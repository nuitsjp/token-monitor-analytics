import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { Badge, Progress, Tooltip } from '@mantine/core';
import type { HubDeviceState, HubLimitWindow, HubUsageOverview } from '../../../contracts/usage-overview.ts';
import { useUsageConnectionStatus, useUsageOverview } from '../features/usage-updates.tsx';
import { seriesColor, tokens } from '../app/theme.ts';
import classes from './index.module.css';

export const Route = createFileRoute('/')({ component: Dashboard });

type PeriodKey = 'today' | 'month' | 'total';

const PERIODS = {
  today: {
    tokens: 51350620, cost: '$36.01', activeDays: '1', range: '2026年9月21日', shortRange: '9/21',
    bars: [4, 18, 34, 12, 8, 27, 45, 14, 6, 21, 62, 33, 17, 49, 78, 52, 26, 66, 38, 23, 57],
    labels: { 0: '0時', 5: '6時', 10: '12時', 15: '18時', 20: '24時' } as Record<number, string>,
  },
  month: {
    tokens: 4653088644, cost: '$1,880.88', activeDays: '17', range: '2026年9月1日 — 9月21日', shortRange: '9/1–9/21',
    bars: [4, 42, 100, 7, 1, 29, 8, 4, 2, 5, 27, 7, 2, 4, 11, 8, 53, 13, 8, 7, 4],
    labels: { 0: '9/1', 4: '9/5', 9: '9/10', 14: '9/15', 20: '9/21' } as Record<number, string>,
  },
  total: {
    tokens: 29420800000, cost: '$11,890.42', activeDays: '173', range: '2025年9月22日 — 2026年9月21日', shortRange: '2025/9–2026/9',
    bars: [18, 28, 24, 37, 33, 42, 46, 39, 52, 49, 58, 54, 62, 67, 61, 73, 69, 78, 82, 87, 94],
    labels: { 0: '2025/10', 5: '2026/1', 10: '4月', 15: '7月', 20: '9月' } as Record<number, string>,
  },
} as const;
const TREND_AXIS_MAX = 1590000000;
const TREND_SPLIT = 0.82;

type ToolRow = { name: string; value: number; share: number; neutral?: boolean };

const SECTIONS = [
  { id: 'top', label: 'ダッシュボード', icon: 'dashboard' },
  { id: 'trend', label: 'トレンド', icon: 'trend' },
  { id: 'hubs', label: 'Hub・デバイス', icon: 'devices' },
  { id: 'tools', label: 'ツール', icon: 'tools' },
  { id: 'models', label: 'モデル', icon: 'models' },
  { id: 'limits', label: '利用枠', icon: 'limits' },
  { id: 'activity', label: 'アクティビティ', icon: 'activity' },
] as const;
type IconName = (typeof SECTIONS)[number]['icon'];
const SECTION_IDS = SECTIONS.map((section) => section.id);

