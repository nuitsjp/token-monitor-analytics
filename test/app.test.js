import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { startAnalytics } from '../src/app.js';
import { makeSnapshot, startMockHub } from '../mock/hub.js';
import { readEvents } from '../src/sse.js';

const T0 = '2026-09-13T00:00:00.000Z';
const T1 = '2026-09-13T00:01:00.000Z';
const T2 = '2026-09-13T00:02:00.000Z';
const T3 = '2026-09-13T00:03:00.000Z';
const T4 = '2026-09-13T00:04:00.000Z';
const T5 = '2026-09-13T00:05:00.000Z';
const T6 = '2026-09-13T00:06:00.000Z';
const T7 = '2026-09-13T00:07:00.000Z';

async function waitUntil(check) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await check()) return; await delay(20); }
  assert.fail('Expected state was not reached within 5 seconds');
}

function assertSafeFixtureDirectory(directory) {
  const resolved = resolve(directory);
  const tempRoot = resolve(tmpdir());
  assert.equal(dirname(resolved).toLowerCase(), tempRoot.toLowerCase());
  assert.equal(basename(resolved).startsWith('token-analytics-app-'), true);
  return resolved;
}

async function fixture(t, { twoHubs = false, initialSnapshot, reconnectMs = 30 } = {}) {
  const directory = assertSafeFixtureDirectory(await mkdtemp(join(tmpdir(), 'token-analytics-app-')));
  const secret = 'test-hub-secret-never-expose';
  const hub = await startMockHub({ port: 0, automatic: false, secret });
  const configuration = {
    host: '127.0.0.1', port: 0, dbPath: join(directory, 'data', 'analytics.sqlite'),
    hubs: (twoHubs ? ['alpha', 'beta'] : ['alpha']).map((id) => ({ id, url: hub.url, secret, configError: null })),
  };
  const logs = [];
  let app;
  if (initialSnapshot) hub.broadcast(initialSnapshot);
  t.after(async () => {
    await Promise.allSettled([app?.stop(), hub.close()]);
    await rm(assertSafeFixtureDirectory(directory), { recursive: true, force: true });
  });
  app = await startAnalytics({ configuration, reconnectMs, log: (entry) => logs.push(entry) });
  await waitUntil(() => app.state().hubs.every((item) => item.devices.length === 2));
  return {
    hub, secret, logs, configuration,
    get app() { return app; },
    url: () => `http://127.0.0.1:${app.address.port}`,
    async restart() { await app.stop(); app = await startAnalytics({ configuration, reconnectMs, log: (entry) => logs.push(entry) }); },
  };
}

async function dualFixture(t, { configurationSecrets = {}, reconnectMs = 30 } = {}) {
  const directory = assertSafeFixtureDirectory(await mkdtemp(join(tmpdir(), 'token-analytics-app-')));
  const definitions = [
    { id: 'private', value: 2, secret: 'private-hub-secret-never-expose' },
    { id: 'work', value: 4, secret: 'work-hub-secret-never-expose' },
  ];
  const runningHubs = await Promise.all(definitions.map(({ secret }) => (
    startMockHub({ port: 0, automatic: false, secret })
  )));
  const mockHubs = new Map(definitions.map(({ id }, index) => [id, runningHubs[index]]));
  for (const [index, definition] of definitions.entries()) {
    mockHubs.get(definition.id).broadcast(makeSnapshot({
      value: definition.value,
      updatedAt: `2026-09-13T00:0${index}:00.000Z`,
    }));
  }
  const configuredSecrets = Object.fromEntries(definitions.map(({ id, secret }) => [
    id,
    configurationSecrets[id] ?? secret,
  ]));
  const configuration = {
    host: '127.0.0.1',
    port: 0,
    dbPath: join(directory, 'data', 'analytics.sqlite'),
    hubs: definitions.map(({ id }) => ({
      id,
      url: mockHubs.get(id).url,
      secret: configuredSecrets[id],
      configError: null,
    })),
  };
  const logs = [];
  let app;
  t.after(async () => {
    await Promise.allSettled([app?.stop(), ...runningHubs.map((hub) => hub.close())]);
    await rm(assertSafeFixtureDirectory(directory), { recursive: true, force: true });
  });
  app = await startAnalytics({ configuration, reconnectMs, log: (entry) => logs.push(entry) });
  const allSecrets = [
    ...definitions.map(({ secret }) => secret),
    ...Object.values(configuredSecrets),
  ];
  return {
    mockHubs, allSecrets, logs, configuration,
    get app() { return app; },
    state(id) { return app.state().hubs.find((hub) => hub.id === id); },
    cost(id) { return app.state().hubs.find((hub) => hub.id === id).devices[0].observation.periods.today.costUsd; },
    url: () => `http://127.0.0.1:${app.address.port}`,
  };
}

