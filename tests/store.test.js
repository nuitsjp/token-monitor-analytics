import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.js';
import { makeStats } from '../mock/fixture.js';

const hubA = { id: 'hub-a', url: 'http://127.0.0.1:18001' };
const hubB = { id: 'hub-b', url: 'http://127.0.0.1:18002' };

function snapshot(options = {}) {
  const at = options.at ?? '2026-09-12T02:00:00.000Z';
  return { upstreamAt: at, stats: makeStats({ ...options, at }) };
}

function rowCount(store, table) {
  return store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

test('store persists a snapshot, keeps devices separate, and makes identical retries idempotent', () => {
  const store = createStore(':memory:');
  try {
    store.registerHub(hubA);
    const first = snapshot({ costUsd: 12.5 });
    const firstSaved = store.saveSnapshot(hubA.id, first, '2026-09-12T02:00:01.000Z');

    assert.ok(firstSaved.id);
    assert.deepEqual(firstSaved.stats, first.stats);
    assert.deepEqual(
      firstSaved.stats.devices.map((device) => device.deviceId),
      ['device-a', 'device-b']
    );
    assert.equal(rowCount(store, 'observations'), 1);
    assert.equal(rowCount(store, 'observed_devices'), 2);
    assert.equal(rowCount(store, 'current_observations'), 1);

    const retry = structuredClone(first);
    retry.stats.updatedAt = '2026-09-12T02:05:00.000Z';
    const retrySaved = store.saveSnapshot(hubA.id, retry, '2026-09-12T02:05:01.000Z');

    assert.equal(retrySaved.id, firstSaved.id);
    assert.equal(retrySaved.receivedAt, '2026-09-12T02:05:01.000Z');
    assert.deepEqual(retrySaved.stats.devices.map((device) => device.deviceId), ['device-a', 'device-b']);
    assert.equal(rowCount(store, 'observations'), 1);
    assert.equal(rowCount(store, 'observed_devices'), 2);
  } finally {
    store.close();
  }
});

test('store isolates observations by Hub even when device IDs and contents overlap', () => {
  const store = createStore(':memory:');
  try {
    store.registerHub(hubA);
    store.registerHub(hubB);
    const value = snapshot({ costUsd: 12.5 });
    const savedA = store.saveSnapshot(hubA.id, value, '2026-09-12T02:00:01.000Z');
    const savedB = store.saveSnapshot(hubB.id, value, '2026-09-12T02:00:02.000Z');

    assert.notEqual(savedA.id, savedB.id);
    assert.equal(store.readSnapshot(hubA.id).stats.devices.length, 2);
    assert.equal(store.readSnapshot(hubB.id).stats.devices.length, 2);
    assert.equal(rowCount(store, 'hubs'), 2);
    assert.equal(rowCount(store, 'observations'), 2);
    assert.equal(rowCount(store, 'observed_devices'), 4);
    assert.equal(rowCount(store, 'current_observations'), 2);
  } finally {
    store.close();
  }
});

test('store restores the current snapshot after reopening the database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'token-monitor-analytics-'));
  const databasePath = join(directory, 'analytics.sqlite');
  const value = snapshot({ costUsd: 14.25, usedPercent: 31 });
  let store;
  try {
    store = createStore(databasePath);
    store.registerHub(hubA);
    const saved = store.saveSnapshot(hubA.id, value, '2026-09-12T02:00:01.000Z');
    store.close();
    store = undefined;

    store = createStore(databasePath);
    store.registerHub(hubA);
    const restored = store.readSnapshot(hubA.id);
    assert.equal(restored.id, saved.id);
    assert.equal(restored.upstreamAt, saved.upstreamAt);
    assert.deepEqual(restored.stats, saved.stats);
    assert.equal(restored.stats.devices.length, 2);
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a SQLite write failure leaves the previous current value and rows intact', () => {
  const store = createStore(':memory:');
  try {
    store.registerHub(hubA);
    const previous = store.saveSnapshot(hubA.id, snapshot({ costUsd: 12.5 }), '2026-09-12T02:00:01.000Z');
    const before = store.readSnapshot(hubA.id);
    store.db.exec('PRAGMA query_only = ON');

    assert.throws(
      () => store.saveSnapshot(hubA.id, snapshot({ costUsd: 99 }), '2026-09-12T02:10:01.000Z'),
      /readonly|read-only|query_only|write/i
    );
    assert.deepEqual(store.readSnapshot(hubA.id), before);
    assert.equal(rowCount(store, 'observations'), 1);
    assert.equal(rowCount(store, 'observed_devices'), 2);
    assert.equal(rowCount(store, 'current_observations'), 1);
    assert.equal(store.readSnapshot(hubA.id).id, previous.id);
  } finally {
    store.close();
  }
});

test('failure on the second device rolls back the entire observation transaction', () => {
  const store = createStore(':memory:');
  try {
    store.registerHub(hubA);
    const previous = store.saveSnapshot(hubA.id, snapshot(), '2026-09-12T02:00:01.000Z');
    store.db.exec(`CREATE TRIGGER reject_device_b BEFORE INSERT ON observed_devices
      WHEN NEW.device_id = 'device-b' BEGIN SELECT RAISE(ABORT, 'test device write failure'); END;`);
    assert.throws(() => store.saveSnapshot(hubA.id, snapshot({ costUsd: 90 }), '2026-09-12T02:10:00.000Z'), /test device write failure/);
    assert.equal(store.db.isTransaction, false);
    assert.deepEqual(store.readSnapshot(hubA.id), previous);
    assert.equal(rowCount(store, 'observations'), 1);
    assert.equal(rowCount(store, 'observed_devices'), 2);
  } finally {
    store.close();
  }
});
