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

// UC-3「停止した Hub の収集を再開する」: 画面の再開操作を受ける POST /api/hubs/{id}/resume の系列。
const SECRET = 'resume-hub-secret-never-expose';
const SECOND_SECRET = 'resume-second-secret-never-expose';

async function waitUntil(check) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await check()) return; await delay(20); }
  assert.fail('Expected state was not reached within 5 seconds');
}

function assertSafeFixtureDirectory(directory) {
  const resolved = resolve(directory);
  assert.equal(dirname(resolved).toLowerCase(), resolve(tmpdir()).toLowerCase());
  assert.equal(basename(resolved).startsWith('token-analytics-resume-'), true);
  return resolved;
}

async function fixture(t) {
  const directory = assertSafeFixtureDirectory(await mkdtemp(join(tmpdir(), 'token-analytics-resume-')));
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
    control(id, action, headers = {}) {
      return fetch(`${f.url()}/api/hubs/${encodeURIComponent(id)}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}',
      });
    },
    async collecting(id) {
      await waitUntil(() => {
        const row = f.view(id);
        return row?.status.connection === 'connected' && row.devices.length === 2;
      });
    },
    async stopped(id) {
      await waitUntil(() => f.view(id)?.status.collectionStopped === true && f.view(id).status.connection === 'disconnected');
    },
    async restart() {
      await app.stop();
      configuration.hubs = parseHubs({ hubs: readHubRegistry(configuration.registryPath) });
      app = await startAnalytics({ configuration, reconnectMs: 30, log: (entry) => logs.push(entry) });
    },
  };
  return f;
}

test('UC-3-M: 再開要求で収集設定が保存され、接続と受信が再び始まる', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.register('alpha', f.hub, SECRET)).status, 201);
  assert.equal((await f.register('beta', f.secondHub, SECOND_SECRET)).status, 201);
  await f.collecting('alpha');
  await f.collecting('beta');
  assert.equal((await f.control('alpha', 'stop')).status, 200);
  await f.stopped('alpha');
  const betaBefore = f.view('beta');

  const startedAt = Date.now();
  const response = await f.control('alpha', 'resume');
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.id, 'alpha');
  assert.equal(payload.status.collectionStopped, false);
  assert.equal(payload.storage.state, 'normal');
  assert.equal(Object.hasOwn(payload, 'secret'), false);

  assert.equal(f.view('alpha').collectionEnabled, true);
  assert.equal(f.app.store.readState().hubs.find((row) => row.id === 'alpha').collectionEnabled, true);
  await f.collecting('alpha');
  assert.equal(Date.now() - startedAt < 10000, true);

  const beta = f.view('beta');
  assert.equal(beta.status.connection, 'connected');
  assert.deepEqual(beta.devices, betaBefore.devices);
  assert.equal(f.logs.some((entry) => entry.operation === 'resume-hub' && entry.hubId === 'alpha'), true);
  assert.equal(JSON.stringify(f.logs).includes(SECRET), false);
  assert.equal((await (await fetch(`${f.url()}/api/state`)).text()).includes(SECRET), false);
});

test('UC-3-M: 収集中の Hub への再開要求は収集を二重に始めない', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.register('alpha', f.hub, SECRET)).status, 201);
  await f.collecting('alpha');
  const requestsBefore = f.hub.requests;

  const response = await f.control('alpha', 'resume');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status.collectionStopped, false);
  await delay(200);

  // 収集ループが増えれば Mock Hub への新しい要求が立つ。増えないことを確認する。
  assert.equal(f.hub.requests, requestsBefore);
  assert.equal(f.view('alpha').status.connection, 'connected');
  assert.equal(f.view('alpha').collectionEnabled, true);
});

test('UC-3-M: 再起動後も再開した収集が続く', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.register('alpha', f.hub, SECRET)).status, 201);
  await f.collecting('alpha');
  assert.equal((await f.control('alpha', 'stop')).status, 200);
  await f.stopped('alpha');
  assert.equal((await f.control('alpha', 'resume')).status, 200);
  await f.collecting('alpha');

  await f.restart();
  await f.collecting('alpha');
  assert.equal(f.view('alpha').collectionEnabled, true);
  assert.equal(f.view('alpha').status.collectionStopped, false);
});

test('UC-3-X1: 一覧にない Hub への再開要求は 404 で理由を返し、状態を変えない', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.register('alpha', f.hub, SECRET)).status, 201);
  await f.collecting('alpha');
  assert.equal((await f.control('alpha', 'stop')).status, 200);
  await f.stopped('alpha');

  for (const id of ['gamma', 'alpha%20', '%E0%A4%A']) {
    const response = await fetch(`${f.url()}/api/hubs/${id}/resume`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(response.status, 404, `${id} は404であること`);
    assert.deepEqual(await response.json(), { error: 'hub_not_found' });
  }
  assert.equal(f.view('alpha').collectionEnabled, false);
  assert.equal(f.view('alpha').status.collectionStopped, true);
});

test('再開要求も同一オリジン外と JSON 以外を 403 で拒否し、状態を変えない', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.register('alpha', f.hub, SECRET)).status, 201);
  await f.collecting('alpha');
  assert.equal((await f.control('alpha', 'stop')).status, 200);
  await f.stopped('alpha');

  const crossOrigin = await f.control('alpha', 'resume', { Origin: 'http://attacker.example' });
  assert.equal(crossOrigin.status, 403);
  assert.deepEqual(await crossOrigin.json(), { error: 'origin_mismatch' });

  const formPost = await fetch(`${f.url()}/api/hubs/alpha/resume`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: '{}',
  });
  assert.equal(formPost.status, 403);
  assert.deepEqual(await formPost.json(), { error: 'unsupported_media_type' });

  assert.equal(f.view('alpha').collectionEnabled, false);
  assert.equal(f.view('alpha').status.collectionStopped, true);

  const sameOrigin = await f.control('alpha', 'resume', { Origin: `http://127.0.0.1:${f.app.address.port}` });
  assert.equal(sameOrigin.status, 200);
  assert.equal(f.view('alpha').collectionEnabled, true);
});
