import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startAnalytics } from '../src/app.js';
import { startMockHub } from '../mock/hub.js';
import { parseHubs } from '../src/config.js';
import { readHubRegistry } from '../src/hub-registry.js';

const SECRET = 'registration-hub-secret-never-expose';
const SECOND_SECRET = 'registration-second-secret-never-expose';

async function waitUntil(check) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await check()) return; await delay(20); }
  assert.fail('Expected state was not reached within 5 seconds');
}

function assertSafeFixtureDirectory(directory) {
  const resolved = resolve(directory);
  assert.equal(dirname(resolved).toLowerCase(), resolve(tmpdir()).toLowerCase());
  assert.equal(basename(resolved).startsWith('token-analytics-hubs-'), true);
  return resolved;
}

async function fixture(t) {
  const directory = assertSafeFixtureDirectory(await mkdtemp(join(tmpdir(), 'token-analytics-hubs-')));
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
  return {
    hub, secondHub, logs, configuration,
    registryPath: configuration.registryPath,
    get app() { return app; },
    url: () => `http://127.0.0.1:${app.address.port}`,
    view(id) { return app.state().hubs.find((hub) => hub.id === id); },
    async restart() {
      // Mockモードの起動時読み込みと同じ経路で復元する。
      await app.stop();
      configuration.hubs = parseHubs({ hubs: readHubRegistry(configuration.registryPath) });
      app = await startAnalytics({ configuration, reconnectMs: 30, log: (entry) => logs.push(entry) });
    },
  };
}

function post(f, body, headers = {}) {
  return fetch(`${f.url()}/api/hubs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function waitForCollection(f, id) {
  await waitUntil(() => {
    const hub = f.view(id);
    return hub?.status.connection === 'connected' && hub.devices.length === 2;
  });
}

test('画面から登録したHubは一覧に現れ、接続設定が保存され、収集が始まる', async (t) => {
  const f = await fixture(t);
  const startedAt = Date.now();
  const response = await post(f, { id: 'alpha', url: f.hub.url, secret: SECRET });
  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.id, 'alpha');
  assert.equal(payload.url, f.hub.url);
  assert.equal(payload.status.configuration, 'valid');
  assert.equal(payload.status.collectionStopped, false);

  await waitForCollection(f, 'alpha');
  assert.equal(Date.now() - startedAt < 10000, true);
  const view = f.view('alpha');
  assert.equal(view.url, f.hub.url);
  assert.equal(view.collectionEnabled, true);
  assert.equal(f.app.state().features.hubManagement, 'implemented');

  const stored = JSON.parse(await readFile(f.registryPath, 'utf8'));
  assert.deepEqual(stored.hubs, [{ id: 'alpha', url: f.hub.url, secret: SECRET }]);
});

test('共有シークレットは応答にもAPIにもログにも出ない', async (t) => {
  const f = await fixture(t);
  const response = await post(f, { id: 'alpha', url: f.hub.url, secret: SECRET });
  assert.equal(response.status, 201);
  assert.equal((await response.text()).includes(SECRET), false);
  await waitForCollection(f, 'alpha');
  assert.equal((await (await fetch(`${f.url()}/api/state`)).text()).includes(SECRET), false);
  assert.equal(JSON.stringify(f.logs).includes(SECRET), false);
  assert.equal(f.logs.some((entry) => entry.operation === 'register-hub' && entry.hubId === 'alpha'), true);
});

test('不正な入力は理由コードを返し、接続設定を保存しない', async (t) => {
  const f = await fixture(t);
  assert.equal((await post(f, { id: 'alpha', url: f.hub.url, secret: SECRET })).status, 201);
  await waitForCollection(f, 'alpha');

  const rejected = [
    [{ id: 'alpha', url: f.secondHub.url, secret: SECOND_SECRET }, 'hub_id_duplicate'],
    [{ id: '   ', url: f.secondHub.url, secret: SECOND_SECRET }, 'hub_id_invalid'],
    [{ id: 42, url: f.secondHub.url, secret: SECOND_SECRET }, 'hub_id_invalid'],
    [{ id: 'beta', url: 'ftp://127.0.0.1:9', secret: SECOND_SECRET }, 'invalid_url'],
    [{ id: 'beta', url: `${f.secondHub.url}/?token=1`, secret: SECOND_SECRET }, 'invalid_url'],
    [{ id: 'beta', url: f.secondHub.url, secret: '' }, 'invalid_secret'],
    [{ id: 'beta', url: f.secondHub.url, secret: 'broken\nsecret' }, 'invalid_secret'],
    ['{"id":', 'invalid_request'],
    [[], 'invalid_request'],
  ];
  for (const [body, error] of rejected) {
    const response = await post(f, body);
    assert.equal(response.status, 400, `${JSON.stringify(body)} は400であること`);
    assert.deepEqual(await response.json(), { error });
  }

  assert.deepEqual(readHubRegistry(f.registryPath).map((hub) => hub.id), ['alpha']);
  assert.deepEqual(f.app.state().hubs.map((hub) => hub.id), ['alpha']);
});

test('同一オリジン外の要求とJSON以外の要求は403で拒否し、保存しない', async (t) => {
  const f = await fixture(t);
  const body = { id: 'alpha', url: f.hub.url, secret: SECRET };

  const crossOrigin = await post(f, body, { Origin: 'http://attacker.example' });
  assert.equal(crossOrigin.status, 403);
  assert.deepEqual(await crossOrigin.json(), { error: 'origin_mismatch' });

  const formPost = await fetch(`${f.url()}/api/hubs`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify(body),
  });
  assert.equal(formPost.status, 403);
  assert.deepEqual(await formPost.json(), { error: 'unsupported_media_type' });

  assert.deepEqual(f.app.state().hubs, []);
  assert.equal(readHubRegistry(f.registryPath).length, 0);

  const sameOrigin = await post(f, body, { Origin: `http://127.0.0.1:${f.app.address.port}` });
  assert.equal(sameOrigin.status, 201);
  const declared = await post(f, { id: 'beta', url: f.secondHub.url, secret: SECOND_SECRET }, {
    Origin: 'http://attacker.example', 'Sec-Fetch-Site': 'same-origin',
  });
  assert.equal(declared.status, 201);
  assert.deepEqual(f.app.state().hubs.map((hub) => hub.id), ['alpha', 'beta']);
});

test('登録は先に登録したHubの収集と表示を止めない', async (t) => {
  const f = await fixture(t);
  assert.equal((await post(f, { id: 'alpha', url: f.hub.url, secret: SECRET })).status, 201);
  await waitForCollection(f, 'alpha');
  const before = f.view('alpha');

  assert.equal((await post(f, { id: 'beta', url: f.secondHub.url, secret: SECOND_SECRET })).status, 201);
  await waitForCollection(f, 'beta');

  const after = f.view('alpha');
  assert.equal(after.status.connection, 'connected');
  assert.deepEqual(after.devices, before.devices);
  assert.equal(after.collectionEnabled, true);
});

test('再起動後も登録したHubは一覧に残り、収集を続ける', async (t) => {
  const f = await fixture(t);
  assert.equal((await post(f, { id: 'alpha', url: f.hub.url, secret: SECRET })).status, 201);
  await waitForCollection(f, 'alpha');

  await f.restart();
  await waitForCollection(f, 'alpha');
  assert.equal(f.view('alpha').url, f.hub.url);
  assert.equal((await (await fetch(`${f.url()}/api/state`)).text()).includes(SECRET), false);
});
