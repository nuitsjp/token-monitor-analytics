import assert from 'node:assert/strict';
import test from 'node:test';

import { advanceEstimation, interruptEstimation, windowKey } from '../src/estimation.js';

const HUB_ID = 'hub-boundaries';
const START = Date.parse('2026-09-13T00:00:00.000Z');
const RESET_OLD = '2026-09-20T00:00:00.000Z';
const RESET_NEW = '2026-09-27T00:00:00.000Z';

function at(minutes) {
  return new Date(START + minutes * 60_000).toISOString();
}

function limitWindow({
  usedPercent = 10,
  resetsAt = RESET_OLD,
  kind = 'weekly',
  limitId = 'codex',
  windowMinutes = 10_080,
  label = '',
  ...overrides
} = {}) {
  return {
    kind,
    limitId,
    windowMinutes,
    label,
    usedPercent,
    resetsAt,
    additional: false,
    showMeter: true,
    ...overrides,
  };
}

function provider({
  tool = 'codex',
  accountKey = 'account-a',
  accountLabel = 'Plus',
  planLabel = '',
  usedPercent = 10,
  updatedAt = at(0),
  resetsAt = RESET_OLD,
  windows,
  ...overrides
} = {}) {
  return {
    provider: tool,
    accountKey,
    accountLabel,
    planLabel,
    status: 'ok',
    source: tool === 'codex' ? 'oauth' : 'web',
    updatedAt,
    stale: false,
    windows: windows ?? [limitWindow({
      usedPercent,
      resetsAt,
      limitId: tool === 'codex' ? 'codex' : undefined,
    })],
    ...overrides,
  };
}

function device({
  hubId = HUB_ID,
  deviceId = 'device-a',
  present = true,
  gapReason,
  tool = 'codex',
  cost = 0,
  observedAt = at(0),
  providers,
  ...providerOptions
} = {}) {
  return {
    hubId,
    deviceId,
    observationId: `${deviceId}:${observedAt}`,
    present,
    ...(gapReason === undefined ? {} : { gapReason }),
    metadata: { stale: false },
    observation: {
      periods: { allTime: { clientCosts: { [tool]: cost } } },
      clientHealth: {
        observedAt,
        clients: {
          [tool]: {
            overall: 'healthy',
            source: { state: 'detected' },
            collection: { state: 'direct' },
          },
        },
      },
      limits: {
        providers: providers ?? [provider({ tool, updatedAt: observedAt, ...providerOptions })],
      },
    },
  };
}

function snapshot(minutes, devices, receivedAt = at(minutes)) {
  return { devices, receivedAt };
}

function activeGroup(output, tool = 'codex') {
  const matches = output.state.groups.filter((group) => group.view.active && group.view.tool === tool);
  assert.equal(matches.length, 1, `expected one active ${tool} group, got ${matches.length}`);
  return matches[0];
}

function advance(previous, minutes, devices, settings) {
  return advanceEstimation(previous?.state ?? previous, snapshot(minutes, devices), settings);
}

test('全サービスに共通計算を適用し、契約間で対応する枠が欠ける場合だけ停止する', () => {
  for (const current of [
    {
      tool: 'antigravity',
      providersAt: (usedPercent, updatedAt) => [
        provider({
          tool: 'antigravity', accountKey: 'antigravity-a', accountEmail: 'a@example.invalid',
          updatedAt, windows: [limitWindow({ limitId: null, label: 'Gemini pool', usedPercent })],
        }),
        provider({
          tool: 'antigravity', accountKey: 'antigravity-b', accountEmail: 'b@example.invalid',
          updatedAt, windows: [limitWindow({ limitId: null, label: 'Claude pool', usedPercent })],
        }),
      ],
    },
    {
      tool: 'claude',
      providersAt: (usedPercent, updatedAt) => [provider({
        tool: 'claude', accountName: 'Organization display name', updatedAt,
        windows: [limitWindow({ limitId: undefined, kind: 'weekly', usedPercent })],
      })],
    },
  ]) {
    const first = advance(null, 0, [device({
      tool: current.tool,
      providers: current.providersAt(10, at(0)),
    })]);
    const second = advance(first, 10, [device({
      tool: current.tool,
      cost: 10,
      observedAt: at(10),
      providers: current.providersAt(20, at(10)),
    })]);

    if (current.tool === 'antigravity') {
      const groups = second.state.groups.filter((group) => group.view.active && group.view.tool === current.tool);
      assert.equal(groups.length, 2);
      for (const group of groups) {
        assert.equal(group.view.status, 'unavailable');
        assert.equal(group.view.reason, 'missing_account_rate');
        assert.equal(group.view.lastResult, null);
      }
    } else {
      const group = activeGroup(second, current.tool);
      assert.equal(group.view.status, 'estimated');
      assert.equal(group.view.lastResult.baseCapacityUsd, 100);
    }
  }
});

