import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {execFileSync, spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {startServer} from '../analytics/runtime/server.mjs';
import {writeAtomicFile} from '../analytics/runtime/hubs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-integration-manage-'));
const children = [];
let app, liveReader;
const token = 'integration-ingest-000000000000000000000000000';
const env = {...process.env, CGO_ENABLED: '0', TMA_INGEST_TOKEN: token};
const suffix = process.platform === 'win32' ? '.exe' : '';

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function until(predicate, label, timeout = 25000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const v = await predicate();
      if (v) return v;
    } catch {}
    await delay(150);
  }
  throw new Error(`Timed out: ${label}`);
}

function child(file, args, name = '') {
  const p = spawn(file, args, {env, stdio: ['ignore', 'pipe', 'pipe']});
  children.push(p);
  p.on('error', error => console.error(`[${name}] error:`, error.message));
  p.stdout.on('data', d => process.stdout.write(`[${name} stdout] ` + d));
  p.stderr.on('data', d => process.stderr.write(`[${name} stderr] ` + d));
  return p;
}

async function stop(p) {
  if (p.exitCode !== null || p.signalCode !== null) return;
  const ended = new Promise(resolve => p.once('exit', resolve));
  p.kill('SIGTERM');
  const timer = setTimeout(() => p.kill('SIGKILL'), 3000);
  timer.unref();
  await ended;
  clearTimeout(timer);
}

async function frame(reader, contains) {
  let text = '';
  const decoder = new TextDecoder();
  const deadline = setTimeout(() => reader.cancel(), 15000);
  try {
    while (!text.includes(contains)) {
      const r = await reader.read();
      if (r.done) throw new Error('SSE ended');
      text += decoder.decode(r.value, {stream: true});
    }
    return text;
  } finally {
    clearTimeout(deadline);
  }
}

try {
  const mock = path.join(temp, 'mockhub' + suffix);
  const collector = path.join(temp, 'collector' + suffix);
  execFileSync('go', ['build', '-o', mock, './cmd/mockhub'], {cwd: path.join(root, 'collector'), env, stdio: 'inherit'});
  execFileSync('go', ['build', '-o', collector, './cmd/collector'], {cwd: path.join(root, 'collector'), env, stdio: 'inherit'});

  const portHub = await freePort();
  const mockHub = child(mock, ['-listen', `127.0.0.1:${portHub}`], 'mock');
  await until(async () => {
    const r = await fetch(`http://127.0.0.1:${portHub}/api/health`);
    return r.ok;
  }, 'mock health');

  // Shared hubs.json and hub-secrets.json with 0 hubs
  const hubsPath = path.join(temp, 'hubs.json');
  const secretsPath = path.join(temp, 'hub-secrets.json');
  writeAtomicFile(secretsPath, JSON.stringify({schemaVersion: 1, secrets: {}}));
  writeAtomicFile(hubsPath, JSON.stringify({schemaVersion: 1, revision: 0, secretsPath: './hub-secrets.json', hubs: []}));

  // Analytics config
  const aConfig = JSON.parse(fs.readFileSync(path.join(root, 'analytics/configs/demo.json'), 'utf8'));
  delete aConfig.hubs;
  aConfig.listen.port = 0;
  aConfig.databasePath = path.join(temp, 'analytics.db');
  aConfig.hubsPath = hubsPath;
  aConfig.management = {enabled: true};
  aConfig.contracts = [];

  app = await startServer(aConfig, {env, logger: {info(){}, error: console.error}});
  aConfig.listen.port = app.server.address().port;
  aConfig.publicOrigin = `http://127.0.0.1:${aConfig.listen.port}`;
  const origin = aConfig.publicOrigin;

  // Collector config
  const spool = path.join(temp, 'outbox');
  const cConfig = {
    version: 1,
    analytics_url: origin,
    ingest_token_env: 'TMA_INGEST_TOKEN',
    spool_dir: spool,
    max_spool_bytes: 268435456,
    flush_seconds: 1,
    batch_size: 2,
    idle_seconds: 90,
    hubs_path: './hubs.json'
  };
  const cFile = path.join(temp, 'collector.json');
  fs.writeFileSync(cFile, JSON.stringify(cConfig));

  // Start Collector with 0 Hubs
  const bridge = child(collector, ['-config', cFile], 'collector');

  // Connect to live SSE feed
  const source = await fetch(origin + '/api/live');
  liveReader = source.body.getReader();
  await frame(liveReader, 'event: ready');

  // Verify initial 0 hubs
  const initManage = await (await fetch(origin + '/api/manage/hubs')).json();
  assert.equal(initManage.revision, 0);
  assert.equal(initManage.hubs.length, 0);
  console.log('PASS: Started with 0 Hubs and management enabled');

  // Register first Hub via Management API
  const addRes = await fetch(origin + '/api/manage/hubs', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'Origin': origin},
    body: JSON.stringify({
      expectedRevision: 0,
      id: 'hub-dynamic-1',
      label: 'Dynamic Hub 1',
      url: `http://127.0.0.1:${portHub}`,
      secret: 'demo-hub-secret'
    })
  });
  assert.equal(addRes.status, 200);
  console.log('PASS: Registered Hub via Management API');

  // Wait for Collector to pick up the file, connect, and send observations
  await frame(liveReader, 'event: updated');
  await until(async () => {
    const s = await (await fetch(origin + '/api/state')).json();
    return s.hubs.length === 1 && s.hubs[0].hubId === 'hub-dynamic-1';
  }, 'observation received from dynamically added Hub');
  console.log('PASS: Collector dynamically loaded hubs.json and collected observations');

  // Wait for Collector status report
  await until(async () => {
    const m = await (await fetch(origin + '/api/manage/hubs')).json();
    return m.collector.status === 'active' &&
           m.collector.appliedRevision >= 1 &&
           m.collector.hubs['hub-dynamic-1']?.status === 'connected';
  }, 'Collector reported applied revision and connected status');
  console.log('PASS: Collector status reporting verified');

  // Disable Hub
  const disRes = await fetch(origin + '/api/manage/hubs/hub-dynamic-1', {
    method: 'PUT',
    headers: {'Content-Type': 'application/json', 'Origin': origin},
    body: JSON.stringify({
      expectedRevision: 1,
      status: 'disabled'
    })
  });
  assert.equal(disRes.status, 200);

  await until(async () => {
    const m = await (await fetch(origin + '/api/manage/hubs')).json();
    return m.collector.appliedRevision >= 2;
  }, 'Collector applied disabled revision');
  console.log('PASS: Collector stopped disabled hub without process restart');

  await liveReader.cancel();
  liveReader = null;
  await stop(bridge);
  await stop(mockHub);
  await app.close();
  app = null;

  console.log('MANAGEMENT INTEGRATION OK');
} finally {
  if (liveReader) await liveReader.cancel().catch(() => {});
  for (const p of children) await stop(p);
  if (app) await app.close().catch(() => {});
  fs.rmSync(temp, {recursive: true, force: true});
}
