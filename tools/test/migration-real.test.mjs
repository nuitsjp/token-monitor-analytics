/*
 * Explicit real-source migration acceptance.
 *
 * The normal release gate deliberately runs this file with no legacy source
 * bundle, so it skips without touching old Git objects.  Run it only after
 * preparing a bundle with tools/migration-source.mjs and setting
 * TMA_MIGRATION_REAL=1 and TMA_MIGRATION_LEGACY_SOURCE_MANIFEST to the
 * generated manifest.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createReleaseArtifact, verifyReleaseArtifact} from '../release.mjs';
import {
  LEGACY_COMMIT_SHA,
  publishWindowsMigrationArtifact,
  restoreMigration,
  runMigration,
} from '../migrate.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const enabled = process.env.TMA_MIGRATION_REAL === '1';

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
}

function sha256(filename) {
  return createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function regular(filename, label) {
  const stat = fs.lstatSync(filename);
  assert.equal(stat.isFile() && !stat.isSymbolicLink(), true, `${label} must be a regular file`);
}

function requireLegacyBundle() {
  const manifestPath = process.env.TMA_MIGRATION_LEGACY_SOURCE_MANIFEST;
  if (!manifestPath) throw new Error('TMA_MIGRATION_LEGACY_SOURCE_MANIFEST is required when TMA_MIGRATION_REAL=1');
  regular(manifestPath, 'Legacy source manifest');
  const manifest = readJson(manifestPath);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.commitSha, LEGACY_COMMIT_SHA);
  assert.equal(typeof manifest.sourceRoot, 'string');
  assert.equal(path.resolve(manifest.sourceRoot), manifest.sourceRoot);
  assert.equal(typeof manifest.archivePath, 'string');
  assert.equal(path.resolve(manifest.archivePath), manifest.archivePath);
  regular(manifest.archivePath, 'Legacy source archive');
  assert.equal(sha256(manifest.archivePath), manifest.archiveSha256, 'legacy source archive changed after preparation');
  assert.equal(fs.existsSync(path.join(manifest.sourceRoot, 'analytics/runtime/server.mjs')), true, 'legacy server is missing from the pinned source bundle');
  assert.equal(fs.existsSync(path.join(manifest.sourceRoot, 'tools/reset-hubs.mjs')), true, 'legacy drain tool is missing from the pinned source bundle');
  assert.equal(fs.existsSync(path.join(manifest.sourceRoot, 'analytics/migrations/0001_initial.sql')), true, 'legacy migration is missing from the pinned source bundle');
  assert.equal(fs.existsSync(path.join(manifest.sourceRoot, 'analytics/migrations/0002_hubs.sql')), false, 'legacy source bundle unexpectedly contains the new Hub migration');
  return manifest;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function event(eventId, at) {
  return {
    schemaVersion: 1,
    eventId,
    hubId: 'legacy-hub',
    streamId: 'c'.repeat(32),
    kind: 'snapshot',
    observedAt: at,
    receivedAt: new Date(Date.parse(at) + 1000).toISOString(),
    stats: {
      updatedAt: at,
      periods: {today: {costUsd: 1, totalTokens: 10}, allTime: {costUsd: 1, totalTokens: 10}},
      devices: [{
        deviceId: 'legacy-device', updatedAt: at, stale: false,
        periods: {allTime: {costUsd: 1, totalTokens: 10, clientCosts: {'legacy-client': 1}}},
      }],
      limits: {providers: [{
        provider: 'legacy-provider', accountKey: 'legacy-account', updatedAt: at,
        status: 'ok', stale: false, windows: [{kind: 'hour', usedPercent: 1, resetsAt: '2026-09-09T02:00:00.000Z'}],
      }]},
    },
  };
}

async function startLegacy({sourceRoot, analyticsConfigPath, environment}) {
  const runtime = await import(pathToFileURL(path.join(sourceRoot, 'analytics/runtime/config.mjs')).href);
  const server = await import(pathToFileURL(path.join(sourceRoot, 'analytics/runtime/server.mjs')).href);
  const config = runtime.loadConfig(analyticsConfigPath);
  const app = await server.startServer(config, {
    env: environment,
    collectionHubs: [],
    logger: {info() {}, error() {}},
  });
  return {app, config};
}

async function waitHealth(origin) {
  const deadline = Date.now() + 10000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/health`, {signal: AbortSignal.timeout(1000)});
      const body = await response.json();
      if (response.status === 200 && body.ok === true) return body;
      throw new Error(`legacy health returned ${response.status}`);
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  throw lastError ?? new Error('legacy health timed out');
}

function copyTree(source, destination) {
  const stat = fs.lstatSync(source);
  fs.mkdirSync(path.dirname(destination), {recursive: true, mode: 0o700});
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, {recursive: true, mode: stat.mode & 0o777});
    for (const name of fs.readdirSync(source)) copyTree(path.join(source, name), path.join(destination, name));
  } else if (stat.isFile() && !stat.isSymbolicLink()) {
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, stat.mode & 0o7777);
  } else if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(source), destination);
  } else {
    throw new Error(`Unsupported protected fixture entry: ${source}`);
  }
}

function removeEntry(filename) {
  fs.rmSync(filename, {recursive: true, force: true});
}

async function removeTreeEventually(filename) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fs.promises.rm(filename, {recursive: true, force: true, maxRetries: 2, retryDelay: 100});
      if (!fs.existsSync(filename)) return;
    } catch (error) {
      if (attempt === 7) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
  }
  if (fs.existsSync(filename)) throw new Error(`fixture cleanup did not remove ${filename}`);
}

function protectFixtureLayout(dir) {
  const legacyCodeRoot = path.join(dir, 'legacy-code');
  const legacyRunnerDir = path.join(dir, 'legacy-runner');
  const legacyNodePath = path.join(legacyRunnerDir, 'node');
  const infrastructurePath = path.join(dir, 'legacy-infrastructure.json');
  const publicationPath = path.join(dir, 'legacy-publication.json');
  fs.mkdirSync(legacyCodeRoot, {recursive: true, mode: 0o750});
  fs.writeFileSync(path.join(legacyCodeRoot, 'legacy-marker.txt'), 'legacy-code-marker\n', {mode: 0o640});
  fs.mkdirSync(legacyRunnerDir, {recursive: true, mode: 0o750});
  fs.writeFileSync(legacyNodePath, 'legacy-fixed-node-placeholder\n', {mode: 0o750});
  fs.writeFileSync(infrastructurePath, '{"layout":"legacy-infrastructure"}\n', {mode: 0o640});
  fs.writeFileSync(publicationPath, '{"release":"legacy-publication"}\n', {mode: 0o640});
  return {legacyCodeRoot, legacyRunnerDir, legacyNodePath, infrastructurePath, publicationPath};
}

async function makeFixture(t, legacy) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-real-migration-'));
  const fixture = {dir, old: null};
  t.after(async () => {
    const errors = [];
    if (fixture.old) {
      try { await fixture.old.app.close(); } catch (error) { errors.push(error); }
      fixture.old = null;
    }
    try { await removeTreeEventually(dir); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'real migration fixture cleanup failed');
  });
  const token = 'i'.repeat(64);
  const oldHubSecret = 'h'.repeat(40);
  const port = await freePort();
  const databasePath = path.join(dir, 'analytics.db');
  const outboxPath = path.join(dir, 'outbox');
  const configDir = path.join(dir, 'legacy-config');
  const targetDir = path.join(dir, 'target-config');
  const installDir = path.join(dir, 'published-app');
  fs.mkdirSync(outboxPath, {recursive: true, mode: 0o700});
  fs.mkdirSync(configDir, {recursive: true, mode: 0o700});
  fs.mkdirSync(targetDir, {recursive: true, mode: 0o700});
  const analyticsConfigPath = path.join(configDir, 'analytics.json');
  const collectorConfigPath = path.join(configDir, 'collector.json');
  const analyticsEnvPath = path.join(configDir, 'analytics.env');
  const collectorEnvPath = path.join(configDir, 'collector.env');
  const hubsPath = path.join(configDir, 'hubs.json');
  const hubSecretsPath = path.join(configDir, 'hub-secrets.json');
  const contract = {
    id: 'legacy-contract', label: 'Legacy Contract', hubId: 'legacy-hub', provider: 'legacy-provider', accountKey: 'legacy-account',
    clientIds: ['legacy-client'], deviceIds: ['legacy-device'], windowKind: 'hour', windowHours: 1, monthlyFeeUsd: 10,
    attributionConfirmed: true, minDeltaPercent: 1, maxSourceSkewSeconds: 120, maxGapSeconds: 120,
  };
  fs.writeFileSync(hubsPath, `${JSON.stringify({schemaVersion: 1, revision: 0, secretsPath: 'hub-secrets.json', hubs: [{id: 'legacy-hub', label: 'Legacy Hub', url: 'https://legacy.example.invalid', status: 'active', secretRef: 'legacy-hub'}]}, null, 2)}\n`, {mode: 0o600});
  fs.writeFileSync(hubSecretsPath, `${JSON.stringify({schemaVersion: 1, secrets: {'legacy-hub': oldHubSecret}}, null, 2)}\n`, {mode: 0o600});
  fs.writeFileSync(analyticsConfigPath, `${JSON.stringify({
    version: 1,
    listen: {host: '127.0.0.1', port},
    publicOrigin: `http://127.0.0.1:${port}`,
    databasePath,
    timeZone: 'UTC',
    detailRetentionDays: 30,
    ingestTokenEnv: 'TMA_INGEST_TOKEN',
    viewerAuth: {mode: 'loopback'},
    hubsPath: 'hubs.json',
    contracts: [contract],
    update: {enabled: false},
    demo: false,
  }, null, 2)}\n`, {mode: 0o600});
  fs.writeFileSync(collectorConfigPath, `${JSON.stringify({
    version: 1,
    analytics_url: `http://127.0.0.1:${port}`,
    ingest_token_env: 'TMA_INGEST_TOKEN',
    spool_dir: '../outbox',
    max_spool_bytes: 1024 * 1024,
    flush_seconds: 2,
    batch_size: 2,
    idle_seconds: 90,
    hubs: [{id: 'legacy-hub', url: 'https://legacy.example.invalid', secret_env: 'OLD_HUB_SECRET'}],
  }, null, 2)}\n`, {mode: 0o600});
  fs.writeFileSync(analyticsEnvPath, 'LEGACY_ANALYTICS_MARKER=preserve-me\n', {mode: 0o600});
  fs.writeFileSync(collectorEnvPath, 'LEGACY_COLLECTOR_MARKER=preserve-me\n', {mode: 0o600});
  const eventTimes = ['2026-09-09T00:00:00.000Z', '2026-09-09T00:01:00.000Z', '2026-09-09T00:02:00.000Z'];
  for (const [index, at] of eventTimes.entries()) {
    const id = `${String.fromCharCode(97 + index)}${'0'.repeat(31)}`;
    fs.writeFileSync(path.join(outboxPath, `000${index + 1}-${id}.json`), `${JSON.stringify(event(id, at))}\n`, {mode: 0o600});
  }
  const protectedLayout = protectFixtureLayout(dir);
  const environment = {TMA_INGEST_TOKEN: token, OLD_HUB_SECRET: oldHubSecret};
  const old = await startLegacy({sourceRoot: legacy.sourceRoot, analyticsConfigPath, environment});
  fixture.old = old;
  await waitHealth(`http://127.0.0.1:${port}`);
  return {
    dir, legacy, token, oldHubSecret, environment, databasePath, outboxPath, configDir, targetDir, installDir,
    analyticsConfigPath, collectorConfigPath, analyticsEnvPath, collectorEnvPath, hubsPath, hubSecretsPath,
    targetConfigPath: path.join(targetDir, 'analytics.json'), targetSecretsPath: path.join(targetDir, 'hub-secrets.json'),
    targetAnalyticsEnvPath: path.join(targetDir, 'analytics.env'), statePath: path.join(dir, 'migration-state.json'),
    backupDir: path.join(dir, 'migration-backup'), lockPath: path.join(dir, 'deploy.lock'), old, protectedLayout,
  };
}

function sourceOptions(fixture, artifact, legacy, {partial = false} = {}) {
  let oldApp = fixture.old;
  let publishedPid = null;
  const calls = [];
  const services = [
    {scope: 'fixture', unit: 'tma-collector.service', active: true, enabled: true, pid: 1001},
    {scope: 'fixture', unit: 'tma-analytics.service', active: true, enabled: true, pid: 1002},
  ];
  const closeOld = async () => {
    if (oldApp) {
      const current = oldApp;
      oldApp = null;
      fixture.old = null;
      await current.app.close();
    }
  };
  const stopPublished = async () => {
    if (!publishedPid) return;
    const pid = publishedPid;
    publishedPid = null;
    try { process.kill(pid, 'SIGTERM'); } catch {}
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { return; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    try { process.kill(pid, 'SIGKILL'); } catch {}
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { process.kill(pid, 0); } catch { return; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`published fixture process ${pid} did not stop`);
  };
  const platform = {
    inspectServices: async () => services,
    updateState: () => null,
    isUpdateActive: () => false,
    stopCollector: async () => { calls.push('stopCollector'); },
    stopAnalytics: async () => { calls.push('stopAnalytics'); await closeOld(); },
    inhibitAutostart: async () => { calls.push('inhibitAutostart'); },
    verifyStopped: async () => { calls.push('verifyStopped'); assert.equal(oldApp, null); },
    verifyNoDatabaseWriter: async () => {
      calls.push('verifyNoDatabaseWriter');
      assert.equal(oldApp, null);
      if (fs.existsSync(fixture.databasePath)) {
        const probe = `${fixture.databasePath}.probe`;
        fs.renameSync(fixture.databasePath, probe);
        fs.renameSync(probe, fixture.databasePath);
      }
    },
    provision: async () => { calls.push('provision'); return {fixture: true}; },
    configure: async () => { calls.push('configure'); return {configured: true}; },
    publish: async context => {
      calls.push('publish');
      if (partial) return {targetCommitSha: context.targetCommitSha, skipped: true};
      const proof = await publishWindowsMigrationArtifact(context, {windowsInstallDir: fixture.installDir, environment: {}});
      publishedPid = proof.processId;
      return proof;
    },
    preserveCutoverDatabase: async ({backupDir}) => {
      calls.push('preserveCutoverDatabase');
      const destination = path.join(backupDir, 'post-cutover-real.db');
      const sqlite = await import(pathToFileURL(path.join(root, 'analytics/runtime/sqlite.mjs')).href);
      await sqlite.backupDatabase(fixture.databasePath, destination);
      return destination;
    },
    stopNew: async () => {
      calls.push('stopNew');
      await stopPublished();
      removeEntry(fixture.installDir);
    },
    restoreDatabase: async ({source, destination}) => {
      calls.push('restoreDatabase');
      const sqlite = await import(pathToFileURL(path.join(root, 'analytics/runtime/sqlite.mjs')).href);
      await sqlite.backupDatabase(source, destination);
    },
    restoreProtected: async ({manifest, backupRoot}) => {
      calls.push('restoreProtected');
      for (const entry of manifest.entries ?? []) {
        if (!entry.backedUp) {
          if (entry.key !== 'legacy-database' && entry.key !== 'legacy-outbox') removeEntry(entry.path);
          continue;
        }
        if (entry.key === 'legacy-database' || entry.key === 'legacy-outbox') continue;
        const source = path.join(backupRoot, entry.backupKey ?? entry.key);
        assert.equal(fs.existsSync(source), true, `protected backup missing ${entry.key}`);
        removeEntry(entry.path);
        copyTree(source, entry.path);
      }
    },
    startLegacy: async () => {
      calls.push('startLegacy');
      oldApp = await startLegacy({sourceRoot: legacy.sourceRoot, analyticsConfigPath: fixture.analyticsConfigPath, environment: fixture.environment});
      fixture.old = oldApp;
      await waitHealth(oldApp.config.publicOrigin);
      return {fixture: true};
    },
  };
  return {
    calls,
    closeOld,
    stopPublished,
    platform,
    options: {
      oldCommitSha: LEGACY_COMMIT_SHA,
      targetCommitSha: artifact.manifest.targetCommitSha,
      targetArtifactPath: artifact.archivePath,
      analyticsConfigPath: fixture.analyticsConfigPath,
      collectorConfigPath: fixture.collectorConfigPath,
      analyticsEnvPath: fixture.analyticsEnvPath,
      collectorEnvPath: fixture.collectorEnvPath,
      environment: fixture.environment,
      repositoryRoot: root,
      legacySourceRoot: legacy.sourceRoot,
      statePath: fixture.statePath,
      backupDir: fixture.backupDir,
      lockPath: fixture.lockPath,
      targetConfigPath: fixture.targetConfigPath,
      targetSecretsPath: fixture.targetSecretsPath,
      targetAnalyticsEnvPath: fixture.targetAnalyticsEnvPath,
      legacyCodeRoot: fixture.protectedLayout.legacyCodeRoot,
      legacyRunnerDir: fixture.protectedLayout.legacyRunnerDir,
      legacyNodePath: fixture.protectedLayout.legacyNodePath,
      infrastructurePath: fixture.protectedLayout.infrastructurePath,
      publicationPath: fixture.protectedLayout.publicationPath,
      updateStatePath: path.join(fixture.dir, 'update-state.json'),
      // The real source/DB/server fixture is hermetic. Do not inventory a
      // developer host's unrelated /etc system unit paths while exercising
      // the injected platform handoff.
      serviceUnitPaths: [],
      windowsInstallDir: fixture.installDir,
      verifyTargetRelease: ({targetArtifact, targetCommitSha}) => {
        assert.equal(targetArtifact.manifest.targetCommitSha, targetCommitSha);
        assert.equal(targetArtifact.manifest.verification.level, 'release');
        return {checks: ['real-pinned-migration-fixture']};
      },
      platform,
    },
  };
}

async function databaseRows(filename, {newSchema = true} = {}) {
  const {DatabaseSync} = await import('node:sqlite');
  const db = new DatabaseSync(filename, {readOnly: true});
  try {
    const result = {
      migrations: db.prepare('SELECT count(*) AS n FROM schema_migrations').get().n,
      observations: db.prepare('SELECT count(*) AS n FROM observations').get().n,
    };
    if (newSchema) {
      result.archivedHub = db.prepare('SELECT id,label,url,secret_ref,status FROM hubs WHERE id=?').get('legacy-hub');
      result.contracts = db.prepare('SELECT count(*) AS n FROM contract_snapshots WHERE contract_id=?').get('legacy-contract').n;
    } else {
      result.archivedHub = null;
      result.contracts = 0;
    }
    return result;
  } finally { db.close(); }
}

test('real pinned legacy server drains into the native schema and restores the complete protected layout', {skip: !enabled}, async t => {
  const legacy = requireLegacyBundle();
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-real-artifact-'));
  t.after(() => fs.rmSync(fixtureDir, {recursive: true, force: true}));
  const targetSha = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
  assert.match(targetSha, /^[0-9a-f]{40}$/);
  assert.notEqual(targetSha, LEGACY_COMMIT_SHA);
  const artifact = createReleaseArtifact({
    root,
    architecture: 'amd64',
    outputDir: path.join(fixtureDir, 'artifact'),
    targetCommitSha: targetSha,
    certified: true,
    verification: {level: 'release', checks: ['real-pinned-migration-fixture']},
  });
  const verified = verifyReleaseArtifact({archivePath: artifact.archivePath, checksumPath: artifact.checksumPath, expectedTargetCommitSha: targetSha, expectedArchitecture: 'amd64', extractDir: path.join(fixtureDir, 'verified')});
  const fixture = await makeFixture(t, legacy);
  const setup = sourceOptions(fixture, verified, legacy);
  t.after(async () => {
    const errors = [];
    try { await setup.stopPublished(); } catch (error) { errors.push(error); }
    try { await setup.closeOld(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'published real migration fixture cleanup failed');
  });
  const result = await runMigration(setup.options);
  assert.equal(result.state.phase, 'complete');
  assert.equal(fs.readdirSync(fixture.outboxPath).length, 0);
  const migrated = await databaseRows(fixture.databasePath);
  assert.equal(migrated.migrations, 4);
  assert.equal(migrated.observations, 3);
  assert.deepEqual({...migrated.archivedHub}, {id: 'legacy-hub', label: 'Legacy Hub', url: null, secret_ref: null, status: 'archived'});
  assert.equal(migrated.contracts, 1);
  assert.equal(fs.existsSync(fixture.targetConfigPath), true);
  assert.equal(readJson(fixture.targetConfigPath).version, 2);
  assert.deepEqual(readJson(fixture.targetConfigPath).contracts, []);
  assert.deepEqual(readJson(fixture.targetSecretsPath), {schemaVersion: 1, secrets: {}});
  assert.equal(fs.readFileSync(fixture.targetAnalyticsEnvPath, 'utf8'), '');
  assert.equal(fs.readFileSync(path.join(fixture.protectedLayout.legacyCodeRoot, 'legacy-marker.txt'), 'utf8'), 'legacy-code-marker\n');
  assert.equal(fs.readFileSync(fixture.protectedLayout.legacyNodePath, 'utf8'), 'legacy-fixed-node-placeholder\n');
  assert.equal(fs.readFileSync(fixture.protectedLayout.infrastructurePath, 'utf8'), '{"layout":"legacy-infrastructure"}\n');
  assert.equal(fs.readFileSync(fixture.protectedLayout.publicationPath, 'utf8'), '{"release":"legacy-publication"}\n');
  assert.deepEqual(setup.calls.slice(0, 5), ['stopCollector', 'stopAnalytics', 'inhibitAutostart', 'verifyStopped', 'verifyNoDatabaseWriter']);

  // The real Ubuntu handoff replaces these protected paths.  Corrupt the
  // fixture in the same way before rollback and require the manifest copy to
  // restore the exact old code, runner, and root records.
  fs.writeFileSync(path.join(fixture.protectedLayout.legacyCodeRoot, 'legacy-marker.txt'), 'new-code\n');
  fs.writeFileSync(fixture.protectedLayout.legacyNodePath, 'new-runner\n');
  fs.writeFileSync(fixture.protectedLayout.infrastructurePath, '{"layout":"new-infrastructure"}\n');
  fs.writeFileSync(fixture.protectedLayout.publicationPath, '{"release":"new-publication"}\n');

  const restored = await restoreMigration({statePath: fixture.statePath, lockPath: fixture.lockPath, platform: setup.platform});
  assert.equal(restored.state.status, 'restored');
  assert.equal(fs.existsSync(fixture.targetConfigPath), false);
  assert.equal(fs.existsSync(fixture.targetSecretsPath), false);
  assert.equal(fs.existsSync(fixture.analyticsConfigPath), true);
  assert.equal(fs.existsSync(fixture.collectorConfigPath), true);
  assert.equal(fs.existsSync(fixture.hubsPath), true);
  assert.equal(fs.existsSync(fixture.hubSecretsPath), true);
  assert.equal(readJson(fixture.hubsPath).hubs[0].url, 'https://legacy.example.invalid');
  assert.equal(readJson(fixture.hubSecretsPath).secrets['legacy-hub'], fixture.oldHubSecret);
  assert.equal(fs.readFileSync(fixture.protectedLayout.legacyNodePath, 'utf8'), 'legacy-fixed-node-placeholder\n');
  assert.equal(fs.readFileSync(fixture.protectedLayout.infrastructurePath, 'utf8'), '{"layout":"legacy-infrastructure"}\n');
  const rolledBack = await databaseRows(fixture.databasePath, {newSchema: false});
  assert.equal(rolledBack.migrations, 1);
  assert.equal(rolledBack.observations, 3);
  assert.equal(rolledBack.archivedHub, null);
  await setup.closeOld();
});

test('real pinned legacy drain keeps ACKed observations and pending outbox files across rollback', {skip: !enabled}, async t => {
  const legacy = requireLegacyBundle();
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-real-partial-'));
  t.after(() => fs.rmSync(fixtureDir, {recursive: true, force: true}));
  const targetSha = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
  const artifact = createReleaseArtifact({root, architecture: 'amd64', outputDir: path.join(fixtureDir, 'artifact'), targetCommitSha: targetSha, certified: true, verification: {level: 'release', checks: ['real-pinned-migration-fixture']}});
  const verified = verifyReleaseArtifact({archivePath: artifact.archivePath, checksumPath: artifact.checksumPath, expectedTargetCommitSha: targetSha, expectedArchitecture: 'amd64', extractDir: path.join(fixtureDir, 'verified')});
  const fixture = await makeFixture(t, legacy);
  const setup = sourceOptions(fixture, verified, legacy, {partial: true});
  t.after(async () => {
    const errors = [];
    try { await setup.stopPublished(); } catch (error) { errors.push(error); }
    try { await setup.closeOld(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'partial real migration fixture cleanup failed');
  });
  let sendCount = 0;
  setup.options.send = async (url, init) => {
    sendCount += 1;
    if (sendCount === 2) throw new Error('real fixture ACK uncertainty');
    return fetch(url, init);
  };
  await assert.rejects(() => runMigration(setup.options), /Cannot drain outbox/);
  const stoppedRows = await databaseRows(fixture.databasePath, {newSchema: false});
  assert.equal(stoppedRows.migrations, 1);
  assert.equal(stoppedRows.observations, 2);
  assert.equal(fs.readdirSync(fixture.outboxPath).length, 1);
  const state = readJson(fixture.statePath);
  assert.equal(state.phase, 'stop');
  await restoreMigration({statePath: fixture.statePath, lockPath: fixture.lockPath, platform: setup.platform});
  const restoredRows = await databaseRows(fixture.databasePath, {newSchema: false});
  assert.equal(restoredRows.migrations, 1);
  assert.equal(restoredRows.observations, 2);
  assert.equal(fs.readdirSync(fixture.outboxPath).length, 1, 'unacknowledged outbox data was removed during rollback');
  await setup.closeOld();
});
