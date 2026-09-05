// Small storage boundary shared by the pure analytics core and native SQLite adapter.
// Analytics runs as a single process. The caller owns a transaction around ingest.
export interface DBResult<T = Record<string, unknown>> { results: T[]; success: boolean; meta: { changes?: number } }
export interface Statement {
 bind(...values: unknown[]): Statement;
 all<T = Record<string, unknown>>(): Promise<DBResult<T>>;
 first<T = Record<string, unknown>>(): Promise<T | null>;
 run(): Promise<DBResult>;
}
export interface Database { prepare(sql: string): Statement; batch(statements: Statement[]): Promise<DBResult[]> }
