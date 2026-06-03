# C/C++ Navigator 路线图

本文记录 C/C++ Navigator 的功能规划和进度。目标不是一次性照搬全部功能，而是按代码浏览的价值分阶段实现。

## 📊 当前版本

**v1.0.1** - 基础导航闭环完成

- ✅ 内置索引构建（文本扫描）
- ✅ 持久化存储（SQLite/JSON 双模式）
- ✅ 多后端支持（auto/cscope/builtin）
- ✅ 浏览历史 Tree View
- ✅ cscope/ctags 数据库构建和查询
- ✅ 调用树侧边栏、ECharts 图谱、手动链接和 AI 清理基础能力
- ✅ AI 调用树复核支持 DeepSeek 与小米 MiMo API key

---

## 阶段 1：基础导航闭环 ✅

**状态：已完成**

| 功能 | 状态 | 说明 |
|------|------|------|
| C/C++ 文件扫描 | ✅ | 支持 `.c`、`.h`、`.cpp`、`.hpp` |
| 内置定义/声明索引 | ✅ | 函数、宏、结构体、类、命名空间 |
| 增量索引 | ✅ | 按文件修改时间判断 |
| F12 跳转定义 | ✅ | DefinitionProvider |
| 跳转声明 | ✅ | DeclarationProvider |
| 查找引用 | ✅ | 文本扫描 / cscope |
| Workspace Symbol | ✅ | `Ctrl+T` |
| Document Symbol | ✅ | `Ctrl+Shift+O` |
| Hover 定义提示 | ✅ | HoverProvider |
| 定义预览窗口 | ✅ | 右键菜单 + Webview |
| 浏览历史 | ✅ | Tree View + 持久化 |
| cscope 构建/查询 | ✅ | `cscope.files` + `cscope.out` |
| ctags 构建/fallback | ✅ | `tags` 文件 |

---

## 阶段 2：大工程后端增强 🔴

**状态：待实现 | 优先级：高**

### 2.1 readtags 后端

- [ ] 新增 `src/readtagsBackend.ts`
- [ ] 支持精确标签查询
- [ ] 支持模糊匹配
- [ ] 支持字段过滤（kind、file、line）

**配置**：
```json
{
  "cppNavigator.readtagsCmd": "readtags"
}
```

### 2.2 GNU Global 后端

- [ ] 新增 `src/gtagsBackend.ts`
- [ ] 支持 `gtags` 数据库构建
- [ ] 支持 `global` 命令查询
- [ ] 支持 `gozilla` 交叉引用

**配置**：
```json
{
  "cppNavigator.gtagsCmd": "gtags",
  "cppNavigator.globalCmd": "global"
}
```

### 2.3 数据库路径配置

- [ ] 支持配置数据库存储路径
- [ ] 支持多工作区数据库
- [ ] 支持共享数据库（只读模式）

**配置**：
```json
{
  "cppNavigator.databasePath": "/path/to/database"
}
```

### 2.4 更多文件类型支持

- [ ] 汇编文件：`.S`、`.s`
- [ ] 头文件包含：`.inc`、`.hxx`、`.ixx`
- [ ] IDL 文件：`.idl`
- [ ] CUDA 文件：`.cu`、`.cuh`

### 2.5 cscope 查询补齐

- [ ] `-0`: 查找符号（已实现）
- [ ] `-1`: 查找定义（已实现）
- [ ] `-2`: 查找引用（已实现）
- [ ] `-3`: 查找调用者 ✅
- [ ] `-4`: 查找字符串 🔲
- [ ] `-6`: 查找 egrep 模式 🔲
- [ ] `-7`: 查找被调用者 ✅
- [ ] `-8`: 查找文件包含 🔲
- [ ] `-9`: 查找包含此文件的文件 🔲

---

## 阶段 3：浏览历史增强 🟡

**状态：基础版完成 | 优先级：中**

### 3.1 持久化增强

- [ ] 历史树持久化到文件（不只 workspace state）
- [ ] 支持导出历史为 JSON
- [ ] 支持从文件加载历史
- [ ] 支持历史备份/恢复

### 3.2 历史过滤

