import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { root } from './lib.mjs';
// ポート3000/5173は開発だけ。E2Eはこのスクリプトを使用せずport=0で本番entryを起動する。
mkdirSync(join(root, 'frontend/dist'), { recursive: true });
const children = [];
let stopping = false;
function stop(code = 0) {
    if (stopping)
        return;
    stopping = true;
    for (const child of children)
        child.kill('SIGTERM');
    process.exitCode = code;
}
function start(script, args, env) {
    const child = spawn(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
    children.push(child);
    child.once('error', e => { console.error(e); stop(1); });
    child.once('exit', code => {
        if (!stopping)
            stop(code ?? 1);
    });
    return child;
}
start(join(root, 'node_modules/tsx/dist/cli.mjs'), ['watch', 'backend/main.ts'], { HOST: '127.0.0.1', PORT: '3000', DEV_ORIGINS: 'http://127.0.0.1:5173' });
start(join(root, 'node_modules/vite/bin/vite.js'), ['--config', 'frontend/vite.config.ts'], {});
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