async function assertNoSecretsInApiOrLogs(f) {
  const api = await (await fetch(`${f.url()}/api/state`)).text();
  const logs = JSON.stringify(f.logs);
  for (const secret of f.allSecrets) {
    assert.equal(api.includes(secret), false);
    assert.equal(logs.includes(secret), false);
  }
}

async function waitForDualInitialState(f) {
  await waitUntil(() => ['private', 'work'].every((id) => f.state(id).devices.length === 2));
}

const cost = (app, index = 0) => app.state().hubs[index].devices[0].observation.periods.today.costUsd;
const ESTIMATION_RESET_AT = '2099-01-01T00:00:00.000Z';
const fixedSnapshot = (value, updatedAt) => makeSnapshot({
  value,
  updatedAt,
  resetsAt: { session: ESTIMATION_RESET_AT, weekly: ESTIMATION_RESET_AT },
});

async function waitForEstimates(f, check) {
  await waitUntil(() => f.app.state().estimates.length > 0
    && f.app.state().estimates.every(check));
}

async function assertFreshBaseline(f, baselineValue, baselineAt, nextValue, nextAt) {
  f.hub.broadcast(fixedSnapshot(baselineValue, baselineAt));
  await waitForEstimates(f, (view) => view.status === 'collecting' && view.reason === 'collecting');
  f.hub.broadcast(fixedSnapshot(nextValue, nextAt));
  await waitForEstimates(f, (view) => (
    view.status === 'estimated'
    && view.lastResult?.evidence?.baseline?.cost === baselineValue * 48
  ));
  for (const view of f.app.state().estimates) {
    const expectedRate = view.windowKind === 'session' ? baselineValue * 8 : baselineValue * 4;
    assert.equal(view.lastResult.evidence.baseline.accounts[0].usedPercent, expectedRate);
  }
}

test('normal collection renders saved state; one invalid device rejects the complete notification and then recovers', async (t) => {
  const f = await fixture(t);
  const before = structuredClone(f.app.state().hubs[0]);
  const invalid = makeSnapshot({ value: 9 });
  invalid.stats.devices[1].periods.today.costUsd = f.secret;
  f.hub.broadcast(invalid);
  await waitUntil(() => f.app.state().hubs[0].status.validationError !== null);
  assert.equal(cost(f.app), before.devices[0].observation.periods.today.costUsd);
  assert.equal(f.app.state().hubs[0].receivedAt, before.receivedAt);
  assert.ok(!JSON.stringify(f.logs).includes(f.secret));
  const api = await (await fetch(`${f.url()}/api/state`)).text();
  assert.ok(!api.includes(f.secret));
  f.hub.broadcast(makeSnapshot({ value: 9 }));
  await waitUntil(() => cost(f.app) === 9);
  assert.equal(f.app.state().hubs[0].status.validationError, null);
  assert.match(await (await fetch(f.url())).text(), /Token Monitor Analytics/);
  assert.equal((await fetch(`${f.url()}/api/state`, { method: 'POST' })).status, 405);
});

test('shared storage failure stops all hubs while keeping values and timestamps; restart restores collection', async (t) => {
  const f = await fixture(t, { twoHubs: true });
  const before = structuredClone(f.app.state());
  f.app.store.commitNotification = () => { throw Object.assign(new Error('injected write failure'), { code: 'SQLITE_IOERR' }); };
  f.hub.broadcast(makeSnapshot({ value: 7 }));
  await waitUntil(() => f.app.state().storage.state === 'failed');
  f.hub.broadcast(makeSnapshot({ value: 8 }));
  await delay(60);
  for (const [index, hub] of f.app.state().hubs.entries()) {
    assert.equal(hub.receivedAt, before.hubs[index].receivedAt);
    assert.deepEqual(hub.devices, before.hubs[index].devices);
    assert.equal(hub.status.connection, 'connected');
  }
  await f.restart();
  await waitUntil(() => f.app.state().hubs.every((hub) => hub.devices[0]?.observation.periods.today.costUsd === 8));
  assert.equal(f.app.state().storage.state, 'normal');
});

