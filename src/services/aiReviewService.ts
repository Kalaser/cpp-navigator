import * as vscode from 'vscode';
import { AiReviewCandidate, AiReviewDecision, AiReviewRequest, AiReviewResult, CallDirection, SymbolEntry } from '../types';
import { SymbolIndex } from '../symbolIndex';

interface AiReviewRuntimeConfig {
    enabled: boolean;
    provider: AiProvider;
    endpoint: string;
    apiKey: string;
    model: string;
    timeoutMs: number;
    contextLines: number;
    batchSize: number;
}

interface RawAiResponse {
    validNodeIds?: string[];
    invalidNodeIds?: Array<string | { id?: string; reason?: string }>;
    inferredNodes?: Array<{ name?: string; reason?: string }>;
}

interface DeepSeekChatCompletionResponse {
    choices?: Array<{
        message?: {
            content?: string | null;
        };
    }>;
}

type AiProvider = 'deepseek' | 'xiaomi' | 'custom';

const PROVIDER_DEFAULTS: Record<Exclude<AiProvider, 'custom'>, { endpoint: string; model: string; label: string }> = {
    deepseek: {
        endpoint: 'https://api.deepseek.com',
        model: 'deepseek-v4-pro',
        label: 'DeepSeek',
    },
    xiaomi: {
        endpoint: 'https://api.xiaomimimo.com/v1',
        model: 'mimo-v2.5-pro',
        label: 'Xiaomi MiMo',
    },
};

const DEEPSEEK_API_KEY_SECRET = 'cppNavigator.deepSeekApiKey';
const XIAOMI_API_KEY_SECRET = 'cppNavigator.xiaomiApiKey';

export class AiReviewService {
    constructor(private readonly secrets?: vscode.SecretStorage) {}

    isEnabled(): boolean {
        return this.getBaseConfig().enabled;
    }

    getBatchSize(): number {
        return this.getBaseConfig().batchSize;
    }

    async isReady(): Promise<boolean> {
        return this.getBaseConfig().enabled && (await this.hasApiKey());
    }

    async hasApiKey(provider = this.getBaseConfig().provider): Promise<boolean> {
        return (await this.resolveApiKey(provider)).length > 0;
    }

    async storeApiKey(apiKey: string, provider = this.getBaseConfig().provider): Promise<void> {
        if (!this.secrets) return;
        await this.secrets.store(getApiKeySecret(provider), apiKey);
    }

    async clearApiKey(provider = this.getBaseConfig().provider): Promise<void> {
        if (!this.secrets) return;
        await this.secrets.delete(getApiKeySecret(provider));
    }

    async reviewCandidates(
        targetSymbol: string,
        direction: CallDirection,
        candidates: SymbolEntry[],
        index: SymbolIndex,
        activeConfigs: string[]
    ): Promise<AiReviewResult> {
        const cfg = await this.getConfig();
        if (!cfg.enabled) {
            throw new Error('AI review is disabled. Enable cppNavigator.ai.enabled first.');
        }
        if (!cfg.apiKey) {
            throw new Error(`${getProviderLabel(cfg.provider)} API key is missing. Run the matching configure API key command or set ${getProviderEnvHint(cfg.provider)}.`);
        }

        const targetSignatures = await this.collectTargetSignatures(targetSymbol, index, cfg.contextLines);
        const reviewed: AiReviewDecision[] = [];
        const inferredSymbols: AiReviewResult['inferredSymbols'] = [];

        for (let i = 0; i < candidates.length; i += cfg.batchSize) {
            const batch = candidates.slice(i, i + cfg.batchSize);
            const request: AiReviewRequest = {
                targetSymbol,
                direction,
                activeConfigs,
                targetSignatures,
                candidates: await Promise.all(batch.map(entry => this.toCandidate(direction, entry, cfg.contextLines))),
            };

            const result = await this.askModel(request, cfg);
            reviewed.push(...result.decisions);
            inferredSymbols.push(...result.inferredSymbols);
        }

        return { decisions: reviewed, inferredSymbols };
    }

    // ── 通用 AI 分析方法（供各 Provider 调用）─────────────────

