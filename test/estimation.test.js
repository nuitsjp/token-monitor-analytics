import assert from 'node:assert/strict';
import test from 'node:test';

import { advanceEstimation, interruptEstimation, replayEstimation, seedEstimation } from '../src/estimation.js';
import { contractId } from '../src/identity.js';

const HUB_ID = 'hub-a';
const RESET_ONE = '2026-09-14T00:00:00.000Z';
const RESET_TWO = '2026-09-15T00:00:00.000Z';
const WINDOW_KEY = JSON.stringify(['weekly', 10080, 'codex', false, null]);

function timeAt(minutes) {
  return new Date(Date.parse('2026-09-13T00:00:00.000Z') + minutes * 60_000).toISOString();
}

function makeWindow({ usedPercent, resetsAt = RESET_ONE, ...overrides }) {
  return {
    kind: 'weekly',
    limitId: 'codex',
    windowMinutes: 10080,
    usedPercent,
    resetsAt,
    additional: false,
    showMeter: true,
    ...overrides
  };
}

function makeProvider({
  accountKey = 'account-a',
  planLabel = 'Plus',
  usedPercent,
  updatedAt,
  resetsAt = RESET_ONE,
  windows,
  ...overrides
}) {
  return {
    provider: 'codex',
    accountKey,
    accountLabel: accountKey,
    planLabel,
    status: 'ok',
    updatedAt,
    stale: false,
    windows: windows ?? [makeWindow({ usedPercent, resetsAt })],
    ...overrides
  };
}

function makeDevice({
  hubId = HUB_ID,
  deviceId = 'device-a',
  observationId = `${deviceId}-observation`,
  cost = 0,
  usedPercent = 10,
  observedAt = timeAt(0),
  providerUpdatedAt = observedAt,
  resetsAt = RESET_ONE,
  providers,
  ...providerOptions
}) {
  return {
    hubId,
    deviceId,
    observationId,
    present: true,
    observation: {
      periods: { allTime: { clientCosts: { codex: cost } } },
      clientHealth: {
        observedAt,
        clients: {
          codex: {
            overall: 'healthy',
            source: { state: 'detected' },
            collection: { state: 'direct' }
          }
        }
      },
      limits: {
        providers: providers ?? [makeProvider({
          usedPercent,
          updatedAt: providerUpdatedAt,
          resetsAt,
          ...providerOptions
        })]
      }
    },
    metadata: { stale: false }
  };
}

function snapshot(minutes, devices) {
  return { devices, receivedAt: timeAt(minutes) };
}

function groupFor(output, predicate = () => true) {
  const groups = output.state.groups.filter((group) => group.view?.tool === 'codex' && predicate(group));
  assert.equal(groups.length, 1, `expected one matching group, got ${groups.length}`);
  return groups[0];
}

function activeGroups(output) {
  return output.state.groups.filter((group) => group.view?.tool === 'codex' && group.view.active);
}

function resultFor(group) {
  return group.view.lastResult;
}

function assertResult(group, {
  from,
  to,
  baseCapacityUsd,
  deltaCostUsd,
  weightedPercent,
  accounts
}) {
  const result = resultFor(group);
  assert.equal(group.view.status, 'estimated');
  assert.equal(group.view.reason, null);
  assert.equal(result.from, from);
  assert.equal(result.to, to);
  assert.equal(result.calculatedAt, to);
  assert.equal(result.baseCapacityUsd, baseCapacityUsd);
  assert.equal(result.deltaCostUsd, deltaCostUsd);
  assert.equal(result.weightedPercent, weightedPercent);
  assert.deepEqual(result.accounts.map((account) => ({
    key: account.key.length === 64 ? account.key : contractId('codex', account.key, HUB_ID),
    plan: account.plan,
    multiplier: account.multiplier,
    deltaPercent: account.deltaPercent,
    capacityUsd: account.capacityUsd
  })), accounts.map((account) => ({
    ...account,
    key: account.key.length === 64 ? account.key : contractId('codex', account.key, HUB_ID),
  })));
}

function baseDevice(options = {}) {
  return makeDevice({
    cost: 0,
    usedPercent: 10,
    observedAt: timeAt(0),
    ...options
  });
}

test('単一契約は設定なしでΔC10・Δp10から100 USDを算出する', () => {
  const first = advanceEstimation(null, snapshot(0, [baseDevice()]));
  const second = advanceEstimation(first.state, snapshot(10, [makeDevice({
    cost: 10,
    usedPercent: 20,
    observedAt: timeAt(10)
  })]));

  const group = groupFor(second);
  assertResult(group, {
    from: timeAt(0),
    to: timeAt(10),
    baseCapacityUsd: 100,
    deltaCostUsd: 10,
    weightedPercent: 10,
    accounts: [{ key: 'account-a', plan: 'Plus', multiplier: 1, deltaPercent: 10, capacityUsd: 100 }]
  });
});

