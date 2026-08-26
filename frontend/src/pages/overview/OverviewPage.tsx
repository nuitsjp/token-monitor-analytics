import {
  Body1,
  Button,
  Caption1,
  Card,
  CardHeader,
  MessageBar,
  MessageBarBody,
  ProgressBar,
  Skeleton,
  SkeletonItem,
  Subtitle1,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { ChevronRight16Regular } from "@fluentui/react-icons";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { OverviewSnapshot } from "../../../bindings/token-monitor-analytics/internal/desktop/models.js";
import { StatusBadge } from "../../components/StatusBadge";
import type {
  DataManagementStateSnapshot,
  FrontendAdapter,
} from "../../lib/backend";
import {
  formatOverviewBytes,
  formatOverviewInstant,
  progressColor,
} from "../../lib/overviewDisplay";

const useStyles = makeStyles({
  page: {
    display: "grid",
    gap: tokens.spacingVerticalL,
    maxWidth: "100rem",
    minWidth: 0,
  },
  intro: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalM,
  },
  updated: { marginLeft: "auto", color: tokens.colorNeutralForeground3 },
  title: {
    margin: 0,
    fontSize: tokens.fontSizeBase500,
    lineHeight: tokens.lineHeightBase500,
    fontWeight: tokens.fontWeightSemibold,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: tokens.spacingHorizontalL,
    alignItems: "start",
  },
  card: {
    minWidth: 0,
    display: "grid",
    gap: tokens.spacingVerticalS,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}`,
  },
  cardHeader: { alignItems: "start" },
  statusList: {
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalS,
    alignItems: "center",
  },
  statusGroups: {
    display: "grid",
    gap: tokens.spacingVerticalS,
  },
  statusGroup: {
    display: "grid",
    gap: tokens.spacingVerticalXXS,
  },
  kpis: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(7rem, 1fr))",
    gap: tokens.spacingHorizontalM,
  },
  kpi: { display: "grid", gap: tokens.spacingVerticalXXS, minWidth: 0 },
  number: {
    fontSize: tokens.fontSizeBase500,
    lineHeight: tokens.lineHeightBase500,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: "tabular-nums",
    overflowWrap: "anywhere",
  },
  checklist: { display: "grid", gap: tokens.spacingVerticalS },
  checklistItem: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalM,
    padding: tokens.spacingVerticalS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  checklistTitle: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalS,
  },
  recent: { display: "grid", gap: tokens.spacingVerticalS },
  recentItem: {
    display: "grid",
    gap: tokens.spacingVerticalS,
    padding: `${tokens.spacingVerticalXS} 0`,
    border: 0,
    borderRadius: tokens.borderRadiusMedium,
    minWidth: 0,
    "@media (forced-colors: active)": { border: "1px solid CanvasText" },
  },
  compactLimitHeader: {
    display: "flex",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalS,
  },
  recentHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
  },
  time: { fontVariantNumeric: "tabular-nums", overflowWrap: "anywhere" },
  stale: {
    color: tokens.colorPaletteDarkOrangeForeground1,
    "@media (forced-colors: active)": {
      color: "CanvasText",
      textDecorationLine: "underline",
    },
  },
  completed: { display: "grid", gap: tokens.spacingVerticalS },
  loading: { display: "grid", gap: tokens.spacingVerticalM },
  errorActions: { marginTop: tokens.spacingVerticalS },
});

export function OverviewPage({
  backend,
  displayTimeZone,
}: {
  backend: FrontendAdapter;
  displayTimeZone: string;
}) {
  const styles = useStyles();
  const navigate = useNavigate();
  const heading = useRef<HTMLHeadingElement>(null);
  const [snapshot, setSnapshot] = useState<OverviewSnapshot | null>(null);
  const [dataManagement, setDataManagement] =
    useState<DataManagementStateSnapshot | null>(null);
  const [latestValidReferenceCount, setLatestValidReferenceCount] = useState<
    number | null
  >(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [auxiliaryError, setAuxiliaryError] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setAuxiliaryError("");
    try {
      const [overviewResult, dataManagementResult, limitSeriesResult] =
        await Promise.allSettled([
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
      const unavailable = [
        dataManagementResult.status === "rejected" ? "データ管理状態" : "",
        limitSeriesResult.status === "rejected" ? "推定参照数" : "",
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
    } finally {
      setLoading(false);
    }
  }, [backend]);
  useEffect(() => {
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
      <div className={styles.page}>
        <header className={styles.intro}>
          <Caption1>利用状況</Caption1>
          <h1 className={styles.title} tabIndex={-1} ref={heading}>
            概要
          </h1>
        </header>
        <MessageBar intent="warning">
          <MessageBarBody>
            <Body1 as="strong">{snapshot.maintenance.status.label}</Body1>{" "}
            {snapshot.maintenance.status.description}
            <div className={styles.errorActions}>
              <Button onClick={() => navigate("/data")}>
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
  const estimations = snapshot.estimation.states ?? [];
  const recentLimits = snapshot.recentLimits ?? [];
  const backup = dataManagement?.backup;
  const restoreTrial = dataManagement?.restore.trial;
  return (
    <div className={styles.page}>
      <header className={styles.intro}>
        <h1 className={styles.title} tabIndex={-1} ref={heading}>
          概要
        </h1>
        <Caption1 className={styles.updated}>
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
              onClick={() => navigate("/settings")}
            >
              表示設定を開く
            </Button>
          </MessageBarBody>
        </MessageBar>
      ) : null}

      {pending.length > 0 ? (
        <section aria-labelledby="overview-checklist-heading">
          <Subtitle1 as="h2" id="overview-checklist-heading">
            初回チェックリスト
          </Subtitle1>
          <div className={styles.checklist}>
            {pending.map((item) => (
              <div className={styles.checklistItem} key={item.step}>
                <div className={styles.checklistTitle}>
                  <Body1>
                    {item.step}. {item.title}
                  </Body1>
                  <StatusBadge status={item.status} />
                </div>
                {item.actionable ? (
                  <Button
                    icon={<ChevronRight16Regular />}
                    iconPosition="after"
                    onClick={() => navigate(item.route)}
                  >
                    次の設定へ
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
          {completed.length > 0 ? (
            <details className={styles.completed}>
              <summary>完了済み {completed.length} 件</summary>
              {completed.map((item) => (
                <div className={styles.checklistItem} key={item.step}>
                  <Body1>
                    {item.step}. {item.title}
                  </Body1>
                  <StatusBadge status={item.status} />
                </div>
              ))}
            </details>
          ) : null}
        </section>
      ) : null}

      <div className={styles.grid}>
        <Card className={styles.card}>
          <CardHeader
            className={styles.cardHeader}
            header={<Subtitle1 as="h2">Hub・収集</Subtitle1>}
          />
          <div className={styles.kpis}>
            <KPI
              label="定期収集"
              value={`${snapshot.hubs.scheduledCount} / ${snapshot.hubs.enabledCount}`}
              styles={styles}
            />
            <KPI
              label="実行中"
              value={`${snapshot.hubs.runningCount} 件`}
              styles={styles}
            />
            <KPI
              label="異常 Hub"
              value={`${snapshot.hubs.abnormalCount} 件`}
              styles={styles}
            />
          </div>
          <div className={styles.statusGroups}>
            <StatusGroup
              label="接続状態"
              items={snapshot.hubs.connectionStates ?? []}
              styles={styles}
            />
            <StatusGroup
              label="現在の実行状態"
              items={snapshot.hubs.currentCollectionStates ?? []}
              styles={styles}
            />
            <StatusGroup
              label="最終取得結果"
              items={snapshot.hubs.lastCollectionStates ?? []}
              styles={styles}
            />
          </div>
          <Caption1 title={snapshot.hubs.lastSuccessAt}>
            最終成功:{" "}
            {formatOverviewInstant(
              snapshot.hubs.lastSuccessAt,
              displayTimeZone,
            )}
          </Caption1>
          <Button appearance="subtle" onClick={() => navigate("/hubs")}>
            Hub・収集を開く
          </Button>
        </Card>

        {recentLimits.length > 0 ? (
          <Card className={styles.card}>
            <CardHeader header={<Subtitle1 as="h2">利用枠</Subtitle1>} />
            {recentLimits.slice(0, 2).map((item) => (
              <article
                className={styles.recentItem}
                key={`${item.logicalAccountId}:${item.limitDefinitionId}`}
                aria-label={item.accessibleLabel}
              >
                <div className={styles.compactLimitHeader}>
                  <Body1>
                    <strong>{item.serviceName}</strong>{" "}
                    <Caption1>{item.accountName}</Caption1>
                  </Body1>
                  <Body1 title={item.tooltip}>
                    <strong>{item.remainingLabel}</strong>
                  </Body1>
                </div>
                {item.remainingPercent === null ? null : (
                  <ProgressBar
                    value={item.remainingPercent}
                    max={100}
                    color={progressColor(item.remaining)}
                    thickness="medium"
                    aria-label={item.accessibleLabel}
                  />
                )}
              </article>
            ))}
            <Button appearance="subtle" onClick={() => navigate("/limits")}>
              利用上限・価値を開く
            </Button>
          </Card>
        ) : null}

        <Card className={styles.card}>
          <CardHeader header={<Subtitle1 as="h2">要確認</Subtitle1>} />
          <div className={styles.kpis}>
            <StatusKPI item={snapshot.review.actionItems} styles={styles} />
            <StatusKPI item={snapshot.review.warnings} styles={styles} />
            <StatusKPI
              item={snapshot.review.recalculationFailures}
              styles={styles}
            />
          </div>
          {[
            ...(snapshot.review.actionKinds ?? []),
            ...(snapshot.review.warningKinds ?? []),
          ].map((item) => (
            <Body1 key={`${item.code}:${item.label}`}>
              {item.label}: {item.count} 件
            </Body1>
          ))}
          <Button appearance="subtle" onClick={() => navigate("/review")}>
            要確認を開く
          </Button>
        </Card>

        <Card className={styles.card}>
          <CardHeader header={<Subtitle1 as="h2">推定状態</Subtitle1>} />
          <div className={styles.statusList}>
            {estimations.length > 0 ? (
              estimations.map((item) => (
                <span key={item.status.code}>
                  <StatusBadge status={item.status} /> {item.count}件
                </span>
              ))
            ) : (
              <Body1>推定対象 0件</Body1>
            )}
          </div>
          <Body1>
            非カレントの最新有効計算区間を参照中:{" "}
            {latestValidReferenceCount === null
              ? "取得不能"
              : `${latestValidReferenceCount}件`}
          </Body1>
          <Button appearance="subtle" onClick={() => navigate("/limits")}>
            利用上限・価値を開く
          </Button>
        </Card>

        <Card className={styles.card}>
          <CardHeader header={<Subtitle1 as="h2">保存データ</Subtitle1>} />
          <div className={styles.kpis}>
            <KPI
              label="データベース"
              value={formatOverviewBytes(snapshot.capacity.databaseSizeBytes)}
              styles={styles}
            />
            <KPI
              label="原 JSON"
              value={`${snapshot.capacity.rawSnapshotCount} 件`}
              styles={styles}
            />
          </div>
          {snapshot.capacity.rawSnapshotCount > 0 ? (
            <Caption1
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
          {backup ? (
            <div>
              <Caption1>最新バックアップ</Caption1>
              <Body1>
                {operationStatusLabel(backup.status)}
                {backup.artifact?.createdAt
                  ? ` · ${formatOverviewInstant(backup.artifact.createdAt, displayTimeZone)}`
                  : ""}
              </Body1>
            </div>
          ) : null}
          {restoreTrial ? (
            <div>
              <Caption1>復元試行</Caption1>
              <Body1>
                {operationStatusLabel(restoreTrial.status)}
                {restoreTrial.testedAt
                  ? ` · ${formatOverviewInstant(restoreTrial.testedAt, displayTimeZone)}`
                  : ""}
              </Body1>
            </div>
          ) : null}
          <Caption1>バックアップには資格情報を含みません。</Caption1>
          <Button appearance="subtle" onClick={() => navigate("/data")}>
            データ管理を開く
          </Button>
        </Card>
      </div>
    </div>
  );
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

function KPI({
  label,
  value,
  styles,
}: {
  label: string;
  value: string;
  styles: ReturnType<typeof useStyles>;
}) {
  return (
    <div className={styles.kpi}>
      <Caption1>{label}</Caption1>
      <span className={styles.number}>{value}</span>
    </div>
  );
}

function StatusKPI({
  item,
  styles,
}: {
  item: OverviewSnapshot["review"]["actionItems"];
  styles: ReturnType<typeof useStyles>;
}) {
  return (
    <div className={styles.kpi}>
      <StatusBadge status={item.status} />
      <span className={styles.number}>{item.count} 件</span>
    </div>
  );
}

function StatusGroup({
  label,
  items,
  styles,
}: {
  label: string;
  items: NonNullable<OverviewSnapshot["hubs"]["connectionStates"]>;
  styles: ReturnType<typeof useStyles>;
}) {
  return (
    <div className={styles.statusGroup}>
      <Caption1>{label}</Caption1>
      <div className={styles.statusList}>
        {items.map((item) => (
          <span key={item.status.code}>
            <StatusBadge status={item.status} /> {item.count}件
          </span>
        ))}
      </div>
    </div>
  );
}
