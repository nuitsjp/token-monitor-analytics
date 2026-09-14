import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { AnalyticsStore } from '../src/store.js';

const T0 = '2026-09-13T00:00:00.000Z';
const T1 = '2026-09-13T00:01:00.000Z';
const T2 = '2026-09-13T00:02:00.000Z';

function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), 'analytics-grok-'));
  const stores = [];
  t.after(() => {
    for (const store of stores) store.close();
    const absolute = resolve(directory);
    assert.equal(dirname(absolute).toLowerCase(), resolve(tmpdir()).toLowerCase());
    assert.ok(basename(absolute).startsWith('analytics-grok-'));
    rmSync(absolute, { recursive: true, force: true });
  });
  const dbPath = join(directory, 'analytics.sqlite');
  return { dbPath, open: () => { const store = new AnalyticsStore(dbPath); stores.push(store); return store; } };
}

function grok(accountKey, accountEmail, updatedAt = T0, status = 'ok', usedPercent = 1) {
  return { provider: 'grok', accountKey, accountEmail, accountLabel: 'SuperGrok', status, updatedAt,
    windows: [{ kind: 'weekly', usedPercent, resetsAt: '2026-09-20T00:00:00.000Z' }] };
}

function send(store, hub, providers, at = T0) {
  const observation = { updatedAt: at, limits: { providers },
    periods: { allTime: { clientCosts: { grok: 10, codex: 10 } } } };
  store.commitNotification(hub, {
    hubCurrent: { updatedAt: at },
    devices: [{ deviceId: 'device', metadata: { stale: false }, observation, comparisonJson: JSON.stringify(observation) }],
  }, at);
}

test('Grok token rotation and cross-Hub reports share one email contract through restart', (t) => {
  const ws = workspace(t);
  let store = ws.open();
  store.registerHubs(['private', 'work']);
  send(store, 'private', [grok('token-a', ' Person@Example.com ')]);
  const id = store.readState().contracts[0].id;
  send(store, 'work', [grok('old', 'person@example.com', T0, 'unavailable', 0), grok('token-b', 'person@example.com', T1, 'ok', 2)], T1);
  send(store, 'private', [grok('token-a', 'person@example.com', T0, 'unavailable'), grok('token-c', 'PERSON@example.com', T2, 'ok', 3)], T2);
  const state = store.readState();
  assert.equal(state.contracts.length, 1);
  assert.equal(state.contracts[0].id, id);
  assert.deepEqual(state.contracts[0].hubIds, ['private', 'work']);
  assert.equal(state.contracts[0].sources.length, 2);
  assert.equal(state.contracts[0].providerData.accountKey, 'token-c');
  assert.equal(state.contracts[0].providerData.windows[0].usedPercent, 3);
  assert.equal(state.contracts[0].current, true);
  assert.ok(state.estimates.filter((view) => view.tool === 'grok').every((view) => !view.lastResult));
  assert.equal(state.hubs[0].devices[0].observation.limits.providers[0].accountKey, 'token-a');
  store.close();
  store = ws.open();
  assert.deepEqual(store.readState(), state);
});

test('Grok email changes preserve the old contract as history and allow simultaneous accounts', (t) => {
  const store = workspace(t).open();
  store.registerHubs(['private']);
  send(store, 'private', [grok('a', 'first@example.com')]);
  const oldId = store.readState().contracts[0].id;
  send(store, 'private', [grok('a', 'first@example.com', T0, 'unavailable'), grok('b', 'second@example.com', T1)], T1);
  let contracts = store.readState().contracts;
  assert.equal(contracts.length, 2);
  assert.equal(contracts.find((row) => row.id === oldId).current, false);
  assert.equal(contracts.filter((row) => row.current).length, 1);
  send(store, 'private', [grok('a', 'first@example.com', T0, 'unavailable'), grok('b', 'second@example.com', T1, 'unavailable')], T2);
  contracts = store.readState().contracts;
  assert.equal(contracts.find((row) => row.id === oldId).current, false);
  assert.equal(contracts.filter((row) => row.current).length, 1);
  send(store, 'private', [grok('a', 'first@example.com', T2), grok('b', 'second@example.com', T2)], T2);
  assert.equal(store.readState().contracts.filter((row) => row.current).length, 2);
});

test('Grok without email remains a raw report without inventing a contract', (t) => {
  const store = workspace(t).open();
  store.registerHubs(['private', 'work']);
  send(store, 'private', [grok('same-token', '')]);
  send(store, 'work', [grok('same-token', '')]);
  assert.equal(store.readState().contracts.length, 0);
  assert.equal(store.readState().hubs[0].devices[0].observation.limits.providers[0].accountKey, 'same-token');
  send(store, 'private', [grok('', 'known@example.com', T1)], T1);
  assert.equal(store.readState().contracts.length, 1);
});

test('a newer unconfigured or disabled Grok report does not revive an older failed contract', (t) => {
  const store = workspace(t).open();
  store.registerHubs(['private']);
  send(store, 'private', [grok('a', 'known@example.com')]);
  for (const status of ['disabled', 'notConfigured']) {
    send(store, 'private', [grok('a', 'known@example.com', T1, 'unavailable'), grok('', '', T2, status)], T2);
    assert.equal(store.readState().contracts.length, 1);
    assert.equal(store.readState().contracts[0].current, false);
  }
});

