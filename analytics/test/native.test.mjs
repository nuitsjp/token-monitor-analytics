import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {loadConfig, credentials} from '../runtime/config.mjs';
import {canView, allowedRequest} from '../runtime/auth.mjs';
import {openDatabase, transaction, backupDatabase} from '../runtime/sqlite.mjs';
import {startServer} from '../runtime/server.mjs';
import {recordObservation} from '../src/db.ts';
import {contract, observation} from './adapter.mjs';

const viewerEnv = {
  TMA_VIEWER_USER: 'viewer',
  TMA_VIEWER_PASSWORD: 'test-viewer-password-0000000',
};
const logger = {info() {}, error() {}};
const cleanups = new WeakMap();

function cleanup(t, fn) {
  if (!cleanups.has(t)) {
    const list = [];
    cleanups.set(t, list);
    t.after(async () => { for (const action of list.reverse()) await action(); });
  }
  cleanups.get(t).push(fn);
}

function configFile(t, changes = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-native-'));
  cleanup(t, () => fs.rmSync(dir, {recursive: true, force: true}));
  const raw = JSON.parse(fs.readFileSync(new URL('../configs/demo.json', import.meta.url), 'utf8'));
  Object.assign(raw, {
    demo: false,
    databasePath: path.join(dir, 'analytics.db'),
    hubSecretsPath: path.join(dir, 'hub-secrets.json'),
    contracts: [],
  }, changes);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(raw));
  return {dir, file, raw, config: () => loadConfig(file)};
}

async function serverFixture(t, changes = {}) {
  const f = configFile(t, changes);
  const config = f.config();
  config.listen.port = 0;
  const app = await startServer(config, {env: viewerEnv, logger, heartbeatMs: 50});
  config.listen.port = app.server.address().port;
  config.publicOrigin = `http://127.0.0.1:${config.listen.port}`;
  cleanup(t, () => app.close());
  return {...f, config, app, url: config.publicOrigin, request: (route, init) => fetch(config.publicOrigin + route, init)};
}

test('configuration paths are relative to the config, and v1/legacy Hub fields fail closed', t => {
  const f = configFile(t);
  assert.equal(f.config().databasePath, path.join(f.dir, 'analytics.db'));
  assert.equal(f.config().hubSecretsPath, path.join(f.dir, 'hub-secrets.json'));
  fs.writeFileSync(f.file, JSON.stringify({...f.raw, version: 1}));
  assert.throws(f.config, /version=2/);
  fs.writeFileSync(f.file, JSON.stringify({...f.raw, hubs: []}));
  assert.throws(f.config, /unknown configuration field/);
  fs.writeFileSync(f.file, JSON.stringify({...f.raw, hubsPath: './hubs.json'}));
  assert.throws(f.config, /unknown configuration field/);
});

test('UTF-8 BOM and spaces in configuration paths are supported', t => {
  const f = configFile(t);
  const file = path.join(f.dir, 'settings with space.json');
  fs.writeFileSync(file, '\ufeff' + JSON.stringify(f.raw));
  assert.equal(loadConfig(file).databasePath, path.join(f.dir, 'analytics.db'));
});

test('unknown fields and unsafe bind without TLS/basic are rejected', t => {
  const f = configFile(t);
  fs.writeFileSync(f.file, JSON.stringify({...f.raw, accidentalSecret: 'x'}));
  assert.throws(f.config);
  fs.writeFileSync(f.file, JSON.stringify({...f.raw, listen: {host: '0.0.0.0', port: 8787}}));
  assert.throws(f.config);
});

test('Basic viewer credentials are independent from Hub secrets', t => {
  const f = configFile(t, {viewerAuth: {mode: 'basic', userEnv: 'TMA_VIEWER_USER', passwordEnv: 'TMA_VIEWER_PASSWORD'}});
  const config = f.config();
  const auth = credentials(config, viewerEnv);
  const request = {
    headers: {authorization: 'Basic ' + Buffer.from(`viewer:${viewerEnv.TMA_VIEWER_PASSWORD}`).toString('base64')},
    socket: {remoteAddress: '198.51.100.10'},
  };
  assert.ok(canView(request, config, auth));
  assert.throws(() => credentials(config, {...viewerEnv, TMA_VIEWER_USER: 'bad:user'}));
});

test('native SQLite migration is idempotent across reopen', t => {
  const c = configFile(t).config();
  let db = openDatabase(c.databasePath);
  assert.equal(db.prepare('SELECT count(*) n FROM schema_migrations').get().n, 4);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN ('hubs','hub_snapshots','contract_snapshots')").get().n, 3);
  db.close();
  db = openDatabase(c.databasePath);
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  db.close();
});

test('native StatementSync uses direct calls and preserves an empty get result', t => {
  const c = configFile(t).config();
  const db = openDatabase(c.databasePath);
  cleanup(t, () => db.close());
  const statement = db.prepare('SELECT value FROM app_metadata WHERE key=?');
  assert.equal(typeof statement.bind, 'undefined');
  assert.equal(statement.get('missing-key'), undefined);
  const rows = statement.all('dataset_mode');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, 'real');
});

