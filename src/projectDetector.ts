// src/projectDetector.ts

import * as fs from 'fs';
import * as path from 'path';

export interface ProjectContext {
    defines: string[];       // 自动发现的宏
    includePaths: string[];  // 头文件路径
}

export function detectProject(rootPath: string): ProjectContext {
    const ctx: ProjectContext = { defines: [], includePaths: [] };

    // ── 尝试读取 compile_commands.json ──────────────────
    const ccPath = path.join(rootPath, 'compile_commands.json');
    if (fs.existsSync(ccPath)) {
        try {
            const cc = JSON.parse(fs.readFileSync(ccPath, 'utf8')) as Array<{
                command?: string;
                arguments?: string[];
            }>;
            const firstEntry = cc[0];
            const args = firstEntry?.arguments
                ?? firstEntry?.command?.split(/\s+/)
                ?? [];

            for (const arg of args) {
                if (arg.startsWith('-D')) ctx.defines.push(arg.slice(2));
                if (arg.startsWith('-I')) ctx.includePaths.push(arg.slice(2));
            }
        } catch {}
    }

    // ── 尝试读取 CMakeCache.txt ──────────────────────────
    const cmakeCachePath = path.join(rootPath, 'CMakeCache.txt');
    if (fs.existsSync(cmakeCachePath)) {
        const lines = fs.readFileSync(cmakeCachePath, 'utf8').split('\n');
        for (const line of lines) {
            const m = line.match(/^(\w+):BOOL=ON/);
            if (m) ctx.defines.push(m[1]);
        }
    }

    // ── 尝试读取 .config（Kconfig 产物，NuttX/Linux 通用）──
    const kconfigPath = path.join(rootPath, '.config');
    if (fs.existsSync(kconfigPath)) {
        const lines = fs.readFileSync(kconfigPath, 'utf8').split('\n');
        for (const line of lines) {
            const m = line.match(/^(CONFIG_\w+)=y$/);
            if (m) ctx.defines.push(m[1]);
        }
    }

    return ctx;
}