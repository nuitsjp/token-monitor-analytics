const PERIOD_NAMES = ['today', 'month', 'allTime'];

const PERIOD_NUMBER_FIELDS = [
  'totalTokens',
  'costUsd',
  'cacheReadTokens',
  'cacheWriteTokens',
  'outputTokens',
  'unclassifiedTokens',
  'timedTokens',
  'timedOutputTokens',
  'timedDurationMs'
];

const PERIOD_NUMBER_MAP_FIELDS = [
  'clients',
  'clientCosts',
  'clientCacheReads',
  'clientCacheWrites',
  'clientOutputs',
  'clientUnclassifiedTokens',
  'models',
  'modelCosts',
  'modelCacheReads',
  'modelCacheWrites',
  'modelOutputs',
  'modelUnclassifiedTokens'
];

const PERIOD_NESTED_NUMBER_MAP_FIELDS = ['clientModels', 'clientModelCosts'];

const DEVICE_STRING_METADATA_FIELDS = [
  'hostname',
  'platform',
  'osName',
  'osVersion',
  'agentVersion',
  'agentRuntime'
];

const PROVIDER_STRING_FIELDS = [
  'provider',
  'adapterId',
  'accountKey',
  'webAccountKey',
  'accountLabel',
  'planLabel',
  'accountName',
  'accountEmail',
  'workspaceKind',
  'status',
  'actionRequired',
  'source',
  'sourceDetail',
  'region',
  'sourceDeviceId'
];

const WINDOW_STRING_FIELDS = [
  'kind',
  'metric',
  'source',
  'limitId',
  'boundaryKind',
  'label',
  'resetDescription',
  'detail',
  'currency'
];

const WINDOW_NUMBER_FIELDS = [
  'used',
  'limit',
  'remaining',
  'usedPercent',
  'remainingPercent',
  'windowMinutes'
];

const BALANCE_NUMBER_FIELDS = [
  'amount',
  'todaySpend',
  'weekSpend',
  'monthSpend',
  'allTimeSpend',
  'requestCount',
  'giftBalance',
  'cashBalance',
  'planUsed',
  'planLimit',
  'planPercent',
  'todayTokenTotal'
];

const BALANCE_STRING_FIELDS = [
  'currency',
  'quotaGroup',
  'planStatus',
  'todayUsageDate',
  'latestModelUsageDate',
  'todayUsageBasis',
  'snapshotDate'
];

const USAGE_SUMMARY_NUMBER_FIELDS = [
  'requests',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheCreationTokens',
  'totalTokens',
  'standardCost',
  'actualCost',
  'averageDurationMs'
];

export class ValidationError extends Error {
  constructor(pathOrMessage, reason) {
    super(reason === undefined ? pathOrMessage : `${pathOrMessage}: ${reason}`);
    this.name = 'ValidationError';
    if (reason !== undefined) this.path = pathOrMessage;
  }
}

function invalid(path, reason) {
  throw new ValidationError(path, reason);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function objectAt(value, path) {
  if (!isObject(value)) invalid(path, 'オブジェクトではありません');
  return value;
}

function arrayAt(value, path) {
  if (!Array.isArray(value)) invalid(path, '配列ではありません');
  return value;
}

function stringAt(value, path, { nullable = false, nonEmpty = false } = {}) {
  if (value === null && nullable) return null;
  if (typeof value !== 'string') invalid(path, '文字列ではありません');
  if (nonEmpty && value.length === 0) invalid(path, '空文字列です');
  return value;
}

function booleanAt(value, path, { nullable = false } = {}) {
  if (value === null && nullable) return null;
  if (typeof value !== 'boolean') invalid(path, '真偽値ではありません');
  return value;
}

function numberAt(value, path, { nullable = false, min = 0, max = Infinity, integer = false } = {}) {
  if (value === null && nullable) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(path, '有限の数値ではありません');
  if (value < min || value > max) invalid(path, '許容範囲外です');
  if (integer && !Number.isInteger(value)) invalid(path, '整数ではありません');
  return value;
}

function timestampAt(value, path, { nullable = false } = {}) {
  if (value === null && nullable) return null;
  if (typeof value !== 'string') invalid(path, '日時文字列ではありません');
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u.exec(value);
  if (!match) invalid(path, 'ISO 8601 UTC日時ではありません');
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = ''] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const millisecond = Number(fraction.padEnd(3, '0'));
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
    || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute
    || date.getUTCSeconds() !== second
  ) {
    invalid(path, '存在しない日時です');
  }
  return value;
}

