export const HISTORY_PAGE_LIMIT = 100;

function periodField(kind) {
  if (kind === 'daily') return 'date';
  if (kind === 'monthly') return 'month';
  throw new TypeError('履歴種別が不正です');
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function difference(left, right) {
  const from = finiteNumber(left);
  const to = finiteNumber(right);
  return from === null || to === null ? null : to - from;
}

export function monthlyCompletion(month, todayKey) {
  const validMonth = /^\d{4}-(0[1-9]|1[0-2])$/;
  const validDate = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
  if (!validMonth.test(month ?? '') || !validDate.test(todayKey ?? '')) {
    return 'unknown';
  }
  return month >= todayKey.slice(0, 7) ? 'partial' : 'final';
}

export function historyPeriods(items, kind) {
  const field = periodField(kind);
  return [...new Set((Array.isArray(items) ? items : [])
    .map((item) => item?.[field])
    .filter((value) => typeof value === 'string' && value.length))]
    .sort((left, right) => right.localeCompare(left));
}

export function compareHistoryItems(items, { kind, leftPeriod, rightPeriod }) {
  const field = periodField(kind);
  const groups = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const period = item?.[field];
    if (period !== leftPeriod && period !== rightPeriod) continue;
    const identity = [item?.hubId ?? null, item?.deviceId ?? null, item?.tool ?? null];
    const key = JSON.stringify(identity);
    const group = groups.get(key) ?? {
      hubId: identity[0], deviceId: identity[1], tool: identity[2], left: null, right: null,
    };
    if (period === leftPeriod && group.left === null) group.left = item;
    if (period === rightPeriod && group.right === null) group.right = item;
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      tokenDifference: difference(group.left?.tokens, group.right?.tokens),
      costDifference: difference(group.left?.cost, group.right?.cost),
    }))
    .sort((left, right) => [left.hubId, left.deviceId, left.tool].map(String).join('\u0000')
      .localeCompare([right.hubId, right.deviceId, right.tool].map(String).join('\u0000')));
}

export function historySearch(filters, before = null) {
  const params = new URLSearchParams();
  params.set('kind', filters.kind);
  for (const name of ['hubId', 'deviceId', 'tool', 'from', 'to']) {
    const value = filters[name];
    if (typeof value === 'string' && value.length) params.set(name, value);
  }
  params.set('limit', String(HISTORY_PAGE_LIMIT));
  if (before !== null && before !== undefined) params.set('before', String(before));
  return params;
}

export async function readAllHistoryPages(fetchPage) {
  const items = [];
  const cursors = new Set();
  let before = null;
  let kind = null;
  let pageCount = 0;

  while (true) {
    const page = await fetchPage(before);
    pageCount += 1;
    if (!page || !Array.isArray(page.items)) throw new Error('履歴の応答が不正です。');
    if (kind === null) kind = page.kind;
    else if (page.kind !== kind) throw new Error('履歴ページの種別が一致しません。');
    items.push(...page.items);
    if (page.nextCursor === null || page.nextCursor === undefined) return { kind, items, pageCount };
    const cursorKey = String(page.nextCursor);
    if (cursors.has(cursorKey)) throw new Error('履歴ページのカーソルが重複しました。');
    cursors.add(cursorKey);
    before = page.nextCursor;
  }
}
