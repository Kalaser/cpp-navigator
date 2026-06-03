import * as vscode from 'vscode';
import { ManualLink, SymbolEntry } from './types';
import { SymbolIndex } from './symbolIndex';

/**
 * Task 2.1: 手动映射持久化模块
 * 将面向对象的 C 结构体回调（如 ops->read）与实际定义点连接
 */
export class ManualLinkManager {
    private links: ManualLink[] = [];
    private static STORAGE_KEY = 'cppNavigator.manualLinks';

    constructor(private context: vscode.ExtensionContext) {
        this.links = context.workspaceState.get<ManualLink[]>(ManualLinkManager.STORAGE_KEY, []);
    }

    /** 添加一条手动映射 */
    addLink(caller: SymbolEntry, calleeName: string, note?: string): void {
        const id = `${caller.uri}:${caller.line}:${calleeName}:${Date.now()}`;
        // 去重
        const exists = this.links.some(l =>
            l.callerUri === caller.uri &&
            l.callerLine === caller.line &&
            l.calleeName === calleeName
        );
        if (exists) return;

        this.links.push({
            id,
            callerUri: caller.uri,
            callerLine: caller.line,
            callerName: caller.name,
            calleeName,
            createdAt: Date.now(),
            note,
        });
        void this.save();
    }

    /** 移除一条手动映射 */
    removeLink(id: string): void {
        this.links = this.links.filter(l => l.id !== id);
        void this.save();
    }

    /** 获取某个函数的所有手动 Callee */
    getManualCallees(callerUri: string, callerLine: number): ManualLink[] {
        return this.links.filter(l => l.callerUri === callerUri && l.callerLine === callerLine);
    }

    /** 获取某个 calleeName 的所有手动 Caller */
    getManualCallers(calleeName: string): ManualLink[] {
        return this.links.filter(l => l.calleeName === calleeName);
    }

    /** 将 ManualLink 转换为 SymbolEntry（用于合并到调用树） */
    resolveCalleeLinks(
        callerUri: string,
        callerLine: number,
        index: SymbolIndex
    ): SymbolEntry[] {
        const links = this.getManualCallees(callerUri, callerLine);
        const results: SymbolEntry[] = [];
        for (const link of links) {
            const defs = index.getDefinitions(link.calleeName);
            if (defs.length > 0) {
                results.push(defs[0]);
            } else {
                // 即使索引中找不到定义，也生成一个占位节点
                results.push({
                    name: link.calleeName,
                    qualifiedName: link.calleeName,
                    kind: 'definition',
                    uri: link.callerUri,
                    line: link.callerLine,
                    character: 0,
                    ifdefStack: [],
                });
            }
        }
        return results;
    }

    /** 获取所有手动映射 */
    getAllLinks(): ManualLink[] {
        return [...this.links];
    }

    /** 清空所有手动映射 */
    clearAll(): void {
        this.links = [];
        void this.save();
    }

    private async save(): Promise<void> {
        await this.context.workspaceState.update(ManualLinkManager.STORAGE_KEY, this.links);
    }
}
