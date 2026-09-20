import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Tooltip } from '@mantine/core';
import type { HubUsageOverview } from '../../../contracts/usage-overview.ts';
import { getUsageOverview } from '../features/usage-overview.ts';
import classes from './index.module.css';

export const Route = createFileRoute('/')({ component: Dashboard });

type PeriodKey = 'today' | 'month' | 'total';

const PERIODS = {
  today: {
    tokens: 51350620, cost: '$36.01', activeDays: '1', range: '2026年9月21日',
    bars: [4, 18, 34, 12, 8, 27, 45, 14, 6, 21, 62, 33, 17, 49, 78, 52, 26, 66, 38, 23, 57],
    labels: ['0時', '6時', '12時', '18時', '24時'],
  },
  month: {
    tokens: 4653088644, cost: '$1,880.88', activeDays: '17', range: '2026年9月1日 — 9月21日',
    bars: [4, 42, 100, 7, 1, 29, 8, 4, 2, 5, 27, 7, 2, 4, 11, 8, 53, 13, 8, 7, 4],
    labels: ['9/1', '9/5', '9/10', '9/15', '9/21'],
  },
  total: {
    tokens: 29420800000, cost: '$11,890.42', activeDays: '173', range: '2025年9月22日 — 2026年9月21日',
    bars: [18, 28, 24, 37, 33, 42, 46, 39, 52, 49, 58, 54, 62, 67, 61, 73, 69, 78, 82, 87, 94],
    labels: ['2025/10', '2026/1', '4月', '7月', '9月'],
  },
} as const;

const TOOL_ROWS = [
  ['Codex', 4080000000, '87.7%'], ['Antigravity', 423430000, '9.1%'], ['Cursor', 97710000, '2.1%'], ['その他', 51180000, '1.1%'],
] as const;
const MODEL_ROWS = [
  ['gpt-5.6-luna', 2330000000, 50], ['gpt-5.6-sol', 1120000000, 24], ['gpt-6-astra', 651430000, 14], ['gemini-3.8-flash', 418780000, 9], ['その他', 139590000, 3],
] as const;
const ACTIVITY = Array.from({ length: 182 }, (_, index) => (index * 17 + Math.floor(index / 9)) % 5);

