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
import {readUpdateState} from '../analytics/runtime/update-state.mjs';
import {startMockHub} from './mockhub.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-integration-update-'));
let app = null;
let liveReader = null;
let runningChild = null;
let realHub = null;

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

const waitFor = until;

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
  // The release gate also runs from a manifest-verified source archive, which
  // intentionally has no .git directory. Keep the checkout path for normal
  // development runs, and copy the already verified tree for that archive
  // path. The destination gets private Git metadata below, so fixture commits
  // never touch the caller's repository or worktree.
  if (fs.existsSync(path.join(root, '.git'))) {
    // Archive only tracked source. Copying a worktree recursively can copy its
    // .git pointer, which would make fixture git commands mutate the shared
    // repository/worktree metadata. Submodules and generated/private trees are
    // removed explicitly after extraction even when represented by a gitlink.
    git('archive', ['--format=tar', 'HEAD', '-o', archive], root);
    execFileSync('tar', ['-xf', archive, '-C', source], {stdio: 'ignore'});
    fs.rmSync(archive, {force: true});
  } else {
    fs.cpSync(root, source, {recursive: true, force: true});
  }
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
import {execFileSync,spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const appRoot=fs.realpathSync(process.env.APP_ROOT);
const runtime=await import(pathToFileURL(path.join(appRoot,'analytics/runtime/server.mjs')).href);
const configModule=await import(pathToFileURL(path.join(appRoot,'analytics/runtime/config.mjs')).href);
const config=configModule.loadConfig(process.env.CONFIG_PATH);
const updatePidFile=process.env.UPDATE_PID_FILE;
const runnerScript=process.env.RUNNER_SCRIPT;
const repositoryPath=process.env.RUNNER_REPOSITORY;
const updateManagerOptions=runnerScript?{
 startService(unitName){
  if(unitName!=='tma-update.service')throw new Error('fixture only controls tma-update.service');
  const child=spawn(process.execPath,['--experimental-strip-types',runnerScript],{env:process.env,detached:true,stdio:'ignore'});
  child.unref();
  if(updatePidFile)fs.writeFileSync(updatePidFile,String(child.pid),{mode:0o600});
  child.once('exit',()=>{try{if(updatePidFile&&fs.readFileSync(updatePidFile,'utf8').trim()===String(child.pid))fs.rmSync(updatePidFile,{force:true});}catch{}});
 },
 isServiceActive(){
  if(!updatePidFile||!fs.existsSync(updatePidFile))return false;
  try{process.kill(Number(fs.readFileSync(updatePidFile,'utf8')),0);return true;}catch{return false;}
 },
 fetchRemoteCommit:async()=>({commitSha:execFileSync('git',['rev-parse','refs/heads/main'],{cwd:repositoryPath,encoding:'utf8'}).trim(),commitDate:'2026-09-09T00:00:00.000Z',message:'fixture verified release'})
}:{ };
const app=await runtime.startServer(config,{logger:{info(){},error(){}},updateManagerOptions});
const pidFile=process.env.PID_FILE;
fs.writeFileSync(pidFile,String(process.pid),{mode:0o600});
let closing=false;
const close=async()=>{if(closing)return;closing=true;try{await app.close();}finally{fs.rmSync(pidFile,{force:true});process.exit(0);}};
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
`, {mode: 0o600});
  return filename;
}

function fixtureRunnerScript() {
  const filename = path.join(temp, 'fixture-runner.mjs');
  fs.writeFileSync(filename, `
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const runner=await import(pathToFileURL(process.env.RUNNER_MODULE).href);
const context=JSON.parse(fs.readFileSync(process.env.RUNNER_CONTEXT,'utf8'));
const pidFile=context.pidFile;
const appScript=context.appScript;
const env={...process.env,APP_ROOT:context.currentLink,CONFIG_PATH:context.configPath,PID_FILE:pidFile};
function git(command,args,cwd){return execFileSync('git',[command,...args],{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}
function pid(){try{const value=Number(fs.readFileSync(pidFile,'utf8'));return Number.isInteger(value)&&value>0?value:null;}catch{return null;}}
async function waitFor(present,timeout=30000){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(fs.existsSync(pidFile)===present)return;await delay(25);}throw new Error('fixture service transition timed out');}
const services={
 isActive(){const value=pid();if(!value)return false;try{process.kill(value,0);return true;}catch{return false;}},
 isEnabled(){return true;},
 async stop(){const value=pid();if(value){try{process.kill(value,'SIGTERM');}catch{}}await waitFor(false);},
 async start(){const child=spawn(process.execPath,['--experimental-strip-types',appScript],{env,detached:true,stdio:'ignore'});child.unref();await waitFor(true);},
 installUnit(){},
 daemonReload(){}
};
const repositoryOps={
 prepare:async({targetCommitSha,workRoot})=>{
  const snapshotDirectory=path.join(workRoot,'source');
  fs.mkdirSync(path.dirname(snapshotDirectory),{recursive:true,mode:0o700});
  git('worktree',['add','--detach','--force',snapshotDirectory,targetCommitSha],context.repositoryPath);
  return {snapshotDirectory,commitDate:'2026-09-09T00:00:00.000Z',commitMessage:'fixture verified release',branchSha:git('rev-parse',['refs/heads/main'],context.repositoryPath),cleanup:()=>{try{git('worktree',['remove','--force',snapshotDirectory],context.repositoryPath);}catch{}}};
 }
};
const result=await runner.runUpdate({paths:context.paths,repositoryOps,services,preflight:async()=>{},enforceInfrastructure:false});
if(result?.errorCode){console.error('fixture runner failed',result.errorCode);process.exitCode=1;}
`, {mode: 0o600});
  return filename;
}

async function startFixtureApp({currentLink, configPath, pidFile, appScript, runnerScript, repositoryPath, updatePidFile, runnerModule, runnerContext}) {
  const child = spawn(process.execPath, ['--experimental-strip-types', appScript], {
    env: {
      ...process.env,
      APP_ROOT: currentLink,
      CONFIG_PATH: configPath,
      PID_FILE: pidFile,
      RUNNER_SCRIPT: runnerScript,
      RUNNER_REPOSITORY: repositoryPath,
      UPDATE_PID_FILE: updatePidFile,
      RUNNER_MODULE: runnerModule,
      RUNNER_CONTEXT: runnerContext,
    },
    stdio: 'ignore'
  });
  await waitFile(pidFile);
  return child;
}

async function stopFixturePid(pidFile) {
  if (!pidFile) return;
  let value = null;
  try { value = Number(fs.readFileSync(pidFile, 'utf8')); } catch {}
  if (!Number.isInteger(value) || value <= 0) return;
  try { process.kill(value, 'SIGTERM'); } catch {}
  await until(() => !fs.existsSync(pidFile), `fixture process ${value} stopped`, 5000).catch(() => {});
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

function readFixtureDatabase(filename, callback) {
  const database = new DatabaseSync(filename, {readOnly: true});
  try { return callback(database); } finally { database.close(); }
}

function fixtureHistory(day, tokens, cost, messages) {
  return {
    daily: [{date: day, tokens, cost, messages}],
    monthly: [{month: day.slice(0, 7), tokens, cost, messages}],
  };
}

function fixtureDevice(history, updatedAt, periodWindows) {
  return {
    deviceId: 'fixture-device',
    hostname: 'fixture-device',
    platform: 'linux-x64',
    agentVersion: 'mockhub',
    updatedAt,
    stale: false,
    today: {totalTokens: history.daily[0].tokens, costUsd: history.daily[0].cost},
    month: {totalTokens: history.monthly[0].tokens, costUsd: history.monthly[0].cost},
    allTime: {totalTokens: history.monthly[0].tokens, costUsd: history.monthly[0].cost},
    periodWindows,
    historyAvailable: true,
    history,
  };
}

async function waitForJob(statePath, jobId) {
  return waitFor(() => {
    const state = readUpdateState(statePath, {checkServiceActive: () => true});
    return state?.jobId === jobId && state.status !== 'running' ? state : null;
  }, `update job ${jobId} completion`, 120000);
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
  if (!app.updateManager.isSupported()) {
    assert.equal(candidate, null);
    const unsupported = await jsonResponse(`${origin}/api/manage/update/check`, {method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json'}, body: '{}'});
    assert.equal(unsupported.response.status, 200);
    assert.equal(unsupported.body.supported, false);
    assert.equal(unsupported.body.reason, 'unsupported_platform');
    console.log('SKIP: self-update runner is explicitly unsupported on this platform; management status remains readable');
    return false;
  }
  assert.equal(candidate.targetCommitSha, remote.sha);
  const invalidApply = await jsonResponse(`${origin}/api/manage/update/apply`, {method: 'POST', headers: {'Content-Type': 'application/json', Origin: origin}, body: JSON.stringify({targetCommitSha: 'invalid'})});
  assert.equal(invalidApply.response.status, 400);
  console.log('PASS: update API enforces origin, checks the remote SHA, and rejects invalid apply input');
  return true;
}

async function runRealPublicationFixture() {
  const fixture = copySourceFixture();
  const appScript = fixtureAppScript();
  const runnerScript = fixtureRunnerScript();
  const configDir = path.join(temp, 'deployment-config');
  const install = path.join(temp, 'install');
  const currentLink = path.join(install, 'current');
  const oldRelease = path.join(install, 'old-release');
  const publicationPath = path.join(install, 'publication.json');
  const databasePath = path.join(temp, 'publication.db');
  const secretsPath = path.join(configDir, 'hub-secrets.json');
  const envPath = path.join(configDir, 'analytics.env');
  const statePath = path.join(temp, 'publication-state.json');
  const verifyRoot = path.join(temp, 'verify');
  const updatePidFile = path.join(temp, 'update.pid');
  const runnerContextPath = path.join(temp, 'runner-context.json');
  const appPort = await freePort();
  const firstClockDate = new Date(Date.now());
  firstClockDate.setUTCDate(firstClockDate.getUTCDate() - 1);
  firstClockDate.setUTCHours(23, 59, 0, 0);
  const secondClockDate = new Date(firstClockDate.getTime() + 2 * 60 * 1000);
  const firstClockIso = firstClockDate.toISOString();
  const secondClockIso = secondClockDate.toISOString();
  let hubClock = firstClockDate.getTime();
  const firstDay = firstClockIso.slice(0, 10);
  const secondDay = secondClockIso.slice(0, 10);
  const nextDay = value => { const date = new Date(value); date.setUTCDate(date.getUTCDate() + 1); date.setUTCHours(0, 0, 0, 0); return date.toISOString(); };
  const nextMonth = value => { const date = new Date(value); date.setUTCDate(1); date.setUTCHours(0, 0, 0, 0); date.setUTCMonth(date.getUTCMonth() + 1); return date.toISOString(); };
  const firstPeriodWindows = {timeZone: 'UTC', today: {key: firstDay, endsAt: nextDay(firstClockIso)}, month: {key: firstClockIso.slice(0, 7), endsAt: nextMonth(firstClockIso)}};
  const secondPeriodWindows = {timeZone: 'UTC', today: {key: secondDay, endsAt: nextDay(secondClockIso)}, month: {key: secondClockIso.slice(0, 7), endsAt: nextMonth(secondClockIso)}};
  const firstHistory = fixtureHistory(firstDay, 24, 2.4, 4);
  const secondHistory = fixtureHistory(secondDay, 48, 4.8, 8);
  realHub = await startMockHub({
    listen: '127.0.0.1:0',
    secret: 'fixture-hub-secret',
    intervalMs: 40,
    disconnectAfter: 2,
    clock: () => hubClock,
    devices: [fixtureDevice(firstHistory, firstClockIso, firstPeriodWindows)],
  });
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
    management: {enabled: true},
    update: {enabled: true, repositoryUrl: 'https://fixture.invalid/token-monitor-analytics.git', branch: 'main', checkIntervalSeconds: 300, statePath, publicationPath}
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
  const paths = {statePath, verifyRoot, repositoryPath: fixture.bare, configPath, infrastructurePath: path.join(temp, 'infrastructure.json'), currentLink, publicationPath, backupPath: path.join(install, 'backups'), prefix: install, appUnit: 'tma-analytics.service', updateUnit: 'tma-update.service'};
  fs.writeFileSync(runnerContextPath, JSON.stringify({paths, repositoryPath: fixture.bare, currentLink, configPath, pidFile, appScript}), {mode: 0o600});
  runningChild = await startFixtureApp({currentLink, configPath, pidFile, appScript, runnerScript, repositoryPath: fixture.bare, updatePidFile, runnerModule: path.join(root, 'tools', 'update-runner.mjs'), runnerContext: runnerContextPath});
  const origin = config.publicOrigin;
  await until(async () => (await (await fetch(`${origin}/api/health`)).json()).ok, 'old packaged app health');
  setFixtureBranch(fixture.bare, fixture.firstSha);

  const hubRegistration = await jsonResponse(`${origin}/api/manage/hubs`, {method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json'}, body: JSON.stringify({id: 'hub-update', label: 'Update fixture Hub', url: realHub.origin, secret: realHub.secret})});
  assert.equal(hubRegistration.response.status, 200);
  await waitFor(() => readFixtureDatabase(databasePath, db => Number(db.prepare("SELECT count(*) AS total FROM observations WHERE hub_id='hub-update'").get().total) > 0), 'initial Hub SSE observation');
  await waitFor(() => readFixtureDatabase(databasePath, db => db.prepare("SELECT last_status FROM usage_fetches WHERE hub_id='hub-update'").get()?.last_status === 'success'), 'initial Hub history fetch');
  const initialHistoryResponse = await fetch(`${origin}/api/usage-history?hubId=hub-update&deviceId=fixture-device&granularity=daily&from=${firstDay}&to=${firstDay}`);
  assert.equal(initialHistoryResponse.status, 200);
  assert.equal((await initialHistoryResponse.json()).rows[0].tokens, 24);
  assert.equal((await fetch(`${origin}/update-restart.mjs`)).status, 200);

  const beforeRestart = readFixtureDatabase(databasePath, db => ({
    streams: Number(db.prepare("SELECT count(DISTINCT stream_id) AS total FROM observations WHERE hub_id='hub-update'").get().total),
    fetchId: Number(db.prepare("SELECT last_attempt_fetch_id FROM usage_fetches WHERE hub_id='hub-update'").get().last_attempt_fetch_id),
  }));
  const oldPid = Number(fs.readFileSync(pidFile, 'utf8'));
  const candidateResponse = await jsonResponse(`${origin}/api/manage/update/check`, {method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json'}, body: '{}'});
  assert.equal(candidateResponse.response.status, 200);
  assert.equal(candidateResponse.body.candidate.targetCommitSha, fixture.firstSha);
  const appliedResponse = await jsonResponse(`${origin}/api/manage/update/apply`, {method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json'}, body: JSON.stringify({targetCommitSha: fixture.firstSha})});
  assert.equal(appliedResponse.response.status, 202);
  const firstJobId = appliedResponse.body.jobId;
  assert.equal(typeof firstJobId, 'string');
  const finished = await waitForJob(statePath, firstJobId);
  assert.equal(finished.status, 'completed'); assert.equal(finished.stage, 'success'); assert.equal(finished.outcome, 'updated'); assert.equal(finished.targetCommitSha, fixture.firstSha);
  // Inspect the runner terminal state before waiting on the old process. A
  // verification failure must fail promptly instead of masking its error as a
  // thirty-second service-stop timeout.
  await waitFor(() => runningChild?.exitCode !== null || runningChild?.signalCode !== null, 'old Analytics process stop', 30000);
  await waitFor(() => fs.existsSync(pidFile) && Number(fs.readFileSync(pidFile, 'utf8')) !== oldPid, 'new Analytics process start', 30000);
  assert.equal(fs.realpathSync(currentLink), path.join(install, 'releases', finished.expectedReleaseId));
  const health = await (await fetch(`${origin}/api/health`)).json();
  const state = await (await fetch(`${origin}/api/state`)).json();
  assert.equal(health.release.targetCommitSha, fixture.firstSha); assert.equal(health.release.contentHash, finished.contentHash); assert.equal(state.release.targetCommitSha, fixture.firstSha);
  await readReadySSE(origin);
  await waitFor(() => readFixtureDatabase(databasePath, db => Number(db.prepare("SELECT count(DISTINCT stream_id) AS total FROM observations WHERE hub_id='hub-update'").get().total) > beforeRestart.streams), 'Hub SSE resume after app restart');
  await waitFor(() => readFixtureDatabase(databasePath, db => Number(db.prepare("SELECT last_attempt_fetch_id FROM usage_fetches WHERE hub_id='hub-update'").get().last_attempt_fetch_id) > beforeRestart.fetchId), 'Hub history resume after app restart');
  const resumedHistoryResponse = await fetch(`${origin}/api/usage-history?hubId=hub-update&deviceId=fixture-device&granularity=daily&from=${firstDay}&to=${firstDay}`);
  assert.equal((await resumedHistoryResponse.json()).rows[0].tokens, 24);
  const backupRoot = path.join(path.dirname(databasePath), 'backups');
  const backupDirectories = fs.readdirSync(backupRoot);
  assert.equal(backupDirectories.length, 1);
  const backup = path.join(backupRoot, backupDirectories[0]);
  assert.equal(fs.existsSync(path.join(backup, 'analytics.db')), true); assert.equal(fs.existsSync(path.join(backup, 'config', 'analytics.json')), true);
  const backupDb = new DatabaseSync(path.join(backup, 'analytics.db'), {readOnly: true});
  assert.equal(backupDb.prepare('SELECT value FROM fixture_marker').get().value, 'committed-before-update'); backupDb.close();
  console.log('PASS: Web candidate/apply used the real runner, packaged Analytics, backed up SQLite/config, stopped/restarted the app, and proved release identity, browser SSE, and Hub/history resume');

  setFixtureBranch(fixture.bare, fixture.secondSha);
  const noOpPid = Number(fs.readFileSync(pidFile, 'utf8'));
  const noOpCandidate = await jsonResponse(`${origin}/api/manage/update/check`, {method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json'}, body: '{}'});
  assert.equal(noOpCandidate.response.status, 200); assert.equal(noOpCandidate.body.candidate.targetCommitSha, fixture.secondSha);
  const noOpApplied = await jsonResponse(`${origin}/api/manage/update/apply`, {method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json'}, body: JSON.stringify({targetCommitSha: fixture.secondSha})});
  assert.equal(noOpApplied.response.status, 202);
  const noOp = await waitForJob(statePath, noOpApplied.body.jobId);
  assert.equal(noOp.status, 'completed'); assert.equal(noOp.outcome, 'unchanged'); assert.equal(Number(fs.readFileSync(pidFile, 'utf8')), noOpPid);
  const stillCurrent = await (await fetch(`${origin}/api/health`)).json(); assert.equal(stillCurrent.release.targetCommitSha, fixture.firstSha);
  console.log('PASS: identical payload on a newer SHA completed as unchanged without a restart or false SHA claim');

  const afterNoOpFetchId = readFixtureDatabase(databasePath, db => Number(db.prepare("SELECT last_attempt_fetch_id FROM usage_fetches WHERE hub_id='hub-update'").get().last_attempt_fetch_id));
  const stoppedPid = Number(fs.readFileSync(pidFile, 'utf8'));
  await stopFixturePid(pidFile);
  assert.equal(fs.existsSync(pidFile), false, 'Analytics pid file must be removed before the simulated day advances');
  await waitFor(() => {
    try { process.kill(stoppedPid, 0); return false; } catch { return true; }
  }, 'Analytics process exit before UTC day advance', 10000);
  console.log('PASS: stopped the Analytics process before advancing the simulated Hub day');

  hubClock = secondClockDate.getTime();
  realHub.setDeviceHistory('fixture-device', secondHistory, {updatedAt: secondClockIso, periodWindows: secondPeriodWindows});
  runningChild = await startFixtureApp({currentLink, configPath, pidFile, appScript, runnerScript, repositoryPath: fixture.bare, updatePidFile, runnerModule: path.join(root, 'tools', 'update-runner.mjs'), runnerContext: runnerContextPath});
  await until(async () => (await (await fetch(`${origin}/api/health`)).json()).ok, 'Analytics health after stopped UTC day advance');
  await readReadySSE(origin);
  await waitFor(() => readFixtureDatabase(databasePath, db => {
    const row = db.prepare("SELECT latest_success_fetch_id,last_status FROM usage_fetches WHERE hub_id='hub-update'").get();
    return Number(row?.latest_success_fetch_id) > afterNoOpFetchId && row?.last_status === 'success';
  }), 'Hub history fetch after UTC day advance');
  const dailyResponse = await fetch(`${origin}/api/usage-history?hubId=hub-update&deviceId=fixture-device&granularity=daily&from=${firstDay}&to=${secondDay}`);
  assert.equal(dailyResponse.status, 200);
  const dailyBody = await dailyResponse.json();
  assert.deepEqual(dailyBody.rows.map(row => [row.periodKey, row.tokens]), [[firstDay, 24], [secondDay, 48]]);
  assert.equal(new Set(dailyBody.rows.map(row => row.periodKey)).size, 2, 'daily history must not duplicate a period when the app was stopped');
  assert.equal(dailyBody.rows[0].current, false, 'the retained first day must remain visibly older than the replacement fetch');
  assert.equal(dailyBody.rows[1].current, true, 'the restarted app must mark the new day as current');

  const monthlyFrom = firstDay.slice(0, 7);
  const monthlyTo = secondDay.slice(0, 7);
  const monthlyResponse = await fetch(`${origin}/api/usage-history?hubId=hub-update&deviceId=fixture-device&granularity=monthly&from=${monthlyFrom}&to=${monthlyTo}`);
  assert.equal(monthlyResponse.status, 200);
  const monthlyBody = await monthlyResponse.json();
  const expectedMonthly = monthlyFrom === monthlyTo
    ? [[monthlyFrom, 48]]
    : [[monthlyFrom, 24], [monthlyTo, 48]];
  assert.deepEqual(monthlyBody.rows.map(row => [row.periodKey, row.tokens]), expectedMonthly);
  assert.equal(new Set(monthlyBody.rows.map(row => row.periodKey)).size, monthlyBody.rows.length, 'monthly history must not duplicate a period when the app was stopped');

  const stateAfterRestart = await (await fetch(`${origin}/api/state`)).json();
  assert.equal(stateAfterRestart.estimates.length, 0, 'history fetch must not generate contract estimates');
  assert.ok(stateAfterRestart.hubs.some(hub => hub.stats?.limits?.providers?.length > 0), 'live limit observations must remain sourced from SSE after the history fetch');
  assert.equal(readFixtureDatabase(databasePath, db => Number(db.prepare('SELECT count(*) AS total FROM daily_estimates').get().total)), 0, 'history rows must not be persisted as estimated observations');
  console.log('PASS: stopped-day restart retained both daily rows, replaced monthly rows without double counting, and kept live limits/estimates separate');
}

async function main() {
  const selfUpdateSupported = await runManagementAPIFixture();
  if (!selfUpdateSupported) {
    console.log('SKIP: real Web publication fixture requires the supported Ubuntu update runner');
    return;
  }
  await runRealPublicationFixture();
  console.log('UPDATE INTEGRATION OK');
}

main().catch(error => { console.error('UPDATE INTEGRATION FAILED:', error.message); process.exitCode = 1; }).finally(async () => {
  if (liveReader) await liveReader.cancel().catch(() => {});
  await stopChild(runningChild);
  await stopFixturePid(path.join(temp, 'app.pid'));
  await stopFixturePid(path.join(temp, 'update.pid'));
  if (realHub) await realHub.close().catch(() => {});
  if (app) await app.close().catch(() => {});
  fs.rmSync(temp, {recursive: true, force: true});
});
