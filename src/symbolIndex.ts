import { SymbolEntry } from './types';

export class SymbolIndex {
    private defMap      = new Map<string, SymbolEntry[]>(); // qualifiedName → entries
    private defNameMap  = new Map<string, SymbolEntry[]>(); // name → entries
    private declMap     = new Map<string, SymbolEntry[]>();
    private declNameMap = new Map<string, SymbolEntry[]>();

    clear() {
        this.defMap.clear();
        this.defNameMap.clear();
        this.declMap.clear();
        this.declNameMap.clear();
    }

    addEntries(entries: SymbolEntry[]) {
        for (const e of entries) {
            const map     = e.kind === 'definition' ? this.defMap     : this.declMap;
            const nameMap = e.kind === 'definition' ? this.defNameMap : this.declNameMap;

            if (!map.has(e.qualifiedName))  map.set(e.qualifiedName, []);
            map.get(e.qualifiedName)!.push(e);

            if (!nameMap.has(e.name)) nameMap.set(e.name, []);
            nameMap.get(e.name)!.push(e);
        }
    }

    removeFile(uri: string) {
        for (const map of [this.defMap, this.defNameMap, this.declMap, this.declNameMap]) {
            for (const [key, entries] of map) {
                const filtered = entries.filter(e => e.uri !== uri);
                if (filtered.length === 0) map.delete(key);
                else map.set(key, filtered);
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

    search(query: string): SymbolEntry[] {
        const lq = query.toLowerCase();
        const results: SymbolEntry[] = [];
        for (const [key, entries] of this.defMap)  if (key.toLowerCase().includes(lq)) results.push(...entries);
        for (const [key, entries] of this.declMap) if (key.toLowerCase().includes(lq)) results.push(...entries);
        return results;
    }

    getForFile(uri: string): SymbolEntry[] {
        const results: SymbolEntry[] = [];
        for (const entries of this.defMap.values()) results.push(...entries.filter(e => e.uri === uri));
        return results.sort((a, b) => a.line - b.line);
    }
}