    /** 多定义消歧：当同一符号存在多个定义时，根据上下文判断正确的一个 */
    async disambiguateDefinition(
        word: string,
        contextSnippet: string,
        candidates: Array<{ file: string; line: number; snippet: string }>
    ): Promise<number> {
        const prompt = [
            `The user is looking at symbol "${word}" in this context:`,
            '```cpp',
            contextSnippet,
            '```',
            '',
            `There are ${candidates.length} definitions with the same name. Which one is the correct target?`,
            ...candidates.map((c, i) => `[${i}] ${c.file}:${c.line + 1}\n${c.snippet}`),
            '',
            'Return JSON: {"index": <number>, "reason": "<brief>"}',
        ].join('\n');

        const raw = await this.askQuick(prompt, 10000);
        if (raw === null) return 0;
        try {
            const parsed = JSON.parse(raw);
            const idx = typeof parsed.index === 'number' ? parsed.index : 0;
            return idx >= 0 && idx < candidates.length ? idx : 0;
        } catch { return 0; }
    }

    /** 引用过滤：从文本搜索结果中剔除注释、字符串、宏等误匹配 */
    async filterReferences(
        word: string,
        candidates: Array<{ file: string; line: number; snippet: string }>
    ): Promise<number[]> {
        if (candidates.length === 0) return [];
        const prompt = [
            `A text search for C/C++ symbol "${word}" found these locations.`,
            'Filter out false positives: matches in comments, string literals, macro bodies, or unrelated scopes.',
            'Return JSON: {"validIndices": [0, 2, ...]} — only indices of real call/reference sites.',
            '',
            ...candidates.map((c, i) => `[${i}] ${c.file}:${c.line + 1}\n${c.snippet}`),
        ].join('\n');

        const raw = await this.askQuick(prompt, 15000);
        if (raw === null) return candidates.map((_, i) => i);
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed.validIndices) ? parsed.validIndices : candidates.map((_, i) => i);
        } catch { return candidates.map((_, i) => i); }
    }

    /** 调用层级分析：验证 caller/callee 结果，推断函数指针回调 */
    async analyzeCallHierarchy(
        symbol: string,
        direction: 'incoming' | 'outgoing',
        candidates: Array<{ name: string; file: string; line: number; snippet: string }>
    ): Promise<{ valid: number[]; inferred: string[] }> {
        if (candidates.length === 0) return { valid: [], inferred: [] };
        const dirLabel = direction === 'incoming' ? 'callers' : 'callees';
        const prompt = [
            `Analyze the ${dirLabel} of C/C++ function "${symbol}".`,
            'Verify which candidates are real call relationships. Also infer function-pointer/callback targets if visible.',
            '',
            ...candidates.map((c, i) => `[${i}] ${c.name} @ ${c.file}:${c.line + 1}\n${c.snippet}`),
            '',
            'Return JSON: {"validIndices": [0,1,...], "inferredSymbols": ["name1","name2",...]}',
        ].join('\n');

        const raw = await this.askQuick(prompt, 15000);
        if (raw === null) return { valid: candidates.map((_, i) => i), inferred: [] };
        try {
            const parsed = JSON.parse(raw);
            return {
                valid: Array.isArray(parsed.validIndices) ? parsed.validIndices : candidates.map((_, i) => i),
                inferred: Array.isArray(parsed.inferredSymbols) ? parsed.inferredSymbols : [],
            };
        } catch { return { valid: candidates.map((_, i) => i), inferred: [] }; }
    }

    /** Hover 增强：为符号生成简短的中文功能说明 */
    async summarizeSymbol(word: string, snippet: string): Promise<string | null> {
        const prompt = [
            'In 1-2 sentences (Chinese), describe what this C/C++ function/symbol does:',
            '```cpp',
            snippet,
            '```',
            '',
            'Return JSON: {"summary": "..."}',
        ].join('\n');

        const raw = await this.askQuick(prompt, 10000);
        if (raw === null) return null;
        try {
            const parsed = JSON.parse(raw);
            return typeof parsed.summary === 'string' ? parsed.summary : null;
        } catch { return null; }
    }

    /** 深度分析函数：AI 读取源码，输出功能说明、算法、注意事项 */
    async analyzeFunction(word: string, snippet: string): Promise<string | null> {
        const prompt = [
            `请对以下 C/C++ 函数 "${word}" 进行深度分析。`,
            '请用中文回答，包含以下内容：',
            '1. **功能概述**：这个函数做什么',
            '2. **核心逻辑**：关键算法或处理流程',
            '3. **参数与返回值**：各参数含义、返回值语义',
            '4. **调用关系**：调用了哪些关键函数，可能被谁调用',
            '5. **注意事项**：潜在的 bug 风险、线程安全、内存问题等',
            '',
            '源码：',
            '```cpp',
            snippet,
            '```',
            '',
            'Return JSON: {"analysis": "markdown formatted analysis"}',
        ].join('\n');

        const raw = await this.askQuick(prompt, 30000);
        if (raw === null) return null;
        try {
            const parsed = JSON.parse(raw);
            return typeof parsed.analysis === 'string' ? parsed.analysis : null;
        } catch { return null; }
    }

    /** 调用链分析：AI 解释函数的上下游调用关系和数据流 */
    async explainCallChain(
        word: string,
        snippet: string,
        callers: Array<{ name: string; file: string; line: number }>,
        callees: Array<{ name: string; file: string; line: number }>
    ): Promise<string | null> {
        const prompt = [
            `请分析 C/C++ 函数 "${word}" 的调用链。`,
            '请用中文回答，包含：',
            '1. **调用链概述**：这个函数在整体架构中的位置',
            '2. **上游（谁调用了它）**：调用者的角色和调用场景',
            '3. **下游（它调用了谁）**：被调用函数的作用',
            '4. **数据流**：数据如何流入和流出这个函数',
            '5. **潜在的回调/函数指针**：是否通过函数指针间接调用其他函数',
            '',
            '函数源码：',
            '```cpp',
            snippet,
            '```',
            '',
            `上游调用者 (${callers.length} 个)：`,
            ...callers.slice(0, 10).map(c => `- ${c.name} @ ${c.file}:${c.line + 1}`),
            '',
            `下游被调用者 (${callees.length} 个)：`,
            ...callees.slice(0, 10).map(c => `- ${c.name} @ ${c.file}:${c.line + 1}`),
            '',
            'Return JSON: {"analysis": "markdown formatted analysis"}',
        ].join('\n');

        const raw = await this.askQuick(prompt, 30000);
        if (raw === null) return null;
        try {
            const parsed = JSON.parse(raw);
            return typeof parsed.analysis === 'string' ? parsed.analysis : null;
        } catch { return null; }
    }

    /** 通用快速 AI 请求（轻量级，各分析方法共用） */
    private async askQuick(prompt: string, timeoutMs?: number): Promise<string | null> {
        const cfg = await this.getConfig();
        if (!cfg.enabled || !cfg.apiKey) return null;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs ?? Math.min(cfg.timeoutMs, 15000));

        try {
            const response = await fetch(toChatCompletionsUrl(cfg.endpoint), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${cfg.apiKey}`,
                },
                body: JSON.stringify({
                    model: cfg.model,
                    stream: false,
                    temperature: 0,
                    response_format: { type: 'json_object' },
                    messages: [
                        { role: 'system', content: 'You are a precise C/C++ code analysis assistant. Return JSON only.' },
                        { role: 'user', content: prompt },
                    ],
                }),
                signal: controller.signal,
            });

            if (!response.ok) return null;
            const payload = await response.json() as DeepSeekChatCompletionResponse;
            const content = payload.choices?.[0]?.message?.content ?? '';
            const trimmed = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
            // 尝试提取 JSON 对象
            const start = trimmed.indexOf('{');
            const end = trimmed.lastIndexOf('}');
            if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
            return trimmed;
        } catch {
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    private getBaseConfig(): Omit<AiReviewRuntimeConfig, 'apiKey'> {
        const cfg = vscode.workspace.getConfiguration('cppNavigator.ai');
        const provider = normalizeProvider(cfg.get<string>('provider', 'deepseek'));
        return {
            enabled: cfg.get<boolean>('enabled', false),
            provider,
            endpoint: stripTrailingSlash(resolveProviderDefaultedSetting(cfg, 'endpoint', provider)),
            model: resolveProviderDefaultedSetting(cfg, 'model', provider),
            timeoutMs: Math.max(1000, cfg.get<number>('timeoutMs', 45000)),
            contextLines: clamp(cfg.get<number>('contextLines', 8), 3, 30),
            batchSize: clamp(cfg.get<number>('batchSize', 30), 1, 50),
        };
    }

    private async getConfig(): Promise<AiReviewRuntimeConfig> {
        const base = this.getBaseConfig();
        return {
            ...base,
            apiKey: await this.resolveApiKey(base.provider),
        };
    }

    private async resolveApiKey(provider: AiProvider): Promise<string> {
        const stored = await this.secrets?.get(getApiKeySecret(provider));
        if (stored) return stored;

        const cfg = vscode.workspace.getConfiguration('cppNavigator.ai');
        const configured = provider === 'xiaomi'
            ? cfg.get<string>('xiaomiApiKey', '')
            : cfg.get<string>('apiKey', '');
        if (configured) return configured;

        switch (provider) {
            case 'xiaomi':
                return process.env.MIMO_API_KEY || process.env.XIAOMI_API_KEY || '';
            case 'custom':
                return process.env.CPP_NAVIGATOR_AI_API_KEY || process.env.DEEPSEEK_API_KEY || '';
            default:
                return process.env.DEEPSEEK_API_KEY || '';
        }
    }

    private async collectTargetSignatures(symbol: string, index: SymbolIndex, contextLines: number): Promise<string[]> {
        const defs = index.getDefinitions(symbol).slice(0, 5);
        const signatures = await Promise.all(defs.map(async def => {
            const snippet = await readSnippet(def.uri, def.line, Math.min(contextLines, 8));
            return `${vscode.workspace.asRelativePath(vscode.Uri.parse(def.uri))}:${def.line + 1}\n${snippet}`;
        }));
        return signatures.filter(Boolean);
    }

    private async toCandidate(direction: CallDirection, entry: SymbolEntry, contextLines: number): Promise<AiReviewCandidate> {
        return {
            id: makeAiNodeId(direction, entry),
            symbol: entry.name,
            qualifiedName: entry.qualifiedName,
            uri: entry.uri,
            line: entry.line,
            character: entry.character,
            snippet: await readSnippet(entry.uri, entry.line, contextLines),
            ifdefStack: entry.ifdefStack,
        };
    }

    private async askModel(request: AiReviewRequest, cfg: AiReviewRuntimeConfig): Promise<AiReviewResult> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

        try {
            const response = await fetch(toChatCompletionsUrl(cfg.endpoint), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${cfg.apiKey}`,
                },
                body: JSON.stringify({
                    model: cfg.model,
                    stream: false,
                    temperature: 0,
                    thinking: { type: 'disabled' },
                    response_format: { type: 'json_object' },
                    messages: [
                        {
                            role: 'system',
                            content: 'You are a precise C/C++ RTOS call-tree review agent. Return JSON only.',
                        },
                        {
                            role: 'user',
                            content: buildReviewPrompt(request),
                        },
                    ],
                }),
                signal: controller.signal,
            });

            if (!response.ok) {
                throw new Error(`${getProviderLabel(cfg.provider)} returned HTTP ${response.status}`);
            }

            const payload = await response.json() as DeepSeekChatCompletionResponse;
            const content = payload.choices?.[0]?.message?.content ?? '';
            return normalizeResponse(content);
        } finally {
            clearTimeout(timer);
        }
    }
}