- [ ] 按类型过滤：只显示函数/宏/结构体
- [ ] 按时间范围过滤
- [ ] 按文件过滤
- [ ] 按项目过滤

### 3.3 调用链记录

- [x] 调用链作为多层树记录（侧边栏懒加载）
- [x] 调用链可视化（ECharts 关系图）
- [ ] 调用链导出为文本/Markdown
- [ ] 调用链复制到剪贴板

### 3.4 历史管理

- [ ] 删除单个历史项
- [ ] 删除整棵调用链
- [ ] 批量选择删除
- [ ] 历史记录去重

---

## 阶段 4：预览体验增强 🟡

**状态：基础版完成 | 优先级：中**

### 4.1 Preview View

- [ ] 常驻右侧 Preview View（不关闭）
- [ ] 可配置是否复用同一 Tab
- [ ] 支持在预览中跳转链接
- [ ] 支持语法高亮优化

### 4.2 预览策略

- [ ] 函数：显示完整定义 + 调用示例
- [ ] 宏：显示展开形式
- [ ] 结构体：显示成员列表
- [ ] 类：显示继承关系

### 4.3 交互优化

- [ ] Hover 预览和 Preview View 可配置切换
- [ ] Hover 时可选是否加入历史
- [ ] 预览窗口支持快速关闭（Esc）
- [ ] 预览窗口支持固定/取消固定

---

## 阶段 5：函数指针和手动映射 🔴

**状态：基础版完成 | 优先级：高**

### 5.1 手动标记

- [x] 支持 `Mark Caller`（标记调用者）
- [ ] 支持 `Mark Definition`（标记定义）
- [x] 支持 `Link Caller`（链接调用者到定义）
- [ ] 支持 `Link Definition`（链接定义到调用者）

### 5.2 关系显示

- [ ] 手动关系显示在 Output Channel
- [ ] 手动关系显示在专用 Tree View
- [ ] 手动关系参与 F12 跳转
- [ ] 手动关系参与 Call Hierarchy

### 5.3 持久化

- [ ] 手动关系持久化到工作区
- [ ] 支持导出/导入关系
- [ ] 支持关系合并/冲突解决

**数据结构**：
```ts
interface ManualLink {
    id: string;
    caller: SymbolEntry;
    definition: SymbolEntry;
    createdAt: number;
    note?: string;
}
```

---

## 阶段 6：条件编译和非活跃代码 🟡

**状态：简单条件过滤完成 | 优先级：中**

### 6.1 宏定义加载

- [ ] 支持加载 `autoconf.h`（Linux kernel）
- [ ] 支持加载 `sdkconfig.h`（ESP-IDF）
- [ ] 支持自定义宏定义文件
- [ ] 支持 UI 增删宏定义

### 6.2 表达式解析

- [ ] 支持 `defined(A) && !defined(B)`
- [ ] 支持 `IS_ENABLED(CONFIG_*)`
- [ ] 支持嵌套条件
- [ ] 支持宏展开后判断

### 6.3 灰色显示

- [ ] 使用 Decoration API 灰色显示非活跃代码
- [ ] 提供开关控制是否显示
- [ ] 可配置灰色样式
- [ ] 支持悬停提示「此代码被 #ifdef 禁用」

**配置**：
```json
{
  "cppNavigator.showInactiveCode": false,
  "cppNavigator.inactiveCodeDecoration": {
    "opacity": "0.5",
    "fontStyle": "italic"
  }
}
```

---

## 阶段 7：工具分发和快速设置 🔴

**状态：未实现 | 优先级：高**

### 7.1 内置可执行文件

- [ ] 分发 Windows 版 `cscope.exe`、`ctags.exe`、`readtags.exe`
- [ ] 分发 Linux 版可执行文件
- [ ] 配置是否使用内置工具
- [ ] 自动检测平台下载对应版本

### 7.2 状态栏交互

- [ ] 状态栏显示当前后端（auto/cscope/builtin）
- [ ] 点击弹出 QuickPick 快速切换
- [ ] 状态栏显示索引状态（空闲/扫描中）
- [ ] 状态栏显示符号数量

### 7.3 开关控制

- [ ] 启用/禁用���义搜索
- [ ] 启���/禁用引用搜索
- [ ] 启用/禁用调用层级
- [ ] 启用/禁用 Hover 预览
- [ ] 启用/禁用命令输出

