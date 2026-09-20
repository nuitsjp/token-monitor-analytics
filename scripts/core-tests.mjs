import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { run, root } from './lib.mjs';
const files = readdirSync(join(root, 'tests/core')).filter(f => f.endsWith('.test.ts')).map(f => join(root, 'tests/core', f));
await run(process.execPath, ['--experimental-strip-types', '--test', '--test-concurrency=4', ...files]);
