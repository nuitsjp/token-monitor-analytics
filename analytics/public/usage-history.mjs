const DAILY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTHLY_PATTERN = /^\d{4}-\d{2}$/;
const FETCH_ERROR_LABELS={
  unsupported:'Hubが履歴APIに未対応',
  auth_error:'Hub認証エラー',
  input_error:'Hub履歴の応答が不正',
  response_too_large:'Hubの応答が大きすぎます',
  network_error:'Hubへ接続できません',
  config_error:'Hub設定エラー',
  storage_error:'履歴の保存に失敗しました',
};

export function historyFetchErrorText(status) {
  if (status?.lastStatus !== 'error') return '';
  return FETCH_ERROR_LABELS[status.lastError] ?? 'Hub履歴の取得に失敗しました';
}

function validDate(value, granularity) {
  if (typeof value !== 'string') return false;
  if (granularity === 'daily') {
    if (!DAILY_PATTERN.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }
  if (!MONTHLY_PATTERN.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  return year >= 1 && year <= 9999 && month >= 1 && month <= 12;
}

function dailyIndex(value) {
  return Math.floor(Date.parse(`${value}T00:00:00.000Z`) / 86400000);
}

function dailyKey(index) {
  return new Date(index * 86400000).toISOString().slice(0, 10);
}

function monthIndex(value) {
  return Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7)) - 1;
}

function monthKey(index) {
  const year = Math.floor(index / 12);
  const month = index % 12 + 1;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

/** Keep the first automatic range within the server's bounded query size. */
export function boundedUsageRange(source, granularity) {
  const fromKey = granularity === 'daily' ? source?.dailyFrom : source?.monthlyFrom;
  const toKey = granularity === 'daily' ? source?.dailyTo : source?.monthlyTo;
  const from = validDate(fromKey, granularity) ? fromKey : '';
  const to = validDate(toKey, granularity) ? toKey : '';
  if (!from || !to) return {from, to};

  if (granularity === 'daily') {
    const start = dailyIndex(from);
    const end = dailyIndex(to);
    if (end >= start && end - start + 1 > 366) return {from: dailyKey(end - 365), to};
  } else {
    const start = monthIndex(from);
    const end = monthIndex(to);
    if (end >= start && end - start + 1 > 120) return {from: monthKey(end - 119), to};
  }
  return {from, to};
}

/** Compare every field that determines the displayed history query. */
export function sameUsageQuery(left, right) {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.hubId === right.hubId
    && left.deviceId === right.deviceId
    && left.granularity === right.granularity
    && left.from === right.from
    && left.to === right.to;
}

/**
 * Serialize displayed-query responses and discard results for an old
 * selection, range, or refresh. The caller supplies the current query so the
 * controller remains independent of the page's DOM.
 */
export function createUsageHistoryController({getQuery, fetchQuery, onApplied = () => {}}) {
  let requestSerial = 0;
  const invalidate = () => { requestSerial += 1; };
  const load = async () => {
    const query = getQuery();
    if (!query) return null;
    const serial = ++requestSerial;
    let result;
    try {
      result = await fetchQuery(query);
    } catch (error) {
      if (serial !== requestSerial || !sameUsageQuery(query, getQuery())) return null;
      throw error;
    }
    if (serial !== requestSerial || !sameUsageQuery(query, getQuery())) return null;
    onApplied(result, query);
    return result;
  };
  return {load, invalidate};
}
