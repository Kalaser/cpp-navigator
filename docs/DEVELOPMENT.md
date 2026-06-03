# 开发指南

本文面向 C/C++ Navigator 的维护者和贡献者，说明本地环境、常用命令、代码结构和实现约定。

## 环境要求

| 依赖 | 版本 | 用途 |
|------|------|------|
| Node.js | 20+ | 运行时环境 |
| VS Code | 1.85+ | 目标平台 |
| npm | - | 包管理 |
| cscope | 可选 | 外部数据库后端 |
| ctags | 可选 | 外部数据库后端 |
| C++ 构建工具 | 可选 | 编译 `better-sqlite3` 原生模块 |

> 💡 **注意**：`better-sqlite3` 是可选依赖。没有 C++ 构建工具时，插件会自动降级为 JSON 持久化，不影响基础功能。

## 快速开始

### 安装依赖

```bash
git clone https://github.com/Kalaser/cpp-navigator.git
cd cpp-navigator
npm install
```

### 编译与打包

```bash
npm run compile      # 编译 TypeScript
npm run watch        # 监听模式，自动重新编译
npm run package      # 打包成 VSIX 文件
```

### 调试扩展

1. 在 VS Code 中打开本仓库
2. 执行 `npm run compile`
3. 按 `F5` 启动 Extension Development Host
4. 在新窗口打开一个 C/C++ 项目
5. 执行 `C/C++ Navigator: Rebuild Index (incremental)`
6. 测试跳转、搜索等功能

### 运行测试（待实现）

```bash
npm run test
```

## 目录结构

```
cpp-navigator/
├── .github/workflows/
│   └── build.yml              # CI/CD：自动打包和发布
├── .vscode/
│   └── launch.json            # 调试配置
├── src/
│   ├── extension.ts           # 插件入口：生命周期、命令注册、事件绑定
│   ├── indexBuilder.ts        # 内置索引构建器：文件扫描、符号提取
│   ├── symbolIndex.ts         # 内存索引：Map 结构存储符号
│   ├── db.ts                  # 持久化层：SQLite/JSON 双模式
│   ├── providers.ts           # VS Code 语言能力 Provider 实现
│   ├── cscopeBackend.ts       # cscope/ctags 后端：数据库构建和查询
│   ├── callHierarchyProvider.ts # 调用层级 Provider
│   ├── callTreeManager.ts     # 调用树状态管理和懒加载
│   ├── manualLinkManager.ts   # 手动调用关系持久化
│   ├── historyManager.ts      # 浏览历史：Tree View 和持久化
│   ├── projectDetector.ts     # 项目配置检测：宏定义、include 路径
│   ├── commands/
│   │   └── callTreeCommands.ts # 调用树命令注册和 UI 编排
│   ├── services/
│   │   ├── aiReviewService.ts # AI 调用树复核 provider 适配
│   │   └── callAnalysisService.ts # 调用分析和 Webview 辅助
│   ├── views/
│   │   └── callTreeProvider.ts # Tree View 节点类型
│   └── types.ts               # 共享类型定义
├── docs/
│   ├── DEVELOPMENT.md         # 本文档
│   ├── ARCHITECTURE.md        # 架构设计
│   └── ROADMAP.md             # 功能路线图
├── images/
│   └── icon.png               # 插件图标
├── .vscodeignore              # VSIX 打包排除规则
├── package.json               # 扩展清单和脚本
├── tsconfig.json              # TypeScript 配置
└── README.md                  # 用户文档
```

## 核心模块说明

### extension.ts

**职责**：
- 插件激活/停用生命周期
- 注册所有命令
- 注册 VS Code Provider（Definition、Reference、Hover 等）
- 初始化调用树、手动链接、AI 复核服务
- 监听文件变化事件
- 初始化后端和索引

**关键函数**：
```ts
export function activate(context: vscode.ExtensionContext): void
export function deactivate(): void
```

### indexBuilder.ts

