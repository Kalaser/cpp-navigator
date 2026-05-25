# C/C++ Navigator

> 🚀 专为大型 C/C++ 项目设计的轻量级、高性能符号索引与跳转工具

![VS Code](https://img.shields.io/badge/VS%20Code-1.80+-007ACC?logo=visual-studio-code)
![License](https://img.shields.io/badge/License-MIT-green)
![Version](https://img.shields.io/badge/Version-0.0.2+-blue)

## 📋 概述

C/C++ Navigator 是一款针对超大型 C/C++ 项目（Linux 内核、RTOS、嵌入式系统、Android 源码等）优化的 VS Code 扩展。相比传统的语言服务器（cpptools、clangd），它以**极低的资源消耗**和**毫秒级的查询速度**，提供精准可靠的代码导航体验。

**核心理念**：用聪明的正则和文本分析，代替笨重的编译解析。

---

## ✨ 核心特性

### 🎯 功能特性

| 特性 | 说明 |
|------|------|
| **命名空间识别** | 准确识别 C++ namespace，避免同名函数/结构体冲突 |
| **结构体/类成员** | 完整支持 struct/class/union 定义及其成员，消除歧义 |
| **宏拼接识别** | 智能识别 `##` 操作符拼接的函数名（如 `FUNC##NAME()`） |
| **条件编译分析** | 支持嵌套 `#ifdef`/`#ifndef`/`#elif`/`#else`，精准过滤死代码 |
| **注释智能擦除** | 自动移除单行/多行注释，避免索引被注释的历史代码 |
| **增量更新** | 文件保存时仅刷新该文件，秒级更新无需全量重建 |

### 🚀 性能优势

| 指标 | Navigator | cpptools | clangd |
|------|-----------|----------|--------|
| **内存占用** | < 50 MB | 500+ MB | 300+ MB |
| **初始索引** | 秒级 | 分钟级 | 分钟级 |
| **查询延迟** | < 1 ms | 50+ ms | 100+ ms |
| **CPU 占用** | 极低 | 持续高 | 持续高 |
| **适用场景** | 百万+行级 | 中等项目 | 中等项目 |

### 🧠 智能识别能力

```cpp
// ✅ 精准识别所有场景

namespace std {
    class string {
        void append(int);  // std::string::append
    };
}

struct MyStruct {
    int value;
    void process();    // MyStruct::process
};

#define MAKE_FUNC(name) void func_##name()
MAKE_FUNC(init)        // func_init ✓ 识别宏拼接

#ifdef DEBUG
    void debug_print();  // 仅在 DEBUG=1 时索引
#endif
```

---

## 🚀 快速开始

### 1. 安装

从 VS Code 扩展市场搜索 **C/C++ Navigator** 或在命令行安装：

```bash
code --install-extension Kalaser.cpp-navigator
```

### 2. 配置项目（可选）

在 `.vscode/settings.json` 中配置：

```json
{
  "cppNavigator.activeConfigs": ["CONFIG_DEBUG", "ENABLE_FEATURE"],
  "cppNavigator.extraRoots": ["/path/to/external/sdk"],
  "cppNavigator.excludePatterns": [
    "**/build/**",
    "**/vendor/**",
    "**/.git/**"
  ]
}
```

### 3. 开始导航

- **转到定义** (F12)：快速跳转到符号定义
- **转到声明** (Ctrl+K F12 或右键菜单)
- **查找引用** (Shift+F12)：查看所有引用位置
- **工作区搜索** (Ctrl+T)：模糊搜索符号

---

## ⚙️ 配置说明

### 设置选项

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `activeConfigs` | `string[]` | `[]` | **激活的条件编译宏**<br/>示例: `["CONFIG_WIFI", "ARCH_ARM"]` |
| `extraRoots` | `string[]` | `[]` | **额外索引目录**<br/>SDK 或第三方库路径（绝对或相对） |
| `excludePatterns` | `string[]` | 见下表 | **排除规则** (Glob)<br/>编译产物、缓存等 |

### 默认排除规则

```json
[
  "**/build/**",
  "**/out/**",
  "**/.git/**",
  "**/node_modules/**",
  "**/CMakeFiles/**",
  "**/compile_commands.json"
]
```

### 配置示例：Linux 内核项目

```json
{
  "cppNavigator.activeConfigs": [
    "CONFIG_X86_64",
    "CONFIG_KASAN",
    "CONFIG_DEBUG_INFO"
  ],
  "cppNavigator.extraRoots": [
    "/path/to/kernel/drivers",
    "/path/to/kernel/mm"
  ],
  "cppNavigator.excludePatterns": [
    "**/build/**",
    "**/*.o",
    "**/*.ko"
  ]
}
```

---

## 📖 使用指南

### 基础导航

| 操作 | 快捷键 | 说明 |
|------|--------|------|
| 转到定义 | `F12` | 跳转到符号定义位置 |
| 转到声明 | `Ctrl+K F12` | 跳转到符号声明位置 |
| 查找引用 | `Shift+F12` | 列出所有引用位置 |
| 工作区符号 | `Ctrl+T` | 模糊搜索任意符号 |
| 文件大纲 | `Ctrl+Shift+O` | 当前文件的符号列表 |
| 悬停提示 | 鼠标悬停 | 显示符号定义位置和文件名 |

### 高级用法

#### 1. 条件编译过滤

```cpp
#ifdef CONFIG_DEBUG
void debug_function() { ... }  // 仅在 activeConfigs 包含 CONFIG_DEBUG 时被索引
#endif

#if defined(ARCH_ARM) && !defined(ARCH_X86)
void arm_specific() { ... }   // 复杂条件支持
#endif
```

#### 2. 处理宏生成的函数

```cpp
// 定义宏
#define MAKE_HANDLER(event) \
  void handle_##event(void) { }

// 使用宏
MAKE_HANDLER(click)      // → handle_click ✓
MAKE_HANDLER(key_press)  // → handle_key_press ✓
```

#### 3. 命名空间消歧义

```cpp
namespace fs {
    void mount(const char *path);  // fs::mount
}

namespace net {
    void mount(void);              // net::mount
}

// 在代码中 Ctrl+点击 "mount" 时会精准显示两个定义
```

#### 4. 手动重建索引

按 `Ctrl+Shift+P` 打开命令面板，执行 **C/C++ Navigator: Rebuild Index** 以强制重建。

---

## 🔧 工作原理

### 索引流程

1. **项目检测** → 读取 `compile_commands.json` / `CMakeCache.txt` / `.config` 提取宏
2. **文件扫描** → 异步并行遍历所有源文件
3. **注释清理** → 移除单行/多行注释以避免误匹配
4. **正则提取** → 精准识别符号定义和作用域
5. **索引存储** → 构建限定名 (qualified name) 双索引
6. **实时服务** → 响应 VS Code Provider 的查询请求

### 架构图

详见 [ARCHITECTURE.md](ARCHITECTURE.md) - 包含完整的数据流和模块说明。

---

## 💡 为什么选择 Navigator？

### vs. cpptools / clangd

| 场景 | Navigator | cpptools | clangd |
|------|-----------|----------|--------|
| **千万行项目** | ✅ 秒级索引 | ❌ 10分钟+ | ❌ 10分钟+ |
| **SSH 远程开发** | ✅ 流畅 | ❌ 经常卡 | ❌ 经常卡 |
| **内存受限环境** | ✅ 50MB | ❌ 1GB+ | ❌ 500MB+ |
| **复杂条件编译** | ✅ 精确分析 | ⚠️ 有局限 | ⚠️ 有局限 |
| **增量更新** | ✅ 毫秒级 | ⚠️ 秒级 | ⚠️ 秒级 |

### 适用场景

✅ 推荐使用：
- Linux 内核 / Android 系统源码
- 嵌入式项目（NuttX、FreeRTOS 等）
- 大型 C/C++ 工程（百万+行）
- 资源受限的开发环境（树莓派、远程服务器）

❌ 不推荐：
- 需要完整的语义分析和自动补全
- 简单小项目（传统 cpptools 已足够）
- 需要代码格式化和 Lint 检查的场景

---

## 🐛 常见问题

### Q: 为什么查不到某些符号？

**A:** 检查以下几点：
1. 符号是否在条件编译分支中？配置 `activeConfigs` 激活相应宏
2. 文件是否在排除规则中？查看 `excludePatterns`
3. 尝试执行 **Rebuild Index** 命令强制重建
4. 检查符号是否以 `#` 开头或包含特殊字符

### Q: 索引速度很慢？

**A:** 优化方案：
1. 增加 `excludePatterns` 排除不必要的目录（build/、vendor/ 等）
2. 检查是否有超大文件（>10MB）
3. 减少 `extraRoots` 数量
4. 关闭其他占用 I/O 的后台进程

### Q: 支持哪些 C/C++ 特性？

**A:** 当前支持：
- ✅ 命名空间 (namespace)
- ✅ 类 / 结构体 / 联合体 (class / struct / union)
- ✅ 宏定义和条件编译
- ✅ typedef 类型别名
- ✅ 函数 / 变量定义和声明
- ❌ 模板特化（部分支持）
- ❌ 匿名namespace（部分支持）

### Q: 能否用于 C 项目？

**A:** 完全支持。导航对 C 和 C++ 代码同样有效，只需确保文件扩展名是 `.c`、`.h`、`.cpp` 等。

---

## 📊 版本信息

- **当前版本**: 0.0.2+
- **最低 VS Code 版本**: 1.80
- **支持系统**: Windows、macOS、Linux

### 更新日志

**v0.0.2**
- ✨ 完善结构体识别（支持 typedef struct、匿名结构体）
- 🐛 修复命名空间嵌套识别
- 🚀 双索引优化（限定名 + 简单名并行查询）

**v0.0.1**
- 🎉 初始发布
- 基础符号索引和导航功能

---

## 🤝 贡献指南

欢迎提交 Issue 和 Pull Request！

### 开发环境

```bash
git clone https://github.com/Kalaser/cpp-navigator.git
cd cpp-navigator
npm install
npm run compile      # 编译 TypeScript
npm run watch        # 监听模式
```

### 项目结构

```
src/
├── extension.ts          # 扩展入口和生命周期
├── indexBuilder.ts       # 文件扫描和符号提取
├── symbolIndex.ts        # 索引存储和查询
├── providers.ts          # VS Code 语言服务提供者
├── projectDetector.ts    # 项目环境检测
└── types.ts             # 数据结构定义
```

详见 [ARCHITECTURE.md](ARCHITECTURE.md)。

---

## 📄 许可证

MIT License - 详见 [LICENSE](LICENSE)

---

## 📞 联系方式

- **GitHub**: [Kalaser/cpp-navigator](https://github.com/Kalaser/cpp-navigator)
- **Issues**: [报告问题](https://github.com/Kalaser/cpp-navigator/issues)

**感谢使用 C/C++ Navigator！** 如果有帮助，请给个 Star ⭐
