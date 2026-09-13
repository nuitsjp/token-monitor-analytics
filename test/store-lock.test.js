import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { AnalyticsStore } from '../src/store.js';

const T0 = '2026-09-13T00:00:00.000Z';
const T1 = '2026-09-13T00:01:00.000Z';
const TEMP_PREFIX = 'token-analytics-store-lock-';

function assertSafeTempDirectory(directory) {
  const resolved = resolve(directory);
  assert.equal(dirname(resolved).toLowerCase(), resolve(tmpdir()).toLowerCase());
  assert.equal(basename(resolved).startsWith(TEMP_PREFIX), true);
  return resolved;
}

function device(value) {
  const observation = {
    updatedAt: T0,
    periods: { today: { totalTokens: value, costUsd: value / 10 } },
    limits: { providers: [] }
  };
  return {
    deviceId: 'device-a',
    observation,
    comparisonJson: JSON.stringify(observation),
    metadata: { receivedAt: T0, ageMs: 0, stale: false }
  };
}

function notification(value) {
  return {
    hubCurrent: {
      updatedAt: T0,
      periods: { today: { totalTokens: value, costUsd: value / 10 } },
      limits: { providers: [] }
    },
    devices: [device(value)]
  };
}

test('a read-only shared lock prevents COMMIT and releasing it permits retry', (t) => {
  const directory = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const stores = [];
  let reader;
  t.after(() => {
    if (reader) {
      try {
        reader.exec('ROLLBACK');
      } catch {
        // The test may already have released the transaction.
      }
      try {
        reader.close();
      } catch {
        // Preserve the test result if cleanup observes an already closed reader.
      }
    }
    for (const store of stores) store.close();
    rmSync(assertSafeTempDirectory(directory), { recursive: true, force: true });
  });

  const dbPath = join(directory, 'analytics.sqlite');
  const store = new AnalyticsStore(dbPath);
  stores.push(store);
  store.registerHubs(['hub-a']);
  store.commitNotification('hub-a', notification(1), T0);

  const before = store.readState();
  const beforeDevice = before.hubs[0].devices[0];

  reader = new DatabaseSync(dbPath, { readOnly: true });
  reader.exec('BEGIN');
  assert.equal(
    reader.prepare('SELECT COUNT(*) AS count FROM observations').get().count,
    1
  );

  let caught;
  assert.throws(
    () => store.commitNotification('hub-a', notification(2), T1),
    (error) => {
      caught = error;
      return error.code === 'ERR_SQLITE_ERROR';
    }
  );
  assert.equal(caught.errcode, 5);
  assert.equal(caught.errstr, 'database is locked');
  assert.deepEqual(store.readState(), before);
  assert.equal(
    reader.prepare('SELECT COUNT(*) AS count FROM observations').get().count,
    1
  );

  reader.exec('ROLLBACK');
  reader.close();
  reader = undefined;

  store.commitNotification('hub-a', notification(2), T1);
  const after = store.readState();
  const afterDevice = after.hubs[0].devices[0];
  assert.equal(after.hubs[0].receivedAt, T1);
  assert.equal(afterDevice.observation.periods.today.totalTokens, 2);
  assert.notEqual(afterDevice.observationId, beforeDevice.observationId);
  const verifier = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(
      verifier.prepare('SELECT COUNT(*) AS count FROM observations').get().count,
      2
    );
  } finally {
    verifier.close();
  }
});
