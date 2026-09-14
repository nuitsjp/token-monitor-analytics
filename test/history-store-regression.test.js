import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { AnalyticsStore, validateHistoryQuery } from '../src/store.js';

const F0 = '2026-09-15T00:00:00.000Z';
const F1 = '2026-09-15T01:00:00.000Z';
const PREFIX = 'analytics-history-regression-';

function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), PREFIX));
  const dbPath = join(directory, 'analytics.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, dbPath };
}

function historyRecord(deviceId, period, tool, value, metadata = {}) {
  return {
    deviceId, date: period, tool, tokens: value * 100, cost: value,
    ...metadata,
  };
}

function monthlyRecord(deviceId, month, tool, value, metadata = {}) {
  return {
    deviceId, month, tool, tokens: value * 100, cost: value,
    ...metadata,
  };
}

function seedCurrentData(dbPath) {
  const store = new AnalyticsStore(dbPath);
  store.registerHubs(['hub-a']);
  const observation = { updatedAt: F0, periods: {}, limits: { providers: [] } };
  store.commitNotification('hub-a', {
    hubCurrent: { updatedAt: F0 },
    devices: [{
      deviceId: 'device-a', metadata: { stale: false }, observation,
      comparisonJson: JSON.stringify(observation),
    }],
  }, F0);
  store.commitHistory('hub-a', {
    daily: [historyRecord('device-a', '2026-09-14', 'codex', 3)],
    monthly: [monthlyRecord('device-a', '2026-09', 'codex', 3)],
  }, F0);
  store.close();
}

function downgrade(dbPath, version) {
  const db = new DatabaseSync(dbPath);
  if (version <= 7) {
    db.exec('DROP TABLE estimation_inputs; DROP TABLE estimation_runtime; DROP TABLE daily_usage; DROP TABLE monthly_usage; DROP TABLE history_fetch_state;');
  } else if (version === 8) {
    db.exec('DROP TABLE daily_usage; DROP TABLE monthly_usage; DROP TABLE history_fetch_state;');
  } else if (version === 9) {
    db.exec('ALTER TABLE history_fetch_state DROP COLUMN devices_json;');
    db.prepare('UPDATE daily_usage SET record_json = ?').run(JSON.stringify({ tokens: 300, cost: 3 }));
    db.prepare('UPDATE monthly_usage SET record_json = ?').run(JSON.stringify({ tokens: 300, cost: 3 }));
  }
  db.exec(`PRAGMA user_version = ${version}`);
  const before = {
    hubs: db.prepare('SELECT * FROM hubs ORDER BY id').all(),
    observations: db.prepare('SELECT * FROM observations ORDER BY id').all(),
    currentDevices: db.prepare('SELECT * FROM current_devices ORDER BY hub_id, device_id').all(),
    daily: db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'daily_usage'").all(),
  };
  db.close();
  return before;
}

