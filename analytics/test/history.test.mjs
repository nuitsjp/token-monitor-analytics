import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {openDatabase} from '../runtime/sqlite.mjs';
import {
  beginHistoryFetch,
  historyFetchStatus,
  readUsageHistory,
  recordHistoryFetchFailure,
  storeHistorySnapshot,
} from '../src/db.ts';
import {
  HistoryInputError,
  normalizeHistoryResponse,
} from '../src/history.ts';
import {
  MAX_HISTORY_BODY_BYTES,
  HistoryUnsupportedError,
  createHistoryScheduler,
  fetchHistory,
} from '../runtime/collection/history.mjs';
import {subscribeLoop} from '../runtime/collection/subscribe.mjs';

const hub = {id: 'hub-a', url: 'http://127.0.0.1:1', secret: 'hub-secret'};

function device(id = 'device-a', changes = {}) {
  return {
    deviceId: id,
    updatedAt: '2026-09-08T12:00:00.000Z',
    historyAvailable: true,
    periodWindows: {
      timeZone: 'Asia/Tokyo',
      today: {key: '2026-09-08', endsAt: '2026-09-08T15:00:00.000Z'},
      month: {key: '2026-09', endsAt: '2026-09-30T15:00:00.000Z'},
    },
    history: {
      daily: [
        {date: '2026-09-07', tokens: 90, cost: 0.9, messages: 3, perClient: {codex: {tokens: 90, cost: 0.9}}, perModel: {'gpt-5': {tokens: 90, cost: 0.9}}},
        {date: '2026-09-08', tokens: 100, cost: 1, messages: 4, perClient: {codex: {tokens: 100, cost: 1}}, perModel: {'gpt-5': {tokens: 100, cost: 1}}},
      ],
      monthly: [
        {month: '2026-09', tokens: 190, cost: 1.9, perClient: {codex: {tokens: 190, cost: 1.9}}, perModel: {'gpt-5': {tokens: 190, cost: 1.9}}},
      ],
      privateField: 'must not persist',
    },
    ...changes,
  };
}

function responseFor(devices, status = 200) {
  return new Response(JSON.stringify({devices}), {status, headers: {'content-type': 'application/json'}});
}

function waitFor(predicate, timeout = 1000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) { resolve(); return; }
      if (Date.now() >= deadline) { reject(new Error('condition timed out')); return; }
      setTimeout(check, 2).unref();
    };
    check();
  });
}

test('History normalization validates the complete response and strips private fields', () => {
  const result = normalizeHistoryResponse({devices: [device(), device('device-b', {historyAvailable: false, history: null})]});
  assert.deepEqual(result.devices[0].rows.map(row => row.periodKey), ['2026-09-07', '2026-09-08', '2026-09']);
  assert.equal(result.devices[0].historyState, 'available');
  assert.equal(result.devices[0].rows[0].perClient.codex.tokens, 90);
  assert.equal(Object.hasOwn(result.devices[0].rows[0], 'privateField'), false);
  assert.equal(result.devices[1].historyState, 'disabled');
  assert.throws(() => normalizeHistoryResponse({devices: [device(), device('device-a')]}), HistoryInputError);
  assert.throws(() => normalizeHistoryResponse({devices: [device('device-a', {history: {...device().history, daily: [{date: '2026-02-30', tokens: 1, cost: 1}]}})]}), /daily period key/);
  assert.throws(() => normalizeHistoryResponse({devices: [device('device-a', {history: {...device().history, daily: [{date: '2026-09-01', tokens: -1, cost: 1}]}})]}), /daily tokens/);
});

