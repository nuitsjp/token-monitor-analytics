import assert from 'node:assert/strict';
import test from 'node:test';

import { parseEstimationSettings } from '../src/estimation-config.js';

const invalidError = '推定設定の形式が不正です。';

test('省略時は空の推定設定を返す', () => {
  assert.deepEqual(parseEstimationSettings(undefined), { planMultipliers: [], error: null });
});

test('有効な設定は文字列をtrimし未知項目を投影から除外する', () => {
  const input = {
    extra: 'ignored',
    planMultipliers: [{
      tool: ' codex ',
      windowKey: ' five_hour ' ,
      basePlan: ' Plus ',
      plans: { ' Plus ': 1, Pro: 5 },
      extra: { ignored: true }
    }]
  };

  assert.deepEqual(parseEstimationSettings(input), {
    planMultipliers: [{
      tool: 'codex',
      windowKey: 'five_hour',
      basePlan: 'Plus',
      plans: { Plus: 1, Pro: 5 }
    }],
    error: null
  });
  assert.deepEqual(input.planMultipliers[0].extra, { ignored: true });
});

test('異なる枠の設定を複数受け入れる', () => {
  assert.deepEqual(parseEstimationSettings({
    planMultipliers: [
      { tool: 'codex', windowKey: 'five_hour', basePlan: 'Plus', plans: { Plus: 1, Pro: 5 } },
      { tool: 'codex', windowKey: 'weekly', basePlan: 'Free', plans: { Free: 1, Team: 3 } }
    ]
  }), {
    planMultipliers: [
      { tool: 'codex', windowKey: 'five_hour', basePlan: 'Plus', plans: { Plus: 1, Pro: 5 } },
      { tool: 'codex', windowKey: 'weekly', basePlan: 'Free', plans: { Free: 1, Team: 3 } }
    ],
    error: null
  });
});

test('基準プランが存在しない、または倍率が1でない設定を拒否する', () => {
  const cases = [
    { basePlan: 'Team', plans: { Plus: 1, Team: 5 } },
    { basePlan: 'Plus', plans: { Plus: 2, Pro: 5 } }
  ];

  for (const current of cases) {
    assert.deepEqual(parseEstimationSettings({
      planMultipliers: [{ tool: 'codex', windowKey: 'five_hour', ...current }]
    }), { planMultipliers: [], error: invalidError });
  }
});

test('非有限、負、ゼロの倍率を拒否する', () => {
  for (const multiplier of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0]) {
    assert.deepEqual(parseEstimationSettings({
      planMultipliers: [{ tool: 'codex', windowKey: 'five_hour', basePlan: 'Plus', plans: { Plus: 1, Pro: multiplier } }]
    }), { planMultipliers: [], error: invalidError });
  }
});

test('同じtoolとwindowKeyの設定重複を拒否する', () => {
  assert.deepEqual(parseEstimationSettings({
    planMultipliers: [
      { tool: 'codex', windowKey: 'five_hour', basePlan: 'Plus', plans: { Plus: 1, Pro: 5 } },
      { tool: ' codex ', windowKey: 'five_hour ', basePlan: 'Plus', plans: { Plus: 1, Pro: 5 } }
    ]
  }), { planMultipliers: [], error: invalidError });
});

test('危険なキーを拒否する', () => {
  const dangerous = JSON.parse('{"planMultipliers":[{"tool":"codex","windowKey":"five_hour","basePlan":"Plus","plans":{"Plus":1,"__proto__":5}}]}');
  assert.deepEqual(parseEstimationSettings(dangerous), { planMultipliers: [], error: invalidError });

  const rootDangerous = JSON.parse('{"__proto__":{},"planMultipliers":[]}');
  assert.deepEqual(parseEstimationSettings(rootDangerous), { planMultipliers: [], error: invalidError });

  const settingsDangerous = [{
    tool: 'codex',
    windowKey: 'five_hour',
    basePlan: 'Plus',
    plans: { Plus: 1 }
  }];
  settingsDangerous.constructor = 'unexpected';
  assert.deepEqual(parseEstimationSettings({ planMultipliers: settingsDangerous }), {
    planMultipliers: [],
    error: invalidError
  });
});

test('不正設定のエラーに入力値や詳細本文を含めない', () => {
  const marker = 'sensitive-estimation-marker';
  const result = parseEstimationSettings({
    marker,
    planMultipliers: [{
      tool: 'codex',
      windowKey: 'five_hour',
      basePlan: 'Plus',
      plans: { Plus: 0, Pro: 5 }
    }]
  });

  assert.deepEqual(result, { planMultipliers: [], error: invalidError });
  assert.equal(JSON.stringify(result).includes(marker), false);
  assert.equal(result.error.includes('0'), false);
});
