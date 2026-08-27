import {
  Body1,
  Button,
  Caption1,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Spinner,
  Subtitle1,
  Tooltip,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowSync16Regular,
  ChevronDown16Regular,
  ChevronUp16Regular,
  Dismiss16Regular,
  ErrorCircle16Regular,
  Eye16Regular,
  EyeOff16Regular,
  Open16Regular,
  Warning16Regular,
} from "@fluentui/react-icons";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSettings } from "../../app/providers";
import { StatusBadge } from "../../components/StatusBadge";
import { Gauge } from "../../components/design";
import { designTokens } from "../../components/designTokens";
import type { DesignStyles } from "../../components/designStyles";
import { gaugeTextClass, useDesignStyles } from "../../components/designStyles";
import type {
  FrontendAdapter,
  OverviewRecentLimitSnapshot,
  OverviewSnapshot,
  UsageSnapshot,
} from "../../lib/backend";
import {
  formatOverviewInstant,
  splitOverviewInstant,
} from "../../lib/overviewDisplay";
import {
  addLocalDays,
  currentDateInZone,
  firstDateOfMonth,
  zonedMidnight,
} from "../../lib/usageTime";

export const compactRefreshMilliseconds = 30_000;

function compactTokens(value: number): string {
  return new Intl.NumberFormat("ja-JP", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

const useStyles = makeStyles({
  window: {
    minHeight: "100vh",
    maxWidth: "420px",
    overflow: "hidden",
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground1,
    fontFamily: "var(--font-ui)",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
  },
  layout: { display: "grid", minWidth: 0 },
  header: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalXS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalXS} ${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    backgroundColor: tokens.colorNeutralBackground1,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  title: {
    minWidth: 0,
    flexGrow: 1,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground3,
  },
  showcaseBadge: {
    color: tokens.colorPaletteDarkOrangeForeground1,
    border: `1px solid ${tokens.colorPaletteDarkOrangeBorderActive}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: `0 ${tokens.spacingHorizontalXXS}`,
    whiteSpace: "nowrap",
  },
  visuallyHidden: {
    position: "absolute",
    width: "1px",
    height: "1px",
    overflow: "hidden",
    clip: "rect(0 0 0 0)",
  },
  headerStatus: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalXXS,
  },
  headerCount: {
    minWidth: 0,
    padding: `0 ${tokens.spacingHorizontalXXS}`,
    fontSize: tokens.fontSizeBase200,
  },
  iconActions: { display: "flex", gap: tokens.spacingHorizontalXXS },
  value: { fontVariantNumeric: "tabular-nums", overflowWrap: "anywhere" },
  limits: {
    minWidth: 0,
    display: "grid",
    gap: tokens.spacingVerticalXXS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
  },
  usageSummary: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    cursor: "pointer",
  },
  usageMetric: {
    display: "grid",
    gap: "1px",
    fontVariantNumeric: "tabular-nums",
  },
  scrollableLimits: {
    maxHeight: "50vh",
    overflowY: "auto",
    scrollbarGutter: "stable",
  },
  limit: {
    minWidth: 0,
    display: "grid",
    gap: "5px",
    padding: `6px ${tokens.spacingHorizontalS}`,
    border: "1px solid transparent",
    borderRadius: tokens.borderRadiusMedium,
    "@media (forced-colors: active)": { border: "1px solid CanvasText" },
  },
  limitHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalS,
  },
  stateLine: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalXS,
  },
  footer: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalXS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  dangerCount: {
    color: tokens.colorPaletteRedForeground1,
  },
  warningCount: {
    color: tokens.colorPaletteDarkOrangeForeground1,
  },
  freshness: {
    marginInlineStart: "auto",
    display: "inline-flex",
    alignItems: "center",
    gap: "3px",
    color: tokens.colorPaletteDarkOrangeForeground1,
    fontWeight: tokens.fontWeightSemibold,
  },
  errorCounter: {
    borderRadius: tokens.borderRadiusMedium,
    "@media (forced-colors: active)": {
      backgroundColor: "Highlight",
      color: "HighlightText",
      border: "1px solid HighlightText",
    },
  },
  update: {
    marginLeft: "auto",
    color: tokens.colorNeutralForeground3,
    whiteSpace: "nowrap",
  },
});

export function CompactWindow({ backend }: { backend: FrontendAdapter }) {
  const styles = useStyles();
  const design = useDesignStyles();
  const { settings, dark } = useSettings();
  const [expanded, setExpanded] = useState(
    () =>
      typeof window !== "undefined" &&
      window.innerWidth >= 400 &&
      window.innerWidth < 800,
  );
  const [privacyMode, setPrivacyMode] = useState(false);
  const [snapshot, setSnapshot] = useState<OverviewSnapshot | null>(null);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const hasSnapshot = useRef(false);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [overviewError, setOverviewError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [quitRequested, setQuitRequested] = useState(false);
  const [quitting, setQuitting] = useState(false);
  const [quitError, setQuitError] = useState<string | null>(null);

  useEffect(
    () =>
      backend.on("app:quit-requested", () => {
        setQuitError(null);
        setQuitting(false);
        setQuitRequested(true);
      }),
    [backend],
  );
  useEffect(() => {
    const updateExpandedFromNativeWindow = () => {
      setExpanded(window.innerWidth >= 400 && window.innerWidth < 800);
    };
    window.addEventListener("resize", updateExpandedFromNativeWindow, {
      passive: true,
    });
    return () =>
      window.removeEventListener("resize", updateExpandedFromNativeWindow);
  }, []);
  useEffect(() => {
    const toggle = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        hasSnapshot.current = false;
        setSnapshot(null);
        setPrivacyMode((current) => !current);
      }
    };
    window.addEventListener("keydown", toggle);
    return () => window.removeEventListener("keydown", toggle);
  }, []);
  useEffect(() => {
    let active = true;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      if (hasSnapshot.current) setUpdating(true);
      else setLoading(true);
      try {
        const currentDate = currentDateInZone(settings.displayTimeZone);
        const [value, usageValue] = await Promise.all([
          backend.getOverview(privacyMode),
          backend.getUsage({
            from: zonedMidnight(
              firstDateOfMonth(currentDate),
              settings.displayTimeZone,
            ),
            to: zonedMidnight(
              addLocalDays(currentDate, 1),
              settings.displayTimeZone,
            ),
            displayTimeZone: settings.displayTimeZone,
            granularity: "day",
            groupBy: "hub",
            hubId: "",
            collectionDeviceId: "",
            deviceId: "",
            serviceId: "",
            rawServiceIdentifier: "",
            logicalAccountId: "",
            planVersionId: "",
            limitDefinitionId: "",
            model: "",
          }),
        ]);
        if (!active) return;
        hasSnapshot.current = true;
        setSnapshot(value);
        setUsage(usageValue);
        setOverviewError("");
      } catch {
        if (active) setOverviewError("最新状態を読み込めませんでした。");
      } finally {
        inFlight = false;
        if (active) {
          setLoading(false);
          setUpdating(false);
        }
      }
    };
    void refresh();
    const interval = window.setInterval(
      () => void refresh(),
      compactRefreshMilliseconds,
    );
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [backend, privacyMode, reloadKey, settings.displayTimeZone]);

  const openMainRoute = useCallback(
    (route: string) => void backend.OpenMainRoute(route),
    [backend],
  );
  const toggleExpanded = () => {
    setExpanded((current) => {
      const next = !current;
      void backend.SetCompactExpanded(next).catch(() => setExpanded(current));
      return next;
    });
  };
  const togglePrivacy = () => {
    hasSnapshot.current = false;
    setSnapshot(null);
    setPrivacyMode((current) => !current);
  };
  const confirmQuit = async () => {
    if (quitting) return;
    setQuitError(null);
    setQuitting(true);
    try {
      const hubs = await backend.getHubs();
      await Promise.all(
        hubs
          .filter((hub) => hub.collectionEnabled)
          .map((hub) => backend.stopCollection(hub.id)),
      );
      await backend.ConfirmQuit();
    } catch {
      setQuitError("収集処理を停止できなかったため、終了していません。");
      setQuitting(false);
    }
  };

  const limits = (snapshot?.recentLimits ?? []).slice(0, expanded ? 4 : 2);
  return (
    <>
      <main
        className={styles.window}
        data-window="compact"
        data-compact-expanded={expanded}
        aria-labelledby="compact-title"
      >
        <div className={styles.layout}>
          <header className={styles.header}>
            <div className={styles.title}>Token Monitor</div>
            {backend.isShowcase ? (
              <Caption1 className={styles.showcaseBadge}>
                サンプルデータ（モック Hub）
              </Caption1>
            ) : null}
            <Subtitle1
              as="h1"
              id="compact-title"
              className={styles.visuallyHidden}
            >
              運用状態
            </Subtitle1>
            {snapshot ? (
              <div className={styles.headerStatus} aria-label="Hub 収集状態">
                <Button
                  appearance="subtle"
                  size="small"
                  className={styles.headerCount}
                  icon={<ArrowSync16Regular />}
                  aria-label={`定期収集 ${snapshot?.hubs.scheduledCount ?? 0} / ${snapshot?.hubs.enabledCount ?? 0}、実行中 ${snapshot?.hubs.runningCount ?? 0} 件`}
                  onClick={() => openMainRoute("/hubs")}
                >
                  {snapshot?.hubs.scheduledCount ?? 0}/
                  {snapshot?.hubs.enabledCount ?? 0}
                </Button>
                {(snapshot?.hubs.runningCount ?? 0) > 0 ? (
                  <Button
                    appearance="subtle"
                    size="small"
                    className={styles.headerCount}
                    icon={<ArrowSync16Regular />}
                    aria-label={`実行中 ${snapshot?.hubs.runningCount ?? 0} 件`}
                    onClick={() => openMainRoute("/hubs")}
                  >
                    {snapshot?.hubs.runningCount ?? 0}
                  </Button>
                ) : null}
                {(snapshot?.hubs.abnormalCount ?? 0) > 0 ? (
                  <Button
                    appearance="subtle"
                    size="small"
                    className={mergeClasses(
                      styles.headerCount,
                      styles.dangerCount,
                    )}
                    icon={<ErrorCircle16Regular />}
                    aria-label={`異常 Hub ${snapshot?.hubs.abnormalCount ?? 0} 件`}
                    onClick={() => openMainRoute("/hubs")}
                  >
                    {snapshot?.hubs.abnormalCount ?? 0}
                  </Button>
                ) : null}
              </div>
            ) : null}
            <div className={styles.iconActions}>
              <Tooltip content="メイン画面を開く" relationship="label">
                <Button
                  appearance="subtle"
                  icon={<Open16Regular />}
                  aria-label="メイン画面を開く"
                  disabled={!backend.canOpenMain}
                  onClick={() => openMainRoute("/overview")}
                />
              </Tooltip>
              <Tooltip
                content={
                  privacyMode
                    ? "プライバシーモードを解除"
                    : "プライバシーモード"
                }
                relationship="label"
              >
                <Button
                  appearance="subtle"
                  icon={privacyMode ? <EyeOff16Regular /> : <Eye16Regular />}
                  aria-label={
                    privacyMode
                      ? "プライバシーモードを解除"
                      : "プライバシーモード"
                  }
                  aria-pressed={privacyMode}
                  onClick={togglePrivacy}
                />
              </Tooltip>
              <Tooltip content="終了（定期収集も停止）" relationship="label">
                <Button
                  appearance="subtle"
                  icon={<Dismiss16Regular />}
                  aria-label="終了（定期収集も停止）"
                  onClick={() => setQuitRequested(true)}
                />
              </Tooltip>
            </div>
          </header>

          {loading && !snapshot ? (
            <Spinner size="small" label="運用状態を読み込み中" />
          ) : null}
          {overviewError ? (
            <div role="alert">
              <Body1>{overviewError}</Body1>{" "}
              <Button
                size="small"
                onClick={() => setReloadKey((value) => value + 1)}
              >
                再試行
              </Button>
            </div>
          ) : null}
          {snapshot ? (
            <>
              {snapshot.maintenance ? (
                <div role="status" aria-live="polite">
                  <StatusBadge status={snapshot.maintenance.status} />
                  <Body1>{snapshot.maintenance.status.description}</Body1>
                  <Button size="small" onClick={() => openMainRoute("/data")}>
                    データ管理を開く
                  </Button>
                </div>
              ) : null}
              <div hidden={Boolean(snapshot.maintenance)}>
                {usage ? (
                  <button
                    type="button"
                    className={styles.usageSummary}
                    onClick={() => openMainRoute("/usage")}
                    aria-label="当日・当月の利用実績を開く"
                  >
                    <span className={styles.usageMetric}>
                      <Caption1>当日トークン</Caption1>
                      <Body1 className={styles.value}>
                        {privacyMode
                          ? "••••"
                          : compactTokens(
                              usage.series?.find(
                                (item) =>
                                  currentDateInZone(
                                    settings.displayTimeZone,
                                    new Date(item.periodStart),
                                  ) ===
                                  currentDateInZone(settings.displayTimeZone),
                              )?.tokens ?? 0,
                            )}
                      </Body1>
                    </span>
                    <span className={styles.usageMetric}>
                      <Caption1>当月トークン</Caption1>
                      <Body1 className={styles.value}>
                        {privacyMode
                          ? "••••"
                          : compactTokens(usage.summary.tokens)}
                      </Body1>
                    </span>
                  </button>
                ) : null}
                {expanded ? (
                  <div
                    className={mergeClasses(
                      styles.limits,
                      styles.scrollableLimits,
                    )}
                    aria-label="Hub 別状態"
                  >
                    {(snapshot.hubs.items ?? []).map((hub) => (
                      <div className={styles.limit} key={hub.id}>
                        <div className={design.gaugeHeader}>
                          <Body1 className={design.gaugeName}>
                            {hub.displayName}
                          </Body1>
                          {hub.enabled && hub.collectionEnabled ? null : (
                            <Caption1 className={design.metaLabel}>
                              停止中
                            </Caption1>
                          )}
                        </div>
                        <div className={styles.stateLine}>
                          <StatusBadge status={hub.connection} />
                          <StatusBadge status={hub.currentCollection} />
                          <StatusBadge status={hub.lastCollection} />
                        </div>
                        <HubTimeLine
                          label="OK"
                          accessibleLabel="最終成功"
                          value={hub.lastSuccessAt}
                          design={design}
                          displayTimeZone={settings.displayTimeZone}
                        />
                        <HubTimeLine
                          label="NG"
                          accessibleLabel="最終失敗"
                          value={hub.lastFailureAt}
                          design={design}
                          displayTimeZone={settings.displayTimeZone}
                        />
                        <HubTimeLine
                          label="SKIP"
                          accessibleLabel="最終スキップ"
                          value={hub.lastSkippedAt}
                          design={design}
                          displayTimeZone={settings.displayTimeZone}
                        />
                      </div>
                    ))}
                  </div>
                ) : null}

                {snapshot.hubs.totalCount === 0 ? (
                  <div>
                    <Body1>Hub が登録されていません</Body1>
                    <Button size="small" onClick={() => openMainRoute("/hubs")}>
                      Hub を登録
                    </Button>
                  </div>
                ) : snapshot.capacity.rawSnapshotCount === 0 ? (
                  <div>
                    <Body1>観測データがありません</Body1>
                    <Button size="small" onClick={() => openMainRoute("/hubs")}>
                      今すぐ取得
                    </Button>
                  </div>
                ) : limits.length === 0 ? (
                  <div>
                    <Body1>利用増加を確認できる利用枠はありません</Body1>
                    <Caption1>
                      同一利用周期内の二つ以上の有効観測が必要です。
                    </Caption1>
                  </div>
                ) : (
                  <section
                    className={mergeClasses(
                      styles.limits,
                      expanded && styles.scrollableLimits,
                    )}
                    data-region="limit-list"
                    aria-label="利用増加を最近確認した利用枠"
                  >
                    {limits.map((item) => (
                      <article
                        className={styles.limit}
                        key={`${item.logicalAccountId}:${item.limitDefinitionId}`}
                        aria-label={item.accessibleLabel}
                      >
                        <div className={design.gaugeHeader}>
                          <Body1 className={design.gaugeName}>
                            <strong>{item.serviceName}</strong>{" "}
                            <span className={design.gaugeContext}>
                              {item.accountName}・{item.limitName}
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
                        <LimitResetLine
                          item={item}
                          design={design}
                          styles={styles}
                          displayTimeZone={settings.displayTimeZone}
                        />
                      </article>
                    ))}
                  </section>
                )}

                <footer className={styles.footer}>
                  <Button
                    size="small"
                    appearance="subtle"
                    className={
                      snapshot.review.actionItems.count > 0
                        ? styles.dangerCount
                        : undefined
                    }
                    icon={<ErrorCircle16Regular />}
                    aria-label={`要確認 ${snapshot.review.actionItems.count} 件`}
                    onClick={() => openMainRoute("/review")}
                  >
                    {snapshot.review.actionItems.count}
                  </Button>
                  {snapshot.review.warnings.count > 0 ? (
                    <Button
                      size="small"
                      appearance="subtle"
                      className={styles.warningCount}
                      icon={<Warning16Regular />}
                      aria-label={`警告 ${snapshot.review.warnings.count} 件`}
                      onClick={() => openMainRoute("/review")}
                    >
                      {snapshot.review.warnings.count}
                    </Button>
                  ) : null}
                  {snapshot.review.recalculationFailures.count > 0 ? (
                    <Button
                      size="small"
                      appearance="subtle"
                      className={styles.errorCounter}
                      data-error-counter="true"
                      aria-label={`処理失敗 ${snapshot.review.recalculationFailures.count} 件`}
                      style={
                        dark
                          ? {
                              backgroundColor:
                                designTokens.dark.errorCounterBackground,
                              color: designTokens.dark.errorCounterForeground,
                            }
                          : undefined
                      }
                      onClick={() => openMainRoute("/review")}
                    >
                      処理失敗 {snapshot.review.recalculationFailures.count}
                    </Button>
                  ) : null}
                  <Button
                    appearance="subtle"
                    icon={
                      expanded ? (
                        <ChevronUp16Regular />
                      ) : (
                        <ChevronDown16Regular />
                      )
                    }
                    aria-expanded={expanded}
                    aria-label={
                      expanded ? "利用枠を折りたたむ" : "利用枠を展開"
                    }
                    onClick={toggleExpanded}
                  />
                  <Caption1
                    className={styles.update}
                    role="status"
                    aria-live="polite"
                  >
                    {updating
                      ? "更新中"
                      : `${formatOverviewInstant(snapshot.generatedAt, settings.displayTimeZone)} 更新`}
                  </Caption1>
                </footer>
              </div>
            </>
          ) : null}
        </div>
      </main>
      <Dialog
        open={quitRequested}
        onOpenChange={(_, data) => !data.open && setQuitRequested(false)}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>アプリを終了しますか？</DialogTitle>
            <DialogContent>
              収集処理を停止して、すべての画面を閉じます。
            </DialogContent>
            <DialogActions>
              <Button
                appearance="secondary"
                disabled={quitting}
                onClick={() => setQuitRequested(false)}
              >
                キャンセル
              </Button>
              <Button
                appearance="primary"
                disabled={quitting}
                onClick={() => void confirmQuit()}
              >
                {quitting ? "停止中…" : "終了"}
              </Button>
            </DialogActions>
            {quitError ? <Body1 role="alert">{quitError}</Body1> : null}
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}

/**
 * Reset date and time in fixed columns so every row lines up, with the
 * freshness warning reduced to an icon (`docs/design-system.md` §5.5, §7.1).
 */
function LimitResetLine({
  item,
  design,
  styles,
  displayTimeZone,
}: {
  item: OverviewRecentLimitSnapshot;
  design: DesignStyles;
  styles: ReturnType<typeof useStyles>;
  displayTimeZone: string;
}) {
  const reset = item.resetAt
    ? splitOverviewInstant(item.resetAt, displayTimeZone)
    : null;
  const staleFreshness = item.freshness.status.intent !== "success";
  return (
    <div className={design.resetRow} title={item.tooltip}>
      <span className={design.metaLabel}>Reset</span>
      {reset ? (
        <>
          <span className={design.resetValue}>{reset.date}</span>
          <span className={design.resetValue}>{reset.time}</span>
        </>
      ) : (
        <span className={design.resetValue}>{item.reset.label}</span>
      )}
      {staleFreshness ? (
        <span
          className={styles.freshness}
          title={item.freshness.observationAt}
          aria-label={`最新観測 ${item.freshness.ageLabel}`}
        >
          <Warning16Regular aria-hidden="true" />
          {item.freshness.ageLabel}
        </span>
      ) : null}
    </div>
  );
}

/** Hub timestamps as `LABEL  M/D  H:MM`, aligned across rows. */
function HubTimeLine({
  label,
  accessibleLabel,
  value,
  design,
  displayTimeZone,
}: {
  label: string;
  accessibleLabel: string;
  value: string;
  design: DesignStyles;
  displayTimeZone: string;
}) {
  if (!value) return null;
  const instant = splitOverviewInstant(value, displayTimeZone);
  return (
    <div
      className={design.resetRow}
      title={value}
      aria-label={`${accessibleLabel} ${instant.date} ${instant.time}`}
    >
      <span className={design.metaLabel}>{label}</span>
      <span className={design.resetValue}>{instant.date}</span>
      <span className={design.resetValue}>{instant.time}</span>
    </div>
  );
}
