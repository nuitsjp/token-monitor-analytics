import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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


function checkpoint(path) {
  const db = new DatabaseSync(path);
  try { return JSON.parse(db.prepare('SELECT state_json FROM shared_estimation_state WHERE id=1').get().state_json); }
  finally { db.close(); }
}

test('replay matches committed notifications, including unchanged observations, stale/missing sources and gaps', (t) => {
  const { dbPath, track } = workspace(t);
  const store = track(new AnalyticsStore(dbPath));
  store.registerHubs(['a', 'b']);
  const first = estimationDevice('one', 0, 10, T0);
  store.commitNotification('a', estimationNotification([first]), T0);
  store.commitNotification('b', estimationNotification([estimationDevice('two', 0, 10, T0)]), T0);
  store.commitNotification('a', estimationNotification([estimationDevice('one', 10, 20, T1)]), T1);
  store.commitNotification('b', estimationNotification([estimationDevice('two', 10, 20, T1)]), T1);
  assert.ok(store.readState().estimates.some((v) => v.lastResult));
  const stale = estimationDevice('one', 10, 20, T1);
  stale.metadata.stale = true;
  store.commitNotification('a', estimationNotification([stale]), T2);
  store.commitNotification('a', estimationNotification([]), T2);
  store.markEstimationGap('b', 'disconnected', T2);
  const before = checkpoint(dbPath);
  const history = store.readEstimationHistory({ limit: 10000 });
  assert.deepEqual(store.rebuildEstimation(), before);
  assert.deepEqual(checkpoint(dbPath), before);
  assert.deepEqual(store.readEstimationHistory({ limit: 10000 }), history);
  store.close();
  const reopened = track(new AnalyticsStore(dbPath));
  assert.equal(reopened.readState().contracts[0].providerData.stale, true);
  reopened.commitNotification('a', estimationNotification([estimationDevice('one', 30, 30, T2)]), T2);
  assert.deepEqual(reopened.rebuildEstimation(), checkpoint(dbPath));
});

test('clean restart preserves checkpoint; interrupted collection preserves result and discards unsafe baseline', (t) => {
  const { dbPath, track } = workspace(t);
  let store = track(new AnalyticsStore(dbPath));
  store.registerHubs(['a']);
  store.beginCollection(T0);
  store.commitNotification('a', estimationNotification([estimationDevice('one', 0, 10, T0)]), T0);
  store.commitNotification('a', estimationNotification([estimationDevice('one', 10, 20, T1)]), T1);
  const before = checkpoint(dbPath);
  store.finishCollection(); store.close();
  store = track(new AnalyticsStore(dbPath)); store.beginCollection(T2);
  assert.deepEqual(checkpoint(dbPath), before);
  store.close(); // no finishCollection: process failure or storage failure
  store = track(new AnalyticsStore(dbPath)); store.beginCollection(T2);
  const recovered = checkpoint(dbPath);
  assert.equal(recovered.groups[0].view.reason, 'recovery');
  assert.equal(recovered.groups[0].baseline, null);
  assert.deepEqual(recovered.groups[0].view.lastResult, before.groups[0].view.lastResult);
  assert.deepEqual(store.rebuildEstimation(), recovered);
});

test('input journal write failure rolls back observation, checkpoint and result event together', (t) => {
  const { dbPath, track } = workspace(t);
  const store = track(new AnalyticsStore(dbPath)); store.registerHubs(['a']);
  store.commitNotification('a', estimationNotification([estimationDevice('one', 0, 10, T0)]), T0);
  const before = store.readState(); const history = store.readEstimationHistory();
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TRIGGER fail_input BEFORE INSERT ON estimation_inputs BEGIN SELECT RAISE(ABORT, 'input failure'); END");
  db.close();
  assert.throws(() => store.commitNotification('a', estimationNotification([estimationDevice('one', 10, 20, T1)]), T1), /input failure/);
  assert.deepEqual(store.readState(), before);
  assert.deepEqual(store.readEstimationHistory(), history);
  assert.equal(observationRows(dbPath, 'a', 'one').length, 1);
});