test('Codexの現行wireではaccountLabelをplanとして同一プランを設定なしで推定する', () => {
  const firstProviders = [
    provider({ accountKey: 'account-a', accountLabel: 'Plus', usedPercent: 10 }),
    provider({ accountKey: 'account-b', accountLabel: 'Plus', usedPercent: 20 }),
  ];
  const secondProviders = [
    provider({ accountKey: 'account-a', accountLabel: 'Plus', usedPercent: 20, updatedAt: at(10) }),
    provider({ accountKey: 'account-b', accountLabel: 'Plus', usedPercent: 30, updatedAt: at(10) }),
  ];
  const first = advance(null, 0, [device({ providers: firstProviders })]);
  const second = advance(first, 10, [device({ cost: 20, observedAt: at(10), providers: secondProviders })]);
  const group = activeGroup(second);

  assert.equal(group.view.status, 'estimated');
  assert.equal(group.view.basePlan, 'Plus');
  assert.equal(group.view.lastResult.baseCapacityUsd, 100);
  assert.deepEqual(group.view.lastResult.accounts.map(({ plan, multiplier, capacityUsd }) => (
    { plan, multiplier, capacityUsd }
  )), [
    { plan: 'Plus', multiplier: 1, capacityUsd: 100 },
    { plan: 'Plus', multiplier: 1, capacityUsd: 100 },
  ]);
});

test('Codexの現行wireで異なるaccountLabel planを共有する場合だけ倍率を要求して適用する', () => {
  const initialProviders = [
    provider({ accountKey: 'account-a', accountLabel: 'Plus', usedPercent: 10 }),
    provider({ accountKey: 'account-b', accountLabel: 'Pro 5x', usedPercent: 10 }),
  ];
  const unavailable = advance(null, 0, [device({ providers: initialProviders })]);
  assert.equal(activeGroup(unavailable).view.status, 'settings-required');
  assert.equal(activeGroup(unavailable).view.reason, 'multipliers_required');

  const identity = windowKey(initialProviders[0].windows[0]);
  const settings = {
    error: null,
    planMultipliers: [{
      tool: 'codex',
      windowKey: identity,
      basePlan: 'Plus',
      plans: { Plus: 1, 'Pro 5x': 5 },
    }],
  };
  const first = advance(null, 0, [device({ providers: initialProviders })], settings);
  const nextProviders = [
    provider({ accountKey: 'account-a', accountLabel: 'Plus', usedPercent: 20, updatedAt: at(10) }),
    provider({ accountKey: 'account-b', accountLabel: 'Pro 5x', usedPercent: 20, updatedAt: at(10) }),
  ];
  const second = advance(first, 10, [device({ cost: 60, observedAt: at(10), providers: nextProviders })], settings);
  const group = activeGroup(second);

  assert.equal(group.view.status, 'estimated');
  assert.equal(group.view.lastResult.baseCapacityUsd, 100);
  assert.equal(group.view.lastResult.weightedPercent, 60);
  assert.deepEqual(group.view.lastResult.accounts.map(({ plan, multiplier, capacityUsd }) => (
    { plan, multiplier, capacityUsd }
  )), [
    { plan: 'Plus', multiplier: 1, capacityUsd: 100 },
    { plan: 'Pro 5x', multiplier: 5, capacityUsd: 500 },
  ]);
});

test('対応対象のcostだけが存在する場合も候補を残してmissing_accountを示す', () => {
  const first = advance(null, 0, [device({ cost: 10, providers: [] })]);
  const group = activeGroup(first);

  assert.equal(group.view.status, 'unavailable');
  assert.equal(group.view.reason, 'missing_account');
  assert.equal(group.view.lastResult, null);
});

