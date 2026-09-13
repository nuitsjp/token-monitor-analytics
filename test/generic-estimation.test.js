import assert from 'node:assert/strict';
import test from 'node:test';

import { advanceEstimation, windowKey } from '../src/estimation.js';

const START = Date.parse('2026-09-13T00:00:00.000Z');
const RESET = '2026-10-01T00:00:00.000Z';
const SERVICES = [
  'codex',
  'claude',
  'grok',
  'cursor',
  'copilot',
  'antigravity',
  'unknown-service',
];

function at(minutes) {
  return new Date(START + minutes * 60_000).toISOString();
}

function makeWindow({
  kind = 'weekly',
  windowMinutes = 10_080,
  limitId = 'generic-limit',
  label = '',
  resetsAt = RESET,
  additional = false,
  showMeter = true,
  metric,
  boundaryKind,
  usedPercent,
  remainingPercent,
  used,
  limit,
  ...overrides
} = {}) {
  const window = {
    kind,
    windowMinutes,
    limitId,
    label,
    resetsAt,
    additional,
    showMeter,
    ...overrides,
  };
  if (metric !== undefined) window.metric = metric;
  if (boundaryKind !== undefined) window.boundaryKind = boundaryKind;
  if (usedPercent !== undefined) window.usedPercent = usedPercent;
  if (remainingPercent !== undefined) window.remainingPercent = remainingPercent;
  if (used !== undefined) window.used = used;
  if (limit !== undefined) window.limit = limit;
  return window;
}

function makeProvider({
  tool = 'unknown-service',
  accountKey = 'account-a',
  accountEmail,
  accountLabel = 'Plus',
  planLabel = 'Plus',
  usedPercent = 10,
  updatedAt = at(0),
  resetsAt = RESET,
  windows,
  ...overrides
} = {}) {
  const provider = {
    provider: tool,
    accountKey,
    accountLabel,
    planLabel,
    status: 'ok',
    updatedAt,
    stale: false,
    windows: windows ?? [makeWindow({ usedPercent, resetsAt })],
    ...overrides,
  };
  if (accountEmail !== undefined) provider.accountEmail = accountEmail;
  return provider;
}

function makeDevice({
  hubId = 'hub-a',
  deviceId = 'device-a',
  observationId = `${hubId}-${deviceId}`,
  tool = 'unknown-service',
  cost = 0,
  costs,
  observedAt = at(0),
  providerUpdatedAt = observedAt,
  providers,
  present = true,
  gapReason,
  metadataStale = false,
  healthOverall = 'healthy',
  healthSource = 'detected',
  collectionState = 'direct',
  healthObservedAt = observedAt,
  ...providerOptions
} = {}) {
  const clientCosts = costs ?? { [tool]: cost };
  const client = {
    overall: healthOverall,
    source: { state: healthSource },
    collection: { state: collectionState },
  };
  return {
    hubId,
    deviceId,
    observationId,
    present,
    ...(gapReason === undefined ? {} : { gapReason }),
    metadata: { stale: metadataStale },
    observation: {
      periods: { allTime: { clientCosts } },
      clientHealth: {
        observedAt: healthObservedAt,
        clients: { [tool]: client },
      },
      limits: {
        providers: providers ?? [makeProvider({
          tool,
          updatedAt: providerUpdatedAt,
          ...providerOptions,
        })],
      },
    },
  };
}

function snapshot(minutes, devices) {
  return { receivedAt: at(minutes), devices };
}

function activeGroups(output, tool) {
  return output.state.groups.filter((group) => group.view.active && group.view.tool === tool);
}

function onlyGroup(output, tool) {
  const groups = activeGroups(output, tool);
  assert.equal(groups.length, 1, `expected one active ${tool} group, got ${groups.length}`);
  return groups[0];
}

