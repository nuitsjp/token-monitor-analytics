const PERIOD_NAMES = ['today', 'month', 'allTime'];

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(numberOrZero(value) * factor) / factor;
}

function makePeriod({ totalTokens, costUsd, codexTokens, claudeTokens, codexCost, claudeCost }) {
  const tokens = Math.max(0, Math.round(numberOrZero(totalTokens)));
  const codex = Math.max(0, Math.round(numberOrZero(codexTokens)));
  const claude = Math.max(0, Math.round(numberOrZero(claudeTokens)));
  const cost = round(costUsd);
  const codexCostValue = round(codexCost);
  const claudeCostValue = round(claudeCost);
  const cacheRead = Math.round(tokens * 0.2);
  const cacheWrite = Math.round(tokens * 0.05);
  const output = Math.max(0, tokens - cacheRead - cacheWrite);

  return {
    capabilities: { tokenComponents: true, throughput: true },
    totalTokens: tokens,
    costUsd: cost,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: output,
    unclassifiedTokens: 0,
    timedTokens: output,
    timedOutputTokens: output,
    timedDurationMs: output * 3,
    clients: { codex, claude },
    clientCosts: { codex: codexCostValue, claude: claudeCostValue },
    clientCacheReads: { codex: Math.round(cacheRead * 0.6), claude: cacheRead - Math.round(cacheRead * 0.6) },
    clientCacheWrites: { codex: Math.round(cacheWrite * 0.6), claude: cacheWrite - Math.round(cacheWrite * 0.6) },
    clientOutputs: { codex: Math.round(output * 0.6), claude: output - Math.round(output * 0.6) },
    clientUnclassifiedTokens: {},
    models: { 'mock-gpt': codex, 'mock-claude': claude },
    modelCosts: { 'mock-gpt': codexCostValue, 'mock-claude': claudeCostValue },
    modelCacheReads: { 'mock-gpt': Math.round(cacheRead * 0.6), 'mock-claude': cacheRead - Math.round(cacheRead * 0.6) },
    modelCacheWrites: { 'mock-gpt': Math.round(cacheWrite * 0.6), 'mock-claude': cacheWrite - Math.round(cacheWrite * 0.6) },
    modelOutputs: { 'mock-gpt': Math.round(output * 0.6), 'mock-claude': output - Math.round(output * 0.6) },
    modelUnclassifiedTokens: {},
    clientModels: { codex: { 'mock-gpt': codex }, claude: { 'mock-claude': claude } },
    clientModelCosts: {
      codex: { 'mock-gpt': codexCostValue },
      claude: { 'mock-claude': claudeCostValue }
    },
    projects: {},
    sessions: {}
  };
}

function addPeriods(left, right) {
  const result = {};
  for (const periodName of PERIOD_NAMES) {
    const first = left[periodName];
    const second = right[periodName];
    result[periodName] = makePeriod({
      totalTokens: first.totalTokens + second.totalTokens,
      costUsd: first.costUsd + second.costUsd,
      codexTokens: first.clients.codex + second.clients.codex,
      claudeTokens: first.clients.claude + second.clients.claude,
      codexCost: first.clientCosts.codex + second.clientCosts.codex,
      claudeCost: first.clientCosts.claude + second.clientCosts.claude
    });
  }
  return result;
}

function makeWindow({
  kind,
  limitId,
  label,
  usedPercent = null,
  resetsAt,
  windowMinutes,
  showMeter = true,
  remaining = null,
  boundaryKind = 'reset',
  metric = 'credits'
}) {
  const percent = usedPercent === null ? null : numberOrZero(usedPercent);
  return {
    kind,
    metric,
    source: 'web',
    limitId,
    boundaryKind,
    label,
    used: null,
    limit: null,
    remaining,
    usedPercent: percent,
    remainingPercent: percent === null ? null : round(100 - percent, 3),
    resetsAt,
    windowMinutes,
    resetDescription: '',
    detail: '',
    currency: 'USD',
    showMeter
  };
}

function makeProvider({ provider, accountKey, updatedAt, usedPercent, deviceIndex }) {
  const codexWindows = [
    // These deliberately share kind and limitId while their reset periods differ.
    makeWindow({
      kind: 'weekly',
      limitId: 'mock-shared-window',
      label: 'Short window',
      usedPercent,
      resetsAt: '2026-09-12T06:00:00.000Z',
      windowMinutes: 300
    }),
    makeWindow({
      kind: 'weekly',
      limitId: 'mock-shared-window',
      label: 'Long window',
      usedPercent: null,
      resetsAt: '2026-09-19T02:00:00.000Z',
      windowMinutes: 10080
    })
  ];
  const claudeWindows = [
    makeWindow({
      kind: 'session',
      limitId: 'mock-claude-session',
      label: 'Session',
      usedPercent: deviceIndex === 0 ? 40 : 55,
      resetsAt: '2026-09-12T05:00:00.000Z',
      windowMinutes: 300
    }),
    makeWindow({
      kind: 'session',
      limitId: 'mock-claude-model',
      label: 'Model allowance',
      usedPercent: null,
      resetsAt: null,
      windowMinutes: null
    })
  ];
  const balance = {
    amount: round(4.5 + deviceIndex),
    currency: 'USD',
    todaySpend: round(0.5 + deviceIndex * 0.2),
    weekSpend: round(1.2 + deviceIndex * 0.3),
    monthSpend: round(2.4 + deviceIndex * 0.4),
    allTimeSpend: round(8.5 + deviceIndex),
    requestCount: 20 + deviceIndex * 5,
    quotaGroup: 'mock-balance'
  };
  const openRouterWindows = [
    makeWindow({
      kind: 'billing',
      limitId: 'mock-balance',
      label: 'Balance',
      usedPercent: null,
      remaining: balance.amount,
      resetsAt: null,
      windowMinutes: null,
      showMeter: false,
      boundaryKind: 'expiry'
    })
  ];

  const windows = provider === 'codex'
    ? codexWindows
    : provider === 'claude'
      ? claudeWindows
      : openRouterWindows;
  return {
    provider,
    accountKey,
    accountLabel: `mock-${provider}-${deviceIndex === 0 ? 'a' : 'b'}`,
    planLabel: 'Mock plan',
    accountName: '',
    accountEmail: '',
    workspaceKind: '',
    status: 'ok',
    source: provider === 'codex' ? 'rpc' : provider === 'claude' ? 'web' : 'api',
    sourceDetail: 'managed',
    updatedAt,
    windows,
    balanceUsd: provider === 'openrouter' ? balance.amount : null,
    balance: provider === 'openrouter' ? balance : null,
    resetCredits: null,
    region: ''
  };
}

