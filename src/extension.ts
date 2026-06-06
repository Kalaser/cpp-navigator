import * as vscode from 'vscode';
import * as fs from 'fs';
import { scanFile } from './indexBuilder';
import { SymbolIndex } from './symbolIndex';
import {
    DefinitionProvider, DeclarationProvider, ReferenceProvider,
    WorkspaceSymbolProvider, DocumentSymbolProvider, HoverProvider
} from './providers';
import { detectProject } from './projectDetector';
import { CscopeBackend } from './cscopeBackend';
import { CallHierarchyProvider, clearCallHierarchyCache } from './callHierarchyProvider';
import { CallTreeManager } from './callTreeManager';
import { ManualLinkManager } from './manualLinkManager';
import {
    setTreeManager, setManualLinkManager, setSymbolIndex,
    setAiReviewService, setActiveConfigProvider,
    registerShowCallHierarchy, registerShowCallTreeGraph,
    registerMarkCaller, registerClearCallTree, registerAiCleanCallTree
} from './commands/callTreeCommands';
import { AiReviewService } from './services/aiReviewService';
import { IndexDatabase } from './db';
import { BackendType, SymbolEntry } from './types';
import { HistoryManager } from './historyManager';

const index = new SymbolIndex();
let db: IndexDatabase;
let cscopeBackend: CscopeBackend | null = null;
let buildLock: Promise<void> | null = null;
let historyManager: HistoryManager;

// ── 配置读取 ──────────────────────────────────────────────────
function getConfig() {
    const cfg = vscode.workspace.getConfiguration('cppNavigator');
    return {
        activeConfigs:   new Set<string>(cfg.get<string[]>('activeConfigs', [])),
        extraRoots:      cfg.get<string[]>('extraRoots', []),
        backend:         cfg.get<BackendType>('backend', 'auto'),
        cscopeCmd:       cfg.get<string>('cscopeCmd', 'cscope'),
        ctagsCmd:        cfg.get<string>('ctagsCmd', 'ctags'),
        excludePatterns: cfg.get<string[]>('excludePatterns', [
            '**/build/**', '**/out/**', '**/.git/**',
            '**/node_modules/**', '**/CMakeFiles/**',
        ]),
    };
}

// ── 后端选择 ──────────────────────────────────────────────────
async function resolveBackend(
    rootPath: string,
    cfg: ReturnType<typeof getConfig>
): Promise<{ useCscope: boolean; useBuiltin: boolean }> {
    if (cfg.backend === 'builtin') return { useCscope: false, useBuiltin: true };
    if (cfg.backend === 'cscope')  return { useCscope: true,  useBuiltin: false };

    if (cfg.backend === 'auto') {
        const backend = new CscopeBackend(rootPath, cfg.cscopeCmd, cfg.ctagsCmd);
        const avail   = await backend.isAvailable();
        if (avail.cscope && backend.hasCscopeDb()) {
            return { useCscope: true, useBuiltin: true };
        }
    }
    return { useCscope: false, useBuiltin: true };
}

