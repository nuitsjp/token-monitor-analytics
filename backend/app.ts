import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions, } from '@trpc/server/adapters/fastify';
import { openDatabase } from './db/database.ts';
import { createAppRouter, type AppRouter } from './http/router.ts';
import type { AppConfig } from './config.ts';
import { readHubDeviceOverview, registerHub } from './db/hub-state.ts';
import { readHubConfigFile } from './hub/config-file.ts';
import { startHubReceiver } from './hub/receiver.ts';
import { createUsageStream } from './http/usage-stream.ts';

// DBはアプリインスタンスが所有し、モジュール単位のsingletonを作らない。
export async function createApp(config: AppConfig) {
    const hubs = readHubConfigFile(config.hubConfigPath);
    const app = Fastify({
        bodyLimit: 1024 * 1024,
        logger: {
            level: config.logLevel,
            serializers: {
                req: (req) => ({ method: req.method, url: String(req.url).split('?')[0] }),
            },
        },
    });
    const db = openDatabase(config.databasePath);
    const usageStream = createUsageStream(() => ({ hubs: readHubDeviceOverview(db, hubs) }), app.log);
    const receivers: ReturnType<typeof startHubReceiver>[] = [];
    // 長時間接続をHTTPサーバーの終了待ちより前に解放する。
    app.addHook('preClose', async () => { usageStream.close(); });
    app.addHook('onClose', async () => {
        await Promise.all(receivers.map(receiver => receiver.stop()));
        db.close();
    });
    try {
        for (const hub of hubs)
            registerHub(db, hub.id, hub.name);
        const router = createAppRouter(db, hubs);
        app.addHook('onListen', async () => {
            receivers.push(...hubs.map(hub => startHubReceiver(hub, db, app.log, usageStream.publish)));
        });
        app.addHook('onRequest', async (req, reply) => {
            // 拒否応答とhijackで配信するSSEにも同じヘッダーを適用する。
            reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'same-origin');
            reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
            if (!req.url.startsWith('/api/'))
                return;
            const host = req.headers.host ?? '';
            const bound = app.server.address();
            const port = bound && typeof bound === 'object' ? bound.port : config.port;
            const localHost = config.host === '::1' ? `[::1]:${port}` : `${config.host}:${port}`;
            const expected = config.publicOrigin ?? `http://${localHost}`;
            if (host !== localHost && host !== `localhost:${port}` && host !== new URL(expected).host) {
                return reply.code(403).send({ message: '接続先が不正です。' });
            }
            const origin = req.headers.origin;
            const allowed = [expected, ...config.allowedOrigins];
            if ((origin && !allowed.includes(origin)) || (req.method === 'POST' && !origin)) {
                return reply.code(403).send({ message: '同一サイトから操作してください。' });
            }
            reply.header('Cache-Control', 'no-store');
        });
        await app.register(fastifyTRPCPlugin, {
            prefix: '/api/trpc',
            trpcOptions: {
                router,
                onError: ({ error, path }) => {
                    if (error.code === 'INTERNAL_SERVER_ERROR') {
                        app.log.error({ err: error.cause, operation: path }, '処理に失敗しました');
                    }
                },
            } satisfies FastifyTRPCPluginOptions<AppRouter>['trpcOptions'],
        });
        app.get('/health', async () => ({ status: 'ok' }));
        app.get('/api/usage/stream', { exposeHeadRoute: false }, (_request, reply) => {
            usageStream.subscribe(reply);
        });
        await app.register(staticFiles, { root: config.frontendDist, wildcard: false });
        app.setNotFoundHandler(async (req, reply) => {
            if (req.method === 'GET' && !req.url.startsWith('/api/') && req.headers.accept?.includes('text/html')) {
                reply.header('Cache-Control', 'no-store');
                return reply.sendFile('index.html');
            }
            return reply.code(404).send({ message: '見つかりません。' });
        });
        await app.ready();
        return app;
    }
    catch (error) {
        await app.close();
        throw error;
    }
}