test('History storage replaces rows, retains omitted rows, and records current source state', () => {
  const db = openDatabase(':memory:');
  try {
    const first = normalizeHistoryResponse({devices: [device()]});
    const firstAt = '2026-09-08T12:01:00.000Z';
    const firstId = db.transaction(() => beginHistoryFetch(db, 'hub-a', firstAt));
    db.transaction(() => storeHistorySnapshot(db, 'hub-a', first, firstId, firstAt));
    let result = readUsageHistory(db, {hubId: 'hub-a', deviceId: 'device-a', granularity: 'daily', from: '2026-09-01', to: '2026-09-30'});
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[1].tokens, 100);
    assert.equal(result.rows[1].current, true);

    const correctedDevice = device('device-a', {history: {...device().history, daily: [device().history.daily[1]]}});
    const second = normalizeHistoryResponse({devices: [correctedDevice]});
    const secondAt = '2026-09-08T12:02:00.000Z';
    const secondId = db.transaction(() => beginHistoryFetch(db, 'hub-a', secondAt));
    db.transaction(() => storeHistorySnapshot(db, 'hub-a', second, secondId, secondAt));
    result = readUsageHistory(db, {hubId: 'hub-a', deviceId: 'device-a', granularity: 'daily', from: '2026-09-01', to: '2026-09-30'});
    assert.equal(result.rows.length, 2, 'omitted older rows remain available');
    assert.equal(result.rows[0].current, false, 'omitted rows are visibly older than the current fetch');
    assert.equal(result.rows[1].confirmedFetchId, secondId);

    const status = historyFetchStatus(db, 'hub-a');
    assert.equal(status.latestSuccessFetchId, secondId);
    assert.equal(status.lastStatus, 'success');
    assert.equal(result.source.historyState, 'available');
    assert.equal(result.source.timeZone, 'Asia/Tokyo');
    assert.equal(result.rows[1].sourceTimeZone, null, 'current period window does not establish old row date basis');

    const staleAt = '2026-09-08T12:03:00.000Z';
    const staleId = db.transaction(() => beginHistoryFetch(db, 'hub-a', staleAt));
    const currentId = db.transaction(() => beginHistoryFetch(db, 'hub-a', '2026-09-08T12:04:00.000Z'));
    assert.notEqual(staleId, currentId);
    assert.throws(() => db.transaction(() => storeHistorySnapshot(db, 'hub-a', first, staleId, staleAt)), /stale history fetch/);
    db.transaction(() => storeHistorySnapshot(db, 'hub-a', first, currentId, '2026-09-08T12:04:00.000Z'));
  } finally { db.close(); }
});

test('History storage distinguishes deletion, disabled, null, and missing capability without erasing rows', () => {
  const db = openDatabase(':memory:');
  try {
    const initial = normalizeHistoryResponse({devices: [device(), device('device-b')]});
    const at = '2026-09-08T12:01:00.000Z';
    const id = db.transaction(() => beginHistoryFetch(db, 'hub-a', at));
    db.transaction(() => storeHistorySnapshot(db, 'hub-a', initial, id, at));
    const next = normalizeHistoryResponse({devices: [
      device('device-a', {historyAvailable: false, history: null}),
    ]});
    const nextAt = '2026-09-08T12:02:00.000Z';
    const nextId = db.transaction(() => beginHistoryFetch(db, 'hub-a', nextAt));
    db.transaction(() => storeHistorySnapshot(db, 'hub-a', next, nextId, nextAt));
    const disabled = readUsageHistory(db, {hubId: 'hub-a', deviceId: 'device-a', granularity: 'daily', from: '2026-09-01', to: '2026-09-30'});
    const deleted = readUsageHistory(db, {hubId: 'hub-a', deviceId: 'device-b', granularity: 'daily', from: '2026-09-01', to: '2026-09-30'});
    assert.equal(disabled.source.historyState, 'disabled');
    assert.equal(disabled.source.presence, 'present');
    assert.equal(disabled.rows.length, 2);
    assert.equal(disabled.rows.every(row => row.current === false), true);
    assert.equal(deleted.source.historyState, 'deleted');
    assert.equal(deleted.source.presence, 'deleted');
    assert.equal(deleted.source.timeZone, null);
    assert.equal(deleted.rows.length, 2);

    const missingRaw = device('device-a');
    delete missingRaw.historyAvailable;
    delete missingRaw.history;
    const missing = normalizeHistoryResponse({devices: [missingRaw]});
    const missingAt = '2026-09-08T12:03:00.000Z';
    const missingId = db.transaction(() => beginHistoryFetch(db, 'hub-a', missingAt));
    db.transaction(() => storeHistorySnapshot(db, 'hub-a', missing, missingId, missingAt));
    assert.equal(readUsageHistory(db, {hubId: 'hub-a', deviceId: 'device-a', granularity: 'daily', from: '2026-09-01', to: '2026-09-30'}).source.historyState, 'missing_capability');
  } finally { db.close(); }
});

