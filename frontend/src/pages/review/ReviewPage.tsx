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
  Tab,
  TabList,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import type {
  FrontendAdapter,
  HubSnapshot,
  ReviewFilterInput,
  ReviewItemSnapshot,
  ReviewPage as ReviewPageResult,
} from "../../lib/backend";

const useStyles = makeStyles({
  page: {
    display: "grid",
    gap: tokens.spacingVerticalL,
    maxWidth: "100rem",
  },
  intro: {
    display: "grid",
    gap: tokens.spacingVerticalXS,
  },
  filters: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 12rem), 1fr))",
    alignItems: "end",
    gap: tokens.spacingHorizontalM,
    padding: tokens.spacingVerticalL,
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: tokens.shadow4,
  },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalS,
  },
  tabs: {
    display: "flex",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalM,
    alignItems: "end",
    flexWrap: "wrap",
  },
  content: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) minmax(18rem, 24rem)",
    gap: tokens.spacingHorizontalL,
    alignItems: "start",
    "@media (max-width: 70rem)": {
      gridTemplateColumns: "1fr",
    },
  },
  list: {
    display: "grid",
    gap: tokens.spacingVerticalS,
    minWidth: 0,
  },
  item: {
    display: "grid",
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalL,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: tokens.shadow2,
    contentVisibility: "auto",
    containIntrinsicSize: "180px",
  },
  selectedItem: {
    outline: `2px solid ${tokens.colorBrandBackground}`,
    outlineOffset: "-2px",
  },
  itemHeader: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
  },
  selectButton: {
    minWidth: 0,
    flex: "1 1 16rem",
    justifyContent: "flex-start",
    textAlign: "left",
    fontWeight: tokens.fontWeightSemibold,
    whiteSpace: "normal",
  },
  badge: {
    display: "inline-flex",
    alignItems: "center",
    minHeight: "1.5rem",
    padding: `0 ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
  },
  warningBadge: {
    backgroundColor: tokens.colorPaletteYellowBackground1,
    color: tokens.colorPaletteYellowForeground1,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 10rem), 1fr))",
    gap: tokens.spacingVerticalM,
    margin: 0,
  },
  field: {
    minWidth: 0,
  },
  fieldLabel: {
    display: "block",
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
  },
  fieldValue: {
    margin: 0,
    overflowWrap: "anywhere",
  },
  meta: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    overflowWrap: "anywhere",
  },
  detail: {
    display: "grid",
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalL,
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: tokens.shadow4,
    minWidth: 0,
    position: "sticky",
    top: tokens.spacingVerticalL,
    "@media (max-width: 70rem)": {
      position: "static",
    },
  },
  detailHeading: {
    display: "grid",
    gap: tokens.spacingVerticalXS,
  },
  detailSection: {
    display: "grid",
    gap: tokens.spacingVerticalXS,
    paddingTop: tokens.spacingVerticalS,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
});

type ReviewTab = "work" | "warnings";
type FilterState = {
  from: string;
  to: string;
  kind: string;
  state: string;
  impact: string;
  hubId: string;
};

const emptyFilters: FilterState = {
  from: "",
  to: "",
  kind: "",
  state: "",
  impact: "",
  hubId: "",
};

const kindOptions = [
  ["identification_candidate", "サービス・プラン同定候補"],
  ["hub_account_candidate", "Hubアカウント候補"],
  ["usage_cost_unassociated", "未関連付け利用額"],
  ["usage_limit_unassociated", "未関連付け利用枠"],
  ["label_change", "利用枠名称変更候補"],
  ["billing_monthly", "billing月次確認"],
  ["plan_history_inconsistency", "プラン履歴不整合"],
  ["completeness", "活動主体の完全性"],
  ["missing_account_key", "accountKey欠落"],
  ["cost_dedupe_conflict", "利用額重複排除不整合"],
  ["limit_dedupe_conflict", "利用枠重複排除不整合"],
] as const;

const warningKinds = new Set([
  "missing_account_key",
  "cost_dedupe_conflict",
  "limit_dedupe_conflict",
]);

export function ReviewPage({
  backend,
  displayTimeZone = backend.initialSettings.displayTimeZone,
}: {
  backend: FrontendAdapter;
  displayTimeZone?: string;
}) {
  const styles = useStyles();
  const navigate = useNavigate();
  const [tab, setTab] = useState<ReviewTab>("work");
  const [filters, setFilters] = useState<FilterState>(emptyFilters);
  const [appliedFilters, setAppliedFilters] =
    useState<FilterState>(emptyFilters);
  const [page, setPage] = useState<ReviewPageResult | null>(null);
  const [cursorHistory, setCursorHistory] = useState<string[]>([""]);
  const [hubs, setHubs] = useState<HubSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedID, setSelectedID] = useState("");

  const loadPage = useCallback(
    async (cursor: string, activeFilters: FilterState) => {
      setLoading(true);
      setError("");
      const input: ReviewFilterInput = {
        cursor,
        limit: 50,
        from: toUTC(activeFilters.from),
        to: toUTC(activeFilters.to),
        kind: activeFilters.kind.trim(),
        state: activeFilters.state.trim(),
        impact: activeFilters.impact.trim(),
        hubId: activeFilters.hubId,
      };
      try {
        setPage(await backend.getReviewItems(input));
      } catch (cause) {
        setError(errorMessage(cause));
        setPage(null);
      } finally {
        setLoading(false);
      }
    },
    [backend],
  );

  useEffect(() => {
    // The initial read synchronizes this page with the external Wails adapter.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadPage("", emptyFilters);
  }, [loadPage]);

  useEffect(() => {
    let active = true;
    void backend
      .getHubs()
      .then((value) => {
        if (active) setHubs(value);
      })
      .catch(() => {
        if (active) setHubs([]);
      });
    return () => {
      active = false;
    };
  }, [backend]);

  const applyFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAppliedFilters(filters);
    setCursorHistory([""]);
    void loadPage("", filters);
  };

  const clearFilters = () => {
    setFilters(emptyFilters);
    setAppliedFilters(emptyFilters);
    setCursorHistory([""]);
    void loadPage("", emptyFilters);
  };

  const next = () => {
    if (!page?.hasMore || !page.nextCursor) return;
    setCursorHistory((current) => [...current, page.nextCursor]);
    void loadPage(page.nextCursor, appliedFilters);
  };

  const previous = () => {
    if (cursorHistory.length <= 1) return;
    const nextHistory = cursorHistory.slice(0, -1);
    setCursorHistory(nextHistory);
    void loadPage(nextHistory[nextHistory.length - 1], appliedFilters);
  };

  const allItems = page?.items ?? [];
  const visibleItems = allItems.filter((item) =>
    tab === "warnings"
      ? warningKinds.has(item.kind)
      : !warningKinds.has(item.kind),
  );
  const selected =
    visibleItems.find((item) => item.id === selectedID) ?? visibleItems[0];

  const openDestination = (item: ReviewItemSnapshot) => {
    const path = destinationFor(item);
    navigate(path, {
      state: {
        reviewReturn: {
          path: "/review",
          tab,
          filters: appliedFilters,
          targetId: item.targetId,
          evidenceIds: item.evidenceIds ?? [],
        },
      },
    });
  };

  return (
    <div className={styles.page}>
      <div className={styles.intro}>
        <Subtitle1 as="h1">要確認</Subtitle1>
        <Body1>
          判断が必要な作業と、正本を変更せずに確認するデータ警告を分けて表示します。
        </Body1>
      </div>

      <form className={styles.filters} onSubmit={applyFilters}>
        <Field label="開始日時（UTC）">
          <Input
            type="datetime-local"
            value={filters.from}
            onChange={(_, data) =>
              setFilters((current) => ({ ...current, from: data.value }))
            }
          />
        </Field>
        <Field label="終了日時（UTC・含まない）">
          <Input
            type="datetime-local"
            value={filters.to}
            onChange={(_, data) =>
              setFilters((current) => ({ ...current, to: data.value }))
            }
          />
        </Field>
        <Field label="種類">
          <Select
            value={filters.kind}
            onChange={(_, data) =>
              setFilters((current) => ({ ...current, kind: data.value }))
            }
          >
            <option value="">すべて</option>
            {kindOptions.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="状態">
          <Select
            value={filters.state}
            onChange={(_, data) =>
              setFilters((current) => ({ ...current, state: data.value }))
            }
          >
            <option value="">すべて</option>
            <option value="unconfirmed">未確認</option>
            <option value="archived_reconfirmation">アーカイブ後再確認</option>
            <option value="missing">欠落</option>
            <option value="active">有効</option>
            <option value="conflict">不整合</option>
          </Select>
        </Field>
        <Field label="影響区分">
          <Select
            value={filters.impact}
            onChange={(_, data) =>
              setFilters((current) => ({ ...current, impact: data.value }))
            }
          >
            <option value="">すべて</option>
            <option value="current_calculation_impact">
              カレント計算へ影響
            </option>
            <option value="calculation_interval_impossible">
              計算区間形成不能
            </option>
            <option value="current_no_impact">現在影響なし</option>
          </Select>
        </Field>
        <Field label="Hub">
          <Select
            value={filters.hubId}
            onChange={(_, data) =>
              setFilters((current) => ({ ...current, hubId: data.value }))
            }
          >
            <option value="">すべて</option>
            {hubs.map((hub) => (
              <option key={hub.id} value={hub.id}>
                {hub.displayName}
              </option>
            ))}
          </Select>
        </Field>
        <div className={styles.actions}>
          <Button appearance="primary" type="submit">
            絞り込む
          </Button>
          <Button type="button" onClick={clearFilters}>
            条件をクリア
          </Button>
        </div>
      </form>

      <div className={styles.tabs}>
        <TabList
          selectedValue={tab}
          onTabSelect={(_, data) => setTab(data.value as ReviewTab)}
          aria-label="要確認の分類"
        >
          <Tab value="work">要確認作業</Tab>
          <Tab value="warnings">データ警告</Tab>
        </TabList>
        <Caption1>最終観測時刻の新しい順・半開期間 [開始, 終了)</Caption1>
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            {error}
            <Button
              appearance="transparent"
              onClick={() =>
                void loadPage(
                  cursorHistory[cursorHistory.length - 1],
                  appliedFilters,
                )
              }
            >
              再試行
            </Button>
          </MessageBarBody>
        </MessageBar>
      )}

      {loading ? (
        <Spinner label="要確認項目を読み込み中" />
      ) : visibleItems.length === 0 ? (
        <Body1>
          {hasFilters(appliedFilters)
            ? "条件に一致する項目はありません。"
            : tab === "warnings"
              ? "現在有効なデータ警告はありません。"
              : "要確認作業はありません。"}
        </Body1>
      ) : (
        <div className={styles.content}>
          <div className={styles.list} role="list" aria-label={tabLabel(tab)}>
            {visibleItems.map((item) => (
              <ReviewItemCard
                key={item.id}
                item={item}
                selected={item.id === selected?.id}
                displayTimeZone={displayTimeZone}
                hubs={hubs}
                styles={styles}
                onSelect={() => setSelectedID(item.id)}
              />
            ))}
          </div>
          {selected && (
            <ReviewDetail
              item={selected}
              tab={tab}
              displayTimeZone={displayTimeZone}
              styles={styles}
              onNavigate={() => openDestination(selected)}
            />
          )}
        </div>
      )}

      {!loading && (visibleItems.length > 0 || cursorHistory.length > 1) && (
        <div className={styles.actions}>
          <Button onClick={previous} disabled={cursorHistory.length <= 1}>
            前のページ
          </Button>
          <Button onClick={next} disabled={!page?.hasMore}>
            次のページ
          </Button>
        </div>
      )}
    </div>
  );
}

function ReviewItemCard({
  item,
  selected,
  displayTimeZone,
  hubs,
  styles,
  onSelect,
}: {
  item: ReviewItemSnapshot;
  selected: boolean;
  displayTimeZone: string;
  hubs: HubSnapshot[];
  styles: ReturnType<typeof useStyles>;
  onSelect: () => void;
}) {
  return (
    <div
      className={`${styles.item} ${selected ? styles.selectedItem : ""}`}
      role="listitem"
      aria-current={selected ? "true" : undefined}
    >
      <div className={styles.itemHeader}>
        <Button
          appearance="subtle"
          className={styles.selectButton}
          onClick={onSelect}
          aria-pressed={selected}
        >
          {targetLabel(item)}
        </Button>
        <span
          className={`${styles.badge} ${warningKinds.has(item.kind) ? styles.warningBadge : ""}`}
        >
          {warningKinds.has(item.kind) ? "データ警告" : "要確認作業"}
        </span>
      </div>
      <dl className={styles.grid}>
        <ReviewField styles={styles} label="種類">
          {kindLabel(item.kind)}
        </ReviewField>
        <ReviewField styles={styles} label="状態">
          {stateLabel(item.state)}
        </ReviewField>
        <ReviewField styles={styles} label="Hub">
          {hubLabel(item.hubId, hubs)}
        </ReviewField>
        <ReviewField styles={styles} label="対象期間">
          {formatPeriod(
            item.targetPeriodStart,
            item.targetPeriodEnd,
            displayTimeZone,
          )}
        </ReviewField>
        <ReviewField styles={styles} label="最初の観測">
          {formatInstantPair(item.firstObservedAt, displayTimeZone)}
        </ReviewField>
        <ReviewField styles={styles} label="最後の観測">
          {formatInstantPair(item.lastObservedAt, displayTimeZone)}
        </ReviewField>
        <ReviewField styles={styles} label="推定影響">
          {impactLabel(item.impact)}
        </ReviewField>
      </dl>
    </div>
  );
}

function ReviewDetail({
  item,
  tab,
  displayTimeZone,
  styles,
  onNavigate,
}: {
  item: ReviewItemSnapshot;
  tab: ReviewTab;
  displayTimeZone: string;
  styles: ReturnType<typeof useStyles>;
  onNavigate: () => void;
}) {
  return (
    <aside className={styles.detail} aria-label="選択行の非秘密根拠">
      <div className={styles.detailHeading}>
        <Subtitle1 as="h2">選択した項目</Subtitle1>
        <Body1>{targetLabel(item)}</Body1>
      </div>
      <dl className={styles.detailSection}>
        <ReviewField styles={styles} label="対象">
          {targetLabel(item)}
        </ReviewField>
        <ReviewField styles={styles} label="非秘密の表示情報">
          {nonSecretDetails(item)}
        </ReviewField>
        <ReviewField styles={styles} label="根拠観測">
          {item.count}件
        </ReviewField>
        <ReviewField styles={styles} label="観測期間">
          {formatInstantPair(item.firstObservedAt, displayTimeZone)}
          <br />～ {formatInstantPair(item.lastObservedAt, displayTimeZone)}
        </ReviewField>
        <ReviewField styles={styles} label="対象期間 [開始, 終了)">
          {formatPeriod(
            item.targetPeriodStart,
            item.targetPeriodEnd,
            displayTimeZone,
          )}
        </ReviewField>
        <ReviewField styles={styles} label="推定除外理由">
          {item.estimationExclusionReason || "なし"}
        </ReviewField>
      </dl>
      <div className={styles.actions}>
        <Button appearance="primary" onClick={onNavigate}>
          {tab === "warnings" ? "関連設定を開く" : "確認先を開く"}
        </Button>
      </div>
      <Caption1>
        この画面は読み取り専用です。判断の保存や元観測の承認は行いません。
      </Caption1>
    </aside>
  );
}

function ReviewField({
  label,
  children,
  styles,
}: {
  label: string;
  children: React.ReactNode;
  styles: ReturnType<typeof useStyles>;
}) {
  return (
    <div className={styles.field}>
      <dt className={styles.fieldLabel}>{label}</dt>
      <dd className={styles.fieldValue}>{children}</dd>
    </div>
  );
}

function targetLabel(item: ReviewItemSnapshot): string {
  return (
    item.target ||
    item.accountDisplayName ||
    item.workspaceName ||
    item.deviceName ||
    "対象不明"
  );
}

function hubLabel(hubID: string, hubs: HubSnapshot[]): string {
  return hubs.find((hub) => hub.id === hubID)?.displayName || "不明";
}

function nonSecretDetails(item: ReviewItemSnapshot): string {
  const values = [
    item.accountDisplayName,
    item.workspaceName,
    item.deviceName,
    item.rawLimitServiceIdentifier,
    item.rawReportedPlanName,
  ].filter(Boolean);
  return values.length > 0 ? values.join(" / ") : "表示情報なし";
}

function kindLabel(value: string): string {
  return kindOptions.find(([kind]) => kind === value)?.[1] ?? value;
}

function stateLabel(value: string): string {
  return (
    (
      {
        unconfirmed: "未確認",
        archived_reconfirmation: "アーカイブ後再確認",
        missing: "欠落",
        active: "有効",
        conflict: "不整合",
      } as Record<string, string>
    )[value] ?? value
  );
}

function impactLabel(value: string): string {
  return (
    (
      {
        current_calculation_impact: "カレント計算へ影響",
        calculation_interval_impossible: "計算区間形成不能",
        current_no_impact: "現在影響なし",
      } as Record<string, string>
    )[value] ?? value
  );
}

function tabLabel(tab: ReviewTab): string {
  return tab === "warnings" ? "データ警告一覧" : "要確認作業一覧";
}

function destinationFor(item: ReviewItemSnapshot): string {
  if (
    item.kind === "identification_candidate" ||
    item.kind === "billing_monthly"
  ) {
    return "/catalog";
  }
  return "/accounts";
}

function formatInstantPair(value: string, timeZone: string): string {
  return value ? `${formatInstant(value, timeZone)} / UTC: ${value}` : "不明";
}

function formatPeriod(start: string, end: string, timeZone: string): string {
  const left = start ? formatInstantPair(start, timeZone) : "不明";
  const right = end ? formatInstantPair(end, timeZone) : "継続中";
  return `[${left}, ${right})`;
}

function formatInstant(value: string, timeZone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "日時不明";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function toUTC(value: string): string {
  if (!value) return "";
  const date = new Date(`${value}:00Z`);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function hasFilters(filters: FilterState): boolean {
  return Boolean(
    filters.from ||
    filters.to ||
    filters.kind.trim() ||
    filters.state.trim() ||
    filters.impact.trim() ||
    filters.hubId,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "要確認項目を読み込めませんでした。";
}
