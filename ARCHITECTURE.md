# C/C++ Navigator 架构设计

## 模块架构图

```mermaid
graph TB
    subgraph "启动阶段" [启动阶段]
        A["extension.ts<br/>activate()"]
        B["projectDetector.ts<br/>检测编译宏和路径"]
        C["buildIndex()"]
    end

    subgraph "扫描阶段" [扫描阶段]
        D["indexBuilder.ts<br/>scanDirectory()"]
        E["scanFile()"]
        F["正则匹配提取符号<br/>+ 作用域推导"]
    end

    subgraph "索引管理" [索引管理]
        G["symbolIndex.ts<br/>SymbolIndex 类"]
        H["defMap/declMap<br/>限定名索引"]
        I["defNameMap/declNameMap<br/>简单名索引"]
    end

    subgraph "查询服务" [查询服务]
        J["providers.ts"]
        K["DefinitionProvider<br/>DeclarationProvider<br/>ReferenceProvider"]
        L["WorkspaceSymbolProvider<br/>DocumentSymbolProvider<br/>HoverProvider"]
    end

    subgraph "增量更新" [增量更新]
        M["onDidSaveTextDocument"]
        N["removeFile() + addEntries()"]
    end

    A -->|并行扫描所有根目录| C
    C -->|自动发现| B
    C -->|并行扫描| D
    D -->|批量处理 20 文件/批| E
    E -->|提取 symbols| F
    F -->|生成 SymbolEntry| G
    G -->|双索引存储| H
    G -->|双索引存储| I
    J -->|查询命中| K
    J -->|工作区搜索| L
    K & L -->|查询用户光标位置单词| G
    M -->|监听文件保存| N
    N -->|更新索引| G
```

## 数据流流程图

```mermaid
sequenceDiagram
    participant VS as VS Code
    participant Ext as Extension
    participant Proj as Project Detector
    participant Builder as Index Builder
    participant Index as Symbol Index
    participant Provider as Providers

    VS->>Ext: activate()
    Ext->>Proj: detectProject()
    Proj-->>Ext: 返回 defines[], includePaths[]
    Ext->>Builder: scanDirectory() x 多个根
    Builder->>Builder: findFiles() glob 查找
    Builder->>Builder: scanFile() 逐文件处理
    Note over Builder: 正则 + 作用域栈<br/>提取限定名
    Builder-->>Index: addEntries()
    Index->>Index: defMap 存限定名<br/>defNameMap 存简单名
    Note over Index: A::foo -> defMap<br/>foo -> defNameMap

    VS->>Provider: 用户点击 symbol
    Provider->>Index: getDefinitions('foo')<br/>or getDefinitions('A::foo')
    Index-->>Provider: SymbolEntry[]
    Provider-->>VS: 返回 Location[]
```

## 模块职责表

| 模块 | 职责 | 核心逻辑 |
|------|------|--------|
| **extension.ts** | 生命周期管理 | 激活 → 后台索引 + 注册 6 个 Provider + 监听文件变更 |
| **projectDetector.ts** | 编译环境检测 | 读取 `compile_commands.json` / `CMakeCache.txt` / `.config` 提取宏 |
| **indexBuilder.ts** | 文件扫描解析 | 正则匹配 + 条件编译分析 + 作用域栈推导 → 生成限定名 |
| **symbolIndex.ts** | 内存索引存储 | 4 个 Map：`defMap`/`declMap`（限定名）+ `defNameMap`/`declNameMap`（简单名）|
| **providers.ts** | 语言服务 | 6 个 VSCode Provider：定义、声明、引用、工作区搜索、大纲、悬停 |
| **types.ts** | 数据结构 | `SymbolEntry` 包含 `name` + `qualifiedName` + 位置 + 宏条件 |

## 核心优化点

1. **后台索引**：激活时立即注册 Provider，索引在后台构建
2. **并行扫描**：多根目录并行扫描，单目录内文件按 20 为单位批量处理
3. **双重索引**：同时支持 `foo` 和 `A::foo` 查询
4. **增量更新**：文件保存时只重新扫描该文件
5. **作用域追踪**：通过大括号嵌套深度推导 `namespace::class::function`
6. **条件编译**：支持 `#ifdef` / `#ifndef` / `#elif` / `#else` 嵌套分析
7. **宏拼接**：正则支持 `##` 操作符识别宏生成的标识符