**职责**：
- 扫描工作区 `.c`、`.h`、`.cpp`、`.hpp` 文件
- 移除注释（保留行号）
- 处理 `#ifdef` / `#ifndef` 条件编译
- 维护作用域栈（namespace、class）
- 正则提取符号（函数、宏、结构体、类等）

**索引流程**：
```
findFiles → readFile → stripComments → 
preprocessorStack → scopeStack → regexExtract → SymbolEntry
```

### symbolIndex.ts

**职责**：
- 内存中维护四个 Map：
  - `defMap`: qualifiedName → 定义列表
  - `defNameMap`: name → 定义列表
  - `declMap`: qualifiedName → 声明列表
  - `declNameMap`: name → 声明列表
- 提供查询接口：`getDefinitions()`, `getDeclarations()`, `search()`

### db.ts

**职责**：
- 持久化索引数据
- **SQLite 模式**：使用 `better-sqlite3`，写入 `symbol-index.db`
- **JSON 模式**：SQLite 不可用时降级，写入 `symbol-index.json`

**关键接口**：
```ts
interface IndexDatabase {
    open(): void;
    updateFile(uri: string, symbols: SymbolEntry[]): void;
    deleteFile(uri: string): void;
    close(): void;
}
```

### providers.ts

**实现 VS Code 能力**：

| Provider | VS Code 功能 | 快捷键 |
|----------|--------------|--------|
| `DefinitionProvider` | 跳转定义 | `F12` |
| `DeclarationProvider` | 跳转声明 | `Alt+F12` |
| `ReferenceProvider` | 查找引用 | `Shift+F12` |
| `WorkspaceSymbolProvider` | 工作区符号搜索 | `Ctrl+T` |
| `DocumentSymbolProvider` | 文件大纲 | `Ctrl+Shift+O` |
| `HoverProvider` | 悬停提示 | 鼠标悬停 |

### cscopeBackend.ts

**职责**：
- 检测 `cscope` / `ctags` 是否可用
- 生成 `cscope.files`
- 构建 `cscope.out` 和 `tags`
- 查询定义、引用、调用者、被调用者

**查询模式**：
```bash
cscope -L -0  # 查找符号
cscope -L -1  # 查找定义
cscope -L -2  # 查找引用
cscope -L -3  # 查找调用者
cscope -L -7  # 查找被调用者
```

### historyManager.ts

**职责**：
- 记录浏览历史（定义跳转、引用搜索、符号搜索）
- 提供 Tree View 展示
- 持久化到 `vscode.workspaceState`

**历史数据结构**：
```ts
interface HistoryItem {
    uri: string;
    line: number;
    symbol: string;
    kind: 'definition' | 'reference' | 'search';
    timestamp: number;
}
```

### callTreeManager.ts

**职责**：
- 管理 `C/C++ Call Tree` 侧边栏状态
- 懒加载 caller/callee 节点
- 合并 cscope、内置索引和手动链接结果
- 执行 AI 复核后标记误报节点和回调提示

### aiReviewService.ts

**职责**：
- 读取 `cppNavigator.ai.*` 配置
- 从 VS Code SecretStorage、settings 或环境变量解析 API key
- 以 OpenAI-compatible Chat Completions 格式请求模型
- 将模型 JSON 输出标准化为 `AiReviewResult`

**内置 provider**：

| Provider | 默认 endpoint | 默认 model | 环境变量回退 |
|----------|---------------|------------|--------------|
| `deepseek` | `https://api.deepseek.com` | `deepseek-v4-pro` | `DEEPSEEK_API_KEY` |
| `xiaomi` | `https://api.xiaomimimo.com/v1` | `mimo-v2.5-pro` | `MIMO_API_KEY` / `XIAOMI_API_KEY` |
| `custom` | 读取 `cppNavigator.ai.endpoint` | 读取 `cppNavigator.ai.model` | `CPP_NAVIGATOR_AI_API_KEY` |

