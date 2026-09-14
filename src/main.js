import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigurationError } from './config.js';
import { startRuntime, describeStartupFailure } from './runtime.js';

const rootDir = process.cwd();
let runtime;
let logFile;
const mode = process.argv[2];
function log(entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  if (entry.level === 'error') console.error(line);
  else console.log(line);
  if (logFile) {
    try { appendFileSync(logFile, `${line}\n`, 'utf8'); }
    catch (error) {
      console.error(JSON.stringify({ at: new Date().toISOString(), level: 'error', operation: 'log-write', reason: 'ログファイルに記録できませんでした。', code: typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : null }));
    }
  }
}
try {
  if (process.argv.length !== 3 || !['real', 'mock'].includes(mode)) throw new ConfigurationError('起動モードを real または mock で指定してください。');
  mkdirSync(resolve(rootDir, '.local'), { recursive: true });
  logFile = resolve(rootDir, '.local', `${mode}.log`);
  runtime = await startRuntime({ mode, rootDir, log });
  const schema = runtime.app.store.schema;
  log({ level: 'info', operation: 'started', mode, host: runtime.configuration.host, port: runtime.app.address.port, version: runtime.version, schemaVersion: schema.version, migratedFrom: schema.migratedFrom });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try { await runtime.stop(); log({ level: 'info', operation: 'stopped', mode }); }
    catch { console.error('終了処理に失敗しました。'); process.exitCode = 1; }
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch (error) {
  try { log(describeStartupFailure(error)); }
  catch { console.error('ログファイルに記録できませんでした。'); }
  if (runtime) await runtime.stop();
  process.exitCode = 1;
}
