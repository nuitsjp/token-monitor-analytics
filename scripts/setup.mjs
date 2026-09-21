import { existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { npm, root } from './lib.mjs';
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 16))
    throw new Error('Node.js 22.16以上（推奨24.21.0）が必要です。');
await npm(existsSync(join(root, 'package-lock.json')) ? 'ci' : 'install');
if (!existsSync(join(root, '.env')))
    copyFileSync(join(root, '.env.example'), join(root, '.env'));
await npm('run', 'routes');
console.log('config/hubs.example.json を data/hubs.local.json へコピーして接続情報を設定後、mise run hub で起動します。');
