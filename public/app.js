import {
  compareHistoryItems,
  historyPeriods,
  historySearch,
  monthlyCompletion,
  readAllHistoryPages,
} from './history.js';

const hubRoot = document.querySelector('#hubs');
const overallRoot = document.querySelector('#overall');
const contractRoot = document.querySelector('#contracts');
const estimateRoot = document.querySelector('#estimates');
const browserStatus = document.querySelector('#browser-status');
const storageStatus = document.querySelector('#storage-status');
const showNotConfigured = document.querySelector('#show-not-configured');
const scopeNote = document.querySelector('.scope-note');
const usageHistoryForm = document.querySelector('#usage-history-form');
const usageHistoryResults = document.querySelector('#usage-history-results');
const historyCollectionStatus = document.querySelector('#history-collection-status');
const historyKind = document.querySelector('#history-kind');
const historyFrom = document.querySelector('#history-from');
const historyTo = document.querySelector('#history-to');
const historyFetch = document.querySelector('#history-fetch');
const hubList = document.querySelector('#hub-list');
const hubForm = document.querySelector('#hub-form');
const hubMockNote = document.querySelector('#hub-mock-note');
const hubRegistrationResult = document.querySelector('#hub-registration-result');
const hubRegisterButton = document.querySelector('#hub-register');
const hubIdInput = document.querySelector('#hub-id');
const hubUrlInput = document.querySelector('#hub-url');
const hubSecretInput = document.querySelector('#hub-secret');
const number = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 });
const money = new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const dateTime = new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const preciseNumber = new Intl.NumberFormat('ja-JP', { maximumSignificantDigits: 12 });
const expanded = new Set();
const histories = new Map();
let latestState;
let legacyHubFilter = '';
const usageHistory = {
  items: [], loaded: false, loading: false, error: null, pageCount: 0,
  kind: 'daily', visibleCount: 100, compareLeft: null, compareRight: null, requestId: 0,
};
const estimateStatuses = { estimated: '推定済み', collecting: '観測待ち', unavailable: '推定不可', 'settings-required': '設定が必要' };
const registrationErrors = {
  hub_id_invalid: 'ID を入力してください。',
  hub_id_duplicate: '同じ ID の Hub が既に登録されています。',
  invalid_url: 'URL は http または https で始まり、利用者情報・クエリ・フラグメントを含まない形式で入力してください。',
  invalid_secret: '共有シークレットの形式が不正です。',
  origin_mismatch: 'この画面と同じアドレス以外からの登録は受け付けません。',
  unsupported_media_type: '登録要求の形式が不正です。',
  invalid_request: '登録要求の形式が不正です。',
  registration_failed: '接続設定を保存できませんでした。',
};
const sourceReasons = {
  stale_device: '端末の報告が古い',
  missing_cost: '利用額を取得できない',
  usage_unavailable: '利用実績を利用できない',
  usage_time_missing: '利用実績の収集日時を取得できない',
  missing_device: '端末データを取得できない',
  disconnected: 'Hubが未接続',
  invalid_notification: '通知データが不正',
  missing_account: 'アカウントを識別できない',
  overlapping_usage: '利用範囲が重複',
  conflicting_usage: '同じ収集日時の利用額が不一致',
  duplicate_usage: '同じ利用額の重複報告',
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formattedTime(value) {
  if (!value) return '未取得';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未取得' : dateTime.format(date);
}

function moneyText(value) { return typeof value === 'number' && Number.isFinite(value) ? money.format(value) : '未取得'; }
function preciseText(value) { return typeof value === 'number' && Number.isFinite(value) ? preciseNumber.format(value) : '未取得'; }
function badge(text, tone = 'muted') { return element('span', `badge ${tone}`, text); }
function stringValue(value) { return typeof value === 'string' && value.length ? value : null; }
function sameId(left, right) { return left !== null && left !== undefined && right !== null && right !== undefined && String(left) === String(right); }

function windowLabel(provider, window) {
  const label = typeof window?.label === 'string' ? window.label.trim() : '';
  if (provider?.provider === 'codex' && window?.kind === 'weekly') return 'Weekly';
  if (label) return label;
  return window?.kind || '利用枠名未取得';
}

function estimateWindowLabel(estimate) {
  if (estimate?.tool === 'codex' && estimate?.windowKind === 'weekly') return 'Weekly';
  return estimate?.windowLabel || estimate?.windowKind || '利用枠未取得';
}

function remainingPercent(window) {
  if (typeof window?.remainingPercent === 'number' && Number.isFinite(window.remainingPercent)) {
    return Math.max(0, Math.min(100, window.remainingPercent));
  }
  if (typeof window?.usedPercent === 'number' && Number.isFinite(window.usedPercent)) {
    return Math.max(0, Math.min(100, 100 - window.usedPercent));
  }
  return null;
}

function overallView(state) {
  const hubs = Array.isArray(state?.hubs) ? state.hubs : [];
  const section = element('section', 'hub overall');
  const heading = element('div', 'hub-heading overall-heading');
  const title = element('div');
  const headingText = element('h2', '', '全体');
  headingText.id = 'overall-heading';
  title.append(element('p', 'eyebrow', 'ALL HUBS'), headingText);
  heading.append(title, badge(`${hubs.length} Hub`, 'muted'));
  section.append(heading);
  const body = element('div', 'hub-total overall-body');
  if (!hubs.length) {
    body.append(element('p', 'empty', '表示できるHubがありません。'));
  } else {
    body.append(element('p', 'section-label', '全体 · API換算額（USD）'), metrics(state?.metrics?.periods));
    body.append(element('p', 'source-time', 'アカウント全体の利用額は同じ契約につき1回だけ数えます。全体値はHub値の単純な和とは限りません。'));
    body.append(sourceDisclosure(state?.metrics?.excludedSources, state, {
      id: 'metrics:overall:excluded',
      label: '利用額の集計から除外した端末',
    }));
  }
  section.append(body);
  return section;
}

function disclosure(id, label) {
  const details = element('details');
  details.open = expanded.has(id);
  details.append(element('summary', '', label));
  details.addEventListener('toggle', () => {
    if (details.open) expanded.add(id); else expanded.delete(id);
  });
  return details;
}

function contractAnchorId(id) {
  const encoded = encodeURIComponent(String(id ?? 'unknown')).replace(/[^A-Za-z0-9_-]/g, '_');
  return `contract-${encoded}`;
}

function contractById(state, id) {
  return (Array.isArray(state?.contracts) ? state.contracts : []).find((contract) => sameId(contract?.id, id)) ?? null;
}

function hubById(state, id) {
  return (Array.isArray(state?.hubs) ? state.hubs : []).find((hub) => sameId(hub?.id, id)) ?? null;
}

function hubName(state, id) { return stringValue(hubById(state, id)?.id) ?? stringValue(id) ?? 'Hub未取得'; }

function contractScopeLabel(contract, state) {
  const ids = Array.isArray(contract?.hubIds) ? contract.hubIds : [];
  const names = ids.map((id) => hubName(state, id));
  if (names.length > 1) return `${names.join('・')}で共有`;
  if (names.length === 1) return `${names[0]}で利用`;
  return 'Hub未取得';
}

function deviceForSource(state, source) {
  const hub = hubById(state, source?.hubId);
  const device = (Array.isArray(hub?.devices) ? hub.devices : []).find((entry) => sameId(entry?.deviceId, source?.deviceId));
  const hostname = stringValue(device?.metadata?.hostname);
  return {
    hubId: stringValue(source?.hubId),
    deviceId: stringValue(source?.deviceId),
    name: hostname ?? stringValue(source?.deviceId) ?? '端末未取得',
  };
}

function sourceDeviceLabels(sources, state) {
  const rows = (Array.isArray(sources) ? sources : []).map((source) => deviceForSource(state, source));
  return rows.map((row) => {
    const sameName = rows.filter((other) => other.name === row.name);
    const needsHub = sameName.some((other) => other.hubId !== row.hubId);
    const needsDevice = sameName.some((other) => other.hubId === row.hubId && other.deviceId !== row.deviceId);
    if (needsDevice) return `${row.hubId ?? 'Hub未取得'} · ${row.name} (${row.deviceId ?? 'deviceId未取得'})`;
    return needsHub ? `${row.hubId ?? 'Hub未取得'} · ${row.name}` : row.name;
  });
}

function sourceDisclosure(items, state, { id, label }) {
  const sources = Array.isArray(items) ? items : [];
  if (!sources.length) return document.createDocumentFragment();
  const details = disclosure(id, `${label}（${sources.length}件）`);
  details.classList.add('source-disclosure');
  const list = element('ul', 'evidence-list');
  const names = sourceDeviceLabels(sources, state);
  sources.forEach((source, index) => {
    const tool = stringValue(source?.tool);
    const reason = sourceReasons[source?.reason] ?? stringValue(source?.reason) ?? '理由未取得';
    list.append(element('li', '', [names[index] ?? '端末未取得', tool, reason].filter(Boolean).join(' · ')));
  });
  details.append(list);
  return details;
}

function sourceLocation(item) {
  return [stringValue(item?.hubId), stringValue(item?.deviceId)].filter(Boolean).join(' · ');
}

function resultDetails(result, id) {
  const details = disclosure(`evidence:${id}`, '計算の根拠');
  details.append(element('p', '', `比較期間 ${formattedTime(result?.from)} ～ ${formattedTime(result?.to)}`));
  details.append(element('p', '', `利用額の増分 ${preciseText(result?.deltaCostUsd)} USD ／ 倍率を反映した消費率の増分 ${preciseText(result?.weightedPercent)} ポイント`));
  details.append(element('p', '', '基準の許容量 = 100 × 利用額の増分 ÷ 倍率を反映した消費率の増分'));
  for (const [key, label] of [['baseline', '起点'], ['latest', '比較先']]) {
    const point = result?.evidence?.[key];
    if (!point) continue;
    const list = element('ul', 'evidence-list');
    for (const cost of Array.isArray(point.costs) ? point.costs : []) {
      const location = sourceLocation(cost);
      const prefix = location ? `${location} · ` : '';
      list.append(element('li', '', `${prefix}利用額 ${moneyText(cost.value)}、利用実績の収集 ${formattedTime(cost.measuredAt)}、観測 #${cost.observationId ?? '未取得'}`));
    }
    for (const account of Array.isArray(point.accounts) ? point.accounts : []) {
      const location = sourceLocation(account);
      const prefix = location ? `${location} · ` : '';
      list.append(element('li', '', `${prefix}${account.label ?? '契約'}（識別子 ${account.key ?? '未取得'}）：${preciseText(account.usedPercent)}%、利用枠の更新 ${formattedTime(account.measuredAt)}、リセット予定 ${formattedTime(account.resetsAt)}、観測 #${account.observationId ?? '未取得'}`));
    }
    details.append(element('strong', '', label), list);
  }
  return details;
}

function contractForProvider(state, hub, deviceId, provider) {
  if (!hub || !provider?.provider) return null;
  const ids = Array.isArray(hub.contractIds) ? hub.contractIds : [];
  const sourceDeviceId = deviceId ?? provider.sourceDeviceId ?? null;
  for (const id of ids) {
    const contract = contractById(state, id);
    if (!contract || contract.provider !== provider.provider) continue;
    if (provider.provider === 'grok') {
      const email = provider.accountEmail?.trim().toLowerCase();
      if (!email || contract.providerData?.accountEmail?.trim().toLowerCase() !== email) continue;
    } else if (!provider.accountKey || contract.accountKey !== provider.accountKey) continue;
    const sources = Array.isArray(contract.sources) ? contract.sources : [];
    if (sources.some((source) => sameId(source?.hubId, hub.id)
      && (!sourceDeviceId || sameId(source?.deviceId, sourceDeviceId))
      && (!source?.tool || source.tool === provider.provider))) return contract;
  }
  return null;
}

function providerReference(contract, provider) {
  const card = element('section', 'provider provider-reference');
  const heading = element('div', 'provider-heading');
  const status = provider.status === 'ok' ? '取得成功' : `取得状態：${provider.status || '未取得'}`;
  const statusTone = provider.status === 'ok' ? 'good' : 'warning';
  const statusBadges = element('div', 'badges');
  statusBadges.append(badge(status, statusTone), badge('契約カードを参照', 'muted'));
  heading.append(element('h4', '', provider.provider || 'プロバイダー名未取得'), statusBadges);
  card.append(heading);
  const account = [provider.accountLabel, provider.planLabel].filter((value) => typeof value === 'string' && value.length).join(' · ');
  if (account) card.append(element('p', 'provider-account', account));
  const link = element('a', 'contract-link', '共通の「契約・利用枠」カードで利用枠を見る');
  link.href = `#${contractAnchorId(contract.id)}`;
  link.dataset.contractId = String(contract.id);
  card.append(link);
  card.append(element('p', 'source-time', `データ側の更新日時 ${formattedTime(provider.updatedAt)}`));
  card.append(element('p', 'source-time', '同じ利用枠のメーターは契約カードにまとめて表示しています。'));
  return card;
}

function providerCard(provider) {
  const card = element('section', 'provider');
  const heading = element('div', 'provider-heading');
  heading.append(element('h4', '', provider.provider || 'プロバイダー名未取得'));
  heading.append(badge(provider.status === 'ok' ? '取得成功' : `取得状態：${provider.status || '未取得'}`, provider.status === 'ok' ? 'good' : 'warning'));
  card.append(heading);
  const account = [provider.accountLabel, provider.planLabel].filter((value) => typeof value === 'string' && value.length).join(' · ');
  if (account) card.append(element('p', 'provider-account', account));
  if (provider.provider === 'grok' && !provider.accountEmail?.trim()) {
    card.append(element('p', 'limit-detail', 'メールアドレスを取得できないため、契約を識別できません。'));
  }
  for (const window of Array.isArray(provider.windows) ? provider.windows : []) {
    const row = element('div', 'limit-row');
    const label = element('div', 'limit-label');
    const labelText = windowLabel(provider, window);
    const available = remainingPercent(window);
    label.append(element('span', '', labelText));
    label.append(element('span', 'percent', available === null ? '未取得' : `残量 ${number.format(available)}%`));
    row.append(label);
    if (available !== null && window.showMeter !== false) {
      const meter = document.createElement('progress');
      meter.max = 100;
      meter.value = available;
      meter.setAttribute('aria-label', `${labelText}の残量`);
      row.append(meter);
    }
    if (window.resetsAt) row.append(element('p', 'limit-detail', `次回の境界予定 ${formattedTime(window.resetsAt)}`));
    if (typeof window.remaining === 'number') row.append(element('p', 'limit-detail', `残量 ${number.format(window.remaining)}${window.unit ? ` ${window.unit}` : ''}`));
    card.append(row);
  }
  if (typeof provider.balanceUsd === 'number') card.append(element('p', 'limit-detail', `残高 ${moneyText(provider.balanceUsd)}`));
  card.append(element('p', 'source-time', `データ側の更新日時 ${formattedTime(provider.updatedAt)}`));
  return card;
}

function limits(summary, { state = latestState, hub = null, deviceId = null, allowContractLinks = true } = {}) {
  const providers = Array.isArray(summary?.providers) ? summary.providers.filter(Boolean) : [];
  if (!providers.length) return element('p', 'empty', '利用枠は未取得です。');
  const visibleProviders = providers.filter((provider) => showNotConfigured?.checked || provider.status !== 'notConfigured');
  if (!visibleProviders.length) return element('p', 'empty', '表示できる利用枠はありません。未設定の取得元も表示できます。');
  const grid = element('div', 'limits');
  const grokReferences = new Map();
  if (allowContractLinks) {
    for (const provider of visibleProviders.filter((row) => row.provider === 'grok')) {
      const contract = contractForProvider(state, hub, deviceId, provider);
      if (!contract) continue;
      const previous = grokReferences.get(contract.id);
      if (!previous || (provider.status === 'ok' && previous.status !== 'ok')
        || ((provider.status === 'ok') === (previous.status === 'ok')
          && (Date.parse(provider.updatedAt) || 0) > (Date.parse(previous.updatedAt) || 0))) {
        grokReferences.set(contract.id, provider);
      }
    }
  }
  for (const provider of visibleProviders) {
    const contract = allowContractLinks ? contractForProvider(state, hub, deviceId, provider) : null;
    if (contract && provider.provider === 'grok' && grokReferences.get(contract.id) !== provider) continue;
    grid.append(contract ? providerReference(contract, provider) : providerCard(provider));
  }
  return grid;
}

function contractHeader(contract, state) {
  const heading = element('div', 'provider-heading contract-heading');
  const title = element('div');
  const primary = [contract.provider, contract.label].filter((value) => typeof value === 'string' && value.length).join(' · ');
  title.append(element('h4', '', primary || '契約名未取得'));
  if (contract.plan && contract.plan !== contract.label) title.append(element('p', 'contract-plan', contract.plan));
  heading.append(title);
  const badges = element('div', 'badges');
  if (contract.current === false) badges.append(badge('過去に観測した契約', 'warning'));
  else badges.append(badge('現在の契約', 'good'));
  if ((Array.isArray(contract.hubIds) ? contract.hubIds : []).length > 1) badges.append(badge('Hub間で共有', 'muted'));
  heading.append(badges);
  return heading;
}

function contractSourceList(contract, state) {
  const sources = Array.isArray(contract.sources) ? contract.sources : [];
  if (!sources.length) return element('p', 'empty', '関連するHub・端末の観測はありません。');
  const list = element('ul', 'contract-sources');
  const labels = sourceDeviceLabels(sources, state);
  sources.forEach((source, index) => {
    const item = element('li', 'contract-source');
    const label = labels[index] ?? sourceDeviceLabels([source], state)[0];
    const isCurrent = source.current === true;
    const isPresent = source.present !== false;
    const stateLabel = !isCurrent || contract.current === false ? '過去観測のみ' : source.stale === true ? '現在報告（古い）' : isPresent ? '現在報告' : '契約報告あり（端末未報告）';
    const line = element('div', 'contract-source-heading');
    const sourceTone = isCurrent && contract.current !== false && source.stale !== true && isPresent ? 'good' : 'warning';
    line.append(element('span', '', label), badge(stateLabel, sourceTone));
    item.append(line);
    const observationIds = [source.firstObservationId, source.lastObservationId].filter((value) => value !== null && value !== undefined);
    if (observationIds.length) {
      const range = observationIds.length > 1 && observationIds[0] !== observationIds[1]
        ? `観測 #${observationIds[0]}〜#${observationIds[1]}`
        : `観測 #${observationIds[0]}`;
      item.append(element('p', 'source-time', `${source.tool || contract.provider || '利用枠'} · ${range}`));
    }
    list.append(item);
  });
  return list;
}

function contractBody(contract, state) {
  const body = element('div', 'contract-body');
  body.append(element('p', 'contract-scope', `${contractScopeLabel(contract, state)} · 関連デバイス`));
  const deviceLabels = sourceDeviceLabels(contract.sources, state);
  if (deviceLabels.length) body.append(element('p', 'contract-devices', deviceLabels.join('、')));
  body.append(contractSourceList(contract, state));
  body.append(element('p', 'source-time', `選択元の受信日時 ${formattedTime(contract.receivedAt)}`));
  if (contract.providerData) {
    body.append(element('p', 'section-label', '現在の利用枠'));
    body.append(limits({ providers: [contract.providerData] }, { state, allowContractLinks: false }));
  } else {
    body.append(element('p', 'empty', contract.current === false ? '現在の利用枠はありません。過去の観測情報を保持しています。' : '現在の利用枠は未取得です。Hub・端末の詳細で取得状態を確認できます。'));
  }
  return body;
}

function contractCard(contract, state) {
  const card = element('article', 'contract');
  card.dataset.contractId = String(contract.id ?? '');
  card.id = contractAnchorId(contract.id);
  if (contract.current === false) {
    card.classList.add('historical-contract');
    const details = element('details', 'contract-disclosure');
    const disclosureId = `contract:${contract.id}`;
    details.open = expanded.has(disclosureId);
    details.addEventListener('toggle', () => {
      if (details.open) expanded.add(disclosureId); else expanded.delete(disclosureId);
    });
    const summary = element('summary', 'contract-summary');
    summary.append(contractHeader(contract, state));
    details.append(summary, contractBody(contract, state));
    card.append(details);
  } else {
    card.append(contractHeader(contract, state), contractBody(contract, state));
  }
  return card;
}

function contractsView(state) {
  const section = element('section', 'contracts');
  const heading = element('h2', '', '契約・利用枠');
  heading.id = 'contracts-heading';
  section.append(heading, element('p', 'contracts-intro', 'Hubをまたぐ同一契約を1枚にまとめ、関連する端末と利用枠の現在値を表示します。'));
  const contracts = Array.isArray(state?.contracts) ? state.contracts : [];
  if (!contracts.length) {
    section.append(element('p', 'empty', '契約情報を受信するまでお待ちください。'));
    return section;
  }
  const current = contracts.filter((contract) => contract.current !== false);
  const historical = contracts.filter((contract) => contract.current === false);
  const grid = element('div', 'contracts-grid');
  for (const contract of current) grid.append(contractCard(contract, state));
  if (grid.childElementCount) section.append(grid);
  if (historical.length) {
    const details = disclosure('historical-contracts', '過去に観測した契約');
    const oldGrid = element('div', 'contracts-grid historical-contracts-grid');
    for (const contract of historical) oldGrid.append(contractCard(contract, state));
    details.append(oldGrid);
    section.append(details);
  }
  return section;
}

function historyKey(scope, seriesId, hubId) { return JSON.stringify([scope, seriesId ?? null, hubId ?? null]); }

async function loadHistory({ scope, seriesId = null, hubId = null, append = false }) {
  const id = historyKey(scope, seriesId, hubId);
  const history = histories.get(id) ?? { items: [], nextCursor: null, loaded: false };
  if (history.loading) return;
  history.loading = true;
  history.error = null;
  histories.set(id, history);
  if (latestState) render(latestState);
  try {
    const params = new URLSearchParams();
    params.set('scope', scope);
    if (scope === 'global' && seriesId) params.set('seriesId', seriesId);
    params.set('limit', '20');
    if (scope === 'legacy' && hubId) params.set('hubId', hubId);
    if (append && history.nextCursor) params.set('before', history.nextCursor);
    const response = await fetch(`/api/estimates/history?${params}`);
    let page;
    try { page = await response.json(); } catch { page = null; }
    if (!response.ok) throw new Error(page?.error || '履歴を取得できませんでした。接続と保存状態を確認してください。');
    history.items = append ? [...history.items, ...(Array.isArray(page?.items) ? page.items : [])] : (Array.isArray(page?.items) ? page.items : []);
    history.nextCursor = page?.nextCursor ?? null;
    history.loaded = true;
  } catch (error) {
    history.error = error.message;
  } finally {
    history.loading = false;
    if (latestState) render(latestState);
  }
}

function historyEvent(row, state, { legacy = false } = {}) {
  const event = element('article', 'history-event');
  const view = row?.view ?? {};
  const status = estimateStatuses[row?.status] ?? row?.status ?? '状態未取得';
  const heading = legacy && row?.hubId ? `${hubName(state, row.hubId)} · ` : '';
  event.append(element('p', 'history-heading', `${heading}${formattedTime(row?.recordedAt)} · ${status}`));
  if (legacy) {
    const deviceIds = Array.isArray(view.deviceIds) ? view.deviceIds : [];
    if (deviceIds.length) {
      const hub = hubById(state, row.hubId);
      const names = deviceIds.map((deviceId) => (hub?.devices ?? []).find((device) => sameId(device.deviceId, deviceId))?.metadata?.hostname ?? deviceId);
      event.append(element('p', 'estimate-scope', `旧方式の対象端末：${names.join('、')}`));
    }
  }
  if (view.message) event.append(element('p', '', view.message));
  if (view.partial === true) event.append(element('p', 'estimate-reason', '取得できた端末の利用額に基づく参考値です。'));
  event.append(sourceDisclosure(view.excludedSources, state, { id: `history:excluded:${row?.id}`, label: '除外した端末と理由' }));
  event.append(sourceDisclosure(view.duplicateSources, state, { id: `history:duplicates:${row?.id}`, label: '重複として数えなかった報告' }));
  const result = view.lastResult;
  if (result) {
    event.append(element('p', '', `この時点で保持していた推定：${moneyText(result.baseCapacityUsd)}（基準）、算出 ${formattedTime(result.calculatedAt)}`));
    for (const account of Array.isArray(result.accounts) ? result.accounts : []) {
      event.append(element('p', '', `${account.label ?? account.key ?? '契約'}${account.plan ? ` · ${account.plan}` : ''}：${moneyText(account.capacityUsd)}（×${account.multiplier ?? '未取得'}）`));
    }
    event.append(resultDetails(result, `history:${legacy ? 'legacy' : 'global'}:${row.id}`));
  }
  return event;
}

function historyControls(history, onRefresh) {
  const controls = element('div', 'history-controls');
  const refresh = element('button', '', history?.loaded ? '最新の履歴を取得' : '履歴を取得');
  refresh.type = 'button';
  refresh.disabled = history?.loading === true;
  refresh.addEventListener('click', onRefresh);
  controls.append(refresh);
  if (history?.loading) controls.append(element('span', '', '取得中…'));
  return controls;
}

function historyView(estimate, state) {
  const id = historyKey('global', estimate.id, null);
  const details = disclosure(`history:global:${estimate.id}`, '保存した推定と状態の履歴');
  const history = histories.get(id);
  details.append(historyControls(history, () => loadHistory({ scope: 'global', seriesId: estimate.id })));
  if (history?.error) details.append(element('p', 'error-detail', history.error));
  if (history?.loaded && !history.items.length) details.append(element('p', '', '保存済みの履歴はありません。'));
  for (const row of history?.items ?? []) details.append(historyEvent(row, state));
  if (history?.nextCursor) {
    const more = element('button', '', 'さらに過去の履歴を取得');
    more.type = 'button';
    more.disabled = history.loading;
    more.addEventListener('click', () => loadHistory({ scope: 'global', seriesId: estimate.id, append: true }));
    details.append(more);
  }
  return details;
}

function estimateSourceText(estimate, state) {
  const sources = Array.isArray(estimate?.sources) ? estimate.sources : [];
  const hubs = Array.isArray(estimate?.hubIds) ? estimate.hubIds : [];
  const hubText = hubs.length ? `対象Hub：${hubs.map((id) => hubName(state, id)).join('・')}` : '';
  if (sources.length) return [hubText, `採用した費用報告端末：${sourceDeviceLabels(sources, state).join('、')}`].filter(Boolean).join(' · ');
  if (hubs.length) return `対象Hub：${hubs.map((id) => hubName(state, id)).join('、')}`;
  return '対象端末：未取得';
}

function estimateAccountLabel(account, state) {
  const contract = contractById(state, account?.key);
  return account?.label || contract?.label || account?.key || '契約';
}

function estimateCard(estimate, state, { historical = false } = {}) {
  const card = element('article', 'estimate');
  card.dataset.seriesId = String(estimate.id ?? '');
  const heading = element('div', 'provider-heading');
  const statusText = historical ? '以前の集計' : (estimateStatuses[estimate.status] ?? estimate.status ?? '状態未取得');
  heading.append(element('h4', '', `${estimate.tool || 'ツール未取得'} · ${estimateWindowLabel(estimate)}`), badge(statusText, historical ? 'muted' : estimate.status === 'estimated' ? 'good' : 'warning'));
  card.append(heading);
  card.append(element('p', 'estimate-scope', estimateSourceText(estimate, state)));
  if (estimate.usageScope === 'account') card.append(element('p', 'estimate-scope', '利用額の範囲：アカウント全体（同じ契約の重複報告は1回だけ採用）'));
  if (estimate.usageScope === 'device') card.append(element('p', 'estimate-scope', '利用額の範囲：端末'));
  if (estimate.message) card.append(element('p', 'estimate-reason', estimate.message));
  if (historical) card.append(element('p', 'estimate-reason', '以前の集計方法または対象構成の記録です。現在値には使用しません。'));
  else if (estimate.partial === true) card.append(element('p', 'estimate-reason', '取得できた端末の利用額に基づく参考値です。'));
  card.append(sourceDisclosure(estimate.excludedSources, state, { id: `estimate:excluded:${estimate.id}`, label: '除外した端末と理由' }));
  card.append(sourceDisclosure(estimate.duplicateSources, state, { id: `estimate:duplicates:${estimate.id}`, label: '重複として数えなかった報告' }));
  const result = estimate.lastResult;
  if (result) {
    const values = element('div', 'capacity-values');
    for (const account of Array.isArray(result.accounts) ? result.accounts : []) {
      const value = element('div');
      const contract = contractById(state, account.key);
      const label = estimateAccountLabel(account, state);
      const labelNode = contract ? element('a', 'contract-inline-link', label) : element('p', 'metric-label', label);
      if (contract) labelNode.href = `#${contractAnchorId(contract.id)}`;
      value.append(labelNode);
      value.append(element('strong', 'capacity-value', moneyText(account.capacityUsd)));
      if ((result.accounts ?? []).length > 1) value.append(element('p', 'metric-sub', `基準 ${result.basePlan ?? '共通プラン'} の ×${account.multiplier ?? '未取得'}`));
      values.append(value);
    }
    const resultLabel = historical ? '保存済みの推定 · 現在値には使用しない' : estimate.status === 'estimated' ? '直近の推定 · API換算額（USD）' : '前回の推定 · 現在は算出を停止';
    card.append(element('p', 'section-label', resultLabel), values);
    card.append(element('p', 'source-time', `算出日時 ${formattedTime(result.calculatedAt)}`), resultDetails(result, estimate.id));
  }
  if (estimate.reason === 'multipliers_required') {
    const setting = disclosure(`settings:${estimate.id}`, 'この利用枠の設定方法');
    setting.append(element('p', '', 'ローカルの hubs.json のトップレベル estimation.planMultipliers に基準プランと各プランの倍率を設定し、アプリを再起動してください。基準は1、ほかは契約の相対的な利用上限倍率を指定します。'));
    setting.append(element('p', '', `対象プラン：${[...new Set((estimate.accounts ?? []).map((account) => account.plan).filter(Boolean))].join('、') || '未取得'}`));
    setting.append(element('pre', '', JSON.stringify({ estimation: { planMultipliers: [{ tool: estimate.tool, windowKey: estimate.windowKey, basePlan: '基準とするプラン名', plans: { '基準とするプラン名': 1, '別のプラン名': '正の倍率を数値で指定' } }] } }, null, 2)));
    card.append(setting);
  }
  card.append(historyView(estimate, state));
  return card;
}

function legacyHistoryView(state) {
  const details = disclosure('history:legacy', '旧方式の履歴（Hub別）');
  details.append(element('p', 'estimate-intro', '旧方式で保存されたHub別の推定履歴です。現在の契約カードや推定値には流用しません。'));
  const filter = element('label', 'legacy-filter', 'Hubで絞り込む');
  const select = document.createElement('select');
  select.setAttribute('aria-label', '旧方式の履歴をHubで絞り込む');
  const all = element('option', '', 'すべてのHub');
  all.value = '';
  select.append(all);
  for (const hub of Array.isArray(state?.hubs) ? state.hubs : []) {
    const option = element('option', '', hub.id);
    option.value = hub.id;
    select.append(option);
  }
  select.value = legacyHubFilter;
  select.addEventListener('change', () => {
    legacyHubFilter = select.value;
    if (latestState) render(latestState);
  });
  filter.append(select);
  details.append(filter);
  const hubId = legacyHubFilter || null;
  const id = historyKey('legacy', null, hubId);
  const history = histories.get(id);
  details.append(historyControls(history, () => loadHistory({ scope: 'legacy', hubId })));
  if (history?.error) details.append(element('p', 'error-detail', history.error));
  if (history?.loaded && !history.items.length) details.append(element('p', '', '保存済みの旧方式履歴はありません。'));
  for (const row of history?.items ?? []) details.append(historyEvent(row, state, { legacy: true }));
  if (history?.nextCursor) {
    const more = element('button', '', 'さらに過去の履歴を取得');
    more.type = 'button';
    more.disabled = history.loading;
    more.addEventListener('click', () => loadHistory({ scope: 'legacy', hubId, append: true }));
    details.append(more);
  }
  return details;
}

function estimates(state) {
  const section = element('section', 'estimates');
  const heading = element('h2', '', '利用許容量の推定');
  heading.id = 'estimates-heading';
  section.append(heading, element('p', 'estimate-intro', '全サービスに共通の計算を使います。ツール全体のAPI換算額と各利用枠の消費率から算出する参考値です。枠ごとの推定値は合算しません。'));
  const views = Array.isArray(state?.estimates) ? state.estimates : [];
  const current = views.filter((estimate) => estimate?.methodVersion === 2 && estimate?.active !== false);
  const historical = views.filter((estimate) => estimate?.methodVersion !== 2 || estimate?.active === false);
  if (!current.length) section.append(element('p', 'empty', '現在の集計方法で推定する利用額と利用枠の受信を待っています。'));
  const secondary = disclosure('other-estimates:global', '取得情報が不足している対象・割合推定に適さない枠');
  let secondaryCount = 0;
  for (const estimate of current) {
    const card = estimateCard(estimate, state);
    if (!estimate.lastResult && (estimate.reason === 'unsupported_window' || estimate.windowKey === 'unavailable')) {
      secondary.append(card);
      secondaryCount += 1;
    } else section.append(card);
  }
  if (secondaryCount) section.append(secondary);
  if (historical.length) {
    const old = disclosure('historical-estimates:global', '以前の集計方法・対象構成の記録');
    old.append(element('p', 'estimate-intro', '新しい集計方法の現在値には使用しません。'));
    for (const estimate of historical) old.append(estimateCard(estimate, state, { historical: true }));
    section.append(old);
  }
  if (Number(state?.legacyEstimateCount) > 0) section.append(legacyHistoryView(state));
  return section;
}

function metrics(periods) {
  const grid = element('div', 'metrics');
  for (const [key, label] of [['today', '今日'], ['month', '今月'], ['allTime', '累計']]) {
    const metric = element('div', 'metric');
    const period = periods?.[key];
    metric.append(element('p', 'metric-label', label));
    metric.append(element('div', 'metric-value', moneyText(period?.costUsd)));
    metric.append(element('p', 'metric-sub', typeof period?.totalTokens === 'number' ? `${number.format(period.totalTokens)} tokens` : 'トークン数 未取得'));
    grid.append(metric);
  }
  return grid;
}

function timestamps(sourceLabel, source, received) {
  const row = element('div', 'timestamps');
  row.append(element('p', '', `${sourceLabel} ${formattedTime(source)}`));
  row.append(element('p', '', `最終保存成功データの受信日時 ${formattedTime(received)}`));
  return row;
}

function deviceCard(device, state, hub) {
  const card = element('article', 'device');
  const heading = element('div', 'device-heading');
  const title = element('div');
  title.append(element('h3', '', device.metadata?.hostname ?? '端末名未取得'));
  title.append(element('div', 'device-id', device.deviceId));
  heading.append(title);
  const badges = element('div', 'badges');
  if (!device.present) badges.append(badge('最新通知に含まれない', 'warning'));
  else if (device.metadata?.stale === true) badges.append(badge('端末の報告が古い', 'warning'));
  else badges.append(badge('Hubから報告あり'));
  if (device.metadata?.platform) badges.append(badge(device.metadata.platform));
  heading.append(badges);
  card.append(heading, metrics(device.observation?.periods));
  card.append(timestamps('データ側の更新日時', device.observation?.updatedAt, device.receivedAt));
  card.append(limits(device.observation?.limits, { state, hub, deviceId: device.deviceId }));
  return card;
}

function historyStatusView(state) {
  const fragment = document.createDocumentFragment();
  const statusLabels = {
    unfetched: ['履歴未取得', 'muted'],
    fetching: ['履歴取得中', 'warning'],
    ready: ['履歴取得成功', 'good'],
    retrying: ['通信失敗・再試行待ち', 'warning'],
    invalid: ['取得データ不正', 'danger'],
    stopped: ['履歴取得停止', 'warning'],
  };
  const hubs = Array.isArray(state?.hubs) ? state.hubs : [];
  for (const hub of hubs) {
    const item = element('article', 'history-source-status');
    const heading = element('div', 'history-source-heading');
    const current = hub.history ?? {};
    const [label, tone] = statusLabels[current.state] ?? ['状態不明', 'muted'];
    heading.append(element('strong', '', hub.id), badge(label, tone));
    item.append(heading);
    if (current.lastSuccessAt) item.append(element('p', '', `最終取得成功 ${formattedTime(current.lastSuccessAt)}`));
    if (current.nextRetryAt) item.append(element('p', '', `次回の再試行 ${formattedTime(current.nextRetryAt)}`));
    if (current.error) item.append(element('p', 'history-source-error', current.error));
    for (const device of Array.isArray(current.devices) ? current.devices : []) {
      const identity = [device.deviceId ?? '端末ID未取得', device.timeZone ? `タイムゾーン ${device.timeZone}` : null].filter(Boolean).join(' · ');
      if (device.dailyStatus === 'no_previous_day') {
        item.append(element('p', 'history-source-note', `${identity}：取得成功・前日データなし`));
      } else if (device.dailyStatus === 'unknown_today') {
        item.append(element('p', 'history-source-error', `${identity}：端末現地日付が不明なため日次履歴を保存していません`));
      }
    }
    fragment.append(item);
  }
  if (!hubs.length) fragment.append(element('p', 'empty', '表示できるHubがありません。'));
  return fragment;
}

function replaceHistoryOptions(id, values) {
  const list = document.querySelector(id);
  if (!list) return;
  const fragment = document.createDocumentFragment();
  for (const value of [...new Set(values.filter((entry) => typeof entry === 'string' && entry.length))].sort()) {
    const option = document.createElement('option');
    option.value = value;
    fragment.append(option);
  }
  list.replaceChildren(fragment);
}

function updateHistoryOptions(state) {
  const hubs = Array.isArray(state?.hubs) ? state.hubs : [];
  const loaded = usageHistory.items;
  replaceHistoryOptions('#history-hub-options', [...hubs.map((hub) => hub.id), ...loaded.map((item) => item?.hubId)]);
  replaceHistoryOptions('#history-device-options', [
    ...hubs.flatMap((hub) => (Array.isArray(hub.devices) ? hub.devices : []).map((device) => device.deviceId)),
    ...loaded.map((item) => item?.deviceId),
  ]);
  const currentTools = hubs.flatMap((hub) => (Array.isArray(hub.devices) ? hub.devices : []).flatMap((device) => {
    const periods = device.observation?.periods ?? {};
    return Object.values(periods).flatMap((period) => Object.keys(period?.clientCosts ?? {}));
  }));
  replaceHistoryOptions('#history-tool-options', [...currentTools, ...loaded.map((item) => item?.tool)]);
}

function historyFilters() {
  const data = new FormData(usageHistoryForm);
  return Object.fromEntries(['kind', 'hubId', 'deviceId', 'tool', 'from', 'to']
    .map((name) => [name, String(data.get(name) ?? '').trim()]));
}

async function fetchHistoryPage(filters, before) {
  const response = await fetch(`/api/history?${historySearch(filters, before)}`);
  let page = null;
  try { page = await response.json(); } catch { /* handled below */ }
  if (!response.ok) throw new Error(page?.error || '履歴を取得できませんでした。接続と保存状態を確認してください。');
  return page;
}

async function loadUsageHistory() {
  const filters = historyFilters();
  if (filters.from && filters.to && filters.from > filters.to) {
    usageHistory.error = '開始は終了以前の日付を指定してください。';
    renderUsageHistoryResults();
    return;
  }
  const requestId = ++usageHistory.requestId;
  usageHistory.loading = true;
  usageHistory.error = null;
  if (historyFetch) { historyFetch.disabled = true; historyFetch.textContent = '取得中…'; }
  renderUsageHistoryResults();
  try {
    const result = await readAllHistoryPages((before) => fetchHistoryPage(filters, before));
    if (requestId !== usageHistory.requestId) return;
    if (result.kind !== filters.kind) throw new Error('取得した履歴の種別が要求と一致しません。');
    usageHistory.items = result.items;
    usageHistory.kind = filters.kind;
    usageHistory.pageCount = result.pageCount;
    usageHistory.loaded = true;
    usageHistory.visibleCount = 100;
    const periods = historyPeriods(result.items, filters.kind);
    usageHistory.compareLeft = periods.at(-1) ?? null;
    usageHistory.compareRight = periods[0] ?? null;
    updateHistoryOptions(latestState);
  } catch (error) {
    if (requestId !== usageHistory.requestId) return;
    usageHistory.error = error.message;
  } finally {
    if (requestId === usageHistory.requestId) {
      usageHistory.loading = false;
      if (historyFetch) {
        historyFetch.disabled = false;
        historyFetch.textContent = usageHistory.loaded ? '履歴を更新' : '履歴を取得';
      }
      renderUsageHistoryResults();
    }
  }
}

function signedHistoryText(value, formatter, suffix = '') {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '差分なし';
  return `${value > 0 ? '+' : ''}${formatter.format(value)}${suffix}`;
}

function historyValueLines(item) {
  if (!item) return element('span', 'history-missing', '未取得');
  const value = element('div', 'history-values');
  value.append(
    element('span', '', typeof item.tokens === 'number' && Number.isFinite(item.tokens) ? `${preciseNumber.format(item.tokens)} tokens` : 'tokens 未取得'),
    element('span', '', typeof item.cost === 'number' && Number.isFinite(item.cost) ? money.format(item.cost) : 'API換算額 未取得'),
  );
  return value;
}

function historyPeriodBadge(item, kind) {
  if (kind === 'daily') return badge('確定分', 'good');
  const completion = monthlyCompletion(item?.month, item?.todayKey);
  if (completion === 'partial') return badge('途中集計', 'warning');
  if (completion === 'final') return badge('確定分', 'good');
  return badge('確定状況不明', 'muted');
}

function historyComparison(periods) {
  const section = element('section', 'history-comparison');
  section.append(element('h3', '', '2期間の比較'));
  if (periods.length < 1) {
    section.append(element('p', 'empty', '比較できる期間がありません。'));
    return section;
  }
  const controls = element('div', 'history-compare-controls');
  const makeSelect = (label, value, onChange) => {
    const field = element('label', '', label);
    const select = document.createElement('select');
    for (const period of periods) {
      const option = element('option', '', period);
      option.value = period;
      select.append(option);
    }
    select.value = periods.includes(value) ? value : periods[0];
    select.addEventListener('change', onChange);
    field.append(select);
    return field;
  };
  controls.append(
    makeSelect('期間A', usageHistory.compareLeft, (event) => {
      usageHistory.compareLeft = event.target.value;
      renderUsageHistoryResults();
    }),
    makeSelect('期間B', usageHistory.compareRight, (event) => {
      usageHistory.compareRight = event.target.value;
      renderUsageHistoryResults();
    }),
  );
  section.append(controls, element('p', 'history-help', '差分は期間Bから期間Aを引いた値です。片方の期間に値がない端末・ツールは「未取得」とし、差分を算出しません。'));
  const rows = compareHistoryItems(usageHistory.items, {
    kind: usageHistory.kind,
    leftPeriod: usageHistory.compareLeft,
    rightPeriod: usageHistory.compareRight,
  });
  const table = element('table', 'history-table');
  const head = document.createElement('thead');
  const heading = document.createElement('tr');
  for (const text of ['Hub・端末・ツール', `期間A ${usageHistory.compareLeft ?? ''}`, `期間B ${usageHistory.compareRight ?? ''}`, '差分（B − A）']) heading.append(element('th', '', text));
  head.append(heading);
  const body = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    const identity = element('td');
    identity.append(element('strong', '', row.hubId ?? 'Hub未取得'), element('span', '', row.deviceId ?? '端末ID未取得'), element('span', '', row.tool ?? 'ツール未取得'));
    const left = element('td');
    left.append(historyValueLines(row.left));
    if (usageHistory.kind === 'monthly' && row.left) left.append(historyPeriodBadge(row.left, usageHistory.kind));
    const right = element('td');
    right.append(historyValueLines(row.right));
    if (usageHistory.kind === 'monthly' && row.right) right.append(historyPeriodBadge(row.right, usageHistory.kind));
    const delta = element('td');
    const values = element('div', 'history-values');
    values.append(
      element('span', '', signedHistoryText(row.tokenDifference, preciseNumber, ' tokens')),
      element('span', '', signedHistoryText(row.costDifference, preciseNumber, ' USD')),
    );
    delta.append(values);
    tr.append(identity, left, right, delta);
    body.append(tr);
  }
  table.append(head, body);
  const wrapper = element('div', 'history-table-wrap');
  wrapper.append(table);
  section.append(wrapper);
  return section;
}