test('History fetch uses authentication, refuses redirects, and enforces the 16 MiB body limit', async () => {
  let received = null;
  const server = http.createServer((request, response) => {
    received = request;
    response.writeHead(200, {'content-type': 'application/json'});
    response.end(JSON.stringify({devices: [device()]}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await fetchHistory({hub: {...hub, url}});
    assert.equal(result.devices.length, 1);
    assert.equal(received.headers.authorization, 'Bearer hub-secret');
    await assert.rejects(() => fetchHistory({hub: {...hub, url}, fetchImpl: async () => new Response(null, {status: 404})}), HistoryUnsupportedError);
    const tooLarge = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(MAX_HISTORY_BODY_BYTES + 1)); controller.close(); },
    }), {status: 200, headers: {'content-type': 'application/json'}});
    await assert.rejects(() => fetchHistory({hub: {...hub, url}, maxBodyBytes: MAX_HISTORY_BODY_BYTES, fetchImpl: async () => tooLarge}), /body limit/);
  } finally { server.close(); }
});

test('History protocol errors are permanent while transport errors are retryable', async () => {
  let protocolCalls = 0;
  const protocolStatuses = [];
  const protocolScheduler = createHistoryScheduler({
    minIntervalMs: 0,
    maxRetries: 3,
    fetchImpl: async () => {
      protocolCalls += 1;
      return new Response('{}', {status: 200, headers: {'content-type': 'text/plain'}});
    },
    onFailure: ({errorCode}) => protocolStatuses.push(errorCode),
  });
  await protocolScheduler.startHub(hub, 1);
  await waitFor(() => protocolStatuses.length === 1);
  assert.equal(protocolCalls, 1);
  assert.equal(protocolStatuses[0], 'input_error');
  await protocolScheduler.stop();

  let transportCalls = 0;
  const transportStatuses = [];
  let clock = 0;
  const sleeps = [];
  const transportScheduler = createHistoryScheduler({
    minIntervalMs: 5000,
    maxRetries: 2,
    now: () => clock,
    sleep: async delay => { sleeps.push(delay); clock += delay; },
    fetchImpl: async () => {
      transportCalls += 1;
      return new Response(null, {status: 500});
    },
    onFailure: ({errorCode, attempts}) => transportStatuses.push({errorCode, attempts}),
  });
  await transportScheduler.startHub(hub, 1);
  await waitFor(() => transportStatuses.length === 1);
  assert.equal(transportCalls, 3);
  assert.deepEqual(transportStatuses[0], {errorCode: 'network_error', attempts: 3});
  assert.deepEqual(sleeps, [5000, 5000]);
  await transportScheduler.stop();
});

test('History scheduler coalesces revisions and retains dirty state through failures', async () => {
  let calls = 0;
  let release;
  let gate = new Promise(resolve => { release = resolve; });
  const successes = [];
  const scheduler = createHistoryScheduler({
    minIntervalMs: 0,
    maxRetries: 0,
    fetchImpl: async () => { calls += 1; return responseFor([device()]); },
    onSuccess: async value => { successes.push(value); await gate; },
  });
  await scheduler.startHub(hub, 1);
  await waitFor(() => calls === 1);
  assert.equal(scheduler.notifyRevision('hub-a', 'stale-revision', 2), false);
  assert.equal(scheduler.notifyRevision('hub-a', 'rev-1'), true);
  assert.equal(scheduler.notifyRevision('hub-a', 'rev-1'), true);
  assert.equal(scheduler.notifyRevision('hub-a', 'rev-2'), true);
  release();
  await waitFor(() => calls === 2);
  assert.equal(successes.length, 2);
  await scheduler.stop();

  let failedCalls = 0;
  const failureScheduler = createHistoryScheduler({
    minIntervalMs: 0,
    maxRetries: 0,
    fetchImpl: async () => { failedCalls += 1; return responseFor([], 500); },
  });
  await failureScheduler.startHub(hub, 2);
  await waitFor(() => failureScheduler.getStatus()[0]?.state === 'error');
  assert.equal(failedCalls, 1);
  failureScheduler.notifyRevision('hub-a', 'rev-after-failure');
  await waitFor(() => failedCalls === 2);
  await failureScheduler.stop();
});

test('History scheduler waits for an in-flight generation before replacement', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let successStarted = false;
  let calls = 0;
  const scheduler = createHistoryScheduler({
    minIntervalMs: 0,
    maxRetries: 0,
    fetchImpl: async () => { calls += 1; return responseFor([device()]); },
    onSuccess: async () => { successStarted = true; await gate; },
  });
  await scheduler.startHub(hub, 1);
  await waitFor(() => successStarted);
  let replaced = false;
  const replacement = scheduler.startHub(hub, 2).then(() => { replaced = true; });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(replaced, false);
  release();
  await replacement;
  await waitFor(() => calls === 2);
  assert.equal(scheduler.getStatus()[0].generation, 2);
  await scheduler.stop();
});

