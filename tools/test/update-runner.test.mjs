import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn, execFileSync} from 'node:child_process';
import {saveRunnerState, readRunnerState} from '../update-runner-state.mjs';
import {acquirePublicationLock} from '../update-runner.mjs';

const SHA_OLD = '1111111111111111111111111111111111111111';
const SHA_NEW = '2222222222222222222222222222222222222222';

function waitForFile(filename, timeoutMs = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (fs.existsSync(filename)) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(`Timed out waiting for ${filename}`));
      setTimeout(poll, 20).unref();
    };
    poll();
  });
}

function fixtureFiles(root) {
  const app = path.join(root, 'fixture-app.mjs');
  fs.writeFileSync(app, `
import fs from 'node:fs';
import http from 'node:http';
const release = JSON.parse(fs.readFileSync(process.env.RELEASE_FILE, 'utf8'));
const pidFile = process.env.PID_FILE;
const server = http.createServer((req, res) => {
  if (req.url === '/api/health') { res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({ok:true, commitSha:release.commitSha, releaseId:release.releaseId})); return; }
  if (req.url === '/api/state') { res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({releaseId:release.releaseId, commitSha:release.commitSha})); return; }
  if (req.url === '/api/live') { res.writeHead(200, {'content-type':'text/event-stream'}); res.write('event: ready\\ndata: {}\\n\\n'); return; }
  res.writeHead(404); res.end();
});
fs.writeFileSync(pidFile, String(process.pid), {mode:0o600});
const stop = () => server.close(() => { fs.rmSync(pidFile, {force:true}); process.exit(0); });
process.on('SIGTERM', stop); process.on('SIGINT', stop);
server.listen(Number(process.env.PORT), '127.0.0.1');
`, {mode: 0o600});
  const releaseModule = path.join(root, 'release.mjs');
  fs.writeFileSync(releaseModule, `
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
export async function preparePublication({root:sourceDirectory, targetCommitSha}) {
  const archivePath=path.join(sourceDirectory,'fixture.tar.gz');
  fs.writeFileSync(archivePath,'verified fixture archive');
  const manifest={releaseId:'rel-fixture-new',targetCommitSha,contentHash:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',runtimeContract:{}};
  return {artifact:{archivePath,archiveSha256:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',checksumPath:archivePath+'.sha256',manifest},manifest,configurationId:'cfg-after'};
}
async function alive(pidFile) { for(let i=0;i<100&&!fs.existsSync(pidFile);i++) await new Promise(r=>setTimeout(r,10)); }
async function gone(pidFile) { for(let i=0;i<100&&fs.existsSync(pidFile);i++) await new Promise(r=>setTimeout(r,10)); }
async function get(url) { const response=await fetch(url); if(!response.ok) throw new Error('fixture request failed'); return response.json(); }
export async function applyPublication(prepared, {targetCommitSha, jobId, paths, onStage}) {
  const {releaseId,contentHash}=prepared.manifest, archiveSha256=prepared.artifact.archiveSha256;
  const pidFile=paths.fixturePidFile; const oldPid=Number(fs.readFileSync(pidFile,'utf8')); process.kill(oldPid,'SIGTERM'); await gone(pidFile);
  onStage('restarting');
  if (paths.fixtureKillAfterStop) process.exit(17);
  fs.mkdirSync(paths.fixtureCurrent,{recursive:true});
  fs.writeFileSync(path.join(paths.fixtureCurrent,'release.json'),JSON.stringify({releaseId,contentHash,archiveSha256,commitSha:targetCommitSha}));
  const child=spawn(process.execPath,[paths.fixtureApp],{env:{...process.env,RELEASE_FILE:path.join(paths.fixtureCurrent,'release.json'),PID_FILE:pidFile,PORT:String(paths.fixturePort)},stdio:'ignore',detached:true}); child.unref();
  await alive(pidFile); await new Promise(r=>setTimeout(r,50));
  const health=await get('http://127.0.0.1:'+paths.fixturePort+'/api/health');
  const state=await get('http://127.0.0.1:'+paths.fixturePort+'/api/state');
  const sse=await fetch('http://127.0.0.1:'+paths.fixturePort+'/api/live'); const reader=sse.body.getReader(); const text=await reader.read(); await reader.cancel();
  return {proof:{jobId,commitSha:health.commitSha,releaseId:health.releaseId,contentHash,archiveSha256,configurationId:'cfg-after',health:paths.fixtureBadProof?false:health.commitSha===targetCommitSha,state:state.commitSha===targetCommitSha,viewer:true,sse:new TextDecoder().decode(text.value).includes('event: ready')}};
}
`);
  const contract = path.join(root, 'runner-contract.mjs');
  fs.writeFileSync(contract, `export const RUNNER_CONTRACT={}; export function validateRunnerContract(){return true;}`);
  return {app, releaseModule, contract};
}

