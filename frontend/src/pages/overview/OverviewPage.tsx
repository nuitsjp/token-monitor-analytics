import {
  Body1,
  Button,
  Caption1,
  MessageBar,
  MessageBarBody,
  Skeleton,
  SkeletonItem,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowSync16Regular,
  CheckmarkCircle16Regular,
  ErrorCircle16Regular,
  Warning16Regular,
} from "@fluentui/react-icons";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { StatusBadge } from "../../components/StatusBadge";
import {
  CountStat,
  Gauge,
  KeyValue,
  NavigationCard,
} from "../../components/design";
import { gaugeTextClass, useDesignStyles } from "../../components/designStyles";
import type {
  CalendarPeriodUsageSnapshot,
  DataManagementStateSnapshot,
  FrontendAdapter,
  OverviewSnapshot,
} from "../../lib/backend";
import {
  formatOverviewBytes,
  formatOverviewInstant,
} from "../../lib/overviewDisplay";

const useStyles = makeStyles({
  setup: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
    padding: `10px ${tokens.spacingHorizontalL}`,
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: tokens.shadow4,
  },
  setupAction: { marginInlineStart: "auto" },
  setupCompleted: {
    display: "grid",
    gap: tokens.spacingVerticalXXS,
    color: tokens.colorNeutralForeground3,
  },
  setupCompletedItem: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
  },
  loading: { display: "grid", gap: tokens.spacingVerticalM },
  errorActions: { marginTop: tokens.spacingVerticalS },
  statusValue: {
    display: "inline-flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalXS,
    justifyContent: "flex-end",
  },
  limitList: { display: "grid", gap: tokens.spacingVerticalS },
});

