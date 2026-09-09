/*
 * Opt-in Windows migration acceptance.  It starts the pinned legacy Node
 * server as a real child process, drives the migration CLI with explicit
 * Collector/Analytics PIDs, then invokes the CLI rollback and checks that the
 * old process can open the restored old-schema database again.
 *
 * This is skipped on non-Windows hosts and when TMA_MIGRATION_REAL is absent.
 * The release gate clears that variable before running this file, so a real
 * acceptance run cannot recursively invoke itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {execFileSync, spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createReleaseArtifact, verifyReleaseArtifact} from '../release.mjs';
import {LEGACY_COMMIT_SHA} from '../migrate.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const enabled = process.platform === 'win32' && process.env.TMA_MIGRATION_REAL === '1';

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

function sourceManifest() {
  const filename = process.env.TMA_MIGRATION_LEGACY_SOURCE_MANIFEST;
  if (!filename) throw new Error('TMA_MIGRATION_LEGACY_SOURCE_MANIFEST is required');
  regular(filename, 'Legacy source manifest');
  const manifest = readJson(filename);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.commitSha, LEGACY_COMMIT_SHA);
  regular(manifest.archivePath, 'Legacy source archive');
  assert.equal(sha256(manifest.archivePath), manifest.archiveSha256);
  assert.equal(fs.existsSync(path.join(manifest.sourceRoot, 'analytics/runtime/server.mjs')), true);
  return manifest;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function event(eventId) {
  const at = '2026-09-09T00:00:00.000Z';
  return {
    schemaVersion: 1, eventId, hubId: 'legacy-hub', streamId: 'd'.repeat(32), kind: 'snapshot',
    observedAt: at, receivedAt: '2026-09-09T00:00:01.000Z',
    stats: {
      updatedAt: at,
      periods: {today: {costUsd: 1, totalTokens: 10}, allTime: {costUsd: 1, totalTokens: 10}},
      devices: [], limits: {providers: []},
    },
  };
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function stopProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || !processAlive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch {}
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  // Windows maps SIGTERM to a normal process termination request. If a child
  // ignores it, use the strongest portable signal and keep waiting before
  // allowing the fixture directory to be removed.
  try { process.kill(pid, 'SIGKILL'); } catch {}
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!processAlive(pid)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`fixture process ${pid} did not exit`);
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

async function waitHealth(origin) {
  const deadline = Date.now() + 15000;
  let error;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/health`, {signal: AbortSignal.timeout(1000)});
      const body = await response.json();
      if (response.status === 200 && body.ok === true) return body;
      throw new Error(`health returned ${response.status}`);
    } catch (cause) {
      error = cause;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw error ?? new Error('health timed out');
}

async function databaseSummary(filename) {
  const {DatabaseSync} = await import('node:sqlite');
  const db = new DatabaseSync(filename, {readOnly: true});
  try {
    return {
      migrations: db.prepare('SELECT count(*) AS n FROM schema_migrations').get().n,
      observations: db.prepare('SELECT count(*) AS n FROM observations').get().n,
    };
  } finally { db.close(); }
}

function spawnServer({legacy, configPath, environment}) {
  const serverPath = path.join(legacy.sourceRoot, 'analytics/runtime/server.mjs');
  const child = spawn(process.execPath, ['--experimental-strip-types', serverPath, '--config', configPath], {
    cwd: legacy.sourceRoot,
    env: {...process.env, ...environment},
    stdio: 'ignore',
    windowsHide: true,
  });
  if (!Number.isInteger(child.pid) || child.pid <= 0) throw new Error('legacy Analytics process did not start');
  return child;
}

test('Windows direct CLI migration and rollback restore the old process and database', {skip: !enabled}, async t => {
  const legacy = sourceManifest();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-windows-migration-'));
  const token = 'w'.repeat(64);
  const hubSecret = 's'.repeat(40);
  const port = await freePort();
  const databasePath = path.join(dir, 'analytics.db');
  const outboxPath = path.join(dir, 'outbox');
  const configDir = path.join(dir, 'legacy-config');
  const targetDir = path.join(dir, 'target-config');
  const installDir = path.join(dir, 'published-app');
  const pidFile = path.join(dir, 'restored.pid');
  let legacyAnalytics = null;
  let collector = null;
  t.after(async () => {
    await stopProcess(collector?.pid);
    await stopProcess(legacyAnalytics?.pid);
    if (fs.existsSync(pidFile)) {
      const restoredPid = Number(fs.readFileSync(pidFile, 'utf8'));
      await stopProcess(restoredPid);
    }
    if (fs.existsSync(path.join(dir, 'migration-state.json'))) {
      try {
        const state = readJson(path.join(dir, 'migration-state.json'));
        await stopProcess(state.windowsProcess?.pid ?? state.published?.processId);
      } catch {}
    }
    await removeTreeEventually(dir);
  });
  for (const filename of [outboxPath, configDir, targetDir]) fs.mkdirSync(filename, {recursive: true, mode: 0o700});
  const hubsPath = path.join(configDir, 'hubs.json');
  const secretsPath = path.join(configDir, 'hub-secrets.json');
  const analyticsConfigPath = path.join(configDir, 'analytics.json');
  const collectorConfigPath = path.join(configDir, 'collector.json');
  const analyticsEnvPath = path.join(configDir, 'analytics.env');
  const collectorEnvPath = path.join(configDir, 'collector.env');
  fs.writeFileSync(hubsPath, `${JSON.stringify({schemaVersion: 1, revision: 0, secretsPath: 'hub-secrets.json', hubs: [{id: 'legacy-hub', label: 'Legacy Hub', url: 'https://legacy.example.invalid', status: 'active', secretRef: 'legacy-hub'}]}, null, 2)}\n`, {mode: 0o600});
  fs.writeFileSync(secretsPath, `${JSON.stringify({schemaVersion: 1, secrets: {'legacy-hub': hubSecret}}, null, 2)}\n`, {mode: 0o600});
  fs.writeFileSync(analyticsConfigPath, `${JSON.stringify({version: 1, listen: {host: '127.0.0.1', port}, publicOrigin: `http://127.0.0.1:${port}`, databasePath, timeZone: 'UTC', detailRetentionDays: 30, ingestTokenEnv: 'TMA_INGEST_TOKEN', viewerAuth: {mode: 'loopback'}, hubsPath: 'hubs.json', contracts: [], update: {enabled: false}, demo: false}, null, 2)}\n`, {mode: 0o600});
  fs.writeFileSync(collectorConfigPath, `${JSON.stringify({version: 1, analytics_url: `http://127.0.0.1:${port}`, ingest_token_env: 'TMA_INGEST_TOKEN', spool_dir: '../outbox', max_spool_bytes: 1024 * 1024, flush_seconds: 2, batch_size: 2, idle_seconds: 90, hubs: [{id: 'legacy-hub', url: 'https://legacy.example.invalid', secret_env: 'OLD_HUB_SECRET'}]}, null, 2)}\n`, {mode: 0o600});
  fs.writeFileSync(analyticsEnvPath, 'LEGACY_WINDOWS_ANALYTICS=keep\n', {mode: 0o600});
  fs.writeFileSync(collectorEnvPath, 'LEGACY_WINDOWS_COLLECTOR=keep\n', {mode: 0o600});
  const id = 'e'.repeat(32);
  fs.writeFileSync(path.join(outboxPath, `0001-${id}.json`), `${JSON.stringify(event(id))}\n`, {mode: 0o600});
  const environment = {TMA_INGEST_TOKEN: token, OLD_HUB_SECRET: hubSecret};
  legacyAnalytics = spawnServer({legacy, configPath: analyticsConfigPath, environment});
  await waitHealth(`http://127.0.0.1:${port}`);
  collector = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore', windowsHide: true});
  assert.ok(collector.pid);

  const targetSha = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
  const artifact = createReleaseArtifact({root, architecture: 'amd64', outputDir: path.join(dir, 'artifact'), targetCommitSha: targetSha, certified: true, verification: {level: 'release', checks: ['windows-migration-fixture']}});
  const verified = verifyReleaseArtifact({archivePath: artifact.archivePath, checksumPath: artifact.checksumPath, expectedTargetCommitSha: targetSha, expectedArchitecture: 'amd64', extractDir: path.join(dir, 'verified')});
  assert.equal(verified.manifest.targetCommitSha, targetSha);
  const statePath = path.join(dir, 'migration-state.json');
  const backupDir = path.join(dir, 'migration-backup');
  const lockPath = path.join(dir, 'deploy.lock');
  const targetConfigPath = path.join(targetDir, 'analytics.json');
  const targetSecretsPath = path.join(targetDir, 'hub-secrets.json');
  const targetEnvPath = path.join(targetDir, 'analytics.env');
  const runCli = (args, extraEnv = {}, timeoutMs = 90000) => new Promise((resolve, reject) => {
    const environmentForChild = {...process.env, ...environment, ...extraEnv};
    // The explicit manifest is consumed by this acceptance test to locate
    // the real old server. The CLI itself uses the pinned object in --repository;
    // never let this test's opt-in variable recursively enter release checks.
    delete environmentForChild.TMA_MIGRATION_REAL;
    delete environmentForChild.TMA_MIGRATION_LEGACY_SOURCE_MANIFEST;
    delete environmentForChild.TMA_MIGRATION_WINDOWS_SERVICES;
    const child = spawn(process.execPath, ['--experimental-strip-types', path.join(root, 'tools/migrate.mjs'), ...args], {
      cwd: root,
      env: environmentForChild,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(async () => {
      await stopProcess(child.pid).catch(() => {});
      reject(new Error(`migration CLI timed out after ${timeoutMs}ms\nstdout=${stdout}\nstderr=${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({code, signal, stdout, stderr}); });
  });
  const migrationArgs = [
    '--old-sha', LEGACY_COMMIT_SHA, '--target-sha', targetSha, '--target-artifact', artifact.archivePath,
    '--analytics-config', analyticsConfigPath, '--collector-config', collectorConfigPath,
    '--analytics-env', analyticsEnvPath, '--collector-env', collectorEnvPath,
    '--state', statePath, '--backup-dir', backupDir, '--lock', lockPath,
    '--target-config', targetConfigPath, '--target-secrets', targetSecretsPath, '--target-analytics-env', targetEnvPath,
    '--repository', root, '--windows-install-dir', installDir,
    '--collector-pid', String(collector.pid), '--analytics-pid', String(legacyAnalytics.pid),
  ];
  // The default Windows platform performs the direct PID cutover. Explicit
  // process IDs are the acceptance evidence; no synthetic service inventory
  // is injected into the migration CLI.
  const result = await runCli([...migrationArgs, '--dry-run']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(LEGACY_COMMIT_SHA));
  // The actual cutover command uses the same explicit PIDs after dry-run.
  const applied = await runCli(migrationArgs);
  assert.equal(applied.code, 0, applied.stderr);
  const state = readJson(statePath);
  assert.equal(state.phase, 'complete');
  assert.equal(readJson(targetConfigPath).version, 2);
  assert.equal(readJson(targetSecretsPath).secrets && Object.keys(readJson(targetSecretsPath).secrets).length, 0);
  assert.equal(fs.existsSync(installDir), true);
  await stopProcess(collector.pid);

  // Rollback is a second direct CLI process, without explicit Analytics PID:
  // restore must identify and stop the published process persisted in state.
  const launcher = path.join(dir, 'restore-legacy.mjs');
  fs.writeFileSync(launcher, `import {spawn} from 'node:child_process';\nimport fs from 'node:fs';\nconst child=spawn(process.execPath,['--experimental-strip-types',${JSON.stringify(path.join(legacy.sourceRoot, 'analytics/runtime/server.mjs'))},'--config',${JSON.stringify(analyticsConfigPath)}],{cwd:${JSON.stringify(legacy.sourceRoot)},env:process.env,stdio:'ignore',windowsHide:true});\nfs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));\nchild.on('exit',(code)=>process.exit(code??0));\n`, {mode: 0o600});
  const restored = await runCli(['--restore', '--state', statePath, '--lock', lockPath, '--legacy-command', process.execPath, '--legacy-args', JSON.stringify(['--experimental-strip-types', launcher]), '--legacy-working-dir', dir]);
  assert.equal(restored.code, 0, restored.stderr);
  assert.equal(fs.existsSync(targetConfigPath), false);
  assert.equal(fs.existsSync(analyticsConfigPath), true);
  assert.equal(fs.existsSync(collectorConfigPath), true);
  await waitHealth(`http://127.0.0.1:${port}`);
  const restoredDb = await databaseSummary(databasePath);
  assert.equal(restoredDb.migrations, 1);
  assert.equal(restoredDb.observations, 1);
  await stopProcess(Number(fs.readFileSync(pidFile, 'utf8')));
});
