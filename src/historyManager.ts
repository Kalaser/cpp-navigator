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
    parentId?: string;
    children: HistoryRecord[];
}

/**
 * Task 3.2: 重构为树状历史栈
 * - 同一调用链内的跳转作为子节点 Push
 * - 跨函数的跳转作为新 Root 节点
 * - Task 3.3: 右键分屏预览
 */
export class HistoryManager implements vscode.TreeDataProvider<HistoryRecord> {
    private records: HistoryRecord[] = [];
    private onDidChangeTreeDataEmitter = new vscode.EventEmitter<HistoryRecord | undefined>();
    readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

    // 当前活跃调用链的 root id
    private activeTraceId: string | undefined;

    constructor(private context: vscode.ExtensionContext) {
        this.records = context.workspaceState.get<HistoryRecord[]>('cppNavigator.history', []);
    }

    /**
     * Task 3.2: pushToStack — 智能推入历史
     * - 如果当前光标在某个历史节点的作用域内 → 作为子节点
     * - 否则作为新 Root
     */
    record(action: HistoryAction, symbol: string, entries: SymbolEntry[]): void {
        if (!symbol || entries.length === 0) return;
        const first = entries[0];
        this.pushToStack(action, symbol, first, false);
    }

    /** 标记新调用链开始（从 Call Tree 触发时调用） */
    startNewTrace(action: HistoryAction, symbol: string, entry: SymbolEntry): void {
        this.pushToStack(action, symbol, entry, true);
    }

    private pushToStack(
        action: HistoryAction,
        symbol: string,
        entry: SymbolEntry,
        isNewTrace: boolean
    ): void {
        const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

        const record: HistoryRecord = {
            id,
            action,
            symbol: entry.qualifiedName || symbol,
            uri: entry.uri,
            line: entry.line,
            character: entry.character,
            timestamp: Date.now(),
            children: [],
        };

        if (isNewTrace || !this.activeTraceId) {
            // 新 Root 节点
            this.records = [record, ...this.records].slice(0, 100);
            this.activeTraceId = id;
        } else {
            // 尝试找到 activeTrace 并添加为子节点
            const parent = this.findRecord(this.activeTraceId);
            if (parent) {
                record.parentId = parent.id;
                parent.children.push(record);
            } else {
                // parent 已不在列表中，作为新 root
                this.records = [record, ...this.records].slice(0, 100);
                this.activeTraceId = id;
            }
        }

        // 去重：如果同 uri+line 已存在，不重复添加
        void this.save();
        this.onDidChangeTreeDataEmitter.fire(undefined);
    }

    private findRecord(id: string): HistoryRecord | undefined {
        for (const r of this.records) {
            if (r.id === id) return r;
            const found = this.findInChildren(r.children, id);
            if (found) return found;
        }
        return undefined;
    }

    private findInChildren(children: HistoryRecord[], id: string): HistoryRecord | undefined {
        for (const c of children) {
            if (c.id === id) return c;
            const found = this.findInChildren(c.children, id);
            if (found) return found;
        }
        return undefined;
    }

    clear(): void {
        this.records = [];
        this.activeTraceId = undefined;
        void this.save();
        this.onDidChangeTreeDataEmitter.fire(undefined);
    }

    getTreeItem(element: HistoryRecord): vscode.TreeItem {
        const hasChildren = element.children.length > 0;
        const item = new vscode.TreeItem(
            element.symbol,
            hasChildren
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

    /**
     * Task 3.3: 分屏预览
     */
    async preview(item: HistoryRecord): Promise<void> {
        const uri = vscode.Uri.parse(item.uri);
        const bytes = await vscode.workspace.fs.readFile(uri);
        const lines = Buffer.from(bytes).toString('utf8').split(/\r?\n/);
        const start = Math.max(0, item.line - 2);
        const end = Math.min(lines.length, item.line + 40);
        const code = lines.slice(start, end).join('\n');

        const panel = vscode.window.createWebviewPanel(
            'cppNavigator.preview',
            `Preview: ${item.symbol}`,
            vscode.ViewColumn.Beside,
            { enableScripts: false }
        );
        panel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><style>
            body{font-family:var(--vscode-editor-font-family);color:var(--vscode-editor-foreground);
                 background:var(--vscode-editor-background);padding:12px;}
            .meta{color:var(--vscode-descriptionForeground);margin-bottom:12px;}
            pre{white-space:pre-wrap;margin:0;line-height:1.45;}
        </style></head><body>
            <div class="meta">${escapeHtml(vscode.workspace.asRelativePath(uri))}:${item.line + 1}</div>
            <pre>${escapeHtml(code)}</pre>
        </body></html>`;
    }

    private async save(): Promise<void> {
        await this.context.workspaceState.update('cppNavigator.history', this.records);
    }

    private formatLocation(item: HistoryRecord): string {
        const file = vscode.Uri.parse(item.uri).path.split('/').pop() ?? item.uri;
        return `${file}:${item.line + 1}`;
    }
}

function escapeHtml(v: string): string {
    return v.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
