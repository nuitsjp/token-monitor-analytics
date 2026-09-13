import { createHash } from 'node:crypto';
import { contractAccountKey, providerContractId, deviceKey } from './identity.js';
import { selectUsageSources, usageScope } from './usage.js';

const MESSAGES = {
  collecting: '比較に必要な次の観測を待っています。',
  awaiting_refresh: '利用額と利用枠の両方の再取得を待っています。',
  no_increase: '推定に必要な利用額・消費率の増加を待っています。',
  missing_account: '利用額に対応するアカウント識別子を取得できません。',
  missing_account_rate: '利用額に含まれる全契約の消費率がそろっていません。',
  missing_cost: 'ツール別の累積利用額を取得できません。',
  missing_device: '対象端末が最新の通知に含まれていません。',
  stale_device: '対象端末の利用実績が古いため推定を停止しています。',
  usage_unavailable: '利用実績の収集成功を確認できません。',
  usage_time_missing: '利用実績の再収集日時を取得できません。',
  limits_unavailable: '利用枠を正常に取得できていません。',
  unsupported_window: '残高・失効型、または割合メーターではない利用枠です。',
  missing_percentage: '利用枠の有効な消費率、または使用量と上限を取得できません。',
  ambiguous_window: '同じ識別情報を持つ複数の利用枠を区別できません。',
  conflicting_rate: '同時刻の利用枠報告が一致していません。',
  invalid_period: '利用枠の有効なリセット予定日時を取得できません。',
  expired_period: 'リセット予定日時を過ぎています。新しい利用枠の取得を待っています。',
  unknown_plan: '共有利用額に含まれる契約のプランを識別できません。',
  multipliers_required: '異なるプランの共有利用額には基準プランと倍率の設定が必要です。',
  invalid_settings: '推定設定の形式が不正です。',
  out_of_order: '古い観測を検出したため、比較を中断しました。',
  conflicting_observation: '同じ測定日時の値が変わったため、比較を中断しました。',
  percentage_decreased: '同じ利用期間で消費率が減少したため、比較を中断しました。',
  cost_not_increased: '起点からの利用額増分が正ではありません。起点を維持しています。',
  disconnected: 'Hub 接続が途切れたため、比較を中断しました。',
  invalid_notification: '不正な通知により観測が欠けたため、比較を中断しました。',
  incomplete_replay_history: '旧版の比較基準を検証できないため、結果を保持して新しい観測を待っています。',
  recovery: '正常終了を確認できないため、結果を保持して比較を再開します。',
  restart: '再起動前後の未観測区間を除外して比較を再開します。',
  migration: '移行前の観測を比較起点にせず、新しい観測を待っています。',
  source_set_changed: '対象端末の構成が変わりました。過去の結果を保持しています。',
  account_set_changed: '対象契約が変わりました。全契約の新しい観測を待っています。',
  no_eligible_sources: '推定に使える利用額の報告がありません。除外理由を確認してください。',
  method_changed: '集計方法の変更前の記録です。現在の推定には使いません。',
  overlapping_usage: '一部の契約だけが重なる利用額を分離できません。',
  conflicting_usage: '同じ収集日時の利用額が一致していません。',
};

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const timestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const timeValue = (value) => timestamp(value) ? Date.parse(value) : null;
const key = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = (value) => structuredClone(value);
const sorted = (values) => [...new Set(values)].sort();

export function windowKey(window) {
  const identity = [
    window?.kind ?? null,
    window?.windowMinutes ?? null,
    window?.limitId ?? null,
    window?.additional === true,
    window?.metric ?? null,
  ];
  if (!window?.limitId && window?.label?.trim()) identity.push(window.label.trim());
  return JSON.stringify(identity);
}

function sourceKey(source) {
  return deviceKey(source.hubId, source.deviceId);
}

function sourceCompare(a, b) {
  return JSON.stringify([a.hubId, a.deviceId]).localeCompare(JSON.stringify([b.hubId, b.deviceId]));
}

function registryCompare(a, b) {
  return JSON.stringify([a.tool, a.hubId, a.deviceId])
    .localeCompare(JSON.stringify([b.tool, b.hubId, b.deviceId]));
}

