import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createReleaseArtifact} from '../release.mjs';
import {LEGACY_COMMIT_SHA, preflightMigration, publishWindowsMigrationArtifact, runMigration, restoreMigration} from '../migrate.mjs';
import {verifyReleaseArtifact} from '../release.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const TARGET_SHA = 'b'.repeat(40);

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-migration-'));
  t.after(() => fs.promises.rm(dir, {recursive: true, force: true, maxRetries: 20, retryDelay: 50}));
  return dir;
}

async function oldRuntime() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-old-runtime-'));
  const oldMigrationChecksum = createHash('sha256').update(fs.readFileSync(path.join(root, 'analytics/migrations/0001_initial.sql'))).digest('hex');
  const runtimeDirectory = path.join(directory, 'analytics', 'runtime');
  const toolDirectory = path.join(directory, 'tools');
  fs.mkdirSync(runtimeDirectory, {recursive: true, mode: 0o700});
  fs.mkdirSync(toolDirectory, {recursive: true, mode: 0o700});
  fs.writeFileSync(path.join(runtimeDirectory, 'sqlite.mjs'), `
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync, backup} from 'node:sqlite';
export function openDatabase(filename) {
  fs.mkdirSync(path.dirname(filename), {recursive: true});
  const db = new DatabaseSync(filename);
  db.exec(\`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS observations (hub_id TEXT NOT NULL, event_id TEXT NOT NULL, observed_at TEXT NOT NULL, received_at TEXT NOT NULL, stream_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(hub_id,event_id));
    CREATE INDEX IF NOT EXISTS observations_retention ON observations(observed_at);
    CREATE TABLE IF NOT EXISTS hub_latest (hub_id TEXT PRIMARY KEY NOT NULL, event_id TEXT NOT NULL, observed_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS contract_state (contract_id TEXT PRIMARY KEY NOT NULL, state_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS daily_estimates (contract_id TEXT NOT NULL, day TEXT NOT NULL, last_observed_at TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL, last_valid_at TEXT, window_capacity_usd REAL, monthly_capacity_usd REAL, estimate_json TEXT, PRIMARY KEY(contract_id,day));\`);
  if (!db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get('0001_initial.sql')) db.prepare('INSERT INTO schema_migrations(name, checksum) VALUES(?, ?)').run('0001_initial.sql', '${oldMigrationChecksum}');
  return db;
}
export async function backupDatabase(source, destination) {
  fs.mkdirSync(path.dirname(destination), {recursive: true});
  const sourceDb = new DatabaseSync(source, {readOnly: true});
  try { await backup(sourceDb, destination); } finally { sourceDb.close(); }
}
`);
  fs.writeFileSync(path.join(runtimeDirectory, 'config.mjs'), `
import fs from 'node:fs';
import path from 'node:path';
export function loadConfig(filename) { const config = JSON.parse(fs.readFileSync(filename, 'utf8')); return {...config, configFile: path.resolve(filename), databasePath: path.isAbsolute(config.databasePath) ? config.databasePath : path.resolve(path.dirname(filename), config.databasePath)}; }
`);
  fs.writeFileSync(path.join(runtimeDirectory, 'server.mjs'), `
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
export async function startServer(config) {
  const db = new DatabaseSync(config.databasePath);
  const insert = db.prepare('INSERT OR IGNORE INTO observations(hub_id,event_id,observed_at,received_at,stream_id,payload) VALUES(?,?,?,?,?,?)');
  const server = http.createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/api/ingest') { response.writeHead(404); response.end(); return; }
    const chunks = []; request.on('data', chunk => chunks.push(chunk)); request.on('end', () => {
      try { const body = JSON.parse(Buffer.concat(chunks)); const events = Array.isArray(body.events) ? body.events : []; const acked = []; db.exec('BEGIN'); for (const event of events) { insert.run(event.hubId, event.eventId, event.observedAt, event.receivedAt, event.streamId, JSON.stringify(event.stats ?? {})); acked.push(event.eventId); } db.exec('COMMIT'); response.writeHead(200, {'content-type': 'application/json'}); response.end(JSON.stringify({ok: true, acked})); }
      catch { try { db.exec('ROLLBACK'); } catch {} response.writeHead(400, {'content-type': 'application/json'}); response.end(JSON.stringify({ok: false, acked: []})); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.listen.port, config.listen.host, resolve); });
  return {close: async () => { await new Promise(resolve => server.close(resolve)); db.close(); }};
}
`);
  fs.writeFileSync(path.join(toolDirectory, 'reset-hubs.mjs'), `
import fs from 'node:fs'; import path from 'node:path';
export async function drainOutbox({directory, origin, token, send = fetch}) {
  const names = fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort(); let count = 0;
  for (let index = 0; index < names.length; index += 2) { const batch = names.slice(index, index + 2); const events = batch.map(name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))); const response = await send(origin + '/api/ingest', {method: 'POST', headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'}, body: JSON.stringify({schemaVersion: 1, events})}); const ack = await response.json(); if (!response.ok || !ack.ok || !batch.every(name => ack.acked.includes(events[batch.indexOf(name)].eventId))) throw new Error('ack failed'); for (const name of batch) { fs.unlinkSync(path.join(directory, name)); count++; } }
  return count;
}
`);
  const source = {root: directory};
  const sqlite = await import(new URL('./analytics/runtime/sqlite.mjs', `file://${directory}/`).href);
  return {source, sqlite, cleanup: () => fs.rmSync(directory, {recursive: true, force: true})};
}