test('同一プラン2アカウントの共有利用額は設定なしで共通100 USDを算出する', () => {
  const firstProviders = [
    makeProvider({ accountKey: 'account-a', planLabel: 'Plus', usedPercent: 10, updatedAt: timeAt(0) }),
    makeProvider({ accountKey: 'account-b', planLabel: 'Plus', usedPercent: 20, updatedAt: timeAt(0) })
  ];
  const secondProviders = [
    makeProvider({ accountKey: 'account-a', planLabel: 'Plus', usedPercent: 20, updatedAt: timeAt(10) }),
    makeProvider({ accountKey: 'account-b', planLabel: 'Plus', usedPercent: 30, updatedAt: timeAt(10) })
  ];
  const first = advanceEstimation(null, snapshot(0, [baseDevice({ providers: firstProviders })]));
  const second = advanceEstimation(first.state, snapshot(10, [makeDevice({
    cost: 20,
    observedAt: timeAt(10),
    providers: secondProviders
  })]));

  const group = groupFor(second);
  assert.equal(group.view.basePlan, 'Plus');
  assertResult(group, {
    from: timeAt(0),
    to: timeAt(10),
    baseCapacityUsd: 100,
    deltaCostUsd: 20,
    weightedPercent: 20,
    accounts: [
      { key: 'account-a', plan: 'Plus', multiplier: 1, deltaPercent: 10, capacityUsd: 100 },
      { key: 'account-b', plan: 'Plus', multiplier: 1, deltaPercent: 10, capacityUsd: 100 }
    ]
  });
});

test('異なるプランの共有利用額は設定倍率1と5から基準100・別プラン500 USDを算出する', () => {
  const settings = {
    planMultipliers: [{
      tool: 'codex',
      windowKey: WINDOW_KEY,
      basePlan: 'Plus',
      plans: { Plus: 1, Pro: 5 }
    }]
  };
  const first = advanceEstimation(null, snapshot(0, [makeDevice({
    providers: [
      makeProvider({ accountKey: 'account-a', planLabel: 'Plus', usedPercent: 10, updatedAt: timeAt(0) }),
      makeProvider({ accountKey: 'account-b', planLabel: 'Pro', usedPercent: 20, updatedAt: timeAt(0) })
    ]
  })]), settings);
  const second = advanceEstimation(first.state, snapshot(10, [makeDevice({
    cost: 60,
    observedAt: timeAt(10),
    providers: [
      makeProvider({ accountKey: 'account-a', planLabel: 'Plus', usedPercent: 20, updatedAt: timeAt(10) }),
      makeProvider({ accountKey: 'account-b', planLabel: 'Pro', usedPercent: 30, updatedAt: timeAt(10) })
    ]
  })]), settings);

  const group = groupFor(second);
  assert.equal(group.view.basePlan, 'Plus');
  assertResult(group, {
    from: timeAt(0),
    to: timeAt(10),
    baseCapacityUsd: 100,
    deltaCostUsd: 60,
    weightedPercent: 60,
    accounts: [
      { key: 'account-a', plan: 'Plus', multiplier: 1, deltaPercent: 10, capacityUsd: 100 },
      { key: 'account-b', plan: 'Pro', multiplier: 5, deltaPercent: 10, capacityUsd: 500 }
    ]
  });
});

test('異なるプランの共有利用額は倍率がないとsettings-requiredになる', () => {
  const first = advanceEstimation(null, snapshot(0, [makeDevice({
    providers: [
      makeProvider({ accountKey: 'account-a', planLabel: 'Plus', usedPercent: 10, updatedAt: timeAt(0) }),
      makeProvider({ accountKey: 'account-b', planLabel: 'Pro', usedPercent: 20, updatedAt: timeAt(0) })
    ]
  })]));
  const second = advanceEstimation(first.state, snapshot(10, [makeDevice({
    cost: 60,
    observedAt: timeAt(10),
    providers: [
      makeProvider({ accountKey: 'account-a', planLabel: 'Plus', usedPercent: 20, updatedAt: timeAt(10) }),
      makeProvider({ accountKey: 'account-b', planLabel: 'Pro', usedPercent: 30, updatedAt: timeAt(10) })
    ]
  })]));

  const group = groupFor(second);
  assert.equal(group.view.status, 'settings-required');
  assert.equal(group.view.reason, 'multipliers_required');
  assert.equal(group.view.lastResult, null);
});

