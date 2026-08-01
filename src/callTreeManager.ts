import * as vscode from 'vscode';
import { CscopeBackend } from './cscopeBackend';
import { SymbolIndex } from './symbolIndex';
import { ManualLinkManager } from './manualLinkManager';
import { CallDirection, CallTreeNode, SymbolEntry } from './types';
import { LRUCache } from './utils/lruCache';
import { FileSearcher, extractFunctionBody } from './utils/fileSearcher';

/**
 * CallTreeManager — 核心调用树控制器
 * Phase 1: TreeDataProvider + LRU 缓存
 * Phase 3: 双根节点 (Callers / Callees) + 懒加载 getChildren
 * Phase 2: 融合 Manual Links
 *
 * 性能优化:
 *  - builtin caller/callee 分析统一走 FileSearcher(文件内容缓存 + 失效),
 *    不再每次 findFiles + 全量读盘
 *  - builtin callee 用 allKnownByName() 一次性建立已知符号表,
 *    替代遍历 (index as any).defNameMap
 *  - exportTree 对 cscope 后端并发发查询并限制节点数
 */
export class CallTreeManager implements vscode.TreeDataProvider<CallTreeNodeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<CallTreeNodeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private callerCache = new LRUCache<SymbolEntry[]>(200);
    private calleeCache = new LRUCache<SymbolEntry[]>(200);

    private rootSymbol: string | undefined;
    private rootUri: string | undefined;
    private rootLine: number = 0;
    private rootChar: number = 0;

    private cscope: CscopeBackend | null = null;
    private index: SymbolIndex | null = null;
    private manualLinks: ManualLinkManager | null = null;
    private searcher: FileSearcher | null = null;

    configure(
        cscope: CscopeBackend | null,
        index: SymbolIndex,
        manualLinks: ManualLinkManager,
        excludePatterns: string[] = []
    ): void {
        this.cscope = cscope;
        this.index = index;
        this.manualLinks = manualLinks;
        this.searcher = new FileSearcher(excludePatterns);
    }

    dispose(): void {
        this.searcher?.dispose();
        this.searcher = null;
    }

    /** 文件内容变化时使缓存失效 */
    invalidateCache(): void {
        this.searcher?.invalidate(null);
        this.callerCache.clear();
        this.calleeCache.clear();
    }

    /** startNewTrace — 触发入口，清空缓存 */
    startNewTrace(symbol: string, uri: string, line: number, character: number): void {
        this.rootSymbol = symbol;
        this.rootUri = uri;
        this.rootLine = line;
        this.rootChar = character;
        this.callerCache.clear();
        this.calleeCache.clear();
        this._onDidChangeTreeData.fire(undefined);
    }

    hasActiveTree(): boolean {
        return !!this.rootSymbol && !!this.index;
    }

    clear(): void {
        this.rootSymbol = undefined;
        this._onDidChangeTreeData.fire(undefined);
    }

    /** 刷新侧边栏 TreeView（缓存已填充后调用） */
    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    /** 导出当前树结构给 Webview */
    async exportTree(): Promise<{ root: string; callers: CallTreeNode[]; callees: CallTreeNode[] }> {
        const symbol = this.rootSymbol ?? '';
        // 两侧并发构建；节点数在 buildBranch 内限制，避免 cscope 子进程风暴
        const [callers, callees] = await Promise.all([
            this.buildBranch(symbol, 'callers', 0, new Set()),
            this.buildBranch(symbol, 'callees', 0, new Set()),
        ]);
        return { root: symbol, callers, callees };
    }

    // ── TreeDataProvider ──────────────────────────────────────────
    getTreeItem(element: CallTreeNodeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: CallTreeNodeItem): Promise<CallTreeNodeItem[]> {
        if (!this.rootSymbol || !this.index) return [];

        // 双根节点
        if (!element) {
            return [
                new CallTreeNodeItem(
                    '$(arrow-left)  Callers (被谁调用)',
                    vscode.TreeItemCollapsibleState.Expanded,
                    { type: 'category', symbol: this.rootSymbol, direction: 'callers' }
                ),
                new CallTreeNodeItem(
                    '$(arrow-right)  Callees (调用了谁)',
                    vscode.TreeItemCollapsibleState.Expanded,
                    { type: 'category', symbol: this.rootSymbol, direction: 'callees' }
                ),
            ];
        }

        const ctx = element.nodeContext;

        // Category 级：懒加载直接子节点
        if (ctx.type === 'category') {
            const entries = await this.smartFind(ctx.symbol, ctx.direction);
            return this.entriesToItems(entries, ctx.direction);
        }

        // Node 级：懒加载更深层子节点
        if (ctx.type === 'node') {
            const entries = await this.smartFind(ctx.entry.name, ctx.parentDirection);
            return this.entriesToItems(entries, ctx.parentDirection);
        }

        return [];
    }

    // ── 智能查找（融合 Cscope + Manual Links）─────────────────────
    private async smartFind(symbol: string, direction: CallDirection): Promise<SymbolEntry[]> {
        if (!this.index) return [];

        // 1. LRU 缓存命中
        const cache = direction === 'callers' ? this.callerCache : this.calleeCache;
        const cached = cache.get(symbol);
        if (cached) return cached;

        // 2. Cscope / Builtin 查询
        let results: SymbolEntry[];
        if (direction === 'callers') {
            results = this.cscope
                ? await this.cscope.findCallers(symbol)
                : await this.builtinFindCallers(symbol);
        } else {
            results = this.cscope
                ? await this.cscope.findCallees(symbol)
                : await this.builtinFindCallees(symbol);
        }

        // 3. Cscope 结果清洗（仅对 cscope 后端生效）
        if (this.cscope) {
            results = cleanCscopeResults(results);
        }

        // 4. 融合 Manual Links
        if (this.manualLinks && direction === 'callees') {
            const defs = this.index.getDefinitions(symbol);
            if (defs.length > 0) {
                const manual = this.manualLinks.resolveCalleeLinks(defs[0].uri, defs[0].line, this.index);
                // 去重后追加
                const existingNames = new Set(results.map(r => r.name));
                for (const m of manual) {
                    if (!existingNames.has(m.name)) {
                        results.push({ ...m, kind: 'declaration' });
                    }
                }
            }
        }

        cache.set(symbol, results);
        return results;
    }

    private async buildBranch(
        symbol: string,
        direction: CallDirection,
        depth: number,
        visited: Set<string>
    ): Promise<CallTreeNode[]> {
        if (depth >= 3) return [];
        const key = `${symbol}:${direction}:${depth}`;
        if (visited.has(key)) return [];
        visited.add(key);

        const entries = await this.smartFind(symbol, direction);
        const seen = new Set<string>();
        const nodes: CallTreeNode[] = [];

        // 深度 0 最多 15 个节点；更深层收紧，避免 cscope 子进程风暴
        const maxNodes = depth === 0 ? 15 : 8;
        for (const e of entries) {
            if (nodes.length >= maxNodes) break;
            if (seen.has(e.name)) continue;
            seen.add(e.name);

            const children = await this.buildBranch(e.name, direction, depth + 1, new Set(visited));
            nodes.push({
                name: e.name,
                qualifiedName: e.qualifiedName,
                uri: e.uri,
                line: e.line,
                character: e.character,
                direction,
                nodeType: 'node',
                children,
            });
        }
        return nodes;
    }

    // ── 辅助方法 ──────────────────────────────────────────────────
    private entriesToItems(entries: SymbolEntry[], direction: CallDirection): CallTreeNodeItem[] {
        const seen = new Set<string>();
        const items: CallTreeNodeItem[] = [];

        for (const e of entries) {
            if (seen.has(e.name)) continue;
            seen.add(e.name);
            items.push(this.entryToItem(e, direction));
        }

        if (items.length === 0) {
            const item = new CallTreeNodeItem(
                '$(info)  无结果',
                vscode.TreeItemCollapsibleState.None,
                { type: 'leaf', entry: null as any, parentDirection: direction }
            );
            return [item];
        }
        return items;
    }

    private entryToItem(entry: SymbolEntry, direction: CallDirection): CallTreeNodeItem {
        const file = vscode.Uri.parse(entry.uri).fsPath.split(/[/\\]/).pop() ?? '';
        const icon = direction === 'callers' ? '$(arrow-left)' : '$(arrow-right)';

        const item = new CallTreeNodeItem(
            `${icon}  ${entry.name}`,
            vscode.TreeItemCollapsibleState.Collapsed,
            { type: 'node', entry, parentDirection: direction }
        );
        item.description = `${file}:${entry.line + 1}`;
        item.tooltip = [
            entry.qualifiedName,
            `${vscode.Uri.parse(entry.uri).fsPath}:${entry.line + 1}`,
        ].filter(Boolean).join('\n');
        return item;
    }

    // ── Builtin 分析（FileSearcher 缓存版本）─────────────────────
    private async builtinFindCallers(symbol: string): Promise<SymbolEntry[]> {
        if (!this.index || !this.searcher) return [];
        const simpleName = symbol.split('::').pop() ?? symbol;
        if (simpleName.length < 2) return [];

        const results: SymbolEntry[] = [];
        const seen = new Set<string>();
        const MAX = 50;

        await this.searcher.searchCallSites(simpleName, MAX, (uri, line) => {
            const key = `${uri.toString()}:${line}`;
            if (seen.has(key)) return;
            seen.add(key);
            const enclosing = this.findEnclosing(uri.toString(), line);
            results.push({
                name: enclosing?.name ?? '(anonymous)',
                qualifiedName: enclosing?.qualifiedName ?? '(anonymous)',
                kind: 'declaration', uri: uri.toString(),
                line, character: 0, ifdefStack: [],
            });
        });
        return results;
    }

    private async builtinFindCallees(symbol: string): Promise<SymbolEntry[]> {
        if (!this.index || !this.searcher) return [];
        const defs = this.index.getDefinitions(symbol);
        if (defs.length === 0) return [];

        const def = defs[0];
        const file = await this.searcher.readFile(vscode.Uri.parse(def.uri));
        if (!file) return [];

        // 一次性建立已知符号表（替代遍历整个索引）
        const known = this.index.allKnownByName();
        const isKnown = (name: string) => known.has(name);

        const body = extractFunctionBody(file.lines, def.line);
        const calls = await this.searcher.findCallsInLines(
            vscode.Uri.parse(def.uri),
            body ? [def.line, def.line + body.length] : null,
            isKnown
        );

        const results: SymbolEntry[] = [];
        const seen = new Set<string>();
        for (const { name } of calls) {
            const simple = name.split('::').pop()!;
            const entry = known.get(name) ?? known.get(simple);
            if (!entry || seen.has(entry.name)) continue;
            if (entry.name === symbol) continue;
            seen.add(entry.name);
            results.push(entry);
        }
        return results;
    }

    private findEnclosing(uri: string, lineNo: number): SymbolEntry | undefined {
        if (!this.index) return undefined;
        const fileEntries = this.index.getForFile(uri);
        let best: SymbolEntry | undefined;
        for (const e of fileEntries) {
            if (e.kind === 'definition' && e.line <= lineNo) {
                if (!best || e.line > best.line) best = e;
            }
        }
        return best;
    }
}

