import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SymbolEntry } from './types';

// ── 正则表达式集合 ──────────────────────────────────────────
const NAME_PATTERN = '(?:\\w+|\\w+##\\w+)(?:(?:::(?:\\w+|\\w+##\\w+)|##(?:\\w+|\\w+##\\w+)))*';
const RE = {
    // 函数定义：return_type func_name(...)  {   （行尾有 {）
    funcDef: new RegExp('^[\\w\\s\\*&:<>,~]+?\\b(' + NAME_PATTERN + ')\\s*\\([^)]*\\)\\s*\\{?\\s*$'),

    // 函数声明：return_type func_name(...);
    funcDecl: new RegExp('^[\\w\\s\\*&:<>,~]+?\\b(' + NAME_PATTERN + ')\\s*\\([^)]*\\)\\s*;'),

    // 变量/全局定义：int g_foo = ...;  或  static uint32_t bar;
    varDef: new RegExp('^(?:static\\s+|extern\\s+|const\\s+)*[\\w\\s\\*&:<>,~]+?\\b(' + NAME_PATTERN + ')\\s*(?:=|;)'),

    // typedef
    typedefSimple: new RegExp('^typedef\\s+[\\w\\s\\*&:<>,~]+\\b(' + NAME_PATTERN + ')\\s*;'),

    // struct/union/enum 定义
    structDef: new RegExp('^(?:typedef\\s+)?(?:struct|union|enum)\\s+(' + NAME_PATTERN + ')'),

    // 宏定义
    macroDefine: new RegExp('^#define\\s+(' + NAME_PATTERN + ')'),

    // 条件编译控制
    ifdef:  /^#\s*(?:ifdef|ifndef|if)\s+(.*)/,
    elif:   /^#\s*elif\s+(.*)/,
    else:   /^#\s*else\b/,
    endif:  /^#\s*endif\b/,
    namespaceOpen: /^namespace\s+([\w:]+)\s*(\{)?/,
    classStructOpen: /^(?:class|struct)\s+(\w+)\b[^;{]*\{/,
};

// ── 关键字过滤表 ──────────────────────────────────────────
const KEYWORDS = new Set([
    'if','else','for','while','do','return','switch','case',
    'break','continue','sizeof','typedef','struct','union','enum',
    'void','int','char','long','short','float','double','unsigned',
    'signed','static','extern','const','volatile','inline',
]);

// ── 条件栈管理 ──────────────────────────────────────────────
interface CondFrame {
    condition: string;   // 原始条件字符串
    active: boolean;     // 当前分支是否被激活
    seenTrue: boolean;   // 是否已经有分支为 true（用于 #else）
}

function evalCondition(expr: string, activeConfigs: Set<string>): boolean {
    // 简单处理：defined(X) 或 X 直接判断是否在 activeConfigs 里
    // 支持 ! 前缀（#ifndef）
    const clean = expr.trim();
    if (clean.startsWith('!')) {
        return !activeConfigs.has(clean.slice(1).trim());
    }
    const m = clean.match(/^defined\s*\(\s*(\w+)\s*\)/);
    if (m) return activeConfigs.has(m[1]);
    return activeConfigs.has(clean);
}

// ── 主扫描函数 ──────────────────────────────────────────────
export async function scanFile(
    filePath: string,
    activeConfigs: Set<string>
): Promise<SymbolEntry[]> {
    let content: string;
    try {
        content = await fs.promises.readFile(filePath, 'utf8');
    } catch {
        return [];
    }

    // 移除注释并替换为空格（保留换行符），以保证后续统计的行号和字符位置依然准确
    // 这一步能大幅度提高正则匹配的准确度，防止索引注释里的死代码
    content = content
        .replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\r\n]/g, ' '))
        .replace(/\/\/.*$/gm, match => match.replace(/./g, ' '));

    const uri = vscode.Uri.file(filePath).toString();
    const lines = content.split('\n');
    const results: SymbolEntry[] = [];
    const condStack: CondFrame[] = [];
    const scopeStack: { name: string; startDepth: number }[] = [];
    let braceDepth = 0;
    let pendingScope: string | null = null;

    const currentScope = () => scopeStack.map(frame => frame.name).join('::');
    const makeQualified = (name: string) => {
        const localName = name.startsWith('::') ? name.slice(2) : name;
        const scope = currentScope();
        return scope && !localName.startsWith('::') ? `${scope}::${localName}` : localName;
    };

    // 判断当前行是否在"激活"的条件编译分支下
    function isActive(): boolean {
        if (activeConfigs.size === 0) return true; // 未配置则全量索引
        return condStack.every(f => f.active);
    }

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i].trimStart();

        // ── 处理条件编译指令 ──
        let m: RegExpMatchArray | null;

        if ((m = raw.match(RE.ifdef))) {
            const expr = m[1];
            // 区分 #ifdef / #ifndef / #if
            const isNot = raw.match(/^#\s*ifndef/);
            const cond = isNot ? `!${expr}` : expr;
            const active = evalCondition(cond, activeConfigs);
            condStack.push({ condition: cond, active, seenTrue: active });
            continue;
        }
        if ((m = raw.match(RE.elif))) {
            const top = condStack[condStack.length - 1];
            if (top) {
                const active = !top.seenTrue && evalCondition(m[1], activeConfigs);
                top.active = active;
                if (active) top.seenTrue = true;
            }
            continue;
        }
        if (RE.else.test(raw)) {
            const top = condStack[condStack.length - 1];
            if (top) { top.active = !top.seenTrue; }
            continue;
        }
        if (RE.endif.test(raw)) {
            condStack.pop();
            continue;
        }

        // ── 作用域推导 ──
        let scopeMatch: RegExpMatchArray | null;
        if ((scopeMatch = raw.match(RE.namespaceOpen))) {
            const name = scopeMatch[1];
            if (scopeMatch[2]) {
                scopeStack.push({ name, startDepth: braceDepth });
            } else {
                pendingScope = name;
            }
        } else if ((scopeMatch = raw.match(RE.classStructOpen))) {
            scopeStack.push({ name: scopeMatch[1], startDepth: braceDepth });
        } else if (pendingScope && raw.includes('{')) {
            scopeStack.push({ name: pendingScope, startDepth: braceDepth });
            pendingScope = null;
        }

        // ── 跳过未激活区块 ──
        if (!isActive()) {
            for (const ch of raw) {
                if (ch === '{') braceDepth++;
                else if (ch === '}') braceDepth--;
            }
            continue;
        }

        // 当前 ifdef 条件栈快照（用于后续过滤）
        const ifdefSnapshot = condStack.map(f => f.condition);

        // ── 提取符号 ──
        const addSym = (name: string, kind: SymbolEntry['kind']) => {
            // 过滤掉关键字和极短名称
            if (name.length < 2) return;
            if (KEYWORDS.has(name)) return;

            const qualifiedName = makeQualified(name);
            results.push({
                name,
                qualifiedName,
                kind,
                uri,
                line: i,
                character: lines[i].indexOf(name),
                ifdefStack: [...ifdefSnapshot],
            });
        };

        if ((m = raw.match(RE.macroDefine))) {
            addSym(m[1], 'definition');
        } else if ((m = raw.match(RE.structDef))) {
            addSym(m[1], 'definition');
        } else if ((m = raw.match(RE.typedefSimple))) {
            addSym(m[1], 'definition');
        } else if ((m = raw.match(RE.funcDef))) {
            addSym(m[1], 'definition');
        } else if ((m = raw.match(RE.funcDecl))) {
            addSym(m[1], 'declaration');
        }
        // varDef 较宽泛，只在 .c 文件里匹配，避免头文件噪声
        else if (filePath.endsWith('.c') && (m = raw.match(RE.varDef))) {
            addSym(m[1], 'definition');
        }

        // ── 更新作用域层级（按字符顺序处理大括号） ──
        for (const ch of raw) {
            if (ch === '{') {
                braceDepth++;
            } else if (ch === '}') {
                braceDepth--;
                const top = scopeStack[scopeStack.length - 1];
                if (top && braceDepth === top.startDepth) {
                    scopeStack.pop();
                }
            }
        }
    }

    return results;
}

// ── 递归扫描目录 ─────────────────────────────────────────────
export async function scanDirectory(
    rootPath: string,
    activeConfigs: Set<string>,
    excludePatterns: string[]
): Promise<SymbolEntry[]> {
    const allEntries: SymbolEntry[] = [];

    // 用 vscode API 查找文件，支持 glob 排除
    const excludeGlob = excludePatterns.length > 0 ? `{${excludePatterns.join(',')}}` : undefined;
    const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(rootPath, '**/*.{c,h,cpp,hpp,cc}'),
        excludeGlob
    );

    const batchSize = 20;
    for (let i = 0; i < files.length; i += batchSize) {
        const chunk = files.slice(i, i + batchSize);
        const chunkResults = await Promise.all(
            chunk.map(file => scanFile(file.fsPath, activeConfigs))
        );
        for (const entries of chunkResults) {
            allEntries.push(...entries);
        }
    }

    return allEntries;
}