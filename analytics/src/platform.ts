// Synchronous storage boundary for the pure analytics core and native SQLite adapter.
// The caller owns BEGIN IMMEDIATE around observation recording. No Promise wrappers.
export interface RunResult { changes: number }
export interface Statement {
 bind(...values: unknown[]): Statement;
 all<T = Record<string, unknown>>(): T[];
 get<T = Record<string, unknown>>(): T | null;
 run(): RunResult;
}
export interface Database {
 prepare(sql: string): Statement;
 exec(sql: string): void;
 transaction<T>(callback: () => T): T;
 close(): void;
}
