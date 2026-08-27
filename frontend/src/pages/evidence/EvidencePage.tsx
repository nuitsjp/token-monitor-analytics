import {
  Body1,
  Button,
  Field,
  Input,
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
import { Link, useSearchParams } from "react-router";
import type {
  CollectionAttemptSnapshot,
  CostObservationSnapshot,
  FrontendAdapter,
  LimitObservationSnapshot,
  LimitSeriesDetailSnapshot,
  LimitSeriesSnapshot,
  RawSnapshotDetail,
  RawSnapshotSnapshot,
  UsageSnapshot,
} from "../../lib/backend";
import type { HubSnapshot } from "../../../bindings/token-monitor-analytics/internal/desktop/models.js";
import { StatusBadge } from "../../components/StatusBadge";
import { formatOverviewInstant } from "../../lib/overviewDisplay";

const useStyles = makeStyles({
  page: { display: "grid", gap: tokens.spacingVerticalL, maxWidth: "96rem" },
  controls: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 18rem), 1fr))",
    gap: tokens.spacingHorizontalM,
  },
  list: { display: "grid", gap: tokens.spacingVerticalS },
  row: {
    display: "grid",
    gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: tokens.shadow4,
  },
  targetRow: {
    outline: `2px solid ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorBrandBackground2,
    "@media (forced-colors: active)": {
      outlineColor: "CanvasText",
      backgroundColor: "Canvas",
    },
  },
  meta: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    overflowWrap: "anywhere",
  },
  raw: {
    maxHeight: "32rem",
    overflow: "auto",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    fontFamily: "Consolas, 'Cascadia Code', monospace",
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
  },
  rawToolbar: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "end",
    gap: tokens.spacingHorizontalS,
    marginBlock: tokens.spacingVerticalS,
  },
  rawLine: {
    display: "grid",
    gridTemplateColumns: "3rem minmax(0, 1fr)",
    gap: tokens.spacingHorizontalS,
  },
  lineNumber: {
    color: tokens.colorNeutralForeground3,
    textAlign: "right",
    userSelect: "none",
  },
  tree: {
    display: "grid",
    gap: tokens.spacingVerticalXS,
    paddingInlineStart: tokens.spacingHorizontalM,
    overflowWrap: "anywhere",
  },
});

type EvidenceTab =
  | "attempts"
  | "raw"
  | "observations"
  | "series"
  | "calculation"
  | "aggregation";

export function EvidencePage({
  backend,
  displayTimeZone,
}: {
  backend: FrontendAdapter;
  displayTimeZone: string;
}) {
  const styles = useStyles();
  const [searchParams] = useSearchParams();
  const targetObservationID = searchParams.get("observationId") ?? "";
  const targetSnapshotID = searchParams.get("snapshotId") ?? "";
  const targetSeriesID = searchParams.get("seriesId") ?? "";
  const targetUsageObservationID = searchParams.get("usageObservationId") ?? "";
  const [hubs, setHubs] = useState<HubSnapshot[]>([]);
  const [hubID, setHubID] = useState("");
  const [tab, setTab] = useState<EvidenceTab>(
    targetSeriesID ? "series" : "attempts",
  );
  const [query, setQuery] = useState("");
  const [state, setState] = useState("");
  const [attempts, setAttempts] = useState<CollectionAttemptSnapshot[]>([]);
  const [rawSnapshots, setRawSnapshots] = useState<RawSnapshotSnapshot[]>([]);
  const [costs, setCosts] = useState<CostObservationSnapshot[]>([]);
  const [limits, setLimits] = useState<LimitObservationSnapshot[]>([]);
  const [series, setSeries] = useState<LimitSeriesSnapshot[]>([]);
  const [selectedSeriesID, setSelectedSeriesID] = useState(targetSeriesID);
  const [seriesDetail, setSeriesDetail] =
    useState<LimitSeriesDetailSnapshot | null>(null);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [rawDetail, setRawDetail] = useState<RawSnapshotDetail | null>(null);
  const [rawMode, setRawMode] = useState<"tree" | "text">("tree");
  const [rawQuery, setRawQuery] = useState("");
  const [copiedPath, setCopiedPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [seriesError, setSeriesError] = useState("");
  const activeTab = targetUsageObservationID
    ? "aggregation"
    : targetObservationID
      ? "observations"
      : targetSnapshotID
        ? "raw"
        : tab;
  const activeQuery = targetObservationID || targetSnapshotID || query;

  const loadHubs = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const items = await backend.getHubs();
      setHubs(items);
      setHubID((current) => current || items[0]?.id || "");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [backend]);

  const loadSeries = useCallback(async () => {
    setSeriesError("");
    try {
      const nextSeries = await backend.getLimitSeries({
        serviceId: "",
        status: "",
        planVersionId: "",
        limitDefinitionId: "",
        sortBy: "status",
        descending: false,
      });
      setSeries(nextSeries);
      setSelectedSeriesID((current) => current || nextSeries[0]?.id || "");
    } catch (cause) {
      setSeriesError(errorMessage(cause));
    }
  }, [backend]);

  const loadUsage = useCallback(async () => {
    try {
      setUsage(
        await backend.getUsage({
          from: "2000-01-01T00:00:00Z",
          to: "2100-01-01T00:00:00Z",
          displayTimeZone,
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
      );
    } catch (cause) {
      setSeriesError(errorMessage(cause));
    }
  }, [backend, displayTimeZone]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadHubs();
    void loadSeries();
    void loadUsage();
  }, [loadHubs, loadSeries, loadUsage]);

  useEffect(() => {
    if (!selectedSeriesID) return;
    void backend
      .getLimitSeriesDetail(selectedSeriesID)
      .then(setSeriesDetail)
      .catch((cause: unknown) => setSeriesError(errorMessage(cause)));
  }, [backend, selectedSeriesID]);

  const loadEvidence = useCallback(async () => {
    if (!hubID) return;
    setLoading(true);
    setError("");
    try {
      const [nextAttempts, nextRaw, nextCosts, nextLimits] = await Promise.all([
        backend.getCollectionAttempts(hubID),
        backend.getRawSnapshots(hubID),
        backend.getCostObservations(hubID),
        backend.getLimitObservations(hubID),
      ]);
      setAttempts(nextAttempts);
      setRawSnapshots(nextRaw);
      setCosts(nextCosts);
      setLimits(nextLimits);
      setRawDetail(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [backend, hubID]);

  useEffect(() => {
    // A Hub selection synchronizes the page with the external Wails adapter.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadEvidence();
  }, [loadEvidence]);

  const filteredAttempts = useMemo(
    () =>
      attempts.filter(
        (item) =>
          (!state || item.state === state) &&
          includesQuery(
            [item.trigger, item.state, item.failureCode, item.apiContract],
            activeQuery,
          ),
      ),
    [attempts, activeQuery, state],
  );
  const filteredRaw = useMemo(
    () =>
      rawSnapshots.filter((item) =>
        includesQuery(
          [item.responseKind, item.apiContract, item.snapshotId],
          activeQuery,
        ),
      ),
    [activeQuery, rawSnapshots],
  );
  const filteredCosts = useMemo(
    () =>
      costs.filter((item) =>
        includesQuery(
          [
            item.observationId,
            item.deviceId,
            item.rawServiceIdentifier,
            item.jsonPath,
          ],
          activeQuery,
        ),
      ),
    [costs, activeQuery],
  );
  const filteredLimits = useMemo(
    () =>
      limits.filter((item) =>
        includesQuery(
          [
            item.observationId,
            item.deviceId,
            item.rawServiceIdentifier,
            item.accountKey,
            item.normalizedLabel,
            item.jsonPath,
          ],
          activeQuery,
        ),
      ),
    [limits, activeQuery],
  );
  const filteredSeries = useMemo(
    () =>
      series.filter((item) =>
        includesQuery(
          [
            item.id,
            item.serviceName,
            item.logicalAccountName,
            item.limitDefinitionName,
            item.state.label,
            item.stateReason,
          ],
          activeQuery,
        ),
      ),
    [activeQuery, series],
  );

  return (
    <div className={styles.page} role="region" aria-label="観測と根拠画面">
      <div>
        <Subtitle1 as="h1">観測と根拠</Subtitle1>
        <Body1>
          保存済みの取得事実、マスク済み原
          JSON、元観測を読み取り専用で確認します。
        </Body1>
      </div>
      <div className={styles.controls}>
        <Field label="Hub">
          <Select
            value={hubID}
            onChange={(event) => setHubID(event.target.value)}
          >
            {hubs.length === 0 && <option value="">Hub がありません</option>}
            {hubs.map((hub) => (
              <option key={hub.id} value={hub.id}>
                {hub.displayName}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="検索">
          <Input
            value={activeQuery}
            onChange={(_, data) => setQuery(data.value)}
          />
        </Field>
        {activeTab === "attempts" && (
          <Field label="取得状態">
            <Select
              value={state}
              onChange={(event) => setState(event.target.value)}
            >
              <option value="">すべて</option>
              <option value="succeeded">成功</option>
              <option value="failed">失敗</option>
              <option value="skipped">スキップ</option>
            </Select>
          </Field>
        )}
      </div>
      <TabList
        selectedValue={activeTab}
        onTabSelect={(_, data) => setTab(data.value as EvidenceTab)}
      >
        <Tab value="attempts">取得</Tab>
        <Tab value="raw">原 JSON</Tab>
        <Tab value="observations">元観測</Tab>
        <Tab value="series">利用枠系列</Tab>
        <Tab value="calculation">計算根拠</Tab>
        <Tab value="aggregation">集計根拠</Tab>
      </TabList>
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            {error}{" "}
            <Button onClick={() => void (hubID ? loadEvidence() : loadHubs())}>
              再試行
            </Button>
          </MessageBarBody>
        </MessageBar>
      )}
      {seriesError && (
        <MessageBar intent="warning">
          <MessageBarBody>
            利用枠系列を読み込めませんでした。{seriesError}{" "}
            <Button onClick={() => void loadSeries()}>系列を再試行</Button>
          </MessageBarBody>
        </MessageBar>
      )}
      {loading ? (
        <Spinner label="観測証跡を読み込み中" />
      ) : activeTab === "attempts" ? (
        <AttemptList
          items={filteredAttempts}
          displayTimeZone={displayTimeZone}
        />
      ) : activeTab === "raw" ? (
        <>
          <MessageBar intent="warning">
            <MessageBarBody>
              原 JSON
              にはアカウント識別情報と利用履歴が含まれます。未知フィールドと秘密値は表示用データでマスクされています。
            </MessageBarBody>
          </MessageBar>
          <div className={styles.list}>
            {filteredRaw.length === 0 ? (
              <Body1>原 JSON スナップショットはありません。</Body1>
            ) : (
              filteredRaw.map((item) => (
                <article
                  className={`${styles.row} ${item.snapshotId === targetSnapshotID ? styles.targetRow : ""}`}
                  key={item.snapshotId}
                  data-testid={
                    item.snapshotId === targetSnapshotID
                      ? "target-snapshot"
                      : undefined
                  }
                >
                  <div>
                    {item.responseKind} / HTTP {item.httpStatus}
                  </div>
                  <div className={styles.meta}>
                    {formatInstant(item.receivedCompletedAt, displayTimeZone)} /
                    UTC: {item.receivedCompletedAt}
                  </div>
                  <Button
                    onClick={() =>
                      void backend
                        .getRawSnapshot(item.snapshotId)
                        .then(setRawDetail)
                        .catch((cause: unknown) =>
                          setError(errorMessage(cause)),
                        )
                    }
                  >
                    マスク済み詳細
                  </Button>
                </article>
              ))
            )}
          </div>
          {rawDetail && (
            <section aria-label="マスク済み原 JSON 詳細">
              <Subtitle1 as="h2">マスク済み原 JSON</Subtitle1>
              <div className={styles.rawToolbar}>
                <Button
                  appearance={rawMode === "tree" ? "primary" : "secondary"}
                  aria-pressed={rawMode === "tree"}
                  onClick={() => setRawMode("tree")}
                >
                  ツリー
                </Button>
                <Button
                  appearance={rawMode === "text" ? "primary" : "secondary"}
                  aria-pressed={rawMode === "text"}
                  onClick={() => setRawMode("text")}
                >
                  折り返しテキスト
                </Button>
                <Field label="原 JSON 内を検索">
                  <Input
                    value={rawQuery}
                    onChange={(_, data) => setRawQuery(data.value)}
                  />
                </Field>
              </div>
              <div aria-live="polite" className={styles.meta}>
                {copiedPath && `JSON パスをコピーしました: ${copiedPath}`}
              </div>
              {rawMode === "tree" ? (
                <JSONTree
                  body={rawDetail.body}
                  query={rawQuery}
                  onCopyPath={(path) => {
                    void navigator.clipboard
                      .writeText(path)
                      .then(() => setCopiedPath(path))
                      .catch((cause: unknown) => setError(errorMessage(cause)));
                  }}
                />
              ) : (
                <RawText body={rawDetail.body} query={rawQuery} />
              )}
            </section>
          )}
        </>
      ) : activeTab === "observations" ? (
        <ObservationList
          costs={filteredCosts}
          limits={filteredLimits}
          displayTimeZone={displayTimeZone}
          targetObservationID={targetObservationID}
        />
      ) : activeTab === "series" ? (
        <SeriesTrace
          items={filteredSeries}
          selectedSeriesID={selectedSeriesID}
          detail={seriesDetail}
          displayTimeZone={displayTimeZone}
          onSelect={setSelectedSeriesID}
        />
      ) : activeTab === "calculation" ? (
        <CalculationTrace
          detail={seriesDetail}
          displayTimeZone={displayTimeZone}
        />
      ) : (
        <AggregationTrace
          usage={usage}
          targetObservationID={targetUsageObservationID}
          displayTimeZone={displayTimeZone}
        />
      )}
    </div>
  );
}

function JSONTree({
  body,
  query,
  onCopyPath,
}: {
  body: string;
  query: string;
  onCopyPath: (path: string) => void;
}) {
  const parsed = parseJSON(body);
  if (!parsed.ok) return <RawText body={body} query={query} />;
  return (
    <div aria-label="JSON ツリー">
      <JSONNode
        label="$"
        path="$"
        value={parsed.value}
        query={query}
        onCopyPath={onCopyPath}
      />
    </div>
  );
}

function JSONNode({
  label,
  path,
  value,
  query,
  onCopyPath,
}: {
  label: string;
  path: string;
  value: unknown;
  query: string;
  onCopyPath: (path: string) => void;
}) {
  const styles = useStyles();
  const children = jsonChildren(value, path);
  const matches = jsonNodeMatches(label, value, query);
  if (query.trim() && !matches && !jsonValueContains(value, query)) return null;

  if (children.length === 0) {
    return (
      <div className={styles.tree}>
        <span>
          {highlightText(label, query)}:{" "}
          {highlightText(JSON.stringify(value), query)}{" "}
          <Button size="small" onClick={() => onCopyPath(path)}>
            JSON パスをコピー
          </Button>
        </span>
      </div>
    );
  }
  return (
    <details open={query.trim() ? true : undefined} className={styles.tree}>
      <summary>
        {highlightText(label, query)}{" "}
        {Array.isArray(value) ? `[${children.length}]` : "{}"}
      </summary>
      <Button size="small" onClick={() => onCopyPath(path)}>
        JSON パスをコピー
      </Button>
      {children.map((child) => (
        <JSONNode
          key={child.path}
          label={child.label}
          path={child.path}
          value={child.value}
          query={query}
          onCopyPath={onCopyPath}
        />
      ))}
    </details>
  );
}

function RawText({ body, query }: { body: string; query: string }) {
  const styles = useStyles();
  const lines = prettyJSON(body).split("\n");
  return (
    <pre className={styles.raw} aria-label="折り返し原 JSON">
      {lines.map((line, index) => (
        <span className={styles.rawLine} key={`${index}-${line}`}>
          <span className={styles.lineNumber} aria-hidden="true">
            {index + 1}
          </span>
          <span>{highlightText(line, query)}</span>
        </span>
      ))}
    </pre>
  );
}

type JSONChild = { label: string; path: string; value: unknown };

function parseJSON(body: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(body) as unknown };
  } catch {
    return { ok: false };
  }
}

function jsonChildren(value: unknown, path: string): JSONChild[] {
  if (Array.isArray(value)) {
    return value.map((item, index) => ({
      label: String(index),
      path: `${path}[${index}]`,
      value: item,
    }));
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).map(([key, item]) => ({
    label: key,
    path: /^[A-Za-z_$][\w$]*$/.test(key)
      ? `${path}.${key}`
      : `${path}[${JSON.stringify(key)}]`,
    value: item,
  }));
}

function jsonNodeMatches(
  label: string,
  value: unknown,
  query: string,
): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  return `${label} ${typeof value === "object" ? "" : JSON.stringify(value)}`
    .toLocaleLowerCase()
    .includes(normalized);
}

function jsonValueContains(value: unknown, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  return JSON.stringify(value).toLocaleLowerCase().includes(normalized);
}

function highlightText(line: string, query: string) {
  const normalized = query.trim();
  if (!normalized) return line;
  const index = line
    .toLocaleLowerCase()
    .indexOf(normalized.toLocaleLowerCase());
  if (index < 0) return line;
  return (
    <>
      {line.slice(0, index)}
      <mark>{line.slice(index, index + normalized.length)}</mark>
      {line.slice(index + normalized.length)}
    </>
  );
}

function AttemptList({
  items,
  displayTimeZone,
}: {
  items: CollectionAttemptSnapshot[];
  displayTimeZone: string;
}) {
  const styles = useStyles();
  if (items.length === 0) return <Body1>取得履歴はありません。</Body1>;
  return (
    <div className={styles.list} aria-label="取得一覧">
      {items.map((item) => (
        <article className={styles.row} key={item.attemptId}>
          <div>
            {attemptTriggerLabel(item.trigger)} /{" "}
            {attemptStateLabel(item.state)}
          </div>
          <div className={styles.meta}>
            開始: {formatInstant(item.startedAt, displayTimeZone)} / UTC:{" "}
            {item.startedAt}
          </div>
          <div className={styles.meta}>
            完了: {formatInstant(item.completedAt, displayTimeZone)}
            {item.completedAt ? ` / UTC: ${item.completedAt}` : ""}
          </div>
          <div>
            接続確認 HTTP: {item.healthHttpStatus ?? "—"} / 統計 HTTP:{" "}
            {item.statsHttpStatus ?? "—"}
          </div>
          {item.failureCode && (
            <div>
              {attemptFailureLabel(item.failureCode)}:{" "}
              {item.failureDetail || "詳細なし"}
            </div>
          )}
          {item.normalizationErrorPath ? (
            <div>正規化エラー箇所: {item.normalizationErrorPath}</div>
          ) : null}
          {item.apiContract && (
            <div className={styles.meta}>契約: {item.apiContract}</div>
          )}
        </article>
      ))}
    </div>
  );
}

function ObservationList({
  costs,
  limits,
  displayTimeZone,
  targetObservationID,
}: {
  costs: CostObservationSnapshot[];
  limits: LimitObservationSnapshot[];
  displayTimeZone: string;
  targetObservationID: string;
}) {
  const styles = useStyles();
  if (costs.length === 0 && limits.length === 0)
    return <Body1>元観測はありません。</Body1>;
  return (
    <div className={styles.list} aria-label="元観測一覧">
      {costs.map((item) => (
        <article
          className={`${styles.row} ${item.observationId === targetObservationID ? styles.targetRow : ""}`}
          key={item.observationId}
          data-testid={
            item.observationId === targetObservationID
              ? "target-observation"
              : undefined
          }
        >
          <div>
            利用額 / {item.rawServiceIdentifier} / {formatUSD(item.costUsdText)}
          </div>
          <div className={styles.meta}>
            {formatInstant(item.usageUpdatedAt, displayTimeZone)} / UTC:{" "}
            {item.usageUpdatedAt}
          </div>
          <div className={styles.meta}>
            JSON パス: {item.jsonPath} / {dedupeStateLabel(item.dedupeState)}
          </div>
        </article>
      ))}
      {limits.map((item) => (
        <article
          className={`${styles.row} ${item.observationId === targetObservationID ? styles.targetRow : ""}`}
          key={item.observationId}
          data-testid={
            item.observationId === targetObservationID
              ? "target-observation"
              : undefined
          }
        >
          <div>
            利用枠 / {item.rawServiceIdentifier} /{" "}
            {item.normalizedLabel || item.windowKey}
          </div>
          <div>
            利用 {item.usedPercent ?? "—"}% / 残り{" "}
            {item.remainingPercent ?? "—"}%
          </div>
          <div className={styles.meta}>
            {formatInstant(item.providerUpdatedAt, displayTimeZone)} / UTC:{" "}
            {item.providerUpdatedAt}
          </div>
          <div className={styles.meta}>
            JSON パス: {item.jsonPath} / {dedupeStateLabel(item.dedupeState)}
          </div>
        </article>
      ))}
    </div>
  );
}

function SeriesTrace({
  items,
  selectedSeriesID,
  detail,
  displayTimeZone,
  onSelect,
}: {
  items: LimitSeriesSnapshot[];
  selectedSeriesID: string;
  detail: LimitSeriesDetailSnapshot | null;
  displayTimeZone: string;
  onSelect: (seriesID: string) => void;
}) {
  const styles = useStyles();
  return (
    <div className={styles.list} aria-label="利用枠系列一覧">
      {items.length === 0 ? (
        <Body1>利用枠系列はありません。</Body1>
      ) : (
        items.map((item) => (
          <article
            className={`${styles.row} ${item.id === selectedSeriesID ? styles.targetRow : ""}`}
            key={item.id}
          >
            <div>
              {item.serviceName} /{" "}
              {item.logicalAccountName || "論理アカウント未設定"} /{" "}
              {item.limitDefinitionName || "利用枠未設定"}
            </div>
            <div className={styles.meta}>
              状態: <StatusBadge status={item.state} />
              {item.stateReason ? `（${item.stateReason}）` : ""}
            </div>
            <Button
              appearance={
                item.id === selectedSeriesID ? "primary" : "secondary"
              }
              onClick={() => onSelect(item.id)}
            >
              この系列を確認
            </Button>
          </article>
        ))
      )}
      {detail && (
        <SeriesDetail detail={detail} displayTimeZone={displayTimeZone} />
      )}
    </div>
  );
}

function SeriesDetail({
  detail,
  displayTimeZone,
}: {
  detail: LimitSeriesDetailSnapshot;
  displayTimeZone: string;
}) {
  const styles = useStyles();
  const intervals = [
    ...(detail.current ? [detail.current] : []),
    ...(detail.history ?? []),
  ];
  return (
    <section className={styles.row} aria-label="利用枠系列の状態と区間">
      <Subtitle1 as="h2">系列の状態と区間</Subtitle1>
      <Body1>
        状態: <StatusBadge status={detail.series.state} />
      </Body1>
      <Body1>状態理由: {detail.series.stateReason || "理由なし"}</Body1>
      <Body1>
        最新観測:{" "}
        {formatInstant(detail.series.latestObservationAt, displayTimeZone)}
      </Body1>
      {intervals.length === 0 ? (
        <Body1>計算区間はありません。</Body1>
      ) : (
        <div aria-label="計算区間一覧">
          {intervals.map((interval) => (
            <div className={styles.meta} key={interval.id}>
              {interval.roleLabel || "区間"}:{" "}
              {formatInstant(interval.validFrom, displayTimeZone)} ～{" "}
              {formatInstant(interval.validTo, displayTimeZone)} /{" "}
              {interval.stateLabel || interval.state || "状態不明"}
              {interval.exclusionReason
                ? `（${interval.exclusionReason}）`
                : ""}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function AggregationTrace({
  usage,
  targetObservationID,
  displayTimeZone,
}: {
  usage: UsageSnapshot | null;
  targetObservationID: string;
  displayTimeZone: string;
}) {
  const styles = useStyles();
  if (!usage) return <Body1>集計根拠を読み込み中です。</Body1>;
  const evidence = usage.evidence ?? [];
  return (
    <section className={styles.list} aria-label="集計根拠">
      <article className={styles.row}>
        <Subtitle1 as="h2">集計条件</Subtitle1>
        <Body1>
          {formatInstant(usage.from, displayTimeZone)} ～{" "}
          {formatInstant(usage.to, displayTimeZone)} / {usage.granularity} /{" "}
          {usage.groupBy}
        </Body1>
        <Body1>
          累積観測の隣接差分 {usage.summary.observationCount} 件、利用額ソース{" "}
          {usage.summary.sourceCount} 件を使用しました。
        </Body1>
      </article>
      {evidence.length === 0 ? (
        <Body1>対象期間の集計根拠はありません。</Body1>
      ) : (
        evidence.map((item) => (
          <article
            className={`${styles.row} ${item.endObservationId === targetObservationID ? styles.targetRow : ""}`}
            key={`${item.sourceId}-${item.endObservationId}`}
          >
            <Subtitle1 as="h2">
              {item.hubName} / {item.rawServiceIdentifier}
            </Subtitle1>
            <Body1>
              隣接観測: {item.startObservationId} → {item.endObservationId}
            </Body1>
            <div className={styles.meta}>
              {formatInstant(item.startAt, displayTimeZone)} ～{" "}
              {formatInstant(item.endAt, displayTimeZone)}
            </div>
            <div className={styles.meta}>
              利用額ソース: {item.sourceId} / Hub 端末レコード: {item.deviceId}
            </div>
            <div className={styles.meta}>
              原 JSON: {item.startSnapshotId} → {item.endSnapshotId} / JSON
              パス: {item.jsonPath}
            </div>
            <Link
              to={`/evidence?snapshotId=${encodeURIComponent(item.endSnapshotId)}`}
            >
              終点の原 JSON を表示
            </Link>
          </article>
        ))
      )}
    </section>
  );
}

function CalculationTrace({
  detail,
  displayTimeZone,
}: {
  detail: LimitSeriesDetailSnapshot | null;
  displayTimeZone: string;
}) {
  const styles = useStyles();
  if (!detail) return <Body1>系列を選択すると計算根拠を表示します。</Body1>;
  const result = detail.series.result;
  const evidence = result?.evidence ?? [];
  const differences = result?.differenceRows ?? [];
  return (
    <section className={styles.list} aria-label="計算根拠">
      <article className={styles.row}>
        <Subtitle1 as="h2">計算結果</Subtitle1>
        <Body1>状態: {result?.status.label || "未算出"}</Body1>
        <Body1>
          理由:{" "}
          {result?.statusReason || detail.series.stateReason || "理由なし"}
        </Body1>
        <Body1>
          計算期間: {formatInstant(result?.validFrom ?? "", displayTimeZone)} ～{" "}
          {formatInstant(result?.validTo ?? "", displayTimeZone)}
        </Body1>
        <Body1>
          観測点数: {result?.observationPointCount ?? 0} / 差分行数:{" "}
          {result?.differenceRowCount ?? 0} / 計算論理版:{" "}
          {result?.calculationLogicVersion || "—"}
        </Body1>
      </article>
      <article className={styles.row}>
        <Subtitle1 as="h2">差分と根拠</Subtitle1>
        {differences.length === 0 && evidence.length === 0 ? (
          <Body1>差分行と観測根拠はありません。</Body1>
        ) : (
          <div className={styles.list}>
            {differences.map((row) => (
              <div className={styles.meta} key={row.id}>
                差分: {formatInstant(row.startAt, displayTimeZone)} ～{" "}
                {formatInstant(row.endAt, displayTimeZone)} /{" "}
                {row.accepted ? "採用" : "除外"}
                {row.exclusionReason ? `（${row.exclusionReason}）` : ""}
              </div>
            ))}
            {evidence.map((item) => (
              <div className={styles.meta} key={item.id}>
                根拠: {evidenceKindLabel(item.kind)} /{" "}
                {formatInstant(item.observedAt, displayTimeZone)} /{" "}
                {item.m08Route ? (
                  <Link to={item.m08Route}>観測と根拠で確認</Link>
                ) : (
                  "導線なし"
                )}
              </div>
            ))}
          </div>
        )}
      </article>
    </section>
  );
}

function includesQuery(values: string[], query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  return (
    !normalized ||
    values.some((value) => value.toLocaleLowerCase().includes(normalized))
  );
}

function formatInstant(value: string, timeZone: string): string {
  if (!value) return "—";
  try {
    return formatOverviewInstant(value, timeZone);
  } catch {
    return "日時不明";
  }
}

function attemptTriggerLabel(value: string): string {
  return (
    (
      {
        manual: "手動取得",
        scheduled: "定期取得",
        startup: "起動時取得",
      } as Record<string, string>
    )[value] ?? "取得"
  );
}

function attemptStateLabel(value: string): string {
  return (
    (
      {
        succeeded: "成功",
        failed: "失敗",
        running: "実行中",
        skipped: "スキップ",
      } as Record<string, string>
    )[value] ?? "状態不明"
  );
}

function attemptFailureLabel(value: string): string {
  return (
    (
      {
        stats_http_error: "統計 API の取得失敗",
        health_http_error: "接続確認 API の取得失敗",
        authentication_failed: "認証失敗",
        timeout: "応答待ち時間超過",
        unsupported_contract: "未対応 API 契約",
        invalid_json: "応答形式エラー",
      } as Record<string, string>
    )[value] ?? "取得失敗"
  );
}

function dedupeStateLabel(value: string): string {
  return (
    (
      {
        canonical: "正規観測",
        duplicate: "重複観測",
        conflict: "重複排除不整合",
        excluded: "計算対象外",
      } as Record<string, string>
    )[value] ?? "重複排除状態不明"
  );
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

function formatUSD(value: string): string {
  const exactValue = value.trim();
  return exactValue && Number.isFinite(Number(exactValue))
    ? `${exactValue} USD`
    : "金額不明";
}

function prettyJSON(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "観測証跡を読み込めませんでした。";
}
