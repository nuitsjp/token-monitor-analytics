import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {configureApplication} from '../configure-application.mjs';
import {readEnvironment,readJSON,selectConfiguration,validateConfiguration,writeChanged,treeDigest,readPublication,configurationId,withPublicationLock,assertOldLayout} from '../publish-config.mjs';
import {createReleaseArtifact} from '../release.mjs';
import {preparePublication,applyPublication,defaultHealthCheck,validateFixedNode} from '../publish-ubuntu.mjs';
import {validateInfrastructure,unitDigest,appUnits,managedUnits,infrastructureVersion,configVersion,serviceContractVersion,runnerVersion} from '../ubuntu-layout.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tma publication '));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return directory;
}

function fixtureReleaseVerification(contentHash) {
  return {assertSource() {}, contentHash: () => contentHash, run: () => [['fixture']]};
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
  const basicConfig = {...config, viewerAuth: {mode: 'basic', userEnv: 'VIEWER_USER', passwordEnv: 'VIEWER_PASSWORD'}};
  const basicEnvironment = {VIEWER_USER: 'viewer', VIEWER_PASSWORD: 'first-password-value'};
  const basicId = configurationId({config: basicConfig, environment: basicEnvironment, serviceUnits: service});
  assert.notEqual(configurationId({config: basicConfig, environment: {...basicEnvironment, VIEWER_PASSWORD: 'second-password-value'}, serviceUnits: service}), basicId);
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

test('owner termination releases the shared flock without replacing its inode', async t => {
  if (process.platform !== 'linux') { t.skip('Requires Ubuntu flock'); return; }
  const dir = fixture(t), lock = path.join(dir, 'deploy.lock');
  const script = `import {withPublicationLock} from ${JSON.stringify(path.resolve('tools/release.mjs'))}; await withPublicationLock(${JSON.stringify(lock)}, async () => { const keepAlive = setInterval(() => {}, 1000); console.log('held'); await new Promise(() => {}); clearInterval(keepAlive); });`;
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {stdio: ['ignore', 'pipe', 'pipe']});
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
  assert.equal(spawnSync('/usr/bin/flock', ['-n', lock, '-c', 'true']).status, 1);
  child.kill('SIGKILL');
  await new Promise(resolve => child.once('exit', resolve));
  assert.equal(spawnSync('/usr/bin/flock', ['-n', lock, '-c', 'true']).status, 0);
  assert.equal(fs.existsSync(lock), true);
});

