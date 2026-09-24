import { existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { npm, root } from './lib.mjs';
await npm('ci');
if (!existsSync(join(root, '.env')))
    copyFileSync(join(root, '.env.example'), join(root, '.env'));
await npm('run', 'routes');
console.log('config/hubs.example.json を data/hubs.local.json へコピーして接続情報を設定後、mise run hub で起動します。ブラウザー導入: npm exec -- playwright install --only-shell chromium');
