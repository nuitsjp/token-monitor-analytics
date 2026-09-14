import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startAnalytics } from '../src/app.js';
import { startMockHub } from '../mock/hub.js';
import { parseHubs } from '../src/config.js';
import { readHubRegistry } from '../src/hub-registry.js';

// UC-2「Hub の収集を停止する」: 画面の停止操作を受ける POST /api/hubs/{id}/stop の系列。
const SECRET = 'stop-hub-secret-never-expose';
const SECOND_SECRET = 'stop-second-secret-never-expose';

async function waitUntil(check) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await check()) return; await delay(20); }
  assert.fail('Expected state was not reached within 5 seconds');
}

// ブラウザ向け SSE を購読し、条件を満たす状態が配信されるまで待つ。
async function sseState(url, predicate) {
  const controller = new AbortController();
  const response = await fetch(`${url}/api/events`, { signal: controller.signal });
  const decoder = new TextDecoder();
  let buffer = '';
  const timer = delay(5000).then(() => assert.fail('SSE で期待した状態が 5 秒以内に配信されなかった'));
  const read = (async () => {
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const data = buffer.slice(0, index).split('\n').find((line) => line.startsWith('data: '));
        buffer = buffer.slice(index + 2);
        if (data && predicate(JSON.parse(data.slice(6)))) return;
      }
    }
  })();
  try { await Promise.race([read, timer]); }
  finally { controller.abort(); }
}

function assertSafeFixtureDirectory(directory) {
  const resolved = resolve(directory);
  assert.equal(dirname(resolved).toLowerCase(), resolve(tmpdir()).toLowerCase());
  assert.equal(basename(resolved).startsWith('token-analytics-stop-'), true);
  return resolved;
}