function supportedWindow(window) {
  if (!window || window.showMeter === false
    || ['credits', 'balance'].includes(window.kind)
    || ['credits', 'balance'].includes(window.metric)) return false;
  if (window.boundaryKind && window.boundaryKind !== 'reset') return false;
  return true;
}

function usedPercentage(window) {
  if (!window) return null;
  let percentage = null;
  if (window.usedPercent != null) percentage = window.usedPercent;
  else if (window.remainingPercent != null) percentage = 100 - window.remainingPercent;
  else if (finite(window.used) && finite(window.limit) && window.limit > 0) percentage = 100 * window.used / window.limit;
  return finite(percentage) && percentage >= 0 && percentage <= 100 ? percentage : null;
}

function percentageLimit(window) {
  return window?.usedPercent == null && window?.remainingPercent == null ? window?.limit ?? null : null;
}

function providerPlan(provider) {
  // Codex reports its plan in accountLabel in the current Hub wire format.
  return provider.planLabel?.trim() || (provider.provider === 'codex' ? provider.accountLabel?.trim() : null) || null;
}

function registryFor(previous, devices = [], suppliedRegistry) {
  const initial = suppliedRegistry ?? previous?.registry ?? [];
  const registry = [];
  const bySource = new Map();

  for (const entry of initial) {
    const identity = JSON.stringify([entry.hubId, entry.deviceId, entry.tool]);
    const existing = bySource.get(identity);
    if (existing) existing.accounts = sorted([...existing.accounts, ...entry.accounts]);
    else {
      const stored = { ...entry, accounts: [...entry.accounts] };
      bySource.set(identity, stored);
      registry.push(stored);
    }
  }

  for (const device of devices) {
    const providers = device.observation.limits?.providers ?? [];
    const costs = device.observation.periods?.allTime?.clientCosts ?? {};
    const tools = sorted([
      ...providers.map((provider) => provider.provider).filter((provider) => typeof provider === 'string' && provider.length > 0),
      ...Object.keys(costs).filter((tool) => finite(costs[tool])),
    ]);

    for (const tool of tools) {
      const rows = providers.filter((provider) => provider.provider === tool);
      if (!rows.some((provider) => provider.windows?.length) && !finite(costs[tool])) continue;
      const identity = JSON.stringify([device.hubId, device.deviceId, tool]);
      let source = bySource.get(identity);
      if (!source) {
        source = { hubId: device.hubId, deviceId: device.deviceId, tool, accounts: [] };
        bySource.set(identity, source);
        registry.push(source);
      }
      const accounts = rows
        .map((provider) => providerContractId(provider, device.hubId))
        .filter(Boolean);
      source.accounts = sorted([...source.accounts, ...accounts]);
    }
  }
  return registry.sort(registryCompare);
}

function components(registry) {
  const candidates = [...registry].sort(registryCompare);
  const groups = [];
  const remaining = new Set(candidates);

  while (remaining.size) {
    const initial = remaining.values().next().value;
    remaining.delete(initial);
    const sources = [initial];
    const accounts = new Set(initial.accounts);
    let changed = true;
    while (changed) {
      changed = false;
      for (const source of remaining) {
        if (source.tool !== initial.tool || !source.accounts.some((account) => accounts.has(account))) continue;
        remaining.delete(source);
        sources.push(source);
        source.accounts.forEach((account) => accounts.add(account));
        changed = true;
      }
    }
    sources.sort(sourceCompare);
    groups.push({
      tool: initial.tool,
      sources,
      accountKeys: [...accounts].sort(),
    });
  }
  return groups;
}