### 7.4 输出面板

- [ ] Output Channel 显示外部命令行
- [ ] 显示命令执行耗时
- [ ] 显示错误输出
- [ ] 支持一键复制命令

---

## 阶段 8：质量和测试 🔴

**状态：未实现 | 优先级：高**

### 8.1 单元测试

- [ ] 搭建测试框架（Mocha/Chai 或 Jest）
- [ ] `indexBuilder.ts` 单元测试
- [ ] `symbolIndex.ts` 单元测试
- [ ] `db.ts` 单元测试
- [ ] `cscopeBackend.ts` Mock 测试

### 8.2 测试覆盖

- [ ] C 语言 fixture 覆盖
- [ ] C++ 语言 fixture（namespace、class、template）
- [ ] 宏定义 fixture
- [ ] 条件编译 fixture
- [ ] 边界情况 fixture

### 8.3 端到端测试

- [ ] 命令注册测试
- [ ] Provider 输出测试
- [ ] 文件事件响应测试
- [ ] 配置变化响应测试

### 8.4 性能基准

- [ ] 扫描文件数基准
- [ ] 符号数基准
- [ ] 耗时基准（冷启动/增量）
- [ ] 内存占用基准
- [ ] CI 中运行性能测试

---

## 阶段 9：AI 辅助（探索性）🟡

**状态：基础版完成 | 优先级：低**

- [x] 使用 LLM 复核调用树候选节点
- [x] 支持 DeepSeek API key
- [x] 支持小米 MiMo API key
- [x] 支持 custom OpenAI-compatible endpoint
- [ ] 使用 LLM 生成符号索引提示
- [ ] 智能推荐相关符号
- [ ] 代码理解摘要生成
- [ ] 调用链自动注释/解释

---

## 功能状态总览

| SourceSeek 能力 | 当前状态 | 阶段 |
|-----------------|----------|------|
| cscope/ctags 导航 | ✅ 完成 | 1 |
| readtags | 🔲 待实现 | 2 |
| global/gtags | 🔲 待实现 | 2 |
| Go to Definition | ✅ 完成 | 1 |
| Go to Reference | ✅ 完成 | 1 |
| Find All References | ✅ 完成 | 1 |
| Call Hierarchy | ✅ 部分完成 | 1 |
| Outline Window | ✅ 完成 | 1 |
| Preview Window | ✅ 完成 | 1 |
| Browser History Window | ✅ 完成 | 1 |
| Call tree sidebar and graph | ✅ 部分完成 | 3 |
| Call hierarchy export | 🔲 待实现 | 3 |
| Manual function pointer map | ✅ 部分完成 | 5 |
| AI call-tree cleanup | ✅ 部分完成 | 9 |
| Non-active code gray display | 🔲 待实现 | 6 |
| Status bar quick settings | 🔲 待实现 | 7 |
| Internal executables | 🔲 待实现 | 7 |
| 单元测试 | 🔲 待实现 | 8 |
| 端到端测试 | 🔲 待实现 | 8 |

---

## 版本规划

| 版本 | 目标 | 预计 |
|------|------|------|
| v1.0.x | 基础导航闭环 | ✅ 已完成 |
| v1.1.0 | readtags + 数据库配置 | 2026 Q2 |
| v1.2.0 | GNU Global 后端 | 2026 Q3 |
| v1.3.0 | 手动映射 + 调用链导出 | 2026 Q3 |
| v2.0.0 | 内置工具分发 + 状态栏 | 2026 Q4 |

---

## 贡献方式

欢迎认领功能！在 GitHub Issue 中评论你想要实现的功能，我会：

1. 确认需求范围
2. 提供技术指引
3. Review 代码
4. 协助测试

**贡献入口**：https://github.com/Kalaser/cpp-navigator/issues

---

## 更新记录

| 日期 | 版本 | 更新内容 |
|------|------|----------|
| 2026-06-03 | v1.0.1 | 补充调用树、手动链接、AI 清理与小米 MiMo API key 支持状态 |
| 2026-06-01 | v1.0.1 | 初始路线图，基于 SourceSeek 能力拆分 |
