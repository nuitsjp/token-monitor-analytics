import {
  Body1,
  Button,
  Caption1,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Select,
  Spinner,
  Subtitle1,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowDownload16Regular,
  DataTrending16Regular,
  Dismiss16Regular,
  Filter16Regular,
  Share16Regular,
} from "@fluentui/react-icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import type {
  FrontendAdapter,
  AccountSnapshot,
  CatalogSnapshot,
  HubSnapshot,
  LinkingSnapshot,
  UsageFilterInput,
  UsageSnapshot,
} from "../../lib/backend";
import {
  addLocalDays,
  currentDateInZone,
  firstDateOfMonth,
  zonedMidnight,
} from "../../lib/usageTime";
import { UsageStackedChart } from "./UsageStackedChart";

const useStyles = makeStyles({
  page: { display: "grid", gap: tokens.spacingVerticalL, maxWidth: "100rem" },
  header: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalM,
    flexWrap: "wrap",
  },
  title: { margin: 0, fontSize: tokens.fontSizeBase500 },
  controls: {
    display: "grid",
    gridTemplateColumns: "repeat(5, minmax(9rem, 1fr))",
    gap: tokens.spacingHorizontalM,
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: tokens.shadow4,
    "@media (max-width: 75rem)": {
      gridTemplateColumns: "repeat(3, minmax(10rem, 1fr))",
    },
  },
  timezone: {
    color: tokens.colorBrandForeground1,
    fontWeight: tokens.fontWeightSemibold,
  },
  summary: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: tokens.spacingHorizontalM,
    "@media (max-width: 60rem)": { gridTemplateColumns: "repeat(2, 1fr)" },
  },
  card: {
    display: "grid",
    gap: tokens.spacingVerticalXS,
    padding: "14px 16px",
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: tokens.shadow4,
  },
  metric: {
    fontSize: tokens.fontSizeHero700,
    lineHeight: tokens.lineHeightHero700,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: "tabular-nums",
  },
  sharedMetric: { color: tokens.colorPaletteDarkOrangeForeground1 },
  muted: { color: tokens.colorNeutralForeground3 },
  panel: {
    display: "grid",
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalL,
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: tokens.shadow4,
    minWidth: 0,
  },
  panelHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalM,
  },
  actions: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
  },
  selectedPeriod: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalM,
    flexWrap: "wrap",
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorBrandBackground2,
  },
  selectedPeriodMetrics: {
    display: "flex",
    alignItems: "baseline",
    gap: tokens.spacingHorizontalL,
    flexWrap: "wrap",
    fontVariantNumeric: "tabular-nums",
  },
  tableWrap: { overflowX: "auto" },
  table: { width: "100%", borderCollapse: "collapse", minWidth: "46rem" },
  th: {
    padding: tokens.spacingVerticalS,
    textAlign: "start",
    color: tokens.colorNeutralForeground3,
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  td: {
    padding: tokens.spacingVerticalS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    fontVariantNumeric: "tabular-nums",
  },
  numeric: { textAlign: "end" },
  shared: {
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    color: tokens.colorPaletteDarkOrangeForeground1,
    fontWeight: tokens.fontWeightSemibold,
  },
  amountGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(16rem, 1fr))",
    gap: tokens.spacingHorizontalM,
  },
  amountValue: {
    fontSize: tokens.fontSizeBase500,
    fontWeight: tokens.fontWeightSemibold,
  },
  exportPanel: {
    display: "grid",
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  detailsFilter: {
    display: "grid",
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: tokens.shadow4,
  },
  filterHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalM,
    flexWrap: "wrap",
  },
  filterToggle: {
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorNeutralForeground1,
    backgroundColor: tokens.colorNeutralBackground1,
    cursor: "pointer",
    font: "inherit",
  },
  filterCount: {
    minWidth: "1.25rem",
    padding: `0 ${tokens.spacingHorizontalXS}`,
    borderRadius: tokens.borderRadiusCircular,
    color: tokens.colorNeutralForegroundOnBrand,
    backgroundColor: tokens.colorBrandBackground,
    textAlign: "center",
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
  },
  filterSummary: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    flexWrap: "wrap",
  },
  filterChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    padding: `2px ${tokens.spacingHorizontalXS} 2px ${tokens.spacingHorizontalS}`,
    border: "none",
    borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorBrandForeground1,
    backgroundColor: tokens.colorBrandBackground2,
  },
  chipDismiss: {
    display: "inline-flex",
    alignItems: "center",
    padding: 0,
    border: 0,
    color: tokens.colorBrandForeground1,
    backgroundColor: "transparent",
    cursor: "pointer",
  },
  filterControls: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(11rem, 1fr))",
    gap: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalS,
    "@media (max-width: 75rem)": {
      gridTemplateColumns: "repeat(2, minmax(11rem, 1fr))",
    },
    "@media (max-width: 42rem)": {
      gridTemplateColumns: "1fr",
    },
  },
});