test('AからBへの切替後にAが消えても推定を再開せず過去結果を保持する', () => {
  const first = advance(null, 0, [device({ accountKey: 'account-a', accountLabel: 'Plus' })]);
  const estimated = advance(first, 10, [device({
    accountKey: 'account-a', accountLabel: 'Plus', cost: 10, usedPercent: 20,
    observedAt: at(10), updatedAt: at(10),
  })]);
  const previousResult = structuredClone(activeGroup(estimated).view.lastResult);
  const switched = advance(estimated, 20, [device({
    accountKey: 'account-b', accountLabel: 'Plus', cost: 20, usedPercent: 10,
    observedAt: at(20), updatedAt: at(20),
  })]);
  const later = advance(switched, 30, [device({
    accountKey: 'account-b', accountLabel: 'Plus', cost: 30, usedPercent: 20,
    observedAt: at(30), updatedAt: at(30),
  })]);
  const group = activeGroup(later);

  assert.equal(group.view.status, 'unavailable');
  assert.equal(group.view.reason, 'missing_account_rate');
  assert.deepEqual(group.view.lastResult, previousResult);
  assert.equal(group.baseline, null);
});

test('消えた端末を除外し残存端末の新しい比較区間で再開して過去結果を保持する', () => {
  const twoDevices = (minutes, cost, usedPercent) => [
    device({ deviceId: 'device-a', cost, usedPercent, observedAt: at(minutes), updatedAt: at(minutes) }),
    device({ deviceId: 'device-b', cost, usedPercent, observedAt: at(minutes), updatedAt: at(minutes) }),
  ];
  const first = advance(null, 0, twoDevices(0, 0, 10));
  const estimated = advance(first, 10, twoDevices(10, 5, 20));
  const previousResult = structuredClone(activeGroup(estimated).view.lastResult);
  const missing = advance(estimated, 20, [device({
    deviceId: 'device-a', cost: 10, usedPercent: 30, observedAt: at(20), updatedAt: at(20),
  })]);
  const later = advance(missing, 30, [device({
    deviceId: 'device-a', cost: 15, usedPercent: 40, observedAt: at(30), updatedAt: at(30),
  })]);
  const group = activeGroup(later);

  assert.equal(group.view.status, 'estimated');
  assert.equal(group.view.lastResult.baseCapacityUsd, 50);
  assert.equal(group.view.lastResult.from, at(20));
  assert.equal(group.view.partial, true);
  assert.equal(group.view.excludedSources[0].reason, 'missing_device');
  assert.deepEqual(later.state.groups.find(entry => !entry.view.active && entry.view.lastResult).view.lastResult, previousResult);
});

test('同一instantの異なるISO表記を別時刻や別期間として扱わない', () => {
  const equivalent = '2026-09-13T01:00:00.000+01:00';
  const equivalentReset = '2026-09-20T09:00:00.000+09:00';
  const first = advanceEstimation(null, snapshot(0, [device()]));
  const replay = advanceEstimation(first.state, snapshot(1, [device({
    observedAt: equivalent,
    providers: [provider({ updatedAt: equivalent, resetsAt: equivalentReset })],
  })]));
  const replayGroup = activeGroup(replay);

  assert.equal(replayGroup.view.reason, 'no_increase');
  assert.equal(replayGroup.baseline.receivedAt, at(0));
  const next = advance(replay, 10, [device({
    cost: 10, usedPercent: 20, observedAt: at(10), updatedAt: at(10),
  })]);
  assert.equal(activeGroup(next).view.lastResult.from, at(0));
});

test('新reset期間の後に届いた旧期間観測を計算せず過去結果を保持する', () => {
  const first = advance(null, 0, [device()]);
  const estimated = advance(first, 10, [device({
    cost: 10, usedPercent: 20, observedAt: at(10), updatedAt: at(10),
  })]);
  const previousResult = structuredClone(activeGroup(estimated).view.lastResult);
  const newPeriod = advance(estimated, 20, [device({
    cost: 20, usedPercent: 5, observedAt: at(20), updatedAt: at(20), resetsAt: RESET_NEW,
  })]);
  const lateOldPeriod = advance(newPeriod, 30, [device({
    cost: 15, usedPercent: 25, observedAt: at(15), updatedAt: at(15), resetsAt: RESET_OLD,
  })]);
  const group = activeGroup(lateOldPeriod);

  assert.equal(group.view.status, 'unavailable');
  assert.equal(group.view.reason, 'out_of_order');
  assert.deepEqual(group.view.lastResult, previousResult);
  assert.equal(group.baseline, null);
});

