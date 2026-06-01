export interface SymbolEntry {
    name: string;
    qualifiedName: string;
    kind: 'definition' | 'declaration';
    uri: string;
    line: number;
    character: number;
    ifdefStack: string[];
}

export type BackendType = 'auto' | 'cscope' | 'builtin';

export interface CscopeResult {
    file: string;
    functionName: string;
    line: number;
    text: string;
}