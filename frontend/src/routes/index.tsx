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
    tokens: '51.35M', exactTokens: '51,350,620 tokens', cost: '$36.01', activeDays: '1', range: '2026年9月21日',
    bars: [4, 18, 34, 12, 8, 27, 45, 14, 6, 21, 62, 33, 17, 49, 78, 52, 26, 66, 38, 23, 57],
    labels: ['0時', '6時', '12時', '18時', '24時'],
  },
  month: {
    tokens: '4.65B', exactTokens: '4,653,088,644 tokens', cost: '$1,880.88', activeDays: '17', range: '2026年9月1日 — 9月21日',
    bars: [4, 42, 100, 7, 1, 29, 8, 4, 2, 5, 27, 7, 2, 4, 11, 8, 53, 13, 8, 7, 4],
    labels: ['9/1', '9/5', '9/10', '9/15', '9/21'],
  },
  total: {
    tokens: '29.42B', exactTokens: '29,420,800,000 tokens', cost: '$11,890.42', activeDays: '173', range: '2025年9月22日 — 2026年9月21日',
    bars: [18, 28, 24, 37, 33, 42, 46, 39, 52, 49, 58, 54, 62, 67, 61, 73, 69, 78, 82, 87, 94],
    labels: ['2025/10', '2026/1', '4月', '7月', '9月'],
  },
} as const;

const TOOL_ROWS = [
  ['Codex', '4.08B', '87.7%'], ['Antigravity', '423.43M', '9.1%'], ['Cursor', '97.71M', '2.1%'], ['その他', '51.18M', '1.1%'],
] as const;
const MODEL_ROWS = [
  ['gpt-5.6-luna', '2.33B', 50], ['gpt-5.6-sol', '1.12B', 24], ['gpt-6-astra', '651.43M', 14], ['gemini-3.8-flash', '418.78M', 9], ['その他', '139.59M', 3],
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
          <a href="#top" aria-current="page"><span>▦</span>ダッシュボード</a>
          <a href="#trend"><span>⌁</span>トレンド</a>
          <a href="#tools"><span>▣</span>ツール</a>
          <a href="#models"><span>♧</span>モデル</a>
          <a href="#hubs"><span>▭</span>Hub・デバイス</a>
          <a href="#limits"><span>◔</span>利用枠</a>
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
          <Kpi label="トークン" value={selected.tokens} suffix="tokens" note={selected.exactTokens} />
          <Kpi label="推定コスト" value={selected.cost} note="USD · 選択期間の合計" />
          <Kpi label="アクティブ日数" value={selected.activeDays} suffix="日" note="3日 連続利用" />
          <Kpi label="デバイス" value={overview.isPending ? '—' : String(deviceCount)} suffix="台" note={`受信済み ${receivedHubs} Hub`} live />
        </section>

        <div className={classes.primaryGrid}>
          <section className={`${classes.panel} ${classes.trendPanel}`} id="trend">
            <PanelHeader title="利用トレンド" caption="トークン / 日" />
            <div className={classes.chartLegend}><span><i />Tokyo Hub</span><span><i />Osaka Hub</span></div>
            <div className={classes.chart} role="img" aria-label={`${selected.range}の固定サンプルトレンド`}>
              <div className={classes.axis}><span>1.59B</span><span>1.06B</span><span>530.98M</span><span>0</span></div>
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
              <div className={classes.toolLead}><small>最も利用したツール</small><strong>Codex</strong><span>4.08B tokens</span></div>
            </div>
            <div className={classes.dataRows}>{TOOL_ROWS.map(([name, value, share]) => <div key={name}><span><i />{name}</span><b>{value}</b><small>{share}</small></div>)}</div>
          </section>

          <section className={classes.panel} id="models">
            <PanelHeader title="モデル" />
            <div className={classes.modelList}>{MODEL_ROWS.map(([name, value, share]) => <div key={name}><span>{name}</span><b>{value} <small>{share}%</small></b><i><em style={{ width: `${share * 2}%` }} /></i></div>)}</div>
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
  const maxTokens = hubs.reduce((max, hub) => Math.max(max, hub.state?.periods[period].totalTokens ?? 0), 0);

  return <div className={classes.hubList}>{hubs.map((hub) => {
    const usage = hub.state?.periods[period];
    const hostnames = hub.state?.devices.map((device) => device.hostname).join(', ');
    const ratio = usage && maxTokens > 0 ? usage.totalTokens / maxTokens * 100 : 0;

    return <article key={hub.hubId} className={classes.hub} aria-label={hub.name}>
      <div className={classes.hubHeading}>
        <div className={classes.hubIdentity}>
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
      {hub.state && usage ? <>
        <div className={classes.hubBar} role="img" aria-label={`${hub.name}: ${usage.totalTokens.toLocaleString('en-US')} tokens（最大Hub比 ${Math.round(ratio)}%）`}><i style={{ width: `${ratio}%` }} /></div>
        <div className={classes.hubMeta}><span>{hub.state.devices.length}台</span><time dateTime={hub.state.updatedAt}>更新 {formatDateTime(hub.state.updatedAt)}</time></div>
      </> : <p className={classes.emptyHub}>まだ情報を受信していません</p>}
    </article>;
  })}</div>;
}

function formatTokens(value: number) {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value);
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}
