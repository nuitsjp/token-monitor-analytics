import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compareHistoryItems,
  historySearch,
  monthlyCompletion,
  readAllHistoryPages,
} from '../public/history.js';

test('history comparison keeps hub, device, and tool separate and never fills a missing side with zero', () => {
  const rows = compareHistoryItems([
    { hubId: 'home', deviceId: 'pc-a', date: '2026-09-12', tool: 'codex', tokens: 10, cost: 1 },
    { hubId: 'home', deviceId: 'pc-a', date: '2026-09-13', tool: 'codex', tokens: 15, cost: 1.75 },
    { hubId: 'home', deviceId: 'pc-b', date: '2026-09-12', tool: 'codex', tokens: 20, cost: 2 },
    { hubId: 'work', deviceId: 'pc-a', date: '2026-09-13', tool: 'codex', tokens: 7, cost: 0 },
    { hubId: 'home', deviceId: 'pc-a', date: '2026-09-13', tool: 'claude', tokens: 3, cost: 0.2 },
    { hubId: 'home', deviceId: 'pc-d', date: '2026-09-12', tool: 'codex', tokens: 0, cost: 0 },
    { hubId: 'home', deviceId: 'pc-d', date: '2026-09-13', tool: 'codex', tokens: 2, cost: 0.25 },
  ], { kind: 'daily', leftPeriod: '2026-09-12', rightPeriod: '2026-09-13' });

  assert.equal(rows.length, 5);
  assert.deepEqual(rows.find((row) => row.hubId === 'home' && row.deviceId === 'pc-a' && row.tool === 'codex'), {
    hubId: 'home', deviceId: 'pc-a', tool: 'codex',
    left: { hubId: 'home', deviceId: 'pc-a', date: '2026-09-12', tool: 'codex', tokens: 10, cost: 1 },
    right: { hubId: 'home', deviceId: 'pc-a', date: '2026-09-13', tool: 'codex', tokens: 15, cost: 1.75 },
    tokenDifference: 5, costDifference: 0.75,
  });
  const missingRight = rows.find((row) => row.deviceId === 'pc-b');
  assert.equal(missingRight.right, null);
  assert.equal(missingRight.tokenDifference, null);
  assert.equal(missingRight.costDifference, null);
  const missingLeftWithRealZero = rows.find((row) => row.hubId === 'work');
  assert.equal(missingLeftWithRealZero.left, null);
  assert.equal(missingLeftWithRealZero.right.cost, 0);
  assert.equal(missingLeftWithRealZero.costDifference, null);
  const comparedFromZero = rows.find((row) => row.deviceId === 'pc-d');
  assert.equal(comparedFromZero.tokenDifference, 2);
  assert.equal(comparedFromZero.costDifference, 0.25);
});

test('all history pages are read before comparison even when one date spans page boundaries', async () => {
  const requestedCursors = [];
  const pages = new Map([
    ['first', { kind: 'daily', items: [
      { hubId: 'home', deviceId: 'pc-a', date: '2026-09-13', tool: 'codex', tokens: 20, cost: 2 },
      { hubId: 'home', deviceId: 'pc-b', date: '2026-09-13', tool: 'codex', tokens: 30, cost: 3 },
    ], nextCursor: 'opaque:same-day:2' }],
    ['opaque:same-day:2', { kind: 'daily', items: [
      { hubId: 'home', deviceId: 'pc-c', date: '2026-09-13', tool: 'codex', tokens: 40, cost: 4 },
      { hubId: 'home', deviceId: 'pc-a', date: '2026-09-12', tool: 'codex', tokens: 10, cost: 1 },
    ], nextCursor: null }],
  ]);

  const result = await readAllHistoryPages(async (before) => {
    requestedCursors.push(before);
    return pages.get(before ?? 'first');
  });
  assert.deepEqual(requestedCursors, [null, 'opaque:same-day:2']);
  assert.equal(result.pageCount, 2);
  assert.equal(result.items.length, 4);
  const compared = compareHistoryItems(result.items, {
    kind: 'daily', leftPeriod: '2026-09-12', rightPeriod: '2026-09-13',
  });
  assert.equal(compared.length, 3);
  assert.equal(compared.find((row) => row.deviceId === 'pc-a').tokenDifference, 10);
  assert.equal(compared.find((row) => row.deviceId === 'pc-c').tokenDifference, null);
});

test('history paging rejects a repeated opaque cursor instead of treating unread pages as complete', async () => {
  await assert.rejects(
    readAllHistoryPages(async () => ({ kind: 'monthly', items: [], nextCursor: 'repeat' })),
    /カーソルが重複/,
  );
});

test('monthly completion uses the fetched device today key without converting time zones', () => {
  assert.equal(monthlyCompletion('2026-08', '2026-09-01'), 'final');
  assert.equal(monthlyCompletion('2026-09', '2026-09-01'), 'partial');
  assert.equal(monthlyCompletion('2026-10', '2026-09-30'), 'partial');
  assert.equal(monthlyCompletion('2026-08', null), 'unknown');
  assert.equal(monthlyCompletion('2026-08', 'invalid'), 'unknown');
  assert.equal(monthlyCompletion('2026-13', '2026-09-01'), 'unknown');
});

test('history query forwards filters and an opaque cursor without changing period strings', () => {
  const params = historySearch({
    kind: 'monthly', hubId: 'work hub', deviceId: 'pc/1', tool: 'codex', from: '2026-01', to: '2026-09',
  }, 'opaque:+/cursor');
  assert.deepEqual(Object.fromEntries(params), {
    kind: 'monthly', hubId: 'work hub', deviceId: 'pc/1', tool: 'codex',
    from: '2026-01', to: '2026-09', limit: '100', before: 'opaque:+/cursor',
  });
});