export function OverviewPage({
  backend,
  displayTimeZone,
}: {
  backend: FrontendAdapter;
  displayTimeZone: string;
}) {
  const design = useDesignStyles();
  const styles = useStyles();
  const navigate = useNavigate();
  const heading = useRef<HTMLHeadingElement>(null);
  const [snapshot, setSnapshot] = useState<OverviewSnapshot | null>(null);
  const [dataManagement, setDataManagement] =
    useState<DataManagementStateSnapshot | null>(null);
  const [latestValidReferenceCount, setLatestValidReferenceCount] = useState<
    number | null
  >(null);
  const [usage, setUsage] = useState<CalendarPeriodUsageSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [auxiliaryError, setAuxiliaryError] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setAuxiliaryError("");
    try {
      const [
        overviewResult,
        dataManagementResult,
        limitSeriesResult,
        usageResult,
      ] = await Promise.allSettled([
        backend.getOverview(false),
        backend.getDataManagementState(),
        backend.getLimitSeries({
          serviceId: "",
          status: "",
          planVersionId: "",
          limitDefinitionId: "",
          sortBy: "status",
          descending: false,
        }),
        backend.getCalendarPeriodUsage({
          displayTimeZone,
        }),
      ]);
      if (overviewResult.status === "rejected") {
        throw overviewResult.reason;
      }
      setSnapshot(overviewResult.value);
      if (dataManagementResult.status === "fulfilled") {
        setDataManagement(dataManagementResult.value);
      } else {
        setDataManagement(null);
      }
      if (limitSeriesResult.status === "fulfilled") {
        setLatestValidReferenceCount(
          limitSeriesResult.value.filter(
            (item) => item.latestValidReference !== null,
          ).length,
        );
      } else {
        setLatestValidReferenceCount(null);
      }
      setUsage(usageResult.status === "fulfilled" ? usageResult.value : null);
      const unavailable = [
        dataManagementResult.status === "rejected" ? "データ管理状態" : "",
        limitSeriesResult.status === "rejected" ? "推定参照数" : "",
        usageResult.status === "rejected" ? "利用実績" : "",
      ].filter(Boolean);
      if (unavailable.length > 0) {
        setAuxiliaryError(
          `${unavailable.join("・")}を読み込めませんでした。再試行してください。`,
        );
      }
    } catch {
      setError("概要を読み込めませんでした。");
      setSnapshot(null);
      setDataManagement(null);
      setLatestValidReferenceCount(null);
      setUsage(null);
    } finally {
      setLoading(false);
    }
  }, [backend, displayTimeZone]);
  useEffect(() => {
    // Exception: Rule=react-hooks/set-state-in-effect; Reason=mount synchronizes adapter-backed state; Scope=next line; Owner=frontend; Expires=2026-12-31.
    // The initial read synchronizes this page with the external Wails adapter.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  useEffect(() => {
    if (snapshot) heading.current?.focus();
  }, [snapshot]);
  useEffect(
    () =>
      backend.on("navigation:open", (data) => {
        if (data === "/overview") heading.current?.focus();
      }),
    [backend],
  );

  if (loading && !snapshot) {
    return (
      <div className={styles.loading} aria-label="概要を読み込み中">
        <Skeleton>
          <SkeletonItem size={32} />
        </Skeleton>
        <Skeleton>
          <SkeletonItem size={128} />
        </Skeleton>
        <Skeleton>
          <SkeletonItem size={128} />
        </Skeleton>
      </div>
    );
  }
  if (error || !snapshot) {
    return (
      <MessageBar intent="error">
        <MessageBarBody>
          {error || "概要を読み込めませんでした。"}
          <div className={styles.errorActions}>
            <Button onClick={() => void load()}>再試行</Button>
          </div>
        </MessageBarBody>
      </MessageBar>
    );
  }

  if (snapshot.maintenance) {
    return (
      <div className={design.page}>
        <header className={design.pageHeader}>
          <h1 className={design.pageTitle} tabIndex={-1} ref={heading}>
            概要
          </h1>
        </header>
        <MessageBar intent="warning">
          <MessageBarBody>
            <Body1 as="strong">{snapshot.maintenance.status.label}</Body1>{" "}
            {snapshot.maintenance.status.description}
            <div className={styles.errorActions}>
              <Button onClick={() => void navigate("/data")}>
                データ管理を開く
              </Button>
            </div>
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }

  const checklist = snapshot.checklist ?? [];
  const pending = checklist.filter((item) => item.status.code !== "complete");
  const completed = checklist.filter((item) => item.status.code === "complete");
  const nextStep = pending.find((item) => item.actionable) ?? pending[0];
  const estimations = snapshot.estimation.states ?? [];
  const recentLimits = snapshot.recentLimits ?? [];
  const reviewKinds = [
    ...(snapshot.review.actionKinds ?? []),
    ...(snapshot.review.warningKinds ?? []),
  ];
  const backup = dataManagement?.backup;
  const restoreTrial = dataManagement?.restore.trial;
  const abnormalHubs = snapshot.hubs.abnormalCount;
  const todayUsage = usage?.day;
  const monthUsage = usage?.month;
  return (
    <div className={design.page}>
      <header className={design.pageHeader}>
        <h1 className={design.pageTitle} tabIndex={-1} ref={heading}>
          概要
        </h1>
        <Caption1 className={design.pageMeta} title={snapshot.generatedAt}>
          {formatOverviewInstant(snapshot.generatedAt, displayTimeZone)} 更新
        </Caption1>
      </header>

      {auxiliaryError ? (
        <MessageBar intent="warning">
          <MessageBarBody>
            {auxiliaryError}
            <Button appearance="transparent" onClick={() => void load()}>
              再試行
            </Button>
          </MessageBarBody>
        </MessageBar>
      ) : null}

      {snapshot.recoveryNotice ? (
        <MessageBar
          intent={
            snapshot.recoveryNotice.status.intent === "success"
              ? "success"
              : "warning"
          }
        >
          <MessageBarBody>
            <StatusBadge status={snapshot.recoveryNotice.status} />{" "}
            {snapshot.recoveryNotice.status.description} 成果物 SHA-256:{" "}
            {snapshot.recoveryNotice.artifactSha256}
          </MessageBarBody>
        </MessageBar>
      ) : null}
      {!snapshot.timezoneConfirmed ? (
        <MessageBar intent="warning">
          <MessageBarBody>
            表示タイムゾーンを確認してください。{" "}
            <Button
              appearance="transparent"
              onClick={() => void navigate("/settings")}
            >
              表示設定を開く
            </Button>
          </MessageBarBody>
        </MessageBar>
      ) : null}

      {pending.length > 0 && nextStep ? (
        <section aria-labelledby="overview-setup-heading">
          <div className={styles.setup}>
            <span
              className={
                nextStep.status.intent === "warning"
                  ? design.warning
                  : design.muted
              }
              aria-hidden="true"
            >
              <Warning16Regular />
            </span>
            <Body1 as="strong" id="overview-setup-heading">
              初回設定 あと {pending.length} 件
            </Body1>
            <Caption1 className={design.muted}>{nextStep.title}</Caption1>
            <StatusBadge status={nextStep.status} />
            {nextStep.actionable ? (
              <Button
                size="small"
                className={styles.setupAction}
                onClick={() => void navigate(nextStep.route)}
              >
                確認する
              </Button>
            ) : null}
          </div>
          {completed.length > 0 ? (
            <details>
              <summary>完了済み {completed.length} 件</summary>
              <div className={styles.setupCompleted}>
                {completed.map((item) => (
                  <div className={styles.setupCompletedItem} key={item.step}>
                    <Caption1>
                      {item.step}. {item.title}
                    </Caption1>
                    <StatusBadge status={item.status} />
                  </div>
                ))}
              </div>
            </details>
          ) : null}
        </section>
      ) : null}

      <div className={design.grid}>
        <NavigationCard
          title="Hub・収集"
          to="/hubs"
          ariaLabel="Hub・収集を開く"
        >
          <div className={design.counts}>
            <CountStat
              icon={<ArrowSync16Regular />}
              value={`${snapshot.hubs.scheduledCount}/${snapshot.hubs.enabledCount}`}
              label={`定期収集が有効な Hub ${snapshot.hubs.scheduledCount} / ${snapshot.hubs.enabledCount}`}
            />
            <CountStat
              icon={<ArrowSync16Regular />}
              value={snapshot.hubs.runningCount}
              label={`実行中 ${snapshot.hubs.runningCount} 件`}
              tone={snapshot.hubs.runningCount > 0 ? "success" : "muted"}
            />
            <CountStat
              icon={<ErrorCircle16Regular />}
              value={abnormalHubs}
              label={`異常 Hub ${abnormalHubs} 件`}
              tone={abnormalHubs > 0 ? "danger" : "muted"}
            />
          </div>
          <StatusCounts
            label="接続状態"
            items={snapshot.hubs.connectionStates ?? []}
            className={styles.statusValue}
          />
          <StatusCounts
            label="現在の実行状態"
            items={snapshot.hubs.currentCollectionStates ?? []}
            className={styles.statusValue}
          />
          <StatusCounts
            label="最終取得結果"
            items={snapshot.hubs.lastCollectionStates ?? []}
            className={styles.statusValue}
          />
          <KeyValue label="最終成功" title={snapshot.hubs.lastSuccessAt}>
            {formatOverviewInstant(
              snapshot.hubs.lastSuccessAt,
              displayTimeZone,
            )}
          </KeyValue>
        </NavigationCard>

        {usage ? (
          <NavigationCard
            title="当日・当月の利用実績"
            to="/usage"
            ariaLabel="利用実績を開く"
            wide
          >
            <div className={design.metricRow}>
              <div className={design.metricCell}>
                <Caption1 className={design.metricLabel}>当日トークン</Caption1>
                <span className={design.metric}>
                  {todayUsage?.available
                    ? formatUsageTokens(todayUsage.tokens)
                    : "未取得"}
                </span>
                <Caption1
                  className={design.muted}
                  title="API 単価による換算値。実際の請求額ではありません"
                >
                  {todayUsage?.available
                    ? `API 換算 ${formatUsageCost(todayUsage.apiCostUsd)}*`
                    : (todayUsage?.unavailableReason ?? "未取得")}
                </Caption1>
              </div>
              <div className={design.metricCell}>
                <Caption1 className={design.metricLabel}>当月トークン</Caption1>
                <span className={design.metric}>
                  {monthUsage?.available
                    ? formatUsageTokens(monthUsage.tokens)
                    : "未取得"}
                </span>
                <Caption1
                  className={design.muted}
                  title="API 単価による換算値。実際の請求額ではありません"
                >
                  {monthUsage?.available
                    ? `API 換算 ${formatUsageCost(monthUsage.apiCostUsd)}*`
                    : (monthUsage?.unavailableReason ?? "未取得")}
                </Caption1>
              </div>
            </div>
            {todayUsage?.available && todayUsage.latestObservedAt ? (
              <Caption1 className={design.muted}>
                採用した観測時刻{" "}
                {formatOverviewInstant(
                  todayUsage.latestObservedAt,
                  displayTimeZone,
                )}
                {todayUsage.oldestObservedAt &&
                todayUsage.oldestObservedAt !== todayUsage.latestObservedAt
                  ? `（最古 ${formatOverviewInstant(todayUsage.oldestObservedAt, displayTimeZone)}）`
                  : ""}
              </Caption1>
            ) : null}
          </NavigationCard>
        ) : null}

        {recentLimits.length > 0 ? (
          <NavigationCard title="利用枠" to="/limits" ariaLabel="利用枠を開く">
            <div className={styles.limitList}>
              {recentLimits.slice(0, 2).map((item) => (
                <div
                  className={design.gaugeRow}
                  key={`${item.logicalAccountId}:${item.limitDefinitionId}`}
                >
                  <div className={design.gaugeHeader}>
                    <Body1 className={design.gaugeName}>
                      {item.serviceName}{" "}
                      <span className={design.gaugeContext}>
                        {item.accountName}
                      </span>
                    </Body1>
                    <Body1
                      className={mergeClasses(
                        design.gaugePercent,
                        gaugeTextClass(design, item.remaining),
                      )}
                      title={item.tooltip}
                    >
                      {item.remainingLabel}
                    </Body1>
                  </div>
                  {item.remainingPercent === null ? null : (
                    <Gauge
                      percent={item.remainingPercent}
                      status={item.remaining}
                      label={item.accessibleLabel}
                    />
                  )}
                </div>
              ))}
            </div>
          </NavigationCard>
        ) : null}

        <NavigationCard title="要確認" to="/review" ariaLabel="要確認を開く">
          <div className={design.counts}>
            <CountStat
              icon={<ErrorCircle16Regular />}
              value={snapshot.review.actionItems.count}
              label={`要確認 ${snapshot.review.actionItems.count} 件`}
              tone={snapshot.review.actionItems.count > 0 ? "danger" : "muted"}
            />
            <CountStat
              icon={<Warning16Regular />}
              value={snapshot.review.warnings.count}
              label={`データ警告 ${snapshot.review.warnings.count} 件`}
              tone={snapshot.review.warnings.count > 0 ? "warning" : "muted"}
            />
          </div>
          <KeyValue label="再計算失敗">
            {snapshot.review.recalculationFailures.count} 件
          </KeyValue>
          {reviewKinds.map((item) => (
            <KeyValue key={`${item.code}:${item.label}`} label={item.label}>
              {item.count} 件
            </KeyValue>
          ))}
        </NavigationCard>

        <NavigationCard
          title="推定状態"
          to="/limits"
          ariaLabel="利用上限・価値を開く"
        >
          <div className={design.badgeRow}>
            {estimations.length > 0 ? (
              estimations.map((item) => (
                <span key={item.status.code} className={design.badgeRow}>
                  <StatusBadge status={item.status} />
                  <Caption1 className={design.numeric}>{item.count}</Caption1>
                </span>
              ))
            ) : (
              <Caption1 className={design.muted}>推定対象 0件</Caption1>
            )}
          </div>
          <KeyValue
            label="旧区間を表示中"
            title="非カレントの最新有効計算区間を参照している利用枠系列"
          >
            {latestValidReferenceCount === null
              ? "取得不能"
              : `${latestValidReferenceCount} 件`}
          </KeyValue>
        </NavigationCard>

        <NavigationCard
          title="保存データ"
          to="/data"
          ariaLabel="データ管理を開く"
        >
          <div className={design.metricRow}>
            <div className={design.metricCell}>
              <Caption1 className={design.metricLabel}>データベース</Caption1>
              <span className={design.metric}>
                {formatOverviewBytes(snapshot.capacity.databaseSizeBytes)}
              </span>
            </div>
            <div className={design.metricCell}>
              <Caption1 className={design.metricLabel}>原 JSON</Caption1>
              <span className={design.metric}>
                {snapshot.capacity.rawSnapshotCount}
              </span>
            </div>
          </div>
          {snapshot.capacity.rawSnapshotCount > 0 ? (
            <Caption1
              className={mergeClasses(design.muted, design.numeric)}
              title={`${snapshot.capacity.oldestSnapshotAt} – ${snapshot.capacity.latestSnapshotAt}`}
            >
              {formatOverviewInstant(
                snapshot.capacity.oldestSnapshotAt,
                displayTimeZone,
              )}{" "}
              ～{" "}
              {formatOverviewInstant(
                snapshot.capacity.latestSnapshotAt,
                displayTimeZone,
              )}
            </Caption1>
          ) : null}
          <KeyValue label="バックアップ">
            <OperationResult
              status={backup?.status ?? "not_run"}
              at={backup?.artifact?.createdAt ?? ""}
              displayTimeZone={displayTimeZone}
            />
          </KeyValue>
          <KeyValue label="復元試験">
            <OperationResult
              status={restoreTrial?.status ?? "not_run"}
              at={restoreTrial?.testedAt ?? ""}
              displayTimeZone={displayTimeZone}
            />
          </KeyValue>
          <Caption1 className={design.muted}>
            バックアップには資格情報を含みません。
          </Caption1>
        </NavigationCard>
      </div>
    </div>
  );
}

