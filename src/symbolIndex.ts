import { SymbolEntry } from './types';

export class SymbolIndex {
    // name → 所有匹配的符号（可能跨文件有多个定义）
    private defMap  = new Map<string, SymbolEntry[]>();
    private declMap = new Map<string, SymbolEntry[]>();

    clear() {
        this.defMap.clear();
        this.declMap.clear();
    }

    addEntries(entries: SymbolEntry[]) {
        for (const e of entries) {
            const map = e.kind === 'definition' ? this.defMap : this.declMap;
            if (!map.has(e.name)) map.set(e.name, []);
            map.get(e.name)!.push(e);
        }
    }

    // 移除某个文件的所有符号（文件保存时增量更新用）
    removeFile(uri: string) {
        for (const map of [this.defMap, this.declMap]) {
            for (const [key, entries] of map) {
                const filtered = entries.filter(e => e.uri !== uri);
                if (filtered.length === 0) map.delete(key);
                else map.set(key, filtered);
            }
        }
    }

    getDefinitions(name: string): SymbolEntry[] {
        return this.defMap.get(name) ?? [];
    }

    getDeclarations(name: string): SymbolEntry[] {
        return this.declMap.get(name) ?? [];
    }

    // 查找所有引用（定义 + 声明都算）
    getAllEntries(name: string): SymbolEntry[] {
        return [
            ...(this.defMap.get(name) ?? []),
            ...(this.declMap.get(name) ?? []),
        ];
    }

    get size(): number {
        return this.defMap.size + this.declMap.size;
    }

    // 全局模糊搜索（用于 Ctrl+T 工作区符号搜索）
    search(query: string): SymbolEntry[] {
        const lowerQuery = query.toLowerCase();
        const results: SymbolEntry[] = [];
        for (const [key, entries] of this.defMap) {
            if (key.toLowerCase().includes(lowerQuery)) results.push(...entries);
        }
        for (const [key, entries] of this.declMap) {
            if (key.toLowerCase().includes(lowerQuery)) results.push(...entries);
        }
        return results;
    }

    // 获取单个文件的所有符号（用于侧边栏大纲视图和顶部面包屑）
    getForFile(uri: string): SymbolEntry[] {
        const results: SymbolEntry[] = [];
        for (const entries of this.defMap.values()) {
            results.push(...entries.filter(e => e.uri === uri));
        }
        // 按行号排序，确保大纲视图中的结构顺序和代码一致
        return results.sort((a, b) => a.line - b.line);
    }
}