test('全providerが集計範囲を反映した同じ費用増分から100 USDを算出する', () => {
  for (const tool of SERVICES) {
    const isGrok = tool === 'grok';
    const providersAt = (minutes) => [makeProvider({
      tool,
      accountKey: isGrok ? `token-${minutes}` : 'shared-account',
      ...(isGrok ? { accountEmail: minutes === 0 ? ' User@Example.Invalid ' : 'user@example.invalid' } : {}),
      usedPercent: minutes === 0 ? 10 : 20,
      updatedAt: at(minutes),
    })];
    const first = advanceEstimation(null, snapshot(0, [
      makeDevice({ tool, cost: 0, providers: providersAt(0) }),
      makeDevice({
        tool,
        hubId: 'hub-b',
        deviceId: 'device-b',
        cost: 0,
        providers: providersAt(0),
      }),
    ]));
    const second = advanceEstimation(first.state, snapshot(10, [
      makeDevice({ tool, cost: tool === 'cursor' ? 10 : 5, observedAt: at(10), providers: providersAt(10) }),
      makeDevice({
        tool,
        hubId: 'hub-b',
        deviceId: 'device-b',
        cost: tool === 'cursor' ? 10 : 5,
        observedAt: at(10),
        providers: providersAt(10),
      }),
    ]));

    const group = onlyGroup(second, tool);
    assert.equal(group.view.status, 'estimated', tool);
    assert.equal(group.view.reason, null, tool);
    assert.equal(group.view.lastResult.baseCapacityUsd, 100, tool);
    assert.equal(group.view.lastResult.deltaCostUsd, 10, tool);
    assert.equal(group.view.lastResult.weightedPercent, 10, tool);
    assert.deepEqual(group.view.hubIds, ['hub-a', 'hub-b'], tool);
  }
});

test('未知providerの同一accountKeyを複数Hubで合算し、ΔC15・Δp10から150 USDを算出する', () => {
  const first = advanceEstimation(null, snapshot(0, [
    makeDevice({ tool: 'unknown-service', hubId: 'hub-a', cost: 0, usedPercent: 10 }),
    makeDevice({ tool: 'unknown-service', hubId: 'hub-b', cost: 0, usedPercent: 10 }),
  ]));
  const second = advanceEstimation(first.state, snapshot(10, [
    makeDevice({
      tool: 'unknown-service',
      hubId: 'hub-a',
      cost: 10,
      usedPercent: 20,
      observedAt: at(10),
      providerUpdatedAt: at(10),
    }),
    makeDevice({
      tool: 'unknown-service',
      hubId: 'hub-b',
      cost: 5,
      usedPercent: 20,
      observedAt: at(10),
      providerUpdatedAt: at(10),
    }),
  ]));

  const group = onlyGroup(second, 'unknown-service');
  assert.equal(group.view.lastResult.baseCapacityUsd, 150);
  assert.equal(group.view.lastResult.deltaCostUsd, 15);
  assert.equal(group.view.lastResult.weightedPercent, 10);
  assert.deepEqual(group.view.sources, [
    { hubId: 'hub-a', deviceId: 'device-a' },
    { hubId: 'hub-b', deviceId: 'device-a' },
  ]);
});

test('Cursorの代表端末が交替しても同じ契約の費用増分として比較する', () => {
  const devices = (minute, latest) => ['a', 'b'].map(deviceId => makeDevice({
    tool: 'cursor', deviceId, cost: deviceId === latest ? minute : Math.max(0, minute - 1),
    observedAt: at(deviceId === latest ? minute : Math.max(0, minute - 1)),
    providerUpdatedAt: at(minute), usedPercent: 10 + minute,
  }));
  const first = advanceEstimation(null, snapshot(0, devices(0, 'a')));
  const second = advanceEstimation(first.state, snapshot(10, devices(10, 'b')));
  const group = onlyGroup(second, 'cursor');
  assert.equal(group.id, onlyGroup(first, 'cursor').id);
  assert.equal(group.view.lastResult.baseCapacityUsd, 100);
  assert.equal(group.view.lastResult.deltaCostUsd, 10);
  assert.deepEqual(group.view.sources, [{ hubId: 'hub-a', deviceId: 'b' }]);
  assert.equal(group.view.duplicateSources.length, 1);
  assert.equal(group.view.partial, false);
});

test('全サービスで不十分な端末を除外して有効な費用増分から参考値を推定する', () => {
  for (const tool of SERVICES) {
    const devices = minute => [
      makeDevice({ tool, accountEmail: 'test@example.invalid', deviceId: 'valid', cost: minute, observedAt: at(minute), usedPercent: 10 + minute }),
      makeDevice({ tool, accountEmail: 'test@example.invalid', deviceId: 'stale', cost: 100, metadataStale: true }),
      makeDevice({ tool, accountEmail: 'test@example.invalid', deviceId: 'missing', costs: {}, observedAt: at(minute), usedPercent: 10 + minute }),
    ];
    const first = advanceEstimation(null, snapshot(0, devices(0)));
    const group = onlyGroup(advanceEstimation(first.state, snapshot(10, devices(10))), tool);
    assert.equal(group.view.lastResult.baseCapacityUsd, 100, tool);
    assert.equal(group.view.partial, true, tool);
    assert.deepEqual(group.view.sources, [{ hubId: 'hub-a', deviceId: 'valid' }], tool);
    assert.deepEqual(group.view.excludedSources.map(row => row.reason).sort(), ['missing_cost', 'stale_device'], tool);
  }
});

