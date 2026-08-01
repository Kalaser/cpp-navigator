import * as fs from 'fs';
import * as path from 'path';
import { SymbolEntry } from './types';

interface FileMeta {
    mtime: number;
    symbolCount: number;
}

interface PersistedIndex {
    files: Record<string, FileMeta>;
    symbols: SymbolEntry[];
}

type SqliteDatabase = {
    exec(sql: string): void;
    prepare(sql: string): {
        get(...args: unknown[]): unknown;
        all(...args: unknown[]): unknown[];
        run(...args: unknown[]): unknown;
    };
    transaction(fn: () => void): () => void;
    close(): void;
};

// better-sqlite3 是可选依赖：原生模块构建失败时会抛异常。
// 这里缓存模块引用，避免每次 activate 都重新触发一次加载失败。
let sqliteModule: (new (filename: string) => SqliteDatabase) | null | undefined;

function loadSqliteModule(): (new (filename: string) => SqliteDatabase) | null {
    if (sqliteModule !== undefined) return sqliteModule;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        sqliteModule = require('better-sqlite3') as (new (filename: string) => SqliteDatabase);
    } catch {
        sqliteModule = null;
    }
    return sqliteModule;
}

export class IndexDatabase {
    public isReady = false;

    private sqlite: SqliteDatabase | null = null;
    private storagePath: string;
    private jsonPath: string;
    private data: PersistedIndex = { files: {}, symbols: [] };

    constructor(storagePath: string) {
        this.storagePath = storagePath;
        this.jsonPath = path.join(storagePath, 'symbol-index.json');
    }

    async open(): Promise<void> {
        await fs.promises.mkdir(this.storagePath, { recursive: true });

        const Database = loadSqliteModule();
        if (Database) {
            try {
                this.sqlite = new Database(path.join(this.storagePath, 'symbol-index.db'));
                this.initSqlite();
            } catch {
                this.sqlite = null;
            }
        }
        if (!this.sqlite) {
            await this.loadJson();
        }

        this.isReady = true;
    }

    needsReindex(uri: string, mtime: number): boolean {
        if (this.sqlite) {
            const row = this.sqlite
                .prepare('SELECT mtime FROM file_meta WHERE uri = ?')
                .get(uri) as { mtime: number } | undefined;
            return !row || row.mtime !== mtime;
        }

        const meta = this.data.files[uri];
        return !meta || meta.mtime !== mtime;
    }

    updateFile(uri: string, mtime: number, entries: SymbolEntry[]): void {
        if (this.sqlite) {
            const del = this.sqlite.prepare('DELETE FROM symbols WHERE uri = ?');
            const ins = this.sqlite.prepare(`
                INSERT INTO symbols(name, qualified_name, kind, uri, line, character, ifdef_stack)
                VALUES (@name, @qualifiedName, @kind, @uri, @line, @character, @ifdefStack)
            `);
            const meta = this.sqlite.prepare(`
                INSERT OR REPLACE INTO file_meta(uri, mtime, symbol_count)
                VALUES (?, ?, ?)
            `);

            this.sqlite.transaction(() => {
                del.run(uri);
                for (const e of entries) {
                    ins.run({ ...e, ifdefStack: JSON.stringify(e.ifdefStack) });
                }
                meta.run(uri, mtime, entries.length);
            })();
            return;
        }

        this.data.symbols = this.data.symbols.filter(e => e.uri !== uri).concat(entries);
        this.data.files[uri] = { mtime, symbolCount: entries.length };
        this.saveJson();
    }

    loadAll(): SymbolEntry[] {
        if (this.sqlite) {
            const rows = this.sqlite.prepare(`
                SELECT name, qualified_name, kind, uri, line, character, ifdef_stack
                FROM symbols
            `).all() as Array<{
                name: string;
                qualified_name: string;
                kind: 'definition' | 'declaration';
                uri: string;
                line: number;
                character: number;
                ifdef_stack: string;
            }>;

            return rows.map(r => ({
                name: r.name,
                qualifiedName: r.qualified_name,
                kind: r.kind,
                uri: r.uri,
                line: r.line,
                character: r.character,
                ifdefStack: this.parseIfdefs(r.ifdef_stack),
            }));
        }

        return [...this.data.symbols];
    }