function Dashboard() {
  const [period, setPeriod] = useState<PeriodKey>('month');
  const selected = PERIODS[period];
  const overview = useQuery({ queryKey: ['usage-overview'], queryFn: getUsageOverview, staleTime: Infinity });
  const receivedHubs = overview.data?.hubs.filter((hub) => hub.state !== null).length ?? 0;
  const registeredHubs = overview.data?.hubs.length ?? 0;
  const deviceCount = overview.data?.hubs.reduce((sum, hub) => sum + (hub.state?.devices.length ?? 0), 0) ?? 0;

  return (
    <div className={classes.workspace}>
      <aside className={classes.sidebar}>
        <a className={classes.brand} href="#top" aria-label="Token Monitor Analytics トップ">
          <span className={classes.brandMark}>Σ</span>
          <span><strong>Token Monitor</strong><small>ANALYTICS</small></span>
        </a>
        <p className={classes.navLabel}>WORKSPACE</p>
        <nav className={classes.navigation} aria-label="ダッシュボード内ナビゲーション">
          <a href="#top" aria-current="page"><NavigationIcon name="dashboard" />ダッシュボード</a>
          <a href="#trend"><NavigationIcon name="trend" />トレンド</a>
          <a href="#tools"><NavigationIcon name="tools" />ツール</a>
          <a href="#models"><NavigationIcon name="models" />モデル</a>
          <a href="#hubs"><NavigationIcon name="devices" />Hub・デバイス</a>
          <a href="#limits"><NavigationIcon name="limits" />利用枠</a>
        </nav>
        <div className={classes.sidebarStatus}>
          <p><i className={classes.liveDot} />受信済み {receivedHubs} / 登録 {registeredHubs} Hub</p>
          <p>デバイス {deviceCount} 台</p>
        </div>
      </aside>

      <main className={classes.main} id="top">
        <header className={classes.pageHeader}>
          <div><div className={classes.headingLine}><h1>ダッシュボード</h1><span>固定データを含む</span></div><p>{selected.range}</p></div>
          <div className={classes.periodSwitch} role="group" aria-label="集計期間">
            {(Object.keys(PERIODS) as PeriodKey[]).map((key) => (
              <button key={key} type="button" aria-pressed={period === key} onClick={() => setPeriod(key)}>{key.toUpperCase()}</button>
            ))}
          </div>
        </header>

        <section className={classes.kpis} aria-label="主要指標">
          <Kpi label="トークン" value={formatTokens(selected.tokens)} note="選択期間の合計" />
          <Kpi label="推定コスト" value={selected.cost} note="USD · 選択期間の合計" />
          <Kpi label="アクティブ日数" value={selected.activeDays} suffix="日" note="3日 連続利用" />
          <Kpi label="デバイス" value={overview.isPending ? '—' : String(deviceCount)} suffix="台" note={`受信済み ${receivedHubs} Hub`} live />
        </section>

        <div className={classes.primaryGrid}>
          <section className={`${classes.panel} ${classes.trendPanel}`} id="trend">
            <PanelHeader title="利用トレンド" caption="トークン / 日" />
            <div className={classes.chartLegend}><span><i />Tokyo Hub</span><span><i />Osaka Hub</span></div>
            <div className={classes.chart} role="img" aria-label={`${selected.range}の固定サンプルトレンド`}>
              <div className={classes.axis}>{[1590000000, 1060000000, 530980000, 0].map((value) => <span key={value}>{formatTokens(value)}</span>)}</div>
              <div className={classes.chartBody}>
                <div className={classes.gridLines}><i /><i /><i /><i /></div>
                <div className={classes.bars}>{selected.bars.map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}</div>
                <div className={classes.chartLabels}>{selected.labels.map((label) => <span key={label}>{label}</span>)}</div>
              </div>
            </div>
          </section>

          <section className={classes.panel} id="limits">
            <PanelHeader title="利用枠" />
            <div className={classes.limitList}>
              <Limit name="Codex" value={95} detail="Weekly" reset="リセットまで 6日14時間" />
              <Limit name="Cursor" value={97} detail="Models" reset="リセットまで 22時間" />
              <Limit name="Grok" value={98} detail="Weekly" reset="リセットまで 4日10時間" />
            </div>
          </section>
        </div>

        <div className={classes.secondaryGrid}>
          <section className={classes.panel} id="tools">
            <PanelHeader title="ツール" />
            <div className={classes.toolBody}>
              <div className={classes.donut}><strong>87.7%</strong><small>Codex</small></div>
              <div className={classes.toolLead}><small>最も利用したツール</small><strong>Codex</strong><span>{formatTokens(TOOL_ROWS[0][1])} tokens</span></div>
            </div>
            <div className={classes.dataRows}>{TOOL_ROWS.map(([name, value, share]) => <div key={name}><span><i />{name}</span><b>{formatTokens(value)}</b><small>{share}</small></div>)}</div>
          </section>

          <section className={classes.panel} id="models">
            <PanelHeader title="モデル" />
            <div className={classes.modelList}>{MODEL_ROWS.map(([name, value, share]) => <div key={name}><span>{name}</span><b>{formatTokens(value)} <small>{share}%</small></b><i><em style={{ width: `${share * 2}%` }} /></i></div>)}</div>
          </section>

          <section className={`${classes.panel} ${classes.hubPanel}`} id="hubs">
            <PanelHeader title="Hub・デバイス" live />
            {overview.isPending ? <HubLoading /> : overview.isError ? <div className={classes.hubError}>Hub・デバイスを取得できませんでした</div> : <HubList hubs={overview.data.hubs} period={period} />}
          </section>
        </div>

        <section className={`${classes.panel} ${classes.activityPanel}`} aria-labelledby="activity-title">
          <div className={classes.activityCopy}><h2 id="activity-title">アクティビティ</h2><strong>173</strong><span>アクティブ日数</span></div>
          <div className={classes.heatmap} role="img" aria-label="固定サンプルのアクティビティヒートマップ">{ACTIVITY.map((level, index) => <i key={index} data-level={level} />)}</div>
          <div className={classes.heatLegend}>少 <i /><i /><i /><i /> 多</div>
        </section>
      </main>
    </div>
  );
}