// ── 增量索引构建 ──────────────────────────────────────────────
async function buildIndexIncremental(showProgress = true): Promise<void> {
    if (buildLock) { await buildLock; return; }

    const cfg        = getConfig();
    const wsFolders  = vscode.workspace.workspaceFolders ?? [];
    const roots      = [...wsFolders.map(f => f.uri.fsPath), ...cfg.extraRoots];
    const autoCtx    = detectProject(wsFolders[0]?.uri.fsPath ?? '');
    const activeConfigs = new Set([...autoCtx.defines, ...cfg.activeConfigs]);
    const excludeGlob = cfg.excludePatterns.length
        ? `{${cfg.excludePatterns.join(',')}}`
        : undefined;

    const task = async (progress?: vscode.Progress<{ message?: string }>) => {
        let scanned = 0;
        let skipped = 0;

        for (const root of roots) {
            const files = await vscode.workspace.findFiles(
                new vscode.RelativePattern(root, '**/*.{c,h,cpp,hpp,cc}'),
                excludeGlob
            );

            const batchSize = 20;
            for (let i = 0; i < files.length; i += batchSize) {
                const chunk = files.slice(i, i + batchSize);
                await Promise.all(chunk.map(async file => {
                    const uri   = file.toString();
                    const mtime = Math.floor(fs.statSync(file.fsPath).mtimeMs);

                    if (db.isReady && !db.needsReindex(uri, mtime)) {
                        skipped++;
                        return;
                    }

                    const entries = await scanFile(file.fsPath, activeConfigs);
                    db.updateFile(uri, mtime, entries);
                    index.removeFile(uri);
                    index.addEntries(entries);
                    scanned++;
                }));

                progress?.report({
                    message: `${scanned} scanned, ${skipped} cached (${i + chunk.length}/${files.length})`
                });
            }
        }

        clearCallHierarchyCache();
        const stats = db.isReady ? db.stats() : { symbols: index.size, files: 0 };
        vscode.window.setStatusBarMessage(
            `$(symbol-function) CppNav: ${stats.symbols} symbols, ${scanned} updated`, 4000
        );
    };

    buildLock = showProgress
        ? Promise.resolve(vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'C/C++ Navigator: Indexing...' },
            p => task(p)
          ).then(() => {}))
        : task();

    try { await buildLock; }
    finally { buildLock = null; }
}

async function buildCscopeDb(): Promise<void> {
    if (!cscopeBackend) {
        vscode.window.showWarningMessage('cscope not available. Install cscope and ctags first.');
        return;
    }
    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Building cscope/ctags database...' },
        async progress => {
            await cscopeBackend!.buildCscope((msg: string) => progress.report({ message: msg }));
            await cscopeBackend!.buildCtags((msg: string) => progress.report({ message: msg }));
        }
    );
    vscode.window.showInformationMessage('cscope/ctags database built!');
}

// ── 命令实现（薄封装）─────────────────────────────────────────
async function searchSymbolCommand(): Promise<void> {
    const query = await vscode.window.showInputBox({
        title: 'C/C++ Navigator: Search Symbol',
        prompt: 'Type a symbol name or prefix',
    });
    if (!query) return;

    const matches = index.search(query).slice(0, 200);
    const picked = await vscode.window.showQuickPick(matches.map(entry => ({
        label: entry.qualifiedName,
        description: `${vscode.Uri.parse(entry.uri).fsPath}:${entry.line + 1}`,
        entry,
    })), { matchOnDescription: true, placeHolder: `${matches.length} matches` });

    if (!picked) return;
    historyManager?.record('definition', picked.entry.name, [picked.entry]);
    await openEntry(picked.entry);
}

async function previewDefinitionCommand(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const word = getWord(editor.document, editor.selection.active);
    if (!word) return;
    const definitions = index.getDefinitions(word);
    if (definitions.length === 0) {
        vscode.window.showInformationMessage(`No definition found for ${word}`);
        return;
    }
    historyManager?.record('definition', word, definitions);
    await showPreviewPanel(word, definitions[0]);
}

async function searchSelectedTextCommand(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const selected = editor.document.getText(editor.selection).trim();
    const word = selected || getWord(editor.document, editor.selection.active);
    if (!word) return;
    await vscode.commands.executeCommand('workbench.action.findInFiles', {
        query: word, triggerSearch: true, isRegex: false, isCaseSensitive: true, matchWholeWord: true,
    });
}

async function openEntry(entry: SymbolEntry): Promise<void> {
    const uri = vscode.Uri.parse(entry.uri);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);
    const pos = new vscode.Position(entry.line, entry.character);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

