import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { SymbolEntry } from './types';

type ProgressReporter = (message: string) => void;

const SOURCE_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx']);

// 方案一：源头隔离脏代码目录（针对 LVGL/嵌入式/大型 C++ 工程优化）
const SKIP_DIRS = new Set([
    // 版本控制 & 构建产物
    '.git', '.svn', '.hg', 'node_modules', 'build', 'out', 'CMakeFiles', '__pycache__',
    // 测试 & 示例（Cscope 盲区的主要来源）
    'tests', 'test', 'examples', 'example', 'demos', 'demo', 'benchmark', 'benchmarks',
    'unity',                          // Unity 单元测试框架（LVGL tests 依赖）
    // 文档 & 资源
    'docs', 'doc', 'scripts', 'tools',
    // 常见第三方干扰库
    'LodePNG', 'lodepng',             // 图片解码库（含自带 main）
    'lv_fs_if',                       // LVGL 文件系统接口
    'lv_lib_png', 'lv_lib_gif',      // LVGL 第三方库
    'lv_demos',                       // LVGL 官方 demo（含 main）
]);

export class CscopeBackend {
    private cscopeDbPath: string;
    private cscopeFilesPath: string;
    private tagsPath: string;

    constructor(
        private rootPath: string,
        private cscopeCmd = 'cscope',
        private ctagsCmd = 'ctags'
    ) {
        this.cscopeDbPath = path.join(rootPath, 'cscope.out');
        this.cscopeFilesPath = path.join(rootPath, 'cscope.files');
        this.tagsPath = path.join(rootPath, 'tags');
    }

    async isAvailable(): Promise<{ cscope: boolean; ctags: boolean }> {
        const [cscope, ctags] = await Promise.all([
            this.commandExists(this.cscopeCmd),
            this.commandExists(this.ctagsCmd),
        ]);
        return { cscope, ctags };
    }

    hasCscopeDb(): boolean {
        return !!this.rootPath && fs.existsSync(this.cscopeDbPath);
    }

    async buildCscope(report?: ProgressReporter): Promise<void> {
        if (!this.rootPath) return;

        report?.('collecting source files');
        const files = await this.collectSourceFiles(this.rootPath);
        await fs.promises.writeFile(this.cscopeFilesPath, files.join('\n'), 'utf8');

        report?.(`${files.length} files, building cscope database`);
        await this.execFile(this.cscopeCmd, ['-b', '-q', '-k', '-i', this.cscopeFilesPath], this.rootPath);
    }

    async buildCtags(report?: ProgressReporter): Promise<void> {
        if (!this.rootPath) return;

        report?.('building ctags database');
        await this.execFile(this.ctagsCmd, ['-R', '-f', this.tagsPath, '.'], this.rootPath);
    }

    async findDefinitions(symbol: string): Promise<SymbolEntry[]> {
        const cscopeResults = await this.queryCscope('-1', symbol, 'definition');
        if (cscopeResults.length > 0) return cscopeResults;
        return this.queryTags(symbol);
    }

    async findReferences(symbol: string): Promise<SymbolEntry[]> {
        return this.queryCscope('-0', symbol, 'declaration');
    }

    async findCallers(symbol: string): Promise<SymbolEntry[]> {
        return this.queryCscope('-3', symbol, 'declaration');
    }

    async findCallees(symbol: string): Promise<SymbolEntry[]> {
        return this.queryCscope('-2', symbol, 'declaration');
    }

    private async queryCscope(
        mode: '-0' | '-1' | '-2' | '-3',
        symbol: string,
        kind: SymbolEntry['kind']
    ): Promise<SymbolEntry[]> {
        if (!this.rootPath || !this.hasCscopeDb()) return [];

        try {
            const stdout = await this.execFile(this.cscopeCmd, ['-d', '-L', mode, symbol], this.rootPath);
            return stdout
                .split(/\r?\n/)
                .map(line => this.parseCscopeLine(line, symbol, kind))
                .filter((entry): entry is SymbolEntry => !!entry);
        } catch {
            return [];
        }
    }

