import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {loadConfig} from '../analytics/runtime/config.mjs';
import {startServer} from '../analytics/runtime/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-integration-manage-'));
let app;
let liveReader;
let mock;

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function until(predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch {}
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}

function payload(at) {
  return JSON.stringify({
    type: 'stats',
    at,
    stats: {
      updatedAt: at,
      periods: {
        today: {costUsd: 1},
        month: {costUsd: 2},
        allTime: {costUsd: 3},
      },
      devices: [],
      limits: {providers: []},
    },
  });
}

function createMockHub() {
  let requestCount = 0;
  let eventCount = 0;
  const baseTime = Date.now() - 60000;
  const server = http.createServer((request, response) => {
    if (request.url === '/api/devices') {
      response.writeHead(200, {'Content-Type': 'application/json'});
      response.end(JSON.stringify({devices: [{
        deviceId: 'device-managed', historyAvailable: true, updatedAt: '2026-09-09T00:00:00.000Z',
        history: {daily: [{date: '2026-09-09', tokens: 12, cost: 1.2}], monthly: [{month: '2026-09', tokens: 12, cost: 1.2}]},
      }]}));
      return;
    }
    if (request.url !== '/api/stats/stream') {
      response.writeHead(404).end();
      return;
    }
    requestCount++;
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    const send = () => {
      const at = new Date(baseTime + (++eventCount * 1000)).toISOString();
      response.write(`event: snapshot\ndata: ${payload(at)}\n\n`);
    };
    send();
    const timer = setInterval(send, 100);
    request.on('close', () => clearInterval(timer));
  });
  return {
    server,
    get requestCount() { return requestCount; },
  };
}

async function closeServer(server) {
  if (!server) return;
  await new Promise(resolve => server.close(() => resolve()));
}

class SseQueue {
  constructor(reader) {
    this.reader = reader;
    this.buffer = '';
  }

  async next(timeout = 15000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const end = this.buffer.indexOf('\n\n');
      if (end >= 0) {
        const frame = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        return frame;
      }
      if (Date.now() >= deadline) throw new Error('Timed out waiting for live SSE');
      const remaining = deadline - Date.now();
      let timer;
      const timeout = new Promise(resolve => { timer = setTimeout(() => resolve({timeout: true}), remaining); });
      let read;
      try { read = await Promise.race([this.reader.read(), timeout]); }
      finally { clearTimeout(timer); }
      if (read.timeout) throw new Error('Timed out waiting for live SSE');
      if (read.done) throw new Error('Live SSE ended');
      this.buffer += new TextDecoder().decode(read.value, {stream: true});
    }
  }

  async waitFor(text, timeout = 15000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const frame = await this.next(Math.max(1, deadline - Date.now()));
      if (frame.includes(text)) return frame;
    }
  }
}

async function jsonResponse(url, init) {
  const response = await fetch(url, init);
  const body = await response.json();
  return {response, body};
}

