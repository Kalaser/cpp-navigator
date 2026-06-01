# C/C++ Navigator

C/C++ Navigator 是一个面向大型 C/C++ 代码库的 VS Code 导航插件。它优先提供轻量、快速、可增量更新的代码跳转能力，并可结合 `cscope` / `ctags` 数据库增强定义、引用和调用层级查询。

这个项目正在按 SourceSeek 的体验逐步复刻。当前版本重点完成基础代码浏览闭环：索引、跳转定义、查找引用、文件大纲、Hover 预览、浏览历史和 cscope/ctags 基础后端。

## 当前功能

| 功能 | 状态 | 说明 |
| --- | --- | --- |
| 跳转定义 | 已支持 | VS Code `Go to Definition` / F12 / Ctrl+Click |
| 跳转声明 | 已支持 | VS Code `Go to Declaration` |
| 查找引用 | 已支持 | cscope 后端优先；内置模式会扫描工作区文本引用 |
| 工作区符号搜索 | 已支持 | VS Code `Go to Symbol in Workspace` 和插件命令 |
| 当前文件大纲 | 已支持 | VS Code Outline / `Ctrl+Shift+O` |
| Hover 定义提示 | 已支持 | 显示定义位置和代码片段 |
| 定义预览窗口 | 已支持 | 右键或命令打开旁侧 Webview 预览 |
| 浏览历史 | 已支持 | Explorer 中的 `C/C++ Browse History` 视图 |
| 增量索引 | 已支持 | 按文件修改时间判断是否需要重建 |
| 持久化索引 | 已支持 | 优先 SQLite，失败时自动降级 JSON |
| cscope 数据库构建 | 已支持 | 生成 `cscope.files` 和 `cscope.out` |
| ctags 数据库构建/查询 | 部分支持 | 可生成 `tags`，定义查询可 fallback 到 tags |
| 调用层级 | 部分支持 | cscope 后端可提供 Incoming/Outgoing calls |

## 适用场景

- Linux kernel、Android、RTOS、SDK、嵌入式项目等大型源码树。
- 机器资源有限，不想启动完整 clangd/cpptools 语义索引。
- 需要快速定位函数、宏、结构体、类和命名空间下的符号。
- 编译配置复杂，但主要目标是浏览代码而不是补全、诊断或重构。

不适合替代完整语言服务器的场景：

- 需要准确类型推导、模板实例化、重构、智能补全。
- 需要编译错误诊断、格式化、语义高亮。
- 需要完整 C++ 标准语义解析。

## 快速开始

安装依赖并编译：

```bash
npm install
npm run compile
```

在 VS Code 中调试扩展：

1. 打开本仓库。
2. 运行 `npm run compile`。
3. 按 `F5` 启动 Extension Development Host。
4. 在新窗口打开一个 C/C++ 项目。
5. 执行 `C/C++ Navigator: Rebuild Index (incremental)`。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `C/C++ Navigator: Rebuild Index (incremental)` | 增量重建内置索引 |
| `C/C++ Navigator: Build cscope/ctags Database` | 构建 `cscope.out` 和 `tags` |
| `C/C++ Navigator: Rebuild All (cscope + index)` | 同时构建外部数据库和内置索引 |
| `C/C++ Navigator: Show Index Stats` | 显示当前符号和文件数量 |
| `C/C++ Navigator: Search Symbol` | 插件内全局符号搜索并跳转 |
| `C/C++ Navigator: Preview Definition` | 在旁侧窗口预览当前符号定义 |
| `C/C++ Navigator: Search Selected Text` | 用 VS Code 全局搜索选中文本 |
| `C/C++ Navigator: Clear Browse History` | 清空浏览历史 |

## 配置项

```json
{
  "cppNavigator.backend": "auto",
  "cppNavigator.cscopeCmd": "cscope",
  "cppNavigator.ctagsCmd": "ctags",
  "cppNavigator.activeConfigs": ["CONFIG_DEBUG", "ENABLE_FEATURE"],
  "cppNavigator.extraRoots": ["/path/to/sdk"],
  "cppNavigator.excludePatterns": [
    "**/build/**",
    "**/out/**",
    "**/.git/**",
    "**/node_modules/**",
    "**/CMakeFiles/**"
  ]
}
```

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `cppNavigator.backend` | `auto` | `auto` 自动使用已有 cscope 数据库；`cscope` 强制 cscope；`builtin` 只用内置索引 |
| `cppNavigator.cscopeCmd` | `cscope` | `cscope` 可执行文件路径 |
| `cppNavigator.ctagsCmd` | `ctags` | `ctags` 可执行文件路径 |
| `cppNavigator.activeConfigs` | `[]` | 内置索引处理 `#ifdef` 时认为启用的宏 |
| `cppNavigator.extraRoots` | `[]` | 除工作区外额外扫描的源码根目录 |
| `cppNavigator.excludePatterns` | 见上方 | 排除构建目录、缓存目录等无关文件 |

## 后端选择

### 内置索引

内置索引通过文本扫描和正则提取符号，支持：

- 函数定义和声明
- 宏定义
- typedef
- struct / union / enum
- class / namespace 作用域
- 简单 `#ifdef` / `#ifndef` / `#elif` / `#else` / `#endif` 过滤
- 注释剔除
- 增量更新

优点是无需编译数据库，启动快，部署简单。缺点是它不是完整 C/C++ parser，对复杂模板、宏展开、函数指针调用和重载解析无法做到语言服务器级别准确。

### cscope / ctags

当 `cppNavigator.backend` 为 `auto` 且工作区存在 `cscope.out` 时，会优先使用 cscope 进行定义、引用和调用层级查询，同时保留内置索引作为 fallback。

也可以手动构建数据库：

```bash
cscope -Rcbqk
ctags -R -f tags .
```

或使用命令：

```text
C/C++ Navigator: Build cscope/ctags Database
```

## 浏览历史

插件会记录以下操作：

- 跳转定义
- 查找引用
- 符号搜索

历史显示在 Explorer 的 `C/C++ Browse History` 视图中。点击历史节点可以重新打开对应位置。多定义场景下，额外定义会作为子节点显示。

## 已知限制

- 内置引用搜索是文本级引用扫描，可能包含注释、字符串或同名局部符号。
- 内置索引不是完整 AST 解析器，复杂宏、模板特化、重载和函数指针调用仍可能不准。
- `ctags` 当前只作为定义查询 fallback，尚未完整接入 readtags 查询能力。
- `global` / `gtags` 后端尚未实现。
- 非活跃代码灰色显示、手动函数指针映射、调用链导出等 SourceSeek 高级功能仍在路线图中。

## 文档

- [架构设计](ARCHITECTURE.md)
- [开发指南](docs/DEVELOPMENT.md)
- [复刻路线图](docs/ROADMAP.md)

## 开发脚本

```bash
npm install
npm run compile
npm run watch
npm run package
```

注意：`better-sqlite3` 是可选依赖。如果当前机器缺少匹配的原生预编译包或 C++ 构建工具，安装失败不会阻止插件运行，插件会自动使用 JSON 持久化缓存。