test('remainingPercentとused/limitから消費率を正規化して同じ100 USDを算出する', () => {
  const cases = [
    {
      name: 'remainingPercent',
      initial: { remainingPercent: 90 },
      latest: { remainingPercent: 80 },
    },
    {
      name: 'used/limit',
      initial: { used: 20, limit: 100 },
      latest: { used: 30, limit: 100 },
    },
  ];

  for (const current of cases) {
    const windowsAt = (minutes) => [makeWindow({
      ...current[minutes === 0 ? 'initial' : 'latest'],
      label: current.name,
    })];
    const first = advanceEstimation(null, snapshot(0, [makeDevice({
      tool: 'ratio-service',
      providers: [makeProvider({ tool: 'ratio-service', windows: windowsAt(0) })],
    })]));
    const second = advanceEstimation(first.state, snapshot(10, [makeDevice({
      tool: 'ratio-service',
      cost: 10,
      observedAt: at(10),
      providerUpdatedAt: at(10),
      providers: [makeProvider({
        tool: 'ratio-service',
        updatedAt: at(10),
        windows: windowsAt(10),
      })],
    })]));

    const group = onlyGroup(second, 'ratio-service');
    assert.equal(group.view.status, 'estimated', current.name);
    assert.equal(group.view.lastResult.baseCapacityUsd, 100, current.name);
    assert.equal(group.view.lastResult.weightedPercent, 10, current.name);
  }
});

test('daily・billing・additionalの枠は種類によらず独立して100 USDを算出する', () => {
  const windowsAt = (usedPercent) => [
    makeWindow({ kind: 'daily', windowMinutes: 1_440, limitId: 'daily-limit', usedPercent }),
    makeWindow({ kind: 'billing', windowMinutes: 43_200, limitId: 'billing-limit', usedPercent }),
    makeWindow({ kind: 'weekly', windowMinutes: 10_080, limitId: 'addon-limit', additional: true, usedPercent }),
  ];
  const first = advanceEstimation(null, snapshot(0, [makeDevice({
    tool: 'window-service',
    providers: [makeProvider({ tool: 'window-service', windows: windowsAt(10) })],
  })]));
  const second = advanceEstimation(first.state, snapshot(10, [makeDevice({
    tool: 'window-service',
    cost: 10,
    observedAt: at(10),
    providerUpdatedAt: at(10),
    providers: [makeProvider({
      tool: 'window-service',
      updatedAt: at(10),
      windows: windowsAt(20),
    })],
  })]));

  const groups = activeGroups(second, 'window-service');
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map((group) => group.view.windowKind).sort(), ['billing', 'daily', 'weekly']);
  for (const group of groups) {
    assert.equal(group.view.status, 'estimated', group.view.windowKind);
    assert.equal(group.view.lastResult.baseCapacityUsd, 100, group.view.windowKind);
  }
});

test('limitIdなしで異なるlabelを持つ並列枠はlabelをwindowKeyへ加えて別々に推定する', () => {
  const windowsAt = (usedPercent) => [
    makeWindow({ kind: 'daily', windowMinutes: 1_440, limitId: null, label: ' Primary ', usedPercent }),
    makeWindow({ kind: 'daily', windowMinutes: 1_440, limitId: '', label: 'Secondary', usedPercent }),
  ];
  const first = advanceEstimation(null, snapshot(0, [makeDevice({
    tool: 'label-service',
    providers: [makeProvider({ tool: 'label-service', windows: windowsAt(10) })],
  })]));
  const second = advanceEstimation(first.state, snapshot(10, [makeDevice({
    tool: 'label-service',
    cost: 10,
    observedAt: at(10),
    providerUpdatedAt: at(10),
    providers: [makeProvider({
      tool: 'label-service',
      updatedAt: at(10),
      windows: windowsAt(20),
    })],
  })]));

  const groups = activeGroups(second, 'label-service');
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => JSON.parse(group.view.windowKey).slice(-1)).sort(), [
    ['Primary'],
    ['Secondary'],
  ]);
  for (const group of groups) {
    assert.equal(group.view.status, 'estimated');
    assert.equal(group.view.lastResult.baseCapacityUsd, 100);
  }
  assert.equal(windowKey(windowsAt(10)[0]), JSON.stringify(['daily', 1_440, null, false, null, 'Primary']));
});