test('a post-commit read failure preserves the commit and old display until restart', async (t) => {
  const f = await fixture(t);
  const before = structuredClone(f.app.state().hubs[0]);
  const readSaved = f.app.store.readState.bind(f.app.store);
  f.app.store.readState = () => { throw Object.assign(new Error('injected read failure'), { code: 'SQLITE_IOERR' }); };
  f.hub.broadcast(makeSnapshot({ value: 12 }));
  await waitUntil(() => f.app.state().storage.state === 'unreadable');
  assert.deepEqual(f.app.state().hubs[0].devices, before.devices);
  assert.equal(f.app.state().hubs[0].receivedAt, before.receivedAt);
  assert.equal(readSaved().hubs[0].devices[0].observation.periods.today.costUsd, 12);
  assert.equal((await fetch(`${f.url()}/api/history`)).status, 503);
  await f.restart();
  await waitUntil(() => cost(f.app) === 12);
});

test('browser notification absence never stops saving; reconnect begins with the complete latest state', async (t) => {
  const f = await fixture(t);
  const first = await fetch(`${f.url()}/api/events`);
  const frames = readEvents(first.body);
  assert.equal((await frames.next()).value.event, 'status');
  await frames.return();
  f.hub.broadcast(makeSnapshot({ value: 15 }));
  await waitUntil(() => cost(f.app) === 15);
  assert.equal(f.app.state().storage.state, 'normal');
  const reconnected = readEvents((await fetch(`${f.url()}/api/events`)).body);
  const state = JSON.parse((await reconnected.next()).value.data);
  assert.equal(state.hubs[0].devices[0].observation.periods.today.costUsd, 15);
  await reconnected.return();
});

test('Hub reconnection receives a snapshot without duplicating observations', async (t) => {
  const f = await fixture(t);
  const ids = f.app.state().hubs[0].devices.map((device) => device.observationId);
  const received = f.app.state().hubs[0].receivedAt;
  f.hub.disconnect();
  await waitUntil(() => f.hub.requests >= 2 && f.app.state().hubs[0].receivedAt !== received);
  assert.deepEqual(f.app.state().hubs[0].devices.map((device) => device.observationId), ids);
});

test('browser SSE delivers a full state larger than the socket buffer and continues updating', async (t) => {
  const f = await fixture(t);
  const large = makeSnapshot({ value: 16 });
  large.stats.devices[0].hostname = 'large-state-'.repeat(100000);
  f.hub.broadcast(large);
  await waitUntil(() => cost(f.app) === 16);
  const frames = readEvents((await fetch(`${f.url()}/api/events`)).body);
  const initial = JSON.parse((await frames.next()).value.data);
  assert.equal(initial.hubs[0].devices[0].metadata.hostname, large.stats.devices[0].hostname);
  f.hub.broadcast(makeSnapshot({ value: 17 }));
  let updated;
  do { updated = JSON.parse((await frames.next()).value.data); }
  while (updated.hubs[0].devices[0].observation.periods.today.costUsd !== 17);
  assert.equal(f.app.state().storage.state, 'normal');
  await frames.return();
});

test('shutdown cancels reconnection waiting promptly', async (t) => {
  const f = await fixture(t);
  await f.hub.close();
  await waitUntil(() => f.app.state().hubs[0].status.connection === 'disconnected');
  const started = Date.now();
  await f.app.stop();
  assert.ok(Date.now() - started < 1000);
});

test('a listen failure prevents any Hub connection', async (t) => {
  const directory = assertSafeFixtureDirectory(await mkdtemp(join(tmpdir(), 'token-analytics-app-')));
  const busy = createServer((request, response) => response.end());
  await new Promise((resolve) => busy.listen(0, '127.0.0.1', resolve));
  const mock = await startMockHub({ port: 0, automatic: false });
  t.after(async () => {
    await mock.close();
    await new Promise((resolve) => busy.close(resolve));
    await rm(assertSafeFixtureDirectory(directory), { recursive: true, force: true });
  });
  await assert.rejects(startAnalytics({ configuration: { host: '127.0.0.1', port: busy.address().port, dbPath: join(directory, 'analytics.sqlite'), hubs: [{ id: 'one', url: mock.url, secret: 'mock-secret', configError: null }] } }), { code: 'EADDRINUSE' });
  assert.equal(mock.requests, 0);
});

