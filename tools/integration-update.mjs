import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {execFileSync, spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {loadConfig} from '../analytics/runtime/config.mjs';
import {startServer} from '../analytics/runtime/server.mjs';
import {saveUpdateState, readUpdateState} from '../analytics/runtime/update-state.mjs';
import {runUpdate} from './update-runner.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-integration-update-'));
let app = null;
let liveReader = null;
let runningChild = null;

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function until(predicate, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const value = await predicate(); if (value) return value; } catch {}
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  timer.unref();
  await ended;
  clearTimeout(timer);
}

async function jsonResponse(url, init) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  return {response, body};
}

async function waitFile(filename, timeout = 15000) {
  return until(() => fs.existsSync(filename), `file ${filename}`, timeout);
}

const fixtureIdentity = ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Token Monitor fixture'];

function git(command, args, cwd, {identity = false} = {}) {
  const prefix = identity ? fixtureIdentity : [];
  return execFileSync('git', [...prefix, command, ...args], {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
}

function createRemoteFixture() {
  const work = path.join(temp, 'remote-work');
  const bare = path.join(temp, 'remote.git');
  fs.mkdirSync(work, {recursive: true});
  git('init', ['-q'], work);
  fs.writeFileSync(path.join(work, 'README.md'), 'fixture release\n');
  git('add', ['README.md'], work, {identity: true});
  git('commit', ['-qm', 'fixture release'], work, {identity: true});
  const sha = git('rev-parse', ['HEAD'], work);
  git('init', ['--bare', '-q', bare], temp);
  git('push', ['-q', bare, 'HEAD:refs/heads/main'], work);
  return {bare, sha, url: `file://${bare}`};
}

function copySourceFixture() {
  const source = path.join(temp, 'source-work');
  const archive = path.join(temp, 'source-work.tar');
  fs.mkdirSync(source, {recursive: true, mode: 0o700});
  // Archive only tracked source. Copying a worktree recursively can copy its
  // .git pointer, which would make fixture git commands mutate the shared
  // repository/worktree metadata. Submodules and generated/private trees are
  // removed explicitly after extraction even when represented by a gitlink.
  git('archive', ['--format=tar', 'HEAD', '-o', archive], root);
  execFileSync('tar', ['-xf', archive, '-C', source], {stdio: 'ignore'});
  fs.rmSync(archive, {force: true});
  for (const relative of ['external', 'node_modules', 'dist']) {
    fs.rmSync(path.join(source, relative), {recursive: true, force: true});
  }
  git('init', ['-q'], source);
  const sourceReal = fs.realpathSync(source);
  const commonDir = fs.realpathSync(path.resolve(source, git('rev-parse', ['--git-common-dir'], source)));
  assert.equal(commonDir, path.join(sourceReal, '.git'), 'fixture Git metadata must be private to the temporary checkout');
  // The real release gate invokes these entry points. Replace only the
  // fixture checkout's recursive integration calls; production code and the
  // publisher remain the exact target source used by the runner.
  for (const name of ['integration.mjs', 'integration-manage.mjs', 'integration-update.mjs']) {
    fs.writeFileSync(path.join(source, 'tools', name), "console.log('fixture release gate entry point');\n", {mode: 0o600});
  }
  const tests = path.join(source, 'tools', 'test');
  fs.rmSync(tests, {recursive: true, force: true});
  fs.mkdirSync(tests, {recursive: true});
  fs.writeFileSync(path.join(tests, 'fixture-release.test.mjs'), "import test from 'node:test'; test('fixture release gate', () => {});\n", {mode: 0o600});
  git('add', ['-A'], source, {identity: true});
  git('commit', ['-qm', 'fixture verified release'], source, {identity: true});
  const firstSha = git('rev-parse', ['HEAD'], source);
  fs.writeFileSync(path.join(source, 'fixture-only.txt'), 'excluded from the release allowlist\n', {mode: 0o600});
  git('add', ['fixture-only.txt'], source, {identity: true});
  git('commit', ['-qm', 'fixture metadata-only revision'], source, {identity: true});
  const secondSha = git('rev-parse', ['HEAD'], source);
  const bare = path.join(temp, 'source.git');
  git('init', ['--bare', '-q', bare], temp);
  git('push', ['-q', bare, 'HEAD:refs/heads/main'], source);
  return {source, bare, firstSha, secondSha};
}

function setFixtureBranch(repository, sha) {
  git('update-ref', ['refs/heads/main', sha], repository);
}

function fixtureAppScript() {
  const filename = path.join(temp, 'fixture-app.mjs');
  fs.writeFileSync(filename, `
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const appRoot=fs.realpathSync(process.env.APP_ROOT);
const runtime=await import(pathToFileURL(path.join(appRoot,'analytics/runtime/server.mjs')).href);
const configModule=await import(pathToFileURL(path.join(appRoot,'analytics/runtime/config.mjs')).href);
const config=configModule.loadConfig(process.env.CONFIG_PATH);
const app=await runtime.startServer(config,{logger:{info(){},error(){}}});
const pidFile=process.env.PID_FILE;
fs.writeFileSync(pidFile,String(process.pid),{mode:0o600});
let closing=false;
const close=async()=>{if(closing)return;closing=true;try{await app.close();}finally{fs.rmSync(pidFile,{force:true});process.exit(0);}};
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
`, {mode: 0o600});
  return filename;
}

async function startFixtureApp({currentLink, configPath, pidFile, appScript}) {
  const child = spawn(process.execPath, ['--experimental-strip-types', appScript], {
    env: {...process.env, APP_ROOT: currentLink, CONFIG_PATH: configPath, PID_FILE: pidFile},
    stdio: 'ignore'
  });
  await waitFile(pidFile);
  return child;
}

function fixtureServices({currentLink, configPath, pidFile, appScript}) {
  return {
    isActive: () => Boolean(runningChild && runningChild.exitCode === null && runningChild.signalCode === null),
    isEnabled: () => true,
    stop: async () => {
      await stopChild(runningChild);
      runningChild = null;
    },
    start: async () => {
      runningChild = await startFixtureApp({currentLink, configPath, pidFile, appScript});
    },
    installUnit: () => {},
    daemonReload: () => {}
  };
}

async function readReadySSE(origin) {
  const response = await fetch(`${origin}/api/live`);
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  let text = '';
  try {
    while (!text.includes('event: ready')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      text += new TextDecoder().decode(chunk.value);
    }
  } finally { await reader.cancel(); }
  return text;
}

async function runManagementAPIFixture() {
  const remote = createRemoteFixture();
  const appPort = await freePort();
  const configRaw = {
    version: 2,
    listen: {host: '127.0.0.1', port: appPort},
    publicOrigin: `http://127.0.0.1:${appPort}`,
    databasePath: path.join(temp, 'api.db'),
    timeZone: 'UTC',
    detailRetentionDays: 7,
    hubSecretsPath: path.join(temp, 'api-secrets.json'),
    viewerAuth: {mode: 'loopback'},
    contracts: [],
    demo: false,
    management: {enabled: true},
    update: {enabled: true, repositoryUrl: remote.url, branch: 'main', checkIntervalSeconds: 300, statePath: path.join(temp, 'api-state.json'), publicationPath: path.join(temp, 'api-publication.json')}
  };
  fs.writeFileSync(configRaw.hubSecretsPath, JSON.stringify({schemaVersion: 1, secrets: {}}), {mode: 0o600});
  fs.writeFileSync(configRaw.update.publicationPath, JSON.stringify({releaseId: 'rel-api-old', commitSha: '0000000000000000000000000000000000000000', configurationId: 'cfg-api'}), {mode: 0o600});
  const configPath = path.join(temp, 'api-config.json'); fs.writeFileSync(configPath, JSON.stringify(configRaw), {mode: 0o600});
  app = await startServer(loadConfig(configPath), {logger: {info() {}, error: (...args) => console.error(...args)}});
  const origin = configRaw.publicOrigin;
  const live = await fetch(`${origin}/api/live`); assert.equal(live.status, 200); liveReader = live.body.getReader();
  assert.match(new TextDecoder().decode((await liveReader.read()).value), /event: ready/);

  const status = await jsonResponse(`${origin}/api/manage/update`);
  assert.equal(status.response.status, 200); assert.equal(status.body.current.commitSha, '0000000000000000000000000000000000000000');
  const rejected = await jsonResponse(`${origin}/api/manage/update`, {headers: {Origin: 'https://evil.example'}});
  assert.equal(rejected.response.status, 403);
  const candidate = await app.updateManager.checkUpdate();
  assert.equal(candidate.targetCommitSha, remote.sha);
  const invalidApply = await jsonResponse(`${origin}/api/manage/update/apply`, {method: 'POST', headers: {'Content-Type': 'application/json', Origin: origin}, body: JSON.stringify({targetCommitSha: 'invalid'})});
  assert.equal(invalidApply.response.status, 400);
  console.log('PASS: update API enforces origin, checks the remote SHA, and rejects invalid apply input');
}

async function runRealPublicationFixture() {
  const fixture = copySourceFixture();
  const appScript = fixtureAppScript();
  const configDir = path.join(temp, 'deployment-config');
  const install = path.join(temp, 'install');
  const currentLink = path.join(install, 'current');
  const oldRelease = path.join(install, 'old-release');
  const publicationPath = path.join(install, 'publication.json');
  const databasePath = path.join(temp, 'publication.db');
  const secretsPath = path.join(configDir, 'hub-secrets.json');
  const envPath = path.join(configDir, 'analytics.env');
  const appPort = await freePort();
  fs.mkdirSync(configDir, {recursive: true, mode: 0o700});
  fs.mkdirSync(oldRelease, {recursive: true, mode: 0o755});
  fs.mkdirSync(path.join(install, 'releases'), {recursive: true, mode: 0o755});
  fs.cpSync(path.join(fixture.source, 'analytics'), path.join(oldRelease, 'analytics'), {recursive: true});
  fs.writeFileSync(path.join(oldRelease, 'release-manifest.json'), JSON.stringify({schemaVersion: 1, releaseId: 'rel-old', targetCommitSha: '1111111111111111111111111111111111111111', commitSha: '1111111111111111111111111111111111111111', contentHash: 'c'.repeat(64), commitDate: '2026-09-09T00:00:00Z'}), {mode: 0o644});
  fs.symlinkSync(oldRelease, currentLink, 'dir');
  const config = {
    version: 2,
    listen: {host: '127.0.0.1', port: appPort},
    publicOrigin: `http://127.0.0.1:${appPort}`,
    databasePath,
    timeZone: 'UTC',
    detailRetentionDays: 7,
    hubSecretsPath: secretsPath,
    viewerAuth: {mode: 'loopback'},
    contracts: [],
    demo: false,
    management: {enabled: false},
    update: {enabled: false}
  };
  fs.writeFileSync(path.join(configDir, 'analytics.json'), JSON.stringify(config), {mode: 0o600});
  fs.writeFileSync(envPath, '', {mode: 0o600});
  fs.writeFileSync(secretsPath, JSON.stringify({schemaVersion: 1, secrets: {}}), {mode: 0o600});
  fs.writeFileSync(publicationPath, JSON.stringify({schemaVersion: 1, releaseId: 'rel-old', targetCommitSha: '1111111111111111111111111111111111111111', contentHash: 'c'.repeat(64), archiveSha256: 'a'.repeat(64), configurationId: 'cfg-old'}), {mode: 0o600});
  const configPath = path.join(configDir, 'analytics.json');
  const pidFile = path.join(temp, 'app.pid');
  // Seed the committed marker before the application opens SQLite. Keeping
  // one writer at a time makes the fixture exercise the production boundary.
  const marker = new DatabaseSync(databasePath);
  marker.exec('CREATE TABLE IF NOT EXISTS fixture_marker (value TEXT NOT NULL)');
  marker.prepare('INSERT INTO fixture_marker VALUES (?)').run('committed-before-update');
  marker.close();
  runningChild = await startFixtureApp({currentLink, configPath, pidFile, appScript});
  const origin = config.publicOrigin;
  await until(async () => (await (await fetch(`${origin}/api/health`)).json()).ok, 'old packaged app health');

  const statePath = path.join(temp, 'publication-state.json');
  const verifyRoot = path.join(temp, 'verify');
  saveUpdateState(statePath, {
    jobId: 'job-real-publication', targetCommitSha: fixture.firstSha, targetCommitDate: '2026-09-09T00:00:00Z', targetMessage: 'fixture verified release',
    repositoryUrl: 'https://fixture.invalid/token-monitor-analytics.git', branch: 'main', initialConfigurationId: 'cfg-old', status: 'running', stage: 'accepted', startedAt: new Date().toISOString(), finishedAt: null
  });
  setFixtureBranch(fixture.bare, fixture.firstSha);
  const services = fixtureServices({currentLink, configPath, pidFile, appScript});
  const repositoryOps = {
    prepare: async ({targetCommitSha, workRoot}) => {
      const snapshotDirectory = path.join(workRoot, 'source');
      fs.mkdirSync(path.dirname(snapshotDirectory), {recursive: true, mode: 0o700});
      git('worktree', ['add', '--detach', '--force', snapshotDirectory, targetCommitSha], fixture.bare);
      return {
        snapshotDirectory, commitDate: '2026-09-09T00:00:00Z', commitMessage: 'fixture verified release',
        branchSha: git('rev-parse', ['refs/heads/main'], fixture.bare),
        cleanup: () => { try { git('worktree', ['remove', '--force', snapshotDirectory], fixture.bare); } catch {} }
      };
    }
  };
  const paths = {statePath, verifyRoot, repositoryPath: fixture.bare, configPath, infrastructurePath: path.join(temp, 'infrastructure.json'), currentLink, publicationPath, backupPath: path.join(install, 'backups'), prefix: install, appUnit: 'tma-analytics.service', updateUnit: 'tma-update.service'};
  const first = await runUpdate({paths, repositoryOps, services, preflight: async () => {}, enforceInfrastructure: false});
  assert.equal(first.errorCode, undefined);
  const finished = readUpdateState(statePath, {checkServiceActive: () => true});
  assert.equal(finished.status, 'completed'); assert.equal(finished.stage, 'success'); assert.equal(finished.outcome, 'updated'); assert.equal(finished.jobId, 'job-real-publication'); assert.equal(finished.targetCommitSha, fixture.firstSha);
  assert.equal(fs.realpathSync(currentLink), path.join(install, 'releases', finished.expectedReleaseId));
  const health = await (await fetch(`${origin}/api/health`)).json();
  const state = await (await fetch(`${origin}/api/state`)).json();
  assert.equal(health.release.targetCommitSha, fixture.firstSha); assert.equal(health.release.contentHash, finished.contentHash); assert.equal(state.release.targetCommitSha, fixture.firstSha);
  await readReadySSE(origin);
  const backupRoot = path.join(path.dirname(databasePath), 'backups');
  const backupDirectories = fs.readdirSync(backupRoot);
  assert.equal(backupDirectories.length, 1);
  const backup = path.join(backupRoot, backupDirectories[0]);
  assert.equal(fs.existsSync(path.join(backup, 'analytics.db')), true); assert.equal(fs.existsSync(path.join(backup, 'config', 'analytics.json')), true);
  const backupDb = new DatabaseSync(path.join(backup, 'analytics.db'), {readOnly: true});
  assert.equal(backupDb.prepare('SELECT value FROM fixture_marker').get().value, 'committed-before-update'); backupDb.close();
  console.log('PASS: real prepare/apply packaged Analytics, backed up SQLite/config, stopped/restarted the app, and proved release identity plus browser SSE');

  const oldPid = Number(fs.readFileSync(pidFile, 'utf8'));
  setFixtureBranch(fixture.bare, fixture.secondSha);
  saveUpdateState(statePath, {
    jobId: 'job-real-noop', targetCommitSha: fixture.secondSha, targetCommitDate: '2026-09-09T00:00:00Z', targetMessage: 'fixture metadata-only revision',
    repositoryUrl: 'https://fixture.invalid/token-monitor-analytics.git', branch: 'main', initialConfigurationId: JSON.parse(fs.readFileSync(publicationPath, 'utf8')).configurationId, status: 'running', stage: 'accepted', startedAt: new Date().toISOString(), finishedAt: null
  });
  const second = await runUpdate({paths, repositoryOps, services, preflight: async () => {}, enforceInfrastructure: false});
  assert.equal(second.errorCode, undefined);
  const noOp = readUpdateState(statePath, {checkServiceActive: () => true});
  assert.equal(noOp.status, 'completed'); assert.equal(noOp.outcome, 'unchanged'); assert.equal(Number(fs.readFileSync(pidFile, 'utf8')), oldPid);
  const stillCurrent = await (await fetch(`${origin}/api/health`)).json(); assert.equal(stillCurrent.release.targetCommitSha, fixture.firstSha);
  console.log('PASS: identical payload on a newer SHA completed as unchanged without a restart or false SHA claim');
}

async function main() {
  await runManagementAPIFixture();
  await runRealPublicationFixture();
  console.log('UPDATE INTEGRATION OK');
}

main().catch(error => { console.error('UPDATE INTEGRATION FAILED:', error.message); process.exitCode = 1; }).finally(async () => {
  if (liveReader) await liveReader.cancel().catch(() => {});
  await stopChild(runningChild);
  if (app) await app.close().catch(() => {});
  fs.rmSync(temp, {recursive: true, force: true});
});
