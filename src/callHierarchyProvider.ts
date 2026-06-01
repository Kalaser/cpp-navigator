import * as vscode from 'vscode';
import { CscopeBackend } from './cscopeBackend';
import { SymbolIndex } from './symbolIndex';
import { SymbolEntry } from './types';

export class CallHierarchyProvider implements vscode.CallHierarchyProvider {
    constructor(private cscope: CscopeBackend, private index: SymbolIndex) {}

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
        const callers = await this.cscope.findCallers(item.name);
        return callers.map(entry => new vscode.CallHierarchyIncomingCall(
            toCallHierarchyItem(entry),
            [new vscode.Range(entry.line, entry.character, entry.line, entry.character + entry.name.length)]
        ));
    }

    async provideCallHierarchyOutgoingCalls(
        item: vscode.CallHierarchyItem
    ): Promise<vscode.CallHierarchyOutgoingCall[]> {
        const callees = await this.cscope.findCallees(item.name);
        return callees.map(entry => new vscode.CallHierarchyOutgoingCall(
            toCallHierarchyItem(entry),
            [new vscode.Range(entry.line, entry.character, entry.line, entry.character + entry.name.length)]
        ));
    }
}

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