function startApp({app, releaseFile, pidFile, port}) {
  const child = spawn(process.execPath, [app], {env: {...process.env, RELEASE_FILE: releaseFile, PID_FILE: pidFile, PORT: String(port)}, stdio: 'ignore'});
  return child;
}

function runnerScript({runnerPath, statePath, contractPath, releasePath, sourceDir, paths, mode = 'success'}) {
  return `
import fs from 'node:fs';
import path from 'node:path';
import {runUpdate} from ${JSON.stringify(pathToFileURL(runnerPath))};
const paths=${JSON.stringify({...paths, statePath})};
const repositoryOps={prepare:async({workRoot})=>{const snapshotDirectory=path.join(workRoot,'fixture-source');fs.mkdirSync(path.join(snapshotDirectory,'tools'),{recursive:true});fs.copyFileSync(${JSON.stringify(releasePath)},path.join(snapshotDirectory,'tools','publish-ubuntu.mjs'));return {snapshotDirectory,commitDate:'2026-09-09T00:00:00Z',commitMessage:'fixture',branchSha:'${mode === 'moved' ? SHA_OLD : SHA_NEW}'};}};
const preflight=${mode === 'preflight' ? `async()=>{throw Object.assign(new Error('fixed tool missing'),{code:'provision_required'});}` : 'async()=>{ }'};
const result=await runUpdate({paths,contractModulePath:${JSON.stringify(contractPath)},repositoryOps,preflight,enforceInfrastructure:false});
if(result?.errorCode) process.exitCode=2;
`;
}

function pathToFileURL(filename) { return new URL(`file://${filename.split(path.sep).map(encodeURIComponent).join('/')}`).href; }