test('Windows publication lock rejects a concurrent holder and releases after completion', async t => {
  if (process.platform !== 'win32') { t.skip('Requires the Windows lock fallback'); return; }
  const dir = fixture(t), lock = path.join(dir, 'deploy.lock');
  const script = `import {withPublicationLock} from ${JSON.stringify(pathToFileURL(path.resolve('tools/release.mjs')).href)}; await withPublicationLock(${JSON.stringify(lock)}, async () => { const released = new Promise(resolve => process.stdin.once('data', resolve)); process.stdout.write('held\\n'); await released; process.stdin.pause(); });`;
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {stdio: ['pipe', 'pipe', 'pipe']});
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
  await assert.rejects(() => withPublicationLock(lock, async () => {}), error => error.code === 'lock_conflict');
  child.stdin.end('release');
  await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  await withPublicationLock(lock, async () => {});
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

test('fixed Node preflight validates the executable version', t => {
  const dir = fixture(t), fixedNode = path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
  fs.copyFileSync(process.execPath, fixedNode);
  fs.chmodSync(fixedNode, 0o755);
  assert.match(validateFixedNode(fixedNode, {minimum: {major: 0, minor: 0, patch: 0}}), /^v\d+\.\d+\.\d+$/);
  const currentMajor = Number(process.versions.node.split('.')[0]);
  assert.throws(() => validateFixedNode(fixedNode, {minimum: {major: currentMajor + 1, minor: 0, patch: 0}}), /older than required/);
});

test('verified publication is idempotent and rechecks config before stop', async t => {
  const dir = fixture(t);
  configureApplication({dir, identity: {listenHost: '127.0.0.1', viewerMode: 'loopback'}, port: 8788});
  const sha = 'd'.repeat(40);
  const artifact = createReleaseArtifact({root: fileURLToPath(new URL('../../', import.meta.url)), architecture: 'amd64', outputDir: dir, targetCommitSha: sha, certified: true, verification: {level: 'release', checks: ['fixture']}});
  const current = path.join(dir, 'current'), publication = path.join(dir, 'publication.json');
  let stopped = 0, started = 0;
  const services = {isActive: () => false, stop: async () => { stopped++; }, start: async () => { started++; }, daemonReload() {}, installUnit() {}};
  const stages = [];
  const options = {services, backup: async () => {}, healthCheck: async () => {}, jobId: 'job-publication', targetCommitSha: sha, onStage: stage => stages.push(stage)};
  const releaseVerification = fixtureReleaseVerification(artifact.contentHash);
  const prepared = await preparePublication({artifactPath: artifact.archivePath, checksumPath: artifact.checksumPath, targetCommitSha: sha, configDir: dir, current, publicationPath: publication, uid: undefined, services, releaseVerification});
  const first = await applyPublication(prepared, options);
  assert.equal(first.changed, true); assert.equal(stopped, 1); assert.equal(started, 1);
  assert.deepEqual(stages, ['restarting']);
  assert.deepEqual(first.proof, {jobId: 'job-publication', commitSha: sha, releaseId: first.publication.releaseId, contentHash: first.publication.contentHash, archiveSha256: first.publication.archiveSha256, configurationId: first.publication.configurationId, health: true, state: true, viewer: true, sse: true});
  services.isActive = () => true; services.isEnabled = () => true;
  const secondPrepared = await preparePublication({artifactPath: artifact.archivePath, checksumPath: artifact.checksumPath, targetCommitSha: sha, configDir: dir, current, publicationPath: publication, uid: undefined, services, releaseVerification});
  const second = await applyPublication(secondPrepared, options);
  assert.equal(second.changed, false); assert.equal(stopped, 1); assert.equal(started, 1);
  const noOpPrepared = await preparePublication({artifactPath: artifact.archivePath, checksumPath: artifact.checksumPath, targetCommitSha: sha, configDir: dir, current, publicationPath: publication, uid: undefined, services, releaseVerification});
  const unchangedConfig = readJSON(path.join(dir, 'analytics.json')); unchangedConfig.timeZone = 'UTC'; fs.writeFileSync(path.join(dir, 'analytics.json'), JSON.stringify(unchangedConfig, null, 2) + '\n');
  await assert.rejects(() => applyPublication(noOpPrepared, options), /changed during publication/);
  assert.equal(stopped, 1); assert.equal(started, 1);
});

test('custom publication destinations cannot bypass pinned source verification', async t => {
  const dir = fixture(t);
  configureApplication({dir, identity: {listenHost: '127.0.0.1', viewerMode: 'loopback'}, port: 8788});
  const sha = 'f'.repeat(40);
  const artifact = createReleaseArtifact({root: fileURLToPath(new URL('../../', import.meta.url)), architecture: 'amd64', outputDir: dir, targetCommitSha: sha, certified: true, verification: {level: 'release', checks: ['fixture']}});
  let stopped = false;
  const services = {stop: async () => { stopped = true; }, start: async () => {}, daemonReload() {}, installUnit() {}};
  await assert.rejects(() => preparePublication({artifactPath: artifact.archivePath, checksumPath: artifact.checksumPath, targetCommitSha: sha, configDir: dir, current: path.join(dir, 'current'), publicationPath: path.join(dir, 'publication.json'), uid: undefined, services}), /pinned commit SHA/);
  assert.equal(stopped, false);
});

test('health verification retries startup responses within one deadline', async () => {
  const expected = {releaseId: 'rel-test', targetCommitSha: 'a'.repeat(40), contentHash: 'b'.repeat(64)};
  const config = {analytics: {publicOrigin: 'http://127.0.0.1:8788', viewerAuth: {mode: 'loopback'}}, auth: {}};
  const attempts = new Map();
  const fetchImpl = async url => {
    const route = new URL(url).pathname;
    const attempt = (attempts.get(route) ?? 0) + 1;
    attempts.set(route, attempt);
    if (route === '/api/health' && attempt === 1) return new Response('starting', {status: 503});
    if (route === '/api/health') return Response.json({ok: true, release: expected});
    if (route === '/api/state') return Response.json({storage: 'sqlite', release: expected});
    if (route === '/api/ingest' || route === '/api/collector/status') return new Response('', {status: 404});
    if (route === '/api/live') return new Response('event: ready\ndata: {}\n\n', {status: 200, headers: {'content-type': 'text/event-stream'}});
    throw new Error(`unexpected route ${route}`);
  };
  const result = await defaultHealthCheck(config, {expectedRelease: expected, fetchImpl, timeoutMs: 1000});
  assert.deepEqual(result, {health: true, state: true, viewer: true, sse: true});
  assert.equal(attempts.get('/api/health'), 2);
});

test('publish verification reaches the extracted real HTTP/SSE/SQLite entrypoint', async t => {
  if (process.platform === 'win32') { t.skip('Ubuntu publication swaps a current symlink and runs a Linux service; Windows uses the native app/integration checks.'); return; }
  const dir = fixture(t);
  configureApplication({dir, identity: {listenHost: '127.0.0.1', viewerMode: 'loopback'}});
  const configFile = path.join(dir, 'analytics.json');
  const reserve = net.createServer(); await new Promise((resolve, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', resolve); }); const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const config = readJSON(configFile); config.listen.port = port; config.publicOrigin = `http://127.0.0.1:${port}`; fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n', {mode: 0o600});
  const sha = 'e'.repeat(40);
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const artifact = createReleaseArtifact({root, architecture: 'amd64', outputDir: dir, targetCommitSha: sha, certified: true, verification: {level: 'release', checks: ['fixture']}});
  const current = path.join(dir, 'current'), publication = path.join(dir, 'publication.json');
  let app = null, active = false;
  t.after(async () => { if (app) await app.close(); });
  const services = {
    isActive: () => active,
    isEnabled: () => active,
    stop: async () => { if (app) { await app.close(); app = null; } active = false; },
    start: async () => {
      const runtime = await import(pathToFileURL(path.join(current, 'analytics/runtime/config.mjs')).href);
      const server = await import(pathToFileURL(path.join(current, 'analytics/runtime/server.mjs')).href);
      app = await server.startServer(runtime.loadConfig(configFile), {logger: {info() {}, error: console.error}});
      active = true;
    },
    daemonReload() {}, installUnit() {}
  };
  const prepared = await preparePublication({artifactPath: artifact.archivePath, checksumPath: artifact.checksumPath, targetCommitSha: sha, configDir: dir, current, publicationPath: publication, uid: undefined, services, releaseVerification: fixtureReleaseVerification(artifact.contentHash)});
  const result = await applyPublication(prepared, {services, backup: async () => {}});
  assert.equal(result.changed, true);
  const state = await (await fetch(config.publicOrigin + '/api/state')).json();
  assert.equal(state.release.targetCommitSha, sha);
  assert.equal(state.storage, 'sqlite');
});

test('same payload with a new target SHA keeps the running release identity', async t => {
  const dir = fixture(t);
  configureApplication({dir, identity: {listenHost: '127.0.0.1', viewerMode: 'loopback'}, port: 8788});
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const first = createReleaseArtifact({root, architecture: 'amd64', outputDir: path.join(dir, 'first'), targetCommitSha: '1'.repeat(40), certified: true, verification: {level: 'release', checks: ['fixture']}});
  const second = createReleaseArtifact({root, architecture: 'amd64', outputDir: path.join(dir, 'second'), targetCommitSha: '2'.repeat(40), certified: true, verification: {level: 'release', checks: ['fixture']}});
  const current = path.join(dir, 'current'), publication = path.join(dir, 'publication.json');
  let active = false, stopped = 0, started = 0, expected;
  const services = {isActive: () => active, isEnabled: () => active, stop: async () => { stopped++; active = false; }, start: async () => { started++; active = true; }, daemonReload() {}, installUnit() {}};
  const options = {services, backup: async () => {}, healthCheck: async (_config, details) => { expected = details.expectedRelease; }};
  const releaseVerification = fixtureReleaseVerification(first.contentHash);
  const firstPrepared = await preparePublication({artifactPath: first.archivePath, checksumPath: first.checksumPath, targetCommitSha: '1'.repeat(40), configDir: dir, current, publicationPath: publication, uid: undefined, services, releaseVerification});
  await applyPublication(firstPrepared, options);
  const secondPrepared = await preparePublication({artifactPath: second.archivePath, checksumPath: second.checksumPath, targetCommitSha: '2'.repeat(40), configDir: dir, current, publicationPath: publication, uid: undefined, services, releaseVerification});
  const result = await applyPublication(secondPrepared, options);
  assert.equal(result.changed, false);
  assert.equal(stopped, 1);
  assert.equal(started, 1);
  assert.equal(result.publication.targetCommitSha, '1'.repeat(40));
  assert.equal(result.requestedManifest.targetCommitSha, '2'.repeat(40));
  assert.equal(expected.targetCommitSha, '1'.repeat(40));
  assert.equal(result.proof.commitSha, '1'.repeat(40));
});
