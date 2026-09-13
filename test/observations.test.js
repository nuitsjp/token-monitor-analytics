import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeNotification, ValidationError } from '../src/observations.js';

const T0 = '2026-09-13T00:00:00.000Z';
const T1 = '2026-09-13T00:01:00.000Z';

function period(totalTokens = 10, costUsd = 1.25) {
  return { totalTokens, costUsd };
}

function periods(totalTokens = 10, costUsd = 1.25) {
  return {
    today: period(totalTokens, costUsd),
    month: period(totalTokens, costUsd),
    allTime: period(totalTokens, costUsd)
  };
}

function window(overrides = {}) {
  return {
    kind: 'session',
    label: 'Session',
    used: null,
    limit: null,
    remaining: null,
    usedPercent: 20,
    remainingPercent: 80,
    resetsAt: '2026-09-13T05:00:00.000Z',
    windowMinutes: 300,
    showMeter: true,
    ...overrides
  };
}

function provider(name = 'codex', overrides = {}) {
  return {
    provider: name,
    accountKey: `account-${name}`,
    accountLabel: `${name} account`,
    planLabel: 'Plus',
    status: 'ok',
    source: 'oauth',
    updatedAt: T0,
    windows: [window()],
    balanceUsd: null,
    balance: null,
    resetCredits: null,
    ...overrides
  };
}

function device(deviceId = 'device-a', overrides = {}) {
  return {
    deviceId,
    hostname: 'Test device',
    platform: 'win32',
    updatedAt: T0,
    receivedAt: T0,
    ageMs: 0,
    stale: false,
    periods: periods(),
    periodWindows: {
      today: { key: '2026-09-13', endsAt: '2026-09-14T00:00:00.000Z' },
      month: { key: '2026-09', endsAt: '2026-10-01T00:00:00.000Z' },
      timeZone: 'Asia/Tokyo'
    },
    clientStatus: { codex: 'active' },
    limits: { updatedAt: T0, refreshMs: 300_000, providers: [provider()] },
    ...overrides
  };
}

function payload(devices = [device()], overrides = {}) {
  return {
    type: 'stats',
    reason: 'snapshot',
    at: T0,
    stats: {
      updatedAt: T0,
      periods: periods(),
      limits: { updatedAt: T0, providers: [provider()] },
      devices,
      ...overrides
    }
  };
}

test('projects the known current values and keeps transport metadata separate', () => {
  const input = payload([device('device-a', {
    unknownDeviceField: 'ignored',
    limits: {
      updatedAt: T1,
      refreshMs: 600_000,
      providers: [provider('codex', { unknownProviderField: 'ignored' })]
    }
  })], { unknownStatsField: 'ignored' });

  const normalized = normalizeNotification(input);

  assert.equal(normalized.hubCurrent.updatedAt, T0);
  assert.equal(normalized.hubCurrent.periods.today.costUsd, 1.25);
  assert.equal(normalized.devices[0].deviceId, 'device-a');
  assert.equal(normalized.devices[0].observation.updatedAt, T0);
  assert.equal(normalized.devices[0].observation.periods.today.totalTokens, 10);
  assert.equal(normalized.devices[0].observation.limits.providers[0].status, 'ok');
  assert.equal(normalized.devices[0].metadata.hostname, 'Test device');
  assert.equal(normalized.devices[0].metadata.receivedAt, T0);
  assert.equal(normalized.devices[0].metadata.stale, false);
  assert.equal('receivedAt' in normalized.devices[0].observation, false);
  assert.equal('updatedAt' in normalized.devices[0].observation.limits, false);
  assert.equal('unknownDeviceField' in normalized.devices[0].observation, false);
  assert.equal('unknownProviderField' in normalized.devices[0].observation.limits.providers[0], false);
  assert.doesNotMatch(normalized.devices[0].comparisonJson, /receivedAt|ageMs|stale|refreshMs/);
});

