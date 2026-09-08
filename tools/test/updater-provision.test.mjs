import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {updaterRunnerFiles} from '../ubuntu-layout.mjs';

test('updater runner files are completely self-contained and loadable in an isolated directory without the source repository', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-isolated-updater-'));

  try {
    // 1. Copy exactly updaterRunnerFiles to isolatedDir
    for (const rel of updaterRunnerFiles) {
      const src = path.join(root, rel);
      const dst = path.join(isolatedDir, rel);
      fs.mkdirSync(path.dirname(dst), {recursive: true});
      fs.copyFileSync(src, dst);
    }

    // 2. Execute node inside isolatedDir attempting to load runner modules
    // Running in isolatedDir ensures resolution is restricted to isolatedDir.
    const checkScript = `
      await import('./tools/ubuntu-layout.mjs');
      await import('./tools/publish-config.mjs');
      await import('./tools/ubuntu-common.mjs');
      await import('./analytics/runtime/update-state.mjs');
      try {
        await import('./tools/update-runner.mjs');
      } catch (err) {
        if (err?.code === 'ERR_MODULE_NOT_FOUND' || (err?.message && err.message.includes('Cannot find module'))) {
          throw err;
        }
      }
    `;
    assert.doesNotThrow(() => {
      execFileSync(process.execPath, [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        checkScript
      ], {
        cwd: isolatedDir,
        encoding: 'utf8',
        stdio: 'pipe'
      });
    });

    // 3. Negative test: verify that omitting config.mjs actually fails with MODULE_NOT_FOUND
    const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-broken-updater-'));
    try {
      for (const rel of updaterRunnerFiles) {
        if (rel.includes('config.mjs')) continue; // intentionally omit
        const src = path.join(root, rel);
        const dst = path.join(badDir, rel);
        fs.mkdirSync(path.dirname(dst), {recursive: true});
        fs.copyFileSync(src, dst);
      }

      assert.throws(() => {
        execFileSync(process.execPath, [
          '--experimental-strip-types',
          '--input-type=module',
          '-e',
          checkScript
        ], {
          cwd: badDir,
          encoding: 'utf8',
          stdio: 'pipe'
        });
      }, /MODULE_NOT_FOUND|Cannot find module/);
    } finally {
      fs.rmSync(badDir, {recursive: true, force: true});
    }
  } finally {
    fs.rmSync(isolatedDir, {recursive: true, force: true});
  }
});
