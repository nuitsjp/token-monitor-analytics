import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { AnalyticsStore } from '../src/store.js';

const T0 = '2026-09-13T00:00:00.000Z';
const T1 = '2026-09-13T00:01:00.000Z';
const T2 = '2026-09-13T00:02:00.000Z';
const RESET_AT = '2026-09-14T00:00:00.000Z';
const WORKSPACE_PREFIX = 'token-monitor-analytics-';

function assertSafeWorkspace(directory) {
  const resolved = resolve(directory);
  assert.equal(dirname(resolved).toLowerCase(), resolve(tmpdir()).toLowerCase());
  assert.equal(basename(resolved).startsWith(WORKSPACE_PREFIX), true);
  return resolved;
}

function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), WORKSPACE_PREFIX));
  const stores = [];
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(assertSafeWorkspace(directory), { recursive: true, force: true });
  });
  return {
    directory,
    dbPath: join(directory, 'analytics.sqlite'),
    track(store) {
      stores.push(store);
      return store;
    }
  };
}

function device(deviceId, value, metadata = {}) {
  const observation = {
    updatedAt: T0,
    periods: { today: { totalTokens: value, costUsd: value / 10 } },
    limits: { providers: [] }
  };
  return {
    deviceId,
    observation,
    comparisonJson: JSON.stringify(observation),
    metadata: {
      hostname: `${deviceId}-host`,
      receivedAt: T0,
      ageMs: 0,
      stale: false,
      ...metadata
    }
  };
}

function notification(entries, aggregateValue = 0) {
  return {
    hubCurrent: {
      updatedAt: T0,
      periods: { today: { totalTokens: aggregateValue, costUsd: aggregateValue / 10 } },
      limits: { providers: [] }
    },
    devices: entries
  };
}

function estimationDevice(deviceId, cost, usedPercent, measuredAt) {
  const observation = {
    updatedAt: measuredAt,
    periods: {
      allTime: { clientCosts: { codex: cost } }
    },
    clientHealth: {
      observedAt: measuredAt,
      clients: {
        codex: {
          overall: 'healthy',
          source: { state: 'detected' },
          collection: { state: 'direct' }
        }
      }
    },
    limits: {
      providers: [{
        provider: 'codex',
        accountKey: 'account-a',
        accountLabel: 'Account A',
        planLabel: 'Plus',
        status: 'ok',
        stale: false,
        updatedAt: measuredAt,
        windows: [{
          kind: 'session',
          limitId: 'codex',
          label: 'Session',
          usedPercent,
          resetsAt: RESET_AT
        }]
      }]
    }
  };
  return {
    deviceId,
    observation,
    comparisonJson: JSON.stringify(observation),
    metadata: { receivedAt: measuredAt, ageMs: 0, stale: false }
  };
}

function estimationNotification(entries) {
  return notification(entries, entries.reduce(
    (sum, entry) => sum + (entry.observation.periods.allTime.clientCosts.codex ?? 0),
    0
  ));
}

function observationRows(dbPath, hubId, deviceId) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(`
      SELECT id, observation_json
      FROM observations
      WHERE hub_id = ? AND device_id = ?
      ORDER BY id
    `).all(hubId, deviceId);
  } finally {
    db.close();
  }
}

test('registers hubs without replacing existing state', (t) => {
  const { dbPath, track } = workspace(t);
  const store = track(new AnalyticsStore(dbPath));

  store.registerHubs(['hub-b', 'hub-a']);
  store.commitNotification('hub-a', notification([device('device-a', 10)], 10), T0);
  store.registerHubs(['hub-a', 'hub-c', 'hub-c']);

  const state = store.readState();
  assert.deepEqual(state.hubs.map((hub) => hub.id), ['hub-a', 'hub-b', 'hub-c']);
  assert.equal(state.hubs[0].collectionEnabled, true);
  assert.equal(state.hubs[0].devices[0].observation.periods.today.totalTokens, 10);
  assert.equal(state.hubs[1].aggregate, null);
  assert.equal(state.hubs[1].receivedAt, null);
});

