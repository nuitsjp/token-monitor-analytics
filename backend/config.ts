import { resolve } from 'node:path';
export interface HubConfig {
    id: string;
    name: string;
    url: string;
    token: string;
}
export interface AppConfig {
    host: string;
    port: number;
    databasePath: string;
    frontendDist: string;
    publicOrigin?: string;
    allowedOrigins: string[];
    logLevel: string;
    hub?: HubConfig;
}
export function readConfig(env: NodeJS.ProcessEnv): AppConfig {
    const host = env.HOST ?? '127.0.0.1';
    const port = Number(env.PORT ?? '3000');
    if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new Error('PORTは0〜65535で指定してください。');
    if (host !== '127.0.0.1' && host !== '::1')
        throw new Error('バックエンドはloopbackへバインドしてください。');
    const publicOrigin = env.PUBLIC_ORIGIN || undefined;
    if (publicOrigin && new URL(publicOrigin).origin !== publicOrigin)
        throw new Error('PUBLIC_ORIGINにはパスを含めずoriginを指定してください。');
    const databasePath = resolve(env.DB_PATH ?? './data/app.sqlite');
    const frontendDist = resolve(env.FRONTEND_DIST ?? './frontend/dist');
    if (databasePath === frontendDist || databasePath.startsWith(frontendDist + '/') || databasePath.startsWith(frontendDist + '\\'))
        throw new Error('DBはWeb公開領域の外に配置してください。');
    const hubValues = [env.HUB_ID, env.HUB_NAME, env.HUB_URL, env.HUB_TOKEN];
    let hub: HubConfig | undefined;
    if (hubValues.some(value => value !== undefined && value !== '')) {
        if (hubValues.some(value => !value?.trim()))
            throw new Error('HUB_ID・HUB_NAME・HUB_URL・HUB_TOKENをすべて設定してください。');
        let url: URL;
        try { url = new URL(env.HUB_URL!); }
        catch { throw new Error('HUB_URLにはHubのHTTP(S) originを指定してください。'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
            throw new Error('HUB_URLには認証情報やパスを含まないHTTP(S) originを指定してください。');
        if (/[\r\n]/.test(env.HUB_TOKEN!))
            throw new Error('HUB_TOKENに改行を含めることはできません。');
        hub = { id: env.HUB_ID!.trim(), name: env.HUB_NAME!.trim(), url: url.origin, token: env.HUB_TOKEN!.trim() };
    }
    return { host, port, databasePath, frontendDist, publicOrigin, hub,
        allowedOrigins: (env.DEV_ORIGINS ?? '').split(',').filter(Boolean), logLevel: env.LOG_LEVEL ?? 'info' };
}
