export interface SymbolEntry {
    name: string;
    qualifiedName: string;
    kind: 'definition' | 'declaration';
    uri: string;
    line: number;
    character: number;
    ifdefStack: string[];
}

export type BackendType = 'auto' | 'cscope' | 'builtin';

export interface CscopeResult {
    file: string;
    functionName: string;
    line: number;
    text: string;
}

// ── Call Tree Types (Phase 1 & 3) ────────────────────────────────
export type CallDirection = 'callers' | 'callees';

export type CallTreeNodeType = 'root' | 'category' | 'node' | 'manual-link';

export type AiCallNodeStatus = 'raw' | 'valid' | 'invalid' | 'inferred';

export interface AiReviewDecision {
    id: string;
    status: AiCallNodeStatus;
    reason?: string;
}

export interface AiReviewCandidate {
    id: string;
    symbol: string;
    qualifiedName: string;
    uri: string;
    line: number;
    character: number;
    snippet: string;
    ifdefStack: string[];
}

export interface AiReviewRequest {
    targetSymbol: string;
    direction: CallDirection;
    activeConfigs: string[];
    candidates: AiReviewCandidate[];
    targetSignatures: string[];
}

export interface AiReviewResult {
    decisions: AiReviewDecision[];
    inferredSymbols: Array<{
        name: string;
        reason?: string;
    }>;
}

/**
 * CallTreeNode — 统一的调用树节点
 * 用于 TreeDataProvider 和 ECharts 可视化
 */
export interface CallTreeNode {
    name: string;
    qualifiedName: string;
    uri: string;
    line: number;
    character: number;
    direction: CallDirection;
    nodeType: CallTreeNodeType;
    children: CallTreeNode[];
    isManual?: boolean;
    aiStatus?: AiCallNodeStatus;
    aiReason?: string;
}

/**
 * ManualLink — 手动调用映射（Phase 2）
 * 用于连接 ops->read 等函数指针与实际定义
 */
export interface ManualLink {
    id: string;
    callerUri: string;
    callerLine: number;
    callerName: string;
    calleeName: string;
    createdAt: number;
    note?: string;
}

/**
 * ECharts 树节点（Phase 4: 可视化用）
 */
export interface EChartsTreeNode {
    name: string;
    value: string;
    symbolSize: number;
    itemStyle: { color: string; borderColor: string };
    lineStyle: { color: string };
    label: { color: string };
    children: EChartsTreeNode[];
    _uri: string;
    _line: number;
}