function oldConfig(dir, databasePath) {
  const analytics = path.join(dir, 'analytics.json');
  const collector = path.join(dir, 'collector.json');
  fs.writeFileSync(analytics, `${JSON.stringify({
    version: 1,
    listen: {host: '127.0.0.1', port: 8787},
    publicOrigin: 'http://127.0.0.1:8787',
    databasePath,
    timeZone: 'UTC',
    detailRetentionDays: 7,
    ingestTokenEnv: 'TMA_INGEST_TOKEN',
    viewerAuth: {mode: 'loopback'},
    hubs: [{id: 'old-hub', label: 'Old Hub'}],
    contracts: [],
    demo: false,
  }, null, 2)}\n`, {mode: 0o600});
  fs.writeFileSync(collector, `${JSON.stringify({
    version: 1,
    analytics_url: 'http://127.0.0.1:8787',
    ingest_token_env: 'TMA_INGEST_TOKEN',
    spool_dir: './outbox',
    max_spool_bytes: 1024 * 1024,
    flush_seconds: 2,
    batch_size: 2,
    idle_seconds: 90,
    hubs: [{id: 'old-hub', url: 'https://old.example.invalid', secret_env: 'OLD_HUB_SECRET'}],
  }, null, 2)}\n`, {mode: 0o600});
  return {analytics, collector};
}

function legacyEvent() {
  return {
    schemaVersion: 1,
    eventId: 'a'.repeat(32),
    hubId: 'old-hub',
    streamId: 'c'.repeat(32),
    kind: 'snapshot',
    observedAt: '2026-09-09T00:00:00.000Z',
    receivedAt: '2026-09-09T00:00:01.000Z',
    stats: {
      updatedAt: '2026-09-09T00:00:00.000Z',
      periods: {today: {costUsd: 1, totalTokens: 3}},
      devices: [],
      limits: {providers: []},
    },
  };
}