    getByName(name: string): SymbolEntry[] {
        if (this.sqlite) {
            const rows = this.sqlite.prepare(`
                SELECT name, qualified_name, kind, uri, line, character, ifdef_stack
                FROM symbols
                WHERE name = ? OR qualified_name = ?
            `).all(name, name) as Array<{
                name: string;
                qualified_name: string;
                kind: 'definition' | 'declaration';
                uri: string;
                line: number;
                character: number;
                ifdef_stack: string;
            }>;

            return rows.map(r => ({
                name: r.name,
                qualifiedName: r.qualified_name,
                kind: r.kind,
                uri: r.uri,
                line: r.line,
                character: r.character,
                ifdefStack: this.parseIfdefs(r.ifdef_stack),
            }));
        }

        return this.data.symbols.filter(e => e.name === name || e.qualifiedName === name);
    }

    removeFile(uri: string): void {
        if (this.sqlite) {
            this.sqlite.prepare('DELETE FROM symbols WHERE uri = ?').run(uri);
            this.sqlite.prepare('DELETE FROM file_meta WHERE uri = ?').run(uri);
            return;
        }

        delete this.data.files[uri];
        this.data.symbols = this.data.symbols.filter(e => e.uri !== uri);
        this.saveJson();
    }

    stats(): { symbols: number; files: number } {
        if (this.sqlite) {
            const symbolRow = this.sqlite.prepare('SELECT COUNT(*) AS count FROM symbols').get() as { count: number };
            const fileRow = this.sqlite.prepare('SELECT COUNT(*) AS count FROM file_meta').get() as { count: number };
            return { symbols: symbolRow.count, files: fileRow.count };
        }

        return { symbols: this.data.symbols.length, files: Object.keys(this.data.files).length };
    }

    close(): void {
        if (this.sqlite) {
            this.sqlite.close();
            this.sqlite = null;
        } else {
            this.saveJson();
        }
    }

    private initSqlite(): void {
        this.sqlite?.exec(`
            CREATE TABLE IF NOT EXISTS symbols (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                qualified_name TEXT NOT NULL,
                kind TEXT NOT NULL,
                uri TEXT NOT NULL,
                line INTEGER NOT NULL,
                character INTEGER NOT NULL,
                ifdef_stack TEXT DEFAULT '[]'
            );
            CREATE TABLE IF NOT EXISTS file_meta (
                uri TEXT PRIMARY KEY,
                mtime INTEGER NOT NULL,
                symbol_count INTEGER DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_name ON symbols(name);
            CREATE INDEX IF NOT EXISTS idx_qname ON symbols(qualified_name);
            CREATE INDEX IF NOT EXISTS idx_uri ON symbols(uri);
            CREATE INDEX IF NOT EXISTS idx_uri_line ON symbols(uri, line);
            CREATE INDEX IF NOT EXISTS idx_kind_uri ON symbols(kind, uri);
        `);
    }

    private async loadJson(): Promise<void> {
        try {
            const raw = await fs.promises.readFile(this.jsonPath, 'utf8');
            const parsed = JSON.parse(raw) as PersistedIndex;
            this.data = {
                files: parsed.files ?? {},
                symbols: Array.isArray(parsed.symbols) ? parsed.symbols : [],
            };
        } catch {
            this.data = { files: {}, symbols: [] };
        }
    }

    private saveJson(): void {
        fs.mkdirSync(this.storagePath, { recursive: true });
        fs.writeFileSync(this.jsonPath, JSON.stringify(this.data), 'utf8');
    }

    private parseIfdefs(value: string): string[] {
        try {
            const parsed = JSON.parse(value) as unknown;
            return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
        } catch {
            return [];
        }
    }
}