新增 provider 时，优先扩展 `PROVIDER_DEFAULTS`、API key 解析和 README/配置说明。密钥不要写入普通日志，不要在错误消息中回显。

## 编码约定

### 通用规则

- ✅ 保持功能分层：扫描、索引、后端、Provider、UI 互相独立
- ✅ Provider 中不要直接修改底层数据库
- ✅ 后端查询失败时返回空数组，而非抛出异常
- ✅ 外部命令调用设置 `windowsHide: true`
- ✅ 大型扫描必须异步执行，避免阻塞 Extension Host

### 索引器开发

内置索引器是**文本扫描器**，不是 AST 解析器。新增规则时：

- ✅ 保留换行，保证 line number 稳定
- ✅ 删除注释时不要改变行数
- ✅ 复杂正则应避免灾难性回溯
- ✅ 新增符号类型前先确认 `SymbolEntry.kind` 是否需要扩展
- ✅ `qualifiedName` 应稳定，避免影响历史记录

### 后端开发

`cscopeBackend.ts` 是后续接入 readtags/global/gtags 的参考：

- ✅ 查询接口统一返回 `SymbolEntry[]`
- ✅ 路径统一转成 `vscode.Uri.file(...).toString()`
- ✅ 外部命令不可用时返回空结果
- ✅ 可配置命令路径，避免写死系统环境

**建议新增后端**：
```
src/readtagsBackend.ts     # readtags 精确查询
src/gtagsBackend.ts        # GNU Global
src/backend.ts             # 统一接口定义
```

**统一接口示例**：
```ts
interface NavigationBackend {
    findDefinitions(symbol: string): Promise<SymbolEntry[]>;
    findReferences(symbol: string): Promise<SymbolEntry[]>;
    findCallers(symbol: string): Promise<SymbolEntry[]>;
    findCallees(symbol: string): Promise<SymbolEntry[]>;
}
```

## 配置系统

### 新增配置项

1. 在 `package.json` 的 `contributes.configuration` 中添加：
```json
{
  "cppNavigator.newSetting": {
    "type": "string",
    "default": "value",
    "description": "配置说明"
  }
}
```

2. 在 `extension.ts` 中读取：
```ts
const config = vscode.workspace.getConfiguration('cppNavigator');
const value = config.get('newSetting');
```

3. 更新 `README.md` 和本文档

### AI 配置和密钥

AI 配置位于 `cppNavigator.ai` 命名空间：

```jsonc
{
  "cppNavigator.ai.enabled": false,
  "cppNavigator.ai.provider": "deepseek",
  "cppNavigator.ai.endpoint": "https://api.deepseek.com",
  "cppNavigator.ai.model": "deepseek-v4-pro",
  "cppNavigator.ai.timeoutMs": 45000,
  "cppNavigator.ai.contextLines": 8,
  "cppNavigator.ai.batchSize": 30
}
```

密钥存储优先级：

1. VS Code SecretStorage，来自 `Configure DeepSeek API Key` 或 `Configure Xiaomi MiMo API Key` 命令。
2. settings 回退：`cppNavigator.ai.apiKey` 或 `cppNavigator.ai.xiaomiApiKey`。
3. 环境变量回退：`DEEPSEEK_API_KEY`、`MIMO_API_KEY`、`XIAOMI_API_KEY`、`CPP_NAVIGATOR_AI_API_KEY`。

`endpoint` 可以配置为 base URL，也可以直接配置到 `/chat/completions`。AI 功能会发送少量源码上下文，发布说明和 README 需要明确这一点。

### 配置变化监听

```ts
context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('cppNavigator')) {
            // 重新初始化
        }
    })
);
```

## 文件事件处理

| 事件 | 行为 |
|------|------|
| 保存 C/C++ 文件 | 重新扫描该文件，替换 DB 和内存索引中的旧符号 |
| 删除文件 | 从 DB 和内存索引中删除该文件符号 |
| 配置变化 | 触发后台增量索引重建 |