function migrationPlatform(events, calls, {failAt = null} = {}) {
  const hook = name => async value => {
    calls.push(name);
    if (failAt === name) throw Object.assign(new Error(`${name} fixture failure`), {code: `fixture_${name}`});
    return value;
  };
  return {
    inspectServices: async () => [{scope: 'fixture', unit: 'tma-collector.service', active: true, enabled: true, pid: 10}, {scope: 'fixture', unit: 'tma-analytics.service', active: true, enabled: true, pid: 11}],
    updateState: () => null,
    isUpdateActive: () => false,
    stopCollector: hook('stopCollector'),
    stopAnalytics: hook('stopAnalytics'),
    inhibitAutostart: hook('inhibitAutostart'),
    verifyStopped: hook('verifyStopped'),
    provision: hook('provision'),
    configure: hook('configure'),
    publish: async ({targetCommitSha}) => { calls.push('publish'); if (failAt === 'publish') throw Object.assign(new Error('publish fixture failure'), {code: 'fixture_publish'}); return {targetCommitSha}; },
    preserveCutoverDatabase: async ({backupDir}) => { const target = path.join(backupDir, 'post-cutover.db'); fs.copyFileSync(events.databasePath, target); return target; },
    stopNew: hook('stopNew'),
    verifyNoDatabaseWriter: hook('verifyNoDatabaseWriter'),
    restoreDatabase: async ({source, destination}) => { calls.push('restoreDatabase'); fs.copyFileSync(source, destination); },
    restoreProtected: hook('restoreProtected'),
    startLegacy: hook('startLegacy'),
  };
}

async function setup(t) {
  const dir = fixture(t);
  const databasePath = path.join(dir, 'analytics.db');
  const outboxPath = path.join(dir, 'outbox');
  fs.mkdirSync(outboxPath, {recursive: true, mode: 0o700});
  const configs = oldConfig(dir, databasePath);
  const old = await oldRuntime();
  t.after(() => old.cleanup());
  const db = old.sqlite.openDatabase(databasePath);
  db.close();
  fs.writeFileSync(path.join(outboxPath, `00000000000000000001-${'a'.repeat(32)}.json`), JSON.stringify(legacyEvent()), {mode: 0o600});
  const artifact = createReleaseArtifact({root, architecture: 'amd64', outputDir: path.join(dir, 'artifact'), targetCommitSha: TARGET_SHA, certified: true, verification: {level: 'release', checks: ['fixture']}});
  const options = {
    oldCommitSha: LEGACY_COMMIT_SHA,
    targetCommitSha: TARGET_SHA,
    targetArtifactPath: artifact.archivePath,
    analyticsConfigPath: configs.analytics,
    collectorConfigPath: configs.collector,
    environment: {TMA_INGEST_TOKEN: 'i'.repeat(64), OLD_HUB_SECRET: 'h'.repeat(40)},
    repositoryRoot: root,
    legacySourceRoot: old.source.root,
    statePath: path.join(dir, 'migration-state.json'),
    backupDir: path.join(dir, 'migration-backup'),
    lockPath: path.join(dir, 'deploy.lock'),
    targetConfigPath: path.join(dir, 'target', 'analytics.json'),
    targetSecretsPath: path.join(dir, 'target', 'hub-secrets.json'),
    targetAnalyticsEnvPath: path.join(dir, 'target', 'analytics.env'),
    verifyTargetRelease: () => ({checks: ['fixture']}),
  };
  return {dir, databasePath, outboxPath, artifact, options};
}

test('migration drains pinned legacy outbox, archives IDs without active URL/Secret, and resumes idempotently', async t => {
  const f = await setup(t);
  const calls = [];
  f.options.platform = migrationPlatform({databasePath: f.databasePath}, calls);
  const result = await runMigration(f.options);
  assert.equal(result.state.phase, 'complete');
  assert.deepEqual(calls.slice(0, 5), ['stopCollector', 'stopAnalytics', 'inhibitAutostart', 'verifyStopped', 'verifyNoDatabaseWriter']);
  assert.equal(fs.readdirSync(f.outboxPath).length, 0);
  const state = JSON.parse(fs.readFileSync(f.options.statePath, 'utf8'));
  assert.equal(state.rollbackDatabase, path.join(f.options.backupDir, 'post-drain-analytics.db'));
  const {DatabaseSync} = await import('node:sqlite');
  const db = new DatabaseSync(f.databasePath, {readOnly: true});
  try {
    const hub = db.prepare('SELECT id,label,url,secret_ref,status FROM hubs WHERE id=?').get('old-hub');
    assert.deepEqual({...hub}, {id: 'old-hub', label: 'Old Hub', url: null, secret_ref: null, status: 'archived'});
    assert.equal(db.prepare('SELECT count(*) n FROM hub_snapshots WHERE hub_id=?').get('old-hub').n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM observations').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM schema_migrations').get().n, 4);
  } finally { db.close(); }
  const before = fs.readFileSync(f.options.statePath);
  const second = await runMigration(f.options);
  assert.equal(second.alreadyComplete, true);
  await assert.rejects(() => runMigration({...f.options, targetCommitSha: 'f'.repeat(40)}), error => error.code === 'state_revision_mismatch');
  assert.deepEqual(fs.readFileSync(f.options.statePath), before);
});

