(function () {
  'use strict';

  var API_EVENTS = '/api/events';
  var PERIODS = [
    { key: 'today', label: '今日' },
    { key: 'month', label: '今月' },
    { key: 'allTime', label: '全期間' }
  ];
  var STATUS_CLASS_NAMES = [
    'normal',
    'connected',
    'open',
    'latest',
    'ok',
    'disconnected',
    'closed',
    'offline',
    'storage-failure',
    'invalid-data',
    'stale',
    'reconnecting',
    'warning',
    'no-data',
    'pending',
    'connecting',
    'unknown'
  ];

  var elements = {
    refreshButton: document.getElementById('refresh-button'),
    transportMessage: document.getElementById('transport-message'),
    browserConnectionCard: document.getElementById('browser-connection-card'),
    browserConnectionBadge: document.getElementById('browser-connection-badge'),
    browserConnectionDetail: document.getElementById('browser-connection-detail'),
    analyticsConnectionCard: document.getElementById('analytics-connection-card'),
    analyticsConnectionBadge: document.getElementById('analytics-connection-badge'),
    analyticsConnectionDetail: document.getElementById('analytics-connection-detail'),
    dataConnectionCard: document.getElementById('data-connection-card'),
    dataConnectionBadge: document.getElementById('data-connection-badge'),
    dataConnectionDetail: document.getElementById('data-connection-detail'),
    estimationValue: document.getElementById('estimation-value'),
    estimationDetail: document.getElementById('estimation-detail'),
    hubCountValue: document.getElementById('hub-count-value'),
    hubCountDetail: document.getElementById('hub-count-detail'),
    latestValue: document.getElementById('latest-value'),
    latestDetail: document.getElementById('latest-detail'),
    snapshotCountValue: document.getElementById('snapshot-count-value'),
    snapshotCountDetail: document.getElementById('snapshot-count-detail'),
    hubList: document.getElementById('hub-list')
  };

  var dateFormatter = new Intl.DateTimeFormat('ja-JP', {
    dateStyle: 'medium',
    timeStyle: 'medium'
  });
  var numberFormatter = new Intl.NumberFormat('ja-JP', {
    maximumFractionDigits: 2
  });
  var integerFormatter = new Intl.NumberFormat('ja-JP', {
    maximumFractionDigits: 0
  });
  var compactNumberFormatter = new Intl.NumberFormat('ja-JP', {
    notation: 'compact',
    maximumFractionDigits: 1
  });
  var usdFormatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 6
  });

  var committedState = null;
  var lastDataIssue = '';
  var browserOnline = typeof navigator.onLine !== 'boolean' || navigator.onLine;
  var analyticsState = 'connecting';
  var analyticsHasOpened = false;
  var eventSource = null;

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function hasOwn(object, key) {
    return isRecord(object) && Object.prototype.hasOwnProperty.call(object, key);
  }

  function makeElement(tagName, className, text) {
    var node = document.createElement(tagName);
    if (className) {
      node.className = className;
    }
    if (text !== undefined && text !== null) {
      node.textContent = String(text);
    }
    return node;
  }

  function clearElement(node) {
    while (node && node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  function appendChildren(parent, children) {
    children.forEach(function (child) {
      if (child) {
        parent.appendChild(child);
      }
    });
    return parent;
  }

  function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function scalarText(value, fallback) {
    if (value === null || value === undefined || value === '') {
      return fallback || '未取得';
    }
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return numberFormatter.format(value);
    }
    if (typeof value === 'boolean') {
      return value ? 'はい' : 'いいえ';
    }
    return fallback || '詳細を展開';
  }

  function plainNumber(value) {
    return isFiniteNumber(value) ? numberFormatter.format(value) : '未取得';
  }

  function countNumber(value) {
    return isFiniteNumber(value) ? integerFormatter.format(value) : '未取得';
  }

  function tokenText(value) {
    if (!isFiniteNumber(value)) {
      return '未取得';
    }
    if (Math.abs(value) < 10000) {
      return integerFormatter.format(value);
    }
    return compactNumberFormatter.format(value);
  }

  function amountText(value) {
    return isFiniteNumber(value) ? usdFormatter.format(value) : '未取得';
  }

  function percentText(value) {
    return isFiniteNumber(value) ? numberFormatter.format(value) + '%' : '未取得';
  }

  function asDate(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return new Date(Math.abs(value) < 1000000000000 ? value * 1000 : value);
    }
    if (typeof value === 'string' && value.trim()) {
      return new Date(value);
    }
    return null;
  }

  function dateText(value) {
    if (value === null || value === undefined || value === '') {
      return '未取得';
    }
    var date = asDate(value);
    if (date && !Number.isNaN(date.getTime())) {
      return dateFormatter.format(date);
    }
    return scalarText(value, '時刻を解釈できません');
  }

  function createTimestamp(label, value) {
    var item = makeElement('div', 'timestamp-item');
    var labelNode = makeElement('span', 'timestamp-label', label);
    var timeNode = makeElement('time', 'timestamp-value', dateText(value));
    var date = asDate(value);
    if (date && !Number.isNaN(date.getTime())) {
      timeNode.dateTime = date.toISOString();
      if (value !== undefined && value !== null) {
        timeNode.title = String(value);
      }
    }
    item.appendChild(labelNode);
    item.appendChild(timeNode);
    return item;
  }

  function setStatusClasses(node, key) {
    if (!node) {
      return;
    }
    STATUS_CLASS_NAMES.forEach(function (name) {
      node.classList.remove('status-' + name);
    });
    node.classList.add('status-' + key);
  }

  function createStatusPill(key, label) {
    var pill = makeElement('span', 'status-pill');
    setStatusClasses(pill, key);
    pill.textContent = label;
    return pill;
  }

  function setStatusPill(node, key, label) {
    setStatusClasses(node, key);
    node.textContent = label;
  }

  function issueValue(value) {
    if (typeof value === 'string') {
      return value.trim();
    }
    if (value === null || value === undefined) {
      return '';
    }
    return scalarText(value, 'エラー詳細を表示できません');
  }

  function hubStatus(hub) {
    var storageError = issueValue(hub && hub.storageError);
    var validationError = issueValue(hub && hub.validationError);
    var connectionError = issueValue(hub && hub.connectionError);
    if (storageError) {
      return {
        key: 'storage-failure',
        label: '保存失敗',
        detail: '保存に失敗しました。前回保存済みの値があれば表示を維持しています。'
      };
    }
    if (validationError) {
      return {
        key: 'invalid-data',
        label: '不正データ',
        detail: '入力検証に失敗しました。保存済みの値があれば表示を維持しています。'
      };
    }
    if (hub && hub.connection === 'disconnected') {
      return {
        key: 'disconnected',
        label: '未接続',
        detail: connectionError || 'Hubとの接続がありません。自動再接続を待っています。'
      };
    }
    if (hub && hub.connection === 'connected' && isRecord(hub.snapshot)) {
      return {
        key: 'normal',
        label: '正常',
        detail: '最新の保存済みスナップショットを表示しています。'
      };
    }
    if (hub && hub.connection === 'connected') {
      return {
        key: 'no-data',
        label: '未取得',
        detail: '接続中ですが、保存済みスナップショットはありません。'
      };
    }
    return {
      key: 'unknown',
      label: '状態不明',
      detail: connectionError || 'Hubの状態を確認できません。'
    };
  }

  function statusSummary(state) {
    if (!state || !Array.isArray(state.hubs)) {
      return {
        key: 'no-data',
        label: '未取得',
        detail: '有効な状態をまだ受信していません。'
      };
    }
    if (state.hubs.some(function (hub) { return hubStatus(hub).key === 'storage-failure'; })) {
      return {
        key: 'storage-failure',
        label: '保存失敗あり',
        detail: '一部Hubで保存に失敗しています。表示中の保存済み値は維持しています。'
      };
    }
    if (state.hubs.some(function (hub) { return hubStatus(hub).key === 'invalid-data'; })) {
      return {
        key: 'invalid-data',
        label: '不正データあり',
        detail: '一部Hubの入力検証に失敗しています。影響するHubを分けて表示しています。'
      };
    }
    if (state.hubs.some(function (hub) { return hubStatus(hub).key === 'disconnected'; })) {
      return {
        key: 'disconnected',
        label: '未接続あり',
        detail: '一部Hubが未接続です。各Hubの保存済み値を確認できます。'
      };
    }
    if (state.hubs.some(function (hub) { return hubStatus(hub).key === 'no-data'; })) {
      return {
        key: 'no-data',
        label: '未取得あり',
        detail: '接続済みでも保存済みスナップショットがないHubがあります。'
      };
    }
    if (state.hubs.some(function (hub) { return hubStatus(hub).key === 'unknown'; })) {
      return {
        key: 'unknown',
        label: '状態不明あり',
        detail: '一部Hubの状態を確認できません。'
      };
    }
    return {
      key: 'normal',
      label: '正常',
      detail: '受信した状態を表示しています。'
    };
  }

  function validApiState(value) {
    if (!isRecord(value) || !Array.isArray(value.hubs)) {
      return false;
    }
    return value.hubs.every(function (hub) {
      if (!isRecord(hub)) {
        return false;
      }
      return !hasOwn(hub, 'connection') || hub.connection === 'connected' || hub.connection === 'disconnected';
    });
  }

  function applyState(candidate, sourceLabel) {
    if (!validApiState(candidate)) {
      lastDataIssue = sourceLabel + 'から不正な状態データを受信しました。表示中の状態を維持しています。';
      renderCommunication();
      return false;
    }
    committedState = candidate;
    lastDataIssue = '';
    renderPage();
    return true;
  }

  function findLatestTimestamp(hubs) {
    var candidates = [];
    hubs.forEach(function (hub) {
      if (!isRecord(hub) || !isRecord(hub.snapshot)) {
        return;
      }
      if (hasOwn(hub.snapshot, 'upstreamAt')) {
        candidates.push(hub.snapshot.upstreamAt);
      }
    });
    var latest = null;
    var latestDate = null;
    candidates.forEach(function (candidate) {
      var date = asDate(candidate);
      if (!date || Number.isNaN(date.getTime())) {
        if (latest === null) {
          latest = candidate;
        }
        return;
      }
      if (latestDate === null || date.getTime() > latestDate.getTime()) {
        latest = candidate;
        latestDate = date;
      }
    });
    return latest;
  }

  function updateOverview() {
    if (!committedState) {
      elements.estimationValue.textContent = '推定機能は未実装';
      elements.estimationDetail.textContent = '現在値を受信すると、取得情報を表示します。';
      elements.hubCountValue.textContent = '未取得';
      elements.hubCountDetail.textContent = 'Hubの状態を確認しています。';
      elements.latestValue.textContent = '未取得';
      elements.latestDetail.textContent = 'Hubの上流更新時刻です。';
      elements.snapshotCountValue.textContent = '未取得';
      elements.snapshotCountDetail.textContent = '前回保存値の有無を表示します。';
      return;
    }

    if (committedState.estimation === 'notImplemented' || committedState.estimation === undefined || committedState.estimation === null) {
      elements.estimationValue.textContent = '推定機能は未実装';
      elements.estimationDetail.textContent = '取得できた実測値の表示を続けています。契約別の推定は行いません。';
    } else {
      elements.estimationValue.textContent = scalarText(committedState.estimation, '推定状態を確認できません');
      elements.estimationDetail.textContent = 'APIから返された推定状態です。';
    }

    var hubs = committedState.hubs;
    var connectedCount = hubs.filter(function (hub) { return hub.connection === 'connected'; }).length;
    var disconnectedCount = hubs.filter(function (hub) { return hub.connection === 'disconnected'; }).length;
    elements.hubCountValue.textContent = countNumber(hubs.length) + '件';
    elements.hubCountDetail.textContent = countNumber(connectedCount) + '件 接続 / ' + countNumber(disconnectedCount) + '件 未接続';

    var latest = findLatestTimestamp(hubs);
    elements.latestValue.textContent = dateText(latest);
    elements.latestDetail.textContent = latest === null || latest === undefined ? '上流の更新時刻は未取得です。' : 'Hubの上流更新時刻です。表示時刻: ' + dateText(latest);

    var snapshots = hubs.filter(function (hub) { return isRecord(hub.snapshot); }).length;
    elements.snapshotCountValue.textContent = countNumber(snapshots) + ' / ' + countNumber(hubs.length);
    elements.snapshotCountDetail.textContent = '保存済み / 全Hub。未取得値をゼロ補完していません。';
  }

  function setConnectionCard(card, badge, detail, key, label, detailText) {
    setStatusClasses(card, key);
    setStatusPill(badge, key, label);
    detail.textContent = detailText;
  }

  function renderCommunication() {
    if (browserOnline) {
      setConnectionCard(
        elements.browserConnectionCard,
        elements.browserConnectionBadge,
        elements.browserConnectionDetail,
        'open',
        'オンライン',
        'ブラウザのネットワーク接続は利用可能です。'
      );
    } else {
      setConnectionCard(
        elements.browserConnectionCard,
        elements.browserConnectionBadge,
        elements.browserConnectionDetail,
        'offline',
        'オフライン',
        'ブラウザがオフラインです。Analyticsとの通信も復旧待ちです。'
      );
    }

    if (analyticsState === 'open') {
      setConnectionCard(
        elements.analyticsConnectionCard,
        elements.analyticsConnectionBadge,
        elements.analyticsConnectionDetail,
        'open',
        '接続中',
        'SSEで状態更新を受信しています。'
      );
    } else if (analyticsState === 'reconnecting') {
      setConnectionCard(
        elements.analyticsConnectionCard,
        elements.analyticsConnectionBadge,
        elements.analyticsConnectionDetail,
        'reconnecting',
        '切断・再接続中',
        'Analyticsとの通信が切断されています。ブラウザが再接続を試みています。'
      );
    } else {
      setConnectionCard(
        elements.analyticsConnectionCard,
        elements.analyticsConnectionBadge,
        elements.analyticsConnectionDetail,
        'connecting',
        '接続中',
        'Analyticsの状態ストリームへ接続しています。'
      );
    }

    var summary = statusSummary(committedState);
    setConnectionCard(
      elements.dataConnectionCard,
      elements.dataConnectionBadge,
      elements.dataConnectionDetail,
      summary.key,
      summary.label,
      summary.detail
    );

    if (lastDataIssue) {
      elements.transportMessage.textContent = lastDataIssue;
    } else if (analyticsState === 'reconnecting') {
      elements.transportMessage.textContent = 'Analyticsとの通信断を検知しています。再接続後に状態を更新します。';
    } else if (analyticsState === 'open') {
      elements.transportMessage.textContent = '状態ストリームを監視しています。';
    } else {
      elements.transportMessage.textContent = 'Analyticsの状態ストリームへ接続しています。';
    }
  }

  function renderPage() {
    updateOverview();
    renderCommunication();
    clearElement(elements.hubList);
    elements.hubList.setAttribute('aria-busy', 'false');

    if (!committedState) {
      elements.hubList.appendChild(createEmptyState('現在値をまだ取得できません。', '通信状態を確認しながら、保存済みの状態を待っています。'));
      return;
    }
    if (committedState.hubs.length === 0) {
      elements.hubList.appendChild(createEmptyState('Hubが登録されていません。', 'Hubが登録されると、ここに現在値が表示されます。'));
      return;
    }
    committedState.hubs.forEach(function (hub, index) {
      elements.hubList.appendChild(renderHub(hub, index));
    });
  }

  function createEmptyState(message, detail) {
    var state = makeElement('div', 'empty-state');
    state.appendChild(makeElement('p', '', message));
    if (detail) {
      state.appendChild(makeElement('p', 'empty-inline', detail));
    }
    return state;
  }

  function createSectionHeading(title, caption) {
    var heading = makeElement('div', 'subsection-heading');
    heading.appendChild(makeElement('h4', '', title));
    if (caption) {
      heading.appendChild(makeElement('p', 'subsection-caption', caption));
    }
    return heading;
  }

  function renderHub(hub, index) {
    var status = hubStatus(hub);
    var card = makeElement('article', 'hub-card status-card-' + status.key);
    var header = makeElement('header', 'hub-card-header');
    var titleWrap = makeElement('div', 'hub-title-wrap');
    titleWrap.appendChild(makeElement('p', 'kicker', 'Hub ' + countNumber(index + 1)));
    titleWrap.appendChild(makeElement('h3', '', scalarText(hub.name, '名前未設定')));
    titleWrap.appendChild(makeElement('span', 'hub-id', 'ID: ' + scalarText(hub.id, '未取得')));
    var statusWrap = makeElement('div', 'hub-status-wrap');
    statusWrap.appendChild(createStatusPill(status.key, status.label));
    statusWrap.appendChild(makeElement('p', 'status-explainer', status.detail));
    appendChildren(header, [titleWrap, statusWrap]);
    card.appendChild(header);

    var alerts = makeElement('div', 'hub-alerts');
    appendHubIssue(alerts, '通信エラー', hub.connectionError, false);
    appendHubIssue(alerts, '不正データ', hub.validationError, true);
    appendHubIssue(alerts, '保存失敗', hub.storageError, true);
    if (alerts.childNodes.length) {
      card.appendChild(alerts);
    }

    if (!isRecord(hub.snapshot)) {
      var noSnapshot = makeElement('div', 'snapshot-shell');
      noSnapshot.appendChild(createEmptyState('保存済みスナップショットは未取得です。', '利用枠や集計値をゼロとして扱っていません。'));
      card.appendChild(noSnapshot);
      return card;
    }

    var snapshot = hub.snapshot;
    var shell = makeElement('div', 'snapshot-shell');
    var snapshotTopline = makeElement('div', 'snapshot-topline');
    var snapshotTitle = makeElement('div');
    snapshotTitle.appendChild(makeElement('h4', '', '保存済みスナップショット'));
    snapshotTitle.appendChild(makeElement('p', '', status.key === 'normal' ? '現在参照できるHubの保存値です。' : '障害発生時も最後に保存できた値を保持して表示しています。'));
    snapshotTopline.appendChild(snapshotTitle);
    snapshotTopline.appendChild(makeElement('span', 'snapshot-id', 'スナップショットID: ' + scalarText(snapshot.id, '未取得')));
    shell.appendChild(snapshotTopline);

    var timestamps = makeElement('div', 'timestamp-grid');
    timestamps.appendChild(createTimestamp('上流更新時刻', snapshot.upstreamAt));
    timestamps.appendChild(createTimestamp('Analytics受信時刻', snapshot.receivedAt));
    timestamps.appendChild(createTimestamp('保存時刻', snapshot.savedAt));
    shell.appendChild(timestamps);

    if (isRecord(snapshot.stats)) {
      var stats = snapshot.stats;
      shell.appendChild(renderStatsSection(
        stats.periods,
        'Hub集計（端末横断）',
        'このHubに属する端末の集計です。契約・利用枠への配分は行いません。',
        stats.updatedAt
      ));
      shell.appendChild(renderLimits(stats.limits, 'Hub集約の利用枠（プロバイダー別）'));
      shell.appendChild(renderDevices(stats.devices));
      var statsExtra = createExtraDetails('集計の追加情報', stats, ['updatedAt', 'periods', 'limits', 'devices']);
      if (statsExtra) {
        shell.appendChild(statsExtra);
      }
    } else {
      shell.appendChild(createEmptyState('集計値は未取得です。', 'スナップショットはありますが、statsが返されていません。'));
    }

    var snapshotExtra = createExtraDetails('スナップショットの追加情報', snapshot, ['id', 'upstreamAt', 'receivedAt', 'savedAt', 'stats']);
    if (snapshotExtra) {
      shell.appendChild(snapshotExtra);
    }
    card.appendChild(shell);
    return card;
  }

  function appendHubIssue(parent, label, value, warning) {
    var issue = issueValue(value);
    if (!issue) {
      return;
    }
    var line = makeElement('div', warning ? 'alert-line alert-warning' : 'alert-line');
    line.appendChild(makeElement('span', 'alert-label', label));
    line.appendChild(makeElement('span', '', issue));
    parent.appendChild(line);
  }

  function renderStatsSection(periods, title, caption, updatedAt) {
    var section = makeElement('section', 'content-section');
    var headingCaption = caption;
    if (updatedAt !== undefined) {
      headingCaption += ' 集計更新: ' + dateText(updatedAt);
    }
    var heading = createSectionHeading(title, headingCaption);
    if (updatedAt !== undefined && asDate(updatedAt) && !Number.isNaN(asDate(updatedAt).getTime())) {
      heading.lastChild.title = String(updatedAt);
    }
    section.appendChild(heading);
    if (!isRecord(periods)) {
      section.appendChild(makeElement('p', 'empty-inline', '期間集計は未取得です。'));
      return section;
    }
    var grid = makeElement('div', 'period-grid');
    PERIODS.forEach(function (periodDefinition) {
      grid.appendChild(renderPeriod(periodDefinition, periods[periodDefinition.key]));
    });
    section.appendChild(grid);
    return section;
  }

  function renderPeriod(definition, period) {
    var card = makeElement('article', 'period-card');
    var heading = makeElement('div', 'period-card-heading');
    heading.appendChild(makeElement('h5', '', definition.label));
    heading.appendChild(makeElement('p', '', '集計期間: ' + definition.key));
    card.appendChild(heading);

    var metrics = makeElement('div', 'metric-stack');
    var amountMetric = createMetricRow('API換算額（この集計単位）', amountText(period && period.costUsd));
    if (period && isFiniteNumber(period.costUsd)) {
      amountMetric.lastChild.title = amountText(period.costUsd);
    }
    metrics.appendChild(amountMetric);
    var tokenMetric = createMetricRow('総トークン', tokenText(period && period.totalTokens));
    if (period && isFiniteNumber(period.totalTokens)) {
      tokenMetric.lastChild.title = integerFormatter.format(period.totalTokens);
    }
    metrics.appendChild(tokenMetric);
    card.appendChild(metrics);

    card.appendChild(renderBreakdown('API換算額・ツール別', period && period.clientCosts));
    card.appendChild(renderBreakdown('API換算額・モデル別', period && period.modelCosts));
    var extra = createExtraDetails('期間集計の追加情報', period, ['costUsd', 'totalTokens', 'clientCosts', 'modelCosts']);
    if (extra) {
      card.appendChild(extra);
    }
    return card;
  }

  function createMetricRow(label, value) {
    var row = makeElement('div', 'metric-row');
    row.appendChild(makeElement('span', 'metric-label', label));
    row.appendChild(makeElement('strong', 'metric-value', value));
    return row;
  }

  function renderBreakdown(title, values) {
    var group = makeElement('section', 'breakdown-group');
    group.appendChild(makeElement('h5', 'breakdown-heading', title));
    if (!isRecord(values) || Object.keys(values).length === 0) {
      group.appendChild(makeElement('p', 'empty-inline', '項目は未取得です。'));
      return group;
    }
    var list = makeElement('ul', 'breakdown-list');
    Object.keys(values).sort().forEach(function (name) {
      var row = makeElement('li', 'breakdown-row');
      row.appendChild(makeElement('span', '', name));
      row.appendChild(makeElement('span', '', amountText(values[name])));
      list.appendChild(row);
    });
    group.appendChild(list);
    return group;
  }

  function renderLimits(limits, title) {
    var section = makeElement('section', 'content-section limits-section');
    section.appendChild(createSectionHeading(title, 'プロバイダーごとの利用枠を分けて表示します。'));
    if (limits === null) {
      section.appendChild(makeElement('p', 'empty-inline', '利用枠情報はありません（上流値: null）。未取得とは区別して表示しています。'));
      return section;
    }
    if (limits === undefined) {
      section.appendChild(makeElement('p', 'empty-inline', '利用枠情報は未取得です（項目が返されていません）。'));
      return section;
    }
    if (isRecord(limits) && hasOwn(limits, 'providers') && limits.providers === null) {
      section.appendChild(makeElement('p', 'empty-inline', '利用枠情報はありません（上流値 providers: null）。未取得とは区別して表示しています。'));
      return section;
    }
    if (!isRecord(limits) || !Array.isArray(limits.providers)) {
      section.appendChild(makeElement('p', 'empty-inline', '利用枠情報の形式を確認できません。'));
      return section;
    }
    if (limits.providers.length === 0) {
      section.appendChild(makeElement('p', 'empty-inline', 'プロバイダー情報はありません。'));
      return section;
    }
    var grid = makeElement('div', 'limit-grid');
    limits.providers.forEach(function (provider, index) {
      grid.appendChild(renderProvider(provider, index));
    });
    section.appendChild(grid);
    var extra = createExtraDetails('利用枠集計の追加情報', limits, ['providers']);
    if (extra) {
      section.appendChild(extra);
    }
    return section;
  }

  function providerStatus(provider) {
    var stale = provider && provider.stale === true;
    var status = provider && provider.status;
    var normalized = typeof status === 'string' ? status.toLowerCase() : '';
    if (stale) {
      return { key: 'stale', label: '古い観測値' };
    }
    if (normalized === 'connected' || normalized === 'ok' || normalized === 'success' || normalized === 'ready' || normalized === 'fresh') {
      return { key: 'ok', label: '上流: ' + scalarText(status, '正常') };
    }
    if (normalized === 'error' || normalized === 'failed' || normalized === 'disconnected' || normalized === 'unavailable') {
      return { key: 'warning', label: '上流: ' + scalarText(status, '異常') };
    }
    return { key: 'unknown', label: hasOwn(provider, 'status') ? '上流: ' + scalarText(status, '未取得') : '上流状態未取得' };
  }

  function renderProvider(provider, index) {
    var data = isRecord(provider) ? provider : {};
    var card = makeElement('article', 'limit-card');
    var header = makeElement('header', 'limit-card-header');
    var titleWrap = makeElement('div', 'limit-title-wrap');
    var title = scalarText(data.accountLabel, '');
    if (!title || title === '未取得') {
      title = scalarText(data.planLabel, '');
    }
    if (!title || title === '未取得') {
      title = scalarText(data.provider, '');
    }
    if (!title || title === '未取得') {
      title = 'プロバイダー ' + countNumber(index + 1);
    }
    titleWrap.appendChild(makeElement('h5', '', title));
    if (hasOwn(data, 'accountKey')) {
      titleWrap.appendChild(makeElement('span', 'limit-account-key', 'アカウントキー: ' + scalarText(data.accountKey, '未取得')));
    }
    var statusWrap = makeElement('div', 'limit-status-wrap');
    var status = providerStatus(data);
    statusWrap.appendChild(createStatusPill(status.key, status.label));
    if (hasOwn(data, 'stale')) {
      statusWrap.appendChild(makeElement('span', 'stale-caption', data.stale === true ? 'stale: true' : 'stale: false'));
    } else {
      statusWrap.appendChild(makeElement('span', 'stale-caption', 'stale: 未指定'));
    }
    appendChildren(header, [titleWrap, statusWrap]);
    card.appendChild(header);

    var fields = makeElement('div', 'field-grid');
    appendProviderField(fields, data, 'provider', 'プロバイダー');
    appendProviderField(fields, data, 'accountLabel', 'アカウント表示名');
    appendProviderField(fields, data, 'planLabel', 'プラン');
    appendProviderField(fields, data, 'accountName', 'アカウント名');
    appendProviderField(fields, data, 'accountEmail', 'アカウントメール');
    appendProviderField(fields, data, 'status', '上流status');
    appendProviderField(fields, data, 'source', '取得元');
    appendProviderField(fields, data, 'sourceDetail', '取得元詳細', true);
    appendProviderField(fields, data, 'updatedAt', '上流更新時刻', false, 'date');
    appendProviderField(fields, data, 'balanceUsd', 'API換算残高', false, 'amount');
    appendProviderField(fields, data, 'balance', '残高');
    appendProviderField(fields, data, 'resetCredits', 'リセットクレジット', false, 'number');
    if (fields.childNodes.length) {
      card.appendChild(fields);
    }

    var windows = Array.isArray(data.windows) ? data.windows : [];
    if (windows.length === 0) {
      card.appendChild(makeElement('p', 'empty-inline', '利用枠ウィンドウは未取得です。'));
    } else {
      var windowList = makeElement('div', 'window-list');
      windows.forEach(function (windowData, windowIndex) {
        windowList.appendChild(renderWindow(windowData, windowIndex));
      });
      card.appendChild(windowList);
    }

    var known = [
      'provider', 'accountKey', 'accountLabel', 'planLabel', 'accountName', 'accountEmail',
      'status', 'source', 'sourceDetail', 'updatedAt', 'windows', 'balanceUsd', 'balance',
      'resetCredits', 'stale'
    ];
    var extra = createExtraDetails('プロバイダーの追加情報', data, known);
    if (extra) {
      card.appendChild(extra);
    }
    return card;
  }

  function appendProviderField(parent, provider, key, label, wide, type) {
    if (!hasOwn(provider, key)) {
      return;
    }
    var item = makeElement('div', 'field-item' + (wide ? ' field-item-wide' : ''));
    item.appendChild(makeElement('span', 'field-label', label));
    var value = makeElement('span', 'field-value');
    appendTypedValue(value, provider[key], type);
    item.appendChild(value);
    parent.appendChild(item);
  }

  function appendTypedValue(parent, value, type) {
    if (type === 'date') {
      parent.textContent = dateText(value);
      var date = asDate(value);
      if (date && !Number.isNaN(date.getTime())) {
        parent.title = String(value);
      }
      return;
    }
    if (type === 'amount') {
      parent.textContent = amountText(value);
      return;
    }
    if (type === 'number') {
      parent.textContent = plainNumber(value);
      return;
    }
    appendSafeValue(parent, value, 0);
  }

  function renderWindow(windowData, index) {
    var data = isRecord(windowData) ? windowData : {};
    var card = makeElement('article', 'window-card');
    var header = makeElement('header', 'window-card-header');
    var titleWrap = makeElement('div');
    var label = scalarText(data.label, '');
    if (!label || label === '未取得') {
      label = scalarText(data.kind, '');
    }
    if (!label || label === '未取得') {
      label = '利用枠 ' + countNumber(index + 1);
    }
    titleWrap.appendChild(makeElement('h5', '', label));
    if (hasOwn(data, 'limitId')) {
      titleWrap.appendChild(makeElement('span', 'window-limit-id', 'limitId: ' + scalarText(data.limitId, '未取得')));
    }
    var kindText = hasOwn(data, 'kind') ? scalarText(data.kind, '未取得') : '';
    var kindNode = makeElement('span', 'window-kind', kindText);
    appendChildren(header, [titleWrap, kindNode]);
    card.appendChild(header);

    var metrics = makeElement('div', 'window-metrics');
    appendWindowMetric(metrics, '消費率', data.usedPercent, 'percent');
    appendWindowMetric(metrics, '残り率', data.remainingPercent, 'percent');
    appendWindowMetric(metrics, '使用量', data.used);
    appendWindowMetric(metrics, '上限', data.limit);
    appendWindowMetric(metrics, '残り', data.remaining);
    appendWindowMetric(metrics, 'リセット時刻', data.resetsAt, 'date');
    card.appendChild(metrics);

    if (data.showMeter !== false && isFiniteNumber(data.usedPercent)) {
      var meterWrap = makeElement('div', 'meter-wrap');
      var meterCaption = makeElement('div', 'meter-caption');
      meterCaption.appendChild(makeElement('span', '', '消費率メーター'));
      meterCaption.appendChild(makeElement('strong', '', percentText(data.usedPercent)));
      var meter = makeElement('div', 'meter-track');
      meter.setAttribute('role', 'progressbar');
      meter.setAttribute('aria-label', '消費率');
      meter.setAttribute('aria-valuemin', '0');
      meter.setAttribute('aria-valuemax', '100');
      meter.setAttribute('aria-valuenow', String(Math.max(0, Math.min(100, data.usedPercent))));
      var fill = makeElement('div', 'meter-fill');
      fill.style.width = Math.max(0, Math.min(100, data.usedPercent)) + '%';
      if (data.usedPercent >= 90) {
        fill.classList.add('meter-critical');
      } else if (data.usedPercent >= 75) {
        fill.classList.add('meter-high');
      }
      meter.appendChild(fill);
      appendChildren(meterWrap, [meterCaption, meter]);
      card.appendChild(meterWrap);
    } else if (data.showMeter === false) {
      card.appendChild(makeElement('p', 'empty-inline', 'メーターは上流指定により非表示です。消費率の値は上に表示しています。'));
    }

    var fields = makeElement('div', 'field-grid');
    appendWindowField(fields, data, 'additional', '追加枠情報', true);
    appendWindowField(fields, data, 'currency', '通貨');
    appendWindowField(fields, data, 'windowMinutes', '枠の長さ（分）', false, 'number');
    appendWindowField(fields, data, 'showMeter', 'メーター表示', false, 'boolean');
    appendWindowField(fields, data, 'boundaryKind', '境界種別');
    appendWindowField(fields, data, 'resetDescription', 'リセット説明', true);
    appendWindowField(fields, data, 'detail', '詳細', true);
    if (fields.childNodes.length) {
      card.appendChild(fields);
    }

    var known = [
      'kind', 'label', 'limitId', 'additional', 'usedPercent', 'remainingPercent', 'used',
      'limit', 'remaining', 'resetsAt', 'windowMinutes', 'showMeter', 'detail', 'currency',
      'boundaryKind', 'resetDescription'
    ];
    var extra = createExtraDetails('利用枠の追加情報', data, known);
    if (extra) {
      card.appendChild(extra);
    }
    return card;
  }

  function appendWindowMetric(parent, label, value, type) {
    var item = makeElement('div', 'window-metric');
    item.appendChild(makeElement('span', 'field-label', label));
    var valueNode = makeElement('span', 'field-value');
    appendTypedValue(valueNode, value, type);
    item.appendChild(valueNode);
    parent.appendChild(item);
  }

  function appendWindowField(parent, windowData, key, label, wide, type) {
    if (!hasOwn(windowData, key)) {
      return;
    }
    var item = makeElement('div', 'field-item' + (wide ? ' field-item-wide' : ''));
    item.appendChild(makeElement('span', 'field-label', label));
    var value = makeElement('span', 'field-value');
    appendTypedValue(value, windowData[key], type);
    item.appendChild(value);
    parent.appendChild(item);
  }

  function renderDevices(devices) {
    var section = makeElement('section', 'content-section');
    section.appendChild(createSectionHeading('端末別の現在値', '端末IDごとに集計と利用枠を分離して表示します。'));
    if (!Array.isArray(devices)) {
      section.appendChild(makeElement('p', 'empty-inline', '端末情報は未取得です。'));
      return section;
    }
    if (devices.length === 0) {
      section.appendChild(makeElement('p', 'empty-inline', '端末情報はありません。'));
      return section;
    }
    var list = makeElement('div', 'device-list');
    devices.forEach(function (device, index) {
      list.appendChild(renderDevice(device, index));
    });
    section.appendChild(list);
    return section;
  }

  function renderDevice(device, index) {
    var data = isRecord(device) ? device : {};
    var card = makeElement('article', 'device-card');
    var header = makeElement('header', 'device-card-header');
    var titleWrap = makeElement('div', 'device-title-wrap');
    titleWrap.appendChild(makeElement('p', 'kicker', '端末別 ' + countNumber(index + 1)));
    var title = scalarText(data.hostname, '');
    if (!title || title === '未取得') {
      title = scalarText(data.deviceId, '');
    }
    if (!title || title === '未取得') {
      title = '端末 ' + countNumber(index + 1);
    }
    titleWrap.appendChild(makeElement('h5', '', title));
    titleWrap.appendChild(makeElement('div', 'device-meta'));
    var meta = titleWrap.lastChild;
    meta.appendChild(makeElement('span', 'device-meta-item', 'deviceId: ' + scalarText(data.deviceId, '未取得')));
    meta.appendChild(makeElement('span', 'device-meta-item', 'platform: ' + scalarText(data.platform, '未取得')));
    var statusWrap = makeElement('div', 'device-status-wrap');
    if (data.stale === true) {
      statusWrap.appendChild(createStatusPill('stale', '古い観測値'));
      statusWrap.appendChild(makeElement('span', 'stale-caption', 'stale: true'));
    } else if (data.stale === false) {
      statusWrap.appendChild(createStatusPill('latest', '最新観測'));
      statusWrap.appendChild(makeElement('span', 'stale-caption', 'stale: false'));
    } else {
      statusWrap.appendChild(createStatusPill('unknown', '鮮度未指定'));
    }
    appendChildren(header, [titleWrap, statusWrap]);
    card.appendChild(header);

    var timestamps = makeElement('div', 'device-timestamps');
    timestamps.appendChild(createTimestamp('端末更新時刻', data.updatedAt));
    timestamps.appendChild(createTimestamp('端末受信時刻', data.receivedAt));
    card.appendChild(timestamps);

    if (hasOwn(data, 'periods')) {
      card.appendChild(renderStatsSection(data.periods, '端末集計', 'この端末に属する利用実績です。Hub集計とは別に表示します。', data.updatedAt));
    } else {
      card.appendChild(makeElement('p', 'empty-inline', '端末の期間集計は未取得です。'));
    }
    if (hasOwn(data, 'limits')) {
      card.appendChild(renderLimits(data.limits, '端末に報告された利用枠（プロバイダー別）'));
    } else {
      card.appendChild(makeElement('p', 'empty-inline', '端末の利用枠情報は未取得です。'));
    }

    var known = ['deviceId', 'hostname', 'platform', 'updatedAt', 'receivedAt', 'stale', 'periods', 'limits'];
    var extra = createExtraDetails('端末の追加情報', data, known);
    if (extra) {
      card.appendChild(extra);
    }
    return card;
  }

  function createExtraDetails(title, object, knownKeys) {
    if (!isRecord(object)) {
      return null;
    }
    var known = knownKeys || [];
    var extraKeys = Object.keys(object).filter(function (key) {
      return known.indexOf(key) === -1;
    });
    if (extraKeys.length === 0) {
      return null;
    }
    var details = makeElement('details', 'details-panel');
    details.appendChild(makeElement('summary', '', title));
    var list = makeElement('dl', 'safe-detail-list');
    extraKeys.forEach(function (key) {
      appendSafeEntry(list, key, object[key], 0);
    });
    details.appendChild(list);
    return details;
  }

  function appendSafeEntry(list, key, value, depth) {
    var term = makeElement('dt', '', String(key));
    var description = makeElement('dd');
    appendSafeValue(description, value, depth);
    list.appendChild(term);
    list.appendChild(description);
  }

  function appendSafeValue(parent, value, depth) {
    if (value === null || value === undefined) {
      parent.textContent = '未取得';
      return;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      parent.textContent = scalarText(value, '未取得');
      return;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        parent.textContent = '空の配列';
        return;
      }
      var arrayList = makeElement('dl', 'safe-detail-list');
      value.forEach(function (item, index) {
        appendSafeEntry(arrayList, '[' + index + ']', item, depth + 1);
      });
      parent.appendChild(arrayList);
      return;
    }
    if (isRecord(value)) {
      var objectList = makeElement('dl', 'safe-detail-list');
      var keys = Object.keys(value);
      if (keys.length === 0) {
        parent.textContent = '表示できる追加情報はありません。';
        return;
      }
      keys.forEach(function (key) {
        appendSafeEntry(objectList, key, value[key], depth + 1);
      });
      parent.appendChild(objectList);
      return;
    }
    parent.textContent = '表示できない値です。';
  }

  function handleSseEvent(event) {
    var payload;
    try {
      payload = JSON.parse(event.data);
    } catch (error) {
      lastDataIssue = 'SSEの' + event.type + 'イベントを解釈できません。表示中の状態を維持しています。';
      renderCommunication();
      return;
    }
    applyState(payload, 'SSE ' + event.type);
  }

  function connectEvents() {
    eventSource = new EventSource(API_EVENTS, { withCredentials: true });
    eventSource.addEventListener('update', handleSseEvent);
    eventSource.addEventListener('status', handleSseEvent);
    eventSource.onopen = function () {
      analyticsHasOpened = true;
      analyticsState = 'open';
      renderCommunication();
    };
    eventSource.onerror = function () {
      analyticsState = analyticsHasOpened ? 'reconnecting' : 'connecting';
      renderCommunication();
    };
  }

  function reconnectEvents() {
    if (eventSource) {
      eventSource.close();
    }
    analyticsHasOpened = false;
    analyticsState = 'connecting';
    renderCommunication();
    connectEvents();
  }

  function bindEvents() {
    elements.refreshButton.addEventListener('click', function () {
      reconnectEvents();
    });
    window.addEventListener('online', function () {
      browserOnline = true;
      renderCommunication();
    });
    window.addEventListener('offline', function () {
      browserOnline = false;
      renderCommunication();
    });
  }

  function init() {
    bindEvents();
    renderPage();
    connectEvents();
  }

  init();
}());