## 调试技巧

### 输出日志

使用 VS Code 输出面板：
```ts
const outputChannel = vscode.window.createOutputChannel('C/C++ Navigator');
outputChannel.appendLine('Debug info...');
outputChannel.show();
```

### 断点调试

1. 在 `src/` 文件中设置断点
2. 按 `F5` 启动调试
3. 在新窗口触发相关操作
4. 查看变量和调用栈

### 性能分析

```ts
const start = Date.now();
// ... 操作
const elapsed = Date.now() - start;
outputChannel.appendLine(`Elapsed: ${elapsed}ms`);
```

## 发布流程

### 本地测试

```bash
npm install
npm run compile
npm run package

# 手工检查
code --install-extension cpp-navigator-*.vsix
```

### 检查清单

- [ ] 打开 C 工程，验证 F12 跳转
- [ ] 打开 C++ 工程，验证 namespace/class 下符号跳转
- [ ] 验证 `C/C++ Browse History` 记录跳转
- [ ] 验证右键 `Preview Definition`
- [ ] 验证 `C/C++ Call Tree` 侧边栏展开、跳转和清空
- [ ] 验证 `Show Call Tree Graph` 能打开关系图
- [ ] 验证 `AI Clean Call Tree` 在未启用时有清晰提示
- [ ] 验证 `Configure DeepSeek API Key` / `Configure Xiaomi MiMo API Key` 命令能保存或清空密钥
- [ ] 如果安装了 cscope/ctags，验证 `Build cscope/ctags Database`
- [ ] 验证 Hover 提示
- [ ] 验证工作区符号搜索

### 自动发布

推送 tag 触发 GitHub Actions：
```bash
git tag -a v1.0.1 -m "Release notes"
git push origin v1.0.1
```

Workflow 会自动：
1. 编译 TypeScript
2. 打包 VSIX
3. 创建 GitHub Release，附带 VSIX 文件

## 常见问题

### better-sqlite3 编译失败

```bash
# 安装 C++ 构建工具
npm install --global windows-build-tools  # Windows
sudo apt install build-essential          # Linux

# 或跳过原生模块（自动降级 JSON）
npm install --ignore-scripts
```

### cscope 命令找不到

```bash
# 安装
sudo apt install cscope           # Debian/Ubuntu
brew install cscope               # macOS
choco install cscope              # Windows

# 配置绝对路径
{
  "cppNavigator.cscopeCmd": "/usr/bin/cscope"
}
```

### 索引不准确

可能原因：
- 复杂宏展开：使用 cscope 后端
- 模板特化：内置索引不支持，使用 cscope
- 非活跃代码分支：配置 `activeConfigs`

### AI 调用树清理不可用

检查顺序：
- `cppNavigator.ai.enabled` 是否为 `true`
- `cppNavigator.ai.provider` 是否匹配已配置的 key
- 是否通过命令面板保存过 key，或设置了对应环境变量
- 公司代理或防火墙是否允许访问所选 provider endpoint
- 自定义 endpoint 是否为 OpenAI-compatible Chat Completions 接口

## 贡献指南

1. Fork 仓库
2. 创建功能分支：`git checkout -b feature/your-feature`
3. 开发并测试
4. 提交：`git commit -m "feat: add your feature"`
5. 推送：`git push origin feature/your-feature`
6. 创建 Pull Request

### 提交信息规范

```
feat: 新功能
fix: 修复 bug
docs: 文档更新
style: 代码格式（不影响功能）
refactor: 重构（既不是新功能也不是修复）
test: 添加测试
chore: 构建/工具配置
```

## 资源

- [VS Code Extension API 文档](https://code.visualstudio.com/api)
- [cscope 手册](https://cscope.sourceforge.net/)
- [Universal Ctags](https://ctags.io/)
- [better-sqlite3 文档](https://github.com/WiseLibs/better-sqlite3)
