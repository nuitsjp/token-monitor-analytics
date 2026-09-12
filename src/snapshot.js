// Hub input is the trust boundary. Project only display data; never retain
// arbitrary fields, request headers, session text, or authentication settings.
export class InvalidSnapshot extends Error {}

function fail(path) { throw new InvalidSnapshot(`${path}: データ形式が不正です`); }
function object(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path);
  return value;
}
function array(value, path) {
  if (!Array.isArray(value)) fail(path);
  return value;
}
function scalar(value, type, path) {
  if (value == null) return null;
  if (typeof value !== type || (type === 'number' && !Number.isFinite(value))) fail(path);
  return value;
}
function fields(value, spec, path) {
  object(value, path);
  const result = {};
  for (const [type, names] of Object.entries(spec)) {
    for (const name of names.split(' ')) {
      if (Object.hasOwn(value, name)) result[name] = scalar(value[name], type, `${path}.${name}`);
    }
  }
  return result;
}
function numbers(value, path) {
  if (value == null) return {};
  object(value, path);
  return Object.fromEntries(Object.entries(value).map(([key, number]) => {
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0) fail(`${path}.*`);
    return [key, number];
  }));
}
function periods(value, path) {
  if (value != null) object(value, path);
  return Object.fromEntries(['today', 'month', 'allTime'].map(name => {
    const source = value?.[name];
    if (source != null) object(source, `${path}.${name}`);
    const costUsd = scalar(source?.costUsd, 'number', `${path}.${name}.costUsd`);
    const totalTokens = scalar(source?.totalTokens, 'number', `${path}.${name}.totalTokens`);
    if (costUsd < 0 || totalTokens < 0) fail(`${path}.${name}`);
    return [name, { costUsd, totalTokens,
      clientCosts: numbers(source?.clientCosts, `${path}.${name}.clientCosts`),
      modelCosts: numbers(source?.modelCosts, `${path}.${name}.modelCosts`) }];
  }));
}
function windowData(value, path) {
  const result = fields(value, {
    string: 'kind label limitId metric source boundaryKind resetsAt resetDescription detail currency',
    number: 'used limit remaining usedPercent remainingPercent windowMinutes',
    boolean: 'additional showMeter'
  }, path);
  for (const name of ['usedPercent', 'remainingPercent']) {
    if (result[name] != null && (result[name] < 0 || result[name] > 100)) fail(`${path}.${name}`);
  }
  return result;
}
function balanceData(value, path) {
  if (value == null) return null;
  const result = fields(value, {
    string: 'currency quotaGroup expiresAt trackingSince planStatus todayUsageDate latestModelUsageDate todayUsageBasis snapshotDate',
    number: 'amount todaySpend weekSpend monthSpend allTimeSpend requestCount giftBalance cashBalance planUsed planLimit planPercent todayTokenTotal',
    boolean: 'monthSinceTracking'
  }, path);
  if (value.tranches != null) result.tranches = array(value.tranches, `${path}.tranches`).map(item =>
    fields(item, { number: 'amount', string: 'currency expiresAt' }, `${path}.tranches[]`));
  return result;
}
function limits(value, path) {
  if (value == null) return null;
  const result = fields(value, { string: 'updatedAt', number: 'refreshMs' }, path);
  result.providers = array(value.providers, `${path}.providers`).map((provider, index) => {
    const location = `${path}.providers[${index}]`;
    const item = fields(provider, {
      string: 'provider adapterId accountKey accountLabel planLabel accountName accountEmail workspaceKind status actionRequired source sourceDetail updatedAt region',
      number: 'balanceUsd', boolean: 'stale'
    }, location);
    if (!item.provider) fail(`${location}.provider`);
    item.windows = array(provider.windows, `${location}.windows`).map((window, i) => windowData(window, `${location}.windows[${i}]`));
    item.balance = balanceData(provider.balance, `${location}.balance`);
    if (provider.resetCredits != null) {
      item.resetCredits = fields(provider.resetCredits, { number: 'availableCount', string: 'nextExpiresAt' }, `${location}.resetCredits`);
      if (provider.resetCredits.expirations != null) {
        item.resetCredits.expirations = array(provider.resetCredits.expirations, `${location}.resetCredits.expirations`)
          .map(expiry => scalar(expiry, 'string', `${location}.resetCredits.expirations[]`));
      }
    }
    if (provider.usageSummary != null) item.usageSummary = fields(provider.usageSummary, {
      string: 'period', number: 'requests inputTokens outputTokens cacheReadTokens cacheCreationTokens totalTokens standardCost actualCost averageDurationMs'
    }, `${location}.usageSummary`);
    return item;
  });
  return result;
}

export function parseSnapshot(data) {
  let envelope;
  try { envelope = JSON.parse(data); } catch { fail('SSE JSON'); }
  object(envelope, 'SSE');
  if (envelope.type !== 'stats') fail('SSE.type');
  if (typeof envelope.at !== 'string' || !Number.isFinite(Date.parse(envelope.at))) fail('SSE.at');
  const source = object(envelope.stats, 'stats');
  const stats = fields(source, { string: 'updatedAt' }, 'stats');
  stats.periods = periods(source.periods, 'stats.periods');
  stats.limits = limits(source.limits, 'stats.limits');
  const ids = new Set();
  stats.devices = array(source.devices, 'stats.devices').map((device, index) => {
    const path = `stats.devices[${index}]`;
    const item = fields(device, { string: 'deviceId hostname platform updatedAt receivedAt', boolean: 'stale' }, path);
    if (!item.deviceId || ids.has(item.deviceId)) fail(`${path}.deviceId`);
    ids.add(item.deviceId);
    item.periods = periods(device.periods, `${path}.periods`);
    item.limits = limits(device.limits, `${path}.limits`);
    return item;
  });
  return { upstreamAt: envelope.at, stats };
}