test('別端末の別契約はプランが異なっても設定なしで個別に算出する', () => {
  const first = advanceEstimation(null, snapshot(0, [
    baseDevice({ deviceId: 'device-a', providers: [makeProvider({ accountKey: 'account-a', planLabel: 'Plus', usedPercent: 10, updatedAt: timeAt(0) })] }),
    baseDevice({ deviceId: 'device-b', providers: [makeProvider({ accountKey: 'account-b', planLabel: 'Pro', usedPercent: 20, updatedAt: timeAt(0) })] })
  ]));
  const second = advanceEstimation(first.state, snapshot(10, [
    makeDevice({ deviceId: 'device-a', cost: 10, usedPercent: 20, observedAt: timeAt(10), providers: [makeProvider({ accountKey: 'account-a', planLabel: 'Plus', usedPercent: 20, updatedAt: timeAt(10) })] }),
    makeDevice({ deviceId: 'device-b', cost: 10, usedPercent: 30, observedAt: timeAt(10), providers: [makeProvider({ accountKey: 'account-b', planLabel: 'Pro', usedPercent: 30, updatedAt: timeAt(10) })] })
  ]));

  const groups = activeGroups(second);
  assert.equal(groups.length, 2);
  for (const group of groups) {
    assertResult(group, {
      from: timeAt(0),
      to: timeAt(10),
      baseCapacityUsd: 100,
      deltaCostUsd: 10,
      weightedPercent: 10,
      accounts: [{
        key: group.view.accounts[0].key,
        plan: group.view.accounts[0].plan,
        multiplier: 1,
        deltaPercent: 10,
        capacityUsd: 100
      }]
    });
  }
});

test('同一accountを複数端末が報告してもcostだけ合算しrateは一度だけ数える', () => {
  const first = advanceEstimation(null, snapshot(0, [
    baseDevice({ deviceId: 'device-a', cost: 0, providers: [makeProvider({ usedPercent: 10, updatedAt: timeAt(0) })] }),
    baseDevice({ deviceId: 'device-b', cost: 0, providers: [makeProvider({ usedPercent: 10, updatedAt: timeAt(0) })] })
  ]));
  const second = advanceEstimation(first.state, snapshot(10, [
    makeDevice({ deviceId: 'device-a', cost: 5, usedPercent: 20, observedAt: timeAt(10), providers: [makeProvider({ usedPercent: 20, updatedAt: timeAt(10) })] }),
    makeDevice({ deviceId: 'device-b', cost: 5, usedPercent: 20, observedAt: timeAt(10), providers: [makeProvider({ usedPercent: 20, updatedAt: timeAt(10) })] })
  ]));

  const group = groupFor(second);
  assertResult(group, {
    from: timeAt(0),
    to: timeAt(10),
    baseCapacityUsd: 100,
    deltaCostUsd: 10,
    weightedPercent: 10,
    accounts: [{ key: 'account-a', plan: 'Plus', multiplier: 1, deltaPercent: 10, capacityUsd: 100 }]
  });
});

test('利用枠だけ更新されcostHealthの時刻が据え置きなら新しい推定を作らない', () => {
  const first = advanceEstimation(null, snapshot(0, [baseDevice()]));
  const limitOnly = advanceEstimation(first.state, snapshot(10, [makeDevice({
    cost: 0,
    usedPercent: 20,
    observedAt: timeAt(0),
    providerUpdatedAt: timeAt(10)
  })]));

  const group = groupFor(limitOnly);
  assert.equal(group.view.status, 'collecting');
  assert.equal(group.view.reason, 'awaiting_refresh');
  assert.equal(group.view.lastResult, null);
  assert.equal(limitOnly.events.length, 1);
});

test('全データが進んでも最初の観測を起点として区間を延伸する', () => {
  const first = advanceEstimation(null, snapshot(0, [baseDevice({ cost: 0, usedPercent: 10 })]));
  const second = advanceEstimation(first.state, snapshot(10, [makeDevice({ cost: 5, usedPercent: 15, observedAt: timeAt(10) })]));
  const third = advanceEstimation(second.state, snapshot(20, [makeDevice({ cost: 10, usedPercent: 20, observedAt: timeAt(20) })]));

  const group = groupFor(third);
  assertResult(group, {
    from: timeAt(0),
    to: timeAt(20),
    baseCapacityUsd: 100,
    deltaCostUsd: 10,
    weightedPercent: 10,
    accounts: [{ key: 'account-a', plan: 'Plus', multiplier: 1, deltaPercent: 10, capacityUsd: 100 }]
  });
});

test('同一データの再配信では新しい推定イベントを追記しない', () => {
  const first = advanceEstimation(null, snapshot(0, [baseDevice()]));
  const estimated = advanceEstimation(first.state, snapshot(10, [makeDevice({ cost: 10, usedPercent: 20, observedAt: timeAt(10) })]));
  const previousResult = resultFor(groupFor(estimated));
  const duplicate = advanceEstimation(estimated.state, snapshot(20, [makeDevice({ cost: 10, usedPercent: 20, observedAt: timeAt(10) })]));

  const group = groupFor(duplicate);
  assert.equal(duplicate.events.length, 0);
  assert.deepEqual(resultFor(group), previousResult);
});

