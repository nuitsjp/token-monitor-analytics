import { npm, run } from './lib.mjs';

await npm('run', 'lint');
await run(process.env.PYTHON ?? 'python', ['scripts/doc_check.py', '.']);
await npm('run', 'test:core');
await npm('run', 'build');
await npm('exec', '--', 'playwright', 'test');
console.log('基盤検証と製品E2E検証が完了しました。');
