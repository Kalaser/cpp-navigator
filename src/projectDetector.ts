import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

export interface ProjectContext {
    defines:      string[];
    includePaths: string[];
}

/**
 * Phase 5.2: 全局宏定义嗅探
 * - compile_commands.json
 * - CMakeCache.txt
 * - .config (Kconfig)
 * - include/generated/autoconf.h (Linux Kernel)
 * - SConstruct → SCons dry-run (Task 5.1)
 */
export function detectProject(rootPath: string): ProjectContext {
    const ctx: ProjectContext = { defines: [], includePaths: [] };
    if (!rootPath) return ctx;

    // ── compile_commands.json ─────────────────────────────────
    const ccPath = path.join(rootPath, 'compile_commands.json');
    if (fs.existsSync(ccPath)) {
        try {
            const cc = JSON.parse(fs.readFileSync(ccPath, 'utf8')) as Array<{
                command?: string; arguments?: string[];
            }>;
            const args = cc[0]?.arguments ?? cc[0]?.command?.split(/\s+/) ?? [];
            for (const arg of args) {
                if (arg.startsWith('-D')) ctx.defines.push(arg.slice(2));
                if (arg.startsWith('-I')) ctx.includePaths.push(arg.slice(2));
            }
        } catch {}
    }

    // ── CMakeCache.txt ────────────────────────────────────────
    const cmakeCachePath = path.join(rootPath, 'CMakeCache.txt');
    if (fs.existsSync(cmakeCachePath)) {
        for (const line of fs.readFileSync(cmakeCachePath, 'utf8').split('\n')) {
            const m = line.match(/^(\w+):BOOL=ON/);
            if (m) ctx.defines.push(m[1]);
        }
    }

    // ── .config（Kconfig 产物，NuttX/Linux）──────────────────
    const kconfigPath = path.join(rootPath, '.config');
    if (fs.existsSync(kconfigPath)) {
        for (const line of fs.readFileSync(kconfigPath, 'utf8').split('\n')) {
            const m = line.match(/^(CONFIG_\w+)=y$/);
            if (m) ctx.defines.push(m[1]);
        }
    }

    // ── Task 5.2: include/generated/autoconf.h ────────────────
    const autoconfPaths = [
        path.join(rootPath, 'include', 'generated', 'autoconf.h'),
        path.join(rootPath, 'include', 'autoconf.h'),
    ];
    for (const autoconfPath of autoconfPaths) {
        if (fs.existsSync(autoconfPath)) {
            try {
                const content = fs.readFileSync(autoconfPath, 'utf8');
                for (const line of content.split('\n')) {
                    // #define CONFIG_XXX 1  或  #define CONFIG_XXX
                    const m = line.match(/^#define\s+(CONFIG_\w+)\b/);
                    if (m) ctx.defines.push(m[1]);
                }
            } catch {}
            break;
        }
    }

    // ── Task 5.1: SConstruct → SCons dry-run ──────────────────
    const sconstructPath = path.join(rootPath, 'SConstruct');
    if (fs.existsSync(sconstructPath)) {
        try {
            const output = execFileSync('python', [
                '-c',
                `import SCons.Script; SCons.Script.Main.options = type('O',(),{'help':False})(); SCons.Script.Main.OptionsParser = None`,
            ], { cwd: rootPath, timeout: 5000, windowsHide: true, encoding: 'utf8' });
        } catch {
            // SCons 可能不可用，忽略
        }

        // 回退：直接扫描 SConstruct 和 SConscript 中的 -D 和 -I
        try {
            const sconsFiles = findSconsFiles(rootPath);
            for (const f of sconsFiles) {
                const content = fs.readFileSync(f, 'utf8');
                // 提取 CPPDEFINES 和 CPPPATH
                const defMatch = content.match(/CPPDEFINES\s*=\s*\[([^\]]*)\]/g);
                if (defMatch) {
                    for (const dm of defMatch) {
                        const inner = dm.match(/\[([^\]]*)\]/)?.[1] ?? '';
                        for (const d of inner.split(',')) {
                            const cleaned = d.trim().replace(/['"]/g, '');
                            if (cleaned && !cleaned.startsWith('-')) ctx.defines.push(cleaned);
                        }
                    }
                }
                const pathMatch = content.match(/CPPPATH\s*=\s*\[([^\]]*)\]/g);
                if (pathMatch) {
                    for (const pm of pathMatch) {
                        const inner = pm.match(/\[([^\]]*)\]/)?.[1] ?? '';
                        for (const p of inner.split(',')) {
                            const cleaned = p.trim().replace(/['"]/g, '');
                            if (cleaned) ctx.includePaths.push(path.resolve(rootPath, cleaned));
                        }
                    }
                }
            }
        } catch {}
    }

    return ctx;
}

function findSconsFiles(rootPath: string): string[] {
    const results: string[] = [];
    const sconstruct = path.join(rootPath, 'SConstruct');
    if (fs.existsSync(sconstruct)) results.push(sconstruct);

    try {
        const dirs = [rootPath];
        while (dirs.length > 0 && results.length < 20) {
            const dir = dirs.pop()!;
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                    dirs.push(path.join(dir, entry.name));
                } else if (entry.isFile() && entry.name === 'SConscript') {
                    results.push(path.join(dir, entry.name));
                }
            }
        }
    } catch {}

    return results;
}