type ExportStatus = "confirm" | "running" | "success" | "cancelled";
type ExportState = {
  format: "csv" | "json";
  status: ExportStatus;
  generatedAt: string;
  filename?: string;
};

type FilterChip = {
  key: keyof Pick<
    UsageFilterInput,
    | "hubId"
    | "collectionDeviceId"
    | "deviceId"
    | "serviceId"
    | "rawServiceIdentifier"
    | "logicalAccountId"
    | "planVersionId"
    | "limitDefinitionId"
    | "model"
  >;
  label: string;
  value: string;
};

function uniqueValues(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))].sort();
}

function serviceName(
  services: NonNullable<CatalogSnapshot["services"]>,
  serviceId: string,
): string {
  return (
    services.find((service) => service.id === serviceId)?.name ?? serviceId
  );
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 }).format(
    value,
  );
}

function formatCost(value: number): string {
  return `${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)} USD*`;
}

function formatPeriodRange(
  start: string,
  end: string,
  displayTimeZone: string,
): string {
  const formatter = new Intl.DateTimeFormat("ja-JP", {
    timeZone: displayTimeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return `${formatter.format(new Date(start))} ～ ${formatter.format(new Date(end))}`;
}

function groupByLabel(groupBy: string): string {
  switch (groupBy) {
    case "model":
      return "モデル";
    case "contract":
      return "契約（プラン版）";
    case "agent":
      return "AIエージェント（観測クライアント）";
    case "hub":
      return "Hub";
    case "collectionDevice":
      return "収集端末";
    case "device":
      return "Hub 端末レコード";
    case "service":
      return "正式サービス";
    case "rawService":
      return "生利用額サービス識別子";
    case "account":
      return "論理アカウント";
    default:
      return "全体";
  }
}

function download(result: {
  filename: string;
  mimeType: string;
  content: string;
}) {
  const blob = new Blob([result.content], { type: result.mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = result.filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function UsagePage({
  backend,
  displayTimeZone,
}: {
  backend: FrontendAdapter;
  displayTimeZone: string;
}) {
  const styles = useStyles();
  const currentDate = currentDateInZone(displayTimeZone);
  const [fromDate, setFromDate] = useState(() => firstDateOfMonth(currentDate));
  const [toDate, setToDate] = useState(() => addLocalDays(currentDate, 1));
  const [granularity, setGranularity] = useState("day");
  const [groupBy, setGroupBy] = useState("model");
  const [hubId, setHubId] = useState("");
  const [collectionDeviceId, setCollectionDeviceId] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [rawServiceIdentifier, setRawServiceIdentifier] = useState("");
  const [logicalAccountId, setLogicalAccountId] = useState("");
  const [planVersionId, setPlanVersionId] = useState("");
  const [limitDefinitionId, setLimitDefinitionId] = useState("");
  const [model, setModel] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [selectedPeriodStart, setSelectedPeriodStart] = useState("");
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [error, setError] = useState("");
  const [hubs, setHubs] = useState<HubSnapshot[]>([]);
  const [catalog, setCatalog] = useState<CatalogSnapshot | null>(null);
  const [accounts, setAccounts] = useState<AccountSnapshot | null>(null);
  const [linking, setLinking] = useState<LinkingSnapshot | null>(null);
  const [exportState, setExportState] = useState<ExportState | null>(null);
  const exportTask = useRef<ReturnType<
    FrontendAdapter["beginUsageExport"]
  > | null>(null);
  useEffect(() => {
    let active = true;
    void Promise.all([
      backend.getHubs(),
      backend.getCatalog(),
      backend.getAccounts(),
      backend.getLinkingSnapshot(),
    ])
      .then(([nextHubs, nextCatalog, nextAccounts, nextLinking]) => {
        if (!active) return;
        setHubs(nextHubs);
        setCatalog(nextCatalog);
        setAccounts(nextAccounts);
        setLinking(nextLinking);
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => {
      active = false;
    };
  }, [backend]);

  const deviceOptions = useMemo(
    () =>
      uniqueValues([
        ...(usage?.evidence ?? []).map((item) => item.deviceId),
        ...(linking?.usageCostSources ?? []).map((item) => item.deviceId),
        ...(linking?.usageLimitSources ?? []).map((item) => item.deviceId),
      ]),
    [linking, usage],
  );
  const collectionDeviceOptions = useMemo(
    () =>
      uniqueValues([
        ...(usage?.evidence ?? []).map((item) => item.collectionDeviceId),
        ...(linking?.hubSwitches ?? []).map((item) => item.collectionDeviceId),
      ]),
    [linking, usage],
  );
  const rawServiceOptions = useMemo(
    () =>
      uniqueValues([
        ...(usage?.evidence ?? []).map((item) => item.rawServiceIdentifier),
        ...(linking?.usageCostSources ?? []).map(
          (item) => item.rawServiceIdentifier,
        ),
        ...(catalog?.serviceIdentifierMappings ?? [])
          .filter((item) => item.kind === "usage_cost")
          .map((item) => item.rawIdentifier),
      ]),
    [catalog, linking, usage],
  );
  const activeFilterChips = useMemo<FilterChip[]>(() => {
    const findHub = hubs.find((item) => item.id === hubId)?.displayName;
    const findAccount = accounts?.logicalAccounts?.find(
      (item) => item.id === logicalAccountId,
    )?.displayName;
    const findVersion = catalog?.planVersions?.find(
      (item) => item.id === planVersionId,
    )?.name;
    const findDefinition = catalog?.limitDefinitions?.find(
      (item) => item.id === limitDefinitionId,
    );
    return (
      [
        { key: "hubId", label: "Hub", value: findHub ?? hubId },
        {
          key: "collectionDeviceId",
          label: "収集端末",
          value: collectionDeviceId,
        },
        { key: "deviceId", label: "Hub 端末レコード", value: deviceId },
        {
          key: "serviceId",
          label: "正式サービス",
          value: serviceId
            ? serviceName(catalog?.services ?? [], serviceId)
            : "",
        },
        {
          key: "rawServiceIdentifier",
          label: "生利用額サービス識別子",
          value: rawServiceIdentifier,
        },
        {
          key: "logicalAccountId",
          label: "論理アカウント",
          value: findAccount ?? logicalAccountId,
        },
        {
          key: "planVersionId",
          label: "プラン版",
          value: findVersion ?? planVersionId,
        },
        {
          key: "limitDefinitionId",
          label: "利用枠定義",
          value: findDefinition
            ? `${findDefinition.meaning} (${findDefinition.id})`
            : limitDefinitionId,
        },
        { key: "model", label: "モデル", value: model },
      ] as FilterChip[]
    ).filter((item) => item.value !== "");
  }, [
    accounts,
    catalog,
    collectionDeviceId,
    deviceId,
    hubId,
    hubs,
    limitDefinitionId,
    logicalAccountId,
    model,
    planVersionId,
    rawServiceIdentifier,
    serviceId,
  ]);
  const clearAdvancedFilters = () => {
    setHubId("");
    setCollectionDeviceId("");
    setDeviceId("");
    setServiceId("");
    setRawServiceIdentifier("");
    setLogicalAccountId("");
    setPlanVersionId("");
    setLimitDefinitionId("");
    setModel("");
  };
  const input = useMemo<UsageFilterInput>(
    () => ({
      from: zonedMidnight(fromDate, displayTimeZone),
      to: zonedMidnight(toDate, displayTimeZone),
      displayTimeZone,
      granularity,
      groupBy,
      hubId,
      collectionDeviceId,
      deviceId,
      serviceId,
      rawServiceIdentifier,
      logicalAccountId,
      planVersionId,
      limitDefinitionId,
      model,
    }),
    [
      collectionDeviceId,
      deviceId,
      displayTimeZone,
      fromDate,
      granularity,
      groupBy,
      hubId,
      limitDefinitionId,
      logicalAccountId,
      model,
      planVersionId,
      rawServiceIdentifier,
      serviceId,
      toDate,
    ],
  );
  const refresh = useCallback(() => {
    let active = true;
    void backend
      .getUsage(input)
      .then((value) => {
        if (active) {
          setError("");
          setUsage(value);
        }
      })
      .catch((reason: unknown) => {
        if (active)
          setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, [backend, input]);
  useEffect(refresh, [refresh]);
  const requestExport = (format: "csv" | "json") => {
    setExportState({
      format,
      status: "confirm",
      generatedAt: new Date().toISOString(),
    });
  };
  const exportRows = async () => {
    if (!exportState) return;
    setError("");
    const task = backend.beginUsageExport(input, exportState.format);
    exportTask.current = task;
    setExportState((current) =>
      current ? { ...current, status: "running" } : current,
    );
    try {
      const result = await task.promise;
      if (exportTask.current !== task) return;
      download(result);
      setExportState((current) =>
        current
          ? { ...current, status: "success", filename: result.filename }
          : current,
      );
    } catch (reason) {
      if (exportTask.current === task) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (exportTask.current === task) exportTask.current = null;
    }
  };
  const cancelExport = () => {
    exportTask.current?.cancel();
    exportTask.current = null;
    setExportState((current) =>
      current ? { ...current, status: "cancelled" } : current,
    );
  };
  const selectedPoint = (usage?.series ?? []).find(
    (point) => point.periodStart === selectedPeriodStart,
  );
  const displayedBreakdown = selectedPoint?.breakdown ?? usage?.breakdown ?? [];
  const timeSeriesRows = (usage?.series ?? []).flatMap((point) =>
    (point.breakdown ?? []).map((row) => ({
      ...row,
      periodStart: point.periodStart,
      periodEnd: point.periodEnd,
    })),
  );

  return (
    <section className={styles.page} aria-labelledby="usage-title">
      <header className={styles.header}>
        <h1 id="usage-title" className={styles.title}>
          利用状況分析
        </h1>
        <Caption1 className={styles.muted}>
          利用量とAPI換算利用金額を、同じ時間軸と内訳で比較
        </Caption1>
      </header>
      <div className={styles.controls} aria-label="利用状況分析の期間と分類">
        <Field label="期間開始">
          <Input
            type="date"
            value={fromDate}
            onChange={(_, data) => setFromDate(data.value)}
          />
        </Field>
        <Field label="期間終了（含まない）">
          <Input
            type="date"
            value={toDate}
            onChange={(_, data) => setToDate(data.value)}
          />
        </Field>
        <Field label="表示タイムゾーン">
          <Input className={styles.timezone} value={displayTimeZone} readOnly />
        </Field>
        <Field label="集計単位">
          <Select
            value={granularity}
            onChange={(_, data) => setGranularity(data.value)}
          >
            <option value="day">日次</option>
            <option value="week">週次（月曜始まり）</option>
            <option value="month">月次</option>
          </Select>
        </Field>
        <Field label="積み上げの分類">
          <Select
            value={groupBy}
            onChange={(_, data) => setGroupBy(data.value)}
          >
            <option value="all">全体</option>
            <option value="model">モデル</option>
            <option value="contract">契約（プラン版）</option>
            <option value="agent">AIエージェント（観測クライアント）</option>
            <option value="hub">Hub</option>
            <option value="collectionDevice">収集端末</option>
            <option value="device">Hub 端末レコード</option>
            <option value="service">正式サービス</option>
            <option value="rawService">生利用額サービス識別子</option>
            <option value="account">論理アカウント</option>
          </Select>
        </Field>
      </div>
      <section className={styles.detailsFilter} aria-label="詳細フィルター">
        <div className={styles.filterHeader}>
          <button
            type="button"
            className={styles.filterToggle}
            aria-expanded={detailsOpen}
            aria-controls="usage-advanced-filters"
            onClick={() => setDetailsOpen((open) => !open)}
          >
            <Filter16Regular aria-hidden="true" />
            <span>詳細フィルター</span>
            {activeFilterChips.length > 0 ? (
              <span
                className={styles.filterCount}
                aria-label={`適用中 ${activeFilterChips.length}件`}
              >
                {activeFilterChips.length}
              </span>
            ) : null}
          </button>
          {activeFilterChips.length === 0 ? (
            <Caption1 className={styles.muted}>
              Hub以降の条件は未指定（全登録 Hub）
            </Caption1>
          ) : null}
        </div>
        {activeFilterChips.length > 0 ? (
          <div className={styles.filterSummary} aria-label="適用中の条件">
            {activeFilterChips.map((chip) => (
              <span className={styles.filterChip} key={chip.key}>
                {chip.label}: {chip.value}
                <button
                  type="button"
                  className={styles.chipDismiss}
                  aria-label={`${chip.label}の条件を解除`}
                  onClick={() => {
                    switch (chip.key) {
                      case "hubId":
                        setHubId("");
                        break;
                      case "collectionDeviceId":
                        setCollectionDeviceId("");
                        break;
                      case "deviceId":
                        setDeviceId("");
                        break;
                      case "serviceId":
                        setServiceId("");
                        break;
                      case "rawServiceIdentifier":
                        setRawServiceIdentifier("");
                        break;
                      case "logicalAccountId":
                        setLogicalAccountId("");
                        break;
                      case "planVersionId":
                        setPlanVersionId("");
                        break;
                      case "limitDefinitionId":
                        setLimitDefinitionId("");
                        break;
                      case "model":
                        setModel("");
                        break;
                    }
                  }}
                >
                  <Dismiss16Regular aria-hidden="true" />
                </button>
              </span>
            ))}
            <Button appearance="subtle" onClick={clearAdvancedFilters}>
              すべて解除
            </Button>
          </div>
        ) : null}
        {detailsOpen ? (
          <div id="usage-advanced-filters" className={styles.filterControls}>
            <Field label="Hub">
              <Select
                value={hubId}
                onChange={(_, data) => setHubId(data.value)}
              >
                <option value="">全登録 Hub</option>
                {hubs.map((hub) => (
                  <option value={hub.id} key={hub.id}>
                    {hub.displayName}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="収集端末">
              <Select
                value={collectionDeviceId}
                onChange={(_, data) => setCollectionDeviceId(data.value)}
              >
                <option value="">すべて</option>
                {collectionDeviceOptions.map((value) => (
                  <option value={value} key={value}>
                    {value}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Hub 端末レコード">
              <Select
                value={deviceId}
                onChange={(_, data) => setDeviceId(data.value)}
              >
                <option value="">すべて</option>
                {deviceOptions.map((value) => (
                  <option value={value} key={value}>
                    {value}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="正式サービス">
              <Select
                value={serviceId}
                onChange={(_, data) => setServiceId(data.value)}
              >
                <option value="">すべて</option>
                {(catalog?.services ?? []).map((service) => (
                  <option value={service.id} key={service.id}>
                    {service.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="生利用額サービス識別子">
              <Select
                value={rawServiceIdentifier}
                onChange={(_, data) => setRawServiceIdentifier(data.value)}
              >
                <option value="">すべて</option>
                {rawServiceOptions.map((value) => (
                  <option value={value} key={value}>
                    {value}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="論理アカウント">
              <Select
                value={logicalAccountId}
                onChange={(_, data) => setLogicalAccountId(data.value)}
              >
                <option value="">すべて</option>
                {(accounts?.logicalAccounts ?? []).map((account) => (
                  <option value={account.id} key={account.id}>
                    {account.displayName}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="プラン版">
              <Select
                value={planVersionId}
                onChange={(_, data) => setPlanVersionId(data.value)}
              >
                <option value="">すべて</option>
                {(catalog?.planVersions ?? []).map((version) => (
                  <option value={version.id} key={version.id}>
                    {version.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="利用枠定義">
              <Select
                value={limitDefinitionId}
                onChange={(_, data) => setLimitDefinitionId(data.value)}
              >
                <option value="">すべて</option>
                {(catalog?.limitDefinitions ?? []).map((definition) => (
                  <option value={definition.id} key={definition.id}>
                    {definition.meaning}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="モデル">
              <Input
                value={model}
                placeholder="すべて"
                onChange={(_, data) => setModel(data.value)}
              />
            </Field>
          </div>
        ) : null}
      </section>
      {error ? (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      ) : null}
      {!usage ? (
        <Spinner label="利用実績を集計しています" />
      ) : (
        <>
          <div className={styles.summary}>
            <article className={styles.card}>
              <Caption1 className={styles.muted}>トークン総使用量</Caption1>
              <span className={styles.metric}>
                {formatTokens(usage.summary.tokens)}
              </span>
              <Caption1>
                {usage.summary.sourceCount} ソース・
                {usage.summary.observationCount} 差分
              </Caption1>
            </article>
            <article
              className={styles.card}
              title="API 単価による換算値。実際の請求額ではありません"
            >
              <Caption1 className={styles.muted}>API 換算利用額</Caption1>
              <span className={styles.metric}>
                {formatCost(usage.summary.apiCostUsd)}
              </span>
              <Caption1>実際の請求額ではありません</Caption1>
            </article>
            <article className={styles.card}>
              <Caption1 className={styles.muted}>共有利用実績</Caption1>
              <span
                className={mergeClasses(styles.metric, styles.sharedMetric)}
              >
                {formatTokens(usage.summary.sharedTokens)}
              </span>
              <Caption1>アカウント別へ按分しません</Caption1>
            </article>
            <article
              className={styles.card}
              title="共有観測利用額。実際の請求額ではありません"
            >
              <Caption1 className={styles.muted}>共有観測利用額</Caption1>
              <span
                className={mergeClasses(styles.metric, styles.sharedMetric)}
              >
                {formatCost(usage.summary.sharedApiCostUsd)}
              </span>
              <Caption1>観測値・按分なし</Caption1>
            </article>
          </div>
          <article
            className={styles.panel}
            aria-label="利用量と利用金額の時系列分析"
          >
            <div className={styles.panelHeader}>
              <div>
                <Subtitle1>利用量 × 利用金額の時系列分析</Subtitle1>
                <Caption1 className={styles.muted}>
                  {groupByLabel(groupBy)}
                  で共通分類。期間合計に占める利用量・利用金額の寄与率を同じ重みで評価し、上位5分類を個別表示、残りは灰色の「それ以外」に集約
                </Caption1>
                {groupBy === "agent" ? (
                  <Caption1 className={styles.muted}>
                    Hub が記録した clients
                    識別子による分類です。推測したエージェント名は使用しません。
                  </Caption1>
                ) : null}
              </div>
              <div className={styles.actions}>
                <Button
                  icon={<ArrowDownload16Regular />}
                  disabled={exportState?.status === "running"}
                  onClick={() => requestExport("csv")}
                >
                  CSV
                </Button>
                <Button
                  icon={<ArrowDownload16Regular />}
                  disabled={exportState?.status === "running"}
                  onClick={() => requestExport("json")}
                >
                  JSON
                </Button>
              </div>
            </div>
            {exportState?.status === "confirm" ? (
              <div
                className={styles.exportPanel}
                role="dialog"
                aria-label="利用実績の出力確認"
              >
                <Subtitle1>出力内容を確認</Subtitle1>
                <Body1>
                  {exportState.format.toUpperCase()}・時系列内訳表・全{" "}
                  {timeSeriesRows.length} 行
                </Body1>
                <Caption1>
                  保存先: 既定のダウンロード先 / 列:
                  期間、分類、帰属、利用量、API 換算利用金額、差分数 /
                  スキーマ版: 2
                </Caption1>
                <Caption1>
                  期間 {fromDate} ～ {toDate}（終了日を含まない）・
                  {displayTimeZone}・{granularity}・観測値 / 生成 UTC 日時{" "}
                  {exportState.generatedAt}
                </Caption1>
                <Body1>
                  アカウント識別情報と利用履歴を含み得る機微データです。
                </Body1>
                <div className={styles.actions}>
                  <Button
                    appearance="primary"
                    onClick={() => void exportRows()}
                  >
                    出力を開始
                  </Button>
                  <Button onClick={() => setExportState(null)}>戻る</Button>
                </div>
              </div>
            ) : exportState?.status === "running" ? (
              <div className={styles.exportPanel} role="status">
                <Spinner label="利用実績をバックグラウンドで出力しています" />
                <Caption1>完了するまで成果物は保存しません。</Caption1>
                <Button onClick={cancelExport}>出力を取り消す</Button>
              </div>
            ) : exportState?.status === "success" ? (
              <MessageBar intent="success">
                <MessageBarBody>
                  {exportState.filename} を出力しました。
                </MessageBarBody>
              </MessageBar>
            ) : exportState?.status === "cancelled" ? (
              <MessageBar intent="warning">
                <MessageBarBody>
                  出力を取り消しました。未完成の成果物はありません。
                </MessageBarBody>
              </MessageBar>
            ) : null}
            <UsageStackedChart
              points={usage.series ?? []}
              breakdown={usage.breakdown ?? []}
              displayTimeZone={displayTimeZone}
              granularity={granularity}
              selectedPeriodStart={selectedPeriodStart}
              onSelectPeriod={setSelectedPeriodStart}
            />
            {selectedPoint ? (
              <div className={styles.selectedPeriod} role="status">
                <div>
                  <Caption1 className={styles.muted}>選択中の期間</Caption1>
                  <Body1>
                    {formatPeriodRange(
                      selectedPoint.periodStart,
                      selectedPoint.periodEnd,
                      displayTimeZone,
                    )}
                  </Body1>
                </div>
                <div className={styles.selectedPeriodMetrics}>
                  <span>利用量 {formatTokens(selectedPoint.tokens)}</span>
                  <span>
                    API換算利用金額 {formatCost(selectedPoint.apiCostUsd)}
                  </span>
                  <span>{selectedPoint.observationCount} 差分</span>
                </div>
                <Button onClick={() => setSelectedPeriodStart("")}>
                  期間合計へ戻す
                </Button>
              </div>
            ) : (
              <Caption1 className={styles.muted}>
                現在は期間合計を表示しています。棒を選択すると該当期間の内訳へ切り替わります。
              </Caption1>
            )}
            <Caption1 className={styles.muted}>
              * API単価による換算値。実際の請求額ではありません。
            </Caption1>
          </article>
          <article className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <Subtitle1>時系列データ</Subtitle1>
                <Caption1 className={styles.muted}>
                  グラフと同じ期間・分類・観測値を表形式で表示
                </Caption1>
              </div>
              <Caption1>{timeSeriesRows.length} 行</Caption1>
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th className={styles.th}>期間</th>
                    <th className={styles.th}>分類</th>
                    <th className={styles.th}>帰属</th>
                    <th className={mergeClasses(styles.th, styles.numeric)}>
                      利用量（トークン）
                    </th>
                    <th className={mergeClasses(styles.th, styles.numeric)}>
                      API換算利用金額
                    </th>
                    <th className={mergeClasses(styles.th, styles.numeric)}>
                      差分数
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {timeSeriesRows.map((row) => (
                    <tr key={`${row.periodStart}-${row.key}`}>
                      <td className={styles.td}>
                        {formatPeriodRange(
                          row.periodStart,
                          row.periodEnd,
                          displayTimeZone,
                        )}
                      </td>
                      <td className={styles.td}>{row.label}</td>
                      <td className={styles.td}>{row.attribution}</td>
                      <td className={mergeClasses(styles.td, styles.numeric)}>
                        {formatTokens(row.tokens)}
                      </td>
                      <td
                        className={mergeClasses(styles.td, styles.numeric)}
                        title="実際の請求額ではありません"
                      >
                        {formatCost(row.apiCostUsd)}
                      </td>
                      <td className={mergeClasses(styles.td, styles.numeric)}>
                        {row.observationCount}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>
          <article className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <Subtitle1>
                  {selectedPoint ? "選択期間" : "期間合計"}の分類別内訳
                </Subtitle1>
                <Caption1 className={styles.muted}>
                  「{groupByLabel(groupBy)}
                  」で集計。利用量と利用金額で分類順・色を共通化し、同じ元観測は一度だけ含めます
                </Caption1>
              </div>
              <DataTrending16Regular aria-hidden="true" />
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th className={styles.th}>分類</th>
                    <th className={styles.th}>帰属</th>
                    <th className={mergeClasses(styles.th, styles.numeric)}>
                      トークン数
                    </th>
                    <th className={mergeClasses(styles.th, styles.numeric)}>
                      API 換算利用額
                    </th>
                    <th className={mergeClasses(styles.th, styles.numeric)}>
                      差分数
                    </th>
                    <th className={styles.th}>根拠</th>
                  </tr>
                </thead>
                <tbody>
                  {displayedBreakdown.map((row) => (
                    <tr key={row.key}>
                      <td className={styles.td}>{row.label}</td>
                      <td className={styles.td}>
                        {row.attribution === "共有利用実績" ? (
                          <span className={styles.shared}>
                            <Share16Regular aria-hidden="true" />
                            共有利用実績
                          </span>
                        ) : (
                          row.attribution
                        )}
                      </td>
                      <td className={mergeClasses(styles.td, styles.numeric)}>
                        {formatTokens(row.tokens)}
                      </td>
                      <td
                        className={mergeClasses(styles.td, styles.numeric)}
                        title="実際の請求額ではありません"
                      >
                        {formatCost(row.apiCostUsd)}
                      </td>
                      <td className={mergeClasses(styles.td, styles.numeric)}>
                        {row.observationCount}
                      </td>
                      <td className={styles.td}>
                        <Link to={row.evidenceRoute}>集計根拠</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>
          {(usage.nativeAmounts?.length ?? 0) > 0 ? (
            <article className={styles.panel}>
              <div>
                <Subtitle1>残高・クレジット・従量額</Subtitle1>
                <Body1 className={styles.muted}>
                  元の単位で表示し、パーセントや USD へ変換しません。
                </Body1>
              </div>
              <div className={styles.amountGrid}>
                {usage.nativeAmounts?.map((amount) => (
                  <div className={styles.card} key={amount.observationId}>
                    <Caption1>
                      {amount.hubName} / {amount.serviceIdentifier}
                    </Caption1>
                    <span className={styles.amountValue}>
                      残り {amount.remaining || "—"} {amount.currency}
                    </span>
                    <Caption1>
                      {amount.label}・使用 {amount.used || "—"} / 上限{" "}
                      {amount.limit || "—"}
                    </Caption1>
                    <Link to={amount.m08Route}>元観測を表示</Link>
                  </div>
                ))}
              </div>
            </article>
          ) : null}
        </>
      )}
    </section>
  );
}
