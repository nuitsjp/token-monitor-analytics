// U6: 日次・月次利用実績の取得・判定の純粋関数。
// 端末現地日付・数値はそのまま保持し、タイムゾーン変換や按分は行わない
// （機能仕様 第3節）。当日分除外の判定に他タイムゾーンでの代用はしない。
//
// GET /api/devices の端末別 history (daily/monthly) を主経路とする
// （連携仕様 第5節。/api/history の端末合算は補完に使わない）。

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_PATTERN = /^\d{4}-\d{2}$/;
const finiteNumber = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export class HistoryValidationError extends Error {}

function validCalendarDate(text) {
  if (typeof text !== 'string' || !DATE_PATTERN.test(text)) return null;
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(5, 7));
  const day = Number(text.slice(8, 10));
  if (month < 1 || month > 12) return null;
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  probe.setUTCHours(0, 0, 0, 0);
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return text;
}

function validCalendarMonth(text) {
  if (typeof text !== 'string' || !MONTH_PATTERN.test(text)) return null;
  const month = Number(text.slice(5, 7));
  if (month < 1 || month > 12) return null;
  return text;
}

// periodWindows.today.key を端末現地の「今日」とする。欠落・不正時は
// 当日分を安全に除外できないため日次保存を見送る（unknown_today）。
// タイムゾーン名が不正な場合も同じ扱いとする。名前が未提供でも
// 有効な今日キーがあれば、その端末日付を使い他ゾーンで代用しない。
export function deviceTodayKey(periodWindows) {
  const key = periodWindows?.today?.key;
  if (typeof key !== 'string') return { todayKey: null, reason: 'unknown_today' };
  const valid = validCalendarDate(key);
  if (!valid) return { todayKey: null, reason: 'unknown_today' };
  const timeZone = periodWindows?.timeZone;
  if (timeZone !== undefined && timeZone !== null) {
    if (typeof timeZone !== 'string') return { todayKey: null, reason: 'unknown_today' };
    try {
      new Intl.DateTimeFormat('en', { timeZone }).format(0);
    } catch {
      return { todayKey: null, reason: 'unknown_today' };
    }
  }
  return { todayKey: valid, reason: null };
}

function toolRowsOf(entry) {
  const perClient = entry?.perClient;
  if (!perClient || typeof perClient !== 'object' || Array.isArray(perClient)) return [];
  const rows = [];
  for (const [tool, value] of Object.entries(perClient)) {
    if (!tool.trim()) continue;
    if (tool === '__proto__' || tool === 'prototype' || tool === 'constructor') continue;
    if (!value || typeof value !== 'object') continue;
    const tokens = finiteNumber(value.tokens);
    const cost = finiteNumber(value.cost);
    if (tokens === null || cost === null || tokens < 0 || cost < 0) continue;
    rows.push({ tool, tokens, cost });
  }
  rows.sort((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0));
  return rows;
}

// 日次: 前日以前の確定分だけ保存。当日分は除外する。
// periodWindows が得られない端末は全件見送り、理由を返す。
export function selectDailyRecords(history, periodWindows) {
  const { todayKey, reason } = deviceTodayKey(periodWindows);
  if (!todayKey) return { records: [], skipped: 'unknown_today', reason };
  const daily = Array.isArray(history?.daily) ? history.daily : [];
  const records = [];
  for (const entry of daily) {
    if (!entry || typeof entry !== 'object') continue;
    const date = validCalendarDate(entry.date);
    if (!date) continue;
    if (date >= todayKey) continue;
    for (const row of toolRowsOf(entry)) {
      records.push({ date, tool: row.tool, tokens: row.tokens, cost: row.cost, entry });
    }
  }
  records.sort((a, b) =>
    a.date.localeCompare(b.date) || a.tool.localeCompare(b.tool),
  );
  return { records, skipped: null, reason: null, todayKey };
}

// 月次: 返却された各月を保存する。当月分の途中集計の明示は
// 読み出し側が periodWindows.today.key の月部と照合して行う。
export function selectMonthlyRecords(history) {
  const monthly = Array.isArray(history?.monthly) ? history.monthly : [];
  const records = [];
  for (const entry of monthly) {
    if (!entry || typeof entry !== 'object') continue;
    const month = validCalendarMonth(entry.month);
    if (!month) continue;
    for (const row of toolRowsOf(entry)) {
      records.push({ month, tool: row.tool, tokens: row.tokens, cost: row.cost, entry });
    }
  }
  records.sort((a, b) =>
    a.month.localeCompare(b.month) || a.tool.localeCompare(b.tool),
  );
  return { records };
}

export function validateDevicesPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new HistoryValidationError('devices payload must be an object');
  }
  const devices = payload.devices;
  if (!Array.isArray(devices)) throw new HistoryValidationError('devices must be an array');
  for (const device of devices) {
    if (!device || typeof device !== 'object' || Array.isArray(device)) throw new HistoryValidationError('device must be an object');
    if (typeof device.deviceId !== 'string' || device.deviceId.length === 0) {
      throw new HistoryValidationError('deviceId must be a non-empty string');
    }
    if (device.history != null) {
      if (typeof device.history !== 'object' || Array.isArray(device.history)) throw new HistoryValidationError('history must be an object');
      for (const kind of ['daily', 'monthly']) {
        if (device.history[kind] !== undefined && !Array.isArray(device.history[kind])) {
          throw new HistoryValidationError('history records must be arrays');
        }
      }
    }
  }
  return devices;
}

export function selectHistoryPayload(payload, fetchedAt) {
  const result = { daily: [], monthly: [], devices: [] };
  for (const device of validateDevicesPayload(payload)) {
    const { todayKey } = deviceTodayKey(device.periodWindows);
    const timeZone = todayKey ? device.periodWindows.timeZone ?? null : null;
    const daily = selectDailyRecords(device.history, device.periodWindows).records;
    let yesterday = null;
    if (todayKey) {
      const date = new Date(todayKey + 'T00:00:00.000Z');
      date.setUTCDate(date.getUTCDate() - 1);
      yesterday = date.toISOString().slice(0, 10);
    }
    const metadata = { deviceId: device.deviceId, todayKey, timeZone, fetchedAt };
    result.daily.push(...daily.map(({ entry, ...row }) => ({ ...row, ...metadata })));
    result.monthly.push(...selectMonthlyRecords(device.history).records.map(({ entry, ...row }) => ({ ...row, ...metadata })));
    result.devices.push({
      deviceId: device.deviceId, todayKey, timeZone,
      dailyStatus: !todayKey ? 'unknown_today' : daily.some((row) => row.date === yesterday) ? 'available' : 'no_previous_day',
    });
  }
  return result;
}
