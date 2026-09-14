import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:net';
import { AnalyticsStore } from '../src/store.js';
import { startAnalytics } from '../src/app.js';
import { startRuntime, describeStartupFailure, readVersion } from '../src/runtime.js';

// UC-4「アプリを手動で更新し、履歴を保全して復旧する」: 更新後の起動で行う版確認・移行・結果提示の系列。
const PREFIX = 'token-analytics-update-';
const AT = '2026-09-13T00:00:00.000Z';
const SECRET = 'update-hub-secret-never-expose';

// 一時ディレクトリを作る。DB を開いたままでは消せないので、登録された終了処理を先に待つ。
function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), PREFIX));
  const closers = [];
  t.after(async () => {
    for (const close of closers) await close();
    const resolved = resolve(directory);
    assert.equal(dirname(resolved).toLowerCase(), resolve(tmpdir()).toLowerCase());
    assert.equal(basename(resolved).startsWith(PREFIX), true);
    rmSync(resolved, { recursive: true, force: true });
  });
  return { directory, closing: (close) => closers.push(close) };
}

// 現在の版で保存済みデータを作る。UC-4 の「更新前のデータ」に当たる。
function seed(dbPath) {
  const store = new AnalyticsStore(dbPath);
  store.registerHubs(['work']);
  const observation = {
    updatedAt: AT, periods: { allTime: { clientCosts: { codex: 10 } } },
    limits: { providers: [{ provider: 'codex', accountKey: 'account-a', planLabel: 'Plus', status: 'ok', updatedAt: AT, windows: [{ kind: 'weekly', limitId: 'weekly', usedPercent: 10, resetsAt: '2026-09-20T00:00:00.000Z' }] }] },
  };
  store.commitNotification('work', { hubCurrent: { updatedAt: AT }, devices: [{ deviceId: 'device-a', metadata: { stale: false }, observation, comparisonJson: JSON.stringify(observation) }] }, AT);
  store.commitHistory('work', { daily: [{ deviceId: 'device-a', date: '2026-09-12', tool: 'codex', tokens: 300, cost: 3 }], monthly: [] }, AT);
  store.setCollectionEnabled('work', false);
  store.close();
}

function snapshot(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const hasDaily = db.prepare("SELECT name FROM sqlite_master WHERE name = 'daily_usage'").all().length > 0;
    return {
      version: db.prepare('PRAGMA user_version').get().user_version,
      tables: db.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name").all(),
      hubs: db.prepare('SELECT * FROM hubs ORDER BY id').all(),
      observations: db.prepare('SELECT * FROM observations ORDER BY id').all(),
      daily: hasDaily ? db.prepare('SELECT * FROM daily_usage').all() : [],
    };
  } finally { db.close(); }
}

function downgradeTo9(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('ALTER TABLE history_fetch_state DROP COLUMN devices_json; PRAGMA user_version = 9');
  db.close();
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolvePort(port)); });
  });
}

function configuration(directory, dbPath) {
  return { mode: 'mock', host: '127.0.0.1', port: 0, dbPath, registryPath: join(directory, '.local', 'hubs.mock.json'), hubs: [{ id: 'work', url: 'http://127.0.0.1:1', secret: SECRET, configError: null }] };
}

test('UC-4-M: 古い版の DB を移行して起動し、版と移行結果を状態に出し、更新前のデータを保つ', async (t) => {
  const { directory, closing } = workspace(t);
  const dbPath = join(directory, 'analytics.sqlite');
  seed(dbPath);
  const before = snapshot(dbPath);
  downgradeTo9(dbPath);

  const app = await startAnalytics({ configuration: configuration(directory, dbPath), version: 'abc1234', reconnectMs: 30 });
  closing(() => app.stop());
  assert.deepEqual(app.store.schema, { version: 10, migratedFrom: 9 });
  const text = await (await fetch(`http://127.0.0.1:${app.address.port}/api/state`)).text();
  const state = JSON.parse(text);
  assert.deepEqual(state.runtime, { version: 'abc1234', schemaVersion: 10, migratedFrom: 9 });
  assert.equal(text.includes(SECRET), false);

  const after = snapshot(dbPath);
  assert.equal(after.version, 10);
  assert.deepEqual(after.hubs, before.hubs);
  assert.deepEqual(after.observations, before.observations);
  assert.deepEqual(after.daily, before.daily);
  const work = state.hubs.find((hub) => hub.id === 'work');
  assert.equal(work.collectionEnabled, false);
  assert.equal(work.status.collectionStopped, true);
});

test('UC-4-M: 移行の要らない起動は migratedFrom を null にする', async (t) => {
  const { directory, closing } = workspace(t);
  const dbPath = join(directory, 'analytics.sqlite');
  seed(dbPath);
  const app = await startAnalytics({ configuration: configuration(directory, dbPath), reconnectMs: 30 });
  closing(() => app.stop());
  assert.deepEqual(app.state().runtime, { version: null, schemaVersion: 10, migratedFrom: null });
});

