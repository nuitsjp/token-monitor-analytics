import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {loadConfig} from '../analytics/runtime/config.mjs';
import {startServer} from '../analytics/runtime/server.mjs';
import {saveUpdateState, readUpdateState} from '../analytics/runtime/update-state.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-integration-update-'));
const children = new Set();
let app = null;
let liveReader = null;

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function until(predicate, label, timeout = 15000) {
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

async function waitFile(filename, timeout = 10000) {
  return until(() => fs.existsSync(filename), `file ${filename}`, timeout);
}

function git(command, args, cwd) {
  return execFileSync('git', [command, ...args], {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
}

function createRemoteFixture() {
  const work = path.join(temp, 'remote-work');
  const bare = path.join(temp, 'remote.git');
  fs.mkdirSync(work, {recursive: true});
  git('init', ['-q'], work);
  git('config', ['user.email', 'fixture@example.invalid'], work);
  git('config', ['user.name', 'Update fixture'], work);
  fs.writeFileSync(path.join(work, 'README.md'), 'fixture release\n');
  git('add', ['README.md'], work);
  git('commit', ['-qm', 'fixture release'], work);
  const sha = git('rev-parse', ['HEAD'], work);
  git('init', ['--bare', '-q', bare], temp);
  git('push', ['-q', bare, 'HEAD:refs/heads/main'], work);
  return {bare, sha, url: `file://${bare}`};
}

function writeChildAppFixture() {
  const child = path.join(temp, 'packaged-app.mjs');
  fs.writeFileSync(child, `
import fs from 'node:fs';
const appRoot=process.env.APP_ROOT;
const configModule=await import(new URL('analytics/runtime/config.mjs', 'file://'+appRoot+'/'));
const serverModule=await import(new URL('analytics/runtime/server.mjs', 'file://'+appRoot+'/'));
const config=configModule.loadConfig(process.env.CONFIG_PATH);
const app=await serverModule.startServer(config,{logger:{info(){},error(){}}});
const pidFile=process.env.PID_FILE;
fs.writeFileSync(pidFile,String(process.pid),{mode:0o600});
const close=async()=>{try{await app.close();}finally{fs.rmSync(pidFile,{force:true});process.exit(0);}};
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
`, {mode: 0o600});
  return child;
}

function copyPackagedApp(releaseRoot, releaseId, commitSha, contentHash) {
  fs.mkdirSync(releaseRoot, {recursive: true, mode: 0o700});
  fs.cpSync(path.join(root, 'analytics'), path.join(releaseRoot, 'analytics'), {recursive: true, errorOnExist: true});
  fs.writeFileSync(path.join(releaseRoot, 'release-manifest.json'), `${JSON.stringify({schemaVersion: 1, releaseId, targetCommitSha: commitSha, commitSha, contentHash, commitDate: '2026-09-09T00:00:00Z'}, null, 2)}\n`, {mode: 0o600});
}

function writeFixtureReleaseModule(filename) {
  fs.writeFileSync(filename, `
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
export async function preparePublication({root:sourceDirectory,targetCommitSha}){
 const archivePath=path.join(sourceDirectory,'fixture-release.tar.gz');
 fs.writeFileSync(archivePath,'fixture archive bytes');
 const manifest={releaseId:'rel-integ-new',targetCommitSha,contentHash:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',runtimeContract:{}};
 return {artifact:{archivePath,checksumPath:archivePath+'.sha256',archiveSha256:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',manifest},manifest,configurationId:'cfg-after'};
}
async function waitUntilFile(file,present){for(let i=0;i<300;i++){if(fs.existsSync(file)===present)return;await new Promise(r=>setTimeout(r,20));}throw new Error('fixture process transition timed out');}
async function json(url){const r=await fetch(url);if(!r.ok)throw new Error('fixture app request failed');return r.json();}
export async function applyPublication(prepared,{targetCommitSha,jobId,paths,onStage}){
 const {releaseId,contentHash}=prepared.manifest,archiveSha256=prepared.artifact.archiveSha256;
 const pid=Number(fs.readFileSync(paths.fixturePidFile,'utf8'));process.kill(pid,'SIGTERM');await waitUntilFile(paths.fixturePidFile,false);onStage('restarting');
 fs.rmSync(paths.currentLink,{force:true});fs.symlinkSync(paths.fixtureNewRelease,paths.currentLink,'dir');
 const child=spawn(process.execPath,[paths.fixtureChildApp],{env:{...process.env,APP_ROOT:paths.currentLink,CONFIG_PATH:paths.fixtureConfig,PID_FILE:paths.fixturePidFile},stdio:'ignore',detached:true});child.unref();
 await waitUntilFile(paths.fixturePidFile,true);const health=await json(paths.fixtureOrigin+'/api/health');const state=await json(paths.fixtureOrigin+'/api/state');
 const sse=await fetch(paths.fixtureOrigin+'/api/live');const reader=sse.body.getReader();const first=await reader.read();await reader.cancel();
 return {proof:{jobId,commitSha:health.release?.commitSha,releaseId:health.release?.releaseId,contentHash:health.release?.contentHash,archiveSha256,configurationId:'cfg-after',health:health.release?.commitSha===targetCommitSha,state:state.release?.commitSha===targetCommitSha,viewer:true,sse:new TextDecoder().decode(first.value).includes('event: ready')}};
}
`, {mode: 0o600});
}

function writeFixtureContract(filename) {
  fs.writeFileSync(filename, 'export const RUNNER_CONTRACT={}; export function validateRunnerContract(){return true;} export function validateInfrastructureRecord(){return true;}\n', {mode: 0o600});
}

function runnerInvocation({runner, statePath, contract, release, source, paths}) {
  return `
import {runUpdate} from ${JSON.stringify(new URL(`file://${runner}`).href)};
import fs from 'node:fs';
import path from 'node:path';
const paths=${JSON.stringify({...paths,statePath})};
const repositoryOps={prepare:async({workRoot})=>{const snapshotDirectory=path.join(workRoot,'fixture-source');fs.mkdirSync(path.join(snapshotDirectory,'tools'),{recursive:true});fs.copyFileSync(${JSON.stringify(release)},path.join(snapshotDirectory,'tools','publish-ubuntu.mjs'));return {snapshotDirectory,commitDate:'2026-09-09T00:00:00Z',commitMessage:'fixture release',branchSha:${JSON.stringify(paths.targetCommitSha)}};}};
const result=await runUpdate({paths,contractModulePath:${JSON.stringify(contract)},repositoryOps,preflight:async()=>{},misePath:null});
if(result?.errorCode)process.exitCode=2;
`;
}

async function main() {
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
  const first = await liveReader.read(); assert.match(new TextDecoder().decode(first.value), /event: ready/);

  const status = await jsonResponse(`${origin}/api/manage/update`);
  assert.equal(status.response.status, 200); assert.equal(status.body.current.commitSha, '0000000000000000000000000000000000000000');
  const rejected = await jsonResponse(`${origin}/api/manage/update`, {headers: {Origin: 'https://evil.example'}});
  assert.equal(rejected.response.status, 403);
  const candidate = await app.updateManager.checkUpdate();
  assert.equal(candidate.targetCommitSha, remote.sha);
  const invalidApply = await jsonResponse(`${origin}/api/manage/update/apply`, {method: 'POST', headers: {'Content-Type': 'application/json', Origin: origin}, body: JSON.stringify({targetCommitSha: 'invalid'})});
  assert.equal(invalidApply.response.status, 400);
  console.log('PASS: update API enforces origin, checks the remote SHA, and rejects invalid apply input');

  const childApp = writeChildAppFixture();
  const oldRelease = path.join(temp, 'release-old'); const newRelease = path.join(temp, 'release-new');
  const contentHash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  copyPackagedApp(oldRelease, 'rel-integ-old', '0000000000000000000000000000000000000000', 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc');
  copyPackagedApp(newRelease, 'rel-integ-new', remote.sha, contentHash);
  const currentLink = path.join(temp, 'current'); fs.symlinkSync(oldRelease, currentLink, 'dir');
  const childPort = await freePort();
  const childConfig = {...configRaw, listen: {host: '127.0.0.1', port: childPort}, publicOrigin: `http://127.0.0.1:${childPort}`,
    databasePath: path.join(temp, 'packaged.db'), hubSecretsPath: path.join(temp, 'packaged-secrets.json'), management: {enabled: false}, update: {enabled: false}};
  fs.writeFileSync(childConfig.hubSecretsPath, JSON.stringify({schemaVersion: 1, secrets: {}}), {mode: 0o600});
  const childConfigPath = path.join(temp, 'packaged-config.json'); fs.writeFileSync(childConfigPath, JSON.stringify(childConfig), {mode: 0o600});
  const pidFile = path.join(temp, 'packaged.pid');
  const oldChild = spawn(process.execPath, [childApp], {env: {...process.env, APP_ROOT: currentLink, CONFIG_PATH: childConfigPath, PID_FILE: pidFile}, stdio: 'ignore'}); children.add(oldChild);
  await waitFile(pidFile);
  const packagedOrigin = childConfig.publicOrigin;
  const healthBefore = await (await fetch(`${packagedOrigin}/api/health`)).json();
  assert.equal(healthBefore.release.commitSha, '0000000000000000000000000000000000000000');

  const statePath = path.join(temp, 'runner-state.json');
  const runnerPublication = path.join(temp, 'runner-publication.json');
  fs.writeFileSync(runnerPublication, JSON.stringify({releaseId: 'rel-integ-old', commitSha: '0000000000000000000000000000000000000000', configurationId: 'cfg-before'}), {mode: 0o600});
  saveUpdateState(statePath, {jobId: 'job-integ-self-update', targetCommitSha: remote.sha, targetCommitDate: '2026-09-09T00:00:00Z', targetMessage: 'fixture release', repositoryUrl: 'https://fixture.invalid/repository.git', branch: 'main', initialConfigurationId: 'cfg-before', status: 'running', stage: 'accepted', errorCode: null, startedAt: new Date().toISOString(), finishedAt: null});
  const source = path.join(temp, 'source'); fs.mkdirSync(source);
  const releaseModule = path.join(temp, 'fixture-release.mjs'); writeFixtureReleaseModule(releaseModule);
  const contract = path.join(temp, 'fixture-contract.mjs'); writeFixtureContract(contract);
  const paths = {verifyRoot: path.join(temp, 'verify'), publicationPath: runnerPublication, currentLink, fixtureNewRelease: newRelease, fixtureChildApp: childApp, fixtureConfig: childConfigPath, fixturePidFile: pidFile, fixtureOrigin: packagedOrigin, targetCommitSha: remote.sha, infrastructurePath: path.join(temp, 'infrastructure.json')};
  fs.writeFileSync(paths.infrastructurePath, JSON.stringify({version: 2}), {mode: 0o600});
  const invocation = runnerInvocation({runner: path.join(root, 'tools/update-runner.mjs'), statePath, contract, release: releaseModule, source, paths});
  execFileSync(process.execPath, ['--input-type=module', '-e', invocation], {stdio: 'inherit'});
  const finished = readUpdateState(statePath, {checkServiceActive: () => true});
  assert.equal(finished.status, 'completed'); assert.equal(finished.stage, 'success'); assert.equal(finished.jobId, 'job-integ-self-update'); assert.equal(finished.targetCommitSha, remote.sha); assert.equal(finished.expectedReleaseId, 'rel-integ-new'); assert.equal(finished.contentHash, contentHash);
  const healthAfter = await (await fetch(`${packagedOrigin}/api/health`)).json(); const stateAfter = await (await fetch(`${packagedOrigin}/api/state`)).json();
  assert.equal(healthAfter.release.commitSha, remote.sha); assert.equal(healthAfter.release.releaseId, 'rel-integ-new'); assert.equal(stateAfter.release.commitSha, remote.sha);
  app.updateManager.pollJobState();
  await delay(50);
  console.log('PASS: isolated runner stopped/restarted the packaged Analytics app and proved SHA, release hash, job, viewer state, and browser SSE');
  console.log('UPDATE INTEGRATION OK');
}

main().catch(error => { console.error('UPDATE INTEGRATION FAILED:', error.message); process.exitCode = 1; }).finally(async () => {
  if (liveReader) await liveReader.cancel().catch(() => {});
  for (const child of children) await stopChild(child);
  if (app) await app.close().catch(() => {});
  fs.rmSync(temp, {recursive: true, force: true});
});
