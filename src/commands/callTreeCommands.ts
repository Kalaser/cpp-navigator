import * as vscode from 'vscode';
import { CallTreeManager } from '../callTreeManager';
import { CallGraphWebview } from '../callGraphWebview';
import { ManualLinkManager } from '../manualLinkManager';
import { SymbolIndex } from '../symbolIndex';

/**
 * 命令控制器层 — 薄封装，调用 Manager → 渲染 View
 */

let treeManager: CallTreeManager | undefined;
let graphWebview: CallGraphWebview | undefined;
let manualLinks: ManualLinkManager | undefined;
let index: SymbolIndex | undefined;

export function setTreeManager(mgr: CallTreeManager): void { treeManager = mgr; }
export function setManualLinkManager(mgr: ManualLinkManager): void { manualLinks = mgr; }
export function setSymbolIndex(idx: SymbolIndex): void { index = idx; }

// ── 命令 1: Show Call Hierarchy (原生 Peek) ─────────────────────
export function registerShowCallHierarchy(disposables: vscode.Disposable[]): void {
    disposables.push(
        vscode.commands.registerCommand('cppNavigator.showCallHierarchy', () =>
            vscode.commands.executeCommand('editor.action.showCallHierarchy')
        )
    );
}

// ── 命令 2: Show Call Tree Graph (Webview) ──────────────────────
export function registerShowCallTreeGraph(disposables: vscode.Disposable[]): void {
    disposables.push(
        vscode.commands.registerCommand('cppNavigator.showCallTreeGraph', async () => {
            if (!treeManager) return;
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;

            const word = getWord(editor.document, editor.selection.active);
            if (!word) {
                vscode.window.showWarningMessage('No symbol under cursor.');
                return;
            }

            // 1. 更新侧边栏 TreeView
            const defs = index?.getDefinitions(word) ?? [];
            const uri = defs[0]?.uri ?? editor.document.uri.toString();
            const line = defs[0]?.line ?? editor.selection.active.line;
            const char = defs[0]?.character ?? 0;

            // 2. 构建调用树 + 渲染 Webview
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `$(sync~spin) Building call graph for "${word}"...`,
                },
                async () => {
                    treeManager!.startNewTrace(word, uri, line, char);

                    const data = await treeManager!.exportTree();
                    if (!graphWebview) graphWebview = new CallGraphWebview();
                    graphWebview.render(word, data.callers, data.callees);

                    // 缓存已填充，再触发侧边栏刷新
                    treeManager!.refresh();
                }
            );
        })
    );
}

// ── 命令 3: Task 2.2 — 标记为调用者 ────────────────────────────
export function registerMarkCaller(disposables: vscode.Disposable[]): void {
    let pendingCaller: { name: string; uri: string; line: number; char: number } | undefined;

    disposables.push(
        vscode.commands.registerCommand('cppNavigator.markCaller', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            const word = getWord(editor.document, editor.selection.active);
            if (!word) return;
            pendingCaller = {
                name: word,
                uri: editor.document.uri.toString(),
                line: editor.selection.active.line,
                char: editor.selection.active.character,
            };
            vscode.window.setStatusBarMessage(
                `$(bookmark) Caller "${word}" marked. Now right-click a callee and "Link to Definition".`,
                8000
            );
        })
    );

    disposables.push(
        vscode.commands.registerCommand('cppNavigator.linkToDefinition', () => {
            if (!pendingCaller || !manualLinks || !index) {
                vscode.window.showWarningMessage('No caller marked. Use "Mark as Caller" first.');
                return;
            }
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            const calleeWord = getWord(editor.document, editor.selection.active);
            if (!calleeWord) return;

            // 用 marked caller 的 uri+line 创建一个 SymbolEntry
            const callerEntry = {
                name: pendingCaller.name,
                qualifiedName: pendingCaller.name,
                kind: 'definition' as const,
                uri: pendingCaller.uri,
                line: pendingCaller.line,
                character: pendingCaller.char,
                ifdefStack: [],
            };
            manualLinks.addLink(callerEntry, calleeWord);
            vscode.window.showInformationMessage(
                `Linked: ${pendingCaller.name} → ${calleeWord}`
            );
            pendingCaller = undefined;
            treeManager?.clear();
        })
    );
}

// ── 命令 4: 清除调用树 ─────────────────────────────────────────
export function registerClearCallTree(disposables: vscode.Disposable[]): void {
    disposables.push(
        vscode.commands.registerCommand('cppNavigator.clearCallTree', () => {
            treeManager?.clear();
            graphWebview?.dispose();
            graphWebview = undefined;
        })
    );
}

// ── Helper ──────────────────────────────────────────────────────
function getWord(doc: vscode.TextDocument, pos: vscode.Position): string | undefined {
    const range = doc.getWordRangeAtPosition(pos, /[\w:]+/);
    return range ? doc.getText(range) : undefined;
}