try {
  const hub = createMockHub();
  mock = hub.server;
  const hubOrigin = await listen(mock);
  const appPort = await (async () => {
    const probe = http.createServer();
    const origin = await listen(probe);
    await closeServer(probe);
    return Number(new URL(origin).port);
  })();

  const rawConfig = JSON.parse(fs.readFileSync(path.join(root, 'analytics/configs/demo.json'), 'utf8'));
  rawConfig.demo = false;
  rawConfig.listen.port = appPort;
  rawConfig.publicOrigin = `http://127.0.0.1:${appPort}`;
  rawConfig.databasePath = path.join(temp, 'analytics.db');
  rawConfig.hubSecretsPath = path.join(temp, 'hub-secrets.json');
  rawConfig.management = {enabled: true};
  rawConfig.contracts = [];
  const configPath = path.join(temp, 'analytics.json');
  fs.writeFileSync(configPath, JSON.stringify(rawConfig));
  const config = loadConfig(configPath);

  app = await startServer(config, {
    collectionIdleMs: 5000,
    collectionHeaderTimeoutMs: 3000,
    historyMinIntervalMs: 0,
    logger: {info() {}, error: (...args) => console.error(...args)},
  });
  const origin = config.publicOrigin;
  const live = await fetch(`${origin}/api/live`);
  assert.equal(live.status, 200);
  liveReader = live.body.getReader();
  const liveEvents = new SseQueue(liveReader);
  await liveEvents.waitFor('event: ready');

  let managed = await jsonResponse(`${origin}/api/manage/hubs`);
  assert.equal(managed.response.status, 200);
  assert.deepEqual(managed.body.hubs, []);
  console.log('PASS: v2 SQLite manager starts with no registered Hubs');

  const secret = 'integration-secret-value';
  const added = await jsonResponse(`${origin}/api/manage/hubs`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Origin: origin},
    body: JSON.stringify({id: 'hub-managed', label: 'Managed Hub', url: hubOrigin, secret}),
  });
  assert.equal(added.response.status, 200);
  assert.equal(added.body.hub.version, 1);
  assert.equal(added.body.hub.hasSecret, true);
  assert.equal(Object.hasOwn(added.body.hub, 'secret'), false);
  assert.equal(Object.hasOwn(added.body.hub, 'secretRef'), false);
  assert.equal(JSON.stringify(added.body).includes(secret), false);
  await liveEvents.waitFor('event: manage_updated');
  console.log('PASS: UI management create persists an opaque secret reference and emits SSE');

  await until(async () => {
    managed = (await jsonResponse(`${origin}/api/manage/hubs`)).body;
    return managed.hubs[0]?.connection.state === 'connected';
  }, 'Hub connects after management create');
  const firstRequestCount = hub.requestCount;
  await until(async () => {
    const state = (await jsonResponse(`${origin}/api/state`)).body;
    return state.hubs.length === 1 && state.configuredHubs[0]?.lastObservationAt;
  }, 'first Hub observation');
  assert.equal(firstRequestCount, 1);
  console.log('PASS: created Hub connects and stores observations without a Collector process');

  await until(async () => {
    const result = (await jsonResponse(`${origin}/api/usage-history/hubs`)).body;
    return result.hubs[0]?.devices[0]?.deviceId === 'device-managed';
  }, 'Hub device history is saved');
  const usage = await jsonResponse(`${origin}/api/usage-history?hubId=hub-managed&deviceId=device-managed&granularity=daily&from=2026-09-09&to=2026-09-09`);
  assert.equal(usage.response.status, 200);
  assert.equal(usage.body.rows[0].tokens, 12);
  const manual = await jsonResponse(`${origin}/api/manage/hubs/hub-managed/history`, {
    method: 'POST', headers: {'Content-Type': 'application/json', Origin: origin}, body: '{}'
  });
  assert.equal(manual.response.status, 202);
  console.log('PASS: device history is readable and manual fetch uses the management boundary');

  const renamed = await jsonResponse(`${origin}/api/manage/hubs/hub-managed`, {
    method: 'PUT',
    headers: {'Content-Type': 'application/json', Origin: origin},
    body: JSON.stringify({expectedVersion: 1, label: 'Renamed Hub'}),
  });
  assert.equal(renamed.response.status, 200);
  assert.equal(renamed.body.hub.version, 2);
  await liveEvents.waitFor('event: manage_updated');
  await delay(250);
  assert.equal(hub.requestCount, firstRequestCount);
  console.log('PASS: metadata edit keeps the existing Hub connection generation');

  const disabled = await jsonResponse(`${origin}/api/manage/hubs/hub-managed`, {
    method: 'PUT',
    headers: {'Content-Type': 'application/json', Origin: origin},
    body: JSON.stringify({expectedVersion: 2, status: 'disabled'}),
  });
  assert.equal(disabled.response.status, 200);
  assert.equal(disabled.body.hub.version, 3);
  await liveEvents.waitFor('event: manage_updated');
  await until(async () => {
    managed = (await jsonResponse(`${origin}/api/manage/hubs`)).body;
    return managed.hubs[0]?.connection.state === 'stopped';
  }, 'disabled Hub stops');
  const disabledRequestCount = hub.requestCount;
  console.log('PASS: disable fences the active stream without restarting Analytics');

  const enabled = await jsonResponse(`${origin}/api/manage/hubs/hub-managed`, {
    method: 'PUT',
    headers: {'Content-Type': 'application/json', Origin: origin},
    body: JSON.stringify({expectedVersion: 3, status: 'active'}),
  });
  assert.equal(enabled.response.status, 200);
  assert.equal(enabled.body.hub.version, 4);
  await liveEvents.waitFor('event: manage_updated');
  await until(async () => {
    managed = (await jsonResponse(`${origin}/api/manage/hubs`)).body;
    return managed.hubs[0]?.connection.state === 'connected' && hub.requestCount > disabledRequestCount;
  }, 're-enabled Hub reconnects');
  await until(async () => {
    const state = (await jsonResponse(`${origin}/api/state`)).body;
    return state.hubs[0]?.observedAt;
  }, 're-enabled Hub stores observations');
  console.log('PASS: re-enable reconnects and resumes observations without a process restart');

  const archived = await jsonResponse(`${origin}/api/manage/hubs/hub-managed`, {
    method: 'DELETE',
    headers: {'Content-Type': 'application/json', Origin: origin},
    body: JSON.stringify({expectedVersion: 4}),
  });
  assert.equal(archived.response.status, 200);
  const retained = await jsonResponse(`${origin}/api/usage-history?hubId=hub-managed&deviceId=device-managed&granularity=daily&from=2026-09-09&to=2026-09-09`);
  assert.equal(retained.response.status, 200);
  assert.equal(retained.body.archived, true);
  console.log('PASS: archived Hub history remains readable and is marked historical');

  await liveReader.cancel();
  liveReader = null;
  await app.close();
  app = null;
  await closeServer(mock);
  mock = null;
  console.log('MANAGEMENT INTEGRATION OK');
} finally {
  if (liveReader) await liveReader.cancel().catch(() => {});
  if (app) await app.close().catch(() => {});
  await closeServer(mock);
  fs.rmSync(temp, {recursive: true, force: true});
}
