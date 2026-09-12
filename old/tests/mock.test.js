import assert from 'node:assert/strict';
import test from 'node:test';
import { createMockHub } from '../mock/hub.js';
import { makeStats } from '../mock/fixture.js';

function waitForListening(server) {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

async function readUntil(reader, marker) {
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes(marker)) {
    const result = await reader.read();
    if (result.done) return text;
    text += decoder.decode(result.value, { stream: true });
  }
  return text;
}

function eventData(text, eventName) {
  const event = text.split('\n\n').find((part) => part.includes(`event: ${eventName}`));
  assert.ok(event, `event ${eventName} was not received`);
  const data = event.split('\n').find((line) => line.startsWith('data: '));
  assert.ok(data, `event ${eventName} has no data line`);
  return JSON.parse(data.slice('data: '.length));
}

test('Mock Hub protects stats and stream with Bearer or X-Token-Monitor-Secret', async () => {
  const hub = createMockHub({ secret: 'test-secret' });
  await waitForListening(hub.server);
  try {
    const unauthenticated = await fetch(`${hub.url}/api/stats`);
    assert.equal(unauthenticated.status, 401);

    const bearer = await fetch(`${hub.url}/api/stats`, {
      headers: { authorization: 'Bearer test-secret' }
    });
    assert.equal(bearer.status, 200);
    assert.deepEqual(await bearer.json(), makeStats());

    const header = await fetch(`${hub.url}/api/stats`, {
      headers: { 'x-token-monitor-secret': 'test-secret' }
    });
    assert.equal(header.status, 200);

    const other = await fetch(`${hub.url}/other`, {
      headers: { authorization: 'Bearer test-secret' }
    });
    assert.equal(other.status, 404);
  } finally {
    await hub.close();
  }
});

test('stream starts with snapshot and publishes update frames', async () => {
  const initial = makeStats({ costUsd: 7.5, usedPercent: 42 });
  const next = makeStats({ costUsd: 8.5, usedPercent: 43, at: '2026-09-12T02:05:00.000Z' });
  const hub = createMockHub({ stats: initial, secret: 'test-secret' });
  await waitForListening(hub.server);
  const response = await fetch(`${hub.url}/api/stats/stream`, {
    headers: { authorization: 'Bearer test-secret' }
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  try {
    const snapshot = eventData(await readUntil(reader, 'event: snapshot'), 'snapshot');
    assert.equal(snapshot.type, 'stats');
    assert.equal(snapshot.reason, 'snapshot');
    assert.equal(snapshot.stats.devices[0].periods.today.costUsd, 7.5);
    assert.equal(snapshot.stats.devices[0].limits.providers[0].windows[0].usedPercent, 42);

    hub.publish(next);
    const update = eventData(await readUntil(reader, 'event: stats'), 'stats');
    assert.equal(update.reason, 'update');
    assert.equal(update.stats.updatedAt, next.updatedAt);
    assert.equal(update.stats.devices[0].periods.today.costUsd, 8.5);
  } finally {
    await reader.cancel();
    await hub.close();
  }
});

test('disconnect closes active streams and permits a new snapshot connection', async () => {
  const hub = createMockHub({ secret: 'test-secret' });
  await waitForListening(hub.server);
  const open = () => fetch(`${hub.url}/api/stats/stream`, {
    headers: { 'x-token-monitor-secret': 'test-secret' }
  });
  const first = await open();
  const firstReader = first.body.getReader();
  try {
    await readUntil(firstReader, 'event: snapshot');
    assert.equal(hub.connections, 1);
    hub.disconnect();
    const closed = await firstReader.read();
    assert.equal(closed.done, true);
    assert.equal(hub.connections, 0);

    const second = await open();
    const secondReader = second.body.getReader();
    try {
      const snapshot = eventData(await readUntil(secondReader, 'event: snapshot'), 'snapshot');
      assert.equal(snapshot.reason, 'snapshot');
      assert.equal(hub.connections, 1);
    } finally {
      await secondReader.cancel();
    }
  } finally {
    await firstReader.cancel();
    await hub.close();
  }
});

test('stream emits heartbeat comments at the configured interval', async () => {
  const hub = createMockHub({ secret: 'test-secret', heartbeatMs: 10 });
  await waitForListening(hub.server);
  const response = await fetch(`${hub.url}/api/stats/stream`, {
    headers: { authorization: 'Bearer test-secret' }
  });
  const reader = response.body.getReader();
  try {
    await readUntil(reader, 'event: snapshot');
    const heartbeat = await readUntil(reader, ': heartbeat');
    assert.match(heartbeat, /: heartbeat\n\n/);
  } finally {
    await reader.cancel();
    await hub.close();
  }
});
