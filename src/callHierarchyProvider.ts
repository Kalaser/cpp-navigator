import * as vscode from 'vscode';
import { CscopeBackend } from './cscopeBackend';
import { SymbolIndex } from './symbolIndex';
import { SymbolEntry } from './types';
import { FileSearcher, extractFunctionBody } from './utils/fileSearcher';

/**
 * Native VS Code CallHierarchyProvider
 * 注册后支持 Shift+Alt+H (Peek Call Hierarchy)
 * 使用 cscope 后端或 builtin 文本分析（FileSearcher 缓存文件内容）
 */
export class CallHierarchyProvider implements vscode.CallHierarchyProvider {
    private searcher: FileSearcher;

    constructor(
        private cscope: CscopeBackend | null,
        private index: SymbolIndex,
        excludePatterns: string[] = []
    ) {
        this.searcher = new FileSearcher(excludePatterns);
    }

    dispose(): void {
        this.searcher.dispose();
    }

    /** 文件保存/删除时由 extension 调用,使内容缓存失效 */
    invalidate(uri?: vscode.Uri): void {
        this.searcher.invalidate(uri ?? null);
    }

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
        const callers = this.cscope
            ? await this.cscope.findCallers(item.name)
            : await builtinFindCallers(item.name, this.index, this.searcher);

        return callers.map(entry => new vscode.CallHierarchyIncomingCall(
            toCallHierarchyItem(entry),
            [new vscode.Range(entry.line, entry.character, entry.line, entry.character + entry.name.length)]
        ));
    }

    async provideCallHierarchyOutgoingCalls(
        item: vscode.CallHierarchyItem
    ): Promise<vscode.CallHierarchyOutgoingCall[]> {
        const callees = this.cscope
            ? await this.cscope.findCallees(item.name)
            : await builtinFindCallees(item.name, this.index, this.searcher);

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

// ── Builtin analysis (FileSearcher 缓存版本) ─────────────────────
const KEYWORDS = new Set([
    'if','else','for','while','do','return','switch','case','break','continue',
    'sizeof','typedef','struct','union','enum','void','int','char','long','short',
    'float','double','unsigned','signed','static','extern','const','volatile','inline',
]);

async function builtinFindCallers(symbol: string, index: SymbolIndex, searcher: FileSearcher): Promise<SymbolEntry[]> {
    const simpleName = symbol.split('::').pop() ?? symbol;
    if (simpleName.length < 2) return [];
    const results: SymbolEntry[] = [];
    const seen = new Set<string>();
    const MAX = 50;

    await searcher.searchCallSites(simpleName, MAX, (uri, ln) => {
        const key = `${uri.toString()}:${ln}`;
        if (seen.has(key)) return;
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
            line: ln, character: 0, ifdefStack: [],
        });
    });
    return results;
}

async function builtinFindCallees(symbol: string, index: SymbolIndex, searcher: FileSearcher): Promise<SymbolEntry[]> {
    const defs = index.getDefinitions(symbol);
    if (defs.length === 0) return [];
    const def = defs[0];

    const file = await searcher.readFile(vscode.Uri.parse(def.uri));
    if (!file) return [];

    const body = extractFunctionBody(file.lines, def.line);
    const known = index.allKnownByName();
    const calls = await searcher.findCallsInLines(
        vscode.Uri.parse(def.uri),
        body ? [def.line, def.line + body.length] : null,
        (name) => known.has(name)
    );

    const results: SymbolEntry[] = [];
    const seen = new Set<string>();
    for (const { name } of calls) {
        const simple = name.split('::').pop()!;
        const entry = known.get(name) ?? known.get(simple);
        if (!entry || seen.has(entry.name)) continue;
        if (entry.name === symbol) continue;
        seen.add(entry.name);
        results.push(entry);
    }
    return results;
}
