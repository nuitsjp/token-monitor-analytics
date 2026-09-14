import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startAnalytics } from '../src/app.js';
import {
  deviceTodayKey,
  selectDailyRecords,
  selectMonthlyRecords,
  selectHistoryPayload,
  validateDevicesPayload,
} from '../src/history.js';
import { AnalyticsStore } from '../src/store.js';
import { makeSnapshot, startMockHub } from '../mock/hub.js';

const T0 = '2026-09-13T00:00:00.000Z';
const NL_SSE = String.fromCharCode(10);

function localTodayKey(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return date.getFullYear() + '-' + month + '-' + day;
}

function dayKey(offsetDays) {
  const now = new Date();
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);
  return localTodayKey(day);
}

function historyEntry(date, cost) {
  return { date, tokens: cost * 1000, cost, perClient: { codex: { tokens: cost * 1000, cost } } };
}

function windows(todayKey = dayKey(0), timeZone = 'Asia/Tokyo') {
  return { today: { key: todayKey, endsAt: '2030-01-01T00:00:00.000Z' }, timeZone };
}

test('日次は前日以前だけ保存し当日分を除外する', () => {
  const history = {
    daily: [historyEntry(dayKey(-2), 3), historyEntry(dayKey(-1), 2), historyEntry(dayKey(0), 99), historyEntry(dayKey(1), 100)],
  };
  const selected = selectDailyRecords(history, windows());
  assert.equal(selected.skipped, null);
  assert.deepEqual(selected.records.map((record) => record.date), [dayKey(-2), dayKey(-1)]);
  assert.deepEqual(selected.records.map((record) => [record.tool, record.tokens, record.cost]), [['codex', 3000, 3], ['codex', 2000, 2]]);
});

test('端末現地の今日が不明な場合は他ゾーンで代用せず日次を見送る', () => {
  const history = { daily: [historyEntry(dayKey(-1), 2)] };
  const unknowns = [null, {}, { today: {} }, { today: { key: 'not-a-date' } }, { today: { key: null } }];
  for (const periodWindows of unknowns) {
    const selected = selectDailyRecords(history, periodWindows);
    assert.deepEqual(selected.records, []);
    assert.equal(selected.skipped, 'unknown_today');
  }
  const invalidZone = selectDailyRecords(history, windows(dayKey(0), 'Invalid/Zone'));
  assert.deepEqual(invalidZone.records, []);
  assert.equal(invalidZone.skipped, 'unknown_today');
  const noZone = selectDailyRecords(history, { today: { key: dayKey(0) } });
  assert.equal(noZone.records.length, 1);
});

test('日付・数値の不正行は補完せず読み飛ばす', () => {
  const history = {
    daily: [
      { date: '2026-13-40', tokens: 1, cost: 1, perClient: { codex: { tokens: 1, cost: 1 } } },
      { date: dayKey(-1), tokens: 1, cost: 1, perClient: { codex: { tokens: -5, cost: 1 } } },
      { date: dayKey(-1), tokens: 1, cost: 1, perClient: { codex: { tokens: 1, cost: Number.NaN } } },
      { date: dayKey(-1), tokens: 1, cost: 1 },
      historyEntry(dayKey(-1), 2),
    ],
  };
  const selected = selectDailyRecords(history, windows());
  assert.equal(selected.records.length, 1);
  assert.equal(selected.records[0].cost, 2);
});

test('月次は返却された各月を保存し当月も除外しない', () => {
  const month = dayKey(-10).slice(0, 7);
  const currentMonth = dayKey(0).slice(0, 7);
  const history = {
    monthly: [
      { month, tokens: 100, cost: 1, perClient: { codex: { tokens: 100, cost: 1 } } },
      { month: currentMonth, tokens: 50, cost: 0.5, perClient: { codex: { tokens: 50, cost: 0.5 } } },
      { month: 'bad-month', tokens: 1, cost: 1, perClient: { codex: { tokens: 1, cost: 1 } } },
    ],
  };
  const selected = selectMonthlyRecords(history);
  assert.deepEqual(selected.records.map((record) => record.month).sort(), [month, currentMonth].sort());
});

