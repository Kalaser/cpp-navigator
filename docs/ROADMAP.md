# SourceSeek 复刻路线图

本文记录 C/C++ Navigator 对 SourceSeek 类能力的复刻进度。目标不是一次性照搬全部功能，而是按代码浏览的价值分阶段实现。

## 阶段 1：基础导航闭环

状态：大部分已完成。

| 功能 | 状态 |
| --- | --- |
| C/C++ 文件扫描 | 已完成 |
| 内置定义/声明索引 | 已完成 |
| 增量索引 | 已完成 |
| F12 跳转定义 | 已完成 |
| 跳转声明 | 已完成 |
| 查找引用 | 已完成基础版 |
| Workspace Symbol | 已完成 |
| Document Symbol / Outline | 已完成基础版 |
| Hover 定义提示 | 已完成 |
| Hover 代码片段预览 | 已完成基础版 |
| 定义预览窗口 | 已完成基础版 |
| 浏览历史 | 已完成基础版 |
| cscope 构建和查询 | 已完成基础版 |
| ctags 构建和定义 fallback | 已完成基础版 |

## 阶段 2：大工程后端增强

状态：待实现。

优先级高：

- 接入 `readtags`，提升 tags 查询准确度和速度。
- 接入 GNU Global / `gtags` / `global`。
- 支持配置数据库目录，而不只是假定工作区根目录。
- 支持 `.S`、`.s`、`.inc` 等更多源码扩展名。
- cscope 查询补齐 file include、assignment、called-by、calling 等模式。

建议新增配置：

```json
{
  "cppNavigator.databasePath": "",
  "cppNavigator.readtagsCmd": "readtags",
  "cppNavigator.gtagsCmd": "gtags",
  "cppNavigator.globalCmd": "global"
}
```

## 阶段 3：浏览历史增强

状态：基础版已完成，高级能力待实现。

待实现：

- 历史树按工作区文件持久化，而不只存在 VS Code workspace state。
- 历史记录支持保存到文件、从文件加载。
- 历史过滤：只显示函数、只显示引用、只显示调用链。
- 多定义显示为更清晰的子节点。
- 调用链作为多层树记录。
- 调用链复制到剪贴板。
- 删除单个历史项、删除整棵调用链。

## 阶段 4：预览体验增强

状态：基础版已完成。

待实现：

- 常驻右侧 Preview View。
- Hover 预览和右侧预览之间可配置切换。
- 是否用同一预览 Tab 打开。
- Hover 时是否自动加入历史。
- Preview 中支持跳转链接。
- 对 struct、macro、function 使用不同预览策略。

## 阶段 5：函数指针和手动映射

状态：未实现。

目标：

- 支持 `Mark Caller`。
- 支持 `Mark Definition`。
- 支持 `Link Caller`。
- 支持 `Link Definition`。
- 手动关系显示在 Output Channel。
- 手动关系参与 F12 和 Call Hierarchy。
- 手动关系持久化到工作区。

建议数据结构：

```ts
interface ManualLink {
    id: string;
    caller: SymbolEntry;
    definition: SymbolEntry;
    createdAt: number;
    note?: string;
}
```

## 阶段 6：条件编译和非活跃代码显示

状态：内置索引已有简单条件过滤，编辑器灰色显示未实现。

待实现：

- 支持加载宏定义文件，例如 Linux kernel `include/generated/autoconf.h`。
- 支持自定义宏增删 UI。
- 支持 `IS_ENABLED(CONFIG_*)`。
- 支持 `defined(A) && !defined(B)` 更完整表达式。
- 使用 Decoration API 将非活跃代码显示为灰色。
- 提供开关控制是否显示灰色非活跃代码。

## 阶段 7：内置工具分发和快速设置

状态：未实现。

待实现：

- 随插件分发 Windows/Linux 版本 `cscope`、`ctags`、`readtags`。
- 配置是否使用内置可执行文件。
- 状态栏点击弹出 QuickPick 快速设置。
- 开关：启用/禁用定义搜索、引用搜索、调用层级、Hover 预览、命令输出。
- Output Channel 显示外部命令行和耗时。

## 阶段 8：质量和测试

状态：待实现。

建议：

- 增加单元测试覆盖 `indexBuilder.ts`。
- 用 fixture 覆盖 C、C++、宏、namespace、struct、typedef。
- 增加后端命令 mock 测试。
- 增加基础端到端测试，验证命令注册和 Provider 输出。
- 建立性能基准：扫描文件数、符号数、耗时、内存。

## 功能状态总览

| SourceSeek 能力 | 当前状态 |
| --- | --- |
| cscope/ctags 导航 | 部分完成 |
| readtags | 未实现 |
| global/gtags | 未实现 |
| Go to Definition | 已完成 |
| Go to Reference | 基础完成 |
| Find All References | 基础完成 |
| Call Hierarchy | cscope 模式部分完成 |
| Outline Window | VS Code Document Symbol 基础完成 |
| Preview Window | 基础完成 |
| Browser History Window | 基础完成 |
| Call hierarchy export | 未实现 |
| Manual function pointer map | 未实现 |
| Non-active code gray display | 未实现 |
| Status bar quick settings | 未实现 |
| Internal executables | 未实现 |