test('migration loads systemd environment files and lets explicit values win without persisting secrets', async t => {
  const f = await setup(t);
  const analytics = JSON.parse(fs.readFileSync(f.options.analyticsConfigPath, 'utf8'));
  analytics.viewerAuth = {mode: 'basic', userEnv: 'TMA_VIEWER_USER', passwordEnv: 'TMA_VIEWER_PASSWORD'};
  fs.writeFileSync(f.options.analyticsConfigPath, `${JSON.stringify(analytics, null, 2)}\n`, {mode: 0o600});
  const fileToken = 'f'.repeat(64);
  const fileUser = 'file-viewer';
  const filePassword = 'file-password-0123456789';
  fs.writeFileSync(path.join(f.dir, 'analytics.env'), `TMA_VIEWER_USER=${fileUser}\nTMA_VIEWER_PASSWORD=${filePassword}\n`, {mode: 0o600});
  fs.writeFileSync(path.join(f.dir, 'collector.env'), `TMA_INGEST_TOKEN=${fileToken}\n`, {mode: 0o600});
  const explicitToken = 'e'.repeat(64);
  const explicitUser = 'cli-viewer';
  const explicitPassword = 'cli-password-9876543210';
  const calls = [];
  f.options.environment = {TMA_INGEST_TOKEN: explicitToken, TMA_VIEWER_USER: explicitUser, TMA_VIEWER_PASSWORD: explicitPassword};
  f.options.send = async (url, init) => {
    assert.equal(init.headers.Authorization, `Bearer ${explicitToken}`);
    return fetch(url, init);
  };
  f.options.platform = migrationPlatform({databasePath: f.databasePath}, calls);
  await runMigration(f.options);
  const targetEnvironment = fs.readFileSync(f.options.targetAnalyticsEnvPath, 'utf8');
  assert.match(targetEnvironment, new RegExp(`^TMA_VIEWER_USER=${explicitUser}$`, 'm'));
  assert.match(targetEnvironment, new RegExp(`^TMA_VIEWER_PASSWORD=${explicitPassword}$`, 'm'));
  assert.doesNotMatch(targetEnvironment, /TMA_INGEST_TOKEN/);
  const stateText = fs.readFileSync(f.options.statePath, 'utf8');
  for (const secret of [fileToken, filePassword, explicitToken, explicitPassword]) assert.equal(stateText.includes(secret), false, `state leaked ${secret.slice(0, 4)}`);
});

test('conflicting Analytics and Collector environment files fail before mutation', async t => {
  const f = await setup(t);
  fs.writeFileSync(path.join(f.dir, 'analytics.env'), `TMA_INGEST_TOKEN=${'a'.repeat(64)}\n`, {mode: 0o600});
  fs.writeFileSync(path.join(f.dir, 'collector.env'), `TMA_INGEST_TOKEN=${'b'.repeat(64)}\n`, {mode: 0o600});
  let stopped = false;
  f.options.environment = {};
  f.options.platform = {...migrationPlatform({databasePath: f.databasePath}, []), stopCollector: async () => { stopped = true; }};
  await assert.rejects(() => preflightMigration(f.options), error => error.code === 'legacy_env_conflict');
  assert.equal(stopped, false);
  assert.equal(fs.existsSync(f.options.statePath), false);
});

