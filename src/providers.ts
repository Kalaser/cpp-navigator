import * as vscode from 'vscode';
import { SymbolIndex } from './symbolIndex';
import { SymbolEntry } from './types';
import { HistoryManager } from './historyManager';
import { AiReviewService } from './services/aiReviewService';

function toLocation(e: SymbolEntry): vscode.Location {
    return new vscode.Location(
        vscode.Uri.parse(e.uri),
        new vscode.Position(e.line, e.character)
    );
}

function getWordAt(doc: vscode.TextDocument, pos: vscode.Position): string | undefined {
    const range = doc.getWordRangeAtPosition(pos, /[\w:]+/);
    return range ? doc.getText(range) : undefined;
}

export class DefinitionProvider implements vscode.DefinitionProvider {
    constructor(private index: SymbolIndex, private history?: HistoryManager, private aiService?: AiReviewService) {}
    async provideDefinition(doc: vscode.TextDocument, pos: vscode.Position) {
        const word = getWordAt(doc, pos);
        if (!word) return null;
        let entries = this.index.getDefinitions(word);
        this.history?.record('definition', word, entries);

        // AI 消歧：多个同名定义时，读取上下文判断正确的一个
        if (entries.length > 1 && this.aiService) {
            try {
                const ctxStart = Math.max(0, pos.line - 3);
                const ctxEnd = Math.min(doc.lineCount, pos.line + 4);
                const contextSnippet = doc.getText(new vscode.Range(ctxStart, 0, ctxEnd, 0));
                const candidates = await Promise.all(entries.map(async e => {
                    const snippet = await readPreview(e) ?? '';
                    return { file: vscode.Uri.parse(e.uri).fsPath, line: e.line, snippet };
                }));
                const best = await this.aiService.disambiguateDefinition(word, contextSnippet, candidates);
                if (best > 0) {
                    entries = [entries[best], ...entries.filter((_, i) => i !== best)];
                }
            } catch { /* AI 失败走原始顺序 */ }
        }
        return entries.map(toLocation);
    }
}

export class DeclarationProvider implements vscode.DeclarationProvider {
    constructor(private index: SymbolIndex, private history?: HistoryManager) {}
    provideDeclaration(doc: vscode.TextDocument, pos: vscode.Position) {
        const word = getWordAt(doc, pos);
        if (!word) return null;
        const entries = this.index.getDeclarations(word);
        this.history?.record('definition', word, entries);
        return entries.map(toLocation);
    }
}

export class ReferenceProvider implements vscode.ReferenceProvider {
    constructor(private index: SymbolIndex, private history?: HistoryManager, private aiService?: AiReviewService) {}
    async provideReferences(doc: vscode.TextDocument, pos: vscode.Position, _ctx: vscode.ReferenceContext) {
        const word = getWordAt(doc, pos);
        if (!word) return null;

        // 索引优先：比全量文本搜索快得多
        const entries = this.index.getAllEntries(word);
        let locations = entries.map(e => toLocation(e));

        this.history?.record('reference', word, entries);

        // AI 过滤：剔除注释/字符串/宏中的误匹配
        if (locations.length > 1 && locations.length <= 100 && this.aiService) {
            try {
                const candidates = await Promise.all(entries.slice(0, 50).map(async e => {
                    const snippet = await readPreview(e) ?? '';
                    return { file: vscode.Uri.parse(e.uri).fsPath, line: e.line, snippet };
                }));
                const valid = await this.aiService.filterReferences(word, candidates);
                if (valid.length < candidates.length) {
                    locations = valid.map(i => locations[i]).filter(Boolean);
                }
            } catch { /* AI 失败走原始结果 */ }
        }
        return locations;
    }
}

export class WorkspaceSymbolProvider implements vscode.WorkspaceSymbolProvider {
    constructor(private index: SymbolIndex) {}
    provideWorkspaceSymbols(query: string) {
        if (!query) return [];
        return this.index.search(query).slice(0, 100).map(e => {
            const kind = e.kind === 'definition' ? vscode.SymbolKind.Function : vscode.SymbolKind.Variable;
            return new vscode.SymbolInformation(e.qualifiedName, kind, '', toLocation(e));
        });
    }
}

export class DocumentSymbolProvider implements vscode.DocumentSymbolProvider {
    constructor(private index: SymbolIndex) {}
    provideDocumentSymbols(doc: vscode.TextDocument) {
        return this.index.getForFile(doc.uri.toString()).map(e => {
            const kind  = e.kind === 'definition' ? vscode.SymbolKind.Function : vscode.SymbolKind.Variable;
            const range = new vscode.Range(e.line, 0, e.line, e.character + e.name.length);
            return new vscode.DocumentSymbol(e.qualifiedName, e.kind, kind, range, range);
        });
    }
}