function makeCandidates(devices, registry, settings, receivedAt) {
  const candidates = [];
  const byDevice = new Map();
  for (const device of devices) {
    byDevice.set(deviceKey(device.hubId, device.deviceId), device);
  }

  for (const component of components(registry)) {
    const { tool } = component;
    const selection = selectUsageSources(component.sources, devices);
    const sources = selection.selected.map(report => report.source);
    const accountKeys = sorted(sources.flatMap(source => source.accounts));
    const eligibleReports = component.sources.filter(source => !selection.excluded.some(excluded => (
      excluded.hubId === source.hubId && excluded.deviceId === source.deviceId
    )));
    const rows = (sources.length ? eligibleReports : component.sources).flatMap((source) => {
      const device = byDevice.get(sourceKey(source));
      if (!device) return [];
      return (device.observation.limits?.providers ?? [])
        .filter((provider) => provider.provider === tool)
        .map((provider) => ({ provider, device, source }));
    });
    const windows = new Map();
    for (const { provider } of rows) {
      for (const window of Array.isArray(provider.windows) ? provider.windows : []) {
        windows.set(windowKey(window), window);
      }
    }
    if (!windows.size) windows.set('unavailable', { kind: null, label: '利用枠未取得' });

    const sourceKeys = selection.selected.map(report => report.id);
    const viewSources = sources.map(({ hubId, deviceId }) => ({ hubId, deviceId }));
    const hubIds = sorted(component.sources.map((source) => source.hubId));
    for (const [identity, window] of windows) {
      // The same contract can span Hubs; each usage source is counted once.
      const id = key(['usage-v2', tool, sourceKeys.length ? sourceKeys : component.sources.map(sourceKey), identity]);
      let error = settings?.error ? 'invalid_settings' : null;
      if (!sources.length) error ??= selection.excluded[0]?.reason ?? 'no_eligible_sources';
      const costs = selection.selected.map(({ source, device, id: usageId, scope, measuredAt }) => ({
        hubId: source.hubId, deviceId: source.deviceId, usageId, scope,
        value: device.observation.periods.allTime.clientCosts[tool], measuredAt, observationId: device.observationId,
      }));

      if (!accountKeys.length || rows.some(({ provider }) => !contractAccountKey(provider))) {
        error ??= 'missing_account';
      }

      const accounts = [];
      for (const accountKey of accountKeys) {
        const matchingReports = rows.filter(({ provider, device }) => (
          providerContractId(provider, device.hubId) === accountKey
        ));
        if (!matchingReports.length) {
          error ??= 'missing_account_rate';
          continue;
        }
        if (matchingReports.some(({ provider }) => (
          (provider.windows ?? []).filter((entry) => windowKey(entry) === identity).length > 1
        ))) {
          error ??= 'ambiguous_window';
          continue;
        }
        const reports = matchingReports.filter(({ provider, device }) => (
          provider.status === 'ok'
          && provider.stale !== true
          && device?.metadata?.stale !== true
          && device?.present !== false
          && !device?.gapReason
          && timestamp(provider.updatedAt)
        ));
        if (!reports.length) {
          error ??= 'limits_unavailable';
          continue;
        }
        reports.sort((a, b) => {
          const difference = Date.parse(b.provider.updatedAt) - Date.parse(a.provider.updatedAt);
          return difference || sourceCompare(a.source, b.source);
        });
        const selected = reports[0];
        const selectedMatches = reports.filter((report) => (
          Date.parse(report.provider.updatedAt) === Date.parse(selected.provider.updatedAt)
        ));
        if (selectedMatches.some((report) => (() => {
            const entry = report.provider.windows.find((candidate) => windowKey(candidate) === identity);
            const selectedEntry = selected.provider.windows.find((candidate) => windowKey(candidate) === identity);
            return usedPercentage(entry) !== usedPercentage(selectedEntry)
              || percentageLimit(entry) !== percentageLimit(selectedEntry)
              || supportedWindow(entry) !== supportedWindow(selectedEntry)
              || providerPlan(report.provider) !== providerPlan(selected.provider)
              || timeValue(entry?.resetsAt) !== timeValue(selectedEntry?.resetsAt);
          })())) {
          error ??= 'conflicting_rate';
        }

        const matchingWindows = (selected.provider.windows ?? []).filter((entry) => windowKey(entry) === identity);
        if (matchingWindows.length > 1) {
          error ??= 'ambiguous_window';
          continue;
        }
        const selectedWindow = matchingWindows[0];
        if (!selectedWindow) {
          error ??= 'missing_account_rate';
          continue;
        }
        if (!supportedWindow(selectedWindow)) error ??= 'unsupported_window';
        const percentage = usedPercentage(selectedWindow);
        if (percentage === null) error ??= 'missing_percentage';
        if (!timestamp(selectedWindow.resetsAt)) error ??= 'invalid_period';
        else if (timestamp(receivedAt) && Date.parse(selectedWindow.resetsAt) <= Date.parse(receivedAt)) error ??= 'expired_period';

        accounts.push({
          key: accountKey,
          label: selected.provider.accountLabel || selected.provider.accountName || 'アカウント',
          plan: providerPlan(selected.provider),
          usedPercent: percentage,
          percentageLimit: percentageLimit(selectedWindow),
          resetsAt: selectedWindow.resetsAt,
          measuredAt: selected.provider.updatedAt,
          observationId: selected.device.observationId,
          hubId: selected.source.hubId,
          deviceId: selected.source.deviceId,
        });
      }

      const plans = sorted(accounts.map((account) => account.plan).filter((plan) => plan));
      let basePlan = accounts[0]?.plan ?? null;
      let multipliers = accounts.map(() => 1);
      if (accounts.length > 1 && plans.length > 1) {
        if (accounts.some((account) => !account.plan)) error ??= 'unknown_plan';
        else {
          const setting = settings?.planMultipliers?.find((entry) => (
            entry?.tool === tool && entry?.windowKey === identity
          ));
          if (!setting || accounts.some((account) => !finite(setting.plans?.[account.plan]))) {
            error ??= 'multipliers_required';
          } else {
            basePlan = setting.basePlan;
            multipliers = accounts.map((account) => setting.plans[account.plan]);
          }
        }
      } else if (accounts.length > 1 && accounts.some((account) => !account.plan)) {
        error ??= 'unknown_plan';
      }
      accounts.forEach((account, index) => { account.multiplier = multipliers[index]; });

      const view = {
        id,
        tool,
        windowKey: identity,
        windowLabel: window.label || window.kind || '利用枠未取得',
        windowKind: window.kind ?? null,
        sources: viewSources,
        hubIds,
        accounts: accounts.map(({ key: accountKey, label, plan, multiplier }) => ({
          key: accountKey,
          label,
          plan,
          multiplier,
        })),
        basePlan,
        active: true,
        methodVersion: 2,
        usageScope: usageScope(tool),
        excludedSources: selection.excluded,
        duplicateSources: selection.duplicates,
        partial: selection.excluded.length > 0,
        status: 'collecting',
        reason: 'collecting',
        message: MESSAGES.collecting,
        lastResult: null,
      };
      const point = {
        receivedAt,
        costs,
        accounts,
        cost: costs.reduce((sum, source) => sum + source.value, 0),
      };
      const configurationKey = key([
        accountKeys,
        accounts.map((account) => [
          account.key,
          account.plan,
          account.multiplier,
          ...(account.percentageLimit === null ? [] : [account.percentageLimit]),
        ]),
        sourceKeys,
        identity,
        basePlan,
      ]);
      const periodKey = key(accounts.map((account) => [account.key, timeValue(account.resetsAt)]));
      candidates.push({ id, view, point, configurationKey, periodKey, error });
    }
  }
  return candidates;
}