test('two SSE observations produce an estimate and a history response with the correct current value', async (t) => {
  const f = await fixture(t, { initialSnapshot: fixedSnapshot(2, T0) });
  await waitForEstimates(f, (view) => view.status === 'collecting');
  f.hub.broadcast(fixedSnapshot(3, T1));
  await waitForEstimates(f, (view) => view.status === 'estimated');

  const current = f.app.state().hubs[0];
  assert.equal(current.devices[0].observation.periods.today.costUsd, 3);
  assert.equal(current.devices[0].observation.periods.allTime.clientCosts.codex, 72);
  assert.equal(f.app.state().estimates.length, 2);
  assert.equal(f.app.state().features.estimation, 'implemented');
  assert.equal(f.app.state().features.estimationHistory, 'implemented');

  const response = await fetch(`${f.url()}/api/estimates/history?hubId=alpha&limit=10`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.items.length, 4);
  assert.equal(body.items.some((item) => item.status === 'estimated'), true);
  assert.equal(body.nextCursor, null);
  assert.equal(JSON.stringify(body).includes(f.secret), false);
  assert.equal(f.app.state().features.history, 'implemented');
  await f.app.fetchHistory('alpha', 'test');
  const historyResponse = await fetch(`${f.url()}/api/history?hubId=alpha&tool=codex`);
  assert.equal(historyResponse.status, 200);
  const historyBody = await historyResponse.json();
  assert.equal(historyBody.kind, 'daily');
  assert.ok(historyBody.items.length > 0);
  const localToday = (() => {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return now.getFullYear() + '-' + month + '-' + day;
  })();
  for (const item of historyBody.items) {
    assert.equal(item.hubId, 'alpha');
    assert.equal(item.tool, 'codex');
    assert.ok(item.date < localToday);
  }
});

test('a limits-only refresh does not estimate and history filters, pages, validates, and supports HEAD', async (t) => {
  const f = await fixture(t, { initialSnapshot: fixedSnapshot(2, T0) });
  await waitForEstimates(f, (view) => view.status === 'collecting');

  const limitsOnly = fixedSnapshot(2, T1);
  for (const device of limitsOnly.stats.devices) {
    device.updatedAt = T0;
    device.clientHealth.observedAt = T0;
    for (const provider of device.limits.providers) {
      provider.updatedAt = T1;
      for (const window of provider.windows) window.usedPercent += 1;
    }
  }
  f.hub.broadcast(limitsOnly);
  await waitForEstimates(f, (view) => view.status === 'collecting' && view.reason === 'awaiting_refresh');
  assert.equal(f.app.state().estimates.some((view) => view.status === 'estimated'), false);

  f.hub.broadcast(fixedSnapshot(3, T2));
  await waitForEstimates(f, (view) => view.status === 'estimated');
  f.hub.broadcast(fixedSnapshot(4, T3));
  await waitForEstimates(f, (view) => view.status === 'estimated');

  const firstPageResponse = await fetch(`${f.url()}/api/estimates/history?hubId=alpha&limit=1`);
  assert.equal(firstPageResponse.status, 200);
  const firstPage = await firstPageResponse.json();
  assert.equal(firstPage.items.length, 1);
  assert.equal(typeof firstPage.nextCursor, 'number');

  const seriesId = firstPage.items[0].seriesId;
  const seriesQuery = encodeURIComponent(seriesId);
  const filteredResponse = await fetch(
    `${f.url()}/api/estimates/history?hubId=alpha&seriesId=${seriesQuery}&limit=1`
  );
  assert.equal(filteredResponse.status, 200);
  const filtered = await filteredResponse.json();
  assert.equal(filtered.items.length, 1);
  assert.equal(filtered.items[0].seriesId, seriesId);
  assert.equal(typeof filtered.nextCursor, 'number');

  const nextFilteredResponse = await fetch(
    `${f.url()}/api/estimates/history?hubId=alpha&seriesId=${seriesQuery}&before=${filtered.nextCursor}&limit=1`
  );
  const nextFiltered = await nextFilteredResponse.json();
  assert.equal(nextFilteredResponse.status, 200);
  assert.equal(nextFiltered.items.length, 1);
  assert.equal(nextFiltered.items[0].seriesId, seriesId);
  assert.ok(nextFiltered.items[0].id < filtered.items[0].id);
  assert.equal(JSON.stringify(nextFiltered).includes(f.secret), false);

  const head = await fetch(`${f.url()}/api/estimates/history?hubId=alpha&limit=1`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await fetch(`${f.url()}/api/estimates/history?limit=0`)).status, 400);
  assert.equal((await fetch(`${f.url()}/api/estimates/history?unknown=1`)).status, 400);
  assert.equal((await fetch(`${f.url()}/api/estimates/history?scope=unknown`)).status, 400);
  assert.deepEqual((await (await fetch(`${f.url()}/api/estimates/history?scope=legacy`)).json()).items, []);
});