function NavigationIcon({ name }: { name: 'dashboard' | 'trend' | 'tools' | 'models' | 'devices' | 'limits' }) {
  const paths = {
    dashboard: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
    trend: 'M3 3v18h18 M6 15l5-5 4 3 6-8',
    tools: 'M8 7V4h8v3 M3 7h18v14H3z M3 12h18 M10 12v3h4v-3',
    models: 'M9 3h6v6H9z M2 16h6v5H2z M16 16h6v5h-6z M12 9v4 M5 16v-3h14v3',
    devices: 'M2 3h20v14H2z M12 17v4 M7 21h10',
    limits: 'M4 19a10 10 0 1 1 16 0 M12 13l5-6 M5 13H3 M12 5V3 M19 13h2',
  };
  return <svg className={classes.navIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

function Kpi({ label, value, suffix, note, live = false }: { label: string; value: string; suffix?: string; note: string; live?: boolean }) {
  return <div className={classes.kpi}><div className={classes.kpiLabel}>{label}{live ? <span className={classes.realBadge}>LIVE</span> : null}</div><strong>{value}</strong>{suffix ? <span className={classes.kpiSuffix}>{suffix}</span> : null}<small>{note}</small></div>;
}

function PanelHeader({ title, caption, live = false }: { title: string; caption?: string; live?: boolean }) {
  return <header className={classes.panelHeader}><div><h2>{title}</h2>{caption ? <span>{caption}</span> : null}</div>{live ? <span className={classes.realBadge}>LIVE</span> : <span className={classes.staticBadge}>固定サンプル</span>}</header>;
}

function Limit({ name, value, detail, reset }: { name: string; value: number; detail: string; reset: string }) {
  return <div className={classes.limit}><div><strong>{name}</strong><b>{value}% <small>残り</small></b></div><i><em style={{ width: `${value}%` }} /></i><p><span>{detail}</span><span>{reset}</span></p></div>;
}

function HubLoading() {
  return <div className={classes.hubLoading} aria-label="Hub・デバイスを読み込み中"><i /><i /><i /></div>;
}

function HubList({ hubs, period }: { hubs: HubUsageOverview[]; period: PeriodKey }) {
  const totalTokens = hubs.reduce((total, hub) => total + (hub.state?.periods[period].totalTokens ?? 0), 0);
  const totalCost = hubs.reduce((total, hub) => total + (hub.state?.periods[period].costUsd ?? 0), 0);
  const segments = hubs.map((hub, index) => {
    const share = totalTokens > 0 ? (hub.state?.periods[period].totalTokens ?? 0) / totalTokens * 100 : 0;
    const costShare = totalCost > 0 ? (hub.state?.periods[period].costUsd ?? 0) / totalCost * 100 : 0;
    return { hub, share, costShare, color: index === 0 ? '#14866e' : index === 1 ? '#648fed' : `hsl(${(index * 137.5 + 160) % 360} 48% 48%)` };
  });

  return <>
    <div className={classes.hubCharts}>
      {(['tokens', 'cost'] as const).map((metric) => <div key={metric} className={classes.hubMetric}>
        <small>{metric === 'tokens' ? 'トークン' : '推定コスト'}</small>
        <strong title={metric === 'tokens' ? `${totalTokens.toLocaleString('en-US')} トークン` : undefined}>{metric === 'tokens' ? formatTokens(totalTokens) : `$${totalCost.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}</strong>
        <div className={classes.hubStack} role="group" aria-label={metric === 'tokens' ? 'Hub別トークン使用量の内訳' : 'Hub別推定コストの内訳'}>
          {segments.map((segment) => ({ ...segment, share: metric === 'tokens' ? segment.share : segment.costShare })).filter(({ share }) => share > 0).map(({ hub, share, color }) => <Tooltip key={hub.hubId} label={`${hub.name}: ${share.toFixed(1)}%`} events={{ hover: true, focus: true, touch: true }}>
            <span style={{ flexGrow: share, background: color }} tabIndex={0} aria-label={`${hub.name}: ${share.toFixed(1)}%`} />
          </Tooltip>)}
        </div>
      </div>)}
    </div>
    <div className={classes.hubList}>{segments.map(({ hub, share, color }) => {
    const usage = hub.state?.periods[period];
    const hostnames = hub.state?.devices.map((device) => device.hostname).join(', ');

    return <article key={hub.hubId} className={classes.hub} aria-label={hub.name}>
      <div className={classes.hubHeading}>
        <div className={classes.hubIdentity}>
          <i className={classes.hubDot} style={{ background: color }} title={usage ? `${share.toFixed(1)}%` : '未受信'} />
          <span className={classes.hubName} title={hub.name}>{hub.name}</span>
          {hostnames ? <Tooltip label={hostnames} multiline maw={360} events={{ hover: true, focus: true, touch: true }}>
            <span className={classes.hostnames} tabIndex={0}>{hostnames}</span>
          </Tooltip> : null}
        </div>
        {usage ? <div className={classes.hubUsage}>
          <strong title={`${usage.totalTokens.toLocaleString('en-US')} tokens`}>{formatTokens(usage.totalTokens)}</strong>
          <span>/</span>
          <small>${usage.costUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</small>
        </div> : <span className={classes.hubWaiting}>未受信</span>}
      </div>
      {!usage ? <p className={classes.emptyHub}>まだ情報を受信していません</p> : null}
    </article>;
  })}</div></>;
}

function formatTokens(value: number) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}