test('accepts null only for nullable unavailable values without filling zero', () => {
  const input = payload([device('device-a', {
    updatedAt: null,
    receivedAt: null,
    limits: {
      updatedAt: null,
      refreshMs: null,
      providers: [provider('codex', {
        updatedAt: null,
        balanceUsd: null,
        windows: [window({ usedPercent: null, remainingPercent: null, resetsAt: null })]
      })]
    }
  })], { updatedAt: null, limits: null });

  const normalized = normalizeNotification(input);
  const resultDevice = normalized.devices[0];
  assert.equal(normalized.hubCurrent.updatedAt, null);
  assert.equal(normalized.hubCurrent.limits, null);
  assert.equal(resultDevice.observation.updatedAt, null);
  assert.equal(resultDevice.metadata.receivedAt, null);
  assert.equal(resultDevice.observation.limits.providers[0].updatedAt, null);
  assert.equal(resultDevice.observation.limits.providers[0].windows[0].usedPercent, null);
  assert.equal(resultDevice.observation.limits.providers[0].windows[0].resetsAt, null);
});

test('keeps optional null fields and null collections as unavailable', () => {
  const input = payload([
    device('device-a', {
      hostname: null,
      clientStatus: null,
      clientHealth: null,
      wslStatus: null,
      limits: {
        updatedAt: null,
        refreshMs: null,
        providers: [provider('codex', {
          provider: null,
          accountLabel: null,
          status: null,
          windows: null,
          accountKeyAliases: null
        })]
      }
    }),
    device('device-b', { limits: { updatedAt: null, refreshMs: null, providers: null } })
  ], { limits: { updatedAt: null, providers: null } });

  const normalized = normalizeNotification(input);
  const first = normalized.devices[0];
  assert.equal(normalized.hubCurrent.limits.providers, null);
  assert.equal(first.metadata.hostname, null);
  assert.equal(first.observation.clientStatus, null);
  assert.equal(first.observation.clientHealth, null);
  assert.equal(first.observation.wslStatus, null);
  assert.equal(first.observation.limits.providers[0].provider, null);
  assert.equal(first.observation.limits.providers[0].status, null);
  assert.equal(first.observation.limits.providers[0].windows, null);
  assert.equal(first.observation.limits.providers[0].accountKeyAliases, null);
  assert.equal(normalized.devices[1].observation.limits.providers, null);
});

test('rejects numeric strings with a safe field path and no received value', () => {
  const secretValue = '123-secret-value';
  const input = payload([device('device-a', {
    periods: {
      ...periods(),
      today: { totalTokens: secretValue, costUsd: 1.25 }
    }
  })]);

  assert.throws(
    () => normalizeNotification(input),
    (error) => {
      assert.equal(error instanceof ValidationError, true);
      assert.match(error.message, /stats\.devices\[0\]\.periods\.today\.totalTokens/);
      assert.doesNotMatch(error.message, new RegExp(secretValue));
      return true;
    }
  );
});

test('does not expose dynamic map keys in validation errors', () => {
  const secretKey = 'secret-client-credential';
  const input = payload([device('device-a', {
    clientStatus: { [secretKey]: 123 }
  })]);

  assert.throws(
    () => normalizeNotification(input),
    (error) => {
      assert.equal(error instanceof ValidationError, true);
      assert.match(error.message, /clientStatus\.\*/);
      assert.doesNotMatch(error.message, new RegExp(secretKey));
      return true;
    }
  );
});

test('rejects impossible or malformed timestamps', () => {
  assert.throws(
    () => normalizeNotification(payload([device('device-a', { updatedAt: '2026-02-30T00:00:00.000Z' })])),
    (error) => error instanceof ValidationError && /updatedAt/.test(error.message)
  );
  assert.throws(
    () => normalizeNotification(payload([device('device-a', {
      limits: { updatedAt: T0, providers: [provider('codex', { updatedAt: 'yesterday' })] }
    })])),
    (error) => error instanceof ValidationError && /providers\[0\]\.updatedAt/.test(error.message)
  );
  assert.throws(
    () => normalizeNotification(payload([device('device-a', {
      periodWindows: {
        today: { key: '2026-02-30', endsAt: T0 },
        month: { key: '2026-02', endsAt: T1 }
      }
    })])),
    (error) => error instanceof ValidationError && /periodWindows\.today\.key/.test(error.message)
  );
});

