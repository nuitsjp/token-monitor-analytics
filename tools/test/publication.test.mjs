import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {configureApplication} from '../configure-application.mjs';
import {readEnvironment,readJSON,selectConfiguration,validateConfiguration,writeChanged,treeDigest,readPublication,configurationId,withPublicationLock,assertOldLayout} from '../publish-config.mjs';
import {validateInfrastructure,unitDigest,appUnits,managedUnits,infrastructureVersion,configVersion,serviceContractVersion,runnerVersion} from '../ubuntu-layout.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tma publication '));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return directory;
}

test('new configuration creates an empty DB/Secret and no legacy Collector inputs', t => {
  const dir = fixture(t);
  const result = configureApplication({dir, identity: {listenHost: '127.0.0.1', viewerMode: 'loopback'}, port: 8788});
  assert.equal(result.ready, true);
  assert.equal(fs.existsSync(path.join(dir, 'analytics.db')), true);
  assert.deepEqual(readJSON(path.join(dir, 'hub-secrets.json')), {schemaVersion: 1, secrets: {}});
  assert.deepEqual({...readEnvironment(path.join(dir, 'analytics.env'))}, {});
  const config = readJSON(path.join(dir, 'analytics.json'));
  assert.equal(config.version, 2);
  assert.deepEqual(config.listen, {host: '127.0.0.1', port: 8788});
  assert.equal(config.tailnetViewer, undefined);
  assert.equal(config.hubs, undefined);
  assert.equal(config.ingestTokenEnv, undefined);
  assert.equal(fs.existsSync(path.join(dir, 'collector.json')), false);
  const before = treeDigest(dir);
  assert.equal(configureApplication({dir, identity: {listenHost: '127.0.0.1', viewerMode: 'loopback'}, port: 8788}).changed, false);
  assert.equal(treeDigest(dir), before);
  const validated = validateConfiguration({}, selectConfiguration({}, dir));
  assert.equal(validated.analytics.viewerAuth.mode, 'loopback');
});

test('configurationId excludes DB/Hub rows/Secret contents but includes startup paths', t => {
  const dir = fixture(t);
  configureApplication({dir, identity: {listenHost: '127.0.0.1', viewerMode: 'loopback'}});
  const config = readJSON(path.join(dir, 'analytics.json'));
  const service = ['[Service]\nExecStart=/opt/token-monitor-analytics/current/node\n'];
  const base = configurationId({config, serviceUnits: service});
  fs.writeFileSync(config.databasePath, 'observation rows changed');
  fs.writeFileSync(config.hubSecretsPath, JSON.stringify({schemaVersion: 1, secrets: {new: 'private'}}), {mode: 0o600});
  assert.equal(configurationId({config, serviceUnits: service}), base);
  // The configuration hash carries paths as startup behavior; the same path
  // is required to compare DB/Secret content changes above.
  assert.notEqual(configurationId({config: {...config, databasePath: path.join(dir, 'other.db')}, serviceUnits: service}), base);
  assert.notEqual(configurationId({config: {...config, hubSecretsPath: path.join(dir, 'other-secret.json')}, serviceUnits: service}), base);
  assert.notEqual(configurationId({config, serviceUnits: [...service, 'new unit']}), base);
});

test('environment parser preserves literals and rejects ambiguous syntax', t => {
  const file = path.join(fixture(t), 'private.env');
  fs.writeFileSync(file, 'TOKEN="$(command); $literal value"\n', {mode: 0o600});
  assert.equal(readEnvironment(file).TOKEN, '$(command); $literal value');
  for (const text of ['TOKEN=a\nTOKEN=b\n', 'export TOKEN=x\n', 'TOKEN=unquoted space\n']) { fs.writeFileSync(file, text); assert.throws(() => readEnvironment(file)); }
  if (process.platform !== 'win32') { fs.chmodSync(file, 0o644); assert.throws(() => readEnvironment(file), /0600/); }
});

test('publication lock uses the shared flock inode and releases after callback', async t => {
  if (process.platform !== 'linux') { t.skip('Requires Ubuntu flock'); return; }
  const dir = fixture(t), lock = path.join(dir, 'deploy.lock');
  await withPublicationLock(lock, async () => {
    const held = spawnSync('/usr/bin/flock', ['-n', lock, '-c', 'true']);
    assert.equal(held.status, 1);
    assert.equal(fs.existsSync(lock), true);
  });
  assert.equal(fs.existsSync(lock), true);
  assert.equal(spawnSync('/usr/bin/flock', ['-n', lock, '-c', 'true']).status, 0);
});

test('old layout guard runs before publication and rejects Collector files', t => {
  const dir = fixture(t);
  assert.doesNotThrow(() => assertOldLayout({destination: dir}));
  fs.writeFileSync(path.join(dir, 'collector.json'), '{}');
  assert.throws(() => assertOldLayout({destination: dir}), error => error.code === 'old_layout');
});

test('publication requires the current one-app infrastructure contract', () => {
  const record = {version: infrastructureVersion, uid: 1000, configVersion, serviceContractVersion, runnerVersion, appUnits: [...appUnits], managedUnits: [...managedUnits], unitDigest: unitDigest()};
  assert.doesNotThrow(() => validateInfrastructure(record, 1000));
  for (const delta of [{version: 2}, {uid: 1001}, {appUnits: ['tma-collector.service']}, {unitDigest: 'old'}]) assert.throws(() => validateInfrastructure({...record, ...delta}, 1000), /provision:ubuntu/);
});

test('readPublication handles legacy and verified records without exposing extra fields', t => {
  const dir = fixture(t), file = path.join(dir, 'publication.json');
  assert.equal(readPublication(path.join(dir, 'missing.json')), null);
  fs.writeFileSync(file, JSON.stringify({releaseId: 'rel-old', configurationId: 'cfg-old', publicOrigin: 'http://127.0.0.1:8788'}));
  assert.equal(readPublication(file).commitSha, null);
  fs.writeFileSync(file, JSON.stringify({schemaVersion: 1, releaseId: 'rel-new', targetCommitSha: 'a'.repeat(40), contentHash: 'b'.repeat(64), archiveSha256: 'c'.repeat(64), configurationId: 'cfg-new'}));
  const result = readPublication(file);
  assert.equal(result.commitSha, 'a'.repeat(40));
  assert.equal(result.contentHash, 'b'.repeat(64));
});

test('writeChanged preserves mtime for identical managed files', t => {
  const dir = fixture(t), file = path.join(dir, 'unit.service');
  assert.equal(writeChanged(file, 'first'), true);
  fs.utimesSync(file, 1, 1);
  const stamp = fs.statSync(file).mtimeMs;
  assert.equal(writeChanged(file, 'first'), false);
  assert.equal(fs.statSync(file).mtimeMs, stamp);
});