test('isolated runner stops and restarts the app, proves the target release, and preserves job identity', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-update-runner-'));
  const port = 39000 + Math.floor(Math.random() * 1000);
  const files = fixtureFiles(root);
  const pidFile = path.join(root, 'app.pid');
  const current = path.join(root, 'current');
  const initial = path.join(root, 'initial.json');
  fs.writeFileSync(initial, JSON.stringify({releaseId:'rel-fixture-old', commitSha:SHA_OLD}));
  const app = startApp({app: files.app, releaseFile: initial, pidFile, port});
  const statePath = path.join(root, 'update-state.json');
  const verifyRoot = path.join(root, 'verify');
  const source = path.join(root, 'source'); fs.mkdirSync(source);
  const publication = path.join(root, 'publication.json');
  fs.writeFileSync(publication, JSON.stringify({releaseId:'rel-fixture-old',commitSha:SHA_OLD,configurationId:'cfg-before'}));
  saveRunnerState(statePath, {jobId:'job-fixture-1',targetCommitSha:SHA_NEW,repositoryUrl:'https://fixture.invalid/repo.git',branch:'main',initialConfigurationId:'cfg-before',status:'running',stage:'accepted',startedAt:new Date().toISOString(),finishedAt:null});
  await waitForFile(pidFile);
  try {
    const script = runnerScript({runnerPath:path.resolve(new URL('../update-runner.mjs', import.meta.url).pathname),statePath,contractPath:files.contract,releasePath:files.releaseModule,sourceDir:source,paths:{verifyRoot,publicationPath:publication,fixturePidFile:pidFile,fixtureCurrent:current,fixtureApp:files.app,fixturePort:port},mode:'success'});
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {stdio:'pipe'});
    const finished = readRunnerState(statePath, {checkServiceActive:()=>true});
    assert.equal(finished.status, 'completed');
    assert.equal(finished.stage, 'success');
    assert.equal(finished.jobId, 'job-fixture-1');
    assert.equal(finished.targetCommitSha, SHA_NEW);
    assert.equal(finished.expectedReleaseId, 'rel-fixture-new');
    assert.equal(JSON.parse(fs.readFileSync(path.join(current,'release.json'),'utf8')).commitSha, SHA_NEW);
    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.equal(health.commitSha, SHA_NEW);
  } finally {
    if (fs.existsSync(pidFile)) { try { process.kill(Number(fs.readFileSync(pidFile,'utf8')), 'SIGTERM'); } catch {} }
    app.kill('SIGTERM');
    fs.rmSync(root, {recursive:true,force:true});
  }
});

test('verification preflight fails before the app is stopped', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-update-preflight-'));
  const files = fixtureFiles(root); const pidFile=path.join(root,'app.pid'); const port=40000+Math.floor(Math.random()*500);
  const initial=path.join(root,'initial.json');fs.writeFileSync(initial,JSON.stringify({releaseId:'rel-old',commitSha:SHA_OLD}));
  const app=startApp({app:files.app,releaseFile:initial,pidFile,port}); await waitForFile(pidFile);
  const statePath=path.join(root,'state.json'); const source=path.join(root,'source');fs.mkdirSync(source);
  saveRunnerState(statePath,{jobId:'job-preflight',targetCommitSha:SHA_NEW,repositoryUrl:'https://fixture.invalid/repo.git',branch:'main',status:'running',stage:'accepted',startedAt:new Date().toISOString(),finishedAt:null});
  try {
    const script=runnerScript({runnerPath:path.resolve(new URL('../update-runner.mjs',import.meta.url).pathname),statePath,contractPath:files.contract,releasePath:files.releaseModule,sourceDir:source,paths:{verifyRoot:path.join(root,'verify'),fixturePidFile:pidFile,fixtureCurrent:path.join(root,'current'),fixtureApp:files.app,fixturePort:port},mode:'preflight'});
    assert.throws(()=>execFileSync(process.execPath,['--input-type=module','-e',script],{stdio:'pipe'}));
    const failed=readRunnerState(statePath,{checkServiceActive:()=>true}); assert.equal(failed.errorCode,'provision_required'); assert.ok(fs.existsSync(pidFile));
  } finally { if(fs.existsSync(pidFile)){try{process.kill(Number(fs.readFileSync(pidFile,'utf8')),'SIGTERM')}catch{}} app.kill('SIGTERM'); fs.rmSync(root,{recursive:true,force:true}); }
});

