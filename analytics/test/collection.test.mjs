import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {MAX_EVENT_BYTES, HTTPError, streamHub, readSSE, isPermanent} from '../runtime/collection/sse.mjs';
import {subscribeLoop} from '../runtime/collection/subscribe.mjs';
import {createCollectionManager} from '../runtime/collection/manager.mjs';
import {compactHubEvent, HubInputError} from '../src/protocol.ts';
import {loadConfig} from '../runtime/config.mjs';
import {startServer} from '../runtime/server.mjs';

const stream = (text, size = 0) => {
  const bytes = Buffer.from(text, 'utf8');
  if (!size) return Readable.toWeb(Readable.from([bytes]));
  const chunks = [];
  for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.subarray(i, i + size));
  return Readable.toWeb(Readable.from(chunks));
};

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

const at = '2026-09-05T00:00:00.000Z';
const payload = extra => JSON.stringify({
  type: 'stats', at,
  stats: {
    updatedAt: at,
    periods: {today: {costUsd: 1}, month: {costUsd: 2}, allTime: {costUsd: 3}, ignored: {costUsd: 99}},
    devices: [{deviceId: 'pc', updatedAt: at, stale: false, periods: {today: {costUsd: 4}, allTime: {costUsd: 5, clientCosts: {claude: 5}}, private: {token: 'secret'}}}],
    limits: {providers: [{provider: 'claude', accountKey: 'account', updatedAt: at, status: 'ok', stale: false, windows: [{kind: 'weekly', usedPercent: 5, resetsAt: '2026-09-12T00:00:00Z'}], accountEmail: 'private@example.com'}]},
    ...extra,
  },
});

test('readSSE handles BOM, UTF-8 chunk splits, line endings, multiline data, comments, and unknown fields', async () => {
  const out = [];
  const input = '\ufeff: heartbeat\r\nevent: snapshot\rdata: {"message":"日本語😀"}\rdata: \r\n\r\nevent: unknown\ndata: ignored\n\nid: 1\nretry: 1000\ndata: ok\n\n';
  await readSSE(stream(input, 1), async event => out.push(event));
  assert.deepEqual(out, [
    {name: 'snapshot', data: '{"message":"日本語😀"}\n'},
    {name: 'unknown', data: 'ignored'},
    {name: 'message', data: 'ok'},
  ]);
});

test('readSSE drops incomplete EOF frames and heartbeat-only frames', async () => {
  const out = [];
  await readSSE(stream(': hb\n\n event: stats\ndata: incomplete\n'), async event => out.push(event));
  assert.deepEqual(out, []);
});

test('readSSE applies the 8 MiB limit in UTF-8 bytes', async () => {
  await assert.rejects(() => readSSE(stream(`data: ${'😀'.repeat(Math.ceil(MAX_EVENT_BYTES / 4))}\n\n`), async () => {}), /SSE event exceeds/);
});

test('compactHubEvent mirrors Go normalization and strips private fields', () => {
  const observation = compactHubEvent({name: 'snapshot', data: payload()}, 'hub-a', 'a'.repeat(32), Date.parse(at));
  assert.deepEqual(observation.stats.periods, {today: {costUsd: 1}, month: {costUsd: 2}, allTime: {costUsd: 3}});
  assert.deepEqual(Object.keys(observation.stats.devices[0].periods), ['allTime']);
  assert.equal(JSON.stringify(observation).includes('private'), false);
  assert.equal(observation.observedAt, at);
  assert.equal(observation.eventId, undefined);
});

test('compactHubEvent applies the size limit after dropping unknown period fields', () => {
  const data = payload({periods: {today: {costUsd: 1, debug: 'x'.repeat(140 * 1024)}, month: {costUsd: 2}, allTime: {costUsd: 3}}});
  const observation = compactHubEvent({name: 'snapshot', data}, 'hub-a', 'a'.repeat(32), Date.parse(at));
  assert.equal(observation.stats.periods.today.costUsd, 1);
  assert.equal(JSON.stringify(observation).includes('debug'), false);
});

test('compactHubEvent rejects malformed upstream input as a permanent Hub error', () => {
  assert.throws(() => compactHubEvent({name: 'stats', data: '{bad'}, 'h', 'a'.repeat(32), Date.parse(at)), error => error instanceof HubInputError && error.code === 'input_error');
  assert.equal(isPermanent(new HTTPError(401)), true);
  assert.equal(isPermanent(new HTTPError(429)), false);
});

