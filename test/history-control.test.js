import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { startAnalytics } from '../src/app.js';
import { makeSnapshot } from '../mock/hub.js';

const today = '2026-09-14';
const payload = () => ({ devices: [{
  deviceId: 'device-1', periodWindows: { today: { key: today }, timeZone: 'Asia/Tokyo' },
  history: {
    daily: [{ date: '2026-09-13', perClient: { codex: { tokens: 10, cost: 1 } } }],
    monthly: [{ month: '2026-09', perClient: { codex: { tokens: 10, cost: 1 } } }],
  },
}, {
    deviceId: 'device-2', periodWindows: { today: { key: today }, timeZone: 'America/Los_Angeles' },
    history: { daily: [], monthly: [] },
  }, { deviceId: 'device-3', history: { daily: [], monthly: [] } }] });

async function waitUntil(check) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail('condition did not become true');
}

async function fixture(t, { history, twoHubs = false, ...options } = {}) {
  const streams = new Set();
  const historyRequests = [];
  let requestHandler = history ?? ((_request, response) => response.end(JSON.stringify(payload())));
  const hub = createServer((request, response) => {
    if (request.url === '/api/stats/stream') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('event: snapshot\ndata: ' + JSON.stringify(makeSnapshot()) + '\n\n');
      streams.add(response);
      response.on('close', () => streams.delete(response));
    } else {
      historyRequests.push(Date.now());
      requestHandler(request, response);
    }
  });
  await new Promise((resolve) => hub.listen(0, '127.0.0.1', resolve));
  const logs = [];
  const app = await startAnalytics({
    configuration: {
      host: '127.0.0.1', port: 0, dbPath: ':memory:',
      hubs: (twoHubs ? ['a', 'b'] : ['a']).map((id) => ({
        id, url: 'http://127.0.0.1:' + hub.address().port, secret: 'test', configError: null,
      })),
    }, reconnectMs: 20, historyRetryMs: 100, historyPollMs: 10,
    now: () => new Date(2026, 8, 14, 12), log: (entry) => logs.push(entry), ...options,
  });
  t.after(async () => {
    await app.stop();
    await new Promise((resolve) => { hub.close(resolve); hub.closeAllConnections(); });
  });
  return {
    app, logs, streams, historyRequests,
    url: 'http://127.0.0.1:' + app.address.port,
    setHistory(handler) { requestHandler = handler; },
    emit(snapshot) { for (const response of streams) response.write('event: stats\ndata: ' + JSON.stringify(snapshot) + '\n\n'); },
  };
}