test('同じplan名でも異なるaccountKeyは別契約として各消費率を一度だけ使う', () => {
  const providersAt = (minutes) => [
    makeProvider({
      tool: 'plan-service',
      accountKey: 'account-a',
      planLabel: 'Same Plan',
      accountLabel: 'Same Plan',
      usedPercent: minutes === 0 ? 10 : 20,
      updatedAt: at(minutes),
    }),
    makeProvider({
      tool: 'plan-service',
      accountKey: 'account-b',
      planLabel: 'Same Plan',
      accountLabel: 'Same Plan',
      usedPercent: minutes === 0 ? 10 : 20,
      updatedAt: at(minutes),
    }),
  ];
  const first = advanceEstimation(null, snapshot(0, [makeDevice({
    tool: 'plan-service',
    providers: providersAt(0),
  })]));
  const second = advanceEstimation(first.state, snapshot(10, [makeDevice({
    tool: 'plan-service',
    cost: 20,
    observedAt: at(10),
    providers: providersAt(10),
  })]));

  const group = onlyGroup(second, 'plan-service');
  assert.equal(group.view.status, 'estimated');
  assert.equal(group.view.lastResult.baseCapacityUsd, 100);
  assert.equal(group.view.lastResult.weightedPercent, 20);
  assert.equal(group.view.accounts.length, 2);
  assert.equal(new Set(group.view.accounts.map(({ key }) => key)).size, 2);
  assert.deepEqual(group.view.accounts.map(({ plan, multiplier }) => ({ plan, multiplier })), [
    { plan: 'Same Plan', multiplier: 1 },
    { plan: 'Same Plan', multiplier: 1 },
  ]);
});

test('missing・health・stale・timestamp・reset・gapの不正データは理由を保持して推定しない', () => {
  const cases = [
    {
      name: 'missing cost',
      options: { costs: {} },
      reason: 'missing_cost',
    },
    {
      name: 'missing rate',
      options: { windows: [makeWindow()] },
      reason: 'missing_percentage',
    },
    {
      name: 'health unavailable',
      options: { healthOverall: 'unauthorized' },
      reason: 'usage_unavailable',
    },
    {
      name: 'stale device',
      options: { metadataStale: true },
      reason: 'stale_device',
    },
    {
      name: 'invalid provider timestamp',
      options: { providerUpdatedAt: 'not-a-timestamp' },
      reason: 'limits_unavailable',
    },
    {
      name: 'invalid reset',
      options: { resetsAt: 'not-a-reset-time' },
      reason: 'invalid_period',
    },
    {
      name: 'explicit gap',
      options: { gapReason: 'disconnected' },
      reason: 'disconnected',
    },
  ];

  for (const current of cases) {
    const group = onlyGroup(advanceEstimation(null, snapshot(0, [makeDevice({
      tool: 'invalid-service',
      ...current.options,
    })])), 'invalid-service');
    assert.equal(group.view.status, 'unavailable', current.name);
    assert.equal(group.view.reason, current.reason, current.name);
    assert.equal(group.view.lastResult, null, current.name);
  }
});

test('表示名からプランを推測せず、複数契約で明示プランが欠ける場合だけunknown_planにする', () => {
  const tool = 'unknown-service';
  for (const accountCount of [1, 2]) {
    const devicesAt = (minutes) => [makeDevice({
      tool, cost: minutes * accountCount, observedAt: at(minutes),
      providers: Array.from({ length: accountCount }, (_, index) => makeProvider({
        tool, accountKey: `account-${index}`, accountLabel: 'Account', planLabel: null,
        usedPercent: 10 + minutes, updatedAt: at(minutes),
      })),
    })];
    const first = advanceEstimation(null, snapshot(0, devicesAt(0)));
    const group = onlyGroup(advanceEstimation(first.state, snapshot(10, devicesAt(10))), tool);
    if (accountCount === 1) {
      assert.equal(group.view.status, 'estimated');
      assert.equal(group.view.lastResult.baseCapacityUsd, 100);
    } else {
      assert.equal(group.view.reason, 'unknown_plan');
      assert.equal(group.view.lastResult, null);
    }
    assert.ok(group.view.accounts.every((account) => account.plan === null));
  }
});

