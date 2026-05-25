import * as vscode from 'vscode';
import { scanDirectory, scanFile } from './indexBuilder';
import { SymbolIndex } from './symbolIndex';
import { DefinitionProvider, DeclarationProvider, ReferenceProvider, WorkspaceSymbolProvider, DocumentSymbolProvider, HoverProvider } from './providers';
import { detectProject } from './projectDetector';

const index = new SymbolIndex();
let currentBuild: Promise<void> | null = null;

function getConfig() {
    const cfg = vscode.workspace.getConfiguration('cppNavigator');
    return {
        activeConfigs: new Set<string>(cfg.get<string[]>('activeConfigs', [])),
        extraRoots:    cfg.get<string[]>('extraRoots', []),
        excludePatterns: cfg.get<string[]>('excludePatterns', [
            '**/build/**',
            '**/out/**',
            '**/.git/**',
            '**/node_modules/**',
            '**/CMakeFiles/**',
            '**/compile_commands.json'
        ]),
    };
}

async function buildIndex(showProgress = true): Promise<void> {
    if (currentBuild) {
        await currentBuild;
        return buildIndex(showProgress);
    }

    const cfg = getConfig();
    const wsFolders = vscode.workspace.workspaceFolders ?? [];
    const roots = [
        ...wsFolders.map(f => f.uri.fsPath),
        ...cfg.extraRoots,
    ];

    const autoCtx = detectProject(wsFolders[0]?.uri.fsPath ?? '');
    const activeConfigs = new Set([
        ...autoCtx.defines,
        ...cfg.activeConfigs,
    ]);

    index.clear();

    const task = async () => {
        const entriesForRoots = await Promise.all(
            roots.map(root => scanDirectory(root, activeConfigs, cfg.excludePatterns))
        );
        for (const entries of entriesForRoots) {
            index.addEntries(entries);
        }
        vscode.window.setStatusBarMessage(
            `$(symbol-function) C/C++ Nav: ${index.size} symbols indexed`, 3000
        );
    };

    currentBuild = showProgress
        ? Promise.resolve(vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'C/C++ Navigator: Indexing...' },
            task
        ).then(() => {}))
        : task();

    try {
        await currentBuild;
    } finally {
        currentBuild = null;
    }
}

export async function activate(context: vscode.ExtensionContext) {
    // 立即注册语言服务，索引在后台构建以避免阻塞激活
    void buildIndex();

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