test('rejects duplicate device ids and invalid collection elements', () => {
  assert.throws(
    () => normalizeNotification(payload([device('device-a'), device('device-a')])),
    (error) => error instanceof ValidationError && /deviceId.*重複/.test(error.message)
  );
  assert.throws(
    () => normalizeNotification(payload([device('device-a', {
      limits: { updatedAt: T0, providers: [null] }
    })])),
    (error) => error instanceof ValidationError && /providers\[0\]/.test(error.message)
  );
  assert.throws(
    () => normalizeNotification(payload([device('device-a', {
      limits: { updatedAt: T0, providers: [provider('codex', { windows: [null] })] }
    })])),
    (error) => error instanceof ValidationError && /windows\[0\]/.test(error.message)
  );
});

test('device, provider, and window ordering does not change comparison JSON', () => {
  const firstProvider = provider('codex', {
    windows: [window({ kind: 'weekly', label: 'Weekly' }), window({ kind: 'session', label: 'Session' })]
  });
  const secondProvider = provider('claude', {
    windows: [window({ kind: 'billing', label: 'Billing' })]
  });
  const first = payload([
    device('device-b', { limits: { updatedAt: T0, providers: [firstProvider, secondProvider] } }),
    device('device-a')
  ]);
  const reordered = payload([
    device('device-a'),
    device('device-b', {
      limits: {
        updatedAt: T1,
        providers: [
          secondProvider,
          { ...firstProvider, windows: [...firstProvider.windows].reverse() }
        ]
      }
    })
  ], { updatedAt: T1 });

  const normalizedFirst = normalizeNotification(first);
  const normalizedReordered = normalizeNotification(reordered);
  assert.deepEqual(normalizedFirst.devices.map((entry) => entry.deviceId), ['device-a', 'device-b']);
  assert.deepEqual(normalizedReordered.devices.map((entry) => entry.deviceId), ['device-a', 'device-b']);
  assert.equal(normalizedFirst.devices[1].comparisonJson, normalizedReordered.devices[1].comparisonJson);
});

test('array multiplicity remains observable', () => {
  const one = normalizeNotification(payload([device('device-a', {
    limits: { updatedAt: T0, providers: [provider()] }
  })]));
  const duplicate = normalizeNotification(payload([device('device-a', {
    limits: { updatedAt: T0, providers: [provider(), provider()] }
  })]));

  assert.notEqual(one.devices[0].comparisonJson, duplicate.devices[0].comparisonJson);
});

test('device and provider data-side timestamps participate in comparison', () => {
  const initial = normalizeNotification(payload());
  const deviceAdvanced = normalizeNotification(payload([device('device-a', { updatedAt: T1 })]));
  const providerAdvanced = normalizeNotification(payload([device('device-a', {
    limits: { updatedAt: T0, providers: [provider('codex', { updatedAt: T1 })] }
  })]));
  const transportAdvanced = normalizeNotification({
    ...payload(),
    at: T1,
    stats: {
      ...payload().stats,
      updatedAt: T1,
      devices: [device('device-a', { receivedAt: T1, ageMs: 60_000, stale: true })]
    }
  });

  assert.notEqual(initial.devices[0].comparisonJson, deviceAdvanced.devices[0].comparisonJson);
  assert.notEqual(initial.devices[0].comparisonJson, providerAdvanced.devices[0].comparisonJson);
  assert.equal(initial.devices[0].comparisonJson, transportAdvanced.devices[0].comparisonJson);
  assert.equal(transportAdvanced.devices[0].metadata.receivedAt, T1);
  assert.equal(transportAdvanced.devices[0].metadata.stale, true);
});

test('ValidationError can represent a safe JSON syntax error message', () => {
  const error = new ValidationError('SSE 通知の JSON 書式が不正です');
  assert.equal(error.name, 'ValidationError');
  assert.equal(error.message, 'SSE 通知の JSON 書式が不正です');
});
