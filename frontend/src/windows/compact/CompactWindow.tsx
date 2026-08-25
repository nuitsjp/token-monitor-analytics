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
  ProgressBar,
  Spinner,
  Subtitle1,
  Tooltip,
  makeStyles,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import {
  ChevronDown16Regular,
  ChevronUp16Regular,
  Eye16Regular,
  EyeOff16Regular,
  Open16Regular,
} from "@fluentui/react-icons";
import { useCallback, useEffect, useRef, useState } from "react";
import type { OverviewSnapshot } from "../../../bindings/token-monitor-analytics/internal/desktop/models.js";
import { useSettings } from "../../app/providers";
import { StatusBadge } from "../../components/StatusBadge";
import type { FrontendAdapter } from "../../lib/backend";
import {
  formatOverviewInstant,
  progressColor,
} from "../../lib/overviewDisplay";

export const compactRefreshMilliseconds = 30_000;

const useStyles = makeStyles({
  window: {
    minHeight: "100vh",
    overflow: "auto",
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground1,
    fontFamily:
      '"Segoe UI Variable Text", "Segoe UI", "Yu Gothic UI", Meiryo, sans-serif',
    ...shorthands.padding(tokens.spacingVerticalM, tokens.spacingHorizontalM),
  },
  layout: { display: "grid", gap: tokens.spacingVerticalM, minWidth: 0 },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "start",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalS,
  },
  title: { display: "grid", gap: tokens.spacingVerticalXXS, minWidth: 0 },
  iconActions: { display: "flex", gap: tokens.spacingHorizontalXXS },
  summary: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(5.5rem, 1fr))",
    gap: tokens.spacingHorizontalS,
  },
  summaryButton: {
    minWidth: 0,
    height: "auto",
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
  },
  value: { fontVariantNumeric: "tabular-nums", overflowWrap: "anywhere" },
  limits: {
    minWidth: 0,
    maxHeight: "50vh",
    display: "grid",
    gap: tokens.spacingVerticalS,
    overflowY: "auto",
    scrollbarGutter: "stable",
  },
  limit: {
    minWidth: 0,
    display: "grid",
    gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
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
  },
  stale: {
    color: tokens.colorPaletteDarkOrangeForeground1,
    "@media (forced-colors: active)": {
      color: "CanvasText",
      textDecorationLine: "underline",
    },
  },
  actions: {
    display: "flex",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalS,
  },
});

