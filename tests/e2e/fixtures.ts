import { test as base, expect } from '@playwright/test';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
export interface IsolatedApp {
    url: string;
    databasePath: string;
    pid: number;
    restart: () => Promise<void>;
}
export const test = base.extend<{
    app: IsolatedApp;
}>({
    // Playwrightはfixture依存を引数の分割代入から読む。
    // eslint-disable-next-line no-empty-pattern
    app: async ({}, use, testInfo) => {
        // worker番号だけでなくmkdtempで分けるので、再試行・shard・複数コマンド同時実行でも衝突しない。
        const directory = await mkdtemp(join(tmpdir(), `aidd-e2e-w${testInfo.workerIndex}-`));
        const databasePath = join(directory, 'app.sqlite');
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
                    NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '0', DB_PATH: databasePath, FRONTEND_DIST: resolve('frontend/dist'), PUBLIC_ORIGIN: '', DEV_ORIGINS: '', LOG_LEVEL: 'warn' } });
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
        const instance: IsolatedApp = { get url() { return address; }, databasePath, get pid() { return pid; }, restart: async () => { await stop(); await start(); } };
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