function Dashboard() {
  const [period, setPeriod] = useState<PeriodKey>('month');
  const selected = PERIODS[period];
  const overview = useUsageOverview();
  const connectionStatus = useUsageConnectionStatus();
  const hubs = overview.data?.hubs ?? [];
  const receivedHubs = hubs.filter((hub) => hub.state !== null).length;
  const activeHubs = hubs.flatMap((hub) => (hub.state ? [hub.state] : []));
  const deviceCount = hubs.reduce((sum, hub) => sum + (hub.state?.devices.length ?? 0), 0);
  const fetchedAt = overview.dataUpdatedAt ? formatTime(overview.dataUpdatedAt) : null;
  const activeSection = useActiveSection(SECTION_IDS);

  const totalTokens = activeHubs.reduce((sum, state) => sum + state.periods[period].totalTokens, 0);
  const totalCostUsd = activeHubs.reduce((sum, state) => sum + state.periods[period].costUsd, 0);
  const maxActiveDays = activeHubs.length > 0 ? Math.max(...activeHubs.map((state) => state.activeDays ?? 0)) : 0;
  const toolRows = aggregateToolRows(activeHubs, period);

  const aggregatedModels = new Map<string, number>();
  for (const state of activeHubs) {
    const models = state.periods[period].models;
    if (!models) continue;
    for (const [model, tokens] of Object.entries(models)) {
      aggregatedModels.set(model, (aggregatedModels.get(model) ?? 0) + tokens);
    }
  }
  const totalModelTokens = Array.from(aggregatedModels.values()).reduce((sum, v) => sum + v, 0);
  const sortedModels = Array.from(aggregatedModels.entries())
    .filter(([_, tokens]) => tokens > 0)
    .sort((a, b) => b[1] - a[1]);

  let modelRows: { name: string; value: number; share: number; neutral?: boolean }[] = [];
  if (totalModelTokens > 0) {
    if (sortedModels.length <= 9) {
      modelRows = sortedModels.map(([name, value]) => ({
        name,
        value,
        share: (value / totalModelTokens) * 100,
      }));
    } else {
      const top9 = sortedModels.slice(0, 9);
      const rest = sortedModels.slice(9);
      const restTokens = rest.reduce((sum, [_, v]) => sum + v, 0);
      modelRows = top9.map(([name, value]) => ({
        name,
        value,
        share: (value / totalModelTokens) * 100,
      }));
      if (restTokens > 0) {
        modelRows.push({
          name: 'その他',
          value: restTokens,
          share: (restTokens / totalModelTokens) * 100,
          neutral: true,
        });
      }
    }
  }

  return (
    <div className={classes.workspace}>
      <aside className={classes.sidebar}>
        <a className={classes.brand} href="#top" aria-label="Token Monitor Analytics トップ">
          <span className={classes.brandMark}>Σ</span>
          <span><strong>Token Monitor</strong><small>ANALYTICS</small></span>
        </a>
        <nav className={classes.navigation} aria-label="ページ内の見出し">
          {SECTIONS.map((section) => (
            <a key={section.id} href={`#${section.id}`} aria-current={activeSection === section.id ? 'location' : undefined}>
              <NavigationIcon name={section.icon} />{section.label}
            </a>
          ))}
        </nav>
        <div className={classes.sidebarStatus}>
          <p>受信済み {receivedHubs} / 登録 {hubs.length} Hub</p>
          <p>デバイス {deviceCount} 台</p>
        </div>
      </aside>

      <main className={classes.main}>
        <div id="top" className={classes.overview}>
          <header className={classes.pageHeader}>
            <div className={classes.headingLine}><h1>ダッシュボード</h1><span>固定データを含む</span></div>
            <div className={classes.headerControls}>
              <span className={classes.headerMeta}>
                {[selected.shortRange, fetchedAt ? `取得 ${fetchedAt}` : null].filter(Boolean).join(' · ')}
              </span>
              <div className={classes.periodSwitch} role="group" aria-label="集計期間">
                {(Object.keys(PERIODS) as PeriodKey[]).map((key) => (
                  <button key={key} type="button" aria-pressed={period === key} onClick={() => setPeriod(key)}>{key.toUpperCase()}</button>
                ))}
              </div>
            </div>
          </header>

          <section className={classes.kpis} aria-label="主要指標">
            <Kpi label="トークン" value={overview.isPending ? '—' : formatTokens(totalTokens)} note="全Hub合計" saved />
            <Kpi label="推定コスト" value={overview.isPending ? '—' : formatUsd(totalCostUsd)} note="USD 換算" saved />
            <Kpi label="アクティブ日数" value={overview.isPending ? '—' : String(maxActiveDays)} suffix="日" note="受信Hubの最大値" saved />
            <Kpi label="デバイス" value={overview.isPending ? '—' : String(deviceCount)} suffix="台" note={`受信済み ${receivedHubs} Hub`} saved />
          </section>
        </div>

        <div className={classes.primaryGrid}>
          <section className={`${classes.panel} ${classes.trendPanel}`} id="trend" aria-labelledby="trend-title">
            <PanelHeader id="trend-title" title="利用トレンド" caption="トークン / 日" />
            <TrendChart period={period} hubs={hubs} />
          </section>

          <section className={`${classes.panel} ${classes.hubPanel}`} id="hubs" aria-labelledby="hubs-title">
            <PanelHeader id="hubs-title" title="Hub・デバイス" saved />
            {connectionStatus === 'reconnecting' ? <p role="status" className={classes.hubError}>再接続中</p> : null}
            {overview.isPending ? <HubLoading /> : overview.isError ? <div className={classes.hubError}>Hub・デバイスを取得できませんでした</div> : <HubList hubs={hubs} period={period} />}
          </section>
        </div>

        <div className={classes.secondaryGrid}>
          <ToolPanel rows={toolRows} isPending={overview.isPending} isError={overview.isError} hasReceivedHubs={receivedHubs > 0} />

          <section className={classes.panel} id="models" aria-labelledby="models-title">
            <PanelHeader id="models-title" title="モデル" caption="トークン構成比" saved />
            {overview.isPending ? (
              <HubLoading />
            ) : modelRows.length === 0 ? (
              <p className={classes.emptyHub}>利用データがありません</p>
            ) : (
              <RankList rows={modelRows} />
            )}
          </section>

          <section className={classes.panel} id="limits" aria-labelledby="limits-title">
            <PanelHeader id="limits-title" title="利用枠" caption="残量" saved />
            {overview.isPending
              ? <div className={classes.hubLoading} aria-label="利用枠を読み込み中"><span /><span /><span /></div>
              : overview.isError
                ? <div className={classes.hubError}>利用枠を取得できませんでした</div>
                : <LimitList hubs={hubs} />}
          </section>
        </div>

        <section className={`${classes.panel} ${classes.activityPanel}`} id="activity" aria-labelledby="activity-title">
          <ActivityHeatmap />
        </section>
      </main>
    </div>
  );
}

