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

const integerFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const useStyles = makeStyles({
  window: {
    minHeight: "100vh",
    maxWidth: "360px",
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
    flexWrap: "nowrap",
    gap: tokens.spacingHorizontalXS,
    "--wails-draggable": "drag",
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalXS} ${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    backgroundColor: tokens.colorNeutralBackground1,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  title: {
    minWidth: 0,
    flexGrow: 1,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground3,
    whiteSpace: "nowrap",
  },
  showcaseBadge: {
    color: tokens.colorPaletteDarkOrangeForeground1,
    border: `1px solid ${tokens.colorPaletteDarkOrangeBorderActive}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: `0 ${tokens.spacingHorizontalXXS}`,
    maxWidth: "138px",
    overflow: "hidden",
    textOverflow: "ellipsis",
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
  iconActions: {
    display: "flex",
    flexShrink: 0,
    gap: tokens.spacingHorizontalXXS,
  },
  limits: {
    minWidth: 0,
    display: "grid",
    gap: tokens.spacingVerticalXXS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
  },
  usageSummary: {
    display: "grid",
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  usageRow: {
    display: "grid",
    gridTemplateColumns: "66px minmax(0, 1fr) auto",
    alignItems: "baseline",
    columnGap: tokens.spacingHorizontalS,
    width: "100%",
    padding: `9px ${tokens.spacingHorizontalM}`,
    color: "inherit",
    backgroundColor: "transparent",
    border: 0,
    textAlign: "left",
    cursor: "pointer",
    ":hover": { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  usageRowDivider: {
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  usageLabel: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase100,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: ".04em",
    textTransform: "uppercase",
  },
  usageValue: {
    minWidth: 0,
    overflow: "hidden",
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: "tabular-nums",
    letterSpacing: "-.02em",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  usageUnit: {
    marginLeft: tokens.spacingHorizontalXXS,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase100,
    fontWeight: tokens.fontWeightRegular,
  },
  usageCost: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  meta: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    padding: `5px ${tokens.spacingHorizontalM}`,
    color: tokens.colorNeutralForeground3,
    backgroundColor: tokens.colorNeutralBackground1,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  metaFailure: {
    color: tokens.colorPaletteDarkOrangeForeground1,
    fontWeight: tokens.fontWeightSemibold,
  },
  scrollableLimits: {
    minHeight: 0,
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
  limitName: {
    minWidth: 0,
    overflow: "hidden",
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  limitContext: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightRegular,
  },
  limitPercent: {
    flexShrink: 0,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightBold,
    fontVariantNumeric: "tabular-nums",
  },
  resetLine: {
    display: "flex",
    alignItems: "baseline",
    minWidth: 0,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase100,
    lineHeight: tokens.lineHeightBase200,
  },
  resetDetails: {
    display: "flex",
    alignItems: "baseline",
    gap: "1ch",
    flexShrink: 0,
    minWidth: 0,
  },
  resetLabel: {
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: ".04em",
    textTransform: "uppercase",
  },
  resetValue: { fontVariantNumeric: "tabular-nums" },
  resetDateColumn: {
    display: "inline-grid",
    gridTemplateAreas: '"date"',
    fontVariantNumeric: "tabular-nums",
    "::before": {
      content: "attr(data-column-sample)",
      gridArea: "date",
      visibility: "hidden",
    },
  },
  resetDateValue: {
    gridArea: "date",
    justifySelf: "end",
  },
  usageLimit: {
    marginLeft: "auto",
    overflow: "hidden",
    fontVariantNumeric: "tabular-nums",
    textAlign: "end",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  more: { display: "flex", justifyContent: "center" },
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

  const allLimits = snapshot?.recentLimits ?? [];
  const limits = allLimits.slice(0, expanded ? allLimits.length : 5);
  const resetDateColumnSample = limits.reduce((widest, item) => {
    if (!item.resetAt) return widest;
    const date = splitOverviewInstant(
      item.resetAt,
      settings.displayTimeZone,
    ).date;
    return date.length > widest.length ? date : widest;
  }, "");
  const usageForCurrentDate = usage?.series?.find(
    (item) =>
      currentDateInZone(
        settings.displayTimeZone,
        new Date(item.periodStart),
      ) === currentDateInZone(settings.displayTimeZone),
  );
  const todayUsage =
    usageForCurrentDate ??
    (backend.isShowcase && usage?.series?.length
      ? usage.series[usage.series.length - 1]
      : undefined);
  const failedHubCount =
    snapshot?.hubs.items?.filter(
      (hub) => hub.enabled && hub.lastCollection.code === "collection_failed",
    ).length ?? 0;
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
              <Caption1
                className={styles.showcaseBadge}
                aria-label="サンプルデータ（モック Hub）"
                title="サンプルデータ（モック Hub）"
              >
                モック
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
              <div
                className={styles.layout}
                hidden={Boolean(snapshot.maintenance)}
              >
                {usage ? (
                  <div className={styles.usageSummary}>
                    <UsageRow
                      label="Today"
                      tokens={todayUsage?.tokens ?? 0}
                      cost={todayUsage?.apiCostUsd ?? 0}
                      privacyMode={privacyMode}
                      className={styles.usageRowDivider}
                      styles={styles}
                      onClick={() => openMainRoute("/usage")}
                    />
                    <UsageRow
                      label="This month"
                      tokens={usage.summary.tokens}
                      cost={usage.summary.apiCostUsd}
                      privacyMode={privacyMode}
                      styles={styles}
                      onClick={() => openMainRoute("/usage")}
                    />
                  </div>
                ) : null}
                <div className={styles.meta}>
                  {failedHubCount > 0 ? (
                    <Button
                      appearance="subtle"
                      size="small"
                      className={styles.metaFailure}
                      icon={<Warning16Regular />}
                      onClick={() => openMainRoute("/hubs")}
                      aria-label={`取得エラー ${failedHubCount} Hub。取得履歴を開く`}
                    >
                      取得エラー {failedHubCount} Hub
                    </Button>
                  ) : (
                    <span />
                  )}
                  <Caption1 className={styles.update}>
                    {formatOverviewInstant(
                      snapshot.generatedAt,
                      settings.displayTimeZone,
                    )}{" "}
                    更新
                  </Caption1>
                </div>

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
                          <Body1 className={styles.limitName}>
                            <strong>{item.serviceName}</strong>{" "}
                            <span className={styles.limitContext}>
                              {item.accountName}・{item.limitName}
                            </span>
                          </Body1>
                          <Body1
                            className={mergeClasses(
                              styles.limitPercent,
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
                          styles={styles}
                          displayTimeZone={settings.displayTimeZone}
                          resetDateColumnSample={resetDateColumnSample}
                        />
                      </article>
                    ))}
                    {allLimits.length > 5 ? (
                      <div className={styles.more}>
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
                      </div>
                    ) : null}
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

function UsageRow({
  label,
  tokens: tokenCount,
  cost,
  privacyMode,
  className,
  styles,
  onClick,
}: {
  label: string;
  tokens: number;
  cost: number;
  privacyMode: boolean;
  className?: string;
  styles: ReturnType<typeof useStyles>;
  onClick: () => void;
}) {
  const value = privacyMode ? "••••" : integerFormatter.format(tokenCount);
  const costValue = privacyMode ? "••••" : usdFormatter.format(cost);
  return (
    <button
      type="button"
      className={mergeClasses(styles.usageRow, className)}
      onClick={onClick}
      aria-label={`${label} の利用トークン ${value}、API換算利用金額 ${costValue}。利用実績を開く`}
    >
      <span className={styles.usageLabel}>{label}</span>
      <span className={styles.usageValue}>
        {value}
        <span className={styles.usageUnit}>tokens</span>
      </span>
      <span className={styles.usageCost}>{costValue}</span>
    </button>
  );
}

/**
 * Reset dates share the widest visible date column. The widest value keeps a
 * one-character visual gap before the time, while every service stays aligned.
 */
function LimitResetLine({
  item,
  styles,
  displayTimeZone,
  resetDateColumnSample,
}: {
  item: OverviewRecentLimitSnapshot;
  styles: ReturnType<typeof useStyles>;
  displayTimeZone: string;
  resetDateColumnSample: string;
}) {
  const reset = item.resetAt
    ? splitOverviewInstant(item.resetAt, displayTimeZone)
    : null;
  const staleFreshness = item.freshness.status.intent !== "success";
  return (
    <div className={styles.resetLine} title={item.tooltip}>
      <span className={styles.resetDetails}>
        <span className={styles.resetLabel}>Reset</span>
        {reset ? (
          <>
            <span
              className={styles.resetDateColumn}
              data-column-sample={resetDateColumnSample}
            >
              <span className={styles.resetDateValue}>{reset.date}</span>
            </span>
            <span className={styles.resetValue}>{reset.time}</span>
          </>
        ) : (
          <span className={styles.resetValue}>{item.reset.label}</span>
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
      </span>
      {item.estimatedLimitLabel ? (
        <span
          className={styles.usageLimit}
          aria-label={`推定利用料 ${item.estimatedUsageLabel}、推定上限 ${item.estimatedLimitLabel}`}
        >
          {item.estimatedUsageLabel} / {item.estimatedLimitLabel}
        </span>
      ) : null}
    </div>
  );
}