test('deviceTodayKeyは今日キーとタイムゾーンの妥当性を判定する', () => {
  assert.equal(deviceTodayKey(windows()).todayKey, dayKey(0));
  assert.equal(deviceTodayKey(null).reason, 'unknown_today');
  assert.equal(deviceTodayKey(windows(dayKey(0), 'Invalid/Zone')).reason, 'unknown_today');
});

test('GET応答の骨格不正は取得として扱わない', () => {
  assert.throws(() => validateDevicesPayload(null), /object/);
  assert.throws(() => validateDevicesPayload({}), /array/);
  assert.throws(() => validateDevicesPayload({ devices: [{}] }), /deviceId/);
  assert.equal(validateDevicesPayload({ devices: [{ deviceId: 'd1' }] }).length, 1);
});

function workspaceStore(t) {
  const workdir = mkdtempSync(join(tmpdir(), 'token-history-'));
  const stores = [];
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(workdir, { recursive: true, force: true });
  });
  return {
    dbPath: join(workdir, 'analytics.sqlite'),
    track(store) {
      stores.push(store);
      return store;
    },
  };
}

function commitSample(store) {
  store.registerHubs(['hub-a']);
  store.commitHistory('hub-a', {
    daily: [{ deviceId: 'device-1', date: dayKey(-2), tool: 'codex', tokens: 3000, cost: 3 }],
    monthly: [{ deviceId: 'device-1', month: dayKey(-2).slice(0, 7), tool: 'codex', tokens: 3000, cost: 3 }],
  }, T0);
}

test('履歴行と取得完了状態を同一トランザクションで確定する', (t) => {
  const work = workspaceStore(t);
  const store = work.track(new AnalyticsStore(work.dbPath));
  commitSample(store);
  const daily = store.readHistory({ kind: 'daily', hubId: 'hub-a' });
  assert.equal(daily.items.length, 1);
  assert.deepEqual(daily.items[0], { hubId: 'hub-a', deviceId: 'device-1', date: dayKey(-2), tool: 'codex', tokens: 3000, cost: 3, todayKey: null, timeZone: null, fetchedAt: null });
  const monthly = store.readHistory({ kind: 'monthly', hubId: 'hub-a' });
  assert.equal(monthly.items.length, 1);
  assert.equal(monthly.items[0].month, dayKey(-2).slice(0, 7));
  assert.equal(store.readHistoryFetchState('hub-a').lastSuccessAt, T0);
});

test('再取得データで非破壊更新し応答にない過去レコードは保持する', (t) => {
  const work = workspaceStore(t);
  const store = work.track(new AnalyticsStore(work.dbPath));
  commitSample(store);
  store.commitHistory('hub-a', {
    daily: [{ deviceId: 'device-1', date: dayKey(-2), tool: 'codex', tokens: 3500, cost: 3.5 }],
    monthly: [],
  }, '2026-09-14T00:00:00.000Z');
  assert.equal(store.readHistory({ kind: 'daily', hubId: 'hub-a' }).items[0].tokens, 3500);
  assert.equal(store.readHistory({ kind: 'monthly', hubId: 'hub-a' }).items.length, 1);
  assert.equal(store.readHistoryFetchState('hub-a').lastSuccessAt, '2026-09-14T00:00:00.000Z');
});

