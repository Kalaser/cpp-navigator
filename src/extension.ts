import * as vscode from 'vscode';
import * as path from 'path';
import { scanDirectory, scanFile } from './indexBuilder';
import { SymbolIndex } from './symbolIndex';
import { DefinitionProvider, DeclarationProvider, ReferenceProvider, WorkspaceSymbolProvider, DocumentSymbolProvider, HoverProvider } from './providers';
import { detectProject } from './projectDetector';

const index = new SymbolIndex();

function getConfig() {
    const cfg = vscode.workspace.getConfiguration('cppNavigator');
    return {
        activeConfigs: new Set<string>(cfg.get<string[]>('activeConfigs', [])),
        extraRoots:    cfg.get<string[]>('extraRoots', []),
        excludePatterns: cfg.get<string[]>('excludePatterns', [
            '**/build/**', '**/out/**', '**/.git/**'
        ]),
    };
}

async function buildIndex(showProgress = true) {
    const cfg = vscode.workspace.getConfiguration('cppNavigator');
    const userConfigs  = cfg.get<string[]>('activeConfigs', []);
    const extraRoots   = cfg.get<string[]>('extraRoots', []);
    const excludePatterns = cfg.get<string[]>('excludePatterns', ['**/build/**', '**/.git/**']);

    const wsFolders = vscode.workspace.workspaceFolders ?? [];
    const roots = [
        ...wsFolders.map(f => f.uri.fsPath),
        ...extraRoots,
    ];

    const autoCtx = detectProject(wsFolders[0]?.uri.fsPath ?? '');
    const activeConfigs = new Set([
        ...autoCtx.defines,   // 自动发现
        ...userConfigs,       // 用户手动追加
    ]);

    index.clear();

    const task = async () => {
        for (const root of roots) {
            const entries = await scanDirectory(root, activeConfigs, excludePatterns);
            index.addEntries(entries);
        }
        vscode.window.setStatusBarMessage(
            `$(symbol-function) C/C++ Nav: ${index.size} symbols indexed`, 3000
        );
    };

    if (showProgress) {
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'C/C++ Navigator: Indexing...' },
            task
        );
    } else {
        await task();
    }
}

export async function activate(context: vscode.ExtensionContext) {
    // 首次构建索引
    await buildIndex();

    const selector: vscode.DocumentSelector = [
        { scheme: 'file', language: 'c' },
        { scheme: 'file', language: 'cpp' },
    ];

    // 注册三个 Provider
    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider(selector, new DefinitionProvider(index)),
        vscode.languages.registerDeclarationProvider(selector, new DeclarationProvider(index)),
        vscode.languages.registerReferenceProvider(selector, new ReferenceProvider(index)),
        vscode.languages.registerDocumentSymbolProvider(selector, new DocumentSymbolProvider(index)),
        vscode.languages.registerWorkspaceSymbolProvider(new WorkspaceSymbolProvider(index)),
        vscode.languages.registerHoverProvider(selector, new HoverProvider(index))
    );

    // 手动重建索引命令
    context.subscriptions.push(
        vscode.commands.registerCommand('cppNavigator.rebuildIndex', () => buildIndex())
    );

    // 监听文件保存 → 增量更新
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(async doc => {
            if (!['c', 'cpp'].includes(doc.languageId)) return;
            const { activeConfigs } = getConfig();
            index.removeFile(doc.uri.toString());
            const entries = await scanFile(doc.uri.fsPath, activeConfigs);
            index.addEntries(entries);
        })
    );

    // 配置变更 → 重建索引（activeConfigs 改变时）
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('cppNavigator')) buildIndex(false);
        })
    );
}

export function deactivate() {}