test('streamHub authenticates, accepts event-stream, and refuses redirects', async () => {
  let received;
  const server = http.createServer((req, res) => {
    received = req.headers.authorization;
    res.writeHead(200, {'Content-Type': 'text/event-stream; charset=utf-8'});
    res.end('event: snapshot\ndata: x\n\n');
  });
  const base = await listen(server);
  try {
    const events = [];
    await streamHub({url: base, secret: 'hub-secret', idleMs: 1000, onEvent: async event => events.push(event)});
    assert.equal(received, 'Bearer hub-secret');
    assert.deepEqual(events, [{name: 'snapshot', data: 'x'}]);
  } finally { server.close(); }

  let redirected = false;
  const target = http.createServer((_req, res) => { redirected = true; res.end(); });
  const targetBase = await listen(target);
  const redirector = http.createServer((_req, res) => { res.writeHead(302, {Location: `${targetBase}/api/stats/stream`}); res.end(); });
  const redirectBase = await listen(redirector);
  try { await assert.rejects(() => streamHub({url: redirectBase, secret: 'hub-secret', idleMs: 1000})); assert.equal(redirected, false); }
  finally { redirector.close(); target.close(); }
});

test('streamHub aborts a quiet stream and applies header timeout', async () => {
  const quiet = http.createServer((_req, res) => {
    res.writeHead(200, {'Content-Type': 'text/event-stream'});
    res.write(': heartbeat\n\n');
  });
  const quietBase = await listen(quiet);
  try { await assert.rejects(() => streamHub({url: quietBase, secret: 'hub-secret', idleMs: 40}), /idle timeout/); }
  finally { quiet.close(); }

  const controller = new AbortController();
  let aborted = false;
  await assert.rejects(() => streamHub({url: 'http://127.0.0.1:1', secret: 'hub-secret', signal: controller.signal, headerTimeoutMs: 20, fetchImpl: (_url, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)))}), error => {
    aborted = true;
    return error.code === 'network_error';
  });
  assert.equal(aborted, true);
});

test('subscribeLoop stops on permanent input/auth errors and backs off transiently', async () => {
  const statuses = [];
  let calls = 0;
  const controller = new AbortController();
  const loop = subscribeLoop({
    hub: {id: 'hub-a', url: 'http://127.0.0.1:1', secret: 'secret'}, signal: controller.signal,
    fetchImpl: async () => { calls++; return new Response(null, {status: calls === 1 ? 401 : 500}); },
    jitterFn: () => 1, onStatus: status => statuses.push(status),
  });
  await loop;
  assert.equal(calls, 1);
  assert.deepEqual(statuses.at(-1), {hubId: 'hub-a', state: 'error', errorCode: 'auth_error'});
});

test('collection manager isolates Hubs and replaces old generations after they finish', async () => {
  const observations = [];
  const waitForObservations = async expected => {
    const deadline = Date.now() + 5000;
    while (observations.length < expected && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(observations.length, expected);
  };
  const servers = [];
  const makeHub = value => http.createServer((_req, res) => {
    res.writeHead(200, {'Content-Type': 'text/event-stream'});
    res.end(`event: stats\ndata: ${JSON.stringify({value})}\n\n`);
  });
  const serverA = makeHub('a'), serverB = makeHub('b'); servers.push(serverA, serverB);
  const urlA = await listen(serverA), urlB = await listen(serverB);
  const manager = createCollectionManager({idleMs: 1000, onObservation: async observation => { observations.push(observation); }});
  try {
    await manager.applyHubs([{id: 'a', url: urlA, secret: 's', status: 'active'}, {id: 'b', url: urlB, secret: 's', status: 'disabled'}]);
    await waitForObservations(1);
    assert.equal(observations[0].hubId, 'a');
    await manager.applyHubs([{id: 'a', url: urlA, secret: 's', status: 'disabled'}, {id: 'b', url: urlB, secret: 's', status: 'active'}]);
    await waitForObservations(2);
    assert.equal(observations[1].hubId, 'b');
    assert.equal(manager.getStatus().some(status => status.hubId === 'a'), false);
  } finally { await manager.stop(); for (const server of servers) server.close(); }
});

test('collection manager serializes reconnect behind configuration removal', async () => {
  let first = true;
  let markObservation;
  const observationStarted = new Promise(resolve => { markObservation = resolve; });
  let releaseObservation;
  const observationGate = new Promise(resolve => { releaseObservation = resolve; });
  const manager = createCollectionManager({
    fetchImpl: async () => {
      if (!first) return new Response(null, {status: 500});
      first = false;
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(['event: stats', 'data: x', '', ''].join(String.fromCharCode(10)))); },
      }), {status: 200, headers: {'Content-Type': 'text/event-stream'}});
    },
    onObservation: async () => { markObservation(); await observationGate; },
    jitterFn: () => 0,
  });
  try {
    await manager.applyHubs([{id: 'a', url: 'http://127.0.0.1:1', secret: 's', status: 'active'}]);
    await observationStarted;
    const reconnect = manager.reconnectHub('a');
    const removal = manager.applyHubs([]);
    releaseObservation();
    await Promise.all([reconnect, removal]);
    assert.deepEqual(manager.getStatus(), []);
  } finally { await manager.stop(); }
});