test('creates the parent directory only for a new database', (t) => {
  const { directory, track } = workspace(t);
  const dbPath = join(directory, 'nested', 'data', 'analytics.sqlite');
  const store = track(new AnalyticsStore(dbPath));
  store.registerHubs(['hub-a']);
  store.close();

  const reopened = track(new AnalyticsStore(dbPath));
  assert.deepEqual(reopened.readState().hubs.map((hub) => hub.id), ['hub-a']);
  reopened.close();
});

test('same content updates current metadata and receipt without appending an observation', (t) => {
  const { dbPath, track } = workspace(t);
  const store = track(new AnalyticsStore(dbPath));
  store.registerHubs(['hub-a']);

  store.commitNotification('hub-a', notification([device('device-a', 10)], 10), T0);
  const first = store.readState().hubs[0];
  const repeated = device('device-a', 10, { ageMs: 60_000, stale: true });
  store.commitNotification('hub-a', notification([repeated], 11), T1);
  const second = store.readState().hubs[0];

  assert.equal(second.receivedAt, T1);
  assert.equal(second.aggregate.periods.today.totalTokens, 11);
  assert.equal(second.devices[0].observationId, first.devices[0].observationId);
  assert.equal(second.devices[0].receivedAt, T1);
  assert.equal(second.devices[0].metadata.ageMs, 60_000);
  assert.equal(second.devices[0].metadata.stale, true);
  assert.equal(observationRows(dbPath, 'hub-a', 'device-a').length, 1);
});

test('A-B-A transitions append each change while consecutive duplicates do not', (t) => {
  const { dbPath, track } = workspace(t);
  const store = track(new AnalyticsStore(dbPath));
  store.registerHubs(['hub-a']);

  store.commitNotification('hub-a', notification([device('device-a', 1)], 1), T0);
  store.commitNotification('hub-a', notification([device('device-a', 2)], 2), T1);
  store.commitNotification('hub-a', notification([device('device-a', 1)], 1), T2);
  store.commitNotification('hub-a', notification([device('device-a', 1)], 1), T2);

  const rows = observationRows(dbPath, 'hub-a', 'device-a');
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => JSON.parse(row.observation_json).periods.today.totalTokens),
    [1, 2, 1]
  );
});

test('the same device id in different hubs has independent observation series', (t) => {
  const { dbPath, track } = workspace(t);
  const store = track(new AnalyticsStore(dbPath));
  store.registerHubs(['hub-a', 'hub-b']);

  store.commitNotification('hub-a', notification([device('device-a', 10)], 10), T0);
  store.commitNotification('hub-b', notification([device('device-a', 20)], 20), T1);

  const [hubA, hubB] = store.readState().hubs;
  assert.equal(hubA.devices[0].observation.periods.today.totalTokens, 10);
  assert.equal(hubB.devices[0].observation.periods.today.totalTokens, 20);
  assert.notEqual(hubA.devices[0].observationId, hubB.devices[0].observationId);
});

test('missing devices retain their observation and receipt until they return', (t) => {
  const { dbPath, track } = workspace(t);
  const store = track(new AnalyticsStore(dbPath));
  store.registerHubs(['hub-a']);

  store.commitNotification('hub-a', notification([device('device-a', 10)], 10), T0);
  const initial = store.readState().hubs[0].devices[0];
  store.commitNotification('hub-a', notification([], 0), T1);
  const missing = store.readState().hubs[0].devices[0];

  assert.equal(missing.present, false);
  assert.equal(missing.observationId, initial.observationId);
  assert.equal(missing.receivedAt, T0);
  assert.deepEqual(missing.observation, initial.observation);

  store.commitNotification('hub-a', notification([device('device-a', 10)], 10), T2);
  const returned = store.readState().hubs[0].devices[0];
  assert.equal(returned.present, true);
  assert.equal(returned.observationId, initial.observationId);
  assert.equal(returned.receivedAt, T2);
  assert.equal(observationRows(dbPath, 'hub-a', 'device-a').length, 1);
});