test('Grok conflicts compare window values and periods, ignoring presentation fields and order', (t) => {
  const store = workspace(t).open();
  store.registerHubs(['private', 'work']);
  const first = grok('a', 'known@example.com');
  first.windows.push({ kind: 'session', usedPercent: 20, resetsAt: '2026-09-13T01:00:00.000Z' });
  send(store, 'private', [first]);
  const second = structuredClone(first);
  second.accountKey = 'b';
  second.windows.reverse();
  second.windows[1].label = 'Different display label';
  second.windows[1].detail = 'A device-specific description';
  second.windows[1].source = 'api';
  second.windows[1].resetsAt = '2026-09-20T09:00:00+09:00';
  send(store, 'work', [second]);
  assert.equal(store.readState().contracts[0].providerData.status, 'ok');
  second.windows[1].usedPercent = 2;
  send(store, 'work', [second], T1);
  assert.equal(store.readState().contracts[0].providerData.status, 'conflicting_rate');
});

const PRESERVED_TABLES = ['hubs', 'observations', 'current_devices', 'estimation_hubs', 'estimation_events', 'shared_estimation_events'];

function snapshot(db) {
  const state = JSON.parse(db.prepare('SELECT state_json FROM shared_estimation_state WHERE id = 1').get().state_json);
  return {
    tables: Object.fromEntries(PRESERVED_TABLES.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])),
    contracts: db.prepare("SELECT * FROM contracts WHERE provider <> 'grok' ORDER BY id").all(),
    relations: db.prepare("SELECT * FROM device_contracts WHERE tool <> 'grok' ORDER BY rowid").all(),
    registry: state.registry.filter((source) => source.tool !== 'grok'),
    groups: state.groups.filter((group) => group.view.tool !== 'grok'),
  };
}

function v3Fixture(ws) {
  const store = ws.open();
  store.registerHubs(['private', 'work']);
  const codex = { provider: 'codex', accountKey: 'codex-account', status: 'ok', updatedAt: T0, windows: [] };
  send(store, 'private', [grok('token-a', 'same@example.com'), codex]);
  send(store, 'work', [grok('token-b', 'same@example.com'), codex]);
  store.close();
  const db = new DatabaseSync(ws.dbPath);
  db.exec("DELETE FROM device_contracts WHERE tool = 'grok'; DELETE FROM contracts WHERE provider = 'grok'; DROP TABLE estimation_inputs; DROP TABLE estimation_runtime; DROP TABLE daily_usage; DROP TABLE monthly_usage; DROP TABLE history_fetch_state; PRAGMA user_version = 3;");
  for (const row of db.prepare('SELECT * FROM observations ORDER BY id').all()) {
    const report = JSON.parse(row.observation_json).limits.providers.find((provider) => provider.provider === 'grok');
    const id = createHash('sha256').update(JSON.stringify([row.hub_id, 'grok', report.accountKey])).digest('hex');
    db.prepare('INSERT INTO contracts VALUES (?, ?, ?, ?)').run(id, 'grok', report.accountKey, row.hub_id);
    db.prepare('INSERT INTO device_contracts VALUES (?, ?, ?, ?, ?, ?)').run(row.hub_id, row.device_id, 'grok', id, row.id, row.id);
  }
  return db;
}

test('v3 migration merges only Grok relationships, preserves observations and events, and rebases current comparisons', (t) => {
  const ws = workspace(t);
  const db = v3Fixture(ws);
  const before = snapshot(db);
  db.close();
  const store = ws.open();
  const after = new DatabaseSync(ws.dbPath, { readOnly: true });
  const { groups: beforeGroups, ...beforeRows } = before;
  const { groups: afterGroups, ...afterRows } = snapshot(after);
  assert.deepEqual(afterRows, beforeRows);
  assert.ok(afterGroups.filter(group => group.view.active).every(group => group.baseline === null));
  assert.equal(after.prepare('PRAGMA user_version').get().user_version, 10);
  assert.equal(after.prepare("SELECT COUNT(*) AS count FROM contracts WHERE provider = 'grok'").get().count, 1);
  assert.equal(after.prepare("SELECT COUNT(*) AS count FROM device_contracts WHERE tool = 'grok'").get().count, 2);
  assert.equal(after.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(after.prepare('PRAGMA foreign_key_check').all(), []);
  after.close();
  assert.equal(store.readState().contracts.filter((row) => row.provider === 'grok').length, 1);
});

test('failed Grok migration restores the original v3 relationships and history', (t) => {
  const ws = workspace(t);
  const db = v3Fixture(ws);
  const before = snapshot(db);
  const oldContracts = db.prepare('SELECT * FROM contracts ORDER BY id').all();
  const oldRelations = db.prepare('SELECT * FROM device_contracts ORDER BY rowid').all();
  db.exec("CREATE TRIGGER fail_grok BEFORE INSERT ON contracts WHEN NEW.provider = 'grok' BEGIN SELECT RAISE(ABORT, 'injected Grok migration failure'); END;");
  db.close();
  assert.throws(() => ws.open(), /injected Grok migration failure/);
  const after = new DatabaseSync(ws.dbPath, { readOnly: true });
  assert.equal(after.prepare('PRAGMA user_version').get().user_version, 3);
  assert.deepEqual(snapshot(after), before);
  assert.deepEqual(after.prepare('SELECT * FROM contracts ORDER BY id').all(), oldContracts);
  assert.deepEqual(after.prepare('SELECT * FROM device_contracts ORDER BY rowid').all(), oldRelations);
  after.close();
});
