import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {updaterRunnerFiles} from '../ubuntu-layout.mjs';
import {RUNNER_CONTRACT,validateRunnerContract} from '../runner-contract.mjs';

test('updater runner dependency closure is isolated from app config and source checkout', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-isolated-updater-'));
  try {
    for (const relative of updaterRunnerFiles) {
      const source = path.join(root, relative), target = path.join(isolated, relative);
      fs.mkdirSync(path.dirname(target), {recursive: true}); fs.copyFileSync(source, target);
    }
    const script = `await import('./tools/ubuntu-layout.mjs'); await import('./tools/release.mjs'); await import('./tools/runner-contract.mjs'); await import('./tools/update-runner.mjs'); await import('./analytics/runtime/update-state.mjs');`;
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {cwd: isolated, stdio: 'pipe'}));
    assert.ok(!updaterRunnerFiles.some(relative => relative.includes('publish-config') || relative.includes('runtime/config.mjs')));
  } finally { fs.rmSync(isolated, {recursive: true, force: true}); }
});

test('runner contract rejects incompatible Node/service requirements before deployment', () => {
  assert.doesNotThrow(() => validateRunnerContract(RUNNER_CONTRACT, {nodeVersion: '24.20.0'}));
  assert.throws(() => validateRunnerContract({...RUNNER_CONTRACT, serviceContractVersion: 1}, {nodeVersion: '24.20.0'}), error => error.code === 'migration_required');
  assert.throws(() => validateRunnerContract(RUNNER_CONTRACT, {nodeVersion: '20.0.0'}), error => error.code === 'provision_required');
});