function formatUsageTokens(value: number): string {
  return new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 }).format(
    value,
  );
}

function formatUsageCost(value: number): string {
  return `$${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 3,
  }).format(value)}`;
}

function operationStatusLabel(status: string): string {
  switch (status) {
    case "success":
    case "succeeded":
      return "成功";
    case "passed":
      return "合格";
    case "failed":
      return "失敗";
    case "creating":
      return "作成中";
    case "validating":
      return "検証中";
    case "running":
      return "試験中";
    case "not_run":
      return "未実施";
    case "cancelled":
      return "キャンセル済み";
    default:
      return "状態不明";
  }
}

function OperationResult({
  status,
  at,
  displayTimeZone,
}: {
  status: string;
  at: string;
  displayTimeZone: string;
}) {
  const design = useDesignStyles();
  const label = operationStatusLabel(status);
  const succeeded =
    status === "success" || status === "succeeded" || status === "passed";
  const failed = status === "failed";
  return (
    <>
      <span
        className={
          succeeded ? design.success : failed ? design.danger : design.muted
        }
        aria-hidden="true"
      >
        {succeeded ? (
          <CheckmarkCircle16Regular />
        ) : failed ? (
          <ErrorCircle16Regular />
        ) : null}
      </span>
      <span>
        {label}
        {at ? ` · ${formatOverviewInstant(at, displayTimeZone)}` : ""}
      </span>
    </>
  );
}

function StatusCounts({
  label,
  items,
  className,
}: {
  label: string;
  items: NonNullable<OverviewSnapshot["hubs"]["connectionStates"]>;
  className: string;
}) {
  const design = useDesignStyles();
  return (
    <KeyValue label={label}>
      <span className={className}>
        {items.length === 0 ? (
          <span className={design.muted}>—</span>
        ) : (
          items.map((item) => (
            <span key={item.status.code} className={design.badgeRow}>
              <StatusBadge status={item.status} />
              <span className={design.numeric}>{item.count}</span>
            </span>
          ))
        )}
      </span>
    </KeyValue>
  );
}
