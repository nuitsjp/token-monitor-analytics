import { existsSync, copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { npm, root } from './lib.mjs';
const expectedNode = readFileSync(join(root, '.nvmrc'), 'utf8').trim();
if (process.versions.node !== expectedNode)
    throw new Error(`Node.js ${expectedNode}が必要です（実行中: ${process.versions.node}）。`);
await npm('ci');
if (!existsSync(join(root, '.env')))
    copyFileSync(join(root, '.env.example'), join(root, '.env'));
await npm('run', 'routes');
console.log('config/hubs.example.json を data/hubs.local.json へコピーして接続情報を設定後、npm run dev で起動します。ブラウザー導入: npm exec -- playwright install --only-shell chromium');