function optional(input, key, path, validator) {
  if (!Object.hasOwn(input, key)) return undefined;
  if (input[key] === null) return null;
  return validator(input[key], `${path}.${key}`);
}

function assignOptional(output, input, key, path, validator) {
  const value = optional(input, key, path, validator);
  if (value !== undefined) output[key] = value;
}

function safeDynamicKey(key, path) {
  if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
    invalid(`${path}.*`, '使用できないキーです');
  }
}

function numberMap(value, path) {
  const input = objectAt(value, path);
  const output = {};
  for (const [key, entry] of Object.entries(input)) {
    safeDynamicKey(key, path);
    output[key] = numberAt(entry, `${path}.*`, { nullable: true });
  }
  return output;
}

function nestedNumberMap(value, path) {
  const input = objectAt(value, path);
  const output = {};
  for (const [key, entry] of Object.entries(input)) {
    safeDynamicKey(key, path);
    output[key] = numberMap(entry, `${path}.*`);
  }
  return output;
}

function stringArray(value, path) {
  return arrayAt(value, path).map((entry, index) => stringAt(entry, `${path}[${index}]`));
}

function projectSession(value, path) {
  const input = objectAt(value, path);
  const output = {};
  for (const field of ['client', 'sessionId', 'startedAt', 'lastUsedAt', 'projectId', 'projectLabel', 'title', 'sessionKind']) {
    assignOptional(output, input, field, path, stringAt);
  }
  for (const field of [
    'totalTokens', 'costUsd', 'messageCount', 'inputTokens', 'outputTokens',
    'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'
  ]) {
    assignOptional(output, input, field, path, numberAt);
  }
  for (const field of ['models', 'modelCosts', 'providers']) {
    assignOptional(output, input, field, path, numberMap);
  }
  return output;
}

function projectSessionMap(value, path) {
  const input = objectAt(value, path);
  const output = {};
  for (const [key, entry] of Object.entries(input)) {
    safeDynamicKey(key, path);
    output[key] = projectSession(entry, `${path}.*`);
  }
  return output;
}

function projectProject(value, path) {
  const input = objectAt(value, path);
  const output = {};
  assignOptional(output, input, 'label', path, stringAt);
  assignOptional(output, input, 'tokens', path, numberAt);
  assignOptional(output, input, 'costUsd', path, numberAt);
  assignOptional(output, input, 'clients', path, numberMap);
  return output;
}

function projectProjectMap(value, path) {
  const input = objectAt(value, path);
  const output = {};
  for (const [key, entry] of Object.entries(input)) {
    safeDynamicKey(key, path);
    output[key] = projectProject(entry, `${path}.*`);
  }
  return output;
}

function projectPeriod(value, path) {
  const input = objectAt(value, path);
  const output = {};
  for (const field of PERIOD_NUMBER_FIELDS) assignOptional(output, input, field, path, numberAt);
  for (const field of PERIOD_NUMBER_MAP_FIELDS) assignOptional(output, input, field, path, numberMap);
  for (const field of PERIOD_NESTED_NUMBER_MAP_FIELDS) assignOptional(output, input, field, path, nestedNumberMap);
  assignOptional(output, input, 'projects', path, projectProjectMap);
  assignOptional(output, input, 'sessions', path, projectSessionMap);
  if (Object.hasOwn(input, 'capabilities')) {
    if (input.capabilities === null) {
      output.capabilities = null;
      return output;
    }
    const capabilities = objectAt(input.capabilities, `${path}.capabilities`);
    const projected = {};
    assignOptional(projected, capabilities, 'tokenComponents', `${path}.capabilities`, booleanAt);
    assignOptional(projected, capabilities, 'throughput', `${path}.capabilities`, booleanAt);
    output.capabilities = projected;
  }
  return output;
}