test('invalid and disconnected collection rebase while a restart keeps the saved estimation clock', async (t) => {
  const f = await fixture(t, { initialSnapshot: fixedSnapshot(2, T0), reconnectMs: 30 });
  await waitForEstimates(f, (view) => view.status === 'collecting');

  const invalid = fixedSnapshot(3, T1);
  invalid.stats.devices[1].periods.today.costUsd = 'invalid';
  f.hub.broadcast(invalid);
  await waitUntil(() => f.app.state().hubs[0].status.validationError !== null);
  await waitForEstimates(f, (view) => view.reason === 'invalid_notification');
  await assertFreshBaseline(f, 4, T2, 5, T3);

  f.hub.disconnect();
  await waitUntil(() => f.app.state().hubs[0].status.connection === 'disconnected');
  await waitForEstimates(f, (view) => view.reason === 'disconnected');
  await waitForEstimates(f, (view) => view.reason === 'awaiting_refresh');
  await assertFreshBaseline(f, 7, T4, 8, T5);

  await f.restart();
  await waitForEstimates(f, (view) => (
    view.status === 'estimated'
    && view.lastResult?.evidence?.baseline?.cost === 7 * 48
  ));
  f.hub.broadcast(fixedSnapshot(9, T6));
  f.hub.broadcast(fixedSnapshot(10, T7));
  await waitForEstimates(f, (view) => (
    view.status === 'estimated'
    && view.lastResult?.evidence?.baseline?.cost === 7 * 48
    && view.lastResult?.evidence?.latest?.cost === 10 * 48
  ));
});

test('estimation history stays readable after save failure and returns 503 after a read failure', async (t) => {
  const f = await fixture(t, { initialSnapshot: fixedSnapshot(2, T0) });
  await waitForEstimates(f, (view) => view.status === 'collecting');
  const before = await fetch(`${f.url()}/api/estimates/history?hubId=alpha`);
  assert.equal(before.status, 200);
  const beforeBody = await before.text();

  f.app.store.commitNotification = () => {
    throw Object.assign(new Error('injected estimation save failure'), { code: 'SQLITE_IOERR' });
  };
  f.hub.broadcast(fixedSnapshot(3, T1));
  await waitUntil(() => f.app.state().storage.state === 'failed');
  const afterSaveFailure = await fetch(`${f.url()}/api/estimates/history?hubId=alpha`);
  assert.equal(afterSaveFailure.status, 200);
  assert.equal(await afterSaveFailure.text(), beforeBody);

  f.app.store.readEstimationHistory = () => {
    throw Object.assign(new Error('injected estimation read failure'), { code: 'SQLITE_IOERR' });
  };
  const afterReadFailure = await fetch(`${f.url()}/api/estimates/history?hubId=alpha`);
  assert.equal(afterReadFailure.status, 503);
  assert.equal((await fetch(`${f.url()}/api/history`)).status, 503);
  assert.equal((await afterReadFailure.text()).includes(f.secret), false);
});

test('two hubs update independently with the same device ids and keep secrets out of API and logs', async (t) => {
  const f = await dualFixture(t);
  await waitForDualInitialState(f);
  assert.deepEqual(
    f.state('private').devices.map((device) => device.deviceId),
    f.state('work').devices.map((device) => device.deviceId)
  );
  assert.equal(f.cost('private'), 2);
  assert.equal(f.cost('work'), 4);

  const initialPrivateReceivedAt = f.state('private').receivedAt;
  const initialWork = structuredClone(f.state('work'));
  await delay(50);
  f.mockHubs.get('private').broadcast(makeSnapshot({ value: 11, updatedAt: '2026-09-13T00:10:00.000Z' }));
  await waitUntil(() => f.cost('private') === 11 && f.state('private').receivedAt !== initialPrivateReceivedAt);
  assert.equal(f.cost('work'), initialWork.devices[0].observation.periods.today.costUsd);
  assert.equal(f.state('work').receivedAt, initialWork.receivedAt);

  const privateAfterUpdate = structuredClone(f.state('private'));
  const workReceivedAt = f.state('work').receivedAt;
  await delay(50);
  f.mockHubs.get('work').broadcast(makeSnapshot({ value: 13, updatedAt: '2026-09-13T00:11:00.000Z' }));
  await waitUntil(() => f.cost('work') === 13 && f.state('work').receivedAt !== workReceivedAt);
  assert.equal(f.cost('private'), privateAfterUpdate.devices[0].observation.periods.today.costUsd);
  assert.equal(f.state('private').receivedAt, privateAfterUpdate.receivedAt);
  await assertNoSecretsInApiOrLogs(f);
});

