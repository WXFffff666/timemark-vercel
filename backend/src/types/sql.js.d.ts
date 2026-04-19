declare module 'sql.js' {
  export interface SqlJsStatic {
    Database: typeof Database;
  }

  export interface QueryExecResult {
    columns: string[];
    values: any[][];
  }

  export interface ParamsObject {
    [key: string]: any;
  }

  export interface Statement {
    bind(params?: any[] | ParamsObject): boolean;
    step(): boolean;
    getAsObject(params?: any): any;
    get(params?: any): any[];
    getColumnNames(): string[];
    free(): boolean;
    reset(): void;
    run(params?: any[] | ParamsObject): void;
  }

  export class Database {
    constructor(data?: ArrayLike<number> | Buffer | null);
    run(sql: string, params?: any[] | ParamsObject): Database;
    exec(sql: string): QueryExecResult[];
    prepare(sql: string): Statement;
    getRowsModified(): number;
    export(): Uint8Array;
    close(): void;
  }

  export default function initSqlJs(config?: any): Promise<SqlJsStatic>;
}