export function makeAiNodeId(direction: CallDirection, entry: Pick<SymbolEntry, 'uri' | 'line' | 'name'>): string {
    return `${direction}:${entry.uri}:${entry.line}:${entry.name}`;
}

function buildReviewPrompt(request: AiReviewRequest): string {
    return [
        'You are a precise C/C++ RTOS call-tree review agent.',
        'A lexical engine has recalled candidate call-tree nodes. Review whether each candidate really belongs to the requested call edge.',
        '',
        'Decision criteria:',
        '- Scope and namespace: reject same-name functions from unrelated files, classes, or static-local scopes.',
        '- Argument shape: compare call-site arguments with the target function signature when available.',
        '- Preprocessor context: reject candidates guarded by inactive macros when activeConfigs indicates the branch is inactive.',
        '- Function pointer/callback hints: mention inferred callback targets only when the snippet clearly registers a function pointer.',
        '',
        'Return JSON only with this schema:',
        '{"validNodeIds":["id"],"invalidNodeIds":[{"id":"id","reason":"short reason"}],"inferredNodes":[{"name":"symbol","reason":"short reason"}]}',
        '',
        `targetSymbol: ${request.targetSymbol}`,
        `direction: ${request.direction}`,
        `activeConfigs: ${JSON.stringify(request.activeConfigs)}`,
        `targetSignatures: ${JSON.stringify(request.targetSignatures)}`,
        `candidates: ${JSON.stringify(request.candidates)}`,
    ].join('\n');
}