// ── CallTreeNodeItem ─────────────────────────────────────────────
type NodeContext =
    | { type: 'category'; symbol: string; direction: CallDirection }
    | { type: 'node'; entry: SymbolEntry; parentDirection: CallDirection }
    | { type: 'leaf'; entry: SymbolEntry | null; parentDirection: CallDirection };

export class CallTreeNodeItem extends vscode.TreeItem {
    constructor(
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly nodeContext: NodeContext
    ) {
        super(label, collapsibleState);
        this.contextValue = nodeContext.type;
    }
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Cscope 结果二次清洗
 * 解决三个核心问题：
 *   1. 全局同名污染（不同文件的 main 混在一起）
 *   2. C++ 语法误判（构造函数、命名空间被当成普通函数）
 *   3. 宏/类型/结构体混入（UNITY_VERSION、lv_timer_t）
 */
function cleanCscopeResults(results: SymbolEntry[]): SymbolEntry[] {
    return results.filter(entry => {
        const name = entry.name;

        // 过滤掉空名或极短名
        if (!name || name.length < 2) return false;

        // 过滤掉 C++ 构造/析构误判：LodePNGState::LodePNGState 或 Foo::Foo
        const parts = name.split('::');
        if (parts.length >= 2) {
            const className = parts[parts.length - 2];
            const methodName = parts[parts.length - 1];
            // 构造函数：ClassName::ClassName
            if (className === methodName) return false;
            // 析构函数：ClassName::~ClassName
            if (methodName === `~${className}`) return false;
        }

        // 过滤掉纯大写宏定义：UNITY_VERSION, CONFIG_XXX, NULL 等
        if (/^[A-Z][A-Z0-9_]{2,}$/.test(name)) return false;

        // 过滤掉 C++ 关键字和内置类型
        const CPP_NOISE = new Set([
            'operator', 'new', 'delete', 'nullptr', 'true', 'false',
            'this', 'virtual', 'override', 'final', 'noexcept',
            'explicit', 'implicit', 'static_cast', 'dynamic_cast',
            'const_cast', 'reinterpret_cast',
        ]);
        if (CPP_NOISE.has(name)) return false;
        // 也检查 qualifiedName
        if (CPP_NOISE.has(entry.qualifiedName)) return false;

        // 过滤掉明显是类型定义/typedef 的符号（以 _t 结尾且首字母小写的短名）
        if (/^[a-z][a-z0-9_]*_t$/.test(name) && entry.kind === 'declaration') {
            if (name.length <= 12) return false;
        }

        // 过滤掉明显是变量/字段访问的误判：xxx.field 或 xxx->field
        if (name.includes('.') || name.includes('->')) return false;

        return true;
    });
}
