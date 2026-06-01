import * as fs from 'fs';
import * as path from 'path';

export interface ProjectContext {
    defines:      string[];
    includePaths: string[];
}

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

    return ctx;
}