function normalizeResponse(text: string): AiReviewResult {
    const parsed = parseJsonObject(text);
    const raw = parsed as RawAiResponse;
    const decisions: AiReviewDecision[] = [];

    for (const id of raw.validNodeIds ?? []) {
        if (typeof id === 'string' && id) {
            decisions.push({ id, status: 'valid' });
        }
    }

    for (const item of raw.invalidNodeIds ?? []) {
        if (typeof item === 'string') {
            decisions.push({ id: item, status: 'invalid' });
        } else if (item.id) {
            decisions.push({ id: item.id, status: 'invalid', reason: item.reason });
        }
    }

    const inferredSymbols = (raw.inferredNodes ?? [])
        .filter((node): node is { name: string; reason?: string } => typeof node.name === 'string' && node.name.length > 0)
        .map(node => ({ name: node.name, reason: node.reason }));

    return { decisions, inferredSymbols };
}

function parseJsonObject(text: string): unknown {
    const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    try {
        return JSON.parse(trimmed);
    } catch {
        const start = trimmed.indexOf('{');
        const end = trimmed.lastIndexOf('}');
        if (start >= 0 && end > start) {
            return JSON.parse(trimmed.slice(start, end + 1));
        }
        throw new Error('AI review did not return valid JSON.');
    }
}

