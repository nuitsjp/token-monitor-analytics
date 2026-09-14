import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { AnalyticsStore } from '../src/store.js';

const AT = '2026-09-13T00:00:00.000Z';
const RESET_AT = '2026-09-20T00:00:00.000Z';
const PREFIX = 'analytics-migration-atomicity-';

function fixture(t, version) {
  const directory = mkdtempSync(join(tmpdir(), PREFIX));
  const dbPath = join(directory, 'analytics.sqlite');
  t.after(() => {
    const resolved = resolve(directory);
    assert.equal(dirname(resolved).toLowerCase(), resolve(tmpdir()).toLowerCase());
    assert.ok(basename(resolved).startsWith(PREFIX));
    rmSync(resolved, { recursive: true, force: true });
  });

  const observation = {
    updatedAt: AT,
    periods: { allTime: { clientCosts: { codex: 10 } } },
    clientHealth: {
      observedAt: AT,
      clients: { codex: { overall: 'healthy', source: { state: 'detected' }, collection: { state: 'direct' } } },
    },
    limits: { providers: [{
      provider: 'codex', accountKey: 'account-a', planLabel: 'Plus', status: 'ok', updatedAt: AT,
      windows: [{ kind: 'weekly', limitId: 'weekly', usedPercent: 10, resetsAt: RESET_AT }],
    }] },
  };
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
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
    CREATE TABLE estimation_inputs (id INTEGER PRIMARY KEY, input_json TEXT NOT NULL) STRICT;
    CREATE TABLE estimation_runtime (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      interrupted INTEGER NOT NULL CHECK (interrupted IN (0, 1))
    ) STRICT;
    INSERT INTO estimation_runtime VALUES (1, 0);
  `);
  if (version === 2) db.exec(`
    CREATE TABLE estimation_hubs (
      hub_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      FOREIGN KEY (hub_id) REFERENCES hubs(id)
    ) STRICT;
    CREATE TABLE estimation_events (
      id INTEGER PRIMARY KEY,
      hub_id TEXT NOT NULL,
      series_id TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      status TEXT NOT NULL,
      event_json TEXT NOT NULL,
      FOREIGN KEY (hub_id) REFERENCES hubs(id)
    ) STRICT;
    CREATE INDEX estimation_events_by_series ON estimation_events (hub_id, series_id, id);
  `);
  db.prepare('INSERT INTO hubs VALUES (?, 1, ?, ?)').run('hub-a', AT, '{}');
  const inserted = db.prepare('INSERT INTO observations (hub_id, device_id, comparison_json, observation_json) VALUES (?, ?, ?, ?)')
    .run('hub-a', 'device-a', JSON.stringify(observation), JSON.stringify(observation));
  db.prepare('INSERT INTO current_devices VALUES (?, ?, ?, ?, 1, ?)')
    .run('hub-a', 'device-a', inserted.lastInsertRowid, AT, JSON.stringify({ stale: false }));
  db.exec(`
    CREATE TRIGGER fail_final_migration
    BEFORE INSERT ON estimation_inputs
    BEGIN
      SELECT RAISE(ABORT, 'injected final migration failure');
    END;
    PRAGMA user_version = ${version};
  `);
  const originalTables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name").all();
  const originalRows = {
    hubs: db.prepare('SELECT * FROM hubs').all(),
    observations: db.prepare('SELECT * FROM observations').all(),
    currentDevices: db.prepare('SELECT * FROM current_devices').all(),
  };
  db.close();
  return { dbPath, originalTables, originalRows };
}

for (const version of [1, 2]) {
  test(`schema ${version} migration rolls every stage back when the final stage fails and can retry`, t => {
    const { dbPath, originalTables, originalRows } = fixture(t, version);

    assert.throws(() => new AnalyticsStore(dbPath), /injected final migration failure/);
    const failed = new DatabaseSync(dbPath);
    assert.equal(failed.prepare('PRAGMA user_version').get().user_version, version);
    assert.deepEqual(
      failed.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name").all(),
      originalTables,
    );
    assert.deepEqual(failed.prepare('SELECT * FROM hubs').all(), originalRows.hubs);
    assert.deepEqual(failed.prepare('SELECT * FROM observations').all(), originalRows.observations);
    assert.deepEqual(failed.prepare('SELECT * FROM current_devices').all(), originalRows.currentDevices);
    failed.exec('DROP TRIGGER fail_final_migration');
    failed.close();

    const retried = new AnalyticsStore(dbPath);
    retried.close();
    const migrated = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, 10);
    assert.equal(migrated.prepare('SELECT COUNT(*) AS count FROM estimation_inputs').get().count, 1);
    assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'contracts'").get().count, 1);
    assert.equal(migrated.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(migrated.prepare('PRAGMA foreign_key_check').all(), []);
    migrated.close();
  });
}
