import * as vscode from 'vscode';
import * as fs from 'fs';
import { CscopeBackend } from './cscopeBackend';
import { SymbolIndex } from './symbolIndex';
import { SymbolEntry } from './types';
import { AiReviewService } from './services/aiReviewService';

/**
 * Native VS Code CallHierarchyProvider
 * 注册后支持 Shift+Alt+H (Peek Call Hierarchy)
 * 使用 cscope 后端或 builtin 文本分析，AI 可用时自动验证
 */
export class CallHierarchyProvider implements vscode.CallHierarchyProvider {
    constructor(
        private cscope: CscopeBackend | null,
        private index: SymbolIndex,
        private aiService?: AiReviewService
    ) {}

    async prepareCallHierarchy(
        document: vscode.TextDocument,
        position: vscode.Position
    ): Promise<vscode.CallHierarchyItem | null> {
        const word = getWord(document, position);
        if (!word) return null;

        const definitions = this.index.getDefinitions(word);
        const entry = definitions[0] ?? {
            name: word,
            qualifiedName: word,
            kind: 'definition',
            uri: document.uri.toString(),
            line: position.line,
            character: position.character,
            ifdefStack: [],
        } satisfies SymbolEntry;

        return toCallHierarchyItem(entry);
    }

    async provideCallHierarchyIncomingCalls(
        item: vscode.CallHierarchyItem
    ): Promise<vscode.CallHierarchyIncomingCall[]> {
        let callers = this.cscope
            ? await this.cscope.findCallers(item.name)
            : await builtinFindCallers(item.name, this.index);

        // AI 过滤假阳性 callers
        if (this.aiService && callers.length > 0 && callers.length <= 50) {
            try {
                const candidates = callers.map(e => ({
                    name: e.name, file: vscode.Uri.parse(e.uri).fsPath,
                    line: e.line, snippet: `${e.name}(...)`,
                }));
                const { valid } = await this.aiService.analyzeCallHierarchy(item.name, 'incoming', candidates);
                if (valid.length < callers.length) {
                    callers = valid.map(i => callers[i]).filter(Boolean);
                }
            } catch { /* AI 失败走原始结果 */ }
        }

        return callers.map(entry => new vscode.CallHierarchyIncomingCall(
            toCallHierarchyItem(entry),
            [new vscode.Range(entry.line, entry.character, entry.line, entry.character + entry.name.length)]
        ));
    }

    async provideCallHierarchyOutgoingCalls(
        item: vscode.CallHierarchyItem
    ): Promise<vscode.CallHierarchyOutgoingCall[]> {
        let callees = this.cscope
            ? await this.cscope.findCallees(item.name)
            : await builtinFindCallees(item.name, this.index);

        // AI 过滤假阳性 callees + 推断函数指针回调
        if (this.aiService && callees.length > 0 && callees.length <= 50) {
            try {
                const candidates = callees.map(e => ({
                    name: e.name, file: vscode.Uri.parse(e.uri).fsPath,
                    line: e.line, snippet: `${e.name}(...)`,
                }));
                const { valid } = await this.aiService.analyzeCallHierarchy(item.name, 'outgoing', candidates);
                if (valid.length < callees.length) {
                    callees = valid.map(i => callees[i]).filter(Boolean);
                }
            } catch { /* AI 失败走原始结果 */ }
        }

        return callees.map(entry => new vscode.CallHierarchyOutgoingCall(
            toCallHierarchyItem(entry),
            [new vscode.Range(entry.line, entry.character, entry.line, entry.character + entry.name.length)]
        ));
    }
}

// ── 向后兼容：缓存清除 ─────────────────────────────────────────
export function clearCallHierarchyCache(): void { /* no-op, LRU handles it */ }

// ── Helpers ──────────────────────────────────────────────────────
function toCallHierarchyItem(entry: SymbolEntry): vscode.CallHierarchyItem {
    const uri = vscode.Uri.parse(entry.uri);
    const range = new vscode.Range(entry.line, entry.character, entry.line, entry.character + entry.name.length);
    return new vscode.CallHierarchyItem(
        vscode.SymbolKind.Function,
        entry.name,
        entry.qualifiedName !== entry.name ? entry.qualifiedName : '',
        uri,
        range,
        range
    );
}