    private parseCscopeLine(line: string, fallbackName: string, kind: SymbolEntry['kind']): SymbolEntry | null {
        const trimmed = line.trim();
        if (!trimmed) return null;

        const match = trimmed.match(/^(\S+)\s+(\S+)\s+(\d+)\s+(.*)$/);
        if (!match) return null;

        const [, file, functionName, lineText, text] = match;
        const filePath = path.isAbsolute(file) ? file : path.join(this.rootPath, file);
        const name = functionName === '<global>' ? fallbackName : functionName;
        const character = Math.max(0, text.indexOf(fallbackName));

        return {
            name,
            qualifiedName: name,
            kind,
            uri: vscode.Uri.file(filePath).toString(),
            line: Math.max(0, Number(lineText) - 1),
            character,
            ifdefStack: [],
        };
    }

    private async queryTags(symbol: string): Promise<SymbolEntry[]> {
        if (!this.rootPath || !fs.existsSync(this.tagsPath)) return [];

        let content: string;
        try {
            content = await fs.promises.readFile(this.tagsPath, 'utf8');
        } catch {
            return [];
        }

        const results: SymbolEntry[] = [];
        for (const line of content.split(/\r?\n/)) {
            if (!line || line.startsWith('!')) continue;
            const parts = line.split('\t');
            if (parts.length < 3 || parts[0] !== symbol) continue;

            const filePath = path.isAbsolute(parts[1])
                ? parts[1]
                : path.join(this.rootPath, parts[1]);
            const location = await this.resolveTagLocation(filePath, parts[2], symbol);
            results.push({
                name: symbol,
                qualifiedName: symbol,
                kind: 'definition',
                uri: vscode.Uri.file(filePath).toString(),
                line: location.line,
                character: location.character,
                ifdefStack: [],
            });
        }

        return results;
    }

    private async resolveTagLocation(
        filePath: string,
        exCommand: string,
        symbol: string
    ): Promise<{ line: number; character: number }> {
        const lineNumber = Number(exCommand);
        if (Number.isFinite(lineNumber) && lineNumber > 0) {
            return { line: lineNumber - 1, character: 0 };
        }

        let pattern = exCommand
            .replace(/^\/\^?/, '')
            .replace(/\$?\/;"$/, '')
            .replace(/\\\//g, '/')
            .trim();

        try {
            const text = await fs.promises.readFile(filePath, 'utf8');
            const lines = text.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(pattern) || lines[i].includes(symbol)) {
                    return { line: i, character: Math.max(0, lines[i].indexOf(symbol)) };
                }
            }
        } catch {
            pattern = '';
        }

        return { line: 0, character: 0 };
    }

    private async collectSourceFiles(root: string): Promise<string[]> {
        const results: string[] = [];

        const walk = async (dir: string): Promise<void> => {
            let entries: fs.Dirent[];
            try {
                entries = await fs.promises.readdir(dir, { withFileTypes: true });
            } catch {
                return;
            }

            await Promise.all(entries.map(async entry => {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (!SKIP_DIRS.has(entry.name)) await walk(fullPath);
                    return;
                }

                if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
                    results.push(path.relative(root, fullPath).replace(/\\/g, '/'));
                }
            }));
        };

        await walk(root);
        return results.sort();
    }

    private async commandExists(command: string): Promise<boolean> {
        try {
            const versionArg = command.toLowerCase().includes('cscope') ? '-V' : '--version';
            await this.execFile(command, [versionArg], this.rootPath || undefined);
            return true;
        } catch {
            return false;
        }
    }

    private execFile(command: string, args: string[], cwd?: string): Promise<string> {
        return new Promise((resolve, reject) => {
            cp.execFile(command, args, { cwd, windowsHide: true, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
                if (err) {
                    reject(new Error(stderr || err.message));
                    return;
                }
                resolve(stdout);
            });
        });
    }
}
