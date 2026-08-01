import * as vscode from 'vscode';
import { SymbolIndex } from './symbolIndex';
import { SymbolEntry } from './types';
import { HistoryManager } from './historyManager';

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
    constructor(private index: SymbolIndex, private history?: HistoryManager) {}
    async provideDefinition(doc: vscode.TextDocument, pos: vscode.Position) {
        const word = getWordAt(doc, pos);
        if (!word) return null;
        const entries = this.index.getDefinitions(word);
        this.history?.record('definition', word, entries);
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
    constructor(private index: SymbolIndex, private history?: HistoryManager) {}
    async provideReferences(doc: vscode.TextDocument, pos: vscode.Position, _ctx: vscode.ReferenceContext) {
        const word = getWordAt(doc, pos);
        if (!word) return null;

        // 索引优先：比全量文本搜索快得多
        const entries = this.index.getAllEntries(word);
        this.history?.record('reference', word, entries);
        return entries.map(e => toLocation(e));
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
    constructor(private index: SymbolIndex) {}
    async provideHover(doc: vscode.TextDocument, pos: vscode.Position) {
        const word = getWordAt(doc, pos);
        if (!word) return null;
        const entries = this.index.getDefinitions(word);
        if (entries.length === 0) return null;

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
        }
        if (entries.length > 5) md.appendMarkdown(`\n*...and ${entries.length - 5} more*`);
        return new vscode.Hover(md);
    }
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