export class HoverProvider implements vscode.HoverProvider {
    constructor(private index: SymbolIndex, private aiService?: AiReviewService) {}
    async provideHover(doc: vscode.TextDocument, pos: vscode.Position) {
        const word = getWordAt(doc, pos);
        if (!word) return null;
        let entries = this.index.getDefinitions(word);
        if (entries.length === 0) return null;

        // AI 消歧：排序最可能的定义
        if (entries.length > 1 && this.aiService) {
            try {
                const ctxStart = Math.max(0, pos.line - 3);
                const ctxEnd = Math.min(doc.lineCount, pos.line + 4);
                const contextSnippet = doc.getText(new vscode.Range(ctxStart, 0, ctxEnd, 0));
                const candidates = await Promise.all(entries.map(async e => {
                    const snippet = await readPreview(e) ?? '';
                    return { file: vscode.Uri.parse(e.uri).fsPath, line: e.line, snippet };
                }));
                const best = await this.aiService.disambiguateDefinition(word, contextSnippet, candidates);
                if (best > 0) {
                    entries = [entries[best], ...entries.filter((_, i) => i !== best)];
                }
            } catch { /* AI 失败走原始顺序 */ }
        }

        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${word}**\n\n`);
        entries.slice(0, 5).forEach(e => {
            const file = vscode.Uri.parse(e.uri).path.split('/').pop();
            md.appendMarkdown(`- \`${e.qualifiedName}\` in \`${file}\` line ${e.line + 1}\n`);
        });
        const preview = await readPreview(entries[0]);
        if (preview) {
            md.appendMarkdown('\n');
            md.appendCodeblock(preview, 'cpp');

            // AI 功能说明
            if (this.aiService) {
                try {
                    const summary = await this.aiService.summarizeSymbol(word, preview);
                    if (summary) {
                        md.appendMarkdown(`\n🤖 *${summary}*\n`);
                    }
                } catch { /* AI 失败不显示 */ }
            }
        }
        if (entries.length > 5) md.appendMarkdown(`\n*...and ${entries.length - 5} more*`);
        return new vscode.Hover(md);
    }
}

async function findTextReferences(word: string): Promise<vscode.Location[]> {
    const exclude = '{**/build/**,**/out/**,**/.git/**,**/node_modules/**,**/CMakeFiles/**}';
    const files = await vscode.workspace.findFiles('**/*.{c,h,cc,cpp,cxx,hh,hpp,hxx,S,s}', exclude);
    const pattern = new RegExp(`\\b${escapeRegExp(simpleName(word))}\\b`, 'g');
    const results: vscode.Location[] = [];

    await Promise.all(files.map(async uri => {
        let text: string;
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            text = Buffer.from(bytes).toString('utf8');
        } catch {
            return;
        }

        const lines = text.split(/\r?\n/);
        for (let lineNo = 0; lineNo < lines.length; lineNo++) {
            const line = stripLineComment(lines[lineNo]);
            let match: RegExpExecArray | null;
            pattern.lastIndex = 0;
            while ((match = pattern.exec(line))) {
                results.push(new vscode.Location(uri, new vscode.Position(lineNo, match.index)));
                if (results.length >= 5000) return;
            }
        }
    }));

    return results.sort((a, b) =>
        a.uri.toString().localeCompare(b.uri.toString()) || a.range.start.line - b.range.start.line
    );
}

function locationToEntry(word: string) {
    return (location: vscode.Location): SymbolEntry => ({
        name: simpleName(word),
        qualifiedName: word,
        kind: 'declaration',
        uri: location.uri.toString(),
        line: location.range.start.line,
        character: location.range.start.character,
        ifdefStack: [],
    });
}

async function readPreview(entry: SymbolEntry): Promise<string | undefined> {
    try {
        const uri = vscode.Uri.parse(entry.uri);
        const bytes = await vscode.workspace.fs.readFile(uri);
        const lines = Buffer.from(bytes).toString('utf8').split(/\r?\n/);
        const start = Math.max(0, entry.line);
        const end = Math.min(lines.length, start + 24);
        return lines.slice(start, end).join('\n').trimEnd();
    } catch {
        return undefined;
    }
}

function simpleName(word: string): string {
    const parts = word.split('::');
    return parts[parts.length - 1] || word;
}

function stripLineComment(line: string): string {
    return line.replace(/\/\/.*$/, '');
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
