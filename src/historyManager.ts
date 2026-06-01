import * as vscode from 'vscode';
import { SymbolEntry } from './types';

export type HistoryAction = 'definition' | 'reference' | 'call';

export interface HistoryRecord {
    id: string;
    action: HistoryAction;
    symbol: string;
    uri: string;
    line: number;
    character: number;
    timestamp: number;
    children?: HistoryRecord[];
}

export class HistoryManager implements vscode.TreeDataProvider<HistoryRecord> {
    private records: HistoryRecord[] = [];
    private onDidChangeTreeDataEmitter = new vscode.EventEmitter<HistoryRecord | undefined>();
    readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

    constructor(private context: vscode.ExtensionContext) {
        this.records = context.workspaceState.get<HistoryRecord[]>('cppNavigator.history', []);
    }

    record(action: HistoryAction, symbol: string, entries: SymbolEntry[]): void {
        if (!symbol || entries.length === 0) return;

        const first = entries[0];
        const item: HistoryRecord = {
            id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            action,
            symbol,
            uri: first.uri,
            line: first.line,
            character: first.character,
            timestamp: Date.now(),
            children: entries.slice(1).map(e => ({
                id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
                action,
                symbol: e.qualifiedName || e.name,
                uri: e.uri,
                line: e.line,
                character: e.character,
                timestamp: Date.now(),
            })),
        };

        this.records = [
            item,
            ...this.records.filter(r => !(r.action === action && r.symbol === symbol && r.uri === first.uri && r.line === first.line)),
        ].slice(0, 200);

        void this.save();
        this.onDidChangeTreeDataEmitter.fire(undefined);
    }

    clear(): void {
        this.records = [];
        void this.save();
        this.onDidChangeTreeDataEmitter.fire(undefined);
    }

    getTreeItem(element: HistoryRecord): vscode.TreeItem {
        const item = new vscode.TreeItem(
            element.symbol,
            element.children && element.children.length > 0
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None
        );
        item.description = `${element.action} · ${this.formatLocation(element)}`;
        item.tooltip = `${element.symbol}\n${vscode.Uri.parse(element.uri).fsPath}:${element.line + 1}`;
        item.command = {
            command: 'cppNavigator.openHistoryItem',
            title: 'Open History Item',
            arguments: [element],
        };
        item.contextValue = 'cppNavigatorHistoryItem';
        return item;
    }

    getChildren(element?: HistoryRecord): HistoryRecord[] {
        if (element) return element.children ?? [];
        return this.records;
    }

    async open(item: HistoryRecord): Promise<void> {
        const uri = vscode.Uri.parse(item.uri);
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc);
        const pos = new vscode.Position(item.line, item.character);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }

    private async save(): Promise<void> {
        await this.context.workspaceState.update('cppNavigator.history', this.records);
    }

    private formatLocation(item: HistoryRecord): string {
        const file = vscode.Uri.parse(item.uri).path.split('/').pop() ?? item.uri;
        return `${file}:${item.line + 1}`;
    }
}