test('schema7 unsafe baseline is retired once while results and events remain available', (t) => {
  const { dbPath, track } = workspace(t);
  const store = track(new AnalyticsStore(dbPath)); store.registerHubs(['a']);
  store.commitNotification('a', estimationNotification([estimationDevice('one', 0, 10, T0)]), T0);
  store.commitNotification('a', estimationNotification([estimationDevice('one', 10, 20, T1)]), T1);
  const before = checkpoint(dbPath); const history = store.readEstimationHistory(); store.close();
  const db = new DatabaseSync(dbPath);
  db.exec('DROP TABLE estimation_inputs; DROP TABLE estimation_runtime; PRAGMA user_version=7'); db.close();
  const migrated = track(new AnalyticsStore(dbPath));
  const after = checkpoint(dbPath);
  assert.equal(after.groups[0].baseline, null);
  assert.equal(after.groups[0].view.reason, 'incomplete_replay_history');
  assert.deepEqual(after.groups[0].view.lastResult, before.groups[0].view.lastResult);
  assert.deepEqual(migrated.readEstimationHistory(), history);
  assert.deepEqual(migrated.rebuildEstimation(), after);
  migrated.close();
  track(new AnalyticsStore(dbPath));
  assert.deepEqual(checkpoint(dbPath), after);
});

test('rebuild preserves each notification settings across configuration changes', (t) => {
  const { dbPath, track } = workspace(t);
  function entry(cost, percent, at) {
    const item = estimationDevice('one', cost, percent, at);
    const provider = item.observation.limits.providers[0];
    item.observation.limits.providers.push({ ...structuredClone(provider), accountKey: 'account-b', planLabel: 'Pro' });
    item.comparisonJson = JSON.stringify(item.observation);
    return item;
  }
  const key = JSON.stringify(['session', null, 'codex', false, null]);
  const settings = (multiplier) => ({ planMultipliers: [{ tool: 'codex', windowKey: key, basePlan: 'Plus', plans: { Plus: 1, Pro: multiplier } }] });
  let store = track(new AnalyticsStore(dbPath, { estimationSettings: settings(5) }));
  store.registerHubs(['a']);
  store.commitNotification('a', estimationNotification([entry(0, 10, T0)]), T0);
  store.commitNotification('a', estimationNotification([entry(60, 20, T1)]), T1);
  assert.equal(store.readState().estimates[0].lastResult.baseCapacityUsd, 100);
  const before = checkpoint(dbPath); const history = store.readEstimationHistory();
  assert.deepEqual(store.rebuildEstimation(), before);
  store.close();
  store = track(new AnalyticsStore(dbPath, { estimationSettings: settings(2) }));
  store.commitNotification('a', estimationNotification([entry(120, 30, T2)]), T2);
  const changed = checkpoint(dbPath);
  assert.deepEqual(store.rebuildEstimation(), changed);
  assert.ok(store.readEstimationHistory().items.length >= history.items.length);
});

test('repeated disconnects only journal a change, and a valid notification reopens the boundary', (t) => {
  const { dbPath, track } = workspace(t);
  const store = track(new AnalyticsStore(dbPath)); store.registerHubs(['a']);
  const count = () => {
    const db = new DatabaseSync(dbPath);
    try { return db.prepare('SELECT count(*) AS n FROM estimation_inputs').get().n; }
    finally { db.close(); }
  };
  store.markEstimationGap('a', 'disconnected', T0);
  assert.equal(count(), 1);
  store.markEstimationGap('a', 'disconnected', T1);
  assert.equal(count(), 1);
  store.commitNotification('a', estimationNotification([estimationDevice('one', 0, 10, T1)]), T1);
  store.markEstimationGap('a', 'disconnected', T2);
  assert.equal(count(), 3);
});

test('replay aborts and preserves the checkpoint when a referenced observation cannot be loaded', (t) => {
  const { dbPath, track } = workspace(t);
  const store = track(new AnalyticsStore(dbPath)); store.registerHubs(['a']);
  store.commitNotification('a', estimationNotification([estimationDevice('one', 0, 10, T0)]), T0);
  store.commitNotification('a', estimationNotification([estimationDevice('one', 10, 20, T1)]), T1);
  const before = checkpoint(dbPath); const history = store.readEstimationHistory();
  const db = new DatabaseSync(dbPath);
  db.exec("UPDATE estimation_inputs SET input_json=json_set(input_json, '$.devices[0].observationId', 99999) WHERE id=2");
  db.close();
  assert.throws(() => store.rebuildEstimation());
  assert.deepEqual(checkpoint(dbPath), before);
  assert.deepEqual(store.readEstimationHistory(), history);
});