function historyRows() {
  const section = element('section', 'history-browse');
  section.append(element('h3', '', usageHistory.kind === 'daily' ? '日次履歴' : '月次履歴'));
  const table = element('table', 'history-table');
  const head = document.createElement('thead');
  const heading = document.createElement('tr');
  const periodLabel = usageHistory.kind === 'daily' ? '端末現地日付' : '端末現地月';
  for (const text of ['Hub', '端末', 'ツール', periodLabel, 'トークン数', 'API換算額', '確定状況', '取得情報']) heading.append(element('th', '', text));
  head.append(heading);
  const body = document.createElement('tbody');
  for (const item of usageHistory.items.slice(0, usageHistory.visibleCount)) {
    const row = document.createElement('tr');
    const period = usageHistory.kind === 'daily' ? item.date : item.month;
    row.append(
      element('td', '', item.hubId ?? '未取得'),
      element('td', '', item.deviceId ?? '未取得'),
      element('td', '', item.tool ?? '未取得'),
      element('td', 'history-period', period ?? '未取得'),
      element('td', '', typeof item.tokens === 'number' && Number.isFinite(item.tokens) ? preciseNumber.format(item.tokens) : '未取得'),
      element('td', '', typeof item.cost === 'number' && Number.isFinite(item.cost) ? money.format(item.cost) : '未取得'),
    );
    const status = element('td');
    status.append(historyPeriodBadge(item, usageHistory.kind));
    const metadata = element('td', 'history-metadata');
    metadata.append(
      element('span', '', item.timeZone ? `タイムゾーン ${item.timeZone}` : 'タイムゾーン 未取得'),
      element('span', '', item.todayKey ? `取得時の端末日付 ${item.todayKey}` : '取得時の端末日付 未取得'),
      element('span', '', `履歴取得 ${formattedTime(item.fetchedAt)}`),
    );
    row.append(status, metadata);
    body.append(row);
  }
  table.append(head, body);
  const wrapper = element('div', 'history-table-wrap');
  wrapper.append(table);
  section.append(wrapper);
  if (usageHistory.visibleCount < usageHistory.items.length) {
    const more = element('button', 'history-more', `さらに表示（残り${usageHistory.items.length - usageHistory.visibleCount}件）`);
    more.type = 'button';
    more.addEventListener('click', () => {
      usageHistory.visibleCount += 100;
      renderUsageHistoryResults();
    });
    section.append(more);
  }
  return section;
}