test('reset予定日時の更新は過去resultを保持し新期間をまたいで計算しない', () => {
  const first = advanceEstimation(null, snapshot(0, [baseDevice({ resetsAt: RESET_ONE })]));
  const estimated = advanceEstimation(first.state, snapshot(10, [makeDevice({ cost: 10, usedPercent: 20, observedAt: timeAt(10), resetsAt: RESET_ONE })]));
  const previousResult = resultFor(groupFor(estimated));
  const afterReset = advanceEstimation(estimated.state, snapshot(20, [makeDevice({ cost: 20, usedPercent: 30, observedAt: timeAt(20), resetsAt: RESET_TWO })]));

  const resetGroup = groupFor(afterReset);
  assert.deepEqual(resultFor(resetGroup), previousResult);
  assert.equal(resetGroup.view.status, 'collecting');
  assert.equal(resetGroup.view.reason, 'collecting');

  const resumed = advanceEstimation(afterReset.state, snapshot(30, [makeDevice({ cost: 30, usedPercent: 40, observedAt: timeAt(30), resetsAt: RESET_TWO })]));
  const resumedGroup = groupFor(resumed);
  assertResult(resumedGroup, {
    from: timeAt(20),
    to: timeAt(30),
    baseCapacityUsd: 100,
    deltaCostUsd: 10,
    weightedPercent: 10,
    accounts: [{ key: 'account-a', plan: 'Plus', multiplier: 1, deltaPercent: 10, capacityUsd: 100 }]
  });
});

test('同一期間で消費率が減少したら過去resultを保持し不明区間をまたがない', () => {
  const first = advanceEstimation(null, snapshot(0, [baseDevice()]));
  const estimated = advanceEstimation(first.state, snapshot(10, [makeDevice({ cost: 10, usedPercent: 20, observedAt: timeAt(10) })]));
  const previousResult = resultFor(groupFor(estimated));
  const decreased = advanceEstimation(estimated.state, snapshot(20, [makeDevice({ cost: 20, usedPercent: 15, observedAt: timeAt(20) })]));

  const decreasedGroup = groupFor(decreased);
  assert.deepEqual(resultFor(decreasedGroup), previousResult);
  assert.equal(decreasedGroup.view.reason, 'percentage_decreased');

  const restart = advanceEstimation(decreased.state, snapshot(30, [makeDevice({ cost: 21, usedPercent: 16, observedAt: timeAt(30) })]));
  assert.equal(resultFor(groupFor(restart)), previousResult);
  const resumed = advanceEstimation(restart.state, snapshot(40, [makeDevice({ cost: 31, usedPercent: 26, observedAt: timeAt(40) })]));
  assert.equal(resultFor(groupFor(resumed)).from, timeAt(30));
});

test('古いデータの再受信は過去resultを保持し古い区間をまたがない', () => {
  const first = advanceEstimation(null, snapshot(0, [baseDevice()]));
  const estimated = advanceEstimation(first.state, snapshot(10, [makeDevice({ cost: 10, usedPercent: 20, observedAt: timeAt(10) })]));
  const previousResult = resultFor(groupFor(estimated));
  const old = advanceEstimation(estimated.state, snapshot(20, [makeDevice({
    cost: 20,
    usedPercent: 30,
    observedAt: timeAt(5),
    providerUpdatedAt: timeAt(5)
  })]));

  const oldGroup = groupFor(old);
  assert.deepEqual(resultFor(oldGroup), previousResult);
  assert.equal(oldGroup.view.reason, 'out_of_order');

  const restart = advanceEstimation(old.state, snapshot(30, [makeDevice({ cost: 30, usedPercent: 40, observedAt: timeAt(30) })]));
  assert.equal(resultFor(groupFor(restart)), previousResult);
  const resumed = advanceEstimation(restart.state, snapshot(40, [makeDevice({ cost: 40, usedPercent: 50, observedAt: timeAt(40) })]));
  assert.equal(resultFor(groupFor(resumed)).from, timeAt(30));
});

test('利用枠取得失敗は過去resultを保持し回復後に新しい起点から再開する', () => {
  const first = advanceEstimation(null, snapshot(0, [baseDevice()]));
  const estimated = advanceEstimation(first.state, snapshot(10, [makeDevice({ cost: 10, usedPercent: 20, observedAt: timeAt(10) })]));
  const previousResult = resultFor(groupFor(estimated));
  const unavailable = advanceEstimation(estimated.state, snapshot(20, [makeDevice({
    cost: 20,
    usedPercent: 30,
    observedAt: timeAt(20),
    status: 'unauthorized'
  })]));

  const unavailableGroup = groupFor(unavailable);
  assert.deepEqual(resultFor(unavailableGroup), previousResult);
  assert.equal(unavailableGroup.view.reason, 'limits_unavailable');

  const restart = advanceEstimation(unavailable.state, snapshot(30, [makeDevice({ cost: 30, usedPercent: 40, observedAt: timeAt(30) })]));
  assert.equal(resultFor(groupFor(restart)), previousResult);
  const resumed = advanceEstimation(restart.state, snapshot(40, [makeDevice({ cost: 40, usedPercent: 50, observedAt: timeAt(40) })]));
  assert.equal(resultFor(groupFor(resumed)).from, timeAt(30));
});