test('a failure while saving the second device rolls back the whole notification', (t) => {
  const { dbPath, track } = workspace(t);
  const store = track(new AnalyticsStore(dbPath));
  store.registerHubs(['hub-a']);
  store.commitNotification(
    'hub-a',
    notification([device('device-a', 1), device('device-b', 1)], 2),
    T0
  );
  const before = store.readState();

  const invalidMetadata = {};
  invalidMetadata.self = invalidMetadata;
  assert.throws(() => {
    store.commitNotification(
      'hub-a',
      notification([
        device('device-a', 2),
        device('device-b', 2, invalidMetadata)
      ], 4),
      T1
    );
  }, /circular/i);

  assert.deepEqual(store.readState(), before);
  assert.equal(observationRows(dbPath, 'hub-a', 'device-a').length, 1);
  assert.equal(observationRows(dbPath, 'hub-a', 'device-b').length, 1);
});

test('committed state is restored after reopening the database', (t) => {
  const { dbPath, track } = workspace(t);
  const first = track(new AnalyticsStore(dbPath));
  first.registerHubs(['hub-a']);
  first.commitNotification('hub-a', notification([device('device-a', 10)], 10), T0);
  const expected = first.readState();
  first.close();

  const reopened = track(new AnalyticsStore(dbPath));
  assert.deepEqual(reopened.readState(), expected);
});

test('an existing corrupt database is rejected without reinitializing it', (t) => {
  const { dbPath } = workspace(t);
  const corruptBytes = Buffer.from('not-a-sqlite-database');
  writeFileSync(dbPath, corruptBytes);

  assert.throws(() => new AnalyticsStore(dbPath));
  assert.deepEqual(readFileSync(dbPath), corruptBytes);
});

test('an existing database with the wrong schema version is rejected', (t) => {
  const { dbPath } = workspace(t);
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY) STRICT');
  db.close();

  assert.throws(() => new AnalyticsStore(dbPath), /schema is incompatible/);
});

test('a matching schema version with incompatible columns is rejected', (t) => {
  const { dbPath } = workspace(t);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE hubs (
      id INTEGER PRIMARY KEY,
      collection_enabled INTEGER NOT NULL,
      received_at TEXT,
      aggregate_json TEXT
    ) STRICT;
    PRAGMA user_version = 1;
  `);
  db.close();

  assert.throws(() => new AnalyticsStore(dbPath), /schema is incompatible/);
});

test('migrates a v1 database while preserving observations and adding estimation tables', (t) => {
  const { dbPath, track } = workspace(t);
  const oldDevice = device('device-a', 10);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE hubs (
      id TEXT PRIMARY KEY,
      collection_enabled INTEGER NOT NULL CHECK (collection_enabled IN (0, 1)),
      received_at TEXT,
      aggregate_json TEXT
    ) STRICT;
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY,
      hub_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      comparison_json TEXT NOT NULL,
      observation_json TEXT NOT NULL,
      FOREIGN KEY (hub_id) REFERENCES hubs(id)
    ) STRICT;
    CREATE INDEX observations_by_device ON observations (hub_id, device_id, id);
    CREATE TABLE current_devices (
      hub_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      observation_id INTEGER NOT NULL,
      received_at TEXT NOT NULL,
      present INTEGER NOT NULL CHECK (present IN (0, 1)),
      metadata_json TEXT NOT NULL,
      PRIMARY KEY (hub_id, device_id),
      FOREIGN KEY (hub_id) REFERENCES hubs(id),
      FOREIGN KEY (observation_id) REFERENCES observations(id)
    ) STRICT;
    PRAGMA user_version = 1;
  `);
  db.prepare(`
    INSERT INTO hubs (id, collection_enabled, received_at, aggregate_json)
    VALUES (?, 1, ?, ?)
  `).run('hub-a', T0, JSON.stringify(notification([]).hubCurrent));
  const observation = db.prepare(`
    INSERT INTO observations (hub_id, device_id, comparison_json, observation_json)
    VALUES (?, ?, ?, ?)
  `).run('hub-a', oldDevice.deviceId, oldDevice.comparisonJson, JSON.stringify(oldDevice.observation));
  db.prepare(`
    INSERT INTO current_devices (
      hub_id, device_id, observation_id, received_at, present, metadata_json
    ) VALUES (?, ?, ?, ?, 1, ?)
  `).run('hub-a', oldDevice.deviceId, observation.lastInsertRowid, T0, JSON.stringify(oldDevice.metadata));
  db.close();

  const store = track(new AnalyticsStore(dbPath));
  const state = store.readState();
  assert.equal(state.hubs[0].devices[0].observationId, observation.lastInsertRowid);
  assert.equal(state.hubs[0].devices[0].observation.periods.today.totalTokens, 10);
  assert.deepEqual(state.estimates, []);

  const reopenedDb = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(reopenedDb.prepare('PRAGMA user_version').get().user_version, 6);
    assert.equal(reopenedDb.prepare(`
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE type = 'table' AND name IN ('estimation_hubs', 'estimation_events')
    `).get().count, 2);
    assert.equal(reopenedDb.prepare(`
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE type = 'index' AND name = 'estimation_events_by_series'
    `).get().count, 1);
  } finally {
    reopenedDb.close();
  }
});