export function CompactWindow({ backend }: { backend: FrontendAdapter }) {
  const styles = useStyles();
  const { settings } = useSettings();
  const [expanded, setExpanded] = useState(
    () =>
      typeof window !== "undefined" &&
      window.innerWidth >= 400 &&
      window.innerWidth < 800,
  );
  const [privacyMode, setPrivacyMode] = useState(false);
  const [snapshot, setSnapshot] = useState<OverviewSnapshot | null>(null);
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
        const value = await backend.getOverview(privacyMode);
        if (!active) return;
        hasSnapshot.current = true;
        setSnapshot(value);
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
  }, [backend, privacyMode, reloadKey]);

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
            <div className={styles.title}>
              <Caption1>Token Monitor Analytics</Caption1>
              <Subtitle1 as="h1" id="compact-title">
                運用状態
              </Subtitle1>
            </div>
            <div className={styles.iconActions}>
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
              <Tooltip content="メイン画面を開く" relationship="label">
                <Button
                  appearance="subtle"
                  icon={<Open16Regular />}
                  aria-label="メイン画面を開く"
                  disabled={!backend.canOpenMain}
                  onClick={() => openMainRoute("/overview")}
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
                <div className={styles.summary} aria-label="Hub 収集状態">
                  <SummaryButton
                    label="定期収集"
                    value={`${snapshot.hubs.scheduledCount} / ${snapshot.hubs.enabledCount}`}
                    onClick={() => openMainRoute("/hubs")}
                    styles={styles}
                  />
                  <SummaryButton
                    label="実行中"
                    value={`${snapshot.hubs.runningCount} 件`}
                    onClick={() => openMainRoute("/hubs")}
                    styles={styles}
                  />
                  <SummaryButton
                    label="異常 Hub"
                    value={`${snapshot.hubs.abnormalCount} 件`}
                    onClick={() => openMainRoute("/hubs")}
                    styles={styles}
                  />
                </div>

                {expanded ? (
                  <div className={styles.limits} aria-label="Hub 別状態">
                    {(snapshot.hubs.items ?? []).map((hub) => (
                      <div className={styles.limit} key={hub.id}>
                        <Body1>{hub.displayName}</Body1>
                        <div className={styles.stateLine}>
                          <Caption1>接続</Caption1>
                          <StatusBadge status={hub.connection} />
                        </div>
                        <div className={styles.stateLine}>
                          <Caption1>定期収集</Caption1>
                          <Body1>
                            {hub.enabled && hub.collectionEnabled
                              ? "有効"
                              : "停止"}
                          </Body1>
                        </div>
                        <div className={styles.stateLine}>
                          <Caption1>現在の実行</Caption1>
                          <StatusBadge status={hub.currentCollection} />
                        </div>
                        <div className={styles.stateLine}>
                          <Caption1>最終取得</Caption1>
                          <StatusBadge status={hub.lastCollection} />
                        </div>
                        {hub.lastSuccessAt ? (
                          <Caption1>
                            最終成功:{" "}
                            <span title={hub.lastSuccessAt}>
                              {formatOverviewInstant(
                                hub.lastSuccessAt,
                                settings.displayTimeZone,
                              )}
                            </span>
                          </Caption1>
                        ) : null}
                        {hub.lastFailureAt ? (
                          <Caption1>
                            最終失敗:{" "}
                            <span title={hub.lastFailureAt}>
                              {formatOverviewInstant(
                                hub.lastFailureAt,
                                settings.displayTimeZone,
                              )}
                            </span>
                          </Caption1>
                        ) : null}
                        {hub.lastSkippedAt ? (
                          <Caption1>
                            最終スキップ:{" "}
                            <span title={hub.lastSkippedAt}>
                              {formatOverviewInstant(
                                hub.lastSkippedAt,
                                settings.displayTimeZone,
                              )}
                            </span>
                          </Caption1>
                        ) : null}
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
                    className={styles.limits}
                    data-region="limit-list"
                    aria-label="利用増加を最近確認した利用枠"
                  >
                    {limits.map((item) => (
                      <article
                        className={styles.limit}
                        key={`${item.logicalAccountId}:${item.limitDefinitionId}`}
                        aria-label={item.accessibleLabel}
                      >
                        <div className={styles.limitHeader}>
                          <div>
                            <Body1>
                              {item.serviceName} / {item.accountName}
                            </Body1>
                            <Caption1>{item.limitName}</Caption1>
                          </div>
                          <StatusBadge status={item.remaining} />
                        </div>
                        {item.remainingPercent === null ? (
                          <Body1>{item.remainingLabel}</Body1>
                        ) : (
                          <ProgressBar
                            value={item.remainingPercent}
                            max={100}
                            color={progressColor(item.remaining)}
                            thickness="medium"
                            aria-label={item.accessibleLabel}
                          />
                        )}
                        <Body1 className={styles.value} title={item.tooltip}>
                          残量 {item.remainingLabel}
                        </Body1>
                        <Caption1 title={item.resetAt}>
                          {item.resetAt
                            ? `${formatOverviewInstant(item.resetAt, settings.displayTimeZone)} リセット`
                            : item.reset.label}
                        </Caption1>
                        <Caption1 title={item.lastIncrease.occurredAt}>
                          利用増加:{" "}
                          {formatOverviewInstant(
                            item.lastIncrease.occurredAt,
                            settings.displayTimeZone,
                          )}
                          （{item.lastIncrease.ageLabel}）
                        </Caption1>
                        <Caption1
                          title={item.freshness.observationAt}
                          className={
                            item.freshness.status.code === "freshness_stale"
                              ? styles.stale
                              : undefined
                          }
                        >
                          最新観測:{" "}
                          {formatOverviewInstant(
                            item.freshness.observationAt,
                            settings.displayTimeZone,
                          )}
                          （{item.freshness.ageLabel}）
                        </Caption1>
                        <div className={styles.stateLine}>
                          <StatusBadge status={item.freshness.status} />
                          <Caption1>{item.freshness.reason}</Caption1>
                        </div>
                      </article>
                    ))}
                  </section>
                )}

                <footer className={styles.footer}>
                  <Button
                    size="small"
                    appearance="subtle"
                    onClick={() => openMainRoute("/review")}
                  >
                    要確認 {snapshot.review.actionItems.count} 件
                  </Button>
                  {snapshot.review.warnings.count > 0 ? (
                    <Button
                      size="small"
                      appearance="subtle"
                      onClick={() => openMainRoute("/review")}
                    >
                      警告 {snapshot.review.warnings.count} 件
                    </Button>
                  ) : null}
                  {snapshot.review.recalculationFailures.count > 0 ? (
                    <Button
                      size="small"
                      appearance="subtle"
                      onClick={() => openMainRoute("/review")}
                    >
                      処理失敗 {snapshot.review.recalculationFailures.count} 件
                    </Button>
                  ) : null}
                </footer>
                <div className={styles.actions}>
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
                  >
                    {expanded ? "折りたたむ" : "展開"}
                  </Button>
                  <Button
                    icon={<Open16Regular />}
                    disabled={!backend.canOpenMain}
                    onClick={() => openMainRoute("/overview")}
                  >
                    詳細
                  </Button>
                </div>
                <Caption1 role="status" aria-live="polite">
                  {updating
                    ? "更新中"
                    : `更新: ${formatOverviewInstant(snapshot.generatedAt, settings.displayTimeZone)}`}
                </Caption1>
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

function SummaryButton({
  label,
  value,
  onClick,
  styles,
}: {
  label: string;
  value: string;
  onClick: () => void;
  styles: ReturnType<typeof useStyles>;
}) {
  return (
    <Button
      className={styles.summaryButton}
      appearance="subtle"
      onClick={onClick}
    >
      {label}
      <br />
      <span className={styles.value}>{value}</span>
    </Button>
  );
}
