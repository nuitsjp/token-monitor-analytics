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
import type {
  CollectionAttemptSnapshot,
  CostObservationSnapshot,
  FrontendAdapter,
  LimitObservationSnapshot,
  RawSnapshotDetail,
  RawSnapshotSnapshot,
} from "../../lib/backend";
import type { HubSnapshot } from "../../../bindings/token-monitor-analytics/internal/desktop/models.js";

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
});

type EvidenceTab = "attempts" | "raw" | "observations";

export function EvidencePage({
  backend,
  displayTimeZone,
}: {
  backend: FrontendAdapter;
  displayTimeZone: string;
}) {
  const styles = useStyles();
  const [hubs, setHubs] = useState<HubSnapshot[]>([]);
  const [hubID, setHubID] = useState("");
  const [tab, setTab] = useState<EvidenceTab>("attempts");
  const [query, setQuery] = useState("");
  const [state, setState] = useState("");
  const [attempts, setAttempts] = useState<CollectionAttemptSnapshot[]>([]);
  const [rawSnapshots, setRawSnapshots] = useState<RawSnapshotSnapshot[]>([]);
  const [costs, setCosts] = useState<CostObservationSnapshot[]>([]);
  const [limits, setLimits] = useState<LimitObservationSnapshot[]>([]);
  const [rawDetail, setRawDetail] = useState<RawSnapshotDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    void backend
      .getHubs()
      .then((items) => {
        setHubs(items);
        setHubID((current) => current || items[0]?.id || "");
      })
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setLoading(false));
  }, [backend]);

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
            query,
          ),
      ),
    [attempts, query, state],
  );
  const filteredRaw = useMemo(
    () =>
      rawSnapshots.filter((item) =>
        includesQuery(
          [item.responseKind, item.apiContract, item.snapshotId],
          query,
        ),
      ),
    [query, rawSnapshots],
  );
  const filteredCosts = useMemo(
    () =>
      costs.filter((item) =>
        includesQuery(
          [item.deviceId, item.rawServiceIdentifier, item.jsonPath],
          query,
        ),
      ),
    [costs, query],
  );
  const filteredLimits = useMemo(
    () =>
      limits.filter((item) =>
        includesQuery(
          [
            item.deviceId,
            item.rawServiceIdentifier,
            item.accountKey,
            item.normalizedLabel,
            item.jsonPath,
          ],
          query,
        ),
      ),
    [limits, query],
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
          <Input value={query} onChange={(_, data) => setQuery(data.value)} />
        </Field>
        {tab === "attempts" && (
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
        selectedValue={tab}
        onTabSelect={(_, data) => setTab(data.value as EvidenceTab)}
      >
        <Tab value="attempts">取得</Tab>
        <Tab value="raw">原 JSON</Tab>
        <Tab value="observations">元観測</Tab>
      </TabList>
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            {error} <Button onClick={() => void loadEvidence()}>再試行</Button>
          </MessageBarBody>
        </MessageBar>
      )}
      {loading ? (
        <Spinner label="観測証跡を読み込み中" />
      ) : tab === "attempts" ? (
        <AttemptList
          items={filteredAttempts}
          displayTimeZone={displayTimeZone}
        />
      ) : tab === "raw" ? (
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
                <article className={styles.row} key={item.snapshotId}>
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
              <pre className={styles.raw}>{prettyJSON(rawDetail.body)}</pre>
            </section>
          )}
        </>
      ) : (
        <ObservationList
          costs={filteredCosts}
          limits={filteredLimits}
          displayTimeZone={displayTimeZone}
        />
      )}
    </div>
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
            {item.trigger} / {item.state}
          </div>
          <div className={styles.meta}>
            {formatInstant(item.startedAt, displayTimeZone)} / UTC:{" "}
            {item.startedAt}
          </div>
          <div>
            health: {item.healthHttpStatus ?? "—"} / stats:{" "}
            {item.statsHttpStatus ?? "—"}
          </div>
          {item.failureCode && (
            <div>
              {item.failureCode}: {item.failureDetail || "詳細なし"}
            </div>
          )}
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
}: {
  costs: CostObservationSnapshot[];
  limits: LimitObservationSnapshot[];
  displayTimeZone: string;
}) {
  const styles = useStyles();
  if (costs.length === 0 && limits.length === 0)
    return <Body1>元観測はありません。</Body1>;
  return (
    <div className={styles.list} aria-label="元観測一覧">
      {costs.map((item) => (
        <article className={styles.row} key={item.observationId}>
          <div>
            利用額 / {item.rawServiceIdentifier} / USD {item.costUsdText}
          </div>
          <div className={styles.meta}>
            {formatInstant(item.usageUpdatedAt, displayTimeZone)} / UTC:{" "}
            {item.usageUpdatedAt}
          </div>
          <div className={styles.meta}>
            {item.jsonPath} / {item.dedupeState}
          </div>
        </article>
      ))}
      {limits.map((item) => (
        <article className={styles.row} key={item.observationId}>
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
            {item.jsonPath} / {item.dedupeState}
          </div>
        </article>
      ))}
    </div>
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
    return new Intl.DateTimeFormat("ja-JP", {
      dateStyle: "medium",
      timeStyle: "medium",
      timeZone,
    }).format(new Date(value));
  } catch {
    return value;
  }
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