test('プラン切替は過去resultを保持し切替前の観測をまたがない', () => {
  const settings = { planMultipliers: [{ tool: 'codex', windowKey: WINDOW_KEY, basePlan: 'Plus', plans: { Plus: 1, Pro: 5 } }] };
  const first = advanceEstimation(null, snapshot(0, [baseDevice({ planLabel: 'Plus' })]), settings);
  const estimated = advanceEstimation(first.state, snapshot(10, [makeDevice({ cost: 10, usedPercent: 20, observedAt: timeAt(10), planLabel: 'Plus' })]), settings);
  const previousResult = resultFor(groupFor(estimated));
  const switched = advanceEstimation(estimated.state, snapshot(20, [makeDevice({ cost: 20, usedPercent: 30, observedAt: timeAt(20), planLabel: 'Pro' })]), settings);

  const switchedGroup = groupFor(switched);
  assert.deepEqual(resultFor(switchedGroup), previousResult);
  assert.equal(switchedGroup.view.status, 'collecting');
  assert.equal(switchedGroup.view.reason, 'collecting');

  const restart = advanceEstimation(switched.state, snapshot(30, [makeDevice({ cost: 30, usedPercent: 40, observedAt: timeAt(30), planLabel: 'Pro' })]), settings);
  assert.notDeepEqual(resultFor(groupFor(restart)), previousResult);
  assert.equal(resultFor(groupFor(restart)).from, timeAt(20));
  const resumed = advanceEstimation(restart.state, snapshot(40, [makeDevice({ cost: 40, usedPercent: 50, observedAt: timeAt(40), planLabel: 'Pro' })]), settings);
  assert.equal(resultFor(groupFor(resumed)).from, timeAt(20));
});

test('端末構成変更は旧resultを保持し新しい構成を再基準化する', () => {
  const first = advanceEstimation(null, snapshot(0, [baseDevice({ deviceId: 'device-a' })]));
  const estimated = advanceEstimation(first.state, snapshot(10, [makeDevice({ deviceId: 'device-a', cost: 10, usedPercent: 20, observedAt: timeAt(10) })]));
  const previousResult = resultFor(groupFor(estimated));
  const changed = advanceEstimation(estimated.state, snapshot(20, [
    makeDevice({ deviceId: 'device-a', cost: 20, usedPercent: 30, observedAt: timeAt(20) }),
    makeDevice({ deviceId: 'device-b', cost: 0, usedPercent: 30, observedAt: timeAt(20) })
  ]));

  const oldGroup = groupFor(changed, (group) => group.view.active === false);
  assert.deepEqual(resultFor(oldGroup), previousResult);
  const newGroups = activeGroups(changed);
  assert.equal(newGroups.length, 1);
  assert.equal(resultFor(newGroups[0]), null);

  const resumed = advanceEstimation(changed.state, snapshot(30, [
    makeDevice({ deviceId: 'device-a', cost: 30, usedPercent: 40, observedAt: timeAt(30) }),
    makeDevice({ deviceId: 'device-b', cost: 10, usedPercent: 40, observedAt: timeAt(30) })
  ]));
  const resumedGroup = activeGroups(resumed)[0];
  assert.equal(resultFor(resumedGroup).from, timeAt(20));
});

test('同一accountの同時刻で異なるrateを報告した場合はconflicting_rateになる', () => {
  const first = advanceEstimation(null, snapshot(0, [
    makeDevice({ deviceId: 'device-a', usedPercent: 10, providers: [makeProvider({ usedPercent: 10, updatedAt: timeAt(0) })] }),
    makeDevice({ deviceId: 'device-b', usedPercent: 10, providers: [makeProvider({ usedPercent: 10, updatedAt: timeAt(0) })] })
  ]));
  const conflicting = advanceEstimation(first.state, snapshot(10, [
    makeDevice({ deviceId: 'device-a', cost: 5, usedPercent: 20, observedAt: timeAt(10), providers: [makeProvider({ usedPercent: 20, updatedAt: timeAt(10) })] }),
    makeDevice({ deviceId: 'device-b', cost: 5, usedPercent: 30, observedAt: timeAt(10), providers: [makeProvider({ usedPercent: 30, updatedAt: timeAt(10) })] })
  ]));

  const group = groupFor(conflicting);
  assert.equal(group.view.reason, 'conflicting_rate');
  assert.equal(group.view.lastResult, null);
});