test('History scheduler cancels a queued replacement when stopHub races retirement', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let successStarted = false;
  let calls = 0;
  const scheduler = createHistoryScheduler({
    minIntervalMs: 0,
    maxRetries: 0,
    fetchImpl: async () => { calls += 1; return responseFor([]); },
    onSuccess: async () => { successStarted = true; await gate; },
  });
  await scheduler.startHub(hub, 1);
  await waitFor(() => successStarted);

  const replacement = scheduler.startHub(hub, 2);
  // The replacement has removed generation 1 while waiting for its save.
  await waitFor(() => scheduler.getStatus().length === 0);
  let stopped = false;
  const stopping = scheduler.stopHub(hub.id).then(() => { stopped = true; });
  let replacementResult;
  const replacementDone = replacement.then(result => { replacementResult = result; });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(stopped, false);
  assert.equal(replacementResult, undefined);

  release();
  await Promise.all([stopping, replacementDone]);
  assert.equal(replacementResult, null);
  assert.deepEqual(scheduler.getStatus(), []);
  assert.equal(calls, 1);
});

test('History scheduler stop waits for a replacement that is retiring a save', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let successStarted = false;
  let calls = 0;
  const scheduler = createHistoryScheduler({
    minIntervalMs: 0,
    maxRetries: 0,
    fetchImpl: async () => { calls += 1; return responseFor([]); },
    onSuccess: async () => { successStarted = true; await gate; },
  });
  await scheduler.startHub(hub, 1);
  await waitFor(() => successStarted);
  const replacement = scheduler.startHub(hub, 2);
  await waitFor(() => scheduler.getStatus().length === 0);

  let stopped = false;
  const stopping = scheduler.stop().then(() => { stopped = true; });
  let replacementResult;
  const replacementDone = replacement.then(result => { replacementResult = result; });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(stopped, false);
  assert.equal(replacementResult, undefined);

  release();
  await Promise.all([stopping, replacementDone]);
  assert.equal(replacementResult, null);
  assert.deepEqual(scheduler.getStatus(), []);
  assert.equal(calls, 1);
});

test('History scheduler keeps the next run in flight after a synchronous follow-up starts', async () => {
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  let releaseSecond;
  const secondGate = new Promise(resolve => { releaseSecond = resolve; });
  let firstSuccessStarted = false;
  let secondFetchStarted = false;
  let successCount = 0;
  let fetchStartCount = 0;
  const scheduler = createHistoryScheduler({
    minIntervalMs: 0,
    maxRetries: 0,
    fetchImpl: async () => responseFor([]),
    onFetchStart: async () => {
      fetchStartCount += 1;
      if (fetchStartCount === 2) {
        secondFetchStarted = true;
        await secondGate;
      }
    },
    onSuccess: async () => {
      successCount += 1;
      if (successCount === 1) {
        firstSuccessStarted = true;
        await firstGate;
      }
    },
  });
  await scheduler.startHub(hub, 1);
  await waitFor(() => firstSuccessStarted);
  scheduler.notifyRevision(hub.id, 'revision-2');
  releaseFirst();
  await waitFor(() => secondFetchStarted);

  scheduler.request(hub.id, 'manual');
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(fetchStartCount, 2);

  releaseSecond();
  await waitFor(() => fetchStartCount === 3);
  await scheduler.stop();
});