test('履歴APIの不正条件は400で返し全Hubの保存を継続する', async (t) => {
  const f = await fixture(t, { twoHubs: true });
  await waitUntil(() => f.app.state().hubs.every((hub) => hub.history.state === 'ready'));
  for (const query of ['limit=501', 'limit=-1', 'limit=1e2', 'kind=weekly', 'before=bad', 'from=2026-02-30', 'from=2026-09-14&to=2026-09-13', 'kind=monthly&to=2026-09-14', 'hubId=', 'limit=1&limit=2']) {
    assert.equal((await fetch(f.url + '/api/history?' + query)).status, 400, query);
    assert.equal(f.app.state().storage.state, 'normal');
  }
  const before = f.app.state().hubs.map((hub) => hub.receivedAt);
  f.emit(makeSnapshot({ value: 9 }));
  await waitUntil(() => f.app.state().hubs.every((hub, i) => hub.receivedAt !== before[i]));
  const head = await fetch(f.url + '/api/history?kind=monthly', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('GETソケット切断を再試行し成功後は再接続でも再取得しない', async (t) => {
  let calls = 0;
  const f = await fixture(t, { history(request, response) {
    if (++calls === 1) request.socket.destroy();
    else response.end(JSON.stringify(payload()));
  } });
  await waitUntil(() => f.app.state().hubs[0].history.state === 'retrying');
  assert.equal(f.logs.find((entry) => entry.operation === 'history-fetch').category, 'TypeError');
  await waitUntil(() => f.app.state().hubs[0].history.state === 'ready');
  assert.equal(calls, 2);
  for (const response of f.streams) response.end();
  await delay(220);
  assert.equal(calls, 2);
  assert.equal(f.app.state().hubs[0].status.connection, 'connected');
});

test('定期取得と再接続は再試行期限を守り成功すると予約を解除する', async (t) => {
  let time = new Date(2026, 8, 14, 12);
  const f = await fixture(t, { now: () => time, historyRetryMs: 500 });
  await waitUntil(() => f.app.state().hubs[0].history.state === 'ready');
  const initial = f.historyRequests.length;
  f.setHistory((_request, response) => response.writeHead(500).end());
  time = new Date(2026, 8, 15, 1);
  await waitUntil(() => f.app.state().hubs[0].history.state === 'retrying');
  for (const response of f.streams) response.end();
  await delay(100);
  assert.equal(f.historyRequests.length, initial + 1);
  f.setHistory((_request, response) => response.end(JSON.stringify(payload())));
  await f.app.fetchHistory('a');
  assert.equal(f.app.state().hubs[0].history.nextRetryAt, null);
  await delay(550);
  assert.equal(f.historyRequests.length, initial + 2);
});

test('不正なJSON・応答骨格は当日の自動再試行を止め次の定期取得で回復する', async (t) => {
  let time = new Date(2026, 8, 14, 1);
  const f = await fixture(t, { now: () => time, history(_request, response) { response.end('invalid JSON'); } });
  await waitUntil(() => f.app.state().hubs[0].history.state === 'invalid');
  await delay(160);
  assert.equal(f.historyRequests.length, 1);
  f.setHistory((_request, response) => response.end(JSON.stringify({ devices: [{}] })));
  await f.app.fetchHistory('a');
  assert.equal(f.app.state().hubs[0].history.state, 'invalid');
  f.setHistory((_request, response) => response.end(JSON.stringify(payload())));
  time = new Date(2026, 8, 15, 1);
  await waitUntil(() => f.app.state().hubs[0].history.state === 'ready');
  assert.equal(f.historyRequests.length, 3);
});

test('初回が午前1時前でも定期時刻を迎えたら取得し翌日も継続する', async (t) => {
  let time = new Date(2026, 8, 14, 0, 30);
  const f = await fixture(t, { now: () => time });
  await waitUntil(() => f.app.state().hubs[0].history.state === 'ready');
  time = new Date(2026, 8, 14, 1);
  await waitUntil(() => f.historyRequests.length === 2);
  await waitUntil(() => f.app.state().hubs[0].history.state === 'ready');
  await delay(40);
  assert.equal(f.historyRequests.length, 2);
  time = new Date(2026, 8, 15, 2);
  await waitUntil(() => f.historyRequests.length === 3);
});

test('午前1時以後の再接続は1時前の成功を定期取得済みと扱わない', async (t) => {
  let time = new Date(2026, 8, 14, 0, 30);
  const f = await fixture(t, { now: () => time, historyPollMs: 60_000 });
  await waitUntil(() => f.app.state().hubs[0].history.state === 'ready' && f.streams.size === 1);
  assert.equal(f.historyRequests.length, 1);
  time = new Date(2026, 8, 14, 2);
  for (const stream of f.streams) stream.end();
  await waitUntil(() => f.historyRequests.length === 2 && f.app.state().hubs[0].history.state === 'ready' && f.streams.size === 1);
  for (const stream of f.streams) stream.end();
  await delay(150);
  assert.equal(f.streams.size, 1);
  assert.equal(f.historyRequests.length, 2);
});

test('再開の重複と停止再開の連続操作で他Hubの保存を止めない', async (t) => {
  const f = await fixture(t, { twoHubs: true });
  await waitUntil(() => f.streams.size === 2 && f.app.state().hubs.every((hub) => hub.history.state === 'ready'));
  await f.app.stopHubCollection('a');
  await f.app.startHubCollection('a');
  await f.app.startHubCollection('a');
  await Promise.all([
    f.app.stopHubCollection('a'), f.app.startHubCollection('a'),
    f.app.stopHubCollection('a'), f.app.startHubCollection('a'),
  ]);
  await waitUntil(() => f.streams.size === 2);
  const before = f.app.state().hubs.map((hub) => hub.receivedAt);
  f.emit(makeSnapshot({ value: 20 }));
  await waitUntil(() => f.app.state().hubs.every((hub, i) => hub.receivedAt !== before[i]));
  assert.ok(f.app.state().hubs.every((hub) => !hub.status.collectionStopped));
  assert.equal(f.app.state().storage.state, 'normal');
});

test('停止設定の保存失敗でも実行中の停止状態を保存失敗と併記する', async (t) => {
  const f = await fixture(t);
  await waitUntil(() => f.app.state().hubs[0].history.state === 'ready');
  f.app.store.setCollectionEnabled = () => { throw new Error('injected write failure'); };
  await f.app.stopHubCollection('a');
  const state = f.app.state();
  assert.equal(state.hubs[0].collectionEnabled, true);
  assert.equal(state.hubs[0].status.collectionStopped, true);
  assert.equal(state.hubs[0].history.state, 'stopped');
  assert.equal(state.storage.state, 'failed');
  await waitUntil(() => f.streams.size === 0);
});

test('GET遅延中もSSEを保存し停止直後の再開で履歴を取り直す', async (t) => {
  let pending;
  const f = await fixture(t, { history(_request, response) { pending = response; } });
  await waitUntil(() => pending && f.app.state().hubs[0].devices.length > 0);
  const before = f.app.state().hubs[0].receivedAt;
  f.emit(makeSnapshot({ value: 30 }));
  await waitUntil(() => f.app.state().hubs[0].receivedAt !== before);
  assert.equal(f.app.store.readHistory().items.length, 0);
  const stopping = f.app.stopHubCollection('a');
  pending.end(JSON.stringify(payload()));
  f.setHistory((_request, response) => response.end(JSON.stringify(payload())));
  const restarting = f.app.startHubCollection('a');
  await Promise.all([stopping, restarting]);
  await waitUntil(() => f.app.state().hubs[0].history.state === 'ready');
  assert.equal(f.app.store.readHistory().items.length, 1);
  assert.equal(f.historyRequests.length, 2);
});

test('履歴保存失敗は成功日時を保持し全Hubの書き込みを止め通信再試行しない', async (t) => {
  const f = await fixture(t, { twoHubs: true });
  await waitUntil(() => f.app.state().hubs.every((hub) => hub.history.state === 'ready'));
  const success = f.app.store.readHistoryFetchState('a');
  const snapshot = f.app.state().hubs.map((hub) => hub.receivedAt);
  f.app.store.commitHistory = () => { throw new Error('injected history write failure'); };
  await f.app.fetchHistory('a');
  const calls = f.historyRequests.length;
  assert.equal(f.app.state().storage.state, 'failed');
  assert.deepEqual(f.app.store.readHistoryFetchState('a'), success);
  f.emit(makeSnapshot({ value: 40 }));
  await delay(150);
  assert.deepEqual(f.app.state().hubs.map((hub) => hub.receivedAt), snapshot);
  assert.equal(f.historyRequests.length, calls);
  assert.equal((await fetch(f.url + '/api/history')).status, 200);
});

test('履歴成功通知に端末ごとの前日なし・今日不明と月次の判定根拠を含める', async (t) => {
  const f = await fixture(t);
  await waitUntil(() => f.app.state().hubs[0].history.state === 'ready');
  assert.deepEqual(f.app.state().hubs[0].history.devices.map((device) => device.dailyStatus), ['available', 'no_previous_day', 'unknown_today']);
  const response = await fetch(f.url + '/api/history?kind=monthly');
  const row = (await response.json()).items[0];
  assert.equal(row.todayKey, today);
  assert.equal(row.timeZone, 'Asia/Tokyo');
  assert.equal(row.month, '2026-09');
});

test('GETの再取得はSSE現在値と共通推定の根拠を変更しない', async (t) => {
  const f = await fixture(t);
  await waitUntil(() => f.app.state().hubs[0].history.state === 'ready' && f.app.state().hubs[0].devices.length > 0);
  const current = () => {
    const state = f.app.state();
    return { contracts: state.contracts, estimates: state.estimates, metrics: state.metrics,
      aggregate: state.hubs[0].aggregate, devices: state.hubs[0].devices, receivedAt: state.hubs[0].receivedAt };
  };
  const before = current();
  f.setHistory((_request, response) => {
    const next = payload();
    next.devices[0].history.daily[0].perClient.codex.cost = 999;
    response.end(JSON.stringify(next));
  });
  await f.app.fetchHistory('a');
  assert.equal(f.app.store.readHistory().items[0].cost, 999);
  assert.deepEqual(current(), before);
});

test('履歴COMMIT後の参照失敗は保存済み履歴を戻さず画面の保持値を維持する', async (t) => {
  const f = await fixture(t);
  await waitUntil(() => f.app.state().hubs[0].history.state === 'ready');
  const before = f.app.state().hubs[0].history;
  f.setHistory((_request, response) => {
    const next = payload();
    next.devices[0].history.daily[0].perClient.codex.cost = 777;
    response.end(JSON.stringify(next));
  });
  f.app.store.readState = () => { throw new Error('injected post-commit read failure'); };
  await f.app.fetchHistory('a');
  assert.equal(f.app.state().storage.state, 'unreadable');
  assert.equal(f.app.store.readHistory().items[0].cost, 777);
  assert.deepEqual(f.app.state().hubs[0].history.devices, before.devices);
  assert.equal((await fetch(f.url + '/api/history')).status, 503);
});