test('利用額だけ減少しても最初の起点を再設定しない', () => {
  const first = advanceEstimation(null, snapshot(0, [baseDevice({ cost: 10, usedPercent: 10 })]));
  const estimated = advanceEstimation(first.state, snapshot(10, [makeDevice({ cost: 20, usedPercent: 20, observedAt: timeAt(10) })]));
  const decreasedCost = advanceEstimation(estimated.state, snapshot(20, [makeDevice({ cost: 15, usedPercent: 30, observedAt: timeAt(20) })]));

  const group = groupFor(decreasedCost);
  assertResult(group, {
    from: timeAt(0),
    to: timeAt(20),
    baseCapacityUsd: 25,
    deltaCostUsd: 5,
    weightedPercent: 20,
    accounts: [{ key: 'account-a', plan: 'Plus', multiplier: 1, deltaPercent: 20, capacityUsd: 25 }]
  });
});

test('失効型・credits枠・識別情報が重なる並列枠は推定不可にする', () => {
  const cases = [
    { name: 'expiry', windowOverrides: { boundaryKind: 'expiry' }, reason: 'unsupported_window' },
    { name: 'credits', windowOverrides: { metric: 'credits' }, reason: 'unsupported_window' },
    {
      name: 'ambiguous',
      windows: [
        makeWindow({ usedPercent: 10, label: 'first' }),
        makeWindow({ usedPercent: 10, label: 'second' })
      ],
      reason: 'ambiguous_window'
    }
  ];

  for (const current of cases) {
    const initialWindows = current.windows ?? [makeWindow({ usedPercent: 10, ...current.windowOverrides })];
    const initialOptions = { providers: [makeProvider({ windows: initialWindows, updatedAt: timeAt(0) })] };
    const first = advanceEstimation(null, snapshot(0, [baseDevice(initialOptions)]));
    const nextOptions = {
      providers: [makeProvider({
        windows: initialWindows.map((window) => ({ ...window, usedPercent: 20 })),
        updatedAt: timeAt(10)
      })]
    };
    const second = advanceEstimation(first.state, snapshot(10, [makeDevice({
      cost: 10,
      usedPercent: 20,
      observedAt: timeAt(10),
      ...nextOptions
    })]));
    const group = groupFor(second);
    assert.equal(group.view.reason, current.reason, current.name);
    assert.equal(group.view.lastResult, null, current.name);
  }
});

test('interrupt後のsnapshotは再基準後にのみ計算する', () => {
  const first = advanceEstimation(null, snapshot(0, [baseDevice()]));
  const estimated = advanceEstimation(first.state, snapshot(10, [makeDevice({ cost: 10, usedPercent: 20, observedAt: timeAt(10) })]));
  const previousResult = resultFor(groupFor(estimated));
  const interrupted = interruptEstimation(estimated.state, { at: timeAt(15), reason: 'disconnected' });

  const interruptedGroup = groupFor(interrupted);
  assert.deepEqual(resultFor(interruptedGroup), previousResult);
  assert.equal(interruptedGroup.view.reason, 'disconnected');
  assert.equal(interruptedGroup.baseline, null);

  const firstAfter = advanceEstimation(interrupted.state, snapshot(20, [makeDevice({ cost: 20, usedPercent: 30, observedAt: timeAt(20) })]));
  assert.deepEqual(resultFor(groupFor(firstAfter)), previousResult);
  const secondAfter = advanceEstimation(firstAfter.state, snapshot(30, [makeDevice({ cost: 30, usedPercent: 40, observedAt: timeAt(30) })]));
  assert.equal(resultFor(groupFor(secondAfter)).from, timeAt(20));
});

test('advanceEstimationとinterruptEstimationは入力previousを破壊変更しない', () => {
  const first = advanceEstimation(null, snapshot(0, [baseDevice()]));
  const estimated = advanceEstimation(first.state, snapshot(10, [makeDevice({ cost: 10, usedPercent: 20, observedAt: timeAt(10) })]));
  const beforeAdvance = structuredClone(estimated.state);
  const beforeInterrupt = structuredClone(estimated.state);

  advanceEstimation(estimated.state, snapshot(20, [makeDevice({ cost: 20, usedPercent: 30, observedAt: timeAt(20) })]));
  assert.deepEqual(estimated.state, beforeAdvance);

  interruptEstimation(estimated.state, { at: timeAt(20), reason: 'disconnected' });
  assert.deepEqual(estimated.state, beforeInterrupt);
});

