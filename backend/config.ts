import { resolve } from 'node:path';
export interface AppConfig {
    host: string;
    port: number;
    databasePath: string;
    frontendDist: string;
    publicOrigin?: string;
    allowedOrigins: string[];
    logLevel: string;
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
    return { host, port, databasePath, frontendDist, publicOrigin,
        allowedOrigins: (env.DEV_ORIGINS ?? '').split(',').filter(Boolean), logLevel: env.LOG_LEVEL ?? 'info' };
}
