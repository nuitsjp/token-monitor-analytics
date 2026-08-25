import {
  Body1,
  Button,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Spinner,
  Subtitle1,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type {
  AuditFilterInput,
  AuditPage as AuditPageResult,
  AuditRecord,
  FrontendAdapter,
} from "../../lib/backend";

const useStyles = makeStyles({
  page: {
    display: "grid",
    gap: tokens.spacingVerticalL,
    maxWidth: "90rem",
  },
  filters: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))",
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
  tableWrap: {
    overflowX: "auto",
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: tokens.shadow4,
  },
  table: {
    width: "100%",
    minWidth: "72rem",
    borderCollapse: "collapse",
    fontSize: tokens.fontSizeBase200,
  },
  header: {
    textAlign: "left",
    color: tokens.colorNeutralForeground3,
    fontWeight: tokens.fontWeightSemibold,
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    padding: tokens.spacingVerticalM,
    whiteSpace: "nowrap",
  },
  cell: {
    verticalAlign: "top",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    padding: tokens.spacingVerticalM,
  },
  meta: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  json: {
    margin: 0,
    maxWidth: "20rem",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    fontFamily: "Consolas, 'Cascadia Code', monospace",
    fontSize: tokens.fontSizeBase200,
  },
});

type FilterState = {
  from: string;
  to: string;
  entityType: string;
  action: string;
};

const emptyFilters: FilterState = {
  from: "",
  to: "",
  entityType: "",
  action: "",
};

export function AuditPage({
  backend,
  displayTimeZone = backend.initialSettings.displayTimeZone,
}: {
  backend: FrontendAdapter;
  displayTimeZone?: string;
}) {
  const styles = useStyles();
  const [filters, setFilters] = useState<FilterState>(emptyFilters);
  const [page, setPage] = useState<AuditPageResult | null>(null);
  const [cursorHistory, setCursorHistory] = useState<string[]>([""]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadPage = useCallback(
    async (cursor: string, activeFilters: FilterState) => {
      setLoading(true);
      setError("");
      const input: AuditFilterInput = {
        cursor,
        limit: 50,
        from: toUTC(activeFilters.from),
        to: toUTC(activeFilters.to),
        entityType: activeFilters.entityType.trim(),
        action: activeFilters.action.trim(),
      };
      try {
        setPage(await backend.getAudits(input));
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

  const applyFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCursorHistory([""]);
    void loadPage("", filters);
  };

  const clearFilters = () => {
    setFilters(emptyFilters);
    setCursorHistory([""]);
    void loadPage("", emptyFilters);
  };

  const next = () => {
    if (!page?.hasMore || !page.nextCursor) return;
    setCursorHistory((current) => [...current, page.nextCursor]);
    void loadPage(page.nextCursor, filters);
  };

  const previous = () => {
    if (cursorHistory.length <= 1) return;
    const nextHistory = cursorHistory.slice(0, -1);
    setCursorHistory(nextHistory);
    void loadPage(nextHistory[nextHistory.length - 1], filters);
  };

  const items = page?.items ?? [];
  return (
    <div className={styles.page}>
      <div>
        <Subtitle1 as="h1">監査記録</Subtitle1>
        <Body1>
          設定変更、破壊的操作、復元の記録を読み取り専用で確認できます。
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
        <Field label="対象種別">
          <Input
            placeholder="例: hub_credential"
            value={filters.entityType}
            onChange={(_, data) =>
              setFilters((current) => ({ ...current, entityType: data.value }))
            }
          />
        </Field>
        <Field label="操作種別">
          <Input
            placeholder="例: credential_saved"
            value={filters.action}
            onChange={(_, data) =>
              setFilters((current) => ({ ...current, action: data.value }))
            }
          />
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
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            {error}
            <Button
              appearance="transparent"
              onClick={() =>
                void loadPage(cursorHistory[cursorHistory.length - 1], filters)
              }
            >
              再試行
            </Button>
          </MessageBarBody>
        </MessageBar>
      )}
      {loading ? (
        <Spinner label="監査記録を読み込み中" />
      ) : items.length === 0 ? (
        <Body1>
          {hasFilters(filters)
            ? "条件に一致する監査記録はありません。"
            : "監査記録はまだありません。"}
        </Body1>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className={styles.meta}>監査記録（新しい順）</caption>
            <thead>
              <tr>
                <th className={styles.header} scope="col">
                  日時
                </th>
                <th className={styles.header} scope="col">
                  操作者
                </th>
                <th className={styles.header} scope="col">
                  操作
                </th>
                <th className={styles.header} scope="col">
                  対象
                </th>
                <th className={styles.header} scope="col">
                  変更前
                </th>
                <th className={styles.header} scope="col">
                  変更後
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <AuditRow
                  key={item.auditId}
                  item={item}
                  styles={styles}
                  displayTimeZone={displayTimeZone}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!loading && (items.length > 0 || cursorHistory.length > 1) && (
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

function AuditRow({
  item,
  styles,
  displayTimeZone,
}: {
  item: AuditRecord;
  styles: ReturnType<typeof useStyles>;
  displayTimeZone: string;
}) {
  return (
    <tr>
      <td className={styles.cell}>
        <time dateTime={item.occurredAt} title={item.occurredAt}>
          {formatTime(item.occurredAt, displayTimeZone)}
        </time>
        <div className={styles.meta}>UTC: {item.occurredAt}</div>
      </td>
      <td className={styles.cell}>{item.actor}</td>
      <td className={styles.cell}>{item.action}</td>
      <td className={styles.cell}>
        <div>{item.entityType}</div>
        <div className={styles.meta}>{item.entityId}</div>
      </td>
      <td className={styles.cell}>
        <pre className={styles.json}>{formatJSON(item.beforeJson)}</pre>
      </td>
      <td className={styles.cell}>
        <pre className={styles.json}>{formatJSON(item.afterJson)}</pre>
      </td>
    </tr>
  );
}

function formatJSON(value: string): string {
  if (!value) return "—";
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return '{"_redacted":"invalid JSON"}';
  }
}

function formatTime(value: string, displayTimeZone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "日時不明";
  const timeZone = displayTimeZone;
  const formatter = new Intl.DateTimeFormat("ja-JP", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const currentYear = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
  }).format(new Date());
  const prefix = parts.year === currentYear ? "" : `${parts.year}/`;
  return `${prefix}${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
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
    filters.entityType.trim() ||
    filters.action.trim(),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "監査記録を読み込めませんでした。";
}
