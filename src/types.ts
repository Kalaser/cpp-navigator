export interface SymbolEntry {
    name: string;
    qualifiedName: string;
    kind: 'definition' | 'declaration';
    uri: string;           // vscode.Uri.toString()
    line: number;          // 0-based
    character: number;     // 列偏移
    ifdefStack: string[];  // 此符号所在的 #ifdef 条件栈，空数组 = 无条件
}