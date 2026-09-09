import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {updaterRunnerFiles,runtimeBinDir,legacySystemUnits,userUnit,infrastructureVersion,appUnits,managedUnits,serviceContractVersion,runnerVersion} from '../ubuntu-layout.mjs';
import {assertLegacySystemUnitsAbsent,assertLegacyUserUnitsAbsent,bootstrapTailscale,ensureDirectory,isIntegratedInfrastructureRecord,requiredPackages} from '../provision-ubuntu.mjs';
import {RUNNER_CONTRACT,validateRunnerContract} from '../runner-contract.mjs';

test('updater runner dependency closure is isolated from app config and source checkout', t => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  if (!fs.existsSync(path.join(root, 'tools', 'update-runner-state.mjs'))) {
    t.skip('Requires the Issue #26 runner closure to be integrated.');
    return;
  }
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-isolated-updater-'));
  try {
    for (const relative of updaterRunnerFiles) {
      const source = path.join(root, relative), target = path.join(isolated, relative);
      fs.mkdirSync(path.dirname(target), {recursive: true}); fs.copyFileSync(source, target);
    }
    assert.deepEqual(updaterRunnerFiles, [
      'tools/update-runner.mjs',
      'tools/update-runner-state.mjs',
      'tools/runner-contract.mjs'
    ]);
    const script = `await import('./tools/runner-contract.mjs'); await import('./tools/update-runner-state.mjs'); await import('./tools/update-runner.mjs');`;
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {cwd: isolated, stdio: 'pipe'}));
    assert.ok(!updaterRunnerFiles.some(relative => relative.includes('publish-config') || relative.includes('runtime/config.mjs') || relative.includes('release.mjs')));
  } finally { fs.rmSync(isolated, {recursive: true, force: true}); }
});

test('runner contract rejects incompatible Node/service requirements before deployment', () => {
  assert.doesNotThrow(() => validateRunnerContract(RUNNER_CONTRACT, {nodeVersion: '24.20.0'}));
  assert.doesNotThrow(() => validateRunnerContract({...RUNNER_CONTRACT, minNode: {major: 22, minor: 16, patch: 1}}, {nodeVersion: '22.16.1'}));
  assert.throws(() => validateRunnerContract({...RUNNER_CONTRACT, minNode: {major: 22, minor: 16, patch: 1}}, {nodeVersion: '22.16.0'}), error => error.code === 'provision_required');
  assert.throws(() => validateRunnerContract({...RUNNER_CONTRACT, minNode: {major: 22, minor: 16, patch: 1}}, {nodeVersion: '22.15.99'}), error => error.code === 'provision_required');
  assert.throws(() => validateRunnerContract({...RUNNER_CONTRACT, minNode: {major: 22, minor: -1, patch: 0}}, {nodeVersion: '24.20.0'}), error => error.code === 'migration_required');
  assert.throws(() => validateRunnerContract(RUNNER_CONTRACT, {nodeVersion: '24.20'}), error => error.code === 'provision_required');
  assert.throws(() => validateRunnerContract({...RUNNER_CONTRACT, serviceContractVersion: 1}, {nodeVersion: '24.20.0'}), error => error.code === 'migration_required');
  assert.throws(() => validateRunnerContract(RUNNER_CONTRACT, {nodeVersion: '20.0.0'}), error => error.code === 'provision_required');
});

test('provisioning rejects loaded legacy system units before mutation', () => {
  const seen = [];
  assert.doesNotThrow(() => assertLegacySystemUnitsAbsent(unit => { seen.push(unit); return 'not-found'; }));
  assert.deepEqual(seen, legacySystemUnits);
  const loaded = legacySystemUnits[1];
  assert.throws(() => assertLegacySystemUnitsAbsent(unit => unit === loaded ? 'loaded' : 'not-found'), error => error.code === 'legacy_system_unit' && error.units.some(value => value.startsWith(`${loaded}=`)));
});

test('Tailscale bootstrap installs only when absent and never changes login or Serve state', () => {
  const runCalls = [], serviceCalls = [];
  const runCommand = (command, args, options) => {
    runCalls.push({command, args, options});
    if (command === '/usr/bin/curl') return '#!/bin/sh\necho installer\n';
    if (command === '/bin/sh') return '';
    if (command === '/usr/bin/tailscale') return JSON.stringify({BackendState: 'NeedsLogin'});
    throw new Error(`unexpected command: ${command}`);
  };
  bootstrapTailscale({exists: () => false, runCommand, systemctlCommand: (...args) => serviceCalls.push(args)});
  assert.deepEqual(runCalls.map(({command, args}) => [command, args]), [
    ['/usr/bin/curl', ['--fail', '--silent', '--show-error', 'https://tailscale.com/install.sh']],
    ['/bin/sh', []],
    ['/usr/bin/tailscale', ['status', '--json']]
  ]);
  assert.equal(runCalls[1].options.input, '#!/bin/sh\necho installer\n');
  assert.deepEqual(serviceCalls, [['enable', '--now', 'tailscaled.service']]);
  assert.equal(runCalls.some(({args}) => args.includes('up') || args.includes('serve')), false);

  runCalls.length = 0; serviceCalls.length = 0;
  bootstrapTailscale({exists: () => true, runCommand, systemctlCommand: (...args) => serviceCalls.push(args)});
  assert.deepEqual(runCalls.map(({command, args}) => [command, args]), [['/usr/bin/tailscale', ['status', '--json']]]);
  assert.deepEqual(serviceCalls, [['enable', '--now', 'tailscaled.service']]);
});