function projectPeriods(value, path) {
  const input = objectAt(value, path);
  const output = {};
  for (const periodName of PERIOD_NAMES) {
    if (!Object.hasOwn(input, periodName)) invalid(`${path}.${periodName}`, '必須項目がありません');
    output[periodName] = projectPeriod(input[periodName], `${path}.${periodName}`);
  }
  return output;
}

function calendarKey(value, path, kind) {
  const text = stringAt(value, path);
  const match = (kind === 'today' ? /^(\d{4})-(\d{2})-(\d{2})$/u : /^(\d{4})-(\d{2})$/u).exec(text);
  if (!match) invalid(path, 'カレンダーキーの形式が不正です');
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) invalid(path, '存在しないカレンダーキーです');
  if (kind === 'today') {
    const day = Number(match[3]);
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(0, 0, 0, 0);
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
      invalid(path, '存在しないカレンダーキーです');
    }
  }
  return text;
}

function projectPeriodWindows(value, path) {
  if (value === null) return null;
  const input = objectAt(value, path);
  const output = {};
  for (const periodName of ['today', 'month']) {
    if (!Object.hasOwn(input, periodName)) continue;
    const windowPath = `${path}.${periodName}`;
    if (input[periodName] === null) {
      output[periodName] = null;
      continue;
    }
    const window = objectAt(input[periodName], windowPath);
    const projected = {};
    assignOptional(projected, window, 'key', windowPath, (entry, entryPath) => calendarKey(entry, entryPath, periodName));
    assignOptional(projected, window, 'endsAt', windowPath, timestampAt);
    output[periodName] = projected;
  }
  if (Object.hasOwn(input, 'timeZone')) {
    if (input.timeZone === null) {
      output.timeZone = null;
      return output;
    }
    const timeZone = stringAt(input.timeZone, `${path}.timeZone`);
    try {
      new Intl.DateTimeFormat('en', { timeZone }).format(0);
    } catch {
      invalid(`${path}.timeZone`, 'IANAタイムゾーンではありません');
    }
    output.timeZone = timeZone;
  }
  return output;
}

function projectClientStatus(value, path) {
  const input = objectAt(value, path);
  const output = {};
  for (const [key, entry] of Object.entries(input)) {
    safeDynamicKey(key, path);
    output[key] = stringAt(entry, `${path}.*`, { nullable: true });
  }
  return output;
}

function projectClientHealth(value, path) {
  const input = objectAt(value, path);
  const output = {};
  assignOptional(output, input, 'version', path, (entry, entryPath) => numberAt(entry, entryPath, { integer: true }));
  assignOptional(output, input, 'observedAt', path, (entry, entryPath) => timestampAt(entry, entryPath, { nullable: true }));
  if (!Object.hasOwn(input, 'clients')) return output;
  if (input.clients === null) {
    output.clients = null;
    return output;
  }

  const clients = objectAt(input.clients, `${path}.clients`);
  const projectedClients = {};
  for (const [clientId, rawClient] of Object.entries(clients)) {
    safeDynamicKey(clientId, `${path}.clients`);
    const clientPath = `${path}.clients.*`;
    const client = objectAt(rawClient, clientPath);
    const projected = {};
    assignOptional(projected, client, 'overall', clientPath, stringAt);
    for (const blockName of ['source', 'collection', 'data']) {
      if (!Object.hasOwn(client, blockName)) continue;
      const blockPath = `${clientPath}.${blockName}`;
      if (client[blockName] === null) {
        projected[blockName] = null;
        continue;
      }
      const block = objectAt(client[blockName], blockPath);
      const projectedBlock = {};
      for (const field of ['state', 'syncFailureStage', 'syncDetailCode', 'lastActivityDay']) {
        assignOptional(projectedBlock, block, field, blockPath, stringAt);
      }
      for (const field of ['lastAttemptAt', 'lastSuccessAt']) {
        assignOptional(projectedBlock, block, field, blockPath, (entry, entryPath) => timestampAt(entry, entryPath, { nullable: true }));
      }
      for (const field of ['detectedCount', 'checkedCount', 'liveTokens', 'syncExitCode']) {
        assignOptional(projectedBlock, block, field, blockPath, (entry, entryPath) => numberAt(entry, entryPath, { integer: true }));
      }
      if (Object.hasOwn(block, 'checks')) {
        projectedBlock.checks = block.checks === null
          ? null
          : arrayAt(block.checks, `${blockPath}.checks`).map((rawCheck, index) => {
            const checkPath = `${blockPath}.checks[${index}]`;
            const check = objectAt(rawCheck, checkPath);
            const result = {};
            assignOptional(result, check, 'id', checkPath, stringAt);
            assignOptional(result, check, 'exists', checkPath, booleanAt);
            return result;
          });
      }
      projected[blockName] = projectedBlock;
    }
    if (Object.hasOwn(client, 'diagnostics')) {
      projected.diagnostics = client.diagnostics === null
        ? null
        : arrayAt(client.diagnostics, `${clientPath}.diagnostics`).map((rawDiagnostic, index) => {
          const diagnosticPath = `${clientPath}.diagnostics[${index}]`;
          const diagnostic = objectAt(rawDiagnostic, diagnosticPath);
          const result = {};
          assignOptional(result, diagnostic, 'code', diagnosticPath, stringAt);
          return result;
        });
    }
    projectedClients[clientId] = projected;
  }
  output.clients = projectedClients;
  return output;
}

