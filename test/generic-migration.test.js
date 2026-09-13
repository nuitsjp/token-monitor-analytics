import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { AnalyticsStore } from '../src/store.js';

const TABLES = ['hubs', 'observations', 'current_devices', 'estimation_hubs', 'estimation_events', 'shared_estimation_events'];
const TOOLS = ['unknown-service', 'codex', 'grok'];

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'analytics-generic-'));
  const dbPath = join(directory, 'analytics.sqlite');
  t.after(() => {
    assert.equal(dirname(resolve(directory)).toLowerCase(), resolve(tmpdir()).toLowerCase());
    assert.ok(basename(directory).startsWith('analytics-generic-'));
    rmSync(directory, { recursive: true, force: true });
  });
  const store = new AnalyticsStore(dbPath);
  store.registerHubs(['private', 'work']);
  for (const minute of [0, 1]) {
    const at = `2026-09-13T00:0${minute}:00.000Z`;
    for (const hub of ['private', 'work']) {
      const observation = {
        updatedAt: at,
        periods: { allTime: { clientCosts: Object.fromEntries(TOOLS.map((tool) => [tool, minute * 5])) } },
        clientHealth: { observedAt: at, clients: Object.fromEntries(TOOLS.map((tool) => [tool, {
          overall: 'healthy', source: { state: 'detected' }, collection: { state: 'direct' },
        }])) },
        limits: { providers: TOOLS.map((tool) => ({
          provider: tool, accountKey: `${tool}-account`, accountEmail: 'test@example.invalid', planLabel: 'Plus',
          status: 'ok', updatedAt: at,
          windows: [{ kind: 'weekly', limitId: 'generic', usedPercent: 10 + minute * 10, resetsAt: '2026-09-20T00:00:00.000Z' }],
        })) },
      };
      store.commitNotification(hub, { hubCurrent: { updatedAt: at }, devices: [{
        deviceId: 'device', metadata: { stale: false }, observation, comparisonJson: JSON.stringify(observation),
      }] }, at);
    }
  }
  store.close();
  const db = new DatabaseSync(dbPath);
  const global = db.prepare("SELECT * FROM contracts WHERE provider = 'unknown-service'").get();
  const relations = db.prepare('SELECT * FROM device_contracts WHERE contract_id = ?').all(global.id);
  db.exec("DELETE FROM device_contracts WHERE tool = 'unknown-service'; DELETE FROM contracts WHERE provider = 'unknown-service';");
  const state = JSON.parse(db.prepare('SELECT state_json FROM shared_estimation_state WHERE id = 1').get().state_json);
  for (const relation of relations) {
    const id = createHash('sha256').update(JSON.stringify([relation.hub_id, global.provider, global.account_key])).digest('hex');
    db.prepare('INSERT INTO contracts VALUES (?, ?, ?, ?)').run(id, global.provider, global.account_key, relation.hub_id);
    db.prepare('INSERT INTO device_contracts VALUES (?, ?, ?, ?, ?, ?)').run(
      relation.hub_id, relation.device_id, relation.tool, id, relation.first_observation_id, relation.last_observation_id,
    );
    state.registry.find((source) => source.tool === global.provider && source.hubId === relation.hub_id).accounts = [id];
  }
  db.prepare('UPDATE shared_estimation_state SET state_json = ? WHERE id = 1').run(JSON.stringify(state));
  db.exec('PRAGMA user_version = 4');
  return { db, dbPath, relations };
}

function preserved(db) {
  const state = JSON.parse(db.prepare('SELECT state_json FROM shared_estimation_state WHERE id = 1').get().state_json);
  return {
    tables: Object.fromEntries(TABLES.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])),
    contracts: db.prepare("SELECT * FROM contracts WHERE provider IN ('codex', 'grok') ORDER BY id").all(),
    relations: db.prepare("SELECT * FROM device_contracts WHERE tool IN ('codex', 'grok') ORDER BY rowid").all(),
    registry: state.registry.filter((source) => source.tool !== 'unknown-service'),
    groups: state.groups.filter((group) => group.view.tool !== 'unknown-service'),
  };
}

test('schema 4 migration merges a generic contract across Hubs while preserving observations and events and rebasing current comparisons', (t) => {
  const { db, dbPath, relations } = fixture(t);
  const before = preserved(db);
  assert.ok(before.tables.shared_estimation_events.length > 0);
  assert.ok(before.groups.some((group) => group.view.lastResult));
  db.close();
  const store = new AnalyticsStore(dbPath);
  store.close();
  const after = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(after.prepare('PRAGMA user_version').get().user_version, 6);
    const { groups: beforeGroups, ...beforeRows } = before;
    const { groups: afterGroups, ...afterRows } = preserved(after);
    assert.deepEqual(afterRows, beforeRows);
    assert.ok(afterGroups.filter(group => group.view.active).every(group => group.baseline === null));
    const contracts = after.prepare("SELECT * FROM contracts WHERE provider = 'unknown-service'").all();
    assert.equal(contracts.length, 1);
    assert.equal(contracts[0].scope_hub_id, '');
    const links = after.prepare("SELECT * FROM device_contracts WHERE tool = 'unknown-service' ORDER BY hub_id").all();
    assert.deepEqual(links.map((relation) => ({ ...relation })), relations.map((relation) => ({ ...relation, contract_id: contracts[0].id })).sort((a, b) => a.hub_id.localeCompare(b.hub_id)));
    const state = JSON.parse(after.prepare('SELECT state_json FROM shared_estimation_state WHERE id = 1').get().state_json);
    const groups = state.groups.filter((group) => group.view.tool === 'unknown-service' && group.view.active);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].view.hubIds, ['private', 'work']);
    assert.equal(groups[0].baseline, null);
    assert.equal(groups[0].view.lastResult, null);
    assert.equal(after.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(after.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { after.close(); }
});

