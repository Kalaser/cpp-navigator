import * as vscode from 'vscode';
import { SymbolIndex } from './symbolIndex';
import { SymbolEntry } from './types';

function toLocation(e: SymbolEntry): vscode.Location {
    const uri = vscode.Uri.parse(e.uri);
    const pos = new vscode.Position(e.line, e.character);
    return new vscode.Location(uri, pos);
}

// 从光标位置提取单词
function getWordAt(
    document: vscode.TextDocument,
    position: vscode.Position
): string | undefined {
    const range = document.getWordRangeAtPosition(position, /[\w_]+/);
    return range ? document.getText(range) : undefined;
}

export class DefinitionProvider implements vscode.DefinitionProvider {
    constructor(private index: SymbolIndex) {}

    provideDefinition(document: vscode.TextDocument, position: vscode.Position) {
        const word = getWordAt(document, position);
        if (!word) return null;
        return this.index.getDefinitions(word).map(toLocation);
    }
}

export class DeclarationProvider implements vscode.DeclarationProvider {
    constructor(private index: SymbolIndex) {}

    provideDeclaration(document: vscode.TextDocument, position: vscode.Position) {
        const word = getWordAt(document, position);
        if (!word) return null;
        return this.index.getDeclarations(word).map(toLocation);
    }
}

export class ReferenceProvider implements vscode.ReferenceProvider {
    constructor(private index: SymbolIndex) {}

    provideReferences(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.ReferenceContext
    ) {
        const word = getWordAt(document, position);
        if (!word) return null;
        // 索引里存的是定义/声明位置，真正的"所有引用"需要全文搜索
        // 这里返回索引中的条目，完整引用可结合 workspace.findFiles + grep
        return this.index.getAllEntries(word).map(toLocation);
    }
}

export class WorkspaceSymbolProvider implements vscode.WorkspaceSymbolProvider {
    constructor(private index: SymbolIndex) {}

    provideWorkspaceSymbols(query: string, token: vscode.CancellationToken) {
        if (!query) return [];
        // 限制最多返回 100 条结果以防查询过于宽泛导致面板卡顿
        const entries = this.index.search(query).slice(0, 100);
        return entries.map(e => {
            const kind = e.kind === 'definition' ? vscode.SymbolKind.Function : vscode.SymbolKind.Variable;
            return new vscode.SymbolInformation(e.name, kind, '', toLocation(e));
        });
    }
}

export class DocumentSymbolProvider implements vscode.DocumentSymbolProvider {
    constructor(private index: SymbolIndex) {}

    provideDocumentSymbols(document: vscode.TextDocument, token: vscode.CancellationToken) {
        const entries = this.index.getForFile(document.uri.toString());
        return entries.map(e => {
            const kind = e.kind === 'definition' ? vscode.SymbolKind.Function : vscode.SymbolKind.Variable;
            const range = new vscode.Range(e.line, 0, e.line, e.character + e.name.length);
            return new vscode.DocumentSymbol(e.name, e.kind, kind, range, range);
        });
    }
}

export class HoverProvider implements vscode.HoverProvider {
    constructor(private index: SymbolIndex) {}

    provideHover(document: vscode.TextDocument, position: vscode.Position) {
        const word = getWordAt(document, position);
        if (!word) return null;
        
        const entries = this.index.getDefinitions(word);
        if (entries.length === 0) return null;

        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${word}**\n\n`);
        
        entries.slice(0, 5).forEach(e => {
            const fileName = vscode.Uri.parse(e.uri).path.split('/').pop();
            md.appendMarkdown(`- Defined in \`${fileName}\` (Line ${e.line + 1})\n`);
        });
        
        if (entries.length > 5) {
            md.appendMarkdown(`\n*...and ${entries.length - 5} more definitions*`);
        }
        
        return new vscode.Hover(md);
    }
}