function getWord(doc: vscode.TextDocument, pos: vscode.Position): string | undefined {
    const range = doc.getWordRangeAtPosition(pos, /[\w:]+/);
    return range ? doc.getText(range) : undefined;
}

// ── Builtin analysis (简化版，供 CallHierarchyProvider 使用) ──────
const KEYWORDS = new Set([
    'if','else','for','while','do','return','switch','case','break','continue',
    'sizeof','typedef','struct','union','enum','void','int','char','long','short',
    'float','double','unsigned','signed','static','extern','const','volatile','inline',
]);

async function builtinFindCallers(symbol: string, index: SymbolIndex): Promise<SymbolEntry[]> {
    const simpleName = symbol.split('::').pop() ?? symbol;
    if (simpleName.length < 2) return [];
    const callRe = new RegExp(`\\b${escapeRegExp(simpleName)}\\s*\\(`, 'g');
    const nameRe  = new RegExp(`\\b${escapeRegExp(simpleName)}\\b`);
    const results: SymbolEntry[] = [];
    const seen = new Set<string>();
    const exclude = '{**/build/**,**/out/**,**/.git/**,**/node_modules/**,**/CMakeFiles/**}';
    const files = await vscode.workspace.findFiles('**/*.{c,h,cc,cpp,cxx,hh,hpp,hxx}', exclude);

    for (let i = 0; i < files.length && results.length < 50; i += 30) {
        const chunk = files.slice(i, i + 30);
        await Promise.all(chunk.map(async uri => {
            if (results.length >= 50) return;
            let text: string;
            try { text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'); }
            catch { return; }
            if (!nameRe.test(text)) return;
            const lines = text.split(/\r?\n/);
            for (let ln = 0; ln < lines.length && results.length < 50; ln++) {
                const line = lines[ln].replace(/\/\/.*$/, '');
                let match: RegExpExecArray | null;
                callRe.lastIndex = 0;
                while ((match = callRe.exec(line)) && results.length < 50) {
                    const key = `${uri.toString()}:${ln}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    const fileEntries = index.getForFile(uri.toString());
                    let enclosing: SymbolEntry | undefined;
                    for (const e of fileEntries) {
                        if (e.kind === 'definition' && e.line <= ln) {
                            if (!enclosing || e.line > enclosing.line) enclosing = e;
                        }
                    }
                    results.push({
                        name: enclosing?.name ?? '(anonymous)',
                        qualifiedName: enclosing?.qualifiedName ?? '(anonymous)',
                        kind: 'declaration', uri: uri.toString(),
                        line: ln, character: match.index, ifdefStack: [],
                    });
                    break;
                }
            }
        }));
    }
    return results;
}

async function builtinFindCallees(symbol: string, index: SymbolIndex): Promise<SymbolEntry[]> {
    const defs = index.getDefinitions(symbol);
    if (defs.length === 0) return [];
    const def = defs[0];
    let text: string;
    try { text = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.parse(def.uri))).toString('utf8'); }
    catch { return []; }
    const lines = text.split(/\r?\n/);
    const body = extractFunctionBody(lines, def.line);
    if (!body) return [];
    const known = new Map<string, SymbolEntry>();
    for (const [name, entries] of (index as any).defNameMap as Map<string, SymbolEntry[]>) {
        if (name.length >= 2 && entries.length > 0) known.set(name, entries[0]);
    }
    const results: SymbolEntry[] = [];
    const seen = new Set<string>();
    const callRe = /\b([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\s*\(/g;
    for (const bodyLine of body) {
        const stripped = bodyLine.replace(/\/\/.*$/, '');
        let match: RegExpExecArray | null;
        callRe.lastIndex = 0;
        while ((match = callRe.exec(stripped))) {
            const name = match[1];
            if (KEYWORDS.has(name)) continue;
            const simple = name.split('::').pop()!;
            const entry = known.get(name) ?? known.get(simple);
            if (!entry || seen.has(entry.name)) continue;
            if (entry.name === symbol) continue;
            seen.add(entry.name);
            results.push(entry);
        }
    }
    return results;
}

function extractFunctionBody(lines: string[], startLine: number): string[] | null {
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
        if (body.length > 500) break;
    }
    return body;
}

function escapeRegExp(v: string): string {
    return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
