import test from 'node:test';
import assert from 'node:assert/strict';
import {MOCK_HUB_SECRET, parseMockHubArgs, startMockHub} from '../mockhub.mjs';

async function fixture(t, options = {}) {
  const hub = await startMockHub({listen: '127.0.0.1:0', intervalMs: 10, ...options});
  t.after(() => hub.close());
  return hub;
}

async function firstFrame(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('\n\n')) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error('SSE stream ended before a frame');
    text += decoder.decode(chunk.value, {stream: true});
  }
  await reader.cancel();
  const data = text.split('\n').find(line => line.startsWith('data: '));
  return {text, payload: JSON.parse(data.slice(6))};
}

test('CLI parser preserves listen and disconnect-after flags', () => {
  assert.deepEqual(parseMockHubArgs(['-listen', '127.0.0.1:9000', '-disconnect-after', '2']), {
    listen: '127.0.0.1:9000', disconnectAfter: 2,
  });
  assert.deepEqual(parseMockHubArgs(['--listen=127.0.0.1:9001', '--disconnect-after=1']), {
    listen: '127.0.0.1:9001', disconnectAfter: 1,
  });
  assert.throws(() => parseMockHubArgs(['-disconnect-after', '-1']), /non-negative/);
  assert.throws(() => parseMockHubArgs(['-unknown', 'x']), /unknown option/);
});

test('health is public while stats and devices require the shared secret', async t => {
  const hub = await fixture(t);
  const health = await fetch(`${hub.origin}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {ok: true, synthetic: true});

  const wrong = await fetch(`${hub.origin}/api/devices`, {headers: {Authorization: 'Bearer wrong'}});
  assert.equal(wrong.status, 401);
  const devices = await fetch(`${hub.origin}/api/devices`, {headers: {Authorization: `Bearer ${MOCK_HUB_SECRET}`}});
  assert.equal(devices.status, 200);
  const body = await devices.json();
  assert.equal(body.devices.length, 1);
  assert.equal(body.devices[0].deviceId, 'demo-pc');
  assert.equal(body.devices[0].historyAvailable, true);
  assert.ok(body.devices[0].history.daily.length > 0);
});

test('authenticated SSE emits snapshot then stats and supports disconnect-after', async t => {
  const hub = await fixture(t, {disconnectAfter: 2});
  const response = await fetch(`${hub.origin}/api/stats/stream`, {
    headers: {Authorization: `Bearer ${MOCK_HUB_SECRET}`},
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const text = await response.text();
  assert.equal((text.match(/event: /g) || []).length, 2);
  assert.match(text, /event: snapshot\ndata: /);
  assert.match(text, /event: stats\ndata: /);
  const payload = JSON.parse(text.split('\n').find(line => line.startsWith('data: ')).slice(6));
  assert.equal(payload.type, 'stats');
  assert.ok(Array.isArray(payload.stats.devices));
  assert.equal(payload.stats.deviceHistoryRevision, hub.revisions.deviceHistoryRevision);
});

test('revision controls change device history invalidation without changing the CLI contract', async t => {
  const hub = await fixture(t);
  const before = hub.revisions;
  hub.setDeviceHistory('demo-pc', {
    daily: [{date: '2026-09-01', tokens: 7, cost: 0.7}],
    monthly: [{month: '2026-09', tokens: 7, cost: 0.7}],
    summary: {totalTokens: 7},
  });
  assert.notEqual(hub.revisions.deviceHistoryRevision, before.deviceHistoryRevision);
  const response = await fetch(`${hub.origin}/api/devices`, {headers: {Authorization: `Bearer ${MOCK_HUB_SECRET}`}});
  const body = await response.json();
  assert.deepEqual(body.devices[0].history.daily, [{date: '2026-09-01', tokens: 7, cost: 0.7}]);

  hub.setRevisions({historyRevision: 'history-test-revision', deviceHistoryRevision: 'device-test-revision'});
  const stream = await fetch(`${hub.origin}/api/stats/stream`, {headers: {Authorization: `Bearer ${MOCK_HUB_SECRET}`}});
  const frame = await firstFrame(stream);
  assert.equal(frame.payload.stats.historyRevision, 'history-test-revision');
  assert.equal(frame.payload.stats.deviceHistoryRevision, 'device-test-revision');
});