function useActiveSection(ids: readonly string[]) {
  const [active, setActive] = useState(ids[0]);
  useEffect(() => {
    const visible = new Map<string, number>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.set(entry.target.id, entry.boundingClientRect.top);
        else visible.delete(entry.target.id);
      }
      if (!visible.size) return;
      // 見えている見出しのうち、最も上にあるものを現在地にする。
      const next = [...visible.entries()].sort((left, right) => left[1] - right[1])[0][0];
      setActive(next);
    }, { rootMargin: '-15% 0px -60% 0px' });
    for (const id of ids) {
      const target = document.getElementById(id);
      if (target) observer.observe(target);
    }
    return () => observer.disconnect();
  }, [ids]);
  return active;
}

function NavigationIcon({ name }: { name: IconName }) {
  const paths: Record<IconName, string> = {
    dashboard: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
    trend: 'M3 3v18h18 M6 15l5-5 4 3 6-8',
    tools: 'M8 7V4h8v3 M3 7h18v14H3z M3 12h18 M10 12v3h4v-3',
    models: 'M9 3h6v6H9z M2 16h6v5H2z M16 16h6v5h-6z M12 9v4 M5 16v-3h14v3',
    devices: 'M2 3h20v14H2z M12 17v4 M7 21h10',
    limits: 'M4 19a10 10 0 1 1 16 0 M12 13l5-6 M5 13H3 M12 5V3 M19 13h2',
    activity: 'M3 4h18v16H3z M3 9h18 M8 2v4 M16 2v4 M7 13h3v3H7z M14 13h3v3h-3z',
  };
  return <svg className={classes.navIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

const BADGE_STYLES = { label: { fontSize: '12px' } };

function SourceBadge({ saved }: { saved: boolean }) {
  if (saved) return null;
  return <Badge variant="outline" color="gray" size="md" radius="sm" tt="none" fw={600} styles={BADGE_STYLES}>固定サンプル</Badge>;
}

function Kpi({ label, value, suffix, note, saved = false }: { label: string; value: string; suffix?: string; note: string; saved?: boolean }) {
  return (
    <div className={classes.kpi}>
      <div className={classes.kpiLabel}>{label}<SourceBadge saved={saved} /></div>
      <div className={classes.kpiValue}><strong>{value}</strong>{suffix ? <span>{suffix}</span> : null}</div>
      <small>{note}</small>
    </div>
  );
}

function PanelHeader({ id, title, caption, saved = false }: { id: string; title: string; caption?: string; saved?: boolean }) {
  return (
    <header className={classes.panelHeader}>
      <div><h2 id={id}>{title}</h2>{caption ? <span>{caption}</span> : null}</div>
      <SourceBadge saved={saved} />
    </header>
  );
}

function ToolPanel({ rows, isPending, isError, hasReceivedHubs }: { rows: ToolRow[]; isPending: boolean; isError: boolean; hasReceivedHubs: boolean }) {
  return (
    <section className={classes.panel} id="tools" aria-labelledby="tools-title">
      <PanelHeader id="tools-title" title="ツール" caption="トークン構成比" saved />
      {isPending ? <p className={classes.hubLoading} aria-label="ツール別トークン構成比を読み込み中">読み込み中</p>
        : isError ? <p className={classes.hubError}>ツール別トークン構成比を取得できませんでした</p>
          : !hasReceivedHubs ? <p className={classes.hubError}>まだ情報を受信していません</p>
            : rows.length === 0 ? <p className={classes.hubError}>この期間のトークン使用量はありません</p>
              : <RankList rows={rows} />}
    </section>
  );
}

function TrendChart({ period, hubs }: { period: PeriodKey; hubs: HubUsageOverview[] }) {
  const selected = PERIODS[period];
  const legend = [0, 1].map((index) => hubs[index]?.name ?? `Hub ${index + 1}`);
  const ticks = [TREND_AXIS_MAX, TREND_AXIS_MAX / 2, 0];
  return (
    <>
      <div className={classes.chartLegend}>
        {legend.map((name, index) => <span key={name}><span className={classes.swatch} style={{ background: seriesColor(index) }} />{name}</span>)}
      </div>
      <div className={classes.chart} role="img" aria-label={`${selected.range}の固定サンプルトレンド`}>
        <div className={classes.plot}>
          {ticks.map((value, index) => (
            <div key={value} className={classes.gridline} style={{ top: `${(index / (ticks.length - 1)) * 100}%` }}><span>{formatTokens(value)}</span></div>
          ))}
          <div className={classes.bars} style={{ gridTemplateColumns: `repeat(${selected.bars.length}, minmax(0, 1fr))` }}>
            {selected.bars.map((height, index) => {
              const total = Math.round((height / 100) * TREND_AXIS_MAX);
              return (
                <Tooltip key={index} label={`${formatTokens(total)} tokens`} events={{ hover: true, focus: true, touch: true }}>
                  <div className={classes.bar} style={{ height: `${height}%` }} tabIndex={0} aria-label={`${index + 1}番目: ${formatTokens(total)} tokens`}>
                    <span style={{ flexGrow: 1 - TREND_SPLIT, background: seriesColor(1) }} />
                    <span style={{ flexGrow: TREND_SPLIT, background: seriesColor(0) }} />
                  </div>
                </Tooltip>
              );
            })}
          </div>
        </div>
        <div className={classes.chartLabels} style={{ gridTemplateColumns: `repeat(${selected.bars.length}, minmax(0, 1fr))` }}>
          {Object.entries(selected.labels).map(([index, label]) => <span key={label} style={{ gridColumn: Number(index) + 1 }}>{label}</span>)}
        </div>
      </div>
    </>
  );
}

function RankList({ rows }: { rows: ToolRow[] }) {
  return (
    <div className={classes.rankList}>
      {rows.map((row) => (
        <div key={row.name} className={classes.rankRow}>
          <div className={classes.rankLabel}><span className={classes.rankName}>{row.name}</span><strong>{formatTokens(row.value)}</strong><small>{formatPercent(row.share)}</small></div>
          <Progress value={row.share} size={4} radius="xl" color={row.neutral ? tokens.neutralSeries : 'brand'} aria-label={`${row.name}の構成比`} />
        </div>
      ))}
    </div>
  );
}

function limitWindowKey(window: HubLimitWindow) {
  return [window.provider, window.accountKey, window.kind, window.limitId ?? window.label].join('\0');
}

const KIND_WINDOW_MINUTES = { session: 300, daily: 1440, weekly: 10080, billing: 43200 } as const;

function limitAccountKey(window: HubLimitWindow) {
  return `${window.provider}\0${window.accountKey}`;
}

function collectLimitRows(hubs: HubUsageOverview[]) {
  const byKey = new Map<string, HubLimitWindow>();
  for (const hub of hubs) {
    for (const window of hub.state?.limits ?? []) {
      const key = limitWindowKey(window);
      const current = byKey.get(key);
      if (!current || (window.meterUpdatedAt ?? '') > (current.meterUpdatedAt ?? ''))
        byKey.set(key, window);
    }
  }
  const rows = [...byKey.values()];
  const accountMeterUpdated = new Map<string, string>();
  for (const row of rows) {
    const at = row.meterUpdatedAt ?? '';
    const account = limitAccountKey(row);
    if (at > (accountMeterUpdated.get(account) ?? ''))
      accountMeterUpdated.set(account, at);
  }
  return rows.sort((left, right) => {
    const leftAccount = limitAccountKey(left);
    const rightAccount = limitAccountKey(right);
    const accountTime = (accountMeterUpdated.get(rightAccount) ?? '').localeCompare(accountMeterUpdated.get(leftAccount) ?? '');
    if (accountTime !== 0) return accountTime;
    const account = leftAccount.localeCompare(rightAccount);
    if (account !== 0) return account;
    const width = windowWidthMinutes(left) - windowWidthMinutes(right);
    if (width !== 0) return width;
    return (right.meterUpdatedAt ?? '').localeCompare(left.meterUpdatedAt ?? '');
  });
}

function windowWidthMinutes(window: HubLimitWindow) {
  if (window.windowMinutes != null) return window.windowMinutes;
  return KIND_WINDOW_MINUTES[window.kind];
}

function providersWithMultipleAccounts(rows: HubLimitWindow[]) {
  const accounts = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = accounts.get(row.provider) ?? new Set<string>();
    set.add(row.accountKey);
    accounts.set(row.provider, set);
  }
  return new Set([...accounts].filter(([, set]) => set.size > 1).map(([provider]) => provider));
}

function limitDisplayName(window: HubLimitWindow, multipleAccounts: boolean) {
  const provider = capitalize(window.provider);
  if (!multipleAccounts) return provider;
  const account = window.accountLabel || window.planLabel;
  return account ? `${provider} ${account}` : provider;
}

function limitDetail(window: HubLimitWindow) {
  return window.label || capitalize(window.kind);
}

function capitalize(value: string) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function remainingPercent(value: number) {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function formatResetUntil(resetsAt: string | null, now = Date.now()) {
  if (resetsAt === null) return null;
  const delta = new Date(resetsAt).getTime() - now;
  if (delta < 0) return 'リセット予定を過ぎています';
  const minutes = Math.floor(delta / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days >= 1) return `リセットまで ${days}日${hours % 24}時間`;
  if (hours >= 1) return `リセットまで ${hours}時間`;
  return `リセットまで ${minutes}分`;
}

function aggregateToolRows(states: HubDeviceState[], period: PeriodKey): ToolRow[] {
  const tokensByTool = new Map<string, number>();
  for (const state of states) {
    for (const [name, value] of Object.entries(state.periods[period].clients ?? {}))
      tokensByTool.set(name, (tokensByTool.get(name) ?? 0) + value);
  }
  const rows = [...tokensByTool.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((left, right) => right.value - left.value || left.name.localeCompare(right.name));
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  return rows.map((row) => ({ ...row, share: total > 0 ? (row.value / total) * 100 : 0 }));
}

function limitColor(remaining: number) {
  if (remaining < 10) return tokens.status.danger;
  if (remaining < 20) return tokens.status.warn;
  return 'brand';
}

function groupLimitAccounts(rows: HubLimitWindow[], multiAccount: Set<string>) {
  const groups: { key: string; name: string; windows: HubLimitWindow[] }[] = [];
  for (const window of rows) {
    const key = limitAccountKey(window);
    const last = groups.at(-1);
    if (last?.key === key) {
      last.windows.push(window);
      continue;
    }
    groups.push({
      key,
      name: limitDisplayName(window, multiAccount.has(window.provider)),
      windows: [window],
    });
  }
  return groups;
}

function LimitList({ hubs }: { hubs: HubUsageOverview[] }) {
  const received = hubs.some((hub) => hub.state !== null);
  if (!received) return <p className={classes.emptyHub} role="status">まだ情報を受信していません</p>;
  const rows = collectLimitRows(hubs);
  if (rows.length === 0) return <p className={classes.emptyHub} role="status">表示できる利用枠はありません</p>;
  const groups = groupLimitAccounts(rows, providersWithMultipleAccounts(rows));
  return (
    <div className={classes.limitList}>
      {groups.map((group) => (
        <div key={group.key} className={classes.limitAccount} aria-label={group.name}>
          <strong className={classes.limitAccountName}>{group.name}</strong>
          {group.windows.map((window) => <Limit key={limitWindowKey(window)} accountName={group.name} window={window} />)}
        </div>
      ))}
    </div>
  );
}

function Limit({ accountName, window }: { accountName: string; window: HubLimitWindow }) {
  const remaining = remainingPercent(window.remainingPercent);
  const reset = formatResetUntil(window.resetsAt);
  const detail = limitDetail(window);
  return (
    <div className={classes.limit}>
      <div className={classes.limitLabel}>
        <strong>{detail}</strong>
        {reset ? <span className={classes.limitReset}>{reset}</span> : null}
        <span className={classes.limitRemaining} style={{ color: remaining < 20 ? limitColor(remaining) : undefined }}>{remaining}% <small>残り</small></span>
      </div>
      <Progress value={remaining} size={4} radius="xl" color={limitColor(remaining)} aria-label={`${accountName}、${detail}の残量`} />
    </div>
  );
}

function HubLoading() {
  return <div className={classes.hubLoading} aria-label="Hub・デバイスを読み込み中"><span /><span /><span /></div>;
}

function HubList({ hubs, period }: { hubs: HubUsageOverview[]; period: PeriodKey }) {
  const totalTokens = hubs.reduce((total, hub) => total + (hub.state?.periods[period].totalTokens ?? 0), 0);
  const totalCost = hubs.reduce((total, hub) => total + (hub.state?.periods[period].costUsd ?? 0), 0);
  const segments = hubs.map((hub, index) => ({
    hub,
    share: totalTokens > 0 ? ((hub.state?.periods[period].totalTokens ?? 0) / totalTokens) * 100 : 0,
    costShare: totalCost > 0 ? ((hub.state?.periods[period].costUsd ?? 0) / totalCost) * 100 : 0,
    color: seriesColor(index),
  }));

  return (
    <>
      <div className={classes.hubCharts}>
        {(['tokens', 'cost'] as const).map((metric) => (
          <div key={metric} className={classes.hubMetric}>
            <small>{metric === 'tokens' ? 'トークン' : '推定コスト'}</small>
            <strong title={metric === 'tokens' ? `${totalTokens.toLocaleString('en-US')} トークン` : undefined}>{metric === 'tokens' ? formatTokens(totalTokens) : formatUsd(totalCost)}</strong>
            <div className={classes.hubStack} role="group" aria-label={metric === 'tokens' ? 'Hub別トークン使用量の内訳' : 'Hub別推定コストの内訳'}>
              {segments.map((segment) => ({ ...segment, share: metric === 'tokens' ? segment.share : segment.costShare })).filter(({ share }) => share > 0).map(({ hub, share, color }) => (
                <Tooltip key={hub.hubId} label={`${hub.name}: ${share.toFixed(1)}%`} events={{ hover: true, focus: true, touch: true }}>
                  <span style={{ flexGrow: share, background: color }} tabIndex={0} aria-label={`${hub.name}: ${share.toFixed(1)}%`} />
                </Tooltip>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className={classes.hubList}>
        {segments.map(({ hub, share, color }) => {
          const usage = hub.state?.periods[period];
          const hostnames = hub.state?.devices.map((device) => device.hostname).join(', ');
          return (
            <article key={hub.hubId} className={classes.hub} aria-label={hub.name}>
              <div className={classes.hubHeading}>
                <div className={classes.hubIdentity}>
                  <span className={classes.hubDot} style={{ background: color }} title={usage ? `${share.toFixed(1)}%` : '未受信'} />
                  <span className={classes.hubName} title={hub.name}>{hub.name}</span>
                  {hostnames ? (
                    <Tooltip label={hostnames} multiline maw={360} events={{ hover: true, focus: true, touch: true }}>
                      <span className={classes.hostnames} tabIndex={0}>{hostnames}</span>
                    </Tooltip>
                  ) : null}
                </div>
                {usage ? (
                  <div className={classes.hubUsage}>
                    <strong title={`${usage.totalTokens.toLocaleString('en-US')} tokens`}>{formatTokens(usage.totalTokens)}</strong>
                    <span>/</span>
                    <small>{formatUsd(usage.costUsd)}</small>
                  </div>
                ) : <span className={classes.hubWaiting}>未受信</span>}
              </div>
              {!usage ? <p className={classes.emptyHub}>まだ情報を受信していません</p> : null}
            </article>
          );
        })}
      </div>
    </>
  );
}

const WEEKDAY_LABELS: Record<number, string> = { 1: '月', 3: '水', 5: '金' };

function activityCells() {
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - 363);
  start.setDate(start.getDate() - start.getDay());
  const cells: { date: Date; level: number }[] = [];
  for (let index = 0; ; index += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    if (date > end) break;
    // 固定サンプル。日付に対して決定的な 0〜4 のレベルを割り当てる。
    cells.push({ date, level: (index * 17 + Math.floor(index / 9)) % 5 });
  }
  return cells;
}

function ActivityHeatmap() {
  const [cells] = useState(activityCells);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const toLatest = () => { if (scroller.current) scroller.current.scrollLeft = scroller.current.scrollWidth; };
    toLatest();
    window.addEventListener('resize', toLatest);
    return () => window.removeEventListener('resize', toLatest);
  }, []);
  const weeks = Math.ceil(cells.length / 7);
  const activeDays = cells.filter((cell) => cell.level > 0).length;
  // 週の先頭日の月が前の週と変わった列に月ラベルを置く。
  const weekStarts = Array.from({ length: weeks }, (_, week) => cells[week * 7].date);
  const monthLabels = weekStarts
    .map((date, week) => ({ date, week }))
    .filter(({ date, week }) => week > 0 && weekStarts[week - 1].getMonth() !== date.getMonth());

  return (
    <>
      <div className={classes.activityCopy}>
        <h2 id="activity-title">アクティビティ</h2>
        <strong>{activeDays}</strong>
        <span>累計アクティブ日数 · 過去1年</span>
      </div>
      <div className={classes.heatmapScroller} ref={scroller}>
        <div className={classes.heatmapFrame} style={{ gridTemplateColumns: `auto repeat(${weeks}, var(--cell))` }}>
          <span className={classes.heatmapCorner} />
          {monthLabels.map(({ date, week }) => (
            <span key={date.toISOString()} className={classes.monthLabel} style={{ gridColumn: week + 2 }}>{date.getMonth() + 1}月</span>
          ))}
          {Array.from({ length: 7 }, (_, weekday) => (
            <span key={weekday} className={classes.weekdayLabel} style={{ gridRow: weekday + 2 }}>{WEEKDAY_LABELS[weekday] ?? ''}</span>
          ))}
          <div className={classes.heatmap} role="img" aria-label={`過去1年の固定サンプルアクティビティ。アクティブ ${activeDays} 日`} style={{ gridTemplateRows: 'repeat(7, var(--cell))' }}>
            {cells.map((cell) => <span key={cell.date.toISOString()} data-level={cell.level} title={`${formatDate(cell.date)} · アクティビティ ${cell.level}/4`} />)}
          </div>
        </div>
      </div>
      <div className={classes.heatLegend}>少 <span data-level={1} /><span data-level={2} /><span data-level={3} /><span data-level={4} /> 多</div>
    </>
  );
}

function formatTokens(value: number) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}
function formatUsd(value: number) {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function formatPercent(value: number) {
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value)}%`;
}
function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(timestamp));
}
function formatDate(date: Date) {
  return new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' }).format(date);
}
