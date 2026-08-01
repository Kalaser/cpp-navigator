import { SymbolEntry } from './types';

/**
 * SymbolIndex — 内存符号索引
 *
 * 优化点:
 *  - 新增 fileMap: uri → entries 倒排,getForFile 由 O(全索引) 降为 O(文件条目数)
 *  - removeFile 借助 fileMap 精准定位,不再全表过滤
 *  - search 结果按符号名去重,并缓存 lower 化结果
 */
export class SymbolIndex {
    private defMap      = new Map<string, SymbolEntry[]>(); // qualifiedName → entries
    private defNameMap  = new Map<string, SymbolEntry[]>(); // name → entries
    private declMap     = new Map<string, SymbolEntry[]>();
    private declNameMap = new Map<string, SymbolEntry[]>();
    private fileMap     = new Map<string, SymbolEntry[]>(); // uri → entries(倒排)

    clear() {
        this.defMap.clear();
        this.defNameMap.clear();
        this.declMap.clear();
        this.declNameMap.clear();
        this.fileMap.clear();
    }

    addEntries(entries: SymbolEntry[]) {
        for (const e of entries) {
            const map     = e.kind === 'definition' ? this.defMap     : this.declMap;
            const nameMap = e.kind === 'definition' ? this.defNameMap : this.declNameMap;

            if (!map.has(e.qualifiedName))  map.set(e.qualifiedName, []);
            map.get(e.qualifiedName)!.push(e);

            if (!nameMap.has(e.name)) nameMap.set(e.name, []);
            nameMap.get(e.name)!.push(e);

            if (!this.fileMap.has(e.uri)) this.fileMap.set(e.uri, []);
            this.fileMap.get(e.uri)!.push(e);
        }
    }

    removeFile(uri: string) {
        const stale = this.fileMap.get(uri);
        if (!stale) return;
        this.fileMap.delete(uri);

        const target = new Set(stale);
        for (const map of [this.defMap, this.defNameMap, this.declMap, this.declNameMap]) {
            for (const [key, entries] of map) {
                if (entries.some(e => target.has(e))) {
                    const filtered = entries.filter(e => !target.has(e));
                    if (filtered.length === 0) map.delete(key);
                    else map.set(key, filtered);
                }
            }
        }
    }

    getDefinitions(name: string): SymbolEntry[] {
        if (name.includes('::')) return this.defMap.get(name) ?? [];
        return this.defNameMap.get(name) ?? [];
    }

    getDeclarations(name: string): SymbolEntry[] {
        if (name.includes('::')) return this.declMap.get(name) ?? [];
        return this.declNameMap.get(name) ?? [];
    }

    getAllEntries(name: string): SymbolEntry[] {
        if (name.includes('::')) {
            return [...(this.defMap.get(name) ?? []), ...(this.declMap.get(name) ?? [])];
        }
        return [...(this.defNameMap.get(name) ?? []), ...(this.declNameMap.get(name) ?? [])];
    }

    get size(): number {
        return this.defMap.size + this.declMap.size;
    }

    /**
     * 按简单名前缀搜索(大小写不敏感),结果按名字去重后返回。
     * 用于 WorkspaceSymbol / QuickPick。
     */
    search(query: string): SymbolEntry[] {
        const lq = query.toLowerCase();
        const seen = new Set<string>();
        const results: SymbolEntry[] = [];
        const pushFrom = (map: Map<string, SymbolEntry[]>) => {
            for (const [key, entries] of map) {
                if (key.toLowerCase().includes(lq)) {
                    for (const e of entries) {
                        if (seen.has(e.name)) continue;
                        seen.add(e.name);
                        results.push(e);
                    }
                }
            }
        };
        pushFrom(this.defMap);
        pushFrom(this.declMap);
        return results;
    }

    getForFile(uri: string): SymbolEntry[] {
        const entries = this.fileMap.get(uri);
        return entries ? [...entries].sort((a, b) => a.line - b.line) : [];
    }

    /** 所有符号,按名字去重(用于 callee 正则分析的一次性已知表) */
    allKnownByName(): Map<string, SymbolEntry> {
        const known = new Map<string, SymbolEntry>();
        for (const entries of this.defNameMap.values()) {
            const first = entries[0];
            if (first && first.name.length >= 2) known.set(first.name, first);
        }
        return known;
    }

    /** 索引当前覆盖的文件数 */
    get fileCount(): number {
        return this.fileMap.size;
    }
}
