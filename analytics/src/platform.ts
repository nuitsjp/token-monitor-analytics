// Deliberately small structural interfaces for the platform methods we use.
// Runtime contracts: docs/SOURCES.md. These are NOT replacements for full generated Cloudflare types.
export interface DBResult<T = Record<string, unknown>> { results: T[]; success: boolean; meta: { changes?: number } }
export interface Statement {
 bind(...values: unknown[]): Statement;
 all<T = Record<string, unknown>>(): Promise<DBResult<T>>;
 first<T = Record<string, unknown>>(): Promise<T | null>;
 run(): Promise<DBResult>;
}
export interface Database { prepare(sql: string): Statement; batch(statements: Statement[]): Promise<DBResult[]> }
export interface CFSocket extends WebSocket { serializeAttachment(value: unknown): void; deserializeAttachment(): unknown }
export interface ObjectContext {
 blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
 acceptWebSocket(socket: CFSocket): void;
 getWebSockets(): CFSocket[];
 setWebSocketAutoResponse(pair: unknown): void;
}
export interface Env {
 DB: Database;
 LIVE: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
 ASSETS: { fetch(request: Request): Promise<Response> };
 AUTH_MODE?: string;
 INGEST_TOKEN?: string;
 ACCESS_TEAM_DOMAIN?: string;
 ACCESS_AUD?: string;
}
declare global {
 var WebSocketPair: {new(): {0: CFSocket; 1: CFSocket}};
 var WebSocketRequestResponsePair: {new(request: string, response: string): unknown};
}