function renderUsageHistoryResults() {
  if (!usageHistoryResults) return;
  const fragment = document.createDocumentFragment();
  if (usageHistory.loading) fragment.append(element('p', 'history-loading', '対象範囲の全ページを取得中…'));
  if (usageHistory.error) {
    fragment.append(element('p', 'error-detail', `${usageHistory.error}${usageHistory.loaded ? ' 以前に表示した履歴は保持しています。' : ''}`));
  }
  if (!usageHistory.loaded) {
    if (!usageHistory.loading && !usageHistory.error) fragment.append(element('p', 'empty', '条件を指定して履歴を取得してください。'));
    usageHistoryResults.replaceChildren(fragment);
    return;
  }
  fragment.append(element('p', 'history-result-summary', `${usageHistory.items.length}件を${usageHistory.pageCount}ページから取得しました。比較は対象範囲の全ページを使用しています。`));
  if (!usageHistory.items.length) fragment.append(element('p', 'empty', '条件に一致する保存済み履歴はありません。'));
  else fragment.append(historyComparison(historyPeriods(usageHistory.items, usageHistory.kind)), historyRows());
  usageHistoryResults.replaceChildren(fragment);
}

function resetUsageHistoryForKind() {
  usageHistory.requestId += 1;
  usageHistory.items = [];
  usageHistory.loaded = false;
  usageHistory.loading = false;
  usageHistory.error = null;
  usageHistory.pageCount = 0;
  usageHistory.kind = historyKind?.value ?? 'daily';
  usageHistory.compareLeft = null;
  usageHistory.compareRight = null;
  if (historyFrom) { historyFrom.type = usageHistory.kind === 'monthly' ? 'month' : 'date'; historyFrom.value = ''; }
  if (historyTo) { historyTo.type = usageHistory.kind === 'monthly' ? 'month' : 'date'; historyTo.value = ''; }
  if (historyFetch) { historyFetch.disabled = false; historyFetch.textContent = '履歴を取得'; }
  renderUsageHistoryResults();
}