function measurements(point) {
  const result = [];
  for (const source of point?.costs ?? []) {
    const sourceId = source.usageId ?? sourceKey(source);
    if (!sourceId || !timestamp(source.measuredAt) || !finite(source.value)) continue;
    result.push({
      id: `cost:${sourceId}`,
      time: source.measuredAt,
      value: source.value,
    });
  }
  for (const account of point?.accounts ?? []) {
    if (typeof account.key !== 'string' || !timestamp(account.measuredAt)
      || !finite(account.usedPercent) || !timestamp(account.resetsAt)) continue;
    result.push({
      id: `rate:${account.key}`,
      time: account.measuredAt,
      value: account.usedPercent,
      period: Date.parse(account.resetsAt),
      ...(account.percentageLimit == null ? {} : { percentageLimit: account.percentageLimit }),
    });
  }
  return result;
}

function numericalKey(point) {
  return key([
    (point?.costs ?? []).map((source) => [source.usageId ?? sourceKey(source), source.value]),
    (point?.accounts ?? []).map((account) => [
      account.key,
      account.usedPercent,
      timeValue(account.resetsAt),
    ]),
  ]);
}

function resultFor(group, candidate) {
  const { point } = candidate;
  const previousAccounts = new Map((group.baseline?.accounts ?? [])
    .map((account) => [account.key, account]));
  const deltas = point.accounts.map((account) => {
    const previous = previousAccounts.get(account.key);
    if (!previous) return {
      key: account.key,
      plan: account.plan,
      label: account.label,
      multiplier: account.multiplier,
      deltaPercent: Number.NaN,
      missing: true,
    };
    return {
      key: account.key,
      plan: account.plan,
      label: account.label,
      multiplier: account.multiplier,
      deltaPercent: account.usedPercent - previous.usedPercent,
    };
  });
  if (deltas.some((entry) => entry.missing)) return { error: 'missing_account_rate' };
  if (deltas.some((entry) => entry.deltaPercent < 0)) return { error: 'percentage_decreased' };
  const deltaCostUsd = point.cost - group.baseline.cost;
  const weightedPercent = deltas.reduce((sum, account) => sum + account.multiplier * account.deltaPercent, 0);
  if (deltaCostUsd <= 0) return { error: 'cost_not_increased' };
  if (weightedPercent <= 0) return { error: 'no_increase' };
  const baseCapacityUsd = 100 * deltaCostUsd / weightedPercent;
  if (!finite(baseCapacityUsd) || baseCapacityUsd <= 0) return { error: 'no_increase' };
  return {
    result: {
      calculatedAt: point.receivedAt,
      from: group.baseline.receivedAt,
      to: point.receivedAt,
      basePlan: candidate.view.basePlan,
      baseCapacityUsd,
      deltaCostUsd,
      weightedPercent,
      accounts: deltas.map(({ missing, ...account }) => ({
        ...account,
        capacityUsd: account.multiplier * baseCapacityUsd,
      })),
      evidence: { baseline: group.baseline, latest: point },
    },
  };
}

