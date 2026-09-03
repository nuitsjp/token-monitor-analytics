import {
  Body1,
  Button,
  Caption1,
  Field,
  MessageBar,
  MessageBarBody,
  Select,
  Spinner,
  Subtitle1,
  Tab,
  TabList,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { StatusBadge } from "../../components/StatusBadge";
import { Gauge, KeyValue } from "../../components/design";
import { formatOverviewInstant } from "../../lib/overviewDisplay";
import type {
  CatalogSnapshot,
  EstimationEvidenceSnapshot,
  FrontendAdapter,
  LimitSeriesFilterInput,
  LimitSeriesSnapshot,
  LimitSeriesDetailSnapshot,
} from "../../lib/backend";
import { cycleTypeLabel } from "../../lib/displayLabels";

const useStyles = makeStyles({
  page: { display: "grid", gap: tokens.spacingVerticalL, maxWidth: "110rem" },
  controls: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 15rem), 1fr))",
    gap: tokens.spacingHorizontalM,
  },
  list: { display: "grid", gap: tokens.spacingVerticalS },
  group: { display: "grid", gap: tokens.spacingVerticalS },
  groupHeading: {
    display: "flex",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalM,
    flexWrap: "wrap",
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
  },
  groupTitle: { display: "grid", gap: tokens.spacingVerticalXXS },
  groupSummary: {
    display: "grid",
    gap: tokens.spacingVerticalXXS,
    textAlign: "end",
  },
  row: {
    display: "grid",
    gridTemplateColumns: "minmax(14rem, 2fr) repeat(5, minmax(8rem, 1fr)) auto",
    alignItems: "center",
    gap: tokens.spacingHorizontalM,
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: tokens.shadow4,
    contentVisibility: "auto",
    containIntrinsicSize: "0 88px",
    "@media (max-width: 70rem)": { gridTemplateColumns: "1fr 1fr" },
  },
  rowHeader: {
    display: "grid",
    gridTemplateColumns: "minmax(14rem, 2fr) repeat(5, minmax(8rem, 1fr)) auto",
    alignItems: "center",
    gap: tokens.spacingHorizontalM,
    padding: `0 ${tokens.spacingHorizontalM}`,
    color: tokens.colorNeutralForeground3,
    "@media (max-width: 70rem)": { display: "none" },
  },
  cell: {
    minWidth: 0,
    display: "grid",
    gap: tokens.spacingVerticalXXS,
    overflowWrap: "anywhere",
  },
  usageCell: {
    minWidth: 0,
    display: "grid",
    gap: tokens.spacingVerticalXXS,
    alignContent: "center",
  },
  numeric: {
    fontVariantNumeric: "tabular-nums",
    fontWeight: tokens.fontWeightSemibold,
  },
  muted: { color: tokens.colorNeutralForeground3 },
  status: { fontWeight: tokens.fontWeightSemibold },
  detail: { display: "grid", gap: tokens.spacingVerticalL },
  detailGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 16rem), 1fr))",
    gap: tokens.spacingHorizontalM,
  },
  card: {
    display: "grid",
    gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: tokens.shadow4,
  },
  table: { width: "100%", borderCollapse: "collapse" },
  th: {
    textAlign: "start",
    padding: tokens.spacingVerticalS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  td: {
    padding: tokens.spacingVerticalS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    verticalAlign: "top",
    overflowWrap: "anywhere",
  },
});

type DetailTab = "current" | "series" | "quality" | "history" | "evidence";

function formatDate(value: string, timeZone: string): string {
  if (!value) return "—";
  try {
    return formatOverviewInstant(value, timeZone);
  } catch {
    return value;
  }
}

function formatResetDate(value: string, timeZone: string): string {
  if (!value) return "不明";
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return "不明";
  if (instant.getTime() <= Date.now()) return "経過済み";
  return formatDate(value, timeZone);
}

function evidenceKindLabel(value: string): string {
  return (
    (
      {
        matched_observation: "対応する観測",
        calculation_interval: "計算区間",
        difference_row: "利用率と利用額の差分",
        plan_history: "プラン履歴",
        completeness: "活動主体の完全性",
      } as Record<string, string>
    )[value] ?? "計算根拠"
  );
}

