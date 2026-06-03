/**
 * LRU Cache — 基于 Map 的最近最少使用缓存
 * Task 1.1: 独立工具，供 CallTreeManager 和 CallAnalysisService 共用
 */
export class LRUCache<V> {
    private cache = new Map<string, V>();

    constructor(private maxSize: number = 200) {}

    get(key: string): V | undefined {
        const val = this.cache.get(key);
        if (val !== undefined) {
            this.cache.delete(key);
            this.cache.set(key, val);
        }
        return val;
    }

    set(key: string, value: V): void {
        if (this.cache.has(key)) this.cache.delete(key);
        this.cache.set(key, value);
        if (this.cache.size > this.maxSize) {
            const oldest = this.cache.keys().next().value;
            if (oldest !== undefined) this.cache.delete(oldest);
        }
    }

    has(key: string): boolean {
        return this.cache.has(key);
    }

    delete(key: string): boolean {
        return this.cache.delete(key);
    }

    clear(): void {
        this.cache.clear();
    }

    get size(): number {
        return this.cache.size;
    }
}
