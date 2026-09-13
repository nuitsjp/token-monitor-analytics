import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { loadConfiguration, ConfigurationError } from './config.js';
import { startAnalytics } from './app.js';

export class RuntimeInUseError extends Error {
  constructor() {
    super('実データ用またはMock用が既に起動しています。先に起動したターミナルで Ctrl+C を押して終了してください。');
    this.code = 'RUNTIME_IN_USE';
  }
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
  let mock;
  let app;
  async function close() {
    try { if (app) await app.stop(); }
    finally {
      try { if (mock) await mock.close(); }
      finally { await release(); }
    }
  }
  try {
    const configuration = loadConfiguration({ rootDir, env, mode });
    if (mode === 'mock') {
      const { startMockHub } = await import('../mock/hub.js');
      const secret = randomUUID();
      mock = await startMockHub({ host: '127.0.0.1', port: 0, secret });
      configuration.hubs = [{ id: 'mock', url: mock.url, secret, configError: null }];
    }
    app = await startAnalytics({ configuration, log });
    let stopped;
    return {
      app, configuration,
      stop: () => { stopped ??= close(); return stopped; },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
