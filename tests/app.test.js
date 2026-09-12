import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnalytics } from '../src/app.js';
import { createMockHub } from '../mock/hub.js';
import { makeStats } from '../mock/fixture.js';

const username = 'test';
const password = 'test-password';

function authorization(user = username, secret = password) {
  return `Basic ${Buffer.from(`${user}:${secret}`, 'utf8').toString('base64')}`;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, message = 'condition was not reached') {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(10);
  }
  assert.fail(message);
}

function rowCount(app, table) {
  return app.store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

async function setup({ databasePath = ':memory:' } = {}) {
  const hubSecret = `hub-secret-${Math.random().toString(36).slice(2)}`;
  const hub = createMockHub({ secret: hubSecret, heartbeatMs: 20 });
  await waitFor(() => hub.server.listening, 'mock Hub did not start');
  const config = {
    host: '127.0.0.1',
    port: 0,
    databasePath,
    username,
    password,
    hub: { id: `hub-${Math.random().toString(36).slice(2)}`, name: 'Test Hub', url: hub.url, secret: hubSecret }
  };
  const logs = [];
  let app;
  try {
    app = createAnalytics(config, {
      logger: { error(value) { logs.push(String(value)); } },
      reconnectMs: 20
    });
    await app.start();
    await waitFor(
      () => app.current().hubs[0].connection === 'connected' && app.current().hubs[0].snapshot,
      'Analytics did not receive the initial snapshot'
    );
    const address = app.server.address();
    return { app, hub, config, logs, base: `http://127.0.0.1:${address.port}` };
  } catch (error) {
    await app?.close().catch(() => {});
    await hub.close();
    throw error;
  }
}

async function teardown(context, stream) {
  await stream?.close();
  await context.app.close();
  await context.hub.close();
}

async function openEvents(base) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events`, {
    headers: { authorization: authorization() },
    signal: controller.signal
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  async function next() {
    while (true) {
      const separator = buffer.search(/\r?\n\r?\n/);
      if (separator >= 0) {
        const match = buffer.match(/\r?\n\r?\n/);
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + match[0].length);
        let event = null;
        let data = '';
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          if (line.startsWith('data:')) data += line.slice(5).trimStart();
        }
        return { event, data };
      }
      const chunk = await reader.read();
      if (chunk.done) return null;
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  }

  return {
    response,
    next,
    async close() {
      controller.abort();
      await reader.cancel().catch(() => {});
    }
  };
}

const timedOut = Symbol('timed out');

async function nextWithin(stream, milliseconds) {
  return Promise.race([
    stream.next(),
    delay(milliseconds).then(() => timedOut)
  ]);
}

async function waitEvent(stream, eventName, predicate = () => true) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const event = await nextWithin(stream, Math.max(1, deadline - Date.now()));
    if (event === timedOut) break;
    if (!event) break;
    if (event.event !== eventName) continue;
    const value = JSON.parse(event.data);
    if (predicate(value)) return value;
  }
  assert.fail(`SSE event ${eventName} was not received`);
}

async function request(context, path, headers = {}) {
  const response = await fetch(`${context.base}${path}`, {
    headers: { authorization: authorization(), ...headers }
  });
  const body = await response.text();
  return { response, body };
}

test('initial and changed snapshots are persisted, notified after saving, and retries do not append observations', async () => {
  const context = await setup();
  let stream;
  try {
    stream = await openEvents(context.base);
    await waitEvent(stream, 'status');
    const initial = context.app.current().hubs[0].snapshot;
    assert.equal(rowCount(context.app, 'observations'), 1);
    assert.deepEqual(initial.stats.devices.map((device) => device.deviceId), ['device-a', 'device-b']);

    const changed = makeStats({ costUsd: 14.5, usedPercent: 30, at: '2026-09-12T02:10:00.000Z' });
    const changedUpdate = waitEvent(
      stream,
      'update',
      (value) => value.hubs[0].snapshot?.stats.periods.today.costUsd === changed.periods.today.costUsd
    );
    context.hub.publish(changed);
    const changedPayload = await changedUpdate;
    const changedSnapshot = changedPayload.hubs[0].snapshot;
    assert.deepEqual(changedSnapshot.stats.devices.map((device) => device.deviceId), ['device-a', 'device-b']);
    assert.equal(changedSnapshot.stats.periods.today.costUsd, changed.periods.today.costUsd);
    assert.equal(rowCount(context.app, 'observations'), 2);
    assert.equal(rowCount(context.app, 'observed_devices'), 4);

    const retry = structuredClone(changed);
    retry.updatedAt = '2026-09-12T02:11:00.000Z';
    const retryUpdate = waitEvent(
      stream,
      'update',
      (value) => value.hubs[0].snapshot?.stats.periods.today.costUsd === changed.periods.today.costUsd
    );
    context.hub.publish(retry);
    const retryPayload = await retryUpdate;
    assert.equal(retryPayload.hubs[0].snapshot.id, changedSnapshot.id);
    assert.equal(rowCount(context.app, 'observations'), 2);
    assert.equal(rowCount(context.app, 'observed_devices'), 4);
  } finally {
    await teardown(context, stream);
  }
});

test('a Hub disconnect is reported and the stream reconnects automatically', async () => {
  const context = await setup();
  let stream;
  try {
    stream = await openEvents(context.base);
    await waitEvent(stream, 'status');
    context.hub.disconnect();
    assert.equal(context.hub.connections, 0);
    await waitFor(
      () => context.app.current().hubs[0].connection === 'disconnected',
      'Analytics did not report the Hub disconnect'
    );
    await waitFor(
      () => context.hub.connections > 0 && context.app.current().hubs[0].connection === 'connected',
      'Analytics did not reconnect to the Hub'
    );

    const recovered = makeStats({ costUsd: 18, usedPercent: 36, at: '2026-09-12T02:20:00.000Z' });
    const update = waitEvent(
      stream,
      'update',
      (value) => value.hubs[0].snapshot?.stats.periods.today.costUsd === recovered.periods.today.costUsd
    );
    context.hub.publish(recovered);
    await update;
    assert.equal(context.app.current().hubs[0].connection, 'connected');
    assert.equal(context.app.current().hubs[0].snapshot.stats.periods.today.costUsd, recovered.periods.today.costUsd);
  } finally {
    await teardown(context, stream);
  }
});

test('invalid Hub payloads are rejected without changing the previous value and valid input recovers', async () => {
  const context = await setup();
  let stream;
  try {
    stream = await openEvents(context.base);
    await waitEvent(stream, 'status');
    const previous = structuredClone(context.app.current().hubs[0].snapshot);
    const invalid = [
      '{not-json',
      JSON.stringify({ type: 'wrong-type', at: '2026-09-12T02:30:00.000Z', stats: makeStats() }),
      (() => {
        const value = makeStats();
        value.devices[1].deviceId = value.devices[0].deviceId;
        return JSON.stringify({ type: 'stats', at: '2026-09-12T02:30:00.000Z', stats: value });
      })()
    ];

    for (const data of invalid) {
      const status = waitEvent(stream, 'status', (value) => value.hubs[0].validationError);
      context.hub.sendRaw(data, 'stats');
      const payload = await status;
      assert.match(payload.hubs[0].validationError, /不正|形式|JSON/);
      assert.deepEqual(context.app.current().hubs[0].snapshot, previous);
      assert.equal(context.app.current().hubs[0].storageError, null);
    }

    const valid = makeStats({ costUsd: 16, usedPercent: 32, at: '2026-09-12T02:35:00.000Z' });
    const update = waitEvent(
      stream,
      'update',
      (value) => value.hubs[0].snapshot?.stats.periods.today.costUsd === valid.periods.today.costUsd
    );
    context.hub.publish(valid);
    const payload = await update;
    assert.equal(payload.hubs[0].validationError, null);
    assert.equal(payload.hubs[0].storageError, null);
    assert.equal(payload.hubs[0].snapshot.stats.periods.today.costUsd, valid.periods.today.costUsd);
  } finally {
    await teardown(context, stream);
  }
});

test('a save failure rolls back the value, emits status without update, and stops later writes', async () => {
  const context = await setup();
  let stream;
  try {
    stream = await openEvents(context.base);
    await waitEvent(stream, 'status');
    const previous = structuredClone(context.app.current().hubs[0].snapshot);
    const beforeRows = rowCount(context.app, 'observations');
    context.app.store.db.exec('PRAGMA query_only = ON');

    const failed = makeStats({ costUsd: 88, usedPercent: 70, at: '2026-09-12T02:40:00.000Z' });
    const status = waitEvent(stream, 'status', (value) => value.hubs[0].storageError);
    context.hub.publish(failed);
    const failedPayload = await status;
    assert.match(failedPayload.hubs[0].storageError, /保存失敗/);
    const next = await nextWithin(stream, 150);
    if (next !== timedOut && next?.event === 'update') assert.fail('save failure emitted update');
    assert.deepEqual(context.app.current().hubs[0].snapshot, previous);
    assert.equal(rowCount(context.app, 'observations'), beforeRows);

    context.hub.publish(makeStats({ costUsd: 91, usedPercent: 72, at: '2026-09-12T02:41:00.000Z' }));
    const later = await nextWithin(stream, 150);
    if (later !== timedOut && later?.event === 'update') assert.fail('writes continued after save failure');
    assert.deepEqual(context.app.current().hubs[0].snapshot, previous);
    assert.match(context.app.current().hubs[0].storageError, /保存失敗/);
  } finally {
    await teardown(context, stream);
  }
});

test('the screen, APIs, and browser SSE require Basic authentication and secrets stay out of output and logs', async () => {
  const context = await setup();
  let stream;
  try {
    for (const path of ['/', '/app.js', '/style.css', '/api/current', '/api/events']) {
      const response = await fetch(`${context.base}${path}`);
      const body = await response.text();
      assert.equal(response.status, 401, path);
      assert.match(response.headers.get('www-authenticate'), /^Basic /i);
      assert.doesNotMatch(body, new RegExp(`${password}|${context.config.hub.secret}`));
    }

    const page = await request(context, '/');
    assert.equal(page.response.status, 200);
    const current = await request(context, '/api/current');
    assert.equal(current.response.status, 200);
    assert.doesNotMatch(current.body, new RegExp(`${password}|${context.config.hub.secret}`));

    stream = await openEvents(context.base);
    assert.match(stream.response.headers.get('content-type'), /^text\/event-stream/i);
    await waitEvent(stream, 'status');
    context.hub.sendRaw(`{"type":"stats","secret":"${context.config.hub.secret}"}`, 'stats');
    await waitEvent(stream, 'status', (value) => value.hubs[0].validationError);
    assert.ok(context.logs.length > 0);
    assert.ok(context.logs.every((entry) => !entry.includes(password) && !entry.includes(context.config.hub.secret)));
  } finally {
    await teardown(context, stream);
  }
});

