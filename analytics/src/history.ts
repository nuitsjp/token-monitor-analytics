// Device history is an upstream snapshot, rather than an event stream.  Keep
// this module pure so the HTTP boundary and the SQLite writer can share exactly
// the same validation without importing either runtime.

export type HistoryGranularity = 'daily' | 'monthly';
export type HistoryState = 'available' | 'disabled' | 'unavailable' | 'missing' | 'missing_capability';

export interface HistoryAttribution {
  tokens: number | null;
  costUsd: number | null;
  messages: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  unclassifiedTokens: number | null;
  tokenComponentsAvailable: boolean | null;
}

export interface HistoryRow {
  granularity: HistoryGranularity;
  periodKey: string;
  tokens: number | null;
  costUsd: number | null;
  messages: number | null;
  activeTimeMs: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  unclassifiedTokens: number | null;
  tokenComponentsAvailable: boolean | null;
  perClient: Record<string, HistoryAttribution>;
  perModel: Record<string, HistoryAttribution>;
}

export interface HistoryWindows {
  timeZone: string | null;
  todayKey: string | null;
  todayEndsAt: string | null;
  monthKey: string | null;
  monthEndsAt: string | null;
}

export interface NormalizedHistoryDevice {
  deviceId: string;
  present: boolean;
  historyAvailable: boolean | null;
  historyState: HistoryState;
  rows: HistoryRow[];
  timeZone: string | null;
  windows: HistoryWindows;
  upstreamUpdatedAt: string | null;
}

export interface NormalizedHistoryResponse {
  devices: NormalizedHistoryDevice[];
}

export class HistoryInputError extends Error {
  readonly code = 'history_input_error';
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = 'HistoryInputError';
  }
}

const MAX_DEVICES = 256;
const MAX_ROWS = 4096;
const MAX_MAP_ENTRIES = 256;
const MAX_KEY_LENGTH = 256;
const MAX_NUMBER = Number.MAX_SAFE_INTEGER;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const has = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function stringValue(value: unknown, label: string, max = MAX_KEY_LENGTH): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new HistoryInputError(`invalid ${label}`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_NUMBER) {
    throw new HistoryInputError(`invalid ${label}`);
  }
  return value;
}

function optionalBoolean(value: unknown, label: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') throw new HistoryInputError(`invalid ${label}`);
  return value;
}

function isoDate(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  const string = stringValue(value, label, 64);
  if (!Number.isFinite(Date.parse(string))) throw new HistoryInputError(`invalid ${label}`);
  return new Date(Date.parse(string)).toISOString();
}

function dailyKey(value: unknown): string {
  const key = stringValue(value, 'daily period key', 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new HistoryInputError('invalid daily period key');
  const parsed = new Date(`${key}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== key) {
    throw new HistoryInputError('invalid daily period key');
  }
  return key;
}

function monthlyKey(value: unknown): string {
  const key = stringValue(value, 'monthly period key', 7);
  if (!/^\d{4}-\d{2}$/.test(key)) throw new HistoryInputError('invalid monthly period key');
  const parsed = new Date(`${key}-01T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 7) !== key) {
    throw new HistoryInputError('invalid monthly period key');
  }
  return key;
}

function componentFields(value: Record<string, unknown>, tokens: number | null, label: string) {
  const cacheReadTokens = nonNegativeNumber(value.cacheReadTokens, `${label}.cacheReadTokens`);
  const cacheWriteTokens = nonNegativeNumber(value.cacheWriteTokens, `${label}.cacheWriteTokens`);
  const outputTokens = nonNegativeNumber(value.outputTokens, `${label}.outputTokens`);
  const unclassifiedTokens = nonNegativeNumber(value.unclassifiedTokens, `${label}.unclassifiedTokens`);
  if (tokens !== null) {
    const known = (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0) + (outputTokens ?? 0) + (unclassifiedTokens ?? 0);
    if (known > tokens) throw new HistoryInputError(`component totals exceed ${label}.tokens`);
  }
  return {
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    unclassifiedTokens,
    tokenComponentsAvailable: optionalBoolean(value.tokenComponentsAvailable, `${label}.tokenComponentsAvailable`),
  };
}

