import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SymbolEntry } from './types';

const NAME_PATTERN = '(?:\\w+|\\w+##\\w+)(?:(?:::(?:\\w+|\\w+##\\w+)|##(?:\\w+|\\w+##\\w+)))*';
const RE = {
    funcDef:         new RegExp('^[\\w\\s\\*&:<>,~]+?\\b(' + NAME_PATTERN + ')\\s*\\([^)]*\\)\\s*\\{?\\s*$'),
    funcDecl:        new RegExp('^[\\w\\s\\*&:<>,~]+?\\b(' + NAME_PATTERN + ')\\s*\\([^)]*\\)\\s*;'),
    varDef:          new RegExp('^(?:static\\s+|extern\\s+|const\\s+)*[\\w\\s\\*&:<>,~]+?\\b(' + NAME_PATTERN + ')\\s*(?:=|;)'),
    typedefSimple:   new RegExp('^typedef\\s+[\\w\\s\\*&:<>,~]+\\b(' + NAME_PATTERN + ')\\s*;'),
    structWithName:  /^(?:typedef\s+)?(?:struct|union|enum)\s+(?:alignas\([^)]*\)|__attribute__\s*\(\([^)]*\)\)|final|sealed|public|private|protected|virtual|static|constexpr|typename|template|explicit|friend|volatile|mutable)*\s*(\w+)\b(?:\s+(?:alignas\([^)]*\)|__attribute__\s*\(\([^)]*\)\)|final|sealed|public|private|protected|virtual|static|constexpr|typename|template|explicit|friend|volatile|mutable|:\s*[^\{;]+))*\s*(?:\{|;)/,
    typedefStructOpen: /^typedef\s+(?:struct|union|enum)\s+(?:alignas\([^)]*\)|__attribute__\s*\(\([^)]*\)\)|final|sealed|public|private|protected|virtual|static|constexpr|typename|template|explicit|friend|volatile|mutable)*\s*(\w+)\b(?:\s+(?:alignas\([^)]*\)|__attribute__\s*\(\([^)]*\)\)|final|sealed|public|private|protected|virtual|static|constexpr|typename|template|explicit|friend|volatile|mutable|:\s*[^\{;]+))*\s*\{/,
    endWithName:     /^}\s*(\w+)\s*;?\s*$/,
    macroDefine:     new RegExp('^#define\\s+(' + NAME_PATTERN + ')'),
    ifdef:           /^#\s*(?:ifdef|ifndef|if)\s+(.*)/,
    elif:            /^#\s*elif\s+(.*)/,
    else:            /^#\s*else\b/,
    endif:           /^#\s*endif\b/,
    namespaceOpen:   /^namespace\s+([\w:]+)\s*(\{)?/,
    classStructOpen: /^(?:class|struct|union)\s+(\w+)\b[^;{]*\{/,
};

const KEYWORDS = new Set([
    'if','else','for','while','do','return','switch','case',
    'break','continue','sizeof','typedef','struct','union','enum',
    'void','int','char','long','short','float','double','unsigned',
    'signed','static','extern','const','volatile','inline',
]);

interface CondFrame { condition: string; active: boolean; seenTrue: boolean; }

function evalCondition(expr: string, activeConfigs: Set<string>): boolean {
    const clean = expr.trim();
    if (clean.startsWith('!')) return !activeConfigs.has(clean.slice(1).trim());
    // defined(CONFIG_XXX)
    const mDefined = clean.match(/^defined\s*\(\s*(\w+)\s*\)/);
    if (mDefined) return activeConfigs.has(mDefined[1]);
    // IS_ENABLED(CONFIG_XXX)  — RTOS/Linux 内核常见宏
    const mIsEnabled = clean.match(/^IS_ENABLED\s*\(\s*(\w+)\s*\)/);
    if (mIsEnabled) return activeConfigs.has(mIsEnabled[1]);
    // CONFIG_XXX (直接匹配)
    return activeConfigs.has(clean);
}

export async function scanFile(filePath: string, activeConfigs: Set<string>): Promise<SymbolEntry[]> {
    let content: string;
    try { content = await fs.promises.readFile(filePath, 'utf8'); }
    catch { return []; }

    // 移除注释，保留换行符以保证行号准确
    content = content
        .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\r\n]/g, ' '))
        .replace(/\/\/.*$/gm, m => m.replace(/./g, ' '));

    const uri   = vscode.Uri.file(filePath).toString();
    const lines = content.split('\n');
    const results: SymbolEntry[] = [];
    const condStack: CondFrame[] = [];
    const scopeStack: { name: string; startDepth: number }[] = [];
    let braceDepth  = 0;
    let pendingScope: string | null = null;

    const currentScope = () => scopeStack.map(f => f.name).join('::');
    const makeQualified = (name: string) => {
        const localName = name.startsWith('::') ? name.slice(2) : name;
        const scope = currentScope();
        return scope && !localName.startsWith('::') ? `${scope}::${localName}` : localName;
    };
    const isActive = () => activeConfigs.size === 0 || condStack.every(f => f.active);

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i].trimStart();
        let m: RegExpMatchArray | null;

        // 条件编译处理
        if ((m = raw.match(RE.ifdef))) {
            const isNot = raw.match(/^#\s*ifndef/);
            const cond  = isNot ? `!${m[1]}` : m[1];
            const active = evalCondition(cond, activeConfigs);
            condStack.push({ condition: cond, active, seenTrue: active });
            continue;
        }
        if ((m = raw.match(RE.elif))) {
            const top = condStack[condStack.length - 1];
            if (top) { const a = !top.seenTrue && evalCondition(m[1], activeConfigs); top.active = a; if (a) top.seenTrue = true; }
            continue;
        }
        if (RE.else.test(raw))  { const top = condStack[condStack.length - 1]; if (top) top.active = !top.seenTrue; continue; }
        if (RE.endif.test(raw)) { condStack.pop(); continue; }

        // 作用域推导
        let sm: RegExpMatchArray | null;
        if ((sm = raw.match(RE.namespaceOpen))) {
            if (sm[2]) scopeStack.push({ name: sm[1], startDepth: braceDepth });
            else pendingScope = sm[1];
        } else if ((sm = raw.match(RE.classStructOpen))) {
            scopeStack.push({ name: sm[1], startDepth: braceDepth });
        } else if ((sm = raw.match(RE.typedefStructOpen))) {
            scopeStack.push({ name: sm[1], startDepth: braceDepth });
        } else if (pendingScope && raw.includes('{')) {
            scopeStack.push({ name: pendingScope, startDepth: braceDepth });
            pendingScope = null;
        }

        if (!isActive()) {
            for (const ch of raw) { if (ch === '{') braceDepth++; else if (ch === '}') braceDepth--; }
            continue;
        }

        const ifdefSnapshot = condStack.map(f => f.condition);
        const addSym = (name: string, kind: SymbolEntry['kind']) => {
            if (name.length < 2 || KEYWORDS.has(name)) return;
            results.push({
                name,
                qualifiedName: makeQualified(name),
                kind,
                uri,
                line:      i,
                character: lines[i].indexOf(name),
                ifdefStack: [...ifdefSnapshot],
            });
        };

        if (raw.startsWith('typedef') && raw.endsWith(';')) {
            const tm = raw.match(/\s+(\w+)\s*;$/);
            if (tm && !KEYWORDS.has(tm[1]) && tm[1].length >= 2) addSym(tm[1], 'definition');
        } else if ((m = raw.match(RE.structWithName))) {
            addSym(m[1], 'definition');
        } else if ((m = raw.match(RE.endWithName))) {
            if (!KEYWORDS.has(m[1]) && m[1].length >= 2) addSym(m[1], 'definition');
        } else if ((m = raw.match(RE.macroDefine))) {
            addSym(m[1], 'definition');
        } else if ((m = raw.match(RE.funcDef))) {
            addSym(m[1], 'definition');
        } else if ((m = raw.match(RE.funcDecl))) {
            addSym(m[1], 'declaration');
        } else if (filePath.endsWith('.c') && (m = raw.match(RE.varDef))) {
            addSym(m[1], 'definition');
        }

        for (const ch of raw) {
            if (ch === '{') {
                braceDepth++;
            } else if (ch === '}') {
                braceDepth--;
                const top = scopeStack[scopeStack.length - 1];
                if (top && braceDepth === top.startDepth) scopeStack.pop();
            }
        }
    }
    return results;
}

export async function scanDirectory(
    rootPath: string,
    activeConfigs: Set<string>,
    excludePatterns: string[]
): Promise<SymbolEntry[]> {
    const allEntries: SymbolEntry[] = [];
    const excludeGlob = excludePatterns.length > 0 ? `{${excludePatterns.join(',')}}` : undefined;
    const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(rootPath, '**/*.{c,h,cpp,hpp,cc}'),
        excludeGlob
    );
    const batchSize = 20;
    for (let i = 0; i < files.length; i += batchSize) {
        const chunk = files.slice(i, i + batchSize);
        const results = await Promise.all(chunk.map(f => scanFile(f.fsPath, activeConfigs)));
        for (const r of results) allEntries.push(...r);
    }
    return allEntries;
}