test('受信入力を順番通り再生し欠測状態とイベント履歴を維持する', () => {
  const frames = [snapshot(0, [baseDevice()]), snapshot(10, [makeDevice({ cost: 10, usedPercent: 20, observedAt: timeAt(10) })]),
    snapshot(20, [{ ...makeDevice({ cost: 20, usedPercent: 30, observedAt: timeAt(20) }), present: false }])];
  let expected = null;
  const observations = new Map();
  const inputs = frames.map((frame, index) => {
    return { kind: 'notification', ...frame, settings: {}, devices: frame.devices.map(({ observation, ...device }) => {
      observations.set(index, observation);
      return { ...device, observationId: index };
    }) };
  });
  // Use the same persisted observation IDs for the online comparison.
  expected = null;
  for (const input of inputs) expected = advanceEstimation(expected, { ...input,
    devices: input.devices.map((device) => ({ ...device, observation: observations.get(device.observationId) })) }).state;
  const rebuilt = replayEstimation({ inputs: inputs.values(), readObservation: (id) => observations.get(id) });
  assert.deepEqual(rebuilt.state, expected);
  assert.deepEqual(rebuilt.events, []);
});

test('同一Codex契約を異なるHubが報告すると利用額を合算して150 USDを算出する', () => {
  const first = advanceEstimation(null, {
    receivedAt: timeAt(0),
    devices: [
      baseDevice({ hubId: 'hub-a', deviceId: 'same-device', observationId: 'a0' }),
      baseDevice({ hubId: 'hub-b', deviceId: 'same-device', observationId: 'b0' }),
    ],
  });
  const second = advanceEstimation(first.state, {
    receivedAt: timeAt(10),
    devices: [
      makeDevice({ hubId: 'hub-a', deviceId: 'same-device', observationId: 'a1', cost: 10, usedPercent: 20, observedAt: timeAt(10) }),
      makeDevice({ hubId: 'hub-b', deviceId: 'same-device', observationId: 'b1', cost: 5, usedPercent: 20, observedAt: timeAt(10) }),
    ],
  });
  const group = groupFor(second);

  assertResult(group, {
    from: timeAt(0),
    to: timeAt(10),
    baseCapacityUsd: 150,
    deltaCostUsd: 15,
    weightedPercent: 10,
    accounts: [{ key: 'account-a', plan: 'Plus', multiplier: 1, deltaPercent: 10, capacityUsd: 150 }],
  });
  assert.deepEqual(group.view.sources, [
    { hubId: 'hub-a', deviceId: 'same-device' },
    { hubId: 'hub-b', deviceId: 'same-device' },
  ]);
  assert.deepEqual(group.view.hubIds, ['hub-a', 'hub-b']);
  assert.equal(group.view.accounts[0].key, contractId('codex', 'account-a', 'hub-a'));
  assert.deepEqual(group.view.lastResult.evidence.latest.costs.map(({ hubId, deviceId, observationId }) => ({
    hubId, deviceId, observationId,
  })), [
    { hubId: 'hub-a', deviceId: 'same-device', observationId: 'a1' },
    { hubId: 'hub-b', deviceId: 'same-device', observationId: 'b1' },
  ]);
});

test('同名deviceIdでもHubが異なるソースは別系列として識別する', () => {
  const first = advanceEstimation(null, {
    receivedAt: timeAt(0),
    devices: [
      baseDevice({ hubId: 'hub-a', deviceId: 'same-device', providers: [makeProvider({ accountKey: 'account-a', usedPercent: 10, updatedAt: timeAt(0) })] }),
      baseDevice({ hubId: 'hub-b', deviceId: 'same-device', providers: [makeProvider({ accountKey: 'account-b', usedPercent: 10, updatedAt: timeAt(0) })] }),
    ],
  });
  const second = advanceEstimation(first.state, {
    receivedAt: timeAt(10),
    devices: [
      makeDevice({ hubId: 'hub-a', deviceId: 'same-device', cost: 10, usedPercent: 20, observedAt: timeAt(10), providers: [makeProvider({ accountKey: 'account-a', usedPercent: 20, updatedAt: timeAt(10) })] }),
      makeDevice({ hubId: 'hub-b', deviceId: 'same-device', cost: 10, usedPercent: 20, observedAt: timeAt(10), providers: [makeProvider({ accountKey: 'account-b', usedPercent: 20, updatedAt: timeAt(10) })] }),
    ],
  });
  const groups = activeGroups(second);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.view.sources), [
    [{ hubId: 'hub-a', deviceId: 'same-device' }],
    [{ hubId: 'hub-b', deviceId: 'same-device' }],
  ]);
  assert.notEqual(groups[0].id, groups[1].id);
});