test('UC-4-X1: 移行に失敗したら DB を移行前のまま保ち、段階・版・復旧手順を報告する', (t) => {
  const { directory, closing } = workspace(t);
  const dbPath = join(directory, 'analytics.sqlite');
  seed(dbPath);
  const db = new DatabaseSync(dbPath);
  assert.ok(db.prepare('SELECT 1 FROM shared_estimation_state WHERE id = 1').get(), 'checkpoint 行が移行対象として存在すること');
  db.exec("DROP TABLE estimation_inputs; DROP TABLE estimation_runtime; DROP TABLE daily_usage; DROP TABLE monthly_usage; DROP TABLE history_fetch_state; PRAGMA user_version = 6; CREATE TRIGGER fail_checkpoint BEFORE UPDATE ON shared_estimation_state BEGIN SELECT RAISE(ABORT, 'injected update failure'); END;");
  db.close();
  const before = snapshot(dbPath);

  let error;
  assert.throws(() => new AnalyticsStore(dbPath), (thrown) => { error = thrown; return /injected update failure/.test(thrown.message); });
  assert.equal(error.code, 'MIGRATION_FAILED');
  assert.equal(error.stage, 'estimation-checkpoint');
  assert.equal(error.schemaVersion, 6);
  assert.equal(error.targetVersion, 10);
  assert.equal(error.sqliteCode, 1811); // SQLITE_CONSTRAINT_TRIGGER
  assert.deepEqual(snapshot(dbPath), before);

  error.dbPath = dbPath;
  const entry = describeStartupFailure(error);
  assert.equal(entry.operation, 'startup');
  assert.equal(entry.code, 'MIGRATION_FAILED');
  assert.equal(entry.stage, 'estimation-checkpoint');
  assert.equal(entry.dbPath, dbPath);
  assert.equal(entry.schemaVersion, 6);
  assert.equal(entry.targetVersion, 10);
  assert.equal(entry.sqliteCode, 1811);
  assert.match(entry.recovery, /移行前の版とデータのまま/);
  assert.match(entry.recovery, /削除・初期化しない/);
  assert.equal(JSON.stringify(entry).includes('injected update failure'), false);
});

test('UC-4-X2: 対応範囲外の版の DB は書き換えず、版と復旧手順を報告する', (t) => {
  const { directory, closing } = workspace(t);
  const dbPath = join(directory, 'analytics.sqlite');
  seed(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA user_version = 11');
  db.close();
  const bytes = readFileSync(dbPath);

  let error;
  assert.throws(() => new AnalyticsStore(dbPath), (thrown) => { error = thrown; return /schema is incompatible/.test(thrown.message); });
  assert.equal(error.code, 'SCHEMA_INCOMPATIBLE');
  assert.equal(error.schemaVersion, 11);
  assert.equal(error.supportedVersions, '1〜10');
  assert.deepEqual(readFileSync(dbPath), bytes);

  const entry = describeStartupFailure(error);
  assert.equal(entry.code, 'SCHEMA_INCOMPATIBLE');
  assert.equal(entry.schemaVersion, 11);
  assert.equal(entry.supportedVersions, '1〜10');
  assert.match(entry.recovery, /書き換えていません/);
});

test('UC-4-X2: 実行環境は起動失敗のエラーに DB のパスを添えて解放する', async (t) => {
  const { directory, closing } = workspace(t);
  writeFileSync(join(directory, '.env'), `ANALYTICS_HOST=127.0.0.1\nANALYTICS_PORT=${await freePort()}\n`, 'utf8');
  // real モードで起動する。mock モードは固定ポート 8788 の練習用 Hub を起こし、runtime.test.js と衝突する。
  mkdirSync(join(directory, '.local'));
  writeFileSync(join(directory, '.local', 'hubs.json'), '{"hubs":[]}', 'utf8');
  const dbPath = join(directory, 'data', 'real', 'analytics.sqlite');
  seed(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA user_version = 11');
  db.close();

  await assert.rejects(startRuntime({ mode: 'real', rootDir: directory, env: {} }), (error) => error.code === 'SCHEMA_INCOMPATIBLE' && error.dbPath === dbPath);
  // ロックが解放されていれば、正常な DB で同じルートから起動できる。
  rmSync(dbPath);
  const runtime = await startRuntime({ mode: 'real', rootDir: directory, env: {} });
  closing(() => runtime.stop());
  assert.deepEqual(runtime.app.store.schema, { version: 10, migratedFrom: null });
});

test('汎用の起動失敗は従来どおり原因コードだけを出し、版はリポジトリの HEAD から読む', () => {
  const entry = describeStartupFailure(Object.assign(new Error('boom'), { code: 'EACCES' }));
  assert.deepEqual(entry, { level: 'error', operation: 'startup', reason: '起動に失敗しました。', code: 'EACCES' });
  assert.match(readVersion(process.cwd()), /^[0-9a-f]{7,}$/);
  assert.equal(readVersion(tmpdir()), null);
});