test('archive migration upgrades existing archived rows without losing observations', t => {
  const f = configFile(t);
  const sql = new DatabaseSync(f.config().databasePath);
  sql.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL); CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  for (const name of ['0001_initial.sql', '0002_hubs.sql', '0003_usage_history.sql']) {
    const text = fs.readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
    sql.exec(text);
    sql.prepare('INSERT INTO schema_migrations(name, checksum) VALUES(?, ?)').run(name, createHash('sha256').update(text).digest('hex'));
  }
  sql.prepare('INSERT INTO app_metadata(key, value) VALUES(?, ?)').run('dataset_mode', 'real');
  sql.prepare('INSERT INTO hubs(id,label,url,status,secret_ref,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('archived-hub', 'Archived', 'https://old.example.invalid', 'archived', 'old-secret', 1, '2026-01-01', '2026-01-01');
  sql.prepare('INSERT INTO hubs(id,label,url,status,secret_ref,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('active-hub', 'Active', 'https://active.example.invalid', 'active', 'active-secret', 1, '2026-01-01', '2026-01-01');
  sql.prepare('INSERT INTO observations(hub_id,event_id,observed_at,received_at,stream_id,payload) VALUES(?,?,?,?,?,?)').run('archived-hub', 'event-1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z', 'stream-1', '{}');
  sql.close();
  const db = openDatabase(f.config().databasePath);
  try {
    assert.deepEqual({...db.prepare('SELECT url,secret_ref,status FROM hubs WHERE id=?').get('archived-hub')}, {url: null, secret_ref: null, status: 'archived'});
    assert.deepEqual({...db.prepare('SELECT url,secret_ref,status FROM hubs WHERE id=?').get('active-hub')}, {url: 'https://active.example.invalid', secret_ref: 'active-secret', status: 'active'});
    assert.equal(db.prepare('SELECT count(*) n FROM observations').get().n, 1);
  } finally { db.close(); }
});

test('demo database cannot be reused for real observations', t => {
  const c = configFile(t).config();
  const db = openDatabase(c.databasePath, {demo: true});
  db.close();
  assert.throws(() => openDatabase(c.databasePath, {demo: false}), /mixing/);
});

test('entire observation transaction rolls back on a storage failure', t => {
  const c = configFile(t).config();
  const db = openDatabase(c.databasePath);
  cleanup(t, () => db.close());
  db.exec("CREATE TRIGGER fail_daily BEFORE INSERT ON daily_estimates BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
  assert.throws(() => transaction(db,() => recordObservation(db, observation(), [contract], 'Asia/Tokyo')));
  assert.equal(db.prepare('SELECT count(*) n FROM observations').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM hub_latest').get().n, 0);
});

test('async transaction callbacks are rejected before execution', async t => {
  const c = configFile(t).config();
  const db = openDatabase(c.databasePath);
  cleanup(t, () => db.close());
  let executed = false;
  assert.throws(() => transaction(db,async () => {
    executed = true;
    await Promise.resolve();
    recordObservation(db, observation(), [contract], 'Asia/Tokyo');
  }), /synchronous/);
  await Promise.resolve();
  assert.equal(executed, false);
  assert.equal(db.prepare('SELECT count(*) n FROM observations').get().n, 0);
});

test('backup includes committed WAL data while the source remains open', async t => {
  const f = configFile(t);
  const db = openDatabase(f.config().databasePath);
  cleanup(t, () => db.close());
  transaction(db,() => {
    recordObservation(db, observation(), [contract], 'Asia/Tokyo');
    recordObservation(db, observation(1), [contract], 'Asia/Tokyo');
  });
  const output = path.join(f.dir, 'backup.db');
  await backupDatabase(f.config().databasePath, output);
  const copy = new DatabaseSync(output, {readOnly: true});
  assert.equal(copy.prepare('SELECT count(*) n FROM observations').get().n, 2);
  copy.close();
  await assert.rejects(backupDatabase(f.config().databasePath, output));
});

test('HTTP exposes the integrated app and has no old ingest or Collector-status endpoint', async t => {
  const f = await serverFixture(t);
  assert.equal((await f.request('/')).status, 200);
  assert.equal((await f.request('/api/health')).status, 200);
  assert.equal((await f.request('/api/ingest')).status, 404);
  assert.equal((await f.request('/api/collector/status')).status, 404);
  const state = await (await f.request('/api/state')).json();
  assert.equal(state.storage, 'sqlite');
  assert.deepEqual(state.configuredHubs, []);
  assert.ok((await (await f.request('/styles.css')).text()).length > 100);
});

test('Host allowlist and cross-origin requests fail closed', async t => {
  const f = await serverFixture(t);
  const hostStatus = await new Promise((resolve, reject) => {
    const req = http.get(f.url + '/api/state', {headers: {Host: 'attacker.invalid'}}, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
  });
  assert.equal(hostStatus, 403);
  assert.equal((await f.request('/api/state', {headers: {Origin: 'https://attacker.invalid'}})).status, 403);
  assert.equal(allowedRequest({headers: {host: 'attacker.invalid'}, socket: {remoteAddress: '127.0.0.1'}}, f.config), false);
});

test('Basic auth protects HTML and state while Hub management remains origin-protected', async t => {
  const f = await serverFixture(t, {management: {enabled: true}, viewerAuth: {mode: 'basic', userEnv: 'TMA_VIEWER_USER', passwordEnv: 'TMA_VIEWER_PASSWORD'}});
  for (const route of ['/', '/app.js', '/api/state']) assert.equal((await f.request(route)).status, 401);
  const auth = 'Basic ' + Buffer.from(`viewer:${viewerEnv.TMA_VIEWER_PASSWORD}`).toString('base64');
  assert.equal((await f.request('/api/state', {headers: {Authorization: auth}})).status, 200);
  const missingOrigin = await f.request('/api/manage/hubs', {
    method: 'POST',
    headers: {Authorization: auth, 'Content-Type': 'application/json'},
    body: JSON.stringify({id: 'h1', label: 'Hub', url: 'https://hub.example.com', secret: 'hub-secret'}),
  });
  assert.equal(missingOrigin.status, 403);
});