function attribution(value: unknown, label: string, includeMessages: boolean): HistoryAttribution {
  if (!isObject(value)) throw new HistoryInputError(`invalid ${label}`);
  const tokens = nonNegativeNumber(value.tokens, `${label}.tokens`);
  const costUsd = nonNegativeNumber(value.cost, `${label}.cost`);
  const components = componentFields(value, tokens, label);
  return {
    tokens,
    costUsd,
    messages: includeMessages ? nonNegativeNumber(value.messages, `${label}.messages`) : null,
    ...components,
  };
}

function attributionMap(value: unknown, label: string, includeMessages: boolean): Record<string, HistoryAttribution> {
  if (value === undefined || value === null) return {};
  if (!isObject(value) || Object.keys(value).length > MAX_MAP_ENTRIES) throw new HistoryInputError(`invalid ${label}`);
  const output: Record<string, HistoryAttribution> = Object.create(null) as Record<string, HistoryAttribution>;
  for (const [key, entry] of Object.entries(value)) {
    if (!key || key.length > MAX_KEY_LENGTH) throw new HistoryInputError(`invalid ${label} key`);
    Object.defineProperty(output, key, {value: attribution(entry, `${label}.${key}`, includeMessages), enumerable: true, writable: true, configurable: true});
  }
  return output;
}

function historyRow(value: unknown, granularity: HistoryGranularity, index: number): HistoryRow {
  if (!isObject(value)) throw new HistoryInputError(`invalid ${granularity} history row ${index}`);
  const key = granularity === 'daily'
    ? dailyKey(value.date)
    : monthlyKey(value.month);
  const tokens = nonNegativeNumber(value.tokens, `${granularity} tokens`);
  const components = componentFields(value, tokens, `${granularity} row`);
  return {
    granularity,
    periodKey: key,
    tokens,
    costUsd: nonNegativeNumber(value.cost, `${granularity} cost`),
    messages: nonNegativeNumber(value.messages, `${granularity} messages`),
    activeTimeMs: nonNegativeNumber(value.activeTimeMs, `${granularity} activeTimeMs`),
    ...components,
    perClient: attributionMap(value.perClient, `${granularity} perClient`, true),
    perModel: attributionMap(value.perModel, `${granularity} perModel`, false),
  };
}

function historyRows(value: unknown, granularity: HistoryGranularity): HistoryRow[] {
  if (!Array.isArray(value) || value.length > MAX_ROWS) throw new HistoryInputError(`invalid ${granularity} history`);
  const rows: HistoryRow[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const row = historyRow(value[index], granularity, index);
    if (seen.has(row.periodKey)) throw new HistoryInputError(`duplicate ${granularity} period key`);
    seen.add(row.periodKey);
    rows.push(row);
  }
  rows.sort((left, right) => left.periodKey.localeCompare(right.periodKey));
  return rows;
}

function periodWindows(value: unknown): HistoryWindows {
  if (value === undefined || value === null) {
    return {timeZone: null, todayKey: null, todayEndsAt: null, monthKey: null, monthEndsAt: null};
  }
  if (!isObject(value)) throw new HistoryInputError('invalid periodWindows');
  let timeZone: string | null = null;
  if (value.timeZone !== undefined && value.timeZone !== null && value.timeZone !== '') {
    timeZone = stringValue(value.timeZone, 'periodWindows.timeZone', 128);
    try { new Intl.DateTimeFormat('en', {timeZone}); } catch { throw new HistoryInputError('invalid periodWindows.timeZone'); }
  }
  const rawToday = value.today;
  const rawMonth = value.month;
  if (rawToday !== undefined && rawToday !== null && !isObject(rawToday)) throw new HistoryInputError('invalid periodWindows.today');
  if (rawMonth !== undefined && rawMonth !== null && !isObject(rawMonth)) throw new HistoryInputError('invalid periodWindows.month');
  const today = rawToday as Record<string, unknown> | undefined;
  const month = rawMonth as Record<string, unknown> | undefined;
  return {
    timeZone,
    todayKey: today?.key === undefined || today.key === null || today.key === '' ? null : dailyKey(today.key),
    todayEndsAt: isoDate(today?.endsAt, 'periodWindows.today.endsAt'),
    monthKey: month?.key === undefined || month.key === null || month.key === '' ? null : monthlyKey(month.key),
    monthEndsAt: isoDate(month?.endsAt, 'periodWindows.month.endsAt'),
  };
}

