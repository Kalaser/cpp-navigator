# C/C++ Navigator

[![Build and Package](https://github.com/Kalaser/cpp-navigator/actions/workflows/build.yml/badge.svg)](https://github.com/Kalaser/cpp-navigator/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

C/C++ Navigator 是一个面向大型 C/C++ 代码库的 VS Code 导航插件。它优先提供轻量、快速、可增量更新的代码跳转能力，并可结合 `cscope` / `ctags` 数据库增强定义、引用和调用层级查询。

> 💡 **设计哲学**：用文本扫描换取速度和低资源占用，不做完整 AST 解析。适合快速浏览代码结构，而非替代完整语言服务器。

![功能演示](images/icon.png)

## ✨ 核心特性

| 特性 | 说明 |
|------|------|
| 🚀 **快速索引** | 增量扫描 C/C++ 文件，启动后快速进入可用状态 |
| 🔍 **多后端支持** | 自动检测 cscope 数据库，或仅用内置索引 |
| 💾 **持久化存储** | 优先 SQLite 数据库，失败时自动降级 JSON 缓存 |
| 📜 **浏览历史** | 自动记录跳转历史，支持 Tree View 回溯 |
| 📊 **调用树可视化** | 侧边栏懒加载树 + ECharts Webview 全局调用关系图 |
| ✨ **AI 调用树清理** | 支持 DeepSeek 与小米 MiMo API，辅助过滤调用树误报并提示回调线索 |
| 🎨 **原生主题适配** | 全自动适配 Dark/Light/High Contrast 主题，零硬编码颜色 |
| ⚡ **LRU 缓存** | 调用分析结果缓存，展开/收起节点无需重复计算 |
| 🛠️ **灵活配置** | 支持额外源码根目录、排除模式、活跃宏定义 |

## 📋 功能清单

### 代码导航能力

| 功能 | 快捷键/入口 | 状态 | 说明 |
|------|-------------|------|------|
| **跳转定义** | `F12` / `Ctrl+Click` | ✅ | 支持函数、宏、结构体、类、变量 |
| **跳转声明** | `Alt+F12` | ✅ | 跳转到头文件中的声明 |
| **查找引用** | `Shift+F12` | ✅ | cscope 后端优先，内置模式扫描文本 |
| **工作区符号** | `Ctrl+T` | ✅ | 全局符号搜索，支持模糊匹配 |
| **文件大纲** | `Ctrl+Shift+O` | ✅ | 当前文件的符号树 |
| **Hover 提示** | 鼠标悬停 | ✅ | 显示定义位置和代码片段 |
| **定义预览** | 右键菜单 | ✅ | 旁侧 Webview 预览定义 |
| **调用层级（原生）** | `Shift+Alt+H` / 右键 | ✅ | VS Code 原生 Peek Call Hierarchy 面板 |
| **调用树可视化** | 右键 → Show Call Tree Graph | ✅ | 侧边栏懒加载树 + ECharts 关系图 |
| **AI 清理调用树** | 调用树视图标题栏魔杖按钮 | ✅ | 使用 DeepSeek 或小米 MiMo 复核候选调用关系 |

### 调用树功能

| 功能 | 说明 |
|------|------|
| **侧边栏懒加载** | Explorer 中的 `C/C++ Call Tree` 视图，展开节点时按需查询，不预加载整棵树 |
| **ECharts 可视化** | 水平展开的关系思维导图，caller（黄）/ callee（青）/ root（蓝）三色区分 |
| **交互操作** | 点击节点跳转源码、滚动缩放、拖拽平移、Expand/Collapse All 按钮 |
| **主题自动适配** | 检测 VS Code 主题类型（Light/Dark/HC），Webview 颜色实时跟随 |
| **LRU 缓存** | 最多 500 条缓存，自动淘汰最旧条目，文件变更时自动清除 |
| **AI 清理** | 将候选调用点及上下文发送到已配置的大模型，标记疑似误报并补充回调提示 |

### AI 辅助调用树清理

AI 清理是可选能力，默认关闭。开启后，插件会把候选调用树节点、目标函数签名和少量源码上下文发送到配置的 OpenAI-compatible Chat Completions 接口，让模型复核调用关系是否真实存在。

当前内置 provider：

| Provider | 默认 endpoint | 默认 model | API key 来源 |
|------|------|------|------|
| `deepseek` | `https://api.deepseek.com` | `deepseek-v4-pro` | SecretStorage / `cppNavigator.ai.apiKey` / `DEEPSEEK_API_KEY` |
| `xiaomi` | `https://api.xiaomimimo.com/v1` | `mimo-v2.5-pro` | SecretStorage / `cppNavigator.ai.xiaomiApiKey` / `MIMO_API_KEY` / `XIAOMI_API_KEY` |
| `custom` | 使用 `endpoint` 配置 | 使用 `model` 配置 | `cppNavigator.ai.apiKey` / `CPP_NAVIGATOR_AI_API_KEY` |

推荐通过命令面板保存密钥：

1. `C/C++ Navigator: Configure DeepSeek API Key`
2. `C/C++ Navigator: Configure Xiaomi MiMo API Key`

这两个命令会把 key 存入 VS Code SecretStorage，并自动启用 `cppNavigator.ai.enabled`。配置小米 key 时还会自动把 `cppNavigator.ai.provider` 切到 `xiaomi`。

### 数据库构建

| 功能 | 状态 | 说明 |
|------|------|------|
| **内置索引构建** | ✅ | 扫描工作区 C/C++ 文件，提取符号 |
| **cscope 数据库** | ✅ | 生成 `cscope.files` 和 `cscope.out` |
| **ctags 数据库** | ✅ | 生成 `tags` 文件，作为 fallback |
| **一键重建全部** | ✅ | 同时构建外部数据库和内置索引 |

## 🚀 快速开始

### 安装

从 [GitHub Releases](https://github.com/Kalaser/cpp-navigator/releases) 下载 `.vsix` 文件：

```bash
# 在 VS Code 中安装
code --install-extension cpp-navigator-1.0.1.vsix
```

或在 VS Code 扩展面板选择「从 VSIX 安装」。

### 编译安装

```bash
git clone https://github.com/Kalaser/cpp-navigator.git
cd cpp-navigator
npm install
npm run compile
npm run package
```

### 调试扩展

1. 打开本仓库
2. 运行 `npm run compile`
3. 按 `F5` 启动 Extension Development Host
4. 在新窗口打开一个 C/C++ 项目
5. 执行 `C/C++ Navigator: Rebuild Index (incremental)`

## 📖 常用命令

| 命令 | 用途 | 入口 |
|------|------|------|
| `Rebuild Index (incremental)` | 增量重建内置索引 | 命令面板 |
| `Build cscope/ctags Database` | 构建外部数据库 | 命令面板 |
| `Rebuild All (cscope + index)` | 构建全部数据库 | 命令面板 |
| `Show Index Stats` | 显示索引统计 | 命令面板 / 状态栏点击 |
| `Search Symbol` | 全局符号搜索并跳转 | 命令面板 |
| `Preview Definition` | 旁侧预览定义 | 右键菜单 `navigation@1` |
| `Search Selected Text` | 全局搜索选中文本 | 右键菜单 `navigation@2` |
| `Show Call Hierarchy` | VS Code 原生调用层级面板 | 右键菜单 `navigation@3` |
| `Show Call Tree Graph` | ECharts 调用树可视化 | 右键菜单 `navigation@4` |
| `Clear Browse History` | 清空浏览历史 | 视图标题栏 |
| `Clear Call Tree` | 清空当前调用树 | 调用树视图标题栏 |
| `AI Clean Call Tree` | 使用 AI 复核并清理调用树误报 | 调用树视图标题栏 |
| `Configure DeepSeek API Key` | 保存 DeepSeek API key 到 SecretStorage | 命令面板 |
| `Configure Xiaomi MiMo API Key` | 保存小米 MiMo API key 到 SecretStorage | 命令面板 |

## ⚙️ 配置项

在 `settings.json` 中配置：

```jsonc
{
  // 后端选择：auto(自动检测) / cscope(强制) / builtin(仅内置)
  "cppNavigator.backend": "auto",
  
  // cscope 可执行文件路径
  "cppNavigator.cscopeCmd": "cscope",
  
  // ctags 可执行文件路径
  "cppNavigator.ctagsCmd": "ctags",
  
  // 活跃宏定义（用于 #ifdef 过滤）
  "cppNavigator.activeConfigs": ["CONFIG_DEBUG", "ENABLE_FEATURE"],
  
  // 额外源码根目录
  "cppNavigator.extraRoots": ["/path/to/sdk", "../vendor"],
  
  // 排除模式
  "cppNavigator.excludePatterns": [
    "**/build/**",
    "**/out/**",
    "**/.git/**",
    "**/node_modules/**",
    "**/CMakeFiles/**",
    "**/vendor/**/test/**"
  ],

  // AI 调用树清理：deepseek / xiaomi / custom
  "cppNavigator.ai.enabled": false,
  "cppNavigator.ai.provider": "deepseek",
  "cppNavigator.ai.endpoint": "https://api.deepseek.com",
  "cppNavigator.ai.model": "deepseek-v4-pro",
  "cppNavigator.ai.timeoutMs": 45000,
  "cppNavigator.ai.contextLines": 8,
  "cppNavigator.ai.batchSize": 30
}
```

### 配置说明

| 配置 | 默认值 | 说明 |
|------|--------|------|
| `cppNavigator.backend` | `auto` | `auto`: 自动检测 cscope；`cscope`: 强制使用；`builtin`: 仅内置索引 |
| `cppNavigator.cscopeCmd` | `cscope` | cscope 可执行文件路径，可填绝对路径 |
| `cppNavigator.ctagsCmd` | `ctags` | ctags 可执行文件路径 |
| `cppNavigator.activeConfigs` | `[]` | 内置索引处理 `#ifdef` 时认为启用的宏 |
| `cppNavigator.extraRoots` | `[]` | 除工作区外额外扫描的源码根目录 |
| `cppNavigator.excludePatterns` | 见上方 | Glob 排除模式，支持 `**` 通配符 |
| `cppNavigator.ai.enabled` | `false` | 是否启用 AI 调用树清理 |
| `cppNavigator.ai.provider` | `deepseek` | AI provider：`deepseek`、`xiaomi` 或 `custom` |
| `cppNavigator.ai.endpoint` | `https://api.deepseek.com` | Chat Completions base URL；provider 为 `xiaomi` 且未手动配置时默认使用 `https://api.xiaomimimo.com/v1` |
| `cppNavigator.ai.apiKey` | `""` | DeepSeek/custom key 的配置回退；更推荐命令面板存入 SecretStorage |
| `cppNavigator.ai.xiaomiApiKey` | `""` | 小米 MiMo key 的配置回退；更推荐命令面板存入 SecretStorage |
| `cppNavigator.ai.model` | `deepseek-v4-pro` | 模型名；provider 为 `xiaomi` 且未手动配置时默认使用 `mimo-v2.5-pro` |
| `cppNavigator.ai.timeoutMs` | `45000` | 单批 AI 请求超时时间 |
| `cppNavigator.ai.contextLines` | `8` | 每个候选调用点截取的上下文行数 |
| `cppNavigator.ai.batchSize` | `30` | 单次发送给 AI 复核的候选节点数量 |

## 🔧 后端模式对比

### 内置索引模式

**优点**：
- ✅ 无需外部依赖，开箱即用
- ✅ 增量更新，文件保存时自动刷新
- ✅ 支持简单 `#ifdef` 过滤
- ✅ 低资源占用，适合大型代码库
- ✅ 支持调用树分析（文本级，有缓存）

**局限**：
- ⚠️ 文本级扫描，非完整 AST 解析
- ⚠️ 复杂模板、宏展开可能不准
- ⚠️ 函数指针调用、重载解析有限

**适合场景**：快速浏览、轻量导航、资源受限环境

### cscope / ctags 后端

**优点**：
- ✅ 语义级查询，准确性高
- ✅ 支持调用层级（Caller/Callee）
- ✅ 成熟的工业级工具链

**要求**：
- 需要手动构建数据库
- 需要安装 `cscope` 和 `ctags`

**构建命令**：
```bash
# 在项目根目录执行
cscope -Rcbqk
ctags -R -f tags .
```

**适合场景**：对准确性要求高、需要调用层级分析

## 📁 项目结构

```
cpp-navigator/
├── src/
│   ├── extension.ts               # 入口：生命周期、Provider 注册、事件绑定
│   ├── types.ts                   # 共享类型（SymbolEntry, CallTreeNode, EChartsTreeNode）
│   ├── indexBuilder.ts            # 索引构建器：文件扫描、符号提取
│   ├── symbolIndex.ts             # 内存索引：四个 Map 存储符号
│   ├── db.ts                      # 持久化（SQLite/JSON 双模式）
│   ├── providers.ts               # VS Code Provider（Definition, Reference, Hover 等）
│   ├── cscopeBackend.ts           # cscope/ctags 后端
│   ├── callHierarchyProvider.ts   # 原生 CallHierarchyProvider（委托给 Service）
│   ├── historyManager.ts          # 浏览历史：Tree View 和持久化
│   ├── projectDetector.ts         # 项目配置检测
│   ├── services/
│   │   ├── callAnalysisService.ts # 调用分析服务：LRU 缓存、主题检测、Webview 构建
│   │   └── aiReviewService.ts     # AI 调用树复核：DeepSeek / 小米 MiMo / custom provider
│   ├── views/
│   │   └── callTreeProvider.ts    # 侧边栏 TreeDataProvider（懒加载 getChildren）
│   └── commands/
│       └── callTreeCommands.ts    # 命令控制器：薄封装，调用 Service → 渲染 View
├── images/
│   └── icon.png
├── docs/
│   ├── ARCHITECTURE.md
│   ├── DEVELOPMENT.md
│   └── ROADMAP.md
└── package.json
```

## 🛠️ 开发脚本

```bash
npm install          # 安装依赖
npm run compile      # 编译 TypeScript
npm run watch        # 监听模式
npm run package      # 打包 VSIX
```

## 📚 文档

- [🏗️ 架构设计](ARCHITECTURE.md) - 分层架构、数据流、LRU 缓存设计
- [🔧 开发指南](docs/DEVELOPMENT.md) - 本地开发、调试、模块说明
- [🗺️ 路线图](docs/ROADMAP.md) - 功能规划、进度追踪

## ⚠️ 已知限制

| 限制 | 影响 | workaround |
|------|------|------------|
| 内置引用搜索是文本扫描 | 可能包含注释、字符串中的同名符号 | 使用 cscope 后端提高准确性 |
| 复杂模板/宏展开 | 定义可能遗漏或错误 | 结合 cscope/ctags 后端 |
| 函数指针调用 | 可能无法精确定位 | 手动查找或使用全局搜索 |
| 非活跃代码分支 | 默认不索引 | 配置 `activeConfigs` 调整 |
| ECharts 需要网络 | Webview 加载 CDN 资源 | 离线环境可缓存 JS 到本地 |
| AI 清理会发送代码上下文 | 调用点附近源码会发送到所选 provider | 仅在可信环境启用，并控制 `contextLines` / `batchSize` |

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

```bash
git clone https://github.com/Kalaser/cpp-navigator.git
cd cpp-navigator
git checkout -b feature/your-feature
npm install && npm run compile
git commit -m "feat: add your feature"
git push origin feature/your-feature
```

## 📄 许可证

[MIT License](LICENSE)
