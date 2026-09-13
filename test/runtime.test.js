import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

import { makeSnapshot, startMockHub } from '../mock/hub.js';
import { RuntimeInUseError, startRuntime } from '../src/runtime.js';

const HOST = '127.0.0.1';
const RUNTIME_PREFIX = 'token-runtime-';

function assertSafeWorkspace(directory) {
  const resolved = resolve(directory);
  assert.equal(dirname(resolved).toLowerCase(), resolve(tmpdir()).toLowerCase());
  assert.equal(basename(resolved).startsWith(RUNTIME_PREFIX), true);
  return resolved;
}

function createWorkspace({ port, hubsText = '{"hubs":[]}' }) {
  const rootDir = assertSafeWorkspace(mkdtempSync(join(tmpdir(), RUNTIME_PREFIX)));
  mkdirSync(join(rootDir, '.local'), { recursive: true });
  writeFileSync(
    join(rootDir, '.env'),
    `ANALYTICS_HOST=${HOST}\nANALYTICS_PORT=${port}\n`,
    'utf8'
  );
  writeFileSync(join(rootDir, '.local', 'hubs.json'), hubsText, 'utf8');
  return rootDir;
}

function writeHubConfiguration(rootDir, hub) {
  writeFileSync(
    join(rootDir, '.local', 'hubs.json'),
    JSON.stringify({ hubs: [hub] }),
    'utf8'
  );
}

function cleanupWorkspace(rootDir) {
  if (!rootDir) return;
  rmSync(assertSafeWorkspace(rootDir), { recursive: true, force: true });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen({ host: HOST, port: 0 }, () => {
      server.removeListener('error', reject);
      resolvePromise();
    });
  });
  const port = server.address().port;
  await new Promise((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise());
  });
  return port;
}

async function listen(server, port) {
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen({ host: HOST, port }, () => {
      server.removeListener('error', reject);
      resolvePromise();
    });
  });
}

async function waitUntil(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  assert.fail('Expected runtime state was not reached within the timeout');
}

async function readState(runtime) {
  const response = await fetch(`http://${HOST}:${runtime.app.address.port}/api/state`);
  assert.equal(response.status, 200);
  return response.json();
}

async function readHistory(runtime, query = '') {
  const response = await fetch(`http://${HOST}:${runtime.app.address.port}/api/estimates/history${query}`);
  assert.equal(response.status, 200);
  return response.json();
}

async function waitForNonEmptyHistory(runtime, timeoutMs = 5000) {
  let history;
  await waitUntil(async () => {
    history = await readHistory(runtime);
    return history.items.length > 0;
  }, timeoutMs);
  return history;
}

async function waitForHub(runtime, mode, hubId) {
  await waitUntil(async () => {
    const state = await readState(runtime);
    const hub = state.hubs.find((current) => current.id === hubId);
    return state.mode === mode
      && hub?.status.connection === 'connected'
      && hub.devices.length > 0;
  });
}

function readDatabaseSummary(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      hubs: db.prepare('SELECT id FROM hubs ORDER BY id').all().map((row) => row.id),
      observations: db.prepare('SELECT COUNT(*) AS count FROM observations').get().count,
    };
  } finally {
    db.close();
  }
}

function hashFile(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

async function expectRuntimeInUse(options) {
  let unexpectedRuntime;
  try {
    unexpectedRuntime = await startRuntime(options);
  } catch (error) {
    assert.equal(error instanceof RuntimeInUseError, true);
    assert.equal(error.code, 'RUNTIME_IN_USE');
    return;
  }
  try {
    await unexpectedRuntime.stop();
  } finally {
    assert.fail('A second runtime unexpectedly started');
  }
}

async function expectClosed(url) {
  await assert.rejects(() => fetch(`${url}/api/health`));
}

function waitForChildReady(child) {
  return new Promise((resolvePromise, reject) => {
    let output = '';
    let settled = false;
    const timer = setTimeout(() => finish(reject, new Error('Child runtime did not start in time')), 5000);
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
      settle(value);
    };
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes('READY\n')) finish(resolvePromise, output);
    };
    const onError = () => finish(reject, new Error('Child runtime failed to spawn'));
    const onExit = () => finish(reject, new Error('Child runtime exited before ready'));
    child.stdout?.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolvePromise());
  });
}