function device(value: unknown): NormalizedHistoryDevice {
  if (!isObject(value)) throw new HistoryInputError('invalid history device');
  const deviceId = stringValue(value.deviceId, 'history deviceId', MAX_KEY_LENGTH);
  const historyAvailable = optionalBoolean(value.historyAvailable, `${deviceId}.historyAvailable`);
  const windows = periodWindows(value.periodWindows);
  const upstreamUpdatedAt = isoDate(value.updatedAt, `${deviceId}.updatedAt`);
  const hasHistory = has(value, 'history');
  let rows: HistoryRow[] = [];
  let historyState: HistoryState;
  if (hasHistory && value.history !== null) {
    if (!isObject(value.history)) throw new HistoryInputError(`invalid ${deviceId}.history`);
    rows = [
      ...historyRows(value.history.daily, 'daily'),
      ...historyRows(value.history.monthly, 'monthly'),
    ];
  }
  // The explicit capability flag is authoritative even when an older or
  // disabled producer also sends a null/omitted history field.  Keep the
  // wire distinction in historyAvailable so callers can tell this apart
  // from an unavailable retained snapshot.
  if (historyAvailable === false) {
    historyState = 'disabled';
  } else if (!hasHistory) {
    historyState = historyAvailable === true ? 'missing' : 'missing_capability';
  } else if (value.history === null) {
    historyState = 'unavailable';
  } else {
    historyState = historyAvailable === true ? 'available' : 'missing_capability';
  }
  return {
    deviceId,
    present: true,
    historyAvailable,
    historyState,
    rows,
    timeZone: windows.timeZone,
    windows,
    upstreamUpdatedAt,
  };
}

/** Validate and allow-list one complete `/api/devices` response. */
export function normalizeHistoryResponse(input: unknown): NormalizedHistoryResponse {
  if (!isObject(input) || !Array.isArray(input.devices) || input.devices.length > MAX_DEVICES) {
    throw new HistoryInputError('history response must contain a bounded devices array');
  }
  const devices: NormalizedHistoryDevice[] = [];
  const seen = new Set<string>();
  for (const entry of input.devices) {
    const normalized = device(entry);
    if (seen.has(normalized.deviceId)) throw new HistoryInputError('duplicate history deviceId');
    seen.add(normalized.deviceId);
    devices.push(normalized);
  }
  return {devices};
}

export function parseHistoryResponse(text: string): NormalizedHistoryResponse {
  if (typeof text !== 'string') throw new HistoryInputError('history response is not text');
  let input: unknown;
  try { input = JSON.parse(text); } catch { throw new HistoryInputError('invalid history JSON'); }
  return normalizeHistoryResponse(input);
}

/** Pick the most complete invalidation token from a stats SSE payload. */
export function historyRevisionFromStats(input: unknown): string | null {
  if (!isObject(input)) return null;
  const stats = isObject(input.stats) ? input.stats : input;
  const deviceRevision = stats.deviceHistoryRevision;
  if (typeof deviceRevision === 'string' && deviceRevision.length > 0 && deviceRevision.length <= 256) return deviceRevision;
  const historyRevision = stats.historyRevision;
  if (typeof historyRevision === 'string' && historyRevision.length > 0 && historyRevision.length <= 256) return historyRevision;
  return null;
}

export function historyRevisionFromSseData(data: string): string | null {
  try {
    const input: unknown = JSON.parse(data);
    return historyRevisionFromStats(input);
  } catch {
    return null;
  }
}
