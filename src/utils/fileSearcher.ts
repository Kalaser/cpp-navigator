import * as vscode from 'vscode';
import { LRUCache } from './lruCache';

const DEFAULT_EXCLUDE = '{**/build/**,**/out/**,**/.git/**,**/node_modules/**,**/CMakeFiles/**}';
const SOURCE_GLOB = '**/*.{c,h,cc,cpp,cxx,hh,hpp,hxx}';

interface CachedFile {
    text: string;
    lines: string[];
    mtimeMs: number;
}

/**
 * FileSearcher — 全库源码扫描的共享工具(带文件内容缓存)
 *
 * 原 builtinFindCallers / builtinFindCallees 各自 findFiles + 全量读盘,
 * 展开一次调用树可能重复读取数千个文件。这里统一缓存文件内容,
 * 并通过 onDidSaveTextDocument / onDidDeleteFiles 失效,保证结果新鲜。
 */
export class FileSearcher {
    private files: vscode.Uri[] | null = null;
    private cache = new LRUCache<CachedFile>(400);
    private excludeGlob: string | undefined;

    constructor(excludePatterns: string[] = []) {
        this.excludeGlob = excludePatterns.length > 0
            ? `{${excludePatterns.join(',')}}`
            : DEFAULT_EXCLUDE;
    }

    dispose(): void {
        this.cache.clear();
        this.files = null;
    }

    /** 目录内容或单文件内容变化时调用,使缓存失效 */
    invalidate(uri: vscode.Uri | null): void {
        if (uri) {
            this.cache.delete(uri.toString());
        } else {
            this.cache.clear();
        }
        this.files = null;
    }

    private async getFiles(): Promise<vscode.Uri[]> {
        if (!this.files) {
            this.files = await vscode.workspace.findFiles(SOURCE_GLOB, this.excludeGlob);
        }
        return this.files;
    }

    private async getFile(uri: vscode.Uri): Promise<CachedFile | undefined> {
        const key = uri.toString();
        const cached = this.cache.get(key);
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            if (cached && cached.mtimeMs === stat.mtime) return cached;

            const bytes = await vscode.workspace.fs.readFile(uri);
            const text = Buffer.from(bytes).toString('utf8');
            const entry: CachedFile = { text, lines: text.split(/\r?\n/), mtimeMs: stat.mtime };
            this.cache.set(key, entry);
            return entry;
        } catch {
            this.cache.delete(key);
            return undefined;
        }
    }

    /** 只读取不搜索(供 callee 分析 / 代码片段读取) */
    async readFile(uri: vscode.Uri): Promise<CachedFile | undefined> {
        return this.getFile(uri);
    }

    /**
     * 全库正则搜索调用点。
     * 先按整行快筛(第一组不带捕获的正则),命中的行再做精确匹配,
     * 避免对每行都执行捕获组正则。
     */
    async searchCallSites(
        simpleName: string,
        limit: number,
        onMatch?: (file: vscode.Uri, line: number, col: number) => void
    ): Promise<void> {
        const pattern = `\\b${escapeRegExp(simpleName)}\\s*\\(`;
        const lineRe = new RegExp(pattern, 'g');
        let hits = 0;

        for (const uri of await this.getFiles()) {
            if (hits >= limit) break;
            const file = await this.getFile(uri);
            if (!file) continue;

            for (let ln = 0; ln < file.lines.length; ln++) {
                if (hits >= limit) break;
                const line = file.lines[ln].replace(/\/\/.*$/, '');
                if (!line.includes(simpleName)) continue;

                lineRe.lastIndex = 0;
                const match = lineRe.exec(line);
                if (!match) continue;
                hits++;
                onMatch?.(uri, ln, match.index);
            }
        }
    }

    /** 全库文本搜索(逐行 word 匹配,剔除行注释),返回命中位置 */
    async searchText(
        simpleName: string,
        limit: number
    ): Promise<Array<{ uri: vscode.Uri; line: number; col: number }>> {
        const hits: Array<{ uri: vscode.Uri; line: number; col: number }> = [];
        await this.searchCallSites(simpleName, limit, (uri, line, col) => {
            hits.push({ uri, line, col });
        });
        return hits;
    }

    /**
     * 在给定文件的行区间(或整个文件)中收集函数调用,返回 (name, line) 列表。
     * 用于 builtinFindCallees:已知表由调用方传入,一次遍历即可。
     */
    async findCallsInLines(
        uri: vscode.Uri,
        lineRange: [number, number] | null,
        isKnown: (name: string) => boolean
    ): Promise<Array<{ name: string; line: number }>> {
        const file = await this.getFile(uri);
        if (!file) return [];

        const start = lineRange ? Math.max(0, lineRange[0]) : 0;
        const end = lineRange ? Math.min(file.lines.length, lineRange[1]) : file.lines.length;
        const callRe = /\b([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\s*\(/g;
        const results: Array<{ name: string; line: number }> = [];

        for (let ln = start; ln < end; ln++) {
            const stripped = file.lines[ln].replace(/\/\/.*$/, '');
            callRe.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = callRe.exec(stripped))) {
                const name = match[1];
                const simple = name.split('::').pop()!;
                if (isKnown(name) || isKnown(simple)) {
                    results.push({ name, line: ln });
                    break; // 一行最多记录一次调用,避免同函数体重复计数
                }
            }
        }
        return results;
    }
}

/** 提取从函数起始行开始的函数体(含大括号平衡),最多 2000 行 */
export function extractFunctionBody(lines: string[], startLine: number): string[] | null {
    let braceLine = startLine;
    let found = false;
    for (let i = startLine; i < Math.min(startLine + 10, lines.length); i++) {
        if (lines[i].includes('{')) { braceLine = i; found = true; break; }
    }
    if (!found) return null;
    let depth = 0;
    const body: string[] = [];
    for (let i = braceLine; i < lines.length; i++) {
        for (const ch of lines[i]) { if (ch === '{') depth++; else if (ch === '}') depth--; }
        body.push(lines[i]);
        if (depth <= 0 && i > braceLine) break;
        if (body.length > 2000) break;
    }
    return body;
}

export function escapeRegExp(v: string): string {
    return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
