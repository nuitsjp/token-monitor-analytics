import { createApp } from './app.ts';
import { readConfig } from './config.ts';
const config = readConfig(process.env);
const app = await createApp(config);
let stopping = false;
async function stop(): Promise<void> {
    if (stopping)
        return;
    stopping = true;
    const timeout = setTimeout(() => { app.log.error('終了待ちが期限を超えました'); process.exit(1); }, 10000);
    timeout.unref();
    try {
        await app.close();
        clearTimeout(timeout);
        process.disconnect?.();
    }
    catch (error) {
        app.log.error({ err: error }, '終了処理に失敗しました');
        process.exitCode = 1;
    }
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
// 親プロセスに管理された起動でもHTTPの管理APIを追加せず終了する。
process.on('message', (message) => {
    if (message === 'shutdown')
        void stop();
});
process.once('disconnect', () => {
    if (!stopping)
        void stop();
});
try {
    const address = await app.listen({ host: config.host, port: config.port });
    app.log.info({ version: '0.1.0' }, 'Token Monitor Analyticsを起動しました');
    process.send?.({ type: 'ready', url: address, pid: process.pid });
}
catch (error) {
    app.log.error({ err: error }, '起動に失敗しました');
    await app.close();
    process.exitCode = 1;
}
