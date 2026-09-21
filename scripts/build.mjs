import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { npm, root } from './lib.mjs';

await npm('run', 'typecheck');
await npm('exec', '--', 'vite', 'build', '--config', 'frontend/vite.config.ts');
rmSync(join(root, 'dist'), { recursive: true, force: true });
await npm('exec', '--', 'tsc', '-p', 'tsconfig.backend.json');
console.log('ビルド完了。npm start で同梱UIとAPIを同じoriginで起動します。');