async function readSnippet(uriText: string, line: number, radius: number): Promise<string> {
    try {
        const uri = vscode.Uri.parse(uriText);
        const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        const lines = text.split(/\r?\n/);
        const start = Math.max(0, line - radius);
        const end = Math.min(lines.length, line + radius + 1);
        return lines
            .slice(start, end)
            .map((value, idx) => `${start + idx + 1}: ${value}`)
            .join('\n');
    } catch {
        return '';
    }
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function stripTrailingSlash(value: string): string {
    return value.replace(/\/+$/, '');
}

function normalizeProvider(value: string): AiProvider {
    if (value === 'xiaomi' || value === 'custom') return value;
    return 'deepseek';
}

function resolveProviderDefaultedSetting(
    cfg: vscode.WorkspaceConfiguration,
    key: 'endpoint' | 'model',
    provider: AiProvider
): string {
    const configured = getConfiguredValue<string>(cfg, key);
    if (configured) return configured;
    if (provider === 'custom') return cfg.get<string>(key, PROVIDER_DEFAULTS.deepseek[key]);
    return PROVIDER_DEFAULTS[provider][key];
}

function getConfiguredValue<T>(cfg: vscode.WorkspaceConfiguration, key: string): T | undefined {
    const inspected = cfg.inspect<T>(key);
    return inspected?.workspaceFolderValue
        ?? inspected?.workspaceValue
        ?? inspected?.globalValue
        ?? inspected?.defaultLanguageValue
        ?? inspected?.workspaceFolderLanguageValue
        ?? inspected?.workspaceLanguageValue
        ?? inspected?.globalLanguageValue;
}

function getApiKeySecret(provider: AiProvider): string {
    return provider === 'xiaomi' ? XIAOMI_API_KEY_SECRET : DEEPSEEK_API_KEY_SECRET;
}

function getProviderLabel(provider: AiProvider): string {
    if (provider === 'custom') return 'AI provider';
    return PROVIDER_DEFAULTS[provider].label;
}

function getProviderEnvHint(provider: AiProvider): string {
    switch (provider) {
        case 'xiaomi':
            return 'MIMO_API_KEY or XIAOMI_API_KEY';
        case 'custom':
            return 'CPP_NAVIGATOR_AI_API_KEY';
        default:
            return 'DEEPSEEK_API_KEY';
    }
}

function toChatCompletionsUrl(endpoint: string): string {
    return endpoint.endsWith('/chat/completions')
        ? endpoint
        : `${endpoint}/chat/completions`;
}
