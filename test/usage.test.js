import assert from 'node:assert/strict';
import test from 'node:test';
import { selectUsageSources } from '../src/usage.js';
import { buildMetrics } from '../src/metrics.js';

const at = minute => `2026-09-13T00:${String(minute).padStart(2, '0')}:00.000Z`;
function report(deviceId, { hubId = 'private', tool = 'cursor', accounts = ['account-a'], cost = 10, minute = 0 } = {}) {
  const source = { hubId, deviceId, tool, accounts };
  const period = { costUsd: cost + 2, totalTokens: cost * 100 + 200, clientCosts: { [tool]: cost, other: 2 }, clients: { [tool]: cost * 100, other: 200 } };
  const device = { hubId, deviceId, present: true, metadata: { stale: false }, observation: {
    periods: Object.fromEntries(['today', 'month', 'allTime'].map(name => [name, structuredClone(period)])),
    clientHealth: { observedAt: at(minute), clients: { [tool]: { overall: 'healthy', source: { state: 'detected' }, collection: { state: 'ok', lastSuccessAt: at(minute) } } } },
  } };
  return { source, device };
}
function select(reports) { return selectUsageSources(reports.map(row => row.source), reports.map(row => row.device)); }

test('Cursorは受信時刻でなく実際の収集成功時刻が最新の同一契約報告を一度だけ採用する', () => {
  const a = report('a', { minute: 5, cost: 20 });
  const b = report('b', { minute: 0, cost: 10 });
  b.device.observation.clientHealth.observedAt = at(10);
  const result = select([b, a]);
  assert.deepEqual(result.selected.map(row => row.source.deviceId), ['a']);
  assert.equal(result.selected[0].measuredAt, at(5));
  assert.deepEqual(result.duplicates, [{ hubId: 'private', deviceId: 'b', tool: 'cursor', reason: 'duplicate_usage' }]);
});

test('同額の別契約はまとめず、端末収集のツールは同一契約でも端末別に採用する', () => {
  assert.equal(select([report('a'), report('b', { accounts: ['account-b'] })]).selected.length, 2);
  assert.equal(select([report('a', { tool: 'codex' }), report('b', { tool: 'codex' })]).selected.length, 2);
});

test('アカウント全体の報告で契約集合が部分重複する場合や同時刻の値が競合する場合は加算しない', () => {
  for (const [reports, reason] of [
    [[report('a'), report('b', { accounts: ['account-a', 'account-b'] })], 'overlapping_usage'],
    [[report('a'), report('b', { cost: 20 })], 'conflicting_usage'],
  ]) {
    const result = select(reports);
    assert.equal(result.selected.length, 0);
    assert.deepEqual(result.excluded.map(row => row.reason), [reason, reason]);
  }
});

test('不十分な費用報告は全ツールで除外し、観測されたゼロは採用する', () => {
  for (const tool of ['cursor', 'grok', 'codex', 'unknown-service']) {
    const reports = ['valid', 'stale', 'missing', 'unauthorized', 'clock'].map(id => report(id, { tool, cost: 0 }));
    reports[1].device.metadata.stale = true;
    delete reports[2].device.observation.periods.allTime.clientCosts[tool];
    reports[3].device.observation.clientHealth.clients[tool].overall = 'unauthorized';
    reports[4].device.observation.clientHealth.clients[tool].collection.lastSuccessAt = 'invalid';
    const result = select(reports);
    assert.deepEqual(result.selected.map(row => row.source.deviceId), ['valid']);
    assert.deepEqual(result.excluded.map(row => row.reason), ['stale_device', 'missing_cost', 'usage_unavailable', 'usage_time_missing']);
  }
});

function metrics(reports) {
  const hubs = [...new Set(reports.map(row => row.source.hubId))].map(id => ({ id, aggregate: { periods:
    Object.fromEntries(['today', 'month', 'allTime'].map(period => [period, {
      costUsd: reports.filter(row => row.source.hubId === id).reduce((sum, row) => sum + row.device.observation.periods[period].costUsd, 0),
      totalTokens: reports.filter(row => row.source.hubId === id).reduce((sum, row) => sum + row.device.observation.periods[period].totalTokens, 0),
    }])) } }));
  return buildMetrics(hubs, reports.map(row => row.device), reports.map(row => row.source));
}

test('全期間の利用額とトークン数をHub内・Hub横断で重複除去し、生の報告を保持する', () => {
  const reports = [report('a'), report('b'), report('c', { hubId: 'work' }), report('d', { hubId: 'work', accounts: ['account-b'] })];
  const before = structuredClone(reports);
  const result = metrics(reports);
  for (const period of ['today', 'month', 'allTime']) {
    assert.deepEqual(result.global.periods[period], { costUsd: 28, totalTokens: 2800 });
    assert.deepEqual(result.byHub.get('private').periods[period], { costUsd: 14, totalTokens: 1400 });
    assert.deepEqual(result.byHub.get('work').periods[period], { costUsd: 24, totalTokens: 2400 });
  }
  assert.equal(result.global.duplicateSources.length, 2);
  assert.deepEqual(reports, before);
});

test('契約識別やHub合計が欠けるメトリクスはゼロにせず不明にする', () => {
  const missingAccount = metrics([report('a', { accounts: [] })]);
  assert.equal(missingAccount.global.periods.allTime.costUsd, null);
  assert.equal(missingAccount.global.excludedSources[0].reason, 'missing_account');
  const missingHub = buildMetrics([{ id: 'private', aggregate: { periods: { allTime: { totalTokens: 12 } } } }], [], []);
  assert.equal(missingHub.global.periods.allTime.costUsd, null);
  assert.equal(missingHub.global.periods.allTime.totalTokens, 12);
});

test('当日未使用のCursor内訳が省略されても取得済みHub合計は保ち、架空のゼロ内訳を生成しない', () => {
  const reports = [report('a'), report('b')];
  for (const { device } of reports) {
    delete device.observation.periods.today.clientCosts.cursor;
    delete device.observation.periods.today.clients.cursor;
    device.observation.periods.today.costUsd = 2;
    device.observation.periods.today.totalTokens = 200;
  }
  const before = structuredClone(reports);
  const result = metrics(reports);
  assert.deepEqual(result.global.periods.today, { costUsd: 4, totalTokens: 400 });
  assert.deepEqual(result.global.periods.allTime, { costUsd: 14, totalTokens: 1400 });
  assert.deepEqual(reports, before);
});