test('履歴の保存失敗は全体をロールバックし成功扱いにしない', (t) => {
  const work = workspaceStore(t);
  const store = work.track(new AnalyticsStore(work.dbPath));
  commitSample(store);
  const before = store.readHistory({ kind: 'daily', hubId: 'hub-a' });
  assert.throws(() => {
    store.commitHistory('hub-a', {
      daily: [{ deviceId: 'device-1', date: dayKey(-1), tool: 'codex', tokens: 10, cost: 0.1 }],
      monthly: [{ deviceId: 'device-1', tool: 'codex', tokens: 10, cost: 0.1 }],
    }, '2026-09-14T00:00:00.000Z');
  }, /month/);
  assert.deepEqual(store.readHistory({ kind: 'daily', hubId: 'hub-a' }), before);
  assert.equal(store.readHistory({ kind: 'monthly', hubId: 'hub-a' }).items.length, 1);
  assert.equal(store.readHistoryFetchState('hub-a').lastSuccessAt, T0);
  assert.throws(() => store.commitHistory('unknown-hub', { daily: [], monthly: [] }, T0), /not registered/);
});

test('履歴の読み出しは絞り込みと件数検証を行う', (t) => {
  const work = workspaceStore(t);
  const store = work.track(new AnalyticsStore(work.dbPath));
  commitSample(store);
  assert.equal(store.readHistory({ kind: 'daily', hubId: 'hub-a', tool: 'other' }).items.length, 0);
  assert.equal(store.readHistory({ kind: 'daily', hubId: 'hub-a', from: dayKey(-1) }).items.length, 0);
  assert.equal(store.readHistory({ kind: 'daily', hubId: 'hub-a', to: dayKey(-2) }).items.length, 1);
  assert.throws(() => store.readHistory({ kind: 'weekly' }), /kind/);
  assert.throws(() => store.readHistory({ limit: 0 }), /limit/);
  assert.throws(() => store.readHistory({ limit: 501 }), /limit/);
});

test('収集停止フラグは保存され再起動後も復元される', (t) => {
  const work = workspaceStore(t);
  const store = work.track(new AnalyticsStore(work.dbPath));
  store.registerHubs(['hub-a']);
  store.setCollectionEnabled('hub-a', false);
  assert.equal(store.readState().hubs[0].collectionEnabled, false);
  store.close();
  const reopened = work.track(new AnalyticsStore(work.dbPath));
  assert.equal(reopened.readState().hubs[0].collectionEnabled, false);
  reopened.setCollectionEnabled('hub-a', true);
  assert.equal(reopened.readState().hubs[0].collectionEnabled, true);
  assert.throws(() => reopened.setCollectionEnabled('unknown-hub', false), /not registered/);
});

async function appFixture(t, hubOptions = {}, analyticsOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'token-analytics-history-'));
  const secret = 'history-test-secret-never-expose';
  const hub = await startMockHub({ port: 0, automatic: false, secret, ...hubOptions });
  const configuration = {
    host: '127.0.0.1', port: 0, dbPath: join(directory, 'analytics.sqlite'),
    hubs: [{ id: 'alpha', url: hub.url, secret, configError: null }],
  };
  const logs = [];
  let app = await startAnalytics({
    configuration, reconnectMs: 30, historyRetryMs: 50, historyPollMs: 3600000,
    log: (entry) => logs.push(entry), ...analyticsOptions,
  });
  t.after(async () => {
    await Promise.allSettled([app?.stop(), hub.close()]);
    await rm(directory, { recursive: true, force: true });
  });
  return {
    hub, logs, configuration,
    get app() { return app; },
    url: () => 'http://127.0.0.1:' + app.address.port,
    async restart() {
      await app.stop();
      app = await startAnalytics({
        configuration, reconnectMs: 30, historyRetryMs: 50, historyPollMs: 3600000,
        log: (entry) => logs.push(entry), ...analyticsOptions,
      });
    },
  };
}

async function waitUntil(check) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  assert.fail('Expected state was not reached within 5 seconds');
}