test('同じプラン名でも異なるaccountKeyは別契約として率を一度ずつ持つ', () => {
  const providersAt = (usedPercent, updatedAt) => [
    makeProvider({ accountKey: 'account-a', planLabel: 'Plus', usedPercent, updatedAt }),
    makeProvider({ accountKey: 'account-b', planLabel: 'Plus', usedPercent, updatedAt }),
  ];
  const first = advanceEstimation(null, {
    receivedAt: timeAt(0),
    devices: [baseDevice({ providers: providersAt(10, timeAt(0)) })],
  });
  const second = advanceEstimation(first.state, {
    receivedAt: timeAt(10),
    devices: [makeDevice({ cost: 20, usedPercent: 20, observedAt: timeAt(10), providers: providersAt(20, timeAt(10)) })],
  });
  const group = groupFor(second);

  assert.deepEqual(group.view.accounts.map(({ key, plan }) => ({ key, plan })), [
    { key: contractId('codex', 'account-a', HUB_ID), plan: 'Plus' },
    { key: contractId('codex', 'account-b', HUB_ID), plan: 'Plus' },
  ]);
  assert.equal(group.view.lastResult.evidence.latest.costs.length, 1);
  assert.equal(group.view.lastResult.evidence.latest.cost, 20);
});

test('異なるHubの一方だけ更新した通知では共有系列を算出しない', () => {
  const first = advanceEstimation(null, {
    receivedAt: timeAt(0),
    devices: [
      baseDevice({ hubId: 'hub-a', deviceId: 'same-device' }),
      baseDevice({ hubId: 'hub-b', deviceId: 'same-device' }),
    ],
  });
  const partial = advanceEstimation(first.state, {
    receivedAt: timeAt(10),
    devices: [
      makeDevice({ hubId: 'hub-a', deviceId: 'same-device', cost: 10, usedPercent: 20, observedAt: timeAt(10) }),
      baseDevice({ hubId: 'hub-b', deviceId: 'same-device' }),
    ],
  });
  const group = groupFor(partial);

  assert.equal(group.view.lastResult, null);
  assert.equal(group.view.status, 'collecting');
  assert.equal(group.view.reason, 'awaiting_refresh');
});

test('Hub指定のgapは共有系列だけを中断し無関係なHub系列を維持する', () => {
  const atHub = (minutes, hubId, accountKey, cost, usedPercent) => makeDevice({
    hubId,
    deviceId: `device-${hubId}`,
    observationId: `${hubId}-${minutes}`,
    cost,
    usedPercent,
    observedAt: timeAt(minutes),
    providers: [makeProvider({ accountKey, usedPercent, updatedAt: timeAt(minutes) })],
  });
  const first = advanceEstimation(null, {
    receivedAt: timeAt(0),
    devices: [atHub(0, 'hub-a', 'account-a', 0, 10), atHub(0, 'hub-b', 'account-a', 0, 10), atHub(0, 'hub-c', 'account-b', 0, 10)],
  });
  const estimated = advanceEstimation(first.state, {
    receivedAt: timeAt(10),
    devices: [atHub(10, 'hub-a', 'account-a', 10, 20), atHub(10, 'hub-b', 'account-a', 5, 20), atHub(10, 'hub-c', 'account-b', 10, 20)],
  });
  const shared = estimated.state.groups.find((group) => group.view.hubIds.length === 2);
  const unrelated = estimated.state.groups.find((group) => group.view.hubIds.length === 1 && group.view.hubIds[0] === 'hub-c');
  const previousUnrelated = structuredClone(unrelated.view.lastResult);
  const interrupted = interruptEstimation(estimated.state, { hubId: 'hub-a', at: timeAt(15), reason: 'disconnected' });
  const interruptedShared = interrupted.state.groups.find((group) => group.id === shared.id);
  const interruptedUnrelated = interrupted.state.groups.find((group) => group.id === unrelated.id);

  assert.equal(interruptedShared.view.reason, 'disconnected');
  assert.equal(interruptedShared.baseline, null);
  assert.deepEqual(interruptedUnrelated.view.lastResult, previousUnrelated);
  assert.equal(interruptedUnrelated.view.status, 'estimated');
  assert.equal(interruptedUnrelated.baseline !== null, true);
});

test('移行seedは現currentをbarrierとして保持し新しい観測から比較を始める', () => {
  const seeded = seedEstimation({
    receivedAt: timeAt(0),
    devices: [baseDevice({ cost: 10, usedPercent: 10 })],
  });
  const seededGroup = groupFor(seeded);
  assert.equal(seededGroup.baseline, null);
  assert.equal(seededGroup.latest, null);
  assert.equal(seededGroup.view.lastResult, null);
  assert.equal(seeded.events.length, 0);
  assert.equal(seededGroup.rebaseAfter.length, 2);

  const baseline = advanceEstimation(seeded.state, {
    receivedAt: timeAt(10),
    devices: [makeDevice({ cost: 20, usedPercent: 20, observedAt: timeAt(10) })],
  });
  assert.equal(groupFor(baseline).view.status, 'collecting');
  assert.equal(groupFor(baseline).baseline.cost, 20);
  assert.equal(groupFor(baseline).view.lastResult, null);
});