test('stores estimation checkpoint and events and restores them after reopening', (t) => {
  const { dbPath, track } = workspace(t);
  const store = track(new AnalyticsStore(dbPath));
  store.registerHubs(['hub-a']);

  store.commitNotification('hub-a', estimationNotification([
    estimationDevice('device-a', 10, 10, T0)
  ]), T0);
  store.commitNotification('hub-a', estimationNotification([
    estimationDevice('device-a', 20, 20, T1)
  ]), T1);

  const state = store.readState();
  assert.equal(state.estimates.length, 1);
  assert.equal(state.estimates[0].status, 'estimated');
  const history = store.readEstimationHistory({ hubId: 'hub-a' });
  assert.equal(history.items.length, 2);
  assert.equal(history.items[0].status, 'estimated');
  assert.equal(history.items[1].status, 'collecting');
  assert.equal(history.nextCursor, null);

  store.close();
  const reopened = track(new AnalyticsStore(dbPath));
  assert.deepEqual(reopened.readState().estimates, state.estimates);
  assert.deepEqual(reopened.readEstimationHistory({ hubId: 'hub-a' }), history);
});

test('reads estimation history in descending pages with hub and series filters', (t) => {
  const { dbPath, track } = workspace(t);
  const store = track(new AnalyticsStore(dbPath));
  store.registerHubs(['hub-a', 'hub-b']);

  store.commitNotification('hub-a', estimationNotification([
    estimationDevice('device-a', 10, 10, T0)
  ]), T0);
  store.commitNotification('hub-a', estimationNotification([
    estimationDevice('device-a', 20, 20, T1)
  ]), T1);
  store.commitNotification('hub-a', estimationNotification([
    estimationDevice('device-a', 30, 30, T2)
  ]), T2);
  const otherAccount = estimationDevice('device-a', 10, 10, T0);
  otherAccount.observation.limits.providers[0].accountKey = 'account-b';
  otherAccount.comparisonJson = JSON.stringify(otherAccount.observation);
  store.commitNotification('hub-b', estimationNotification([otherAccount]), T0);

  const firstPage = store.readEstimationHistory({ hubId: 'hub-a', limit: 2 });
  assert.equal(firstPage.items.length, 2);
  assert.equal(firstPage.items[0].recordedAt, T2);
  assert.equal(firstPage.items[1].recordedAt, T1);
  assert.equal(typeof firstPage.nextCursor, 'number');

  const secondPage = store.readEstimationHistory({
    hubId: 'hub-a',
    beforeId: firstPage.nextCursor,
    limit: 2
  });
  assert.deepEqual(secondPage.items.map((item) => item.recordedAt), [T0]);
  assert.equal(secondPage.nextCursor, null);

  const seriesId = firstPage.items[0].seriesId;
  const filtered = store.readEstimationHistory({ seriesId });
  assert.equal(filtered.items.length, 3);
  assert.equal(filtered.items.every((item) => item.seriesId === seriesId), true);
});

