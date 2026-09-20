import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './lib.mjs';
const target = join(root, 'release/app');
if (existsSync(target))
    throw new Error('release/app が既にあります。内容を確認し別名へ移動してから実行してください。');
mkdirSync(target, { recursive: true });
cpSync(join(root, 'dist'), join(target, 'dist'), { recursive: true });
mkdirSync(join(target, 'frontend'), { recursive: true });
cpSync(join(root, 'frontend/dist'), join(target, 'frontend/dist'), { recursive: true });
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
pkg.scripts = { start: 'node --env-file-if-exists=.env dist/backend/main.js' };
writeFileSync(join(target, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
if (existsSync(join(root, 'package-lock.json')))
    cpSync(join(root, 'package-lock.json'), join(target, 'package-lock.json'));
cpSync(join(root, '.env.example'), join(target, '.env.example'));
console.log('release/app を配備し、npm ci --omit=dev（lockがなければnpm install --omit=dev）、.env設定、npm start を実行してください。dataは配備領域の外へ置いてください。');