for (const version of [3, 4, 5, 6, 7, 8, 9]) {
  test(`schema ${version} accepts the historical shape and migrates to schema 10`, (t) => {
    const { dbPath } = workspace(t);
    seedCurrentData(dbPath);
    const before = downgrade(dbPath, version);

    const store = new AnalyticsStore(dbPath);
    const fetchState = store.readHistoryFetchState('hub-a');
    if (version === 9) assert.equal(fetchState?.devices.length, 0);
    else assert.equal(fetchState, null);
    const after = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(after.prepare('PRAGMA user_version').get().user_version, 10);
      assert.deepEqual(after.prepare('SELECT * FROM hubs ORDER BY id').all(), before.hubs);
      assert.deepEqual(after.prepare('SELECT * FROM observations ORDER BY id').all(), before.observations);
      assert.deepEqual(after.prepare('SELECT * FROM current_devices ORDER BY hub_id, device_id').all(), before.currentDevices);
      assert.equal(after.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('daily_usage', 'monthly_usage', 'history_fetch_state')").get().count, 3);
      assert.equal(after.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(after.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      after.close();
      store.close();
    }

    if (version === 9) {
      const reopened = new AnalyticsStore(dbPath);
      try {
        const [daily, monthly] = [
          reopened.readHistory({ kind: 'daily', hubId: 'hub-a' }).items[0],
          reopened.readHistory({ kind: 'monthly', hubId: 'hub-a' }).items[0],
        ];
        assert.equal(daily.todayKey, null);
        assert.equal(daily.timeZone, null);
        assert.equal(daily.fetchedAt, null);
        assert.equal(monthly.todayKey, null);
        assert.equal(monthly.timeZone, null);
        assert.equal(monthly.fetchedAt, null);
      } finally {
        reopened.close();
      }
    }
  });
}

function collectPages(store, kind, limit) {
  const items = [];
  let before;
  while (true) {
    const page = store.readHistory({ kind, limit, before });
    items.push(...page.items);
    if (!page.nextCursor) return items;
    before = page.nextCursor;
  }
}

test('history cursors continue through equal days and months without duplicates', (t) => {
  const { dbPath } = workspace(t);
  const store = new AnalyticsStore(dbPath);
  store.registerHubs(['hub-a', 'hub-b']);
  for (const [hubId, deviceId, tool, value] of [
    ['hub-a', 'device-a', 'codex', 1],
    ['hub-a', 'device-a', 'grok', 2],
    ['hub-a', 'device-b', 'codex', 3],
    ['hub-b', 'device-a', 'codex', 4],
    ['hub-b', 'device-b', 'grok', 5],
  ]) {
    store.commitHistory(hubId, {
      daily: [historyRecord(deviceId, '2026-09-14', tool, value)],
      monthly: [monthlyRecord(deviceId, '2026-09', tool, value)],
    }, F0);
  }
  store.commitHistory('hub-a', {
    daily: [historyRecord('device-a', '2026-09-13', 'codex', 6)],
    monthly: [monthlyRecord('device-a', '2026-08', 'codex', 6)],
  }, F1);

  for (const kind of ['daily', 'monthly']) {
    const complete = store.readHistory({ kind, limit: 500 }).items;
    const paged = collectPages(store, kind, 2);
    assert.deepEqual(paged, complete);
    assert.equal(new Set(paged.map((item) => JSON.stringify(item))).size, paged.length);
    assert.ok(paged.slice(0, 5).every((item) => (kind === 'daily' ? item.date : item.month) === (kind === 'daily' ? '2026-09-14' : '2026-09')));
  }
  store.close();
});

test('history query and cursor validation reject malformed boundaries', (t) => {
  const { dbPath } = workspace(t);
  const store = new AnalyticsStore(dbPath);
  store.registerHubs(['hub-a']);
  store.commitHistory('hub-a', {
    daily: [historyRecord('device-a', '2026-09-14', 'codex', 1)],
  }, F0);
  const cursor = store.readHistory({ kind: 'daily', limit: 1 }).nextCursor;
  assert.equal(cursor, null);

  const encoded = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const malformed = [
    '', 'not-base64!', encoded(null),
    encoded({ kind: 'daily', period: '2026-09-14', hubId: 'hub-a', deviceId: 'device-a' }),
    encoded({ kind: 'monthly', period: '2026-09', hubId: 'hub-a', deviceId: 'device-a', tool: 'codex' }),
  ];
  for (const before of malformed) assert.throws(() => store.readHistory({ before }), TypeError);
  assert.throws(() => store.readHistory({ kind: 'monthly', before: encoded({ kind: 'daily', period: '2026-09-14', hubId: 'hub-a', deviceId: 'device-a', tool: 'codex' }) }), TypeError);
  for (const options of [
    { kind: 'weekly' },
    { kind: 'daily', from: '2026-02-30' },
    { kind: 'monthly', to: '2026-13' },
    { kind: 'daily', from: '2026-09-15', to: '2026-09-14' },
    { limit: 0 }, { limit: 501 }, { limit: 1.5 }, { before: 1 },
  ]) {
    assert.throws(() => validateHistoryQuery(options), TypeError);
    assert.throws(() => store.readHistory(options), TypeError);
  }
  store.close();
});

test('history fetch metadata is persisted with rows and restored after restart', (t) => {
  const { dbPath } = workspace(t);
  const store = new AnalyticsStore(dbPath);
  store.registerHubs(['hub-a']);
  const metadata = {
    todayKey: '2026-09-15', timeZone: 'Asia/Tokyo', fetchedAt: F1,
  };
  const deviceState = { deviceId: 'device-a', todayKey: metadata.todayKey, timeZone: metadata.timeZone, dailyStatus: 'available' };
  store.commitHistory('hub-a', {
    devices: [deviceState],
    daily: [historyRecord('device-a', '2026-09-14', 'codex', 3, metadata)],
    monthly: [monthlyRecord('device-a', '2026-09', 'codex', 3, metadata)],
  }, F1);
  const expectedState = {
    hubId: 'hub-a', lastSuccessAt: F1, lastAttemptAt: F1,
    devices: [deviceState],
  };
  assert.deepEqual(store.readHistoryFetchState('hub-a'), expectedState);
  const expectedDaily = store.readHistory({ kind: 'daily', hubId: 'hub-a' }).items[0];
  assert.deepEqual(expectedDaily, {
    hubId: 'hub-a', deviceId: 'device-a', date: '2026-09-14', tool: 'codex',
    tokens: 300, cost: 3, ...metadata,
  });
  store.close();

  const reopened = new AnalyticsStore(dbPath);
  try {
    assert.deepEqual(reopened.readHistoryFetchState('hub-a'), expectedState);
    assert.deepEqual(reopened.readHistory({ kind: 'daily', hubId: 'hub-a' }).items[0], expectedDaily);
  } finally {
    reopened.close();
  }
});