test('gap後の旧値再配信をbaselineにせず新規観測2点だけで再開する', () => {
  const first = advance(null, 0, [device()]);
  const estimated = advance(first, 10, [device({
    cost: 10, usedPercent: 20, observedAt: at(10), updatedAt: at(10),
  })]);
  const previousResult = structuredClone(activeGroup(estimated).view.lastResult);
  const interrupted = interruptEstimation(estimated.state, { at: at(15), reason: 'disconnected' });
  const replay = advance(interrupted, 20, [device({
    cost: 10, usedPercent: 20, observedAt: at(10), updatedAt: at(10),
  })]);
  const replayGroup = activeGroup(replay);
  assert.equal(replayGroup.view.reason, 'awaiting_refresh');
  assert.equal(replayGroup.baseline, null);
  assert.deepEqual(replayGroup.view.lastResult, previousResult);

  const newBaseline = advance(replay, 30, [device({
    cost: 20, usedPercent: 30, observedAt: at(30), updatedAt: at(30),
  })]);
  assert.equal(activeGroup(newBaseline).view.status, 'collecting');
  assert.equal(activeGroup(newBaseline).baseline.receivedAt, at(30));
  const resumed = advance(newBaseline, 40, [device({
    cost: 30, usedPercent: 40, observedAt: at(40), updatedAt: at(40),
  })]);
  assert.equal(activeGroup(resumed).view.lastResult.from, at(30));
});

test('resetのlimitsOnly先行値をbaselineにせず実績再収集後から計算する', () => {
  const first = advance(null, 0, [device()]);
  const estimated = advance(first, 10, [device({
    cost: 10, usedPercent: 20, observedAt: at(10), updatedAt: at(10),
  })]);
  const limitsOnly = advance(estimated, 20, [device({
    cost: 10,
    usedPercent: 5,
    observedAt: at(10),
    updatedAt: at(20),
    resetsAt: RESET_NEW,
  })]);
  const pending = activeGroup(limitsOnly);
  assert.equal(pending.view.reason, 'awaiting_refresh');
  assert.equal(pending.baseline, null);

  const refreshedBaseline = advance(limitsOnly, 30, [device({
    cost: 20,
    usedPercent: 5,
    observedAt: at(30),
    updatedAt: at(20),
    resetsAt: RESET_NEW,
  })]);
  assert.equal(activeGroup(refreshedBaseline).view.status, 'collecting');
  assert.equal(activeGroup(refreshedBaseline).baseline.cost, 20);
  const next = advance(refreshedBaseline, 40, [device({
    cost: 30,
    usedPercent: 15,
    observedAt: at(40),
    updatedAt: at(40),
    resetsAt: RESET_NEW,
  })]);
  const result = activeGroup(next).view.lastResult;
  assert.equal(result.from, at(30));
  assert.equal(result.deltaCostUsd, 10);
  assert.equal(result.weightedPercent, 10);
  assert.equal(result.baseCapacityUsd, 100);
});

test('値が同じ完全再取得を挟んでも最初の起点を維持する', () => {
  const first = advance(null, 0, [device()]);
  const unchanged = advance(first, 10, [device({
    observedAt: at(10), updatedAt: at(10),
  })]);
  const estimated = advance(unchanged, 20, [device({
    cost: 20, usedPercent: 20, observedAt: at(20), updatedAt: at(20),
  })]);
  const result = activeGroup(estimated).view.lastResult;

  assert.equal(result.from, at(0));
  assert.equal(result.deltaCostUsd, 20);
  assert.equal(result.weightedPercent, 10);
  assert.equal(result.baseCapacityUsd, 200);
});

test('present falseはmissing_device、明示gapReasonはその理由で推定を停止する', () => {
  const first = advance(null, 0, [device()]);
  const estimated = advance(first, 10, [device({ cost: 10, usedPercent: 20, observedAt: at(10), updatedAt: at(10) })]);
  const previousResult = structuredClone(activeGroup(estimated).view.lastResult);
  const missing = advance(estimated, 20, [device({
    present: false,
    cost: 20,
    usedPercent: 30,
    observedAt: at(20),
    updatedAt: at(20),
  })]);
  assert.equal(activeGroup(missing).view.reason, 'missing_device');
  assert.equal(activeGroup(missing).view.lastResult, null);
  assert.deepEqual(missing.state.groups.find(entry => !entry.view.active && entry.view.lastResult).view.lastResult, previousResult);

  const gapped = advance(estimated, 20, [device({
    gapReason: 'disconnected',
    cost: 20,
    usedPercent: 30,
    observedAt: at(20),
    updatedAt: at(20),
  })]);
  assert.equal(activeGroup(gapped).view.reason, 'disconnected');
  assert.equal(activeGroup(gapped).view.lastResult, null);
  assert.deepEqual(gapped.state.groups.find(entry => !entry.view.active && entry.view.lastResult).view.lastResult, previousResult);
});
