# 开发指南

本文面向继续开发 C/C++ Navigator 的维护者，说明本地环境、常用命令、代码结构和实现约定。

## 环境要求

- Node.js 20 或更高版本
- VS Code 1.85 或更高版本
- npm
- 可选：`cscope`
- 可选：`ctags`
- 可选：C++ 构建工具链，用于构建 `better-sqlite3`

`better-sqlite3` 是可选依赖。没有 C++ 构建工具时，插件会自动降级为 JSON 持久化，不影响基础功能。

## 常用命令

```bash
npm install
npm run compile
npm run watch
npm run package
```

## 调试扩展

1. 在 VS Code 打开本仓库。
2. 执行 `npm install`。
3. 执行 `npm run compile`。
4. 按 `F5` 启动 Extension Development Host。
5. 在新窗口打开 C/C++ 工程。
6. 执行 `C/C++ Navigator: Rebuild Index (incremental)`。

## 目录结构

```text
src/
  extension.ts              插件入口、命令、事件、Provider 注册
  indexBuilder.ts           内置符号扫描器
  symbolIndex.ts            内存索引
  db.ts                     SQLite/JSON 持久化
  providers.ts              VS Code 语言能力 Provider
  cscopeBackend.ts          cscope/ctags 后端
  callHierarchyProvider.ts  调用层级 Provider
  historyManager.ts         浏览历史 Tree View
  projectDetector.ts        工程宏检测
  types.ts                  共享类型
docs/
  DEVELOPMENT.md            开发指南
  ROADMAP.md                功能路线图
```

## 编码约定

- 尽量保持功能分层：扫描、索引、后端、Provider、UI 互相独立。
- Provider 中不要直接修改底层数据库。
- 后端查询失败时应返回空数组，而不是抛出异常打断 VS Code 操作。
- 外部命令调用应设置 `windowsHide: true`。
- 大型扫描必须异步执行，避免阻塞 Extension Host。
- 新增设置项时同步更新 `package.json`、`README.md` 和本文件。

## 索引器开发注意点

内置索引器是文本扫描器，不是 AST parser。新增识别规则时要注意：

- 保留换行，保证 line number 稳定。
- 删除注释时不要改变行数。
- 复杂正则应避免灾难性回溯。
- 新增符号类型前先确认 `SymbolEntry.kind` 是否需要扩展。
- `qualifiedName` 应尽量稳定，避免影响历史记录和搜索结果。

## 后端开发注意点

`cscopeBackend.ts` 是后续接入 readtags/global/gtags 的参考：

- 查询接口统一返回 `SymbolEntry[]`。
- 路径统一转成 `vscode.Uri.file(...).toString()`。
- 外部命令不可用时返回空结果。
- 可配置命令路径，避免写死系统环境。

建议后续新增：

```text
src/readtagsBackend.ts
src/gtagsBackend.ts
src/backend.ts
```

其中 `backend.ts` 可以定义统一接口：

```ts
interface NavigationBackend {
    findDefinitions(symbol: string): Promise<SymbolEntry[]>;
    findReferences(symbol: string): Promise<SymbolEntry[]>;
    findCallers(symbol: string): Promise<SymbolEntry[]>;
    findCallees(symbol: string): Promise<SymbolEntry[]>;
}
```

## 发布前检查

```bash
npm install
npm run compile
npm run package
```

手工检查：

- 打开 C 工程，验证 F12。
- 打开 C++ 工程，验证 namespace/class 下符号跳转。
- 验证 `C/C++ Browse History` 是否记录跳转。
- 验证右键 `Preview Definition`。
- 如果安装了 cscope/ctags，验证 `Build cscope/ctags Database`。

## 已知工程问题

- 当前没有自动化测试框架。
- `ReferenceProvider` 的内置模式为文本扫描，速度和准确度会受项目大小影响。
- README 中承诺的高级 SourceSeek 功能必须在实现后再标为已支持。