async function showPreviewPanel(symbol: string, entry: SymbolEntry): Promise<void> {
    const uri = vscode.Uri.parse(entry.uri);
    const bytes = await vscode.workspace.fs.readFile(uri);
    const lines = Buffer.from(bytes).toString('utf8').split(/\r?\n/);
    const start = Math.max(0, entry.line - 2);
    const end = Math.min(lines.length, entry.line + 40);
    const code = lines.slice(start, end).join('\n');
    const panel = vscode.window.createWebviewPanel(
        'cppNavigator.preview', `Preview: ${symbol}`,
        vscode.ViewColumn.Beside, { enableScripts: false }
    );
    panel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><style>
        body{font-family:var(--vscode-editor-font-family);color:var(--vscode-editor-foreground);
             background:var(--vscode-editor-background);padding:12px;}
        .meta{color:var(--vscode-descriptionForeground);margin-bottom:12px;}
        pre{white-space:pre-wrap;margin:0;line-height:1.45;}
    </style></head><body>
        <div class="meta">${escapeHtml(vscode.workspace.asRelativePath(uri))}:${entry.line + 1}</div>
        <pre>${escapeHtml(code)}</pre>
    </body></html>`;
}

function escapeHtml(value: string): string {
    return value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const DEEPSEEK_API_KEY_PROMPTED = 'cppNavigator.deepSeekApiKeyPrompted';
const XIAOMI_API_KEY_PROMPTED = 'cppNavigator.xiaomiApiKeyPrompted';

type ConfigurableAiProvider = 'deepseek' | 'xiaomi';

const AI_PROVIDER_CONFIG: Record<ConfigurableAiProvider, {
    title: string;
    prompt: string;
    placeHolder: string;
    label: string;
    promptedKey: string;
}> = {
    deepseek: {
        title: 'C/C++ Navigator: DeepSeek API Key',
        prompt: 'Enter your DeepSeek API key. Leave empty to clear the stored key.',
        placeHolder: 'sk-...',
        label: 'DeepSeek',
        promptedKey: DEEPSEEK_API_KEY_PROMPTED,
    },
    xiaomi: {
        title: 'C/C++ Navigator: Xiaomi MiMo API Key',
        prompt: 'Enter your Xiaomi MiMo API key. Leave empty to clear the stored key.',
        placeHolder: 'mim-...',
        label: 'Xiaomi MiMo',
        promptedKey: XIAOMI_API_KEY_PROMPTED,
    },
};

async function configureAiApiKey(
    aiReviewService: AiReviewService,
    context: vscode.ExtensionContext | undefined,
    provider: ConfigurableAiProvider
): Promise<void> {
    const providerConfig = AI_PROVIDER_CONFIG[provider];
    const apiKey = await vscode.window.showInputBox({
        title: providerConfig.title,
        prompt: providerConfig.prompt,
        placeHolder: providerConfig.placeHolder,
        password: true,
        ignoreFocusOut: true,
    });

    if (apiKey === undefined) return;

    const trimmed = apiKey.trim();
    if (!trimmed) {
        await aiReviewService.clearApiKey(provider);
        vscode.window.showInformationMessage(`${providerConfig.label} API key cleared. Non-AI navigation is unaffected.`);
        await context?.globalState.update(providerConfig.promptedKey, true);
        return;
    }

    await aiReviewService.storeApiKey(trimmed, provider);
    await vscode.workspace
        .getConfiguration('cppNavigator.ai')
        .update('provider', provider, vscode.ConfigurationTarget.Global);
    await vscode.workspace
        .getConfiguration('cppNavigator.ai')
        .update('enabled', true, vscode.ConfigurationTarget.Global);
    await context?.globalState.update(providerConfig.promptedKey, true);
    vscode.window.showInformationMessage(`${providerConfig.label} API key saved. AI call-tree review is enabled.`);
}

async function configureDeepSeekApiKey(
    aiReviewService: AiReviewService,
    context?: vscode.ExtensionContext
): Promise<void> {
    await configureAiApiKey(aiReviewService, context, 'deepseek');
}

async function configureXiaomiApiKey(
    aiReviewService: AiReviewService,
    context?: vscode.ExtensionContext
): Promise<void> {
    await configureAiApiKey(aiReviewService, context, 'xiaomi');
}

async function maybePromptForDeepSeekApiKey(
    context: vscode.ExtensionContext,
    aiReviewService: AiReviewService
): Promise<void> {
    const provider = vscode.workspace.getConfiguration('cppNavigator.ai').get<string>('provider', 'deepseek');
    if (provider !== 'deepseek') return;
    if (await aiReviewService.hasApiKey('deepseek')) return;
    if (context.globalState.get<boolean>(DEEPSEEK_API_KEY_PROMPTED, false)) return;

    const choice = await vscode.window.showInformationMessage(
        'C/C++ Navigator can use DeepSeek for AI call-tree cleanup. Configure an API key now?',
        'Configure',
        'Skip'
    );

    if (choice === 'Configure') {
        await configureDeepSeekApiKey(aiReviewService, context);
        return;
    }

    await context.globalState.update(DEEPSEEK_API_KEY_PROMPTED, true);
}

// ── 插件激活入口 ─────────────────────────────────────────────
export async function activate(context: vscode.ExtensionContext) {
    const wsFolders = vscode.workspace.workspaceFolders ?? [];
    const rootPath  = wsFolders[0]?.uri.fsPath ?? '';
    const cfg       = getConfig();

    // 1. 初始化 DB
    db = new IndexDatabase(context.globalStorageUri.fsPath);
    await db.open();
    historyManager = new HistoryManager(context);

    // 2. 从 DB 热加载内存索引
    if (db.isReady) {
        const cached = db.loadAll();
        index.addEntries(cached);
        const { symbols } = db.stats();
        vscode.window.setStatusBarMessage(`$(symbol-function) CppNav: ${symbols} symbols loaded`, 3000);
    }

    // 3. 后台增量扫描
    void buildIndexIncremental(false);

    // 4. 初始化后端
    cscopeBackend = new CscopeBackend(rootPath, cfg.cscopeCmd, cfg.ctagsCmd);
    const { useCscope } = await resolveBackend(rootPath, cfg);
    const effectiveCscope = useCscope ? cscopeBackend : null;

    // 5. 初始化 Manual Link Manager (Phase 2)
    const manualLinkManager = new ManualLinkManager(context);

    // 6. 初始化 Call Tree Manager (Phase 1 + 3)
    const callTreeManager = new CallTreeManager();
    callTreeManager.configure(effectiveCscope, index, manualLinkManager);

    // 7. 注入依赖到命令层
    const aiReviewService = new AiReviewService(context.secrets);
    setTreeManager(callTreeManager);
    setManualLinkManager(manualLinkManager);
    setSymbolIndex(index);
    setAiReviewService(aiReviewService);
    setActiveConfigProvider(() => Array.from(getConfig().activeConfigs));

    const selector: vscode.DocumentSelector = [
        { scheme: 'file', language: 'c' },
        { scheme: 'file', language: 'cpp' },
    ];

    // 8. 注册 TreeView（callTreeView 用 createTreeView 以获取选中事件）
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('cppNavigator.historyView', historyManager),
    );
    const callTreeView = vscode.window.createTreeView('cppNavigator.callTreeView', {
        treeDataProvider: callTreeManager,
    });
    context.subscriptions.push(callTreeView);

    // 点击节点自动跳转到源码（防抖：键盘快速导航时不立即触发）
    const g = globalThis as any;
    let jumpTimer: any;
    callTreeView.onDidChangeSelection(e => {
        if (jumpTimer) { g.clearTimeout(jumpTimer); jumpTimer = undefined; }
        const sel = e.selection[0];
        if (!sel || sel.nodeContext.type !== 'node' || !sel.nodeContext.entry) return;
        const entry = sel.nodeContext.entry;
        jumpTimer = g.setTimeout(() => {
            jumpTimer = undefined;
            vscode.commands.executeCommand(
                'cppNavigator.openCallTreeNode',
                entry.uri, entry.line, entry.character, entry.name.length
            );
        }, 200);
    });

    // 9. 注册 Provider（AI 可用时自动注入）
    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider(selector,
            useCscope && cscopeBackend
                ? new CscopeDefinitionProvider(cscopeBackend, index)
                : new DefinitionProvider(index, historyManager, aiReviewService)
        ),
        vscode.languages.registerDeclarationProvider(selector, new DeclarationProvider(index, historyManager)),
        vscode.languages.registerReferenceProvider(selector,
            useCscope && cscopeBackend
                ? new CscopeReferenceProvider(cscopeBackend, index)
                : new ReferenceProvider(index, historyManager, aiReviewService)
        ),
        vscode.languages.registerDocumentSymbolProvider(selector, new DocumentSymbolProvider(index)),
        vscode.languages.registerWorkspaceSymbolProvider(new WorkspaceSymbolProvider(index)),
        vscode.languages.registerHoverProvider(selector, new HoverProvider(index, aiReviewService)),
        vscode.languages.registerCallHierarchyProvider(selector,
            new CallHierarchyProvider(effectiveCscope, index, aiReviewService)
        )
    );

    // 10. 命令注册
    context.subscriptions.push(
        vscode.commands.registerCommand('cppNavigator.rebuildIndex', () => buildIndexIncremental(true)),
        vscode.commands.registerCommand('cppNavigator.buildCscopeDb', () => buildCscopeDb()),
        vscode.commands.registerCommand('cppNavigator.rebuildAll', async () => {
            await buildCscopeDb();
            await buildIndexIncremental(true);
        }),
        vscode.commands.registerCommand('cppNavigator.showStats', () => {
            const stats = db.isReady ? db.stats() : { symbols: index.size, files: 0 };
            vscode.window.showInformationMessage(
                `C/C++ Navigator: ${stats.symbols} symbols across ${stats.files} files` +
                (useCscope ? ' | cscope backend active' : ' | builtin backend')
            );
        }),
        vscode.commands.registerCommand('cppNavigator.clearHistory', () => historyManager.clear()),
        vscode.commands.registerCommand('cppNavigator.openHistoryItem', (item) => historyManager.open(item)),
        vscode.commands.registerCommand('cppNavigator.previewHistoryItem', (item) => historyManager.preview(item)),
        // 调用树节点点击：以 preview 模式打开文件，保持焦点在侧边栏
        vscode.commands.registerCommand('cppNavigator.openCallTreeNode',
            async (uri: string, line: number, char: number, len: number) => {
                try {
                    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
                    const editor = await vscode.window.showTextDocument(doc, {
                        viewColumn: vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One,
                        preserveFocus: true,
                        preview: false,
                    });
                    // 选中整个符号名，便于识别跳转位置
                    const start = new vscode.Position(line, char);
                    const end = new vscode.Position(line, char + (len || 1));
                    editor.selection = new vscode.Selection(start, end);
                    editor.revealRange(
                        new vscode.Range(start, end),
                        vscode.TextEditorRevealType.InCenter
                    );
                    // 状态栏短暂反馈
                    const file = vscode.Uri.parse(uri).fsPath.split(/[/\\]/).pop();
                    vscode.window.setStatusBarMessage(
                        `$(file) ${file}:${line + 1}`, 2500
                    );
                } catch { /* ignore */ }
            }
        ),
        vscode.commands.registerCommand('cppNavigator.goToCallTreeSource',
            async (item: any) => {
                try {
                    const ctx = item?.nodeContext;
                    if (!ctx || ctx.type !== 'node' || !ctx.entry) return;
                    const entry = ctx.entry;
                    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(entry.uri));
                    const editor = await vscode.window.showTextDocument(doc, {
                        viewColumn: vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One,
                        preview: false,
                    });
                    const start = new vscode.Position(entry.line, entry.character);
                    const end = new vscode.Position(entry.line, entry.character + entry.name.length);
                    editor.selection = new vscode.Selection(start, end);
                    editor.revealRange(
                        new vscode.Range(start, end),
                        vscode.TextEditorRevealType.InCenter
                    );
                } catch { /* ignore */ }
            }
        ),
        vscode.commands.registerCommand('cppNavigator.openCallTreeNodeToSide',
            async (item: any) => {
                try {
                    const ctx = item?.nodeContext;
                    if (!ctx || ctx.type !== 'node' || !ctx.entry) return;
                    const entry = ctx.entry;
                    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(entry.uri));
                    const editor = await vscode.window.showTextDocument(doc, {
                        viewColumn: vscode.ViewColumn.Beside,
                        preview: false,
                    });
                    const start = new vscode.Position(entry.line, entry.character);
                    const end = new vscode.Position(entry.line, entry.character + entry.name.length);
                    editor.selection = new vscode.Selection(start, end);
                    editor.revealRange(
                        new vscode.Range(start, end),
                        vscode.TextEditorRevealType.InCenter
                    );
                } catch { /* ignore */ }
            }
        ),
        vscode.commands.registerCommand('cppNavigator.searchSymbol', () => searchSymbolCommand()),
        vscode.commands.registerCommand('cppNavigator.previewDefinition', () => previewDefinitionCommand()),
        vscode.commands.registerCommand('cppNavigator.searchSelectedText', () => searchSelectedTextCommand()),
        vscode.commands.registerCommand('cppNavigator.configureDeepSeekApiKey',
            () => configureDeepSeekApiKey(aiReviewService, context)
        ),
        vscode.commands.registerCommand('cppNavigator.configureXiaomiApiKey',
            () => configureXiaomiApiKey(aiReviewService, context)
        ),
    );

    // 11. Call Tree 命令 (commands/ 层)
    registerShowCallHierarchy(context.subscriptions);
    registerShowCallTreeGraph(context.subscriptions);
    registerMarkCaller(context.subscriptions);
    registerClearCallTree(context.subscriptions);
    registerAiCleanCallTree(context.subscriptions);
    void maybePromptForDeepSeekApiKey(context, aiReviewService);

    // 11b. AI 深度分析命令（右键菜单）
    context.subscriptions.push(
        vscode.commands.registerCommand('cppNavigator.aiAnalyzeFunction', async () => {
            if (!(await aiReviewService.isReady())) {
                vscode.window.showWarningMessage('AI is not enabled. Configure cppNavigator.ai settings first.');
                return;
            }
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            const word = getWord(editor.document, editor.selection.active);
            if (!word) {
                vscode.window.showWarningMessage('No symbol under cursor.');
                return;
            }

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `$(sparkle) AI analyzing "${word}"...` },
                async () => {
                    const snippet = await readSnippetForWord(word, index);
                    const analysis = await aiReviewService.analyzeFunction(word, snippet);
                    if (analysis) {
                        showAiPanel(`AI Analysis: ${word}`, analysis);
                    } else {
                        vscode.window.showWarningMessage('AI analysis failed or returned empty.');
                    }
                }
            );
        }),
        vscode.commands.registerCommand('cppNavigator.aiExplainCallChain', async () => {
            if (!(await aiReviewService.isReady())) {
                vscode.window.showWarningMessage('AI is not enabled. Configure cppNavigator.ai settings first.');
                return;
            }
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            const word = getWord(editor.document, editor.selection.active);
            if (!word) {
                vscode.window.showWarningMessage('No symbol under cursor.');
                return;
            }

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `$(sparkle) AI analyzing call chain for "${word}"...` },
                async () => {
                    const snippet = await readSnippetForWord(word, index);
                    const callers = await findRelatedSymbols(word, 'callers', cscopeBackend, index);
                    const callees = await findRelatedSymbols(word, 'callees', cscopeBackend, index);
                    const analysis = await aiReviewService.explainCallChain(word, snippet, callers, callees);
                    if (analysis) {
                        showAiPanel(`Call Chain: ${word}`, analysis);
                    } else {
                        vscode.window.showWarningMessage('AI analysis failed or returned empty.');
                    }
                }
            );
        })
    );

    // 12. 文件事件
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(async doc => {
            if (!['c', 'cpp'].includes(doc.languageId)) return;
            const cfg = getConfig();
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
            const autoCtx = detectProject(wsRoot);
            const ac = new Set([...autoCtx.defines, ...cfg.activeConfigs]);
            const uri   = doc.uri.toString();
            const mtime = Math.floor(fs.statSync(doc.uri.fsPath).mtimeMs);

            const entries = await scanFile(doc.uri.fsPath, ac);
            db.updateFile(uri, mtime, entries);
            index.removeFile(uri);
            index.addEntries(entries);
            clearCallHierarchyCache();

            if (useCscope && cscopeBackend) void cscopeBackend.buildCscope();
        }),

        vscode.workspace.onDidDeleteFiles(e => {
            for (const file of e.files) {
                const uri = file.toString();
                db.removeFile(uri);
                index.removeFile(uri);
            }
        }),

        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('cppNavigator')) buildIndexIncremental(false);
        }),
    );

    // 13. 状态栏
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.text    = `$(symbol-function) CppNav: ${useCscope ? 'cscope' : 'builtin'}`;
    statusBar.tooltip = useCscope
        ? 'C/C++ Navigator (cscope backend)\nClick to show stats'
        : 'C/C++ Navigator (builtin backend)\nClick to show stats';
    statusBar.command = 'cppNavigator.showStats';
    statusBar.show();
    context.subscriptions.push(statusBar);

    // 14. 停用时关闭 DB
    context.subscriptions.push({ dispose: () => db.close() });
}

export function deactivate() {}

// ── AI 辅助函数 ─────────────────────────────────────────────
async function readSnippetForWord(word: string, idx: SymbolIndex): Promise<string> {
    const defs = idx.getDefinitions(word);
    if (defs.length === 0) return '';
    const def = defs[0];
    try {
        const uri = vscode.Uri.parse(def.uri);
        const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        const lines = text.split(/\r?\n/);
        const start = Math.max(0, def.line);
        const end = Math.min(lines.length, start + 60);
        return lines.slice(start, end).join('\n');
    } catch { return ''; }
}

async function findRelatedSymbols(
    word: string,
    direction: 'callers' | 'callees',
    cscope: CscopeBackend | null,
    idx: SymbolIndex
): Promise<Array<{ name: string; file: string; line: number }>> {
    let entries: SymbolEntry[];
    if (direction === 'callers') {
        entries = cscope ? await cscope.findCallers(word) : idx.getAllEntries(word);
    } else {
        entries = cscope ? await cscope.findCallees(word) : [];
        if (entries.length === 0) {
            // builtin fallback: scan definitions
            const defs = idx.getDefinitions(word);
            if (defs.length > 0) {
                try {
                    const uri = vscode.Uri.parse(defs[0].uri);
                    const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
                    const lines = text.split(/\r?\n/);
                    const callRe = /\b([A-Za-z_]\w*)\s*\(/g;
                    const bodyStart = defs[0].line;
                    const bodyEnd = Math.min(lines.length, bodyStart + 80);
                    for (let i = bodyStart; i < bodyEnd; i++) {
                        let m: RegExpExecArray | null;
                        callRe.lastIndex = 0;
                        while ((m = callRe.exec(lines[i]))) {
                            const name = m[1];
                            const found = idx.getDefinitions(name);
                            if (found.length > 0 && found[0].name !== word) {
                                entries.push(found[0]);
                            }
                        }
                    }
                } catch { /* ignore */ }
            }
        }
    }
    const seen = new Set<string>();
    return entries.filter(e => {
        if (seen.has(e.name)) return false;
        seen.add(e.name);
        return true;
    }).slice(0, 15).map(e => ({
        name: e.name,
        file: vscode.Uri.parse(e.uri).fsPath,
        line: e.line,
    }));
}

function showAiPanel(title: string, analysis: string): void {
    const panel = vscode.window.createWebviewPanel(
        'cppNavigator.aiAnalysis', title,
        vscode.ViewColumn.Beside, { enableScripts: false }
    );
    // 简单 markdown → HTML 转换
    const html = analysis
        .replace(/^### (.+)$/gm, '<h4>$1</h4>')
        .replace(/^## (.+)$/gm, '<h3>$1</h3>')
        .replace(/^# (.+)$/gm, '<h2>$1</h2>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/^- (.+)$/gm, '<li>$1</li>')
        .replace(/(<li>.*<\/li>\n?)+/gs, m => `<ul>${m}</ul>`)
        .replace(/\n{2,}/g, '<br><br>')
        .replace(/\n/g, '<br>');
    panel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><style>
        body{font-family:var(--vscode-editor-font-family);color:var(--vscode-editor-foreground);
             background:var(--vscode-editor-background);padding:16px;line-height:1.6;max-width:800px;}
        h2,h3,h4{color:var(--vscode-textLink-foreground);margin:16px 0 8px;}
        code{background:var(--vscode-textCodeBlock-background);padding:2px 6px;border-radius:3px;font-size:0.9em;}
        ul{padding-left:20px;}
        li{margin:4px 0;}
        strong{color:var(--vscode-editor-foreground);}
    </style></head><body>${html}</body></html>`;
}

