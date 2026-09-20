import { npm, run } from './lib.mjs';

await npm('run', 'lint');
await run(process.env.PYTHON ?? 'python', ['scripts/doc_check.py', '.']);
await npm('run', 'test:core');
await npm('run', 'build');
console.log('基盤検証完了。製品の単体・E2Eテストは未作成のため、このコマンドでは実行していません。');