test('legacy user unit preflight inspects state and files without mutating them', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-legacy-user-'));
  const unitDirectory = path.join(home, '.config', 'systemd', 'user');
  fs.mkdirSync(unitDirectory, {recursive: true});
  const collector = path.join(unitDirectory, 'tma-collector.service');
  fs.writeFileSync(collector, '[Unit]\nDescription=legacy\n');
  const before = fs.readFileSync(collector);
  const seen = [];
  try {
    assert.throws(() => assertLegacyUserUnitsAbsent({home, loadState: unit => { seen.push(unit); return 'not-found'; }}), error => error.code === 'legacy_user_unit' && error.unit === 'tma-collector.service');
    assert.deepEqual(seen, ['tma-collector.service']);
    assert.deepEqual(fs.readFileSync(collector), before);
  } finally { fs.rmSync(home, {recursive: true, force: true}); }

  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-legacy-state-'));
  const loaded = [];
  try {
    assert.throws(() => assertLegacyUserUnitsAbsent({home: stateHome, loadState: unit => { loaded.push(unit); return unit === 'tma-collector.service' ? 'loaded' : 'not-found'; }}), error => error.code === 'legacy_user_unit' && error.unit === 'tma-collector.service');
    assert.deepEqual(loaded, ['tma-collector.service']);
  } finally { fs.rmSync(stateHome, {recursive: true, force: true}); }
});

test('current Analytics user unit may be retained only with matching infrastructure', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-current-user-'));
  const unitDirectory = path.join(home, '.config', 'systemd', 'user');
  fs.mkdirSync(unitDirectory, {recursive: true});
  fs.writeFileSync(path.join(unitDirectory, 'tma-analytics.service'), '[Service]\n');
  try {
    assert.doesNotThrow(() => assertLegacyUserUnitsAbsent({home, loadState: unit => unit === 'tma-analytics.service' ? 'loaded' : 'not-found', hasCurrentInfrastructure: () => true}));
    assert.throws(() => assertLegacyUserUnitsAbsent({home, loadState: unit => unit === 'tma-analytics.service' ? 'loaded' : 'not-found', hasCurrentInfrastructure: () => false}), error => error.code === 'legacy_user_unit' && error.unit === 'tma-analytics.service');
  } finally { fs.rmSync(home, {recursive: true, force: true}); }
});

test('integrated infrastructure marker allows re-provision with an older service digest', () => {
  const record = {
    version: infrastructureVersion,
    uid: 1000,
    configVersion: 2,
    serviceContractVersion,
    runnerVersion,
    appUnits: [...appUnits],
    managedUnits: [...managedUnits],
    unitDigest: '0'.repeat(64)
  };
  assert.equal(isIntegratedInfrastructureRecord(record, 1000), true);
  assert.equal(isIntegratedInfrastructureRecord(record, 1001), false);
  assert.equal(isIntegratedInfrastructureRecord({...record, configVersion: 1}, 1000), false);
  assert.equal(isIntegratedInfrastructureRecord({...record, appUnits: ['tma-collector.service']}, 1000), false);
  assert.equal(isIntegratedInfrastructureRecord({...record, unitDigest: 'old'}, 1000), false);
});

test('provisioning keeps the nonempty wrong-owner guard and Node-only dependencies', t => {
  assert.deepEqual(requiredPackages, ['ca-certificates', 'curl', 'git', 'tar']);
  assert.doesNotMatch(fs.readFileSync(new URL('../provision-ubuntu.mjs', import.meta.url), 'utf8'), /--locked|build-essential/);
  const unit = userUnit('tma-analytics.service');
  assert.match(unit, /ProtectSystem=strict/);
  assert.match(unit, /ProtectHome=true/);
  assert.match(unit, /ReadWritePaths=.*\/var\/lib\/tma-analytics.*\/var\/lib\/tma-deploy/);
  assert.doesNotMatch(userUnit('tma-update.service'), /--apply|--locked/);
  assert.match(userUnit('tma-update.service'), new RegExp(`Environment=PATH=${runtimeBinDir.replaceAll('/', '\\/')}:%h\\/.local\\/bin:`));
  if (process.getuid?.() !== 0) { t.skip('Wrong-owner filesystem guard requires root-owned fixture mutation.'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-owner-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const nested = path.join(dir, 'managed');
  fs.mkdirSync(nested); fs.writeFileSync(path.join(nested, 'retained'), 'data'); fs.chownSync(nested, 65534, 65534);
  assert.throws(() => ensureDirectory(nested, process.getuid(), process.getgid(), 0o700), /non-empty directory belongs to another owner/);
});

test('provisioning rejects the old externally locked entry point', () => {
  const cli = fileURLToPath(new URL('../provision-ubuntu.mjs', import.meta.url));
  const result = spawnSync(process.execPath, ['--experimental-strip-types', cli, '--locked'], {encoding: 'utf8'});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown option|Unknown argument/);
});

test('packaged service units use the same single user-service contract', () => {
  const analytics = fs.readFileSync(new URL('../../deploy/tma-analytics.service', import.meta.url), 'utf8');
  const update = fs.readFileSync(new URL('../../deploy/tma-update.service', import.meta.url), 'utf8');
  assert.doesNotMatch(analytics, /^User=|^Group=|^WantedBy=multi-user/m);
  assert.match(analytics, /ReadWritePaths=\/var\/lib\/tma-analytics \/var\/lib\/tma-deploy/);
  assert.doesNotMatch(update, /^User=|^Group=|--apply|--locked/m);
  assert.match(update, /Environment=PATH=\/var\/lib\/tma-deploy\/updater\/node-runtime\/bin:%h\/\.local\/bin:/);
  assert.doesNotMatch(update, /^WantedBy=/m);
});