test('a branch move after candidate acceptance fails before the app is stopped', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-update-main-moved-'));
  const files = fixtureFiles(root); const pidFile=path.join(root,'app.pid'); const port=40500+Math.floor(Math.random()*300);
  const initial=path.join(root,'initial.json');fs.writeFileSync(initial,JSON.stringify({releaseId:'rel-old',commitSha:SHA_OLD}));
  const app=startApp({app:files.app,releaseFile:initial,pidFile,port}); await waitForFile(pidFile);
  const statePath=path.join(root,'state.json'); const source=path.join(root,'source');fs.mkdirSync(source);
  saveRunnerState(statePath,{jobId:'job-main-moved',targetCommitSha:SHA_NEW,repositoryUrl:'https://fixture.invalid/repo.git',branch:'main',status:'running',stage:'accepted',startedAt:new Date().toISOString(),finishedAt:null});
  try {
    const script=runnerScript({runnerPath:path.resolve(new URL('../update-runner.mjs',import.meta.url).pathname),statePath,contractPath:files.contract,releasePath:files.releaseModule,sourceDir:source,paths:{verifyRoot:path.join(root,'verify'),fixturePidFile:pidFile,fixtureCurrent:path.join(root,'current'),fixtureApp:files.app,fixturePort:port},mode:'moved'});
    assert.throws(()=>execFileSync(process.execPath,['--input-type=module','-e',script],{stdio:'pipe'}));
    const failed=readRunnerState(statePath,{checkServiceActive:()=>true}); assert.equal(failed.errorCode,'main_moved'); assert.ok(fs.existsSync(pidFile));
  } finally { if(fs.existsSync(pidFile)){try{process.kill(Number(fs.readFileSync(pidFile,'utf8')),'SIGTERM')}catch{}} app.kill('SIGTERM'); fs.rmSync(root,{recursive:true,force:true}); }
});

test('post-restart proof failure is terminal and retains the failed stage', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-update-proof-fail-'));
  const files = fixtureFiles(root); const pidFile=path.join(root,'app.pid'); const port=40800+Math.floor(Math.random()*200);
  const initial=path.join(root,'initial.json');fs.writeFileSync(initial,JSON.stringify({releaseId:'rel-old',commitSha:SHA_OLD}));
  const app=startApp({app:files.app,releaseFile:initial,pidFile,port}); await waitForFile(pidFile);
  const statePath=path.join(root,'state.json'); const source=path.join(root,'source');fs.mkdirSync(source);
  saveRunnerState(statePath,{jobId:'job-proof-fail',targetCommitSha:SHA_NEW,repositoryUrl:'https://fixture.invalid/repo.git',branch:'main',status:'running',stage:'accepted',startedAt:new Date().toISOString(),finishedAt:null});
  try {
    const script=runnerScript({runnerPath:path.resolve(new URL('../update-runner.mjs',import.meta.url).pathname),statePath,contractPath:files.contract,releasePath:files.releaseModule,sourceDir:source,paths:{verifyRoot:path.join(root,'verify'),fixturePidFile:pidFile,fixtureCurrent:path.join(root,'current'),fixtureApp:files.app,fixturePort:port,fixtureBadProof:true},mode:'success'});
    assert.throws(()=>execFileSync(process.execPath,['--input-type=module','-e',script],{stdio:'pipe'}));
    const failed=readRunnerState(statePath,{checkServiceActive:()=>true}); assert.equal(failed.status,'failed'); assert.equal(failed.errorCode,'health_check_failed');
  } finally { if(fs.existsSync(pidFile)){try{process.kill(Number(fs.readFileSync(pidFile,'utf8')),'SIGTERM')}catch{}} app.kill('SIGTERM'); fs.rmSync(root,{recursive:true,force:true}); }
});