function projectWslStatus(value, path) {
  const input = objectAt(value, path);
  const output = {};
  assignOptional(output, input, 'state', path, stringAt);
  assignOptional(output, input, 'detected', path, stringArray);
  assignOptional(output, input, 'withData', path, stringArray);
  return output;
}

function projectWindow(value, path) {
  const input = objectAt(value, path);
  const output = {};
  for (const field of WINDOW_STRING_FIELDS) {
    assignOptional(output, input, field, path, (entry, entryPath) => stringAt(entry, entryPath, { nullable: field === 'currency' }));
  }
  for (const field of WINDOW_NUMBER_FIELDS) {
    const options = field.endsWith('Percent')
      ? { nullable: true, min: 0, max: 100 }
      : { nullable: true };
    assignOptional(output, input, field, path, (entry, entryPath) => numberAt(entry, entryPath, options));
  }
  assignOptional(output, input, 'resetsAt', path, (entry, entryPath) => timestampAt(entry, entryPath, { nullable: true }));
  assignOptional(output, input, 'additional', path, booleanAt);
  assignOptional(output, input, 'showMeter', path, booleanAt);
  return output;
}

function projectBalance(value, path) {
  if (value === null) return null;
  const input = objectAt(value, path);
  const output = {};
  for (const field of BALANCE_NUMBER_FIELDS) {
    assignOptional(output, input, field, path, (entry, entryPath) => numberAt(entry, entryPath, { nullable: true }));
  }
  for (const field of BALANCE_STRING_FIELDS) {
    assignOptional(output, input, field, path, (entry, entryPath) => stringAt(entry, entryPath, { nullable: true }));
  }
  for (const field of ['expiresAt', 'trackingSince']) {
    assignOptional(output, input, field, path, (entry, entryPath) => timestampAt(entry, entryPath, { nullable: true }));
  }
  assignOptional(output, input, 'monthSinceTracking', path, booleanAt);
  if (Object.hasOwn(input, 'tranches')) {
    output.tranches = input.tranches === null
      ? null
      : arrayAt(input.tranches, `${path}.tranches`).map((rawTranche, index) => {
        const tranchePath = `${path}.tranches[${index}]`;
        const tranche = objectAt(rawTranche, tranchePath);
        const result = {};
        assignOptional(result, tranche, 'amount', tranchePath, (entry, entryPath) => numberAt(entry, entryPath, { nullable: true }));
        assignOptional(result, tranche, 'currency', tranchePath, (entry, entryPath) => stringAt(entry, entryPath, { nullable: true }));
        assignOptional(result, tranche, 'expiresAt', tranchePath, (entry, entryPath) => timestampAt(entry, entryPath, { nullable: true }));
        return result;
      });
  }
  return output;
}