test('distinct legacy ingest variable names are accepted only for matching credentials', async t => {
  const f = await setup(t);
  const config = JSON.parse(fs.readFileSync(f.options.analyticsConfigPath, 'utf8'));
  config.ingestTokenEnv = 'ANALYTICS_INGEST';
  fs.writeFileSync(f.options.analyticsConfigPath, JSON.stringify(config));
  f.options.environment.ANALYTICS_INGEST = f.options.environment.TMA_INGEST_TOKEN;
  f.options.platform = migrationPlatform({databasePath: f.databasePath}, []);
  await preflightMigration(f.options);
  f.options.environment.ANALYTICS_INGEST = 'different-credential';
  await assert.rejects(() => preflightMigration(f.options), error => error.code === 'legacy_ingest_mismatch');
  assert.equal(fs.existsSync(f.options.statePath), false);
});

test('direct publication installs and proves the real Analytics server entrypoint', async t => {
  const f = await setup(t);
  const configDir = path.join(f.dir, 'direct-config');
  const installDir = path.join(f.dir, 'direct-app');
  fs.mkdirSync(configDir, {recursive: true, mode: 0o700});
  const portServer = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
  const targetConfigPath = path.join(configDir, 'analytics.json');
  const targetSecretsPath = path.join(configDir, 'hub-secrets.json');
  fs.writeFileSync(targetConfigPath, JSON.stringify({
    version: 2, listen: {host: '127.0.0.1', port: portServer}, publicOrigin: `http://127.0.0.1:${portServer}`,
    databasePath: f.databasePath, timeZone: 'UTC', detailRetentionDays: 7,
    viewerAuth: {mode: 'loopback'}, hubSecretsPath: targetSecretsPath,
    contracts: [], demo: false, management: {enabled: true}, update: {enabled: false},
  }, null, 2));
  fs.writeFileSync(targetSecretsPath, '{"schemaVersion":1,"secrets":{}}\n', {mode: 0o600});
  const targetArtifact = verifyReleaseArtifact({
    archivePath: f.artifact.archivePath, checksumPath: f.artifact.checksumPath,
    expectedTargetCommitSha: TARGET_SHA, expectedArchitecture: 'amd64',
    extractDir: path.join(f.dir, 'direct-artifact'),
  });
  const proof = await publishWindowsMigrationArtifact({
    state: {targetConfigPath, targetSecretsPath, targetAnalyticsEnvPath: path.join(configDir, 'analytics.env'), windowsInstallDir: installDir},
    targetArtifact,
  }, {windowsInstallDir: installDir, environment: {}});
  try {
    assert.equal(proof.direct, true);
    assert.equal(proof.targetCommitSha, TARGET_SHA);
    assert.equal(proof.health && proof.state && proof.sse, true);
  } finally {
    // Stop before fixture()'s directory cleanup hook. Windows retains the
    // child working directory and SQLite handles until the process exits.
    try { process.kill(proof.processId, 'SIGTERM'); } catch {}
    const deadline = Date.now() + 10000;
    for (;;) {
      try { process.kill(proof.processId, 0); } catch (error) {
        if (error.code === 'ESRCH') break;
        throw error;
      }
      assert.ok(Date.now() < deadline, 'direct Analytics process must exit before fixture cleanup');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
});

test('restore recovers a stopped partial drain without replacing the current database', async t => {
  const f = await setup(t);
  const second = `${'00000000000000000002'}-${'b'.repeat(32)}.json`;
  const third = `${'00000000000000000003'}-${'c'.repeat(32)}.json`;
  fs.writeFileSync(path.join(f.outboxPath, second), JSON.stringify({...legacyEvent(), eventId: 'event-2'}), {mode: 0o600});
  fs.writeFileSync(path.join(f.outboxPath, third), JSON.stringify({...legacyEvent(), eventId: 'event-3'}), {mode: 0o600});
  const calls = [];
  f.options.send = async (url, init) => {
    if (calls.filter(call => call === 'send').length) throw new Error('fixture ACK uncertainty');
    calls.push('send');
    return fetch(url, init);
  };
  f.options.platform = migrationPlatform({databasePath: f.databasePath}, calls);
  await assert.rejects(() => runMigration(f.options), /fixture ACK uncertainty/);
  const before = new (await import('node:sqlite')).DatabaseSync(f.databasePath, {readOnly: true});
  assert.equal(before.prepare('SELECT count(*) AS n FROM observations').get().n, 2);
  before.close();
  const state = JSON.parse(fs.readFileSync(f.options.statePath, 'utf8'));
  assert.equal(state.phase, 'stop');
  const restoreCalls = [];
  const restored = await restoreMigration({statePath: f.options.statePath, lockPath: f.options.lockPath, platform: {
    verifyNoDatabaseWriter: async () => restoreCalls.push('verifyNoDatabaseWriter'),
    preserveCutoverDatabase: async ({backupDir}) => { restoreCalls.push('preserve'); const target = path.join(backupDir, 'pre-final-current.db'); fs.copyFileSync(f.databasePath, target); return target; },
    restoreDatabase: async () => restoreCalls.push('restoreDatabase'),
    restoreProtected: async () => restoreCalls.push('restoreProtected'),
    startLegacy: async () => { restoreCalls.push('startLegacy'); return true; },
  }});
  assert.equal(restored.state.restore.preFinalRecovery, true);
  assert.equal(restoreCalls.includes('restoreDatabase'), false);
  assert.deepEqual(restoreCalls, ['verifyNoDatabaseWriter', 'preserve', 'restoreProtected', 'startLegacy']);
  assert.equal(fs.existsSync(path.join(f.outboxPath, third)), true);
});

test('restore recovers a crash after the durable stop handoff without a rollback database', async t => {
  const f = await setup(t);
  const migrationCalls = [];
  f.options.platform = migrationPlatform({databasePath: f.databasePath}, migrationCalls, {failAt: 'stopCollector'});
  await assert.rejects(() => runMigration(f.options), error => error.code === 'fixture_stopCollector');
  const failed = JSON.parse(fs.readFileSync(f.options.statePath, 'utf8'));
  assert.equal(failed.phase, 'prepare');
  assert.equal(typeof failed.stopAttemptedAt, 'string');
  assert.equal(Array.isArray(failed.legacyServices), true);
  const restoreCalls = [];
  const restored = await restoreMigration({statePath: f.options.statePath, lockPath: f.options.lockPath, platform: {
    stopCollector: async () => restoreCalls.push('stopCollector'),
    stopAnalytics: async () => restoreCalls.push('stopAnalytics'),
    verifyStopped: async () => restoreCalls.push('verifyStopped'),
    verifyNoDatabaseWriter: async () => restoreCalls.push('verifyNoDatabaseWriter'),
    preserveCutoverDatabase: async ({backupDir}) => { restoreCalls.push('preserve'); const p = path.join(backupDir, 'early-current.db'); fs.copyFileSync(f.databasePath, p); return p; },
    restoreProtected: async () => restoreCalls.push('restoreProtected'),
    startLegacy: async () => { restoreCalls.push('startLegacy'); return true; },
  }});
  assert.equal(restored.state.restore.earlyRecovery, true);
  assert.equal(restored.state.restore.preFinalRecovery, false);
  assert.deepEqual(restoreCalls, ['stopCollector', 'stopAnalytics', 'verifyStopped', 'verifyNoDatabaseWriter', 'preserve', 'startLegacy']);
  assert.equal(fs.existsSync(f.databasePath), true);
});

test('unsafe outbox and Web runner invocation fail before a service mutation', async t => {
  const f = await setup(t);
  fs.writeFileSync(path.join(f.outboxPath, '.tmp-crash'), 'pending');
  let mutated = false;
  f.options.platform = {...migrationPlatform({databasePath: f.databasePath}, []), stopCollector: async () => {mutated = true;}};
  await assert.rejects(() => preflightMigration(f.options), error => error.code === 'outbox_unsafe');
  assert.equal(mutated, false);
  fs.rmSync(path.join(f.outboxPath, '.tmp-crash'));
  await assert.rejects(() => preflightMigration({...f.options, webRunner: true}), error => error.code === 'web_runner_migration_rejected');
  assert.equal(fs.existsSync(f.options.statePath), false);
});

test('an unverified target artifact is rejected before the stop phase', async t => {
  const f = await setup(t);
  const unverified = createReleaseArtifact({root, architecture: 'amd64', outputDir: path.join(f.dir, 'unverified-artifact'), targetCommitSha: TARGET_SHA, certified: false});
  let stopped = false;
  f.options.targetArtifactPath = unverified.archivePath;
  f.options.verifyTargetRelease = undefined;
  f.options.platform = {...migrationPlatform({databasePath: f.databasePath}, []), stopCollector: async () => { stopped = true; }};
  await assert.rejects(() => runMigration(f.options), error => error.code === 'target_release_unverified');
  assert.equal(stopped, false);
  assert.equal(fs.existsSync(f.options.statePath), false);
});

test('a failed phase keeps the monotonic state and restore preserves cutover data before rollback', async t => {
  const f = await setup(t);
  const calls = [];
  f.options.platform = migrationPlatform({databasePath: f.databasePath}, calls, {failAt: 'provision'});
  await assert.rejects(() => runMigration(f.options), error => error.code === 'fixture_provision');
  const failed = JSON.parse(fs.readFileSync(f.options.statePath, 'utf8'));
  assert.equal(failed.phase, 'archive');
  assert.equal(failed.error.code, 'fixture_provision');
  const restoreCalls = [];
  const restored = await restoreMigration({statePath: f.options.statePath, lockPath: f.options.lockPath, platform: {
    stopNew: async () => restoreCalls.push('stopNew'),
    verifyNoDatabaseWriter: async () => restoreCalls.push('verifyNoDatabaseWriter'),
    preserveCutoverDatabase: async ({backupDir}) => {restoreCalls.push('preserve'); const p = path.join(backupDir, 'post-cutover-test.db'); fs.copyFileSync(f.databasePath, p); return p;},
    restoreDatabase: async ({source, destination}) => {restoreCalls.push('restoreDatabase'); fs.copyFileSync(source, destination);},
    restoreProtected: async () => restoreCalls.push('restoreProtected'),
    startLegacy: async () => { restoreCalls.push('startLegacy'); },
  }});
  assert.equal(restored.state.restore.legacyStarted, true);
  assert.equal(restored.state.status, 'restored');
  assert.deepEqual(restoreCalls, ['stopNew', 'verifyNoDatabaseWriter', 'preserve', 'restoreDatabase', 'restoreProtected', 'startLegacy']);
});

test('restore rejects a corrupted post-drain backup before destructive cutover changes', async t => {
  const f = await setup(t);
  f.options.platform = migrationPlatform({databasePath: f.databasePath}, [], {failAt: 'provision'});
  await assert.rejects(() => runMigration(f.options), error => error.code === 'fixture_provision');
  const state = JSON.parse(fs.readFileSync(f.options.statePath, 'utf8'));
  fs.appendFileSync(state.rollbackDatabase, Buffer.from('corruption'));
  const restoreCalls = [];
  await assert.rejects(() => restoreMigration({statePath: f.options.statePath, lockPath: f.options.lockPath, platform: {
    stopNew: async () => restoreCalls.push('stopNew'),
    verifyNoDatabaseWriter: async () => restoreCalls.push('verifyNoDatabaseWriter'),
    preserveCutoverDatabase: async () => restoreCalls.push('preserve'),
    restoreDatabase: async () => restoreCalls.push('restoreDatabase'),
    restoreProtected: async () => restoreCalls.push('restoreProtected'),
    startLegacy: async () => restoreCalls.push('startLegacy'),
  }}), error => error.code === 'rollback_backup_invalid');
  assert.deepEqual(restoreCalls, []);
  assert.equal(fs.existsSync(f.databasePath), true);
});