test('used/limitの上限変更をまたがず、新しい上限での観測から推定を再開する', () => {
  const tool = 'quantity-service';
  const devicesAt = (minutes, cost, used, limit) => [makeDevice({
    tool, cost, observedAt: at(minutes),
    windows: [makeWindow({ used, limit })],
  })];
  const first = advanceEstimation(null, snapshot(0, devicesAt(0, 0, 10, 100)));
  const second = advanceEstimation(first.state, snapshot(10, devicesAt(10, 10, 40, 200)));
  const rebased = onlyGroup(second, tool);
  assert.equal(rebased.view.status, 'collecting');
  assert.equal(rebased.view.lastResult, null);
  assert.equal(rebased.baseline.accounts[0].percentageLimit, 200);
  const third = onlyGroup(advanceEstimation(second.state, snapshot(20, devicesAt(20, 20, 60, 200))), tool);
  assert.equal(third.view.lastResult.baseCapacityUsd, 100);
  assert.equal(third.view.lastResult.from, at(10));
  assert.equal(third.view.lastResult.evidence.baseline.accounts[0].percentageLimit, 200);
});

test('同時刻のused/limit報告は比率が同じでも上限が異なれば競合として扱う', () => {
  const tool = 'quantity-service';
  const group = onlyGroup(advanceEstimation(null, snapshot(0, [
    makeDevice({ tool, windows: [makeWindow({ used: 10, limit: 100 })] }),
    makeDevice({ tool, hubId: 'hub-b', windows: [makeWindow({ used: 20, limit: 200 })] }),
  ])), tool);
  assert.equal(group.view.reason, 'conflicting_rate');
  assert.equal(group.view.lastResult, null);
});

test('同時刻のプラン・枠の採否条件が競合する場合はHubの並びによらず推定しない', () => {
  const tool = 'unknown-service';
  for (const override of [{ planLabel: 'Other Plan' }, { windows: [makeWindow({ usedPercent: 10, showMeter: false })] },
    { windows: [makeWindow({ usedPercent: 10, boundaryKind: 'expiry' })] }]) {
    for (const swapped of [false, true]) {
      const providers = [makeProvider({ tool }), makeProvider({ tool, ...override })];
      if (swapped) providers.reverse();
      const group = onlyGroup(advanceEstimation(null, snapshot(0, providers.map((provider, i) => makeDevice({
        tool, hubId: `hub-${i}`, providers: [provider],
      })))), tool);
      assert.equal(group.view.reason, 'conflicting_rate');
      assert.equal(group.view.lastResult, null);
    }
  }
});

test('boundaryKind・showMeter false・credits・balanceは明示的に推定対象外とする', () => {
  const cases = [
    { name: 'non-reset boundary', window: makeWindow({ boundaryKind: 'rolling' }) },
    { name: 'hidden meter', window: makeWindow({ showMeter: false }) },
    { name: 'credits kind', window: makeWindow({ kind: 'credits' }) },
    { name: 'credits metric', window: makeWindow({ metric: 'credits' }) },
    { name: 'balance kind', window: makeWindow({ kind: 'balance' }) },
    { name: 'balance metric', window: makeWindow({ metric: 'balance' }) },
  ];

  for (const current of cases) {
    const first = advanceEstimation(null, snapshot(0, [makeDevice({
      tool: 'excluded-service',
      providers: [makeProvider({ tool: 'excluded-service', windows: [current.window] })],
    })]));
    const group = onlyGroup(first, 'excluded-service');
    assert.equal(group.view.status, 'unavailable', current.name);
    assert.equal(group.view.reason, 'unsupported_window', current.name);
    assert.equal(group.view.lastResult, null, current.name);
  }
});

test('同一provider内で同一windowKeyが重複する枠はambiguous_windowとして停止する', () => {
  const duplicate = makeWindow({ usedPercent: 10 });
  const first = advanceEstimation(null, snapshot(0, [makeDevice({
    tool: 'ambiguous-service',
    providers: [makeProvider({ tool: 'ambiguous-service', windows: [duplicate, { ...duplicate }] })],
  })]));
  const group = onlyGroup(first, 'ambiguous-service');

  assert.equal(group.view.status, 'unavailable');
  assert.equal(group.view.reason, 'ambiguous_window');
  assert.equal(group.view.lastResult, null);
});