function projectUsageSummary(value, path) {
  if (value === null) return null;
  const input = objectAt(value, path);
  const output = {};
  assignOptional(output, input, 'period', path, stringAt);
  for (const field of USAGE_SUMMARY_NUMBER_FIELDS) {
    assignOptional(output, input, field, path, (entry, entryPath) => numberAt(entry, entryPath, { nullable: true }));
  }
  return output;
}

function projectResetCredits(value, path) {
  if (value === null) return null;
  const input = objectAt(value, path);
  const output = {};
  assignOptional(output, input, 'availableCount', path, (entry, entryPath) => numberAt(entry, entryPath, { nullable: true, integer: true }));
  assignOptional(output, input, 'nextExpiresAt', path, (entry, entryPath) => timestampAt(entry, entryPath, { nullable: true }));
  if (Object.hasOwn(input, 'expirations')) {
    output.expirations = input.expirations === null
      ? null
      : arrayAt(input.expirations, `${path}.expirations`).map((entry, index) => (
        timestampAt(entry, `${path}.expirations[${index}]`)
      ));
  }
  return output;
}

function projectProvider(value, path, { aggregate = false } = {}) {
  const input = objectAt(value, path);
  const output = {};
  for (const field of PROVIDER_STRING_FIELDS) {
    if (field === 'sourceDeviceId' && !aggregate) continue;
    assignOptional(output, input, field, path, stringAt);
  }
  assignOptional(output, input, 'updatedAt', path, (entry, entryPath) => timestampAt(entry, entryPath, { nullable: true }));
  assignOptional(output, input, 'balanceUsd', path, (entry, entryPath) => numberAt(entry, entryPath, { nullable: true }));
  assignOptional(output, input, 'stale', path, booleanAt);
  assignOptional(output, input, 'accountKeyAliases', path, stringArray);
  if (Object.hasOwn(input, 'windows')) {
    output.windows = input.windows === null
      ? null
      : arrayAt(input.windows, `${path}.windows`).map((entry, index) => (
        projectWindow(entry, `${path}.windows[${index}]`)
      ));
  }
  assignOptional(output, input, 'balance', path, projectBalance);
  assignOptional(output, input, 'usageSummary', path, projectUsageSummary);
  assignOptional(output, input, 'resetCredits', path, projectResetCredits);
  return output;
}

function projectLimits(value, path, { aggregate = false, includeSummaryMetadata = true, nullable = false } = {}) {
  if (value === null && nullable) return null;
  const input = objectAt(value, path);
  const output = {};
  if (includeSummaryMetadata) {
    assignOptional(output, input, 'updatedAt', path, (entry, entryPath) => timestampAt(entry, entryPath, { nullable: true }));
    assignOptional(output, input, 'refreshMs', path, (entry, entryPath) => numberAt(entry, entryPath, { nullable: true }));
  }
  if (!Object.hasOwn(input, 'providers')) invalid(`${path}.providers`, '必須項目がありません');
  output.providers = input.providers === null
    ? null
    : arrayAt(input.providers, `${path}.providers`).map((entry, index) => (
      projectProvider(entry, `${path}.providers[${index}]`, { aggregate })
    ));
  return output;
}

function projectMetadata(device, path) {
  const output = {};
  for (const field of DEVICE_STRING_METADATA_FIELDS) assignOptional(output, device, field, path, stringAt);
  assignOptional(output, device, 'receivedAt', path, (entry, entryPath) => timestampAt(entry, entryPath, { nullable: true }));
  assignOptional(output, device, 'ageMs', path, (entry, entryPath) => numberAt(entry, entryPath, { nullable: true, min: -Infinity }));
  assignOptional(output, device, 'stale', path, (entry, entryPath) => booleanAt(entry, entryPath, { nullable: true }));
  assignOptional(output, device, 'trackedClients', path, stringArray);
  assignOptional(output, device, 'projectsEnabled', path, booleanAt);
  assignOptional(output, device, 'allTimeProjectsOmitted', path, booleanAt);
  assignOptional(output, device, 'allTimeProjectsIncomplete', path, booleanAt);
  assignOptional(output, device, 'syncUploadIntervalMs', path, (entry, entryPath) => numberAt(entry, entryPath, { nullable: true }));
  return output;
}

