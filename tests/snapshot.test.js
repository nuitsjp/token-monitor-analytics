import test from 'node:test';
import assert from 'node:assert/strict';
import { InvalidSnapshot, parseSnapshot } from '../src/snapshot.js';
import { makeStats } from '../mock/fixture.js';

function envelope(options = {}) {
  const stats = makeStats(options);
  return {
    type: 'stats',
    reason: 'snapshot',
    stats,
    at: options.at ?? '2026-09-12T02:00:00.000Z'
  };
}

function text(value) {
  return JSON.stringify(value);
}

test('parseSnapshot keeps provider, window, and null values without collapsing windows', () => {
  const payload = envelope();
  const provider = payload.stats.limits.providers[0];
  provider.provider = 'future-provider';
  provider.accountKey = null;
  provider.balance = null;
  provider.windows = [
    {
      ...provider.windows[0],
      kind: 'shared-kind',
      limitId: 'shared-limit',
      remaining: null,
      usedPercent: null,
      remainingPercent: null
    },
    {
      ...provider.windows[0],
      kind: 'shared-kind',
      limitId: 'shared-limit',
      label: 'second window',
      remaining: 8,
      usedPercent: 20,
      remainingPercent: 80
    }
  ];
  payload.stats.periods.today.costUsd = null;

  const parsed = parseSnapshot(text(payload));
  const parsedProvider = parsed.stats.limits.providers[0];

  assert.equal(parsed.upstreamAt, payload.at);
  assert.equal(parsedProvider.provider, 'future-provider');
  assert.equal(parsedProvider.accountKey, null);
  assert.equal(parsedProvider.balance, null);
  assert.equal(parsedProvider.windows.length, 2);
  assert.deepEqual(
    parsedProvider.windows.map(({ kind, limitId, label }) => ({ kind, limitId, label })),
    [
      { kind: 'shared-kind', limitId: 'shared-limit', label: provider.windows[0].label },
      { kind: 'shared-kind', limitId: 'shared-limit', label: 'second window' }
    ]
  );
  assert.equal(parsedProvider.windows[0].remaining, null);
  assert.equal(parsedProvider.windows[0].usedPercent, null);
  assert.equal(parsedProvider.windows[0].remainingPercent, null);
  assert.equal(parsed.stats.periods.today.costUsd, null);
});

test('parseSnapshot rejects malformed JSON, wrong types, and duplicate device IDs', () => {
  assert.throws(() => parseSnapshot('{not-json'), InvalidSnapshot);

  const wrongEnvelopeType = envelope();
  wrongEnvelopeType.type = 'not-stats';
  assert.throws(() => parseSnapshot(text(wrongEnvelopeType)), InvalidSnapshot);

  const wrongFieldType = envelope();
  wrongFieldType.stats.limits.providers[0].windows[0].usedPercent = '25';
  assert.throws(() => parseSnapshot(text(wrongFieldType)), InvalidSnapshot);

  const duplicateDeviceIds = envelope();
  duplicateDeviceIds.stats.devices[1].deviceId = duplicateDeviceIds.stats.devices[0].deviceId;
  assert.throws(() => parseSnapshot(text(duplicateDeviceIds)), InvalidSnapshot);
});