function makeDevice({ deviceId, at, costUsd, usedPercent, deviceIndex }) {
  const cost = numberOrZero(costUsd);
  const todayTokens = deviceIndex === 0 ? 12000 : 7000;
  const monthTokens = deviceIndex === 0 ? 48000 : 30000;
  const allTimeTokens = deviceIndex === 0 ? 160000 : 100000;
  const periods = {
    today: makePeriod({
      totalTokens: todayTokens,
      costUsd: deviceIndex === 0 ? cost : cost * 0.5,
      codexTokens: Math.round(todayTokens * 0.6),
      claudeTokens: Math.round(todayTokens * 0.4),
      codexCost: (deviceIndex === 0 ? cost : cost * 0.5) * 0.6,
      claudeCost: (deviceIndex === 0 ? cost : cost * 0.5) * 0.4
    }),
    month: makePeriod({
      totalTokens: monthTokens,
      costUsd: cost * (deviceIndex === 0 ? 2.2 : 1.4),
      codexTokens: Math.round(monthTokens * 0.6),
      claudeTokens: Math.round(monthTokens * 0.4),
      codexCost: cost * (deviceIndex === 0 ? 2.2 : 1.4) * 0.6,
      claudeCost: cost * (deviceIndex === 0 ? 2.2 : 1.4) * 0.4
    }),
    allTime: makePeriod({
      totalTokens: allTimeTokens,
      costUsd: cost * (deviceIndex === 0 ? 5.1 : 3.2),
      codexTokens: Math.round(allTimeTokens * 0.6),
      claudeTokens: Math.round(allTimeTokens * 0.4),
      codexCost: cost * (deviceIndex === 0 ? 5.1 : 3.2) * 0.6,
      claudeCost: cost * (deviceIndex === 0 ? 5.1 : 3.2) * 0.4
    })
  };
  const suffix = deviceIndex === 0 ? 'a' : 'b';
  return {
    deviceId,
    hostname: `mock-host-${suffix}`,
    platform: deviceIndex === 0 ? 'win32-x64' : 'linux-x64',
    osName: deviceIndex === 0 ? 'Mock Windows' : 'Mock Linux',
    osVersion: '1.0',
    agentVersion: 'mock-agent-1.0.0',
    agentRuntime: 'node',
    updatedAt: at,
    receivedAt: at,
    ageMs: 0,
    stale: false,
    projectsEnabled: true,
    periodWindows: {
      today: { endAt: '2026-09-13T00:00:00.000Z', timeZone: 'UTC' },
      month: { endAt: '2026-10-01T00:00:00.000Z', timeZone: 'UTC' }
    },
    periods,
    limits: {
      updatedAt: at,
      refreshMs: 300000,
      providers: [
        makeProvider({
          provider: 'codex',
          accountKey: `mock-codex-account-${suffix}`,
          updatedAt: at,
          usedPercent,
          deviceIndex
        }),
        makeProvider({
          provider: 'claude',
          accountKey: `mock-claude-account-${suffix}`,
          updatedAt: at,
          usedPercent,
          deviceIndex
        }),
        makeProvider({
          provider: 'openrouter',
          accountKey: `mock-openrouter-account-${suffix}`,
          updatedAt: at,
          usedPercent,
          deviceIndex
        })
      ]
    }
  };
}

export function makeStats({ costUsd = 12.5, usedPercent = 25, at = '2026-09-12T02:00:00.000Z' } = {}) {
  const deviceA = makeDevice({
    deviceId: 'device-a',
    at,
    costUsd,
    usedPercent,
    deviceIndex: 0
  });
  const deviceB = makeDevice({
    deviceId: 'device-b',
    at,
    costUsd,
    usedPercent,
    deviceIndex: 1
  });
  const devices = [deviceA, deviceB];
  const limitsProviders = devices.flatMap((device) => device.limits.providers.map((provider) => ({
    ...provider,
    sourceDeviceId: device.deviceId,
    windows: provider.windows.map((window) => ({ ...window }))
  })));

  return {
    updatedAt: at,
    periods: addPeriods(deviceA.periods, deviceB.periods),
    devices,
    limits: {
      updatedAt: at,
      refreshMs: 300000,
      providers: limitsProviders
    },
    projectsIncomplete: false
  };
}
