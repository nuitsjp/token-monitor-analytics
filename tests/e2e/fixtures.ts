import { test as base, expect } from '@playwright/test';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
export interface IsolatedApp {
    url: string;
    databasePath: string;
    pid: number;
    output: string;
    restart: () => Promise<void>;
}
export interface ControlledHub {
    id: string;
    name: string;
    origin: string;
    token: string;
    activeConnections: number;
    send: (event: string, payload: unknown) => void;
    sendRaw: (frame: string) => void;
    endConnections: () => void;
    dropConnections: () => void;
    rejectNewConnections: () => void;
}
export const test = base.extend<{
    hubs: ControlledHub[];
    app: IsolatedApp;
}>({
    // eslint-disable-next-line no-empty-pattern
    hubs: async ({}, use) => {
        const definitions = [
            { id: 'hub-a', name: 'Hub A', token: 'e2e-token-a' },
            { id: 'hub-b', name: 'Hub B', token: 'e2e-token-b' },
        ];
        const servers: Server[] = [];
        const clients: Set<ServerResponse>[] = [];
        const hubs: ControlledHub[] = [];
        try {
            for (const definition of definitions) {
                const connected = new Set<ServerResponse>();
                let rejectNew = false;
                const server = createServer((req, res) => {
                    if (rejectNew || req.url !== '/api/stats/stream'
                        || req.headers.authorization !== `Bearer ${definition.token}`
                        || req.headers['x-token-monitor-stream'] !== '2') {
                        res.writeHead(401).end();
                        return;
                    }
                    res.writeHead(200, { 'content-type': 'text/event-stream' });
                    res.flushHeaders();
                    connected.add(res);
                    res.once('close', () => connected.delete(res));
                });
                await new Promise<void>((ready, reject) => {
                    server.once('error', reject);
                    server.listen(0, '127.0.0.1', () => ready());
                });
                servers.push(server);
                clients.push(connected);
                const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
                hubs.push({
                    ...definition,
                    origin,
                    get activeConnections() { return connected.size; },
                    send: (event, payload) => {
                        const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
                        for (const response of connected)
                            response.write(frame);
                    },
                    sendRaw: (frame) => {
                        for (const response of connected)
                            response.write(frame);
                    },
                    endConnections: () => {
                        for (const response of [...connected])
                            response.end();
                    },
                    dropConnections: () => {
                        for (const response of [...connected])
                            response.destroy();
                    },
                    rejectNewConnections: () => { rejectNew = true; },
                });
            }
            await use(hubs);
        }
        finally {
            for (const connected of clients)
                for (const response of connected)
                    response.destroy();
            await Promise.all(servers.map(server => new Promise<void>(resolveClose => server.close(() => resolveClose()))));
        }
    },
    app: async ({ hubs }, use, testInfo) => {
        // worker番号だけでなくmkdtempで分けるので、再試行・shard・複数コマンド同時実行でも衝突しない。
        const directory = await mkdtemp(join(tmpdir(), `aidd-e2e-w${testInfo.workerIndex}-`));
        const databasePath = join(directory, 'app.sqlite');
        const hubConfigPath = join(directory, 'hubs.local.json');
        await writeFile(hubConfigPath, JSON.stringify({ hubs: hubs.map(hub => ({
            id: hub.id, name: hub.name, url: hub.origin, token: hub.token,
        })) }));
        let child: ChildProcess | undefined;
        let output = '';
        let address = '';
        let pid = 0;
        const append = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-128 * 1024); };
        async function stop() {
            if (!child || child.exitCode !== null || child.signalCode !== null)
                return;
            const running = child;
            await new Promise<void>((resolveStop, reject) => {
                let forced = false;
                const timer = setTimeout(() => {
                    // テスト所有の子プロセスだけを終了。ファイル削除より先にexitを待つ。
                    forced = true;
                    running.kill('SIGKILL');
                }, 12000);
                running.once('exit', () => {
                    clearTimeout(timer);
                    if (forced)
                        reject(new Error('E2Eサーバーの通常終了が期限を超えました'));
                    else
                        resolveStop();
                });
                if (running.connected)
                    running.send('shutdown', error => {
                        if (error && running.exitCode === null && running.signalCode === null) {
                            forced = true;
                            running.kill('SIGKILL');
                        }
                    });
                else
                    running.kill('SIGTERM');
            });
        }
        async function start() {
            const running = fork(resolve('dist/backend/main.js'), [], { cwd: process.cwd(), execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env,
                    NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '0', DB_PATH: databasePath, HUB_CONFIG_PATH: hubConfigPath,
                    FRONTEND_DIST: resolve('frontend/dist'), PUBLIC_ORIGIN: '', DEV_ORIGINS: '', LOG_LEVEL: 'warn' } });
            child = running;
            running.stdout?.on('data', append);
            running.stderr?.on('data', append);
            await new Promise<void>((ready, reject) => {
                const timer = setTimeout(() => reject(new Error('E2Eサーバーの起動が期限を超えました')), 20000);
                const failed = (code: number | null) => { clearTimeout(timer); reject(new Error(`サーバー起動失敗 ${code}: ${output}`)); };
                running.once('error', error => { clearTimeout(timer); reject(error); });
                running.once('exit', failed);
                running.on('message', (message: unknown) => {
                    if (message && typeof message === 'object' && 'type' in message && message.type === 'ready' && 'url' in message && typeof message.url === 'string') {
                        address = message.url;
                        pid = running.pid!;
                        clearTimeout(timer);
                        running.off('exit', failed);
                        ready();
                    }
                });
            });
        }
        const instance: IsolatedApp = {
            get url() { return address; }, databasePath, get pid() { return pid; }, get output() { return output; },
            restart: async () => { await stop(); await start(); },
        };
        try {
            await start();
            testInfo.annotations.push({ type: 'isolated-instance', description: `pid=${pid}; worker=${testInfo.workerIndex}; DB=temporary-file` });
            await use(instance);
        }
        finally {
            try {
                await stop();
            }
            finally {
                if (testInfo.status !== testInfo.expectedStatus)
                    await testInfo.attach('server-output', { body: output, contentType: 'text/plain' });
                await rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
            }
        }
    },
    baseURL: async ({ app }, use) => { await use(app.url); },
});
export { expect };