test('rolls back observations and estimation state when event insertion fails', (t) => {
  const { dbPath, track } = workspace(t);
  const store = track(new AnalyticsStore(dbPath));
  store.registerHubs(['hub-a']);
  store.commitNotification('hub-a', estimationNotification([
    estimationDevice('device-a', 10, 10, T0)
  ]), T0);
  const beforeState = store.readState();
  const beforeHistory = store.readEstimationHistory({ hubId: 'hub-a' });

  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TRIGGER fail_estimation_event
    BEFORE INSERT ON shared_estimation_events
    BEGIN
      SELECT RAISE(ABORT, 'injected estimation event failure');
    END;
  `);
  db.close();

  assert.throws(() => {
    store.commitNotification('hub-a', estimationNotification([
      estimationDevice('device-a', 20, 20, T1)
    ]), T1);
  }, /injected estimation event failure/);

  assert.deepEqual(store.readState(), beforeState);
  assert.deepEqual(store.readEstimationHistory({ hubId: 'hub-a' }), beforeHistory);
  assert.equal(observationRows(dbPath, 'hub-a', 'device-a').length, 1);
});

test('notifications for unregistered hubs do not create state', (t) => {
  const { dbPath, track } = workspace(t);
  const store = track(new AnalyticsStore(dbPath));

  assert.throws(
    () => store.commitNotification('missing', notification([device('device-a', 1)], 1), T0),
    /not registered/
  );
  const { metrics, ...saved } = store.readState();
  assert.deepEqual(saved, { hubs: [], contracts: [], estimates: [], legacyEstimateCount: 0 });
  assert.equal(metrics.periods.allTime.costUsd, null);
});

test('one contract spans Hubs and waits for both device clocks before estimating', (t) => {
  const { dbPath, track } = workspace(t);
  const store = track(new AnalyticsStore(dbPath));
  store.registerHubs(['private', 'work']);
  const send = (hub, cost, rate, at) => store.commitNotification(hub,
    estimationNotification([estimationDevice('same-device-name', cost, rate, at)]), at);
  send('private', 10, 10, T0);
  send('work', 10, 10, T0);
  send('private', 20, 20, T1);
  const pending = store.readState().estimates.find((view) => view.active);
  assert.equal(pending.reason, 'awaiting_refresh');
  assert.equal(pending.lastResult, null);
  send('work', 15, 20, T1);
  const state = store.readState();
  const estimate = state.estimates.find((view) => view.active);
  assert.equal(estimate.lastResult.baseCapacityUsd, 150);
  assert.equal(estimate.accounts.length, 1);
  assert.deepEqual(estimate.hubIds, ['private', 'work']);
  assert.equal(estimate.sources.length, 2);
  assert.equal(state.contracts.length, 1);
  assert.equal(state.contracts[0].sources.length, 2);
  assert.deepEqual(state.hubs[0].contractIds, state.hubs[1].contractIds);
  assert.equal(state.hubs[0].aggregate.periods.today.costUsd, 2);
  assert.equal(state.hubs[1].aggregate.periods.today.costUsd, 1.5);
  const history = store.readEstimationHistory({ hubId: 'work' });
  assert.equal(history.items[0].view.lastResult.baseCapacityUsd, 150);
  assert.equal(history.items[0].scope, 'global');
});

test('switching accounts preserves the many-to-many relationship and rolls back new links on failure', (t) => {
  const { dbPath, track } = workspace(t);
  const store = track(new AnalyticsStore(dbPath));
  store.registerHubs(['hub-a']);
  store.commitNotification('hub-a', estimationNotification([estimationDevice('device-a', 10, 10, T0)]), T0);
  const next = estimationDevice('device-a', 20, 20, T1);
  next.observation.limits.providers[0].accountKey = 'account-b';
  next.comparisonJson = JSON.stringify(next.observation);
  const before = store.readState();
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TRIGGER fail_shared BEFORE INSERT ON shared_estimation_events BEGIN SELECT RAISE(ABORT, 'new relationship rollback'); END;");
  assert.throws(() => store.commitNotification('hub-a', estimationNotification([next]), T1), /new relationship rollback/);
  assert.deepEqual(store.readState(), before);
  db.exec('DROP TRIGGER fail_shared');
  db.close();
  store.commitNotification('hub-a', estimationNotification([next]), T1);
  const state = store.readState();
  assert.equal(state.contracts.length, 2);
  assert.equal(state.contracts.filter((contract) => contract.current).length, 1);
  assert.equal(state.contracts.every((contract) => contract.sources.length === 1), true);
  assert.equal(state.contracts.find((contract) => contract.accountKey === 'account-a').sources[0].current, false);
  assert.equal(state.contracts.find((contract) => contract.accountKey === 'account-b').sources[0].current, true);
  assert.equal(state.estimates.find((view) => view.active).reason, 'missing_account_rate');
});

function makeV2Fixture(dbPath, invalidRegistry = false) {
  const store = new AnalyticsStore(dbPath);
  store.registerHubs(['private', 'work']);
  for (const hub of ['private', 'work']) {
    store.commitNotification(hub, estimationNotification([estimationDevice('device-a', 10, 10, T0)]), T0);
  }
  store.close();
  const db = new DatabaseSync(dbPath);
  db.exec('DROP TABLE shared_estimation_events; DROP TABLE shared_estimation_state; DROP TABLE device_contracts; DROP TABLE contracts; PRAGMA user_version = 2;');
  const oldView = { id: 'old-series', tool: 'codex', deviceIds: ['device-a'], status: 'estimated', lastResult: { baseCapacityUsd: 100 } };
  db.prepare('INSERT INTO estimation_hubs (hub_id, state_json) VALUES (?, ?)').run('private', JSON.stringify({
    registry: [{ deviceId: invalidRegistry ? 'unknown-device' : 'device-a', tool: 'codex', accounts: ['account-a'] }],
    groups: [{ view: oldView, baseline: { cost: 9999 }, latest: { cost: 99999 } }],
  }));
  db.prepare('INSERT INTO estimation_events (hub_id, series_id, recorded_at, status, event_json) VALUES (?, ?, ?, ?, ?)')
    .run('private', 'old-series', T0, 'estimated', JSON.stringify({ seriesId: 'old-series', recordedAt: T0, status: 'estimated', view: oldView }));
  const tables = ['hubs', 'observations', 'current_devices', 'estimation_hubs', 'estimation_events'];
  const before = Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  db.close();
  return before;
}

test('v2 migration preserves every old row, unifies contracts, and never reuses old comparison points', (t) => {
  const { dbPath, track } = workspace(t);
  const before = makeV2Fixture(dbPath);
  const store = track(new AnalyticsStore(dbPath));
  const db = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 6);
  for (const [table, rows] of Object.entries(before)) assert.deepEqual(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), rows);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM contracts').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM device_contracts').get().count, 2);
  db.close();
  assert.equal(store.readState().legacyEstimateCount, 1);
  assert.equal(store.readEstimationHistory({ scope: 'legacy' }).items[0].view.lastResult.baseCapacityUsd, 100);
  assert.deepEqual(store.readEstimationHistory().items, []);
  const send = (hub, cost, rate, at) => store.commitNotification(hub,
    estimationNotification([estimationDevice('device-a', cost, rate, at)]), at);
  send('private', 10, 10, T0);
  send('work', 10, 10, T0);
  assert.equal(store.readState().estimates.some((view) => view.lastResult), false);
  send('private', 20, 20, T1);
  send('work', 20, 20, T1);
  assert.equal(store.readState().estimates.some((view) => view.lastResult), false);
  send('private', 30, 30, T2);
  send('work', 25, 30, T2);
  const current = store.readState().estimates.find((view) => view.active);
  assert.equal(current.lastResult.baseCapacityUsd, 150);
  assert.equal(current.lastResult.evidence.baseline.cost, 40);
  assert.equal(store.readEstimationHistory({ scope: 'legacy' }).items.length, 1);
});

test('failed relationship migration rolls back the complete schema upgrade', (t) => {
  const { dbPath } = workspace(t);
  const before = makeV2Fixture(dbPath, true);
  assert.throws(() => new AnalyticsStore(dbPath), /FOREIGN KEY/);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='contracts'").get().count, 0);
  for (const [table, rows] of Object.entries(before)) assert.deepEqual(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), rows);
  db.close();
});