function version5Fixture(t) {
  const { db, dbPath } = fixture(t);
  db.close();
  new AnalyticsStore(dbPath).close();
  const connection = new DatabaseSync(dbPath);
  const state = JSON.parse(connection.prepare('SELECT state_json FROM shared_estimation_state WHERE id = 1').get().state_json);
  // Recreate an older calculation with its original ID and a duplicated cost result.
  const old = state.groups.find(group => group.view.active);
  old.id = 'schema5-cursor-series';
  old.view = { ...old.view, id: old.id, tool: 'cursor', lastResult: { baseCapacityUsd: 749.8163790236914, deltaCostUsd: 2.732664136886342 } };
  delete old.view.methodVersion;
  state.groups = [old];
  connection.prepare('UPDATE shared_estimation_state SET state_json = ? WHERE id = 1').run(JSON.stringify(state));
  connection.exec('PRAGMA user_version = 5');
  return { db: connection, dbPath, old };
}

const usageTables = [...TABLES, 'contracts', 'device_contracts'];
const rows = db => usageTables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());

test('schema 5から6への移行は旧結果を履歴へ隔離し観測・契約関連・eventsを改変しない', t => {
  const { db, dbPath, old } = version5Fixture(t);
  const before = rows(db);
  db.close();
  const store = new AnalyticsStore(dbPath);
  const state = store.readState();
  store.close();
  const after = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(after.prepare('PRAGMA user_version').get().user_version, 6);
    assert.deepEqual(rows(after), before);
    const checkpoint = JSON.parse(after.prepare('SELECT state_json FROM shared_estimation_state WHERE id = 1').get().state_json);
    const archived = checkpoint.groups.find(group => group.id === old.id);
    assert.equal(archived.view.active, false);
    assert.equal(archived.view.reason, 'method_changed');
    assert.deepEqual(archived.view.lastResult, old.view.lastResult);
    assert.equal(archived.baseline, null);
    assert.ok(checkpoint.groups.some(group => group.view.active));
    assert.ok(checkpoint.groups.filter(group => group.view.active).every(group => group.view.methodVersion === 2 && group.view.lastResult === null && group.baseline === null));
    assert.ok(!state.estimates.filter(view => view.active).some(view => view.lastResult?.baseCapacityUsd === 749.8163790236914));
    assert.equal(after.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(after.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { after.close(); }
  const resumed = new AnalyticsStore(dbPath);
  try {
    resumed.markEstimationGap('private', 'restart', '2026-09-13T01:00:00.000Z');
    resumed.commitNotification('private', { hubCurrent: {}, devices: [] }, '2026-09-13T01:01:00.000Z');
    const archived = resumed.readState().estimates.find(view => view.id === old.id);
    assert.equal(archived.active, false);
    assert.equal(archived.reason, 'method_changed');
    assert.deepEqual(archived.lastResult, old.view.lastResult);
  } finally { resumed.close(); }
});

test('schema 6への移行失敗は版番号・checkpoint・全データをschema 5のまま保つ', t => {
  const { db, dbPath } = version5Fixture(t);
  const before = rows(db);
  const checkpoint = db.prepare('SELECT * FROM shared_estimation_state').all();
  db.exec("CREATE TRIGGER fail_usage BEFORE UPDATE ON shared_estimation_state BEGIN SELECT RAISE(ABORT, 'injected usage migration failure'); END;");
  db.close();
  assert.throws(() => new AnalyticsStore(dbPath), /injected usage migration failure/);
  const after = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(after.prepare('PRAGMA user_version').get().user_version, 5);
    assert.deepEqual(rows(after), before);
    assert.deepEqual(after.prepare('SELECT * FROM shared_estimation_state').all(), checkpoint);
  } finally { after.close(); }
});

test('failed generic migration rolls back the version, relationships, checkpoints and history', (t) => {
  const { db, dbPath } = fixture(t);
  const tables = [...TABLES, 'contracts', 'device_contracts', 'shared_estimation_state'];
  const snapshot = (connection) => tables.map((table) => connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const before = snapshot(db);
  db.exec("CREATE TRIGGER fail_global BEFORE INSERT ON contracts WHEN NEW.provider = 'unknown-service' BEGIN SELECT RAISE(ABORT, 'injected generic migration failure'); END;");
  db.close();
  assert.throws(() => new AnalyticsStore(dbPath), /injected generic migration failure/);
  const after = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(after.prepare('PRAGMA user_version').get().user_version, 4);
    assert.deepEqual(snapshot(after), before);
  } finally { after.close(); }
});