function FilterBar({
  catalog,
  input,
  onChange,
}: {
  catalog: CatalogSnapshot;
  input: LimitSeriesFilterInput;
  onChange: (next: LimitSeriesFilterInput) => void;
}) {
  const services = catalog.services ?? [];
  const definitions = catalog.limitDefinitions ?? [];
  const versions = catalog.planVersions ?? [];
  return (
    <div className={useStyles().controls}>
      <Field label="サービス">
        <Select
          value={input.serviceId}
          onChange={(event) =>
            onChange({ ...input, serviceId: event.target.value })
          }
        >
          <option value="">すべて</option>
          {services.map((service) => (
            <option key={service.id} value={service.id}>
              {service.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="状態">
        <Select
          value={input.status}
          onChange={(event) =>
            onChange({ ...input, status: event.target.value })
          }
        >
          <option value="">すべて</option>
          <option value="not_applicable">推定対象外</option>
          <option value="uncomputed">未算出</option>
          <option value="insufficient_observations">観測不足</option>
          <option value="unidentifiable">識別不能</option>
          <option value="model_mismatch">モデル不適合</option>
          <option value="estimated">推定済み</option>
        </Select>
      </Field>
      <Field label="プラン版">
        <Select
          value={input.planVersionId}
          onChange={(event) =>
            onChange({ ...input, planVersionId: event.target.value })
          }
        >
          <option value="">すべて</option>
          {versions.map((version) => (
            <option key={version.id} value={version.id}>
              {version.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="利用枠定義">
        <Select
          value={input.limitDefinitionId}
          onChange={(event) =>
            onChange({ ...input, limitDefinitionId: event.target.value })
          }
        >
          <option value="">すべて</option>
          {definitions.map((definition) => (
            <option key={definition.id} value={definition.id}>
              {definition.meaning}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="並び順">
        <Select
          value={`${input.sortBy}:${input.descending ? "desc" : "asc"}`}
          onChange={(event) => {
            const [sortBy, direction] = event.target.value.split(":");
            onChange({ ...input, sortBy, descending: direction === "desc" });
          }}
        >
          <option value="status:asc">状態</option>
          <option value="remainingPercent:asc">残り（%）</option>
          <option value="latestObservationAt:desc">最新観測時刻</option>
        </Select>
      </Field>
    </div>
  );
}

function GroupHeader({
  item,
  displayTimeZone,
}: {
  item: LimitSeriesSnapshot;
  displayTimeZone: string;
}) {
  const styles = useStyles();
  return (
    <div className={styles.groupHeading}>
      <div className={styles.groupTitle}>
        <Subtitle1>
          {item.planVersionName || "プラン版未設定"} ×{" "}
          {item.limitDefinitionName}
        </Subtitle1>
        <Caption1>
          {item.currentInterval
            ? `${formatDate(item.currentInterval.validFrom, displayTimeZone)} ～ ${formatDate(item.currentInterval.validTo, displayTimeZone)}`
            : "カレント計算区間なし"}
        </Caption1>
      </div>
      <div className={styles.groupSummary}>
        <Caption1>プラン利用上限（API換算）</Caption1>
        <Body1>{item.estimatedLimitLabel || item.planLimitLabel || "—"}</Body1>
      </div>
      <div className={styles.groupSummary}>
        <Caption1>月間換算推定利用上限</Caption1>
        <Body1>{item.monthlyEquivalentLimitLabel || "未算出"}</Body1>
      </div>
      <div className={styles.groupSummary}>
        <Caption1>標準価格推定最大価値倍率</Caption1>
        <Body1>{item.valueMultiplierLabel || "未算出"}</Body1>
      </div>
      {item.result ? (
        <div>
          <Caption1>品質</Caption1>
          <Body1>{item.result.status.label}</Body1>
        </div>
      ) : null}
      {item.latestValidReference ? (
        <Caption1>
          過去の最新有効区間を参照・根拠時刻{" "}
          {formatDate(item.latestValidReference.observedAt, displayTimeZone)}
          ・経過 {item.latestValidReference.age}
        </Caption1>
      ) : null}
    </div>
  );
}

function SeriesRow({
  item,
  displayTimeZone,
}: {
  item: LimitSeriesSnapshot;
  displayTimeZone: string;
}) {
  const styles = useStyles();
  return (
    <div className={styles.row} data-testid={`limit-series-${item.id}`}>
      <div className={styles.cell}>
        <Body1>{item.logicalAccountName}</Body1>
        <Caption1 className={styles.muted}>
          {item.serviceName} / {item.limitDefinitionName} /{" "}
          {cycleTypeLabel(item.cycleType)}
        </Caption1>
      </div>
      <div className={styles.cell}>
        <StatusBadge status={item.state} />
        <Caption1 className={styles.muted}>{item.stateReason}</Caption1>
      </div>
      <div className={styles.usageCell}>
        <Body1 className={styles.numeric} title={item.usedPercentDetailLabel}>
          {item.usedPercentLabel ? `${item.usedPercentLabel}%` : "—"}
        </Body1>
        {item.usedPercent === null ? null : (
          <Gauge
            percent={item.usedPercent}
            label={`利用率 ${item.usedPercentLabel}%`}
          />
        )}
      </div>
      <div className={styles.usageCell}>
        <Body1 className={styles.numeric} title={item.remainingDetailLabel}>
          {item.remainingLabel || "—"}
        </Body1>
      </div>
      <div className={styles.cell}>
        <Body1 title={item.resetAt ? `UTC ${item.resetAt}` : undefined}>
          {formatResetDate(item.resetAt, displayTimeZone)}
        </Body1>
      </div>
      <div className={styles.cell}>
        <Body1>{formatDate(item.latestObservationAt, displayTimeZone)}</Body1>
      </div>
      <div className={styles.cell}>
        <Body1>
          {item.seriesState === "normal"
            ? "正常"
            : item.seriesState === "inconsistent"
              ? "不整合"
              : "断絶"}
        </Body1>
      </div>
      <Link to={`/limits/${encodeURIComponent(item.id)}`}>詳細</Link>
    </div>
  );
}

function SeriesList({
  items,
  displayTimeZone,
}: {
  items: LimitSeriesSnapshot[];
  displayTimeZone: string;
}) {
  const styles = useStyles();
  const groups = useMemo(() => {
    const grouped = new Map<string, LimitSeriesSnapshot[]>();
    for (const item of items) {
      const key = `${item.planVersionId}|${item.limitDefinitionId}`;
      const values = grouped.get(key) ?? [];
      values.push(item);
      grouped.set(key, values);
    }
    return [...grouped.values()];
  }, [items]);
  return (
    <div className={styles.list}>
      {groups.length === 0 ? (
        <Body1>現在有効な利用枠系列はありません。</Body1>
      ) : null}
      {groups.map((group) => (
        <section
          className={styles.group}
          key={`${group[0].planVersionId}|${group[0].limitDefinitionId}`}
        >
          <GroupHeader item={group[0]} displayTimeZone={displayTimeZone} />
          <div className={styles.rowHeader} aria-hidden="true">
            <Caption1>利用枠</Caption1>
            <Caption1>状態</Caption1>
            <Caption1>最新利用率</Caption1>
            <Caption1>残り</Caption1>
            <Caption1>リセット</Caption1>
            <Caption1>観測時刻</Caption1>
            <Caption1>系列</Caption1>
          </div>
          {group.map((item) => (
            <SeriesRow
              item={item}
              displayTimeZone={displayTimeZone}
              key={item.id}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

function CurrentTab({ detail }: { detail: LimitSeriesDetailSnapshot }) {
  const styles = useStyles();
  const item = detail.series;
  return (
    <div className={styles.detailGrid}>
      <div className={styles.card}>
        <Caption1>系列</Caption1>
        <Body1>
          {item.logicalAccountName} / {item.limitDefinitionName}
        </Body1>
        <Body1>{item.serviceName}</Body1>
      </div>
      <div className={styles.card}>
        <Caption1>前提</Caption1>
        <Body1>{item.planVersionName || "プラン版未設定"}</Body1>
        <Body1>{item.currentInterval ? "計算区間あり" : "計算区間なし"}</Body1>
      </div>
      <div className={styles.card}>
        <Caption1>現在の状態</Caption1>
        <Body1>{item.state.label}</Body1>
        <Body1>{item.stateReason}</Body1>
      </div>
      <div className={styles.card}>
        <Caption1>プラン利用上限</Caption1>
        <Body1>{item.estimatedLimitLabel || item.planLimitLabel || "—"}</Body1>
      </div>
      <div className={styles.card}>
        <Caption1>月間換算推定利用上限</Caption1>
        <Body1>{item.monthlyEquivalentLimitLabel || "未算出"}</Body1>
        <Caption1>{item.valueReason}</Caption1>
      </div>
      <div className={styles.card}>
        <Caption1>標準価格推定最大価値倍率</Caption1>
        <Body1>{item.valueMultiplierLabel || "未算出"}</Body1>
        <Body1>
          {item.standardPriceUsdMonthlyPerSeat === null
            ? "標準価格なし"
            : `$${item.standardPriceUsdMonthlyPerSeat.toFixed(2)} / 月 / 1シート`}
        </Body1>
        {item.standardPriceSourceUrl ? (
          <a
            href={item.standardPriceSourceUrl}
            target="_blank"
            rel="noreferrer"
          >
            標準価格の出典
          </a>
        ) : null}
      </div>
    </div>
  );
}

function SeriesTab({
  detail,
  displayTimeZone,
}: {
  detail: LimitSeriesDetailSnapshot;
  displayTimeZone: string;
}) {
  const styles = useStyles();
  return (
    <div className={styles.detailGrid}>
      <div className={styles.card}>
        <Caption1>系列状態</Caption1>
        <Body1>
          {detail.series.seriesState === "normal"
            ? "正常"
            : detail.series.seriesState === "inconsistent"
              ? "不整合"
              : "断絶"}
        </Body1>
      </div>
      <div className={styles.card}>
        <Caption1>利用率</Caption1>
        <Body1 className={styles.numeric}>
          {detail.series.usedPercentDetailLabel
            ? `${detail.series.usedPercentDetailLabel}%`
            : "—"}
        </Body1>
        <KeyValue
          label="リセット"
          title={detail.series.resetAt ? `UTC ${detail.series.resetAt}` : ""}
        >
          {formatResetDate(detail.series.resetAt, displayTimeZone)}
        </KeyValue>
        <KeyValue label="観測">
          {formatDate(detail.series.latestObservationAt, displayTimeZone)}
        </KeyValue>
      </div>
    </div>
  );
}

function QualityTab({ detail }: { detail: LimitSeriesDetailSnapshot }) {
  const styles = useStyles();
  const result = detail.series.result;
  return (
    <div className={styles.detailGrid}>
      <div className={styles.card}>
        <Caption1>品質</Caption1>
        <Body1>{result ? result.status.label : "未算出"}</Body1>
        <Body1>{result?.statusReason || detail.series.stateReason}</Body1>
      </div>
      <div className={styles.card}>
        <Caption1>品質情報</Caption1>
        <Body1>観測点数: {result?.observationPointCount ?? 0}</Body1>
        <Body1>差分行数: {result?.differenceRowCount ?? 0}</Body1>
        <Body1>階数: {result?.rank ?? 0}</Body1>
        <Body1>最大時刻差: {result?.maxTimeDelta || "—"}</Body1>
        <Body1>計算論理版: {result?.calculationLogicVersion || "—"}</Body1>
      </div>
    </div>
  );
}

function HistoryTab({
  detail,
  displayTimeZone,
}: {
  detail: LimitSeriesDetailSnapshot;
  displayTimeZone: string;
}) {
  const styles = useStyles();
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th className={styles.th}>期間</th>
          <th className={styles.th}>役割・状態</th>
          <th className={styles.th}>推定上限</th>
          <th className={styles.th}>月間換算</th>
          <th className={styles.th}>標準価格</th>
          <th className={styles.th}>価値倍率</th>
          <th className={styles.th}>境界</th>
        </tr>
      </thead>
      <tbody>
        {(detail.history ?? []).map((item) => (
          <tr key={item.id}>
            <td className={styles.td}>
              {formatDate(item.validFrom, displayTimeZone)} ～{" "}
              {formatDate(item.validTo, displayTimeZone)}
            </td>
            <td className={styles.td}>
              <Body1>{item.roleLabel}</Body1>
              {item.stateLabel}
              {item.exclusionReason ? `: ${item.exclusionReason}` : ""}
            </td>
            <td className={styles.td}>
              {item.estimatedLimitLabel || "未算出"}
            </td>
            <td className={styles.td}>
              {item.monthlyEquivalentLimitLabel || "未算出"}
            </td>
            <td className={styles.td}>
              {item.standardPriceUsdMonthlyPerSeat == null
                ? "未算出"
                : `$${item.standardPriceUsdMonthlyPerSeat.toFixed(2)} / 月`}
              {item.standardPriceValidFrom ? (
                <Caption1>
                  有効期間:{" "}
                  {formatDate(item.standardPriceValidFrom, displayTimeZone)} ～{" "}
                  {item.standardPriceValidTo
                    ? formatDate(item.standardPriceValidTo, displayTimeZone)
                    : "現在"}
                </Caption1>
              ) : null}
              {item.standardPriceSourceUrl ? (
                <a
                  href={item.standardPriceSourceUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {item.standardPriceSourceUrl}
                </a>
              ) : null}
            </td>
            <td className={styles.td}>
              <Body1>{item.valueMultiplierLabel || "未算出"}</Body1>
              {item.valueReason ? (
                <Caption1>{item.valueReason}</Caption1>
              ) : null}
            </td>
            <td className={styles.td}>
              {item.boundaries
                ?.map(
                  (boundary) =>
                    `${boundary.kind} (${formatDate(boundary.at, displayTimeZone)})`,
                )
                .join(", ") || "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EvidenceRow({
  evidence,
  displayTimeZone,
}: {
  evidence: EstimationEvidenceSnapshot;
  displayTimeZone: string;
}) {
  const styles = useStyles();
  return (
    <tr>
      <td className={styles.td}>{evidenceKindLabel(evidence.kind)}</td>
      <td className={styles.td}>根拠を保持</td>
      <td className={styles.td}>
        {formatDate(evidence.observedAt, displayTimeZone)}
      </td>
      <td className={styles.td}>
        <Link to={evidence.m08Route}>観測と根拠で確認</Link>
      </td>
    </tr>
  );
}

function EvidenceTab({
  detail,
  displayTimeZone,
}: {
  detail: LimitSeriesDetailSnapshot;
  displayTimeZone: string;
}) {
  const styles = useStyles();
  const evidence = detail.series.result?.evidence ?? [];
  const differences = detail.series.result?.differenceRows ?? [];
  return (
    <div className={styles.detail}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th className={styles.th}>差分行</th>
            <th className={styles.th}>開始/終了</th>
            <th className={styles.th}>係数</th>
            <th className={styles.th}>利用額</th>
            <th className={styles.th}>採否</th>
            <th className={styles.th}>理由</th>
          </tr>
        </thead>
        <tbody>
          {differences.map((row) => (
            <tr key={row.id}>
              <td className={styles.td}>隣接差分</td>
              <td className={styles.td}>
                {formatDate(row.startAt, displayTimeZone)} ～{" "}
                {formatDate(row.endAt, displayTimeZone)}
              </td>
              <td className={styles.td}>
                {row.coefficients?.join(", ") || "—"}
              </td>
              <td className={styles.td}>{row.cost}</td>
              <td className={styles.td}>{row.accepted ? "採用" : "除外"}</td>
              <td className={styles.td}>{row.exclusionReason || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className={styles.table}>
        <thead>
          <tr>
            <th className={styles.th}>種別</th>
            <th className={styles.th}>根拠</th>
            <th className={styles.th}>観測時刻</th>
            <th className={styles.th}>導線</th>
          </tr>
        </thead>
        <tbody>
          {evidence.map((item) => (
            <EvidenceRow
              evidence={item}
              displayTimeZone={displayTimeZone}
              key={item.id}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DetailPanel({
  detail,
  displayTimeZone,
}: {
  detail: LimitSeriesDetailSnapshot;
  displayTimeZone: string;
}) {
  const [tab, setTab] = useState<DetailTab>("current");
  return (
    <div>
      <TabList
        selectedValue={tab}
        onTabSelect={(_, data) => setTab(data.value as DetailTab)}
      >
        <Tab value="current">現在</Tab>
        <Tab value="series">利用枠系列</Tab>
        <Tab value="quality">品質</Tab>
        <Tab value="history">履歴</Tab>
        <Tab value="evidence">根拠</Tab>
      </TabList>
      {tab === "current" ? (
        <CurrentTab detail={detail} />
      ) : tab === "series" ? (
        <SeriesTab detail={detail} displayTimeZone={displayTimeZone} />
      ) : tab === "quality" ? (
        <QualityTab detail={detail} />
      ) : tab === "history" ? (
        <HistoryTab detail={detail} displayTimeZone={displayTimeZone} />
      ) : (
        <EvidenceTab detail={detail} displayTimeZone={displayTimeZone} />
      )}
    </div>
  );
}

export function LimitsPage({
  backend,
  displayTimeZone,
}: {
  backend: FrontendAdapter;
  displayTimeZone: string;
}) {
  const styles = useStyles();
  const navigate = useNavigate();
  const { seriesID } = useParams();
  const [catalog, setCatalog] = useState<CatalogSnapshot | null>(null);
  const [items, setItems] = useState<LimitSeriesSnapshot[]>([]);
  const [detail, setDetail] = useState<LimitSeriesDetailSnapshot | null>(null);
  const [input, setInput] = useState<LimitSeriesFilterInput>({
    serviceId: "",
    status: "",
    planVersionId: "",
    limitDefinitionId: "",
    sortBy: "status",
    descending: false,
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [nextCatalog, nextItems] = await Promise.all([
        backend.getCatalog(),
        backend.getLimitSeries(input),
      ]);
      setCatalog(nextCatalog);
      setItems(nextItems);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "利用枠一覧を読み込めませんでした",
      );
    } finally {
      setLoading(false);
    }
  }, [backend, input]);
  useEffect(() => {
    // Exception: Rule=react-hooks/set-state-in-effect; Reason=mount synchronizes adapter-backed limits; Scope=next line; Owner=frontend; Expires=2026-12-31.
    // The fetch updates external adapter-backed state after the component mounts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  useEffect(() => {
    if (!seriesID) {
      // Exception: Rule=react-hooks/set-state-in-effect; Reason=clearing the series selection clears its dependent detail; Scope=next line; Owner=frontend; Expires=2026-12-31.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDetail(null);
      return;
    }
    void backend
      .getLimitSeriesDetail(decodeURIComponent(seriesID))
      .then(setDetail)
      .catch((cause: unknown) =>
        setError(
          cause instanceof Error ? cause.message : "詳細を読み込めませんでした",
        ),
      );
  }, [backend, seriesID]);
  if (loading && !catalog)
    return (
      <main className={styles.page}>
        <Spinner label="利用枠系列を読み込んでいます" />
      </main>
    );
  return (
    <main className={styles.page}>
      <div>
        <Subtitle1 as="h1">利用上限・価値</Subtitle1>
        <Body1>
          利用上限の推定根拠と、月間換算した上限・標準価格による価値比較を確認します。
        </Body1>
      </div>
      {error ? (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      ) : null}
      {detail ? (
        <div className={styles.detail}>
          <Button onClick={() => void navigate("/limits")}>一覧へ戻る</Button>
          <DetailPanel detail={detail} displayTimeZone={displayTimeZone} />
        </div>
      ) : (
        <>
          <FilterBar
            catalog={
              catalog ?? {
                services: [],
                serviceIdentifierMappings: [],
                limitDefinitions: [],
                plans: [],
                planVersions: [],
                planLimitRules: [],
                standardPrices: [],
                identificationCandidates: [],
                labelChangeCandidates: [],
              }
            }
            input={input}
            onChange={setInput}
          />
          <SeriesList items={items} displayTimeZone={displayTimeZone} />
        </>
      )}
    </main>
  );
}