function startRuntimeChild(rootDir, port) {
  const runtimeModule = pathToFileURL(resolve('src/runtime.js')).href;
  const source = [
    `import { startRuntime } from ${JSON.stringify(runtimeModule)};`,
    `await startRuntime({ mode: 'mock', rootDir: ${JSON.stringify(rootDir)}, env: { ANALYTICS_HOST: '${HOST}', ANALYTICS_PORT: '${port}' }, log: () => {} });`,
    "process.stdout.write('READY\\n');",
    'setInterval(() => {}, 1000);',
  ].join('\n');
  return spawn(process.execPath, ['--input-type=module', '-e', source], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

test('mock runtime ignores broken real configuration and persists only to the mock database', async (t) => {
  const port = await freePort();
  const marker = 'runtime-real-secret-marker';
  const rootDir = createWorkspace({
    port,
    hubsText: `{"hubs":[{"id":"real","url":"http://127.0.0.1:1","secret":"${marker}`,
  });
  let runtime;
  t.after(async () => {
    await runtime?.stop();
    cleanupWorkspace(rootDir);
  });

  runtime = await startRuntime({
    mode: 'mock',
    rootDir,
    env: { ANALYTICS_HOST: HOST, ANALYTICS_PORT: String(port) },
    log: () => {},
  });

  assert.equal(runtime.configuration.mode, 'mock');
  assert.equal(runtime.configuration.configPath, null);
  assert.deepEqual(runtime.configuration.hubs.map((hub) => hub.id), ['mock']);
  assert.equal(runtime.configuration.dbPath, join(rootDir, 'data', 'mock', 'analytics.sqlite'));
  assert.equal(runtime.configuration.logPath, join(rootDir, '.local', 'mock.log'));
  assert.equal(existsSync(join(rootDir, 'data', 'real', 'analytics.sqlite')), false);

  await waitForHub(runtime, 'mock', 'mock');
  const state = await readState(runtime);
  assert.equal(state.mode, 'mock');
  assert.deepEqual(state.hubs.map((hub) => hub.id), ['mock']);
  assert.equal(state.hubs[0].devices.length, 2);

  const summary = readDatabaseSummary(runtime.configuration.dbPath);
  assert.deepEqual(summary.hubs, ['mock']);
  assert.equal(summary.observations >= 2, true);
  assert.equal(JSON.stringify(state).includes(marker), false);

  const mockHubUrl = runtime.configuration.hubs[0].url;
  await runtime.stop();
  runtime = null;
  await expectClosed(mockHubUrl);
});

test('real runtime connects only to the configured Hub and uses the real database and log paths', async (t) => {
  const secret = 'runtime-real-hub-secret';
  const hub = await startMockHub({ port: 0, automatic: false, secret });
  const port = await freePort();
  const rootDir = createWorkspace({ port });
  writeHubConfiguration(rootDir, { id: 'fixture', url: hub.url, secret });
  let runtime;
  t.after(async () => {
    await Promise.allSettled([runtime?.stop(), hub.close()]);
    cleanupWorkspace(rootDir);
  });

  runtime = await startRuntime({
    mode: 'real',
    rootDir,
    env: { ANALYTICS_HOST: HOST, ANALYTICS_PORT: String(port) },
    log: () => {},
  });

  assert.equal(runtime.configuration.mode, 'real');
  assert.equal(runtime.configuration.configPath, join(rootDir, '.local', 'hubs.json'));
  assert.equal(runtime.configuration.dbPath, join(rootDir, 'data', 'real', 'analytics.sqlite'));
  assert.equal(runtime.configuration.logPath, join(rootDir, '.local', 'real.log'));
  assert.deepEqual(runtime.configuration.hubs.map((current) => current.id), ['fixture']);

  await waitForHub(runtime, 'real', 'fixture');
  const state = await readState(runtime);
  assert.equal(state.mode, 'real');
  assert.deepEqual(state.hubs.map((current) => current.id), ['fixture']);
  assert.equal(state.hubs[0].devices.length, 2);

  const summary = readDatabaseSummary(runtime.configuration.dbPath);
  assert.deepEqual(summary.hubs, ['fixture']);
  assert.equal(summary.observations >= 2, true);
  assert.equal(existsSync(join(rootDir, 'data', 'mock', 'analytics.sqlite')), false);
  assert.equal(JSON.stringify(state).includes(secret), false);

  await runtime.stop();
  runtime = null;
});

test('runtime lock rejects cross-mode and same-mode duplicates regardless of HTTP port, then allows switching after stop', async (t) => {
  const realSecret = 'runtime-switch-real-secret';
  const hub = await startMockHub({ port: 0, automatic: false, secret: realSecret });
  const initialPort = await freePort();
  const rootDir = createWorkspace({ port: initialPort });
  writeHubConfiguration(rootDir, { id: 'fixture', url: hub.url, secret: realSecret });
  let runtime;
  t.after(async () => {
    await Promise.allSettled([runtime?.stop(), hub.close()]);
    cleanupWorkspace(rootDir);
  });

  runtime = await startRuntime({
    mode: 'mock',
    rootDir,
    env: { ANALYTICS_HOST: HOST, ANALYTICS_PORT: String(initialPort) },
    log: () => {},
  });
  await waitForHub(runtime, 'mock', 'mock');
  const firstMockHubUrl = runtime.configuration.hubs[0].url;
  const mockDbPath = runtime.configuration.dbPath;
  const realDbPath = join(rootDir, 'data', 'real', 'analytics.sqlite');
  const mockHistory = await waitForNonEmptyHistory(runtime);
  assert.equal(mockHistory.items.length > 0, true);

  await expectRuntimeInUse({
    mode: 'real',
    rootDir,
    env: { ANALYTICS_HOST: HOST, ANALYTICS_PORT: String(await freePort()) },
    log: () => {},
  });
  await expectRuntimeInUse({
    mode: 'mock',
    rootDir,
    env: { ANALYTICS_HOST: HOST, ANALYTICS_PORT: String(await freePort()) },
    log: () => {},
  });

  await runtime.stop();
  runtime = null;
  await expectClosed(firstMockHubUrl);
  const mockDbBeforeReal = hashFile(mockDbPath);

  const realPort = await freePort();
  runtime = await startRuntime({
    mode: 'real',
    rootDir,
    env: { ANALYTICS_HOST: HOST, ANALYTICS_PORT: String(realPort) },
    log: () => {},
  });
  await waitForHub(runtime, 'real', 'fixture');
  hub.broadcast(makeSnapshot({
    value: 3,
    updatedAt: new Date(Date.now() + 1000).toISOString(),
  }));
  const realHistory = await waitForNonEmptyHistory(runtime);
  assert.equal(realHistory.items.length > 0, true);
  assert.equal((await readState(runtime)).mode, 'real');
  assert.deepEqual((await readState(runtime)).hubs.map((current) => current.id), ['fixture']);
  assert.deepEqual((await readHistory(runtime, '?hubId=fixture')).items.length > 0, true);
  assert.deepEqual((await readHistory(runtime, '?hubId=mock')).items, []);

  await expectRuntimeInUse({
    mode: 'real',
    rootDir,
    env: { ANALYTICS_HOST: HOST, ANALYTICS_PORT: String(await freePort()) },
    log: () => {},
  });
  await expectRuntimeInUse({
    mode: 'mock',
    rootDir,
    env: { ANALYTICS_HOST: HOST, ANALYTICS_PORT: String(await freePort()) },
    log: () => {},
  });

  await runtime.stop();
  runtime = null;
  assert.equal(hashFile(mockDbPath), mockDbBeforeReal);
  assert.deepEqual(readDatabaseSummary(realDbPath).hubs, ['fixture']);
  const realDbBeforeMock = hashFile(realDbPath);
  const mockPort = await freePort();
  runtime = await startRuntime({
    mode: 'mock',
    rootDir,
    env: { ANALYTICS_HOST: HOST, ANALYTICS_PORT: String(mockPort) },
    log: () => {},
  });
  await waitForHub(runtime, 'mock', 'mock');
  assert.equal((await readState(runtime)).mode, 'mock');
  assert.deepEqual((await readState(runtime)).hubs.map((current) => current.id), ['mock']);
  const mockHistoryAfterSwitch = await waitForNonEmptyHistory(runtime);
  assert.equal(mockHistoryAfterSwitch.items.length > 0, true);
  assert.deepEqual((await readHistory(runtime, '?hubId=mock')).items.length > 0, true);
  assert.deepEqual((await readHistory(runtime, '?hubId=fixture')).items, []);
  await runtime.stop();
  runtime = null;
  assert.equal(hashFile(realDbPath), realDbBeforeMock);
});

test('startup failure releases the runtime lock and permits a later mock start', async (t) => {
  const busyPort = await freePort();
  const busyServer = createServer();
  await listen(busyServer, busyPort);
  const rootDir = createWorkspace({ port: busyPort, hubsText: '{"hubs":[}' });
  let runtime;
  t.after(async () => {
    await Promise.allSettled([
      runtime?.stop(),
      new Promise((resolvePromise) => busyServer.close(() => resolvePromise())),
    ]);
    cleanupWorkspace(rootDir);
  });

  await assert.rejects(
    () => startRuntime({
      mode: 'real',
      rootDir,
      env: { ANALYTICS_HOST: HOST, ANALYTICS_PORT: String(busyPort) },
      log: () => {},
    }),
    (error) => error?.code === 'configuration_file_invalid_json'
  );

  await assert.rejects(
    () => startRuntime({
      mode: 'mock',
      rootDir,
      env: { ANALYTICS_HOST: HOST, ANALYTICS_PORT: String(busyPort) },
      log: () => {},
    }),
    (error) => error?.code === 'EADDRINUSE'
  );

  await new Promise((resolvePromise, reject) => busyServer.close((error) => error ? reject(error) : resolvePromise()));
  const port = await freePort();
  runtime = await startRuntime({
    mode: 'mock',
    rootDir,
    env: { ANALYTICS_HOST: HOST, ANALYTICS_PORT: String(port) },
    log: () => {},
  });
  await waitForHub(runtime, 'mock', 'mock');
  assert.equal((await readState(runtime)).mode, 'mock');
  await runtime.stop();
  runtime = null;
});

test('forced child termination releases the runtime lock and leaves the mock database reusable', async (t) => {
  const childPort = await freePort();
  const rootDir = createWorkspace({
    port: childPort,
    hubsText: '{"hubs":[{"id":"broken","url":"http://127.0.0.1:1","secret":"child-real-secret-marker',
  });
  const child = startRuntimeChild(rootDir, childPort);
  let runtime;
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await waitForChildExit(child);
    await runtime?.stop();
    cleanupWorkspace(rootDir);
  });

  await waitForChildReady(child);
  await expectRuntimeInUse({
    mode: 'mock',
    rootDir,
    env: { ANALYTICS_HOST: HOST, ANALYTICS_PORT: String(await freePort()) },
    log: () => {},
  });

  assert.equal(child.kill('SIGKILL'), true);
  await waitForChildExit(child);

  const port = await freePort();
  runtime = await startRuntime({
    mode: 'mock',
    rootDir,
    env: { ANALYTICS_HOST: HOST, ANALYTICS_PORT: String(port) },
    log: () => {},
  });
  await waitForHub(runtime, 'mock', 'mock');
  assert.equal((await readState(runtime)).mode, 'mock');
  const summary = readDatabaseSummary(runtime.configuration.dbPath);
  assert.deepEqual(summary.hubs, ['mock']);
  assert.equal(summary.observations >= 2, true);
  await runtime.stop();
  runtime = null;
});