test('History persistence callback failures are fatal and concurrent starts are serialized', async () => {
  const startFatal = [];
  const startScheduler = createHistoryScheduler({
    minIntervalMs: 0,
    maxRetries: 0,
    onFetchStart: async () => { throw new Error('database unavailable'); },
    onFatal: error => startFatal.push(error),
  });
  await startScheduler.startHub(hub, 1);
  await waitFor(() => startFatal.length === 1);
  assert.equal(startFatal[0].code, 'storage_error');
  await startScheduler.stop();

  const successFatal = [];
  const successScheduler = createHistoryScheduler({
    minIntervalMs: 0,
    maxRetries: 0,
    fetchImpl: async () => responseFor([device()]),
    onSuccess: async () => { throw new Error('database unavailable'); },
    onFatal: error => successFatal.push(error),
  });
  await successScheduler.startHub(hub, 1);
  await waitFor(() => successFatal.length === 1);
  assert.equal(successFatal[0].code, 'storage_error');
  await successScheduler.stop();

  const failureFatal = [];
  const failureScheduler = createHistoryScheduler({
    minIntervalMs: 0,
    maxRetries: 0,
    fetchImpl: async () => responseFor([], 500),
    onFailure: async () => { throw new Error('database unavailable'); },
    onFatal: error => failureFatal.push(error),
  });
  await failureScheduler.startHub(hub, 1);
  await waitFor(() => failureFatal.length === 1);
  assert.equal(failureFatal[0].code, 'storage_error');
  await failureScheduler.stop();

  let calls = 0;
  const serialized = createHistoryScheduler({
    minIntervalMs: 0,
    maxRetries: 0,
    fetchImpl: async () => { calls += 1; return responseFor([]); },
  });
  const first = serialized.startHub(hub, 1);
  const second = serialized.startHub(hub, 2);
  const [firstRunner, secondRunner] = await Promise.all([first, second]);
  assert.equal(firstRunner, null, 'an older queued desired generation is canceled');
  assert.equal(secondRunner.generation, 2);
  assert.equal(serialized.getStatus()[0].generation, 2);
  await waitFor(() => calls === 1);
  await serialized.stop();
});

test('History fetch failures update only bookkeeping and never overwrite retained rows', () => {
  const db = openDatabase(':memory:');
  try {
    const valid = normalizeHistoryResponse({devices: [device()]});
    const at = '2026-09-08T12:01:00.000Z';
    const id = db.transaction(() => beginHistoryFetch(db, 'hub-a', at));
    db.transaction(() => storeHistorySnapshot(db, 'hub-a', valid, id, at));
    const failedAt = '2026-09-08T12:02:00.000Z';
    const failedId = db.transaction(() => beginHistoryFetch(db, 'hub-a', failedAt));
    assert.throws(() => db.transaction(() => recordHistoryFetchFailure(db, 'hub-a', failedId, 'Bearer secret should never be stored')), /invalid history fetch error code/);
    db.transaction(() => recordHistoryFetchFailure(db, 'hub-a', failedId, 'network_error', failedAt));
    const rows = readUsageHistory(db, {hubId: 'hub-a', deviceId: 'device-a', granularity: 'daily', from: '2026-09-01', to: '2026-09-30'}).rows;
    assert.equal(rows.length, 2);
    assert.equal(historyFetchStatus(db, 'hub-a').lastStatus, 'error');
  } finally { db.close(); }
});

test('History fetch and SQLite store work across a real HTTP boundary', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-history-http-'));
  const hubServer = http.createServer((request, response) => {
    if (request.url === '/api/devices') {
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(JSON.stringify({devices: [device()]}));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise(resolve => hubServer.listen(0, '127.0.0.1', resolve));
  const hubUrl = `http://127.0.0.1:${hubServer.address().port}`;
  const db = openDatabase(path.join(dir, 'analytics.db'));
  try {
    const response = await fetchHistory({hub: {...hub, url: hubUrl}});
    const at = new Date().toISOString();
    const fetchId = db.transaction(() => beginHistoryFetch(db, 'hub-a', at));
    db.transaction(() => storeHistorySnapshot(db, 'hub-a', response, fetchId, at));
    assert.equal(db.prepare('SELECT count(*) AS n FROM usage_periods WHERE hub_id=? AND device_id=? AND granularity=?').bind('hub-a', 'device-a', 'daily').get().n, 2);
    assert.equal(db.prepare('SELECT last_status FROM usage_fetches WHERE hub_id=?').bind('hub-a').get().last_status, 'success');
  } finally {
    db.close();
    await new Promise(resolve => hubServer.close(resolve));
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('SSE forwards device-history revision notifications without using SSE device records', async () => {
  const controller = new AbortController();
  const revisions = [];
  const connected = [];
  await subscribeLoop({
    hub: {...hub, url: 'http://127.0.0.1:1'},
    signal: controller.signal,
    fetchImpl: async () => new Response(
      'event: stats\ndata: ' + JSON.stringify({stats: {deviceHistoryRevision: 'opaque-revision', devices: [{history: {daily: []}}]}}) + '\n\n',
      {status: 200, headers: {'content-type': 'text/event-stream'}},
    ),
    onConnected: event => connected.push(event.streamId),
    onRevision: event => { revisions.push(event.revision); controller.abort(); },
  });
  assert.equal(connected.length, 1);
  assert.deepEqual(revisions, ['opaque-revision']);
});