function projectObservation(device, path) {
  const observation = {};
  if (!Object.hasOwn(device, 'updatedAt')) invalid(`${path}.updatedAt`, '必須項目がありません');
  observation.updatedAt = timestampAt(device.updatedAt, `${path}.updatedAt`, { nullable: true });
  if (!Object.hasOwn(device, 'periods')) invalid(`${path}.periods`, '必須項目がありません');
  observation.periods = projectPeriods(device.periods, `${path}.periods`);
  if (Object.hasOwn(device, 'periodWindows')) {
    observation.periodWindows = projectPeriodWindows(device.periodWindows, `${path}.periodWindows`);
  }
  assignOptional(observation, device, 'clientStatus', path, projectClientStatus);
  assignOptional(observation, device, 'clientHealth', path, projectClientHealth);
  assignOptional(observation, device, 'wslStatus', path, projectWslStatus);
  if (!Object.hasOwn(device, 'limits')) invalid(`${path}.limits`, '必須項目がありません');
  observation.limits = projectLimits(device.limits, `${path}.limits`, { includeSummaryMetadata: false });
  return observation;
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value
      .map(canonicalize)
      .sort((left, right) => {
        const leftJson = JSON.stringify(left);
        const rightJson = JSON.stringify(right);
        return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
      });
  }
  if (!isObject(value)) return value;
  const output = {};
  for (const key of Object.keys(value).sort()) output[key] = canonicalize(value[key]);
  return output;
}

function comparisonJson(observation) {
  return JSON.stringify(canonicalize(observation));
}

function projectHubCurrent(stats) {
  const output = {};
  assignOptional(output, stats, 'updatedAt', 'stats', (entry, entryPath) => timestampAt(entry, entryPath, { nullable: true }));
  if (!Object.hasOwn(stats, 'periods')) invalid('stats.periods', '必須項目がありません');
  output.periods = projectPeriods(stats.periods, 'stats.periods');
  if (!Object.hasOwn(stats, 'limits')) invalid('stats.limits', '必須項目がありません');
  output.limits = projectLimits(stats.limits, 'stats.limits', { aggregate: true, nullable: true });
  assignOptional(output, stats, 'projectsIncomplete', 'stats', booleanAt);
  assignOptional(output, stats, 'staleAfterMs', 'stats', (entry, entryPath) => numberAt(entry, entryPath, { nullable: true }));
  return output;
}

export function normalizeNotification(payload) {
  const event = objectAt(payload, 'notification');
  if (!Object.hasOwn(event, 'type')) invalid('type', '必須項目がありません');
  if (stringAt(event.type, 'type') !== 'stats') invalid('type', 'stats通知ではありません');
  if (!Object.hasOwn(event, 'reason')) invalid('reason', '必須項目がありません');
  stringAt(event.reason, 'reason');
  if (!Object.hasOwn(event, 'at')) invalid('at', '必須項目がありません');
  timestampAt(event.at, 'at');
  if (!Object.hasOwn(event, 'stats')) invalid('stats', '必須項目がありません');
  const stats = objectAt(event.stats, 'stats');
  if (!Object.hasOwn(stats, 'devices')) invalid('stats.devices', '必須項目がありません');

  const seenDeviceIds = new Set();
  const devices = arrayAt(stats.devices, 'stats.devices').map((rawDevice, index) => {
    const path = `stats.devices[${index}]`;
    const device = objectAt(rawDevice, path);
    if (!Object.hasOwn(device, 'deviceId')) invalid(`${path}.deviceId`, '必須項目がありません');
    const deviceId = stringAt(device.deviceId, `${path}.deviceId`, { nonEmpty: true });
    if (seenDeviceIds.has(deviceId)) invalid(`${path}.deviceId`, '通知内で重複しています');
    seenDeviceIds.add(deviceId);
    const observation = projectObservation(device, path);
    return {
      deviceId,
      observation,
      comparisonJson: comparisonJson(observation),
      metadata: projectMetadata(device, path)
    };
  });
  devices.sort((left, right) => left.deviceId.localeCompare(right.deviceId));

  return {
    hubCurrent: projectHubCurrent(stats),
    devices
  };
}