// ── cscope DefinitionProvider ─────────────────────────────────
class CscopeDefinitionProvider implements vscode.DefinitionProvider {
    constructor(private cscope: CscopeBackend, private index: SymbolIndex) {}
    async provideDefinition(doc: vscode.TextDocument, pos: vscode.Position) {
        const word = getWord(doc, pos);
        if (!word) return null;
        const cs = await this.cscope.findDefinitions(word);
        if (cs.length > 0) {
            historyManager?.record('definition', word, cs);
            return cs.map(e => new vscode.Location(vscode.Uri.parse(e.uri), new vscode.Position(e.line, e.character)));
        }
        const entries = this.index.getDefinitions(word);
        historyManager?.record('definition', word, entries);
        return entries.map(e => new vscode.Location(vscode.Uri.parse(e.uri), new vscode.Position(e.line, e.character)));
    }
}

// ── cscope ReferenceProvider ──────────────────────────────────
class CscopeReferenceProvider implements vscode.ReferenceProvider {
    constructor(private cscope: CscopeBackend, private index: SymbolIndex) {}
    async provideReferences(doc: vscode.TextDocument, pos: vscode.Position, _ctx: vscode.ReferenceContext) {
        const word = getWord(doc, pos);
        if (!word) return null;
        const cs = await this.cscope.findReferences(word);
        if (cs.length > 0) {
            historyManager?.record('reference', word, cs);
            return cs.map(e => new vscode.Location(vscode.Uri.parse(e.uri), new vscode.Position(e.line, e.character)));
        }
        const entries = this.index.getAllEntries(word);
        historyManager?.record('reference', word, entries);
        return entries.map(e => new vscode.Location(vscode.Uri.parse(e.uri), new vscode.Position(e.line, e.character)));
    }
}

function getWord(doc: vscode.TextDocument, pos: vscode.Position): string | undefined {
    const range = doc.getWordRangeAtPosition(pos, /[\w:]+/);
    return range ? doc.getText(range) : undefined;
}