function status(view, reason, state = 'unavailable') {
  view.status = state;
  view.reason = reason;
  view.message = MESSAGES[reason] ?? reason;
}

function eventFor(previousView, view, at) {
  if (previousView && JSON.stringify(previousView) === JSON.stringify(view)) return null;
  return { seriesId: view.id, recordedAt: at, status: view.status, view: copy(view) };
}

function mergeMeasurements(existing, current) {
  const merged = new Map((existing ?? []).map((entry) => [entry.id, entry]));
  for (const entry of current ?? []) {
    const old = merged.get(entry.id);
    if (!old || timeValue(entry.time) > timeValue(old.time)) merged.set(entry.id, copy(entry));
    else if (old && timeValue(entry.time) === timeValue(old.time)
      && (old.value !== entry.value || old.period !== entry.period)) merged.set(entry.id, copy(entry));
  }
  return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function measurementMap(entries) {
  return new Map((entries ?? []).map((entry) => [entry.id, entry]));
}

function sameMeasurementSet(a, b) {
  if (a.size !== b.size) return false;
  for (const id of a.keys()) if (!b.has(id)) return false;
  return true;
}

function allAdvanced(current, previous) {
  const currentMap = measurementMap(current);
  const previousMap = measurementMap(previous);
  if (!sameMeasurementSet(currentMap, previousMap)) return false;
  for (const [id, entry] of currentMap) {
    const prior = previousMap.get(id);
    if (timeValue(entry.time) === null || timeValue(prior.time) === null
      || timeValue(entry.time) <= timeValue(prior.time)) return false;
  }
  return true;
}

function hasExactNumerics(a, b) {
  return numericalKey(a) === numericalKey(b);
}

function blankGroup(candidate) {
  return {
    id: candidate.id,
    baseline: null,
    latest: null,
    highWater: [],
    lastNumericKey: null,
    view: copy(candidate.view),
    configurationKey: candidate.configurationKey,
    periodKey: candidate.periodKey,
  };
}

export function advanceEstimation(previous, { devices = [], receivedAt, registry } = {}, settings = {}) {
  const previousState = previous;
  const effectiveRegistry = registryFor(previousState, devices, registry);
  const prior = new Map((previousState?.groups ?? []).map((group) => [group.id, group]));
  const groups = [];
  const events = [];

  for (const candidate of makeCandidates(devices, effectiveRegistry, settings, receivedAt)) {
    const old = prior.get(candidate.id);
    const group = old ? copy(old) : blankGroup(candidate);
    const previousView = old?.view ? copy(old.view) : null;
    group.view = copy(candidate.view);
    group.view.lastResult = old?.view?.lastResult ?? null;
    group.view.active = true;
    group.highWater ??= [];

    const changed = group.configurationKey !== candidate.configurationKey || group.periodKey !== candidate.periodKey;
    if (changed) {
      group.baseline = null;
      group.latest = null;
      group.lastNumericKey = null;
      group.rebaseAfter ??= copy(group.highWater);
    }
    group.configurationKey = candidate.configurationKey;
    group.periodKey = candidate.periodKey;

    if (candidate.error) {
      const current = measurements(candidate.point);
      group.rebaseAfter = mergeMeasurements(group.rebaseAfter ?? group.highWater, current);
      group.highWater = mergeMeasurements(group.highWater, current);
      group.baseline = null;
      group.latest = null;
      status(group.view, candidate.error, candidate.error === 'multipliers_required' ? 'settings-required' : 'unavailable');
    } else {
      const current = measurements(candidate.point);
      const highWater = measurementMap(group.highWater);
      const backwards = current.some((entry) => (
        highWater.has(entry.id) && timeValue(entry.time) < timeValue(highWater.get(entry.id).time)
      ));
      const conflicting = current.some((entry) => (
        highWater.has(entry.id)
        && timeValue(entry.time) === timeValue(highWater.get(entry.id).time)
        && (entry.value !== highWater.get(entry.id).value || entry.period !== highWater.get(entry.id).period
          || entry.percentageLimit !== highWater.get(entry.id).percentageLimit)
      ));

      if (backwards || conflicting) {
        group.rebaseAfter ??= copy(group.highWater);
        group.baseline = null;
        group.latest = null;
        status(group.view, backwards ? 'out_of_order' : 'conflicting_observation');
      } else {
        group.highWater = current;
        if (!group.baseline) {
          const barrier = measurementMap(group.rebaseAfter ?? []);
          if (current.some((entry) => barrier.has(entry.id) && timeValue(entry.time) <= timeValue(barrier.get(entry.id).time))) {
            status(group.view, 'awaiting_refresh', 'collecting');
          } else {
            group.rebaseAfter = null;
            group.baseline = candidate.point;
            group.latest = candidate.point;
            group.lastNumericKey = numericalKey(candidate.point);
            status(group.view, 'collecting', 'collecting');
          }
        } else {
          const previousMeasurements = measurements(group.latest);
          const advanced = allAdvanced(current, previousMeasurements);
          const numeric = numericalKey(candidate.point);
          const decrease = candidate.point.accounts.some((account) => {
            const previousAccount = group.latest.accounts.find((item) => item.key === account.key);
            const high = highWater.get(`rate:${account.key}`);
            return (previousAccount && account.usedPercent < previousAccount.usedPercent)
              || (high && high.period === timeValue(account.resetsAt) && account.usedPercent < high.value);
          });

          if (decrease) {
            group.rebaseAfter = copy(current);
            group.baseline = null;
            group.latest = null;
            status(group.view, 'percentage_decreased');
          } else if (!advanced && numeric !== group.lastNumericKey) {
            status(group.view, 'awaiting_refresh', 'collecting');
          } else if (numeric === group.lastNumericKey) {
            if (advanced) group.latest = candidate.point;
            // An exact replay must not append a state event.  A timestamp-only
            // update is still retained as the latest evidence when every
            // measurement advanced.
            if (old?.view?.status === 'estimated') {
              group.view.status = 'estimated';
              group.view.reason = null;
              group.view.message = null;
            } else if (hasExactNumerics(candidate.point, group.latest) && !advanced) {
              if (old?.view?.reason === 'collecting') status(group.view, 'no_increase', 'collecting');
              else {
                group.view.status = old?.view?.status ?? 'collecting';
                group.view.reason = old?.view?.reason ?? 'collecting';
                group.view.message = old?.view?.message ?? MESSAGES.collecting;
              }
            } else {
              status(group.view, 'no_increase', 'collecting');
            }
          } else {
            const result = resultFor(group, candidate);
            group.latest = candidate.point;
            group.lastNumericKey = numeric;
            if (result.result) {
              group.view.status = 'estimated';
              group.view.reason = null;
              group.view.message = null;
              group.view.lastResult = result.result;
            } else status(group.view, result.error, result.error === 'no_increase' ? 'collecting' : 'unavailable');
          }
        }
      }
    }

    const event = eventFor(previousView, group.view, receivedAt);
    if (event) events.push(event);
    groups.push(group);
    prior.delete(group.id);
  }

  for (const old of prior.values()) {
    const group = copy(old);
    const previousView = copy(group.view);
    group.rebaseAfter ??= copy(group.highWater ?? []);
    group.baseline = null;
    group.latest = null;
    group.view.active = false;
    if (group.view.reason !== 'method_changed') status(group.view, 'source_set_changed');
    const event = eventFor(previousView, group.view, receivedAt);
    if (event) events.push(event);
    groups.push(group);
  }

  return { state: { version: 1, registry: effectiveRegistry, groups }, events };
}

/**
 * Initialize a global checkpoint after an estimation schema migration.
 * Current observations are retained only as a barrier; they are never turned
 * into a baseline or a result.  A later observation must advance every
 * measurement before a new baseline can be created.
 */
export function seedEstimation({ devices = [], registry, receivedAt } = {}, settings = {}) {
  const effectiveRegistry = registryFor(null, devices, registry);
  const groups = makeCandidates(devices, effectiveRegistry, settings, receivedAt).map((candidate) => {
    const barrier = measurements(candidate.point);
    const group = {
      id: candidate.id,
      baseline: null,
      latest: null,
      highWater: copy(barrier),
      rebaseAfter: copy(barrier),
      lastNumericKey: null,
      configurationKey: candidate.configurationKey,
      periodKey: candidate.periodKey,
      view: copy(candidate.view),
    };
    if (candidate.error) {
      status(group.view, candidate.error, candidate.error === 'multipliers_required' ? 'settings-required' : 'unavailable');
    } else {
      status(group.view, 'awaiting_refresh', 'collecting');
    }
    return group;
  });
  return { state: { version: 1, registry: effectiveRegistry, groups }, events: [] };
}

/** Replay committed estimator inputs without rewriting the append-only results. */
export function replayEstimation({ inputs, readObservation }, settings) {
  let state = null;
  for (const input of inputs) {
    if (input.kind === 'checkpoint') state = copy(input.state);
    else if (input.kind === 'notification') {
      const devices = input.devices.map((device) => ({
        ...device, observation: readObservation(device.observationId),
      }));
      state = advanceEstimation(state, {
        devices, registry: input.registry, receivedAt: input.receivedAt,
      }, settings ?? input.settings).state;
    } else if (input.kind === 'gap') {
      state = interruptEstimation(state, input).state;
    } else throw new Error('Unknown estimation input kind');
  }
  return { state, events: [] };
}

export function interruptEstimation(previous, { hubId, at, reason } = {}) {
  if (!previous) return { state: null, events: [] };
  const state = copy(previous);
  const events = [];
  for (const group of state.groups ?? []) {
    if (group.view?.active === false) continue;
    if (hubId !== undefined && hubId !== null && !(group.view?.hubIds ?? []).includes(hubId)) continue;
    const previousView = copy(group.view);
    group.rebaseAfter ??= copy(group.highWater ?? []);
    group.baseline = null;
    group.latest = null;
    status(group.view, reason);
    const event = eventFor(previousView, group.view, at);
    if (event) events.push(event);
  }
  return { state, events };
}