test('one hub authentication failure does not stop the other hub from saving', async (t) => {
  const f = await dualFixture(t, { configurationSecrets: { work: 'wrong-work-secret-never-expose' } });
  await waitUntil(() => f.state('private').devices.length === 2 && f.state('work').status.connectionDetail === 'HTTP 401');
  assert.equal(f.cost('private'), 2);
  assert.deepEqual(f.state('work').devices, []);
  assert.equal(f.state('work').receivedAt, null);
  assert.ok(f.mockHubs.get('private').requests >= 1);
  assert.equal(f.mockHubs.get('work').requests, 0);

  f.mockHubs.get('private').broadcast(makeSnapshot({ value: 17, updatedAt: '2026-09-13T00:17:00.000Z' }));
  await waitUntil(() => f.cost('private') === 17);
  assert.deepEqual(f.state('work').devices, []);
  await assertNoSecretsInApiOrLogs(f);
});

test('one invalid notification preserves its hub while the other saves, then recovers', async (t) => {
  const f = await dualFixture(t);
  await waitForDualInitialState(f);
  const beforePrivate = structuredClone(f.state('private'));
  const invalid = makeSnapshot({ value: 19, updatedAt: '2026-09-13T00:19:00.000Z' });
  invalid.stats.devices[1].periods.today.costUsd = f.allSecrets[0];
  f.mockHubs.get('private').broadcast(invalid);
  await waitUntil(() => f.state('private').status.validationError !== null);
  f.mockHubs.get('work').broadcast(makeSnapshot({ value: 23, updatedAt: '2026-09-13T00:23:00.000Z' }));
  await waitUntil(() => f.cost('work') === 23);

  assert.equal(f.cost('private'), beforePrivate.devices[0].observation.periods.today.costUsd);
  assert.equal(f.state('private').receivedAt, beforePrivate.receivedAt);
  assert.deepEqual(f.state('private').devices, beforePrivate.devices);
  assert.equal(f.state('work').status.validationError, null);

  f.mockHubs.get('private').broadcast(makeSnapshot({ value: 29, updatedAt: '2026-09-13T00:29:00.000Z' }));
  await waitUntil(() => f.cost('private') === 29 && f.state('private').status.validationError === null);
  assert.equal(f.cost('work'), 23);
  await assertNoSecretsInApiOrLogs(f);
});

test('one hub can disconnect while the other updates and reconnection does not duplicate observations', async (t) => {
  const f = await dualFixture(t, { reconnectMs: 1000 });
  await waitForDualInitialState(f);
  const initialPrivate = structuredClone(f.state('private'));
  const initialObservationIds = initialPrivate.devices.map((device) => device.observationId);
  await delay(50);
  f.mockHubs.get('private').disconnect();
  await waitUntil(() => f.state('private').status.connection === 'disconnected');

  const workReceivedAt = f.state('work').receivedAt;
  f.mockHubs.get('work').broadcast(makeSnapshot({ value: 31, updatedAt: '2026-09-13T00:31:00.000Z' }));
  await waitUntil(() => (
    f.cost('work') === 31
    && f.state('work').receivedAt !== workReceivedAt
    && f.state('private').status.connection === 'disconnected'
  ));
  assert.equal(f.state('private').status.connection, 'disconnected');
  assert.equal(f.cost('private'), initialPrivate.devices[0].observation.periods.today.costUsd);

  await waitUntil(() => (
    f.mockHubs.get('private').requests >= 2
    && f.state('private').status.connection === 'connected'
    && f.state('private').receivedAt !== initialPrivate.receivedAt
  ));
  assert.deepEqual(f.state('private').devices.map((device) => device.observationId), initialObservationIds);
  assert.equal(f.cost('private'), initialPrivate.devices[0].observation.periods.today.costUsd);
  assert.equal(f.cost('work'), 31);
  await assertNoSecretsInApiOrLogs(f);
});