test('collection manager fences a newer commit while an older reconciliation waits for retirement', async () => {
  const oldUrl = 'http://127.0.0.1:10001';
  const newUrl = 'http://127.0.0.1:10002';
  const calls = [];
  let first = true;
  let markObservation;
  const observationStarted = new Promise(resolve => { markObservation = resolve; });
  let releaseObservation;
  const observationGate = new Promise(resolve => { releaseObservation = resolve; });
  const event = new TextEncoder().encode('event: snapshot\ndata: {}\n\n');
  const manager = createCollectionManager({
    fetchImpl: async (url) => {
      calls.push(url);
      if (first) {
        first = false;
        return new Response(new ReadableStream({start(controller) { controller.enqueue(event); controller.close(); }}), {
          status: 200, headers: {'Content-Type': 'text/event-stream'},
        });
      }
      return new Response(null, {status: 500});
    },
    onObservation: async () => { markObservation(); await observationGate; },
    jitterFn: () => 0,
  });
  try {
    await manager.applyHubs([{id: 'h', url: oldUrl, secret: 's1', status: 'active'}]);
    await observationStarted;
    const staleApply = manager.applyHubs([{id: 'h', url: oldUrl, secret: 's2', status: 'active'}]);
    const deadline = Date.now() + 1000;
    while (manager.getStatus().length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
    assert.deepEqual(manager.getStatus(), []);
    // The first reconciliation has already removed the runner.  The second
    // commit must still invalidate its pending start through the token.
    assert.equal(manager.invalidateHub('h'), false);
    const currentApply = manager.applyHubs([{id: 'h', url: newUrl, secret: 's3', status: 'active'}]);
    releaseObservation();
    await Promise.all([staleApply, currentApply]);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(calls.filter(url => url.startsWith(oldUrl + '/')).length, 1);
    assert.ok(calls.some(url => url.startsWith(newUrl + '/')));
  } finally {
    await manager.stop();
  }
});

test('startServer stores Node-collected observations only after the SQLite commit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-collection-server-'));
  const hub = http.createServer((_req, res) => {
    res.writeHead(200, {'Content-Type': 'text/event-stream'});
    res.end(`event: snapshot\ndata: ${payload()}\n\n`);
  });
  const hubUrl = await listen(hub);
  const configRaw = JSON.parse(fs.readFileSync(new URL('../configs/demo.json', import.meta.url), 'utf8'));
  Object.assign(configRaw, {demo: false, databasePath: path.join(dir, 'analytics.db'), contracts: []});
  const configFile = path.join(dir, 'analytics.json');
  fs.writeFileSync(configFile, JSON.stringify(configRaw));
  const config = loadConfig(configFile); config.listen.port = 0;
  const app = await startServer(config, {
    env: {TMA_INGEST_TOKEN: 'server-ingest-token-000000000000000000000000000000'},
    logger: {info() {}, error() {}}, collectionIdleMs: 1000,
    collectionHubs: [{id: 'hub-a', url: hubUrl, secret: 'hub-secret', status: 'active'}],
  });
  try {
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 1000;
      const check = () => {
        try {
          if (app.db.sql.prepare('SELECT count(*) n FROM observations').get().n > 0) { resolve(); return; }
          if (Date.now() >= deadline) { reject(new Error('Node collection did not persist an observation')); return; }
          setTimeout(check, 10).unref();
        } catch (error) { reject(error); }
      };
      check();
    });
  } finally {
    await app.close(); hub.close(); fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('startServer closes and marks the process failed after a storage error', async () => {
  const previousExitCode = process.exitCode;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-collection-fatal-'));
  let sendEvent = null;
  const hub = http.createServer((_req, res) => {
    res.writeHead(200, {'Content-Type': 'text/event-stream'});
    sendEvent = () => res.end(['event: snapshot', `data: ${payload()}`, '', ''].join(String.fromCharCode(10)));
  });
  const hubUrl = await listen(hub);
  const configRaw = JSON.parse(fs.readFileSync(new URL('../configs/demo.json', import.meta.url), 'utf8'));
  Object.assign(configRaw, {demo: false, databasePath: path.join(dir, 'analytics.db'), contracts: []});
  const configFile = path.join(dir, 'analytics.json');
  fs.writeFileSync(configFile, JSON.stringify(configRaw));
  const config = loadConfig(configFile); config.listen.port = 0;
  const app = await startServer(config, {
    env: {TMA_INGEST_TOKEN: 'server-ingest-token-000000000000000000000000000000'},
    logger: {info() {}, error() {}}, collectionIdleMs: 1000,
    collectionHubs: [{id: 'hub-a', url: hubUrl, secret: 'hub-secret', status: 'active'}],
  });
  try {
    const deadline = Date.now() + 1000;
    while (!sendEvent && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(typeof sendEvent, 'function');
    app.db.transaction = () => { throw new Error('injected storage failure'); };
    sendEvent();
    while ((app.server.listening || process.exitCode !== 1) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(app.server.listening, false);
    assert.equal(process.exitCode, 1);
  } finally {
    await app.close(); hub.close(); fs.rmSync(dir, {recursive: true, force: true});
    process.exitCode = previousExitCode;
  }
});