function hubManagementView(state) {
  const hubs = Array.isArray(state?.hubs) ? state.hubs : [];
  if (!hubs.length) return element('p', 'empty', '登録済みのHubはありません。');
  const table = element('table', 'history-table');
  const head = document.createElement('thead');
  const heading = document.createElement('tr');
  for (const text of ['ID', 'URL', '接続状態', '収集状態']) heading.append(element('th', '', text));
  head.append(heading);
  const body = document.createElement('tbody');
  for (const hub of hubs) {
    const status = hub.status ?? {};
    const row = document.createElement('tr');
    row.append(element('td', '', stringValue(hub.id) ?? 'ID未取得'), element('td', '', stringValue(hub.url) ?? '接続設定なし'));
    const connection = element('td');
    connection.append(badge(status.connection === 'connected' ? 'Hub 接続正常' : '未接続', status.connection === 'connected' ? 'good' : 'muted'));
    const collection = element('td');
    const stopped = hub.collectionEnabled === false || status.collectionStopped === true;
    collection.append(badge(stopped ? '収集停止' : '収集中', stopped ? 'warning' : 'good'));
    row.append(connection, collection);
    body.append(row);
  }
  table.append(head, body);
  const wrapper = element('div', 'history-table-wrap');
  wrapper.append(table);
  return wrapper;
}

