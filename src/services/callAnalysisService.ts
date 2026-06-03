/**
 * 向后兼容层 — 实际逻辑已迁移至:
 *   - src/callTreeManager.ts   (LRU 缓存 + 调用分析 + 懒加载)
 *   - src/callGraphWebview.ts  (ECharts 蝴蝶结可视化)
 *   - src/utils/lruCache.ts    (通用 LRU 缓存)
 *
 * 本文件仅保留 CallHierarchyProvider 需要的 re-export。
 */

import { LRUCache } from '../utils/lruCache';
import { SymbolEntry } from '../types';

const callerCache = new LRUCache<SymbolEntry[]>(200);
const calleeCache = new LRUCache<SymbolEntry[]>(200);

export function clearCallCache(): void {
    callerCache.clear();
    calleeCache.clear();
}
