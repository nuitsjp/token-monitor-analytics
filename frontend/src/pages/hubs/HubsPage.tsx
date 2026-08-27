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
import { useCallback, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useSearchParams } from "react-router";
import { StatusBadge } from "../../components/StatusBadge";
import type {
  CollectionAttemptSnapshot,
  CreateHubInput,
  FrontendAdapter,
  HubSnapshot,
  StatusPresentationSnapshot,
  UpdateHubInput,
} from "../../lib/backend";
import { formatOverviewInstant } from "../../lib/overviewDisplay";

const useStyles = makeStyles({
  page: { display: "grid", gap: tokens.spacingVerticalL, maxWidth: "64rem" },
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
  },
  meta: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    overflowWrap: "anywhere",
  },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalS,
  },
  statusList: {
    display: "flex",
    flexWrap: "wrap",
    gap: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalL}`,
  },
  operationalSummary: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(14rem, 1fr))",
    gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalS,
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
  },
  attempt: {
    display: "grid",
    gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingVerticalS,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  form: {
    display: "grid",
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalL,
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: tokens.shadow4,
  },
});

type FormValues = {
  displayName: string;
  url: string;
  collectionIntervalSeconds: number;
  secret: string;
};
export function HubsPage({
  backend,
  onDirtyChange,
  displayTimeZone = backend.initialSettings.displayTimeZone,
}: {
  backend: FrontendAdapter;
  onDirtyChange: (dirty: boolean) => void;
  displayTimeZone?: string;
}) {
  const styles = useStyles();
  const [searchParams] = useSearchParams();
  const targetHubID = searchParams.get("hubId") ?? "";
  const [hubs, setHubs] = useState<HubSnapshot[]>([]);
  const [editing, setEditing] = useState<HubSnapshot | null | undefined>(
    undefined,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [saving, setSaving] = useState(false);
  const [historyHubID, setHistoryHubID] = useState("");
  const [attemptsByHub, setAttemptsByHub] = useState<
    Record<string, CollectionAttemptSnapshot[]>
  >({});
  const {
    register,
    handleSubmit,
    reset,
    formState: { isDirty, errors },
  } = useForm<FormValues>({
    defaultValues: {
      displayName: "",
      url: "",
      collectionIntervalSeconds: 300,
      secret: "",
    },
  });
  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const nextHubs = await backend.getHubs();
      setHubs(nextHubs);
      if (targetHubID && nextHubs.some((hub) => hub.id === targetHubID)) {
        setHistoryHubID(targetHubID);
      }
      const attemptResults = await Promise.allSettled(
        nextHubs.map(
          async (hub) =>
            [hub.id, await backend.getCollectionAttempts(hub.id)] as const,
        ),
      );
      setAttemptsByHub(
        Object.fromEntries(
          attemptResults.flatMap((result) =>
            result.status === "fulfilled" ? [result.value] : [],
          ),
        ),
      );
      const failedHubNames = nextHubs
        .filter((_, index) => attemptResults[index]?.status === "rejected")
        .map((hub) => hub.displayName);
      setHistoryError(
        failedHubNames.length > 0
          ? `${failedHubNames.join("、")} の取得履歴を読み込めませんでした。`
          : "",
      );
      setError("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [backend, targetHubID]);
  useEffect(() => {
    // Exception: Rule=react-hooks/set-state-in-effect; Reason=mount synchronizes adapter-backed state; Scope=next line; Owner=frontend; Expires=2026-12-31.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);
  const beginCreate = () => {
    setEditing(null);
    reset({
      displayName: "",
      url: "",
      collectionIntervalSeconds: 300,
      secret: "",
    });
  };
  const beginEdit = (hub: HubSnapshot) => {
    setEditing(hub);
    reset({
      displayName: hub.displayName,
      url: hub.url,
      collectionIntervalSeconds: hub.collectionIntervalSeconds,
      secret: "",
    });
  };
  const submit = async (values: FormValues) => {
    setSaving(true);
    setError("");
    try {
      let saved: HubSnapshot;
      if (editing) {
        const input: UpdateHubInput = {
          id: editing.id,
          displayName: values.displayName,
          url: values.url,
          collectionIntervalSeconds: values.collectionIntervalSeconds,
        };
        saved = await backend.updateHub(input);
        if (values.secret)
          saved = await backend.saveCredential(saved.id, values.secret);
      } else {
        const input: CreateHubInput = {
          ...values,
          collectionEnabled: false,
          secret: values.secret,
        };
        saved = await backend.createHub(input);
      }
      setHubs((current) =>
        editing
          ? current.map((hub) => (hub.id === saved.id ? saved : hub))
          : [...current, saved],
      );
      setEditing(undefined);
      reset({ ...values, secret: "" });
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  const disable = async (hub: HubSnapshot) => {
    if (
      !window.confirm("この Hub を無効にしますか？保存済みの履歴は残ります。")
    )
      return;
    try {
      if (hub.collectionEnabled) await backend.stopCollection(hub.id);
      const saved = await backend.setHubEnabled(hub.id, false);
      setHubs((current) =>
        current.map((item) => (item.id === saved.id ? saved : item)),
      );
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const enable = async (hub: HubSnapshot) => {
    try {
      const saved = await backend.setHubEnabled(hub.id, true);
      setHubs((current) =>
        current.map((item) => (item.id === saved.id ? saved : item)),
      );
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const changeCollection = async (hub: HubSnapshot, enabled: boolean) => {
    try {
      if (enabled) await backend.startCollection(hub.id);
      else await backend.stopCollection(hub.id);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const collectNow = async (hub: HubSnapshot) => {
    try {
      await backend.collectNow(hub.id);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const showHistory = async (hub: HubSnapshot) => {
    try {
      setHistoryHubID(hub.id);
      const attempts = await backend.getCollectionAttempts(hub.id);
      setAttemptsByHub((current) => ({ ...current, [hub.id]: attempts }));
      setHistoryError("");
    } catch (err) {
      setHistoryError(errorMessage(err));
    }
  };
  const deleteSecret = async (hub: HubSnapshot) => {
    if (!window.confirm("この Hub の共有秘密を削除しますか？")) return;
    try {
      const saved = await backend.deleteCredential(hub.id);
      setHubs((current) =>
        current.map((item) => (item.id === saved.id ? saved : item)),
      );
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const checkConnection = async (hub: HubSnapshot) => {
    try {
      const saved = await backend.checkHubConnection(hub.id);
      setHubs((current) =>
        current.map((item) => (item.id === saved.id ? saved : item)),
      );
      setError("");
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <div className={styles.page}>
      <div className={styles.actions}>
        <div>
          <Subtitle1 as="h1">Hub・収集</Subtitle1>
          <Body1>Hub と共有秘密を管理します。</Body1>
        </div>
        <Button appearance="primary" onClick={beginCreate}>
          Hub を登録
        </Button>
      </div>
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}
      {historyError && (
        <MessageBar intent="warning">
          <MessageBarBody>
            {historyError}{" "}
            <Button appearance="transparent" onClick={() => void refresh()}>
              再試行
            </Button>
          </MessageBarBody>
        </MessageBar>
      )}
      {editing !== undefined && (
        <form
          className={styles.form}
          onSubmit={(event) => void handleSubmit(submit)(event)}
          noValidate
        >
          <Subtitle1 as="h2">{editing ? "Hub を編集" : "Hub を登録"}</Subtitle1>
          <Field label="表示名" validationMessage={errors.displayName?.message}>
            <Input
              {...register("displayName", {
                required: "表示名を入力してください",
              })}
            />
          </Field>
          <Field label="URL" validationMessage={errors.url?.message}>
            <Input
              type="url"
              {...register("url", { required: "URLを入力してください" })}
            />
          </Field>
          <Field
            label="収集間隔（秒）"
            validationMessage={errors.collectionIntervalSeconds?.message}
          >
            <Input
              type="number"
              min={1}
              {...register("collectionIntervalSeconds", {
                valueAsNumber: true,
                min: { value: 1, message: "正の値を入力してください" },
              })}
            />
          </Field>
          <Field
            label="共有秘密（保存済みは再表示しません）"
            hint="更新する場合だけ入力してください"
          >
            <Input
              type="password"
              autoComplete="new-password"
              {...register("secret")}
            />
          </Field>
          <div className={styles.actions}>
            <Button appearance="primary" type="submit" disabled={saving}>
              {saving ? <Spinner size="tiny" /> : "保存"}
            </Button>
            <Button
              type="button"
              onClick={() => {
                setEditing(undefined);
                reset();
              }}
            >
              キャンセル
            </Button>
          </div>
        </form>
      )}
      {loading ? (
        <Spinner label="Hub を読み込み中" />
      ) : hubs.length === 0 ? (
        <Body1>Hub はまだ登録されていません。</Body1>
      ) : (
        <div className={styles.list} aria-label="Hub 一覧">
          {hubs.map((hub) => {
            const hubAttempts = attemptsByHub[hub.id] ?? [];
            const latestSuccess = latestAttempt(hubAttempts, "succeeded");
            const latestFailure = latestAttempt(hubAttempts, "failed");
            return (
              <article
                className={`${styles.row} ${hub.id === targetHubID ? styles.targetRow : ""}`}
                key={hub.id}
                data-testid={hub.id === targetHubID ? "target-hub" : undefined}
              >
                <Subtitle1 as="h2">{hub.displayName}</Subtitle1>
                <div className={styles.meta}>識別子: {hub.id}</div>
                <div>{hub.url}</div>
                <div className={styles.statusList}>
                  <span aria-label={`Hub: ${hub.enabled ? "有効" : "無効"}`}>
                    Hub: <StatusBadge status={hubEnabledStatus(hub.enabled)} />
                  </span>
                  <span>
                    定期収集:{" "}
                    <StatusBadge
                      status={collectionEnabledStatus(hub.collectionEnabled)}
                    />
                  </span>
                  <span>
                    資格情報:{" "}
                    <StatusBadge
                      status={hubCredentialStatus(hub.credentialState)}
                    />
                  </span>
                  <span>
                    接続:{" "}
                    <StatusBadge
                      status={hubConnectionStatus(hub.connectionState)}
                    />
                  </span>
                </div>
                {hub.connectionFailureNote && (
                  <div className={styles.meta}>{hub.connectionFailureNote}</div>
                )}
                <div className={styles.operationalSummary}>
                  <div>
                    収集間隔: {formatInterval(hub.collectionIntervalSeconds)}
                  </div>
                  <div>
                    次回予定:{" "}
                    {nextCollectionLabel(hub, hubAttempts, displayTimeZone)}
                  </div>
                  <div>
                    最終成功:{" "}
                    {formatAttemptTime(latestSuccess, displayTimeZone)}
                  </div>
                  <div>
                    最終失敗:{" "}
                    {formatAttemptTime(latestFailure, displayTimeZone)}
                  </div>
                  <div>対応 API 契約: {apiContractLabel(hub.apiContract)}</div>
                  <div>収集能力: {apiCapabilityLabel(hub.apiContract)}</div>
                  {latestFailure ? (
                    <div>
                      最終失敗理由: {failureLabel(latestFailure.failureCode)}
                      {latestFailure.failureDetail
                        ? `（${latestFailure.failureDetail}）`
                        : ""}
                    </div>
                  ) : null}
                </div>
                <div className={styles.actions}>
                  <Button onClick={() => beginEdit(hub)}>編集</Button>
                  <Button
                    onClick={() => void checkConnection(hub)}
                    disabled={!hub.enabled || !hub.credentialReady}
                  >
                    接続確認
                  </Button>
                  {hub.enabled ? (
                    <Button onClick={() => void disable(hub)}>無効化</Button>
                  ) : (
                    <Button onClick={() => void enable(hub)}>再有効化</Button>
                  )}
                  {hub.collectionEnabled ? (
                    <Button
                      disabled={!hub.enabled}
                      onClick={() => void changeCollection(hub, false)}
                    >
                      定期収集を停止
                    </Button>
                  ) : (
                    <Button
                      disabled={!hub.enabled || !hub.credentialReady}
                      onClick={() => void changeCollection(hub, true)}
                    >
                      定期収集を開始
                    </Button>
                  )}
                  <Button
                    disabled={!hub.enabled || !hub.credentialReady}
                    onClick={() => void collectNow(hub)}
                  >
                    今すぐ取得
                  </Button>
                  <Button onClick={() => void showHistory(hub)}>
                    取得履歴
                  </Button>
                  <Button
                    onClick={() => void deleteSecret(hub)}
                    disabled={hub.credentialState === "unregistered"}
                  >
                    共有秘密を削除
                  </Button>
                </div>
                {historyHubID === hub.id && (
                  <div className={styles.list} aria-label="取得履歴">
                    {hubAttempts.length === 0 ? (
                      <Body1>取得履歴はありません。</Body1>
                    ) : (
                      hubAttempts.map((attempt) => (
                        <div className={styles.attempt} key={attempt.attemptId}>
                          <div>
                            {triggerLabel(attempt.trigger)} /{" "}
                            <StatusBadge
                              status={attemptStatus(attempt.state)}
                            />
                          </div>
                          <div className={styles.meta}>
                            開始:{" "}
                            {formatInstant(attempt.startedAt, displayTimeZone)}
                            {attempt.completedAt
                              ? ` / 完了: ${formatInstant(attempt.completedAt, displayTimeZone)}`
                              : " / 実行中"}
                          </div>
                          <div className={styles.meta}>
                            接続確認 HTTP: {attempt.healthHttpStatus ?? "—"} /
                            統計 HTTP: {attempt.statsHttpStatus ?? "—"}
                          </div>
                          <div className={styles.meta}>
                            API 契約: {apiContractLabel(attempt.apiContract)}
                          </div>
                          {attempt.failureCode ? (
                            <div>
                              {failureLabel(attempt.failureCode)}
                              {attempt.failureDetail
                                ? `（${attempt.failureDetail}）`
                                : ""}
                            </div>
                          ) : null}
                          {attempt.normalizationErrorPath ? (
                            <div>
                              正規化エラー箇所: {attempt.normalizationErrorPath}
                            </div>
                          ) : null}
                        </div>
                      ))
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "操作に失敗しました。入力内容を確認してください。";
}

function hubEnabledStatus(enabled: boolean): StatusPresentationSnapshot {
  return hubStatusSnapshot(
    enabled ? "enabled" : "disabled",
    enabled ? "有効" : "無効",
    enabled ? "success" : "subtle",
    enabled ? "checkmark" : "info",
    enabled ? "Hubを利用できます。" : "Hubは無効です。",
  );
}

function collectionEnabledStatus(enabled: boolean): StatusPresentationSnapshot {
  return hubStatusSnapshot(
    enabled ? "running" : "stopped",
    enabled ? "実行中" : "停止",
    enabled ? "success" : "subtle",
    enabled ? "sync" : "info",
    enabled ? "定期収集を実行しています。" : "定期収集は停止しています。",
  );
}

function hubCredentialStatus(state: string): StatusPresentationSnapshot {
  const statuses: Record<
    string,
    [
      string,
      StatusPresentationSnapshot["intent"],
      StatusPresentationSnapshot["icon"],
    ]
  > = {
    registered: ["登録済み", "success", "checkmark"],
    unregistered: ["未登録", "warning", "warning"],
    post_restore_pending: ["復元後再登録待ち", "warning", "warning"],
  };
  const [label, intent, icon] = statuses[state] ?? [
    "状態を確認",
    "warning",
    "warning",
  ];
  return hubStatusSnapshot(state, label, intent, icon, "資格情報の状態です。");
}

function hubConnectionStatus(state: string): StatusPresentationSnapshot {
  const statuses: Record<
    string,
    [
      string,
      StatusPresentationSnapshot["intent"],
      StatusPresentationSnapshot["icon"],
    ]
  > = {
    not_checked: ["未確認", "informative", "info"],
    connected: ["接続済み", "success", "checkmark"],
    unreachable: ["到達不能", "danger", "error"],
    timeout: ["タイムアウト", "danger", "error"],
    tls_error: ["TLSエラー", "danger", "error"],
    authentication_failed: ["認証失敗", "danger", "error"],
    unsupported_contract: ["未対応API契約", "warning", "warning"],
    invalid_json: ["不正な応答", "danger", "error"],
  };
  const [label, intent, icon] = statuses[state] ?? [
    "状態を確認",
    "warning",
    "warning",
  ];
  return hubStatusSnapshot(state, label, intent, icon, "接続状態です。");
}

function attemptStatus(state: string): StatusPresentationSnapshot {
  const statuses: Record<
    string,
    [
      string,
      StatusPresentationSnapshot["intent"],
      StatusPresentationSnapshot["icon"],
    ]
  > = {
    succeeded: ["成功", "success", "checkmark"],
    failed: ["失敗", "danger", "error"],
    running: ["実行中", "informative", "sync"],
    skipped: ["スキップ", "subtle", "info"],
  };
  const [label, intent, icon] = statuses[state] ?? [
    "状態を確認",
    "warning",
    "warning",
  ];
  return hubStatusSnapshot(state, label, intent, icon, "収集履歴の状態です。");
}

function triggerLabel(trigger: string): string {
  return (
    (
      { scheduled: "定期", manual: "手動", startup: "起動時" } as Record<
        string,
        string
      >
    )[trigger] ?? "収集"
  );
}

function latestAttempt(
  attempts: CollectionAttemptSnapshot[],
  state: string,
): CollectionAttemptSnapshot | undefined {
  return attempts
    .filter((attempt) => attempt.state === state)
    .sort(
      (left, right) =>
        attemptTime(right).getTime() - attemptTime(left).getTime(),
    )[0];
}

function attemptTime(attempt: CollectionAttemptSnapshot): Date {
  return new Date(attempt.completedAt || attempt.startedAt);
}

function formatAttemptTime(
  attempt: CollectionAttemptSnapshot | undefined,
  timeZone: string,
): string {
  return attempt
    ? formatInstant(attempt.completedAt || attempt.startedAt, timeZone)
    : "なし";
}

function formatInterval(seconds: number): string {
  if (seconds > 0 && seconds % 60 === 0) return `${seconds / 60}分`;
  return `${seconds}秒`;
}

function nextCollectionLabel(
  hub: HubSnapshot,
  attempts: CollectionAttemptSnapshot[],
  timeZone: string,
): string {
  if (!hub.enabled) return "Hub 無効";
  if (!hub.collectionEnabled) return "定期収集停止中";
  const latest = [...attempts].sort(
    (left, right) => attemptTime(right).getTime() - attemptTime(left).getTime(),
  )[0];
  if (!latest) return "初回取得待ち";
  const next = new Date(
    attemptTime(latest).getTime() + hub.collectionIntervalSeconds * 1000,
  );
  return `${formatInstant(next.toISOString(), timeZone)}（登録間隔から算出）`;
}

function apiContractLabel(contract: string): string {
  if (!contract) return "未確認";
  const values = contractValues(contract);
  const schema = values.schema ? `スキーマ ${values.schema}` : "スキーマ不明";
  const runtime = values.runtime ? `実装 ${values.runtime}` : "実装不明";
  return `${schema} / ${runtime}`;
}

function apiCapabilityLabel(contract: string): string {
  if (!contract) return "接続確認後に表示";
  const usageUpdatedAt = contractValues(contract).usageUpdatedAt;
  return usageUpdatedAt === "true"
    ? "利用枠・利用額・利用額観測時刻に対応"
    : usageUpdatedAt === "false"
      ? "利用枠・利用額に対応（利用額観測時刻は非対応）"
      : "利用枠・利用額に対応（利用額観測時刻は未確認）";
}

function contractValues(contract: string): Record<string, string> {
  return Object.fromEntries(
    contract.split(";").flatMap((part) => {
      const separator = part.indexOf("=");
      return separator > 0
        ? [[part.slice(0, separator).trim(), part.slice(separator + 1).trim()]]
        : [];
    }),
  );
}

function failureLabel(code: string): string {
  return (
    (
      {
        authentication_failed: "認証に失敗",
        timeout: "応答待ち時間超過",
        tls_error: "TLS接続エラー",
        invalid_json: "応答形式エラー",
        unsupported_contract: "API契約未対応",
        stats_http_error: "統計 API の取得失敗",
        health_http_error: "接続確認 API の取得失敗",
      } as Record<string, string>
    )[code] ?? "失敗理由あり"
  );
}

function hubStatusSnapshot(
  code: string,
  label: string,
  intent: StatusPresentationSnapshot["intent"],
  icon: StatusPresentationSnapshot["icon"],
  description: string,
): StatusPresentationSnapshot {
  return {
    code,
    label,
    intent,
    icon,
    description,
    nextAction: "",
    nextRoute: "",
  };
}

function formatInstant(
  value: string,
  timeZone: string,
  emptyLabel = "不明",
): string {
  if (!value) return emptyLabel;
  try {
    return formatOverviewInstant(value, timeZone);
  } catch {
    return "日時不明";
  }
}