function renderHubManagement(state) {
  if (hubList) hubList.replaceChildren(hubManagementView(state));
  if (!hubMockNote) return;
  // Mockモードのときだけ、登録練習用のHubを案内する。実データでは項目自体が返らない。
  const mock = state?.mockRegistration;
  hubMockNote.hidden = !mock;
  hubMockNote.textContent = mock ? `登録練習用のモック Hub: ${mock.url}（シークレット: ${mock.secret}）` : '';
}

async function registerHub(event) {
  event.preventDefault();
  const show = (className, text) => hubRegistrationResult?.replaceChildren(element('p', className, text));
  const body = JSON.stringify({
    id: hubIdInput?.value ?? '', url: hubUrlInput?.value ?? '', secret: hubSecretInput?.value ?? '',
  });
  if (hubRegisterButton) hubRegisterButton.disabled = true;
  try {
    const response = await fetch('/api/hubs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    const payload = await response.json().catch(() => ({}));
    if (response.ok) {
      hubForm.reset();
      show('history-result-summary', `${payload.id} を登録しました。収集を開始しています。`);
    } else {
      show('error-detail', registrationErrors[payload.error] ?? '登録できませんでした。');
    }
  } catch {
    show('error-detail', '登録要求を送信できませんでした。');
  } finally {
    if (hubRegisterButton) hubRegisterButton.disabled = false;
  }
}

function render(state) {
  latestState = state;
  const hubs = Array.isArray(state?.hubs) ? state.hubs : [];
  if (state?.mode === 'real' || state?.mode === 'mock') {
    const modeLabel = state.mode === 'mock' ? 'Mock データ' : '実データ';
    if (scopeNote) scopeNote.textContent = modeLabel;
    document.title = `${modeLabel} · Token Monitor Analytics`;
  }
  const storage = state.storage;
  if (storageStatus) {
    storageStatus.hidden = storage.state === 'normal';
    storageStatus.textContent = storage.state === 'normal' ? '' : `${storage.message}：全Hubの保存を停止しています。最後に表示できた保存値と日時を維持しています。`;
  }
  if (overallRoot) overallRoot.replaceChildren(overallView(state));
  if (contractRoot) contractRoot.replaceChildren(contractsView(state));
  if (estimateRoot) estimateRoot.replaceChildren(estimates(state));
  if (historyCollectionStatus) historyCollectionStatus.replaceChildren(historyStatusView(state));
  renderHubManagement(state);
  updateHistoryOptions(state);
  const fragment = document.createDocumentFragment();
  for (const hub of hubs) {
    const card = element('section', 'hub');
    const heading = element('div', 'hub-heading');
    const title = element('div');
    title.append(element('p', 'eyebrow', 'HUB'), element('h2', '', hub.id));
    heading.append(title);
    const badges = element('div', 'badges');
    const status = hub.status ?? {};
    if (status.configuration === 'invalid') badges.append(badge('設定不正', 'danger'));
    if (status.configuration === 'missing') badges.append(badge('接続設定なし', 'warning'));
    if (!hub.collectionEnabled || status.collectionStopped === true) badges.append(badge('収集停止', 'warning'));
    badges.append(badge(status.connection === 'connected' ? 'Hub 接続正常' : '未接続', status.connection === 'connected' ? 'good' : 'muted'));
    badges.append(badge(storage.state === 'normal' ? '保存正常' : storage.message, storage.state === 'normal' ? 'muted' : 'danger'));
    heading.append(badges);
    card.append(heading);
    for (const error of [status.configurationError, status.connectionDetail, status.validationError]) {
      if (error) card.append(element('p', 'error-detail', error));
    }
    const total = element('div', 'hub-total');
    total.append(element('p', 'section-label', 'Hub全体 · API換算額（USD）'), metrics(hub.metrics?.periods));
    total.append(sourceDisclosure(hub.metrics?.excludedSources, state, {
      id: `metrics:hub:${hub.id}:excluded`,
      label: '利用額の集計から除外した端末',
    }));
    total.append(timestamps('Hub 最終更新日時（データ側）', hub.aggregate?.updatedAt, hub.receivedAt));
    total.append(limits(hub.aggregate?.limits, { state, hub }));
    card.append(total);
    const devices = Array.isArray(hub.devices) ? hub.devices : [];
    for (const device of devices) card.append(deviceCard(device, state, hub));
    if (!devices.length) card.append(element('p', 'empty', '保存済みの端末データはありません。'));
    fragment.append(card);
  }
  if (!hubs.length) fragment.append(element('p', 'empty', 'Hubの接続設定を追加して再起動してください。'));
  if (hubRoot) hubRoot.replaceChildren(fragment);
  if (state?.phase === 'stopping' && browserStatus) {
    browserStatus.textContent = 'アプリ終了中';
    browserStatus.className = 'badge warning';
  }
}

const connection = new EventSource('/api/events');
connection.onopen = () => { browserStatus.textContent = 'ブラウザ 接続正常'; browserStatus.className = 'badge good'; };
connection.onerror = () => { browserStatus.textContent = 'ブラウザ 未接続・再接続中'; browserStatus.className = 'badge warning'; };
for (const event of ['status', 'update']) connection.addEventListener(event, (message) => render(JSON.parse(message.data)));
showNotConfigured?.addEventListener('change', () => { if (latestState) render(latestState); });
usageHistoryForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  loadUsageHistory();
});
historyKind?.addEventListener('change', resetUsageHistoryForKind);
hubForm?.addEventListener('submit', registerHub);
