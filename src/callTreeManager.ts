import * as vscode from 'vscode';
import * as fs from 'fs';
import { CscopeBackend } from './cscopeBackend';
import { SymbolIndex } from './symbolIndex';
import { ManualLinkManager } from './manualLinkManager';
import { AiReviewDecision, CallTreeNode, CallDirection, CallTreeNodeType, SymbolEntry } from './types';
import { LRUCache } from './utils/lruCache';
import { AiReviewService, makeAiNodeId } from './services/aiReviewService';

/**
 * CallTreeManager — 核心调用树控制器
 * Phase 1: TreeDataProvider + LRU 缓存
 * Phase 3: 双根节点 (Callers / Callees) + 懒加载 getChildren
 * Phase 2: 融合 Manual Links
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
    private aiDecisions = new Map<string, AiReviewDecision>();
    private aiInferredEntries = new Map<string, SymbolEntry[]>();

    configure(
        cscope: CscopeBackend | null,
        index: SymbolIndex,
        manualLinks: ManualLinkManager
    ): void {
        this.cscope = cscope;
        this.index = index;
        this.manualLinks = manualLinks;
    }

    /** Task 1.2: startNewTrace — 触发入口，清空缓存 */
    startNewTrace(symbol: string, uri: string, line: number, character: number): void {
        this.rootSymbol = symbol;
        this.rootUri = uri;
        this.rootLine = line;
        this.rootChar = character;
        this.callerCache.clear();
        this.calleeCache.clear();
        this.aiDecisions.clear();
        this.aiInferredEntries.clear();
        this._onDidChangeTreeData.fire(undefined);
    }

    clear(): void {
        this.rootSymbol = undefined;
        this.aiDecisions.clear();
        this.aiInferredEntries.clear();
        this._onDidChangeTreeData.fire(undefined);
    }

    async runAiReview(aiReview: AiReviewService, activeConfigs: string[]): Promise<{
        reviewed: number;
        valid: number;
        invalid: number;
        inferred: number;
    }> {
        if (!this.rootSymbol || !this.index) {
            throw new Error('No call tree is active.');
        }

        const directions: CallDirection[] = ['callers', 'callees'];
        const decisions: AiReviewDecision[] = [];
        let inferred = 0;
        this.aiDecisions.clear();
        this.aiInferredEntries.clear();

        for (const direction of directions) {
            const entries = await this.smartFind(this.rootSymbol, direction);
            if (entries.length === 0) continue;

            const result = await aiReview.reviewCandidates(
                this.rootSymbol,
                direction,
                entries,
                this.index,
                activeConfigs
            );
            decisions.push(...result.decisions);
            inferred += this.storeInferredEntries(this.rootSymbol, direction, result.inferredSymbols);
        }

        for (const decision of decisions) {
            this.aiDecisions.set(decision.id, decision);
        }
        this._onDidChangeTreeData.fire(undefined);

        const valid = decisions.filter(d => d.status === 'valid').length;
        const invalid = decisions.filter(d => d.status === 'invalid').length;
        return { reviewed: decisions.length, valid, invalid, inferred };
    }

    /** 导出当前树结构给 Webview */
    async exportTree(): Promise<{ root: string; callers: CallTreeNode[]; callees: CallTreeNode[] }> {
        const symbol = this.rootSymbol ?? '';
        const callers = await this.buildBranch(symbol, 'callers', 0, new Set());
        const callees = await this.buildBranch(symbol, 'callees', 0, new Set());
        return { root: symbol, callers, callees };
    }

    // ── TreeDataProvider ──────────────────────────────────────────
    getTreeItem(element: CallTreeNodeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: CallTreeNodeItem): Promise<CallTreeNodeItem[]> {
        if (!this.rootSymbol || !this.index) return [];

        // Task 3.1: 双根节点
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

    // ── Task 2.3: 智能查找（融合 Cscope + Manual Links）──────────
    private async smartFind(symbol: string, direction: CallDirection): Promise<SymbolEntry[]> {
        if (!this.index) return [];

        // 1. LRU 缓存命中
        const cache = direction === 'callers' ? this.callerCache : this.calleeCache;
        const cached = cache.get(symbol);
        if (cached) return this.mergeAiInferred(symbol, direction, cached);

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

        // 方案二：Cscope 结果清洗（仅对 cscope 后端生效）
        if (this.cscope) {
            results = cleanCscopeResults(results, symbol);
        }

        // 3. 融合 Manual Links
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
        return this.mergeAiInferred(symbol, direction, results);
    }

    private storeInferredEntries(
        symbol: string,
        direction: CallDirection,
        inferredSymbols: Array<{ name: string; reason?: string }>
    ): number {
        if (!this.index) return 0;

        const key = makeBranchKey(symbol, direction);
        const entries: SymbolEntry[] = [];
        const seen = new Set<string>();

        for (const inferred of inferredSymbols) {
            const def = this.index.getDefinitions(inferred.name)[0];
            if (!def || seen.has(`${def.uri}:${def.line}:${def.name}`)) continue;
            seen.add(`${def.uri}:${def.line}:${def.name}`);
            const entry: SymbolEntry = { ...def, kind: 'declaration' };
            entries.push(entry);
            this.aiDecisions.set(makeAiNodeId(direction, entry), {
                id: makeAiNodeId(direction, entry),
                status: 'inferred',
                reason: inferred.reason,
            });
        }

        if (entries.length > 0) {
            this.aiInferredEntries.set(key, entries);
        }
        return entries.length;
    }

    private mergeAiInferred(symbol: string, direction: CallDirection, entries: SymbolEntry[]): SymbolEntry[] {
        const inferred = this.aiInferredEntries.get(makeBranchKey(symbol, direction)) ?? [];
        if (inferred.length === 0) return entries;

        const seen = new Set(entries.map(entry => `${entry.uri}:${entry.line}:${entry.name}`));
        const merged = entries.slice();
        for (const entry of inferred) {
            const key = `${entry.uri}:${entry.line}:${entry.name}`;
            if (!seen.has(key)) {
                seen.add(key);
                merged.push(entry);
            }
        }
        return merged;
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

        for (const e of entries) {
            if (nodes.length >= 15) break;
            if (seen.has(e.name)) continue;
            seen.add(e.name);

            const children = await this.buildBranch(e.name, direction, depth + 1, new Set(visited));
            const decision = this.aiDecisions.get(makeAiNodeId(direction, e));
            nodes.push({
                name: e.name,
                qualifiedName: e.qualifiedName,
                uri: e.uri,
                line: e.line,
                character: e.character,
                direction,
                nodeType: 'node',
                children,
                aiStatus: decision?.status,
                aiReason: decision?.reason,
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
        const decision = this.aiDecisions.get(makeAiNodeId(direction, entry));
        const icon = getNodeIcon(direction, decision);

        const item = new CallTreeNodeItem(
            `${icon}  ${entry.name}`,
            vscode.TreeItemCollapsibleState.Collapsed,
            { type: 'node', entry, parentDirection: direction }
        );
        item.description = decision?.status === 'invalid'
            ? `${file}:${entry.line + 1} | AI: likely false positive`
            : `${file}:${entry.line + 1}`;
        item.tooltip = [
            entry.qualifiedName,
            `${vscode.Uri.parse(entry.uri).fsPath}:${entry.line + 1}`,
            decision ? `AI: ${decision.status}${decision.reason ? ` - ${decision.reason}` : ''}` : undefined,
        ].filter(Boolean).join('\n');
        item.contextValue = decision?.status === 'invalid' ? 'node-ai-invalid' : item.contextValue;
        // 使用自定义命令打开文件，保持焦点在侧边栏
        item.command = {
            command: 'cppNavigator.openCallTreeNode',
            title: 'Open',
            arguments: [entry.uri, entry.line, entry.character, entry.name.length],
        };
        return item;
    }

    // ── Builtin 分析（优化版：findFiles + nameRe 过滤）────────────
    private async builtinFindCallers(symbol: string): Promise<SymbolEntry[]> {
        if (!this.index) return [];
        const simpleName = symbol.split('::').pop() ?? symbol;
        if (simpleName.length < 2) return [];

        const callRe = new RegExp(`\\b${escapeRegExp(simpleName)}\\s*\\(`, 'g');
        const nameRe  = new RegExp(`\\b${escapeRegExp(simpleName)}\\b`);
        const results: SymbolEntry[] = [];
        const seen = new Set<string>();
        const MAX = 50;

        const exclude = '{**/build/**,**/out/**,**/.git/**,**/node_modules/**,**/CMakeFiles/**}';
        const files = await vscode.workspace.findFiles('**/*.{c,h,cc,cpp,cxx,hh,hpp,hxx}', exclude);

        for (let i = 0; i < files.length && results.length < MAX; i += 30) {
            const chunk = files.slice(i, i + 30);
            await Promise.all(chunk.map(async uri => {
                if (results.length >= MAX) return;
                let text: string;
                try { text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'); }
                catch { return; }
                if (!nameRe.test(text)) return;

                const lines = text.split(/\r?\n/);
                for (let ln = 0; ln < lines.length && results.length < MAX; ln++) {
                    const line = lines[ln].replace(/\/\/.*$/, '');
                    let match: RegExpExecArray | null;
                    callRe.lastIndex = 0;
                    while ((match = callRe.exec(line)) && results.length < MAX) {
                        const key = `${uri.toString()}:${ln}`;
                        if (seen.has(key)) continue;
                        seen.add(key);
                        const enclosing = this.findEnclosing(uri.toString(), ln);
                        results.push({
                            name: enclosing?.name ?? '(anonymous)',
                            qualifiedName: enclosing?.qualifiedName ?? '(anonymous)',
                            kind: 'declaration', uri: uri.toString(),
                            line: ln, character: match.index, ifdefStack: [],
                        });
                        break;
                    }
                }
            }));
        }
        return results;
    }

    private async builtinFindCallees(symbol: string): Promise<SymbolEntry[]> {
        if (!this.index) return [];
        const defs = this.index.getDefinitions(symbol);
        if (defs.length === 0) return [];

        const def = defs[0];
        let text: string;
        try { text = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.parse(def.uri))).toString('utf8'); }
        catch { return []; }

        const lines = text.split(/\r?\n/);
        const body = extractFunctionBody(lines, def.line);
        if (!body) return [];

        const known = new Map<string, SymbolEntry>();
        for (const [name, entries] of (this.index as any).defNameMap as Map<string, SymbolEntry[]>) {
            if (name.length >= 2 && entries.length > 0) known.set(name, entries[0]);
        }

        const results: SymbolEntry[] = [];
        const seen = new Set<string>();
        const callRe = /\b([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\s*\(/g;
        const KEYWORDS = new Set([
            'if','else','for','while','do','return','switch','case','break','continue',
            'sizeof','typedef','struct','union','enum','void','int','char','long','short',
            'float','double','unsigned','signed','static','extern','const','volatile','inline',
        ]);

        for (const bodyLine of body) {
            const stripped = bodyLine.replace(/\/\/.*$/, '');
            let match: RegExpExecArray | null;
            callRe.lastIndex = 0;
            while ((match = callRe.exec(stripped))) {
                const name = match[1];
                if (KEYWORDS.has(name)) continue;
                const simple = name.split('::').pop()!;
                const entry = known.get(name) ?? known.get(simple);
                if (!entry || seen.has(entry.name)) continue;
                if (entry.name === symbol) continue;
                seen.add(entry.name);
                results.push(entry);
            }
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
 * 方案二：Cscope 结果二次清洗
 * 解决三个核心问题：
 *   1. 全局同名污染（不同文件的 main 混在一起）
 *   2. C++ 语法误判（构造函数、命名空间被当成普通函数）
 *   3. 宏/类型/结构体混入（UNITY_VERSION、lv_timer_t）
 */
function cleanCscopeResults(results: SymbolEntry[], querySymbol: string): SymbolEntry[] {
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
        // 注意：不要过度过滤，很多合法函数也以 _t 结尾
        // 只过滤那些在 cscope 结果中被误判为函数调用的类型名
        if (/^[a-z][a-z0-9_]*_t$/.test(name) && entry.kind === 'declaration') {
            // 检查是否在 SymbolIndex 中有对应的定义（如果有则保留）
            // 这里只能做启发式判断：短的 _t 名更可能是类型
            if (name.length <= 12) return false;
        }

        // 过滤掉明显是变量/字段访问的误判：xxx.field 或 xxx->field
        if (name.includes('.') || name.includes('->')) return false;

        return true;
    });
}

function extractFunctionBody(lines: string[], startLine: number): string[] | null {
    let braceLine = startLine;
    let found = false;
    for (let i = startLine; i < Math.min(startLine + 10, lines.length); i++) {
        if (lines[i].includes('{')) { braceLine = i; found = true; break; }
    }
    if (!found) return null;
    let depth = 0;
    const body: string[] = [];
    for (let i = braceLine; i < lines.length; i++) {
        for (const ch of lines[i]) { if (ch === '{') depth++; else if (ch === '}') depth--; }
        body.push(lines[i]);
        if (depth <= 0 && i > braceLine) break;
        if (body.length > 500) break;
    }
    return body;
}

function escapeRegExp(v: string): string {
    return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getNodeIcon(direction: CallDirection, decision?: AiReviewDecision): string {
    if (decision?.status === 'valid') return '$(pass-filled)';
    if (decision?.status === 'invalid') return '$(circle-slash)';
    if (decision?.status === 'inferred') return '$(wand)';
    return direction === 'callers' ? '$(arrow-left)' : '$(arrow-right)';
}

function makeBranchKey(symbol: string, direction: CallDirection): string {
    return `${direction}:${symbol}`;
}