test('初回接続で履歴を取得し当日分を除いて保存する', async (t) => {
  const f = await appFixture(t);
  await waitUntil(() => f.app.store.readHistory({ kind: 'daily', hubId: 'alpha' }).items.length > 0);
  const daily = f.app.store.readHistory({ kind: 'daily', hubId: 'alpha' });
  assert.ok(daily.items.length >= 2);
  for (const item of daily.items) assert.ok(item.date < localTodayKey());
  assert.ok(f.app.store.readHistory({ kind: 'monthly', hubId: 'alpha' }).items.length > 0);
  const response = await fetch(f.url() + '/api/history?kind=monthly&hubId=alpha');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).kind, 'monthly');
  assert.equal((await fetch(f.url() + '/api/history?kind=weekly')).status, 400);
});

test('停止要求は進行中の取得を中止し再起動後も停止を維持する', async (t) => {
  const f = await appFixture(t, { historyDelayMs: 400 });
  f.hub.broadcast(makeSnapshot({ value: 2 }));
  await waitUntil(() => f.app.state().hubs[0].devices.length === 2);
  await f.app.stopHubCollection('alpha');
  await f.app.drain();
  assert.equal(f.app.store.readState().hubs[0].collectionEnabled, false);
  await delay(700);
  assert.equal(f.app.store.readHistory({ kind: 'daily', hubId: 'alpha' }).items.length, 0);
  await f.restart();
  await delay(200);
  assert.equal(f.app.state().hubs[0].status.connection, 'disconnected');
  assert.equal(f.app.store.readState().hubs[0].collectionEnabled, false);
  assert.equal(f.app.store.readHistory({ kind: 'daily', hubId: 'alpha' }).items.length, 0);
});

test('再開後は収集と履歴取得を再開する', async (t) => {
  const f = await appFixture(t);
  f.hub.broadcast(makeSnapshot({ value: 2 }));
  await waitUntil(() => f.app.state().hubs[0].devices.length === 2);
  await f.app.stopHubCollection('alpha');
  await f.app.drain();
  assert.equal(f.app.state().hubs[0].status.connection, 'disconnected');
  await f.app.startHubCollection('alpha');
  await f.app.drain();
  assert.equal(f.app.store.readState().hubs[0].collectionEnabled, true);
  await waitUntil(() => f.app.state().hubs[0].devices.length === 2);
  await waitUntil(() => f.app.store.readHistory({ kind: 'daily', hubId: 'alpha' }).items.length > 0);
});

test('通信失敗は再試行し回復後に取得を完了する', async (t) => {
  let failures = 1;
  const payload = {
    devices: [{
      deviceId: 'device-9',
      periodWindows: { today: { key: dayKey(0), endsAt: '2030-01-01T00:00:00.000Z' }, timeZone: 'Asia/Tokyo' },
      history: {
        daily: [{ date: dayKey(-1), tokens: 500, cost: 0.5, perClient: { codex: { tokens: 500, cost: 0.5 } } }],
        monthly: [],
      },
    }],
  };
  const flaky = createServer((request, response) => {
    if (request.url === '/api/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
      return;
    }
    if (request.url === '/api/stats/stream') {
      const frame = 'event: snapshot' + NL_SSE + 'data: ' + JSON.stringify(makeSnapshot()) + NL_SSE + NL_SSE;
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      response.end(frame);
      return;
    }
    if (request.url === '/api/devices' && request.method === 'GET') {
      if (failures > 0) { failures -= 1; response.writeHead(500).end(); return; }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => flaky.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + flaky.address().port;
  const directory = await mkdtemp(join(tmpdir(), 'token-analytics-flaky-'));
  const app = await startAnalytics({
    configuration: { host: '127.0.0.1', port: 0, dbPath: join(directory, 'analytics.sqlite'), hubs: [{ id: 'flaky', url, secret: 's', configError: null }] },
    reconnectMs: 30, historyRetryMs: 50, historyPollMs: 3600000, log: () => {},
  });
  t.after(async () => {
    await app.stop();
    await new Promise((resolve) => flaky.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await waitUntil(() => app.store.readHistory({ kind: 'daily', hubId: 'flaky' }).items.length === 1);
  assert.notEqual(app.store.readHistoryFetchState('flaky').lastSuccessAt, null);
});