test('a runner killed after stopping the app leaves a recoverable running state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-update-kill-'));
  const files = fixtureFiles(root); const pidFile=path.join(root,'app.pid'); const port=41100+Math.floor(Math.random()*200);
  const initial=path.join(root,'initial.json');fs.writeFileSync(initial,JSON.stringify({releaseId:'rel-old',commitSha:SHA_OLD}));
  const app=startApp({app:files.app,releaseFile:initial,pidFile,port}); await waitForFile(pidFile);
  const statePath=path.join(root,'state.json'); const source=path.join(root,'source');fs.mkdirSync(source);
  saveRunnerState(statePath,{jobId:'job-killed',targetCommitSha:SHA_NEW,repositoryUrl:'https://fixture.invalid/repo.git',branch:'main',status:'running',stage:'accepted',startedAt:'2020-01-01T00:00:00.000Z',finishedAt:null});
  try {
    const script=runnerScript({runnerPath:path.resolve(new URL('../update-runner.mjs',import.meta.url).pathname),statePath,contractPath:files.contract,releasePath:files.releaseModule,sourceDir:source,paths:{verifyRoot:path.join(root,'verify'),fixturePidFile:pidFile,fixtureCurrent:path.join(root,'current'),fixtureApp:files.app,fixturePort:port,fixtureKillAfterStop:true},mode:'success'});
    assert.throws(()=>execFileSync(process.execPath,['--input-type=module','-e',script],{stdio:'pipe'}));
    const aborted=readRunnerState(statePath,{checkServiceActive:()=>false,now:()=>new Date('2026-09-09T00:00:00Z').toISOString()}); assert.equal(aborted.status,'aborted'); assert.equal(aborted.errorCode,'job_aborted'); assert.equal(aborted.stage,'aborted');
  } finally { if(fs.existsSync(pidFile)){try{process.kill(Number(fs.readFileSync(pidFile,'utf8')),'SIGTERM')}catch{}} app.kill('SIGTERM'); fs.rmSync(root,{recursive:true,force:true}); }
});

test('the shared lock is owned by the runner process and a competing runner leaves state untouched', async t => {
  if (process.platform !== 'linux') { t.skip('Requires Ubuntu flock'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-update-lock-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const lock = path.join(root, 'deploy.lock');
  const runnerPath = path.resolve(new URL('../update-runner.mjs', import.meta.url).pathname);
  const holderScript = `import {acquirePublicationLock} from ${JSON.stringify(pathToFileURL(runnerPath))}; const release=acquirePublicationLock(${JSON.stringify(lock)}); process.stdout.write('held\\n'); setInterval(() => {}, 1000); await new Promise(() => {}); release();`;
  const holder = spawn(process.execPath, ['--input-type=module', '-e', holderScript], {stdio: ['ignore', 'pipe', 'pipe']});
  await new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.once('error', reject); });
  const competingScript = `import {acquirePublicationLock} from ${JSON.stringify(pathToFileURL(runnerPath))}; try { acquirePublicationLock(${JSON.stringify(lock)}); process.exitCode=2; } catch (error) { if (error.code !== 'lock_conflict') throw error; }`;
  const competing = execFileSync(process.execPath, ['--input-type=module', '-e', competingScript], {stdio: 'pipe'});
  assert.equal(competing.toString(), '');
  holder.kill('SIGKILL');
  await new Promise(resolve => holder.once('exit', resolve));
  assert.doesNotThrow(() => { const release = acquirePublicationLock(lock); release(); });
});

test('runner state reconciliation preserves a replacement job and does not resurrect a removed file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-update-state-race-'));
  const statePath = path.join(root, 'state.json');
  const oldJob = {jobId: 'job-old', targetCommitSha: SHA_OLD, status: 'running', stage: 'deploying', startedAt: '2026-09-09T00:00:00Z', finishedAt: null};
  const newJob = {...oldJob, jobId: 'job-new', targetCommitSha: SHA_NEW, stage: 'accepted', startedAt: '2026-09-09T00:01:00Z'};
  try {
    saveRunnerState(statePath, oldJob);
    const replaced = readRunnerState(statePath, {
      checkServiceActive: () => { saveRunnerState(statePath, newJob); return false; },
      now: () => '2026-09-09T00:02:00Z'
    });
    assert.equal(replaced.jobId, 'job-new');
    assert.equal(readRunnerState(statePath, {checkServiceActive: () => true}).jobId, 'job-new');
    saveRunnerState(statePath, oldJob);
    const missing = readRunnerState(statePath, {
      checkServiceActive: () => { fs.rmSync(statePath); return false; },
      now: () => '2026-09-09T00:02:00Z'
    });
    assert.equal(missing, null);
    assert.equal(fs.existsSync(statePath), false);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});