async function fixture(t) {
  const directory = assertSafeFixtureDirectory(await mkdtemp(join(tmpdir(), 'token-analytics-stop-')));
  const hub = await startMockHub({ port: 0, automatic: false, secret: SECRET });
  const secondHub = await startMockHub({ port: 0, automatic: false, secret: SECOND_SECRET });
  const configuration = {
    mode: 'mock', host: '127.0.0.1', port: 0,
    dbPath: join(directory, 'data', 'analytics.sqlite'),
    registryPath: join(directory, '.local', 'hubs.mock.json'),
    hubs: [],
  };
  const logs = [];
  let app;
  t.after(async () => {
    await Promise.allSettled([app?.stop(), hub.close(), secondHub.close()]);
    await rm(assertSafeFixtureDirectory(directory), { recursive: true, force: true });
  });
  app = await startAnalytics({ configuration, reconnectMs: 30, log: (entry) => logs.push(entry) });
  const f = {
    hub, secondHub, logs,
    get app() { return app; },
    url: () => `http://127.0.0.1:${app.address.port}`,
    view(id) { return app.state().hubs.find((row) => row.id === id); },
    register(id, target, secret) {
      return fetch(`${f.url()}/api/hubs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, url: target.url, secret }),
      });
    },
    stop(id, headers = {}, body = '{}') {
      return fetch(`${f.url()}/api/hubs/${encodeURIComponent(id)}/stop`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body,
      });
    },
    async collecting(id) {
      await waitUntil(() => {
        const row = f.view(id);
        return row?.status.connection === 'connected' && row.devices.length === 2;
      });
    },
    async restart() {
      await app.stop();
      configuration.hubs = parseHubs({ hubs: readHubRegistry(configuration.registryPath) });
      app = await startAnalytics({ configuration, reconnectMs: 30, log: (entry) => logs.push(entry) });
    },
  };
  return f;
}

test('UC-2-M: 停止要求で通信が止まり、収集停止が表示・保存され、他の Hub は収集を続ける', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.register('alpha', f.hub, SECRET)).status, 201);
  assert.equal((await f.register('beta', f.secondHub, SECOND_SECRET)).status, 201);
  await f.collecting('alpha');
  await f.collecting('beta');
  const betaBefore = f.view('beta');

  // 停止前から SSE を購読し、停止後の配信で「収集停止・未接続」が届くことを確認する。
  const delivered = sseState(f.url(), (state) => {
    const alpha = state.hubs.find((row) => row.id === 'alpha');
    return alpha?.collectionEnabled === false && alpha.status.collectionStopped === true && alpha.status.connection === 'disconnected';
  });
  const startedAt = Date.now();
  const response = await f.stop('alpha');
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.id, 'alpha');
  assert.equal(payload.status.collectionStopped, true);
  assert.equal(payload.storage.state, 'normal');
  assert.equal(Object.hasOwn(payload, 'secret'), false);
  assert.equal(Date.now() - startedAt < 10000, true);

  const view = f.view('alpha');
  assert.equal(view.collectionEnabled, false);
  assert.equal(view.status.collectionStopped, true);
  assert.equal(f.app.store.readState().hubs.find((row) => row.id === 'alpha').collectionEnabled, false);
  await delivered;
  assert.equal(f.view('alpha').status.connection, 'disconnected');

  // 停止後は再接続も履歴取得も行わない。
  const requestsAfterStop = f.hub.requests;
  await delay(150);
  assert.equal(f.hub.requests, requestsAfterStop);

  const beta = f.view('beta');
  assert.equal(beta.status.connection, 'connected');
  assert.equal(beta.collectionEnabled, true);
  assert.deepEqual(beta.devices, betaBefore.devices);
  assert.equal(f.logs.some((entry) => entry.operation === 'stop-hub' && entry.hubId === 'alpha'), true);
  assert.equal(JSON.stringify(f.logs).includes(SECRET), false);
  assert.equal((await (await fetch(`${f.url()}/api/state`)).text()).includes(SECRET), false);

  // 既に停止した Hub への停止要求は状態を変えずに完了する。
  const again = await f.stop('alpha');
  assert.equal(again.status, 200);
  assert.equal((await again.json()).status.collectionStopped, true);
});

test('UC-2-M: 再起動後も停止が維持され、その Hub との通信は行わない', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.register('alpha', f.hub, SECRET)).status, 201);
  await f.collecting('alpha');
  assert.equal((await f.stop('alpha')).status, 200);
  await waitUntil(() => f.view('alpha').status.connection === 'disconnected');

  const requestsBeforeRestart = f.hub.requests;
  await f.restart();
  await delay(150);
  const view = f.view('alpha');
  assert.equal(view.collectionEnabled, false);
  assert.equal(view.status.collectionStopped, true);
  assert.equal(view.status.connection, 'disconnected');
  assert.equal(f.hub.requests, requestsBeforeRestart);
});

test('UC-2-X1: 一覧にない Hub への停止要求は 404 で理由を返し、状態を変えない', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.register('alpha', f.hub, SECRET)).status, 201);
  await f.collecting('alpha');

  for (const id of ['gamma', 'alpha%20', '%E0%A4%A']) {
    const response = await fetch(`${f.url()}/api/hubs/${id}/stop`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(response.status, 404, `${id} は404であること`);
    assert.deepEqual(await response.json(), { error: 'hub_not_found' });
  }
  assert.equal(f.view('alpha').collectionEnabled, true);
  assert.equal(f.view('alpha').status.collectionStopped, false);
});

test('停止要求も同一オリジン外と JSON 以外を 403 で拒否し、状態を変えない', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.register('alpha', f.hub, SECRET)).status, 201);
  await f.collecting('alpha');

  const crossOrigin = await f.stop('alpha', { Origin: 'http://attacker.example' });
  assert.equal(crossOrigin.status, 403);
  assert.deepEqual(await crossOrigin.json(), { error: 'origin_mismatch' });

  const formPost = await fetch(`${f.url()}/api/hubs/alpha/stop`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: '{}',
  });
  assert.equal(formPost.status, 403);
  assert.deepEqual(await formPost.json(), { error: 'unsupported_media_type' });

  assert.equal(f.view('alpha').collectionEnabled, true);
  assert.equal(f.view('alpha').status.connection, 'connected');

  const sameOrigin = await f.stop('alpha', { Origin: `http://127.0.0.1:${f.app.address.port}` });
  assert.equal(sameOrigin.status, 200);
  assert.equal(f.view('alpha').collectionEnabled, false);
});
