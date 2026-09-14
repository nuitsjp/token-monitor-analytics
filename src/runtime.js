import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { loadConfiguration, ConfigurationError, parseHubs } from './config.js';
import { readHubRegistry } from './hub-registry.js';
import { startAnalytics } from './app.js';

// 登録練習用のMock Hub。再起動後も登録済みの接続先が同じになるよう固定ポートで待ち受ける。
const MOCK_REGISTRATION_PORT = 8788;
const MOCK_REGISTRATION_SECRET = 'mock';

export class RuntimeInUseError extends Error {
  constructor() {
    super('実データ用またはMock用が既に起動しています。先に起動したターミナルで Ctrl+C を押して終了してください。');
    this.code = 'RUNTIME_IN_USE';
  }
}

// 更新元は git pull なので、アプリの版は HEAD の短縮ハッシュで識別する（UC-4）。git が使えなければ null。
export function readVersion(rootDir) {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: rootDir, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

const RECOVERY = {
  SCHEMA_INCOMPATIBLE: 'DB は書き換えていません。この DB を作った版以降のコードへ git pull または git checkout で合わせて同じモードで起動してください。DB を削除・初期化しないでください。',
  MIGRATION_FAILED: 'DB は移行前の版とデータのままです。原因を解消して同じモードで再起動するか、git checkout で以前の版へ戻して起動してください。DB を削除・初期化しないでください。',
};

// 起動失敗をログ 1 行に要約する。スキーマ関連は原因コード・段階・版・復旧手順まで出し、それ以外は汎用文にとどめる。
export function describeStartupFailure(error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : null;
  const entry = { level: 'error', operation: 'startup', reason: error instanceof ConfigurationError || error instanceof RuntimeInUseError ? error.message : '起動に失敗しました。', code };
  if (code === 'SCHEMA_INCOMPATIBLE') {
    Object.assign(entry, { reason: 'DB のスキーマ版がこの版のアプリの対応範囲外です。', dbPath: error.dbPath ?? null, schemaVersion: error.schemaVersion, supportedVersions: error.supportedVersions, recovery: RECOVERY[code] });
  } else if (code === 'MIGRATION_FAILED') {
    Object.assign(entry, { reason: 'DB のスキーマ移行に失敗しました。', dbPath: error.dbPath ?? null, stage: error.stage, schemaVersion: error.schemaVersion, targetVersion: error.targetVersion, sqliteCode: error.sqliteCode, recovery: RECOVERY[code] });
  }
  return entry;
}

async function acquireRuntime(rootDir) {
  // The OS owns this Windows pipe, including release after forced process exit.
  const root = realpathSync(rootDir).toLowerCase();
  const id = createHash('sha256').update(root).digest('hex');
  const server = createServer((socket) => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(`\\\\.\\pipe\\token-monitor-analytics-${id}`, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    if (error.code === 'EADDRINUSE') throw new RuntimeInUseError();
    throw error;
  }
  return () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

export async function startRuntime({ mode, rootDir = process.cwd(), env = process.env, log = () => {} }) {
  if (!['real', 'mock'].includes(mode)) throw new ConfigurationError('mode_invalid');
  const release = await acquireRuntime(rootDir);
  const mocks = [];
  let app;
  async function close() {
    try { if (app) await app.stop(); }
    finally {
      try { await Promise.all(mocks.map((hub) => hub.close())); }
      finally { await release(); }
    }
  }
  let configuration;
  try {
    configuration = loadConfiguration({ rootDir, env, mode });
    if (mode === 'mock') {
      const { startMockHub } = await import('../mock/hub.js');
      const secret = randomUUID();
      const builtIn = await startMockHub({ host: '127.0.0.1', port: 0, secret });
      mocks.push(builtIn);
      // 自動登録はしない。画面から登録する練習相手として起動するだけ。
      const registration = await startMockHub({
        host: '127.0.0.1', port: MOCK_REGISTRATION_PORT, secret: MOCK_REGISTRATION_SECRET,
      });
      mocks.push(registration);
      configuration.hubs = [
        { id: 'mock', url: builtIn.url, secret, configError: null },
        ...parseHubs({ hubs: readHubRegistry(configuration.registryPath) }),
      ];
      configuration.mockRegistration = { url: registration.url, secret: MOCK_REGISTRATION_SECRET };
    }
    const version = readVersion(rootDir);
    app = await startAnalytics({ configuration, version, log });
    let stopped;
    return {
      app, configuration, version,
      stop: () => { stopped ??= close(); return stopped; },
    };
  } catch (error) {
    await close();
    if (configuration && (error?.code === 'SCHEMA_INCOMPATIBLE' || error?.code === 'MIGRATION_FAILED')) error.dbPath = configuration.dbPath;
    throw error;
  }
}
