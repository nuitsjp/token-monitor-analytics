import {
  Body1,
  Button,
  Checkbox,
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
import type {
  CreateHubInput,
  HubSnapshot,
  UpdateHubInput,
} from "../../../bindings/token-monitor-analytics/internal/desktop/models.js";
import type { FrontendAdapter } from "../../lib/backend";
import { presentStatus } from "../../lib/status";

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
  collectionEnabled: boolean;
  secret: string;
};
export function HubsPage({
  backend,
  onDirtyChange,
}: {
  backend: FrontendAdapter;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const styles = useStyles();
  const [hubs, setHubs] = useState<HubSnapshot[]>([]);
  const [editing, setEditing] = useState<HubSnapshot | null | undefined>(
    undefined,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
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
      collectionEnabled: true,
      secret: "",
    },
  });
  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setHubs(await backend.getHubs());
      setError("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [backend]);
  useEffect(() => {
    void backend
      .getHubs()
      .then((value) => {
        setHubs(value);
        setError("");
      })
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setLoading(false));
  }, [backend]);
  const beginCreate = () => {
    setEditing(null);
    reset({
      displayName: "",
      url: "",
      collectionIntervalSeconds: 300,
      collectionEnabled: true,
      secret: "",
    });
  };
  const beginEdit = (hub: HubSnapshot) => {
    setEditing(hub);
    reset({
      displayName: hub.displayName,
      url: hub.url,
      collectionIntervalSeconds: hub.collectionIntervalSeconds,
      collectionEnabled: hub.collectionEnabled,
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
        if (values.collectionEnabled !== editing.collectionEnabled)
          saved = await backend.setHubCollectionEnabled(
            saved.id,
            values.collectionEnabled,
          );
        if (values.secret)
          saved = await backend.saveCredential(saved.id, values.secret);
      } else {
        const input: CreateHubInput = { ...values, secret: values.secret };
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
      const saved = await backend.setHubCollectionEnabled(hub.id, false);
      setHubs((current) =>
        current.map((item) => (item.id === saved.id ? saved : item)),
      );
    } catch (err) {
      setError(errorMessage(err));
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
      {editing !== undefined && (
        <form
          className={styles.form}
          onSubmit={(event) => void handleSubmit(submit)(event)}
          noValidate
        >
          <Subtitle1 as="h2">{editing ? "Hub を編集" : "Hub を登録"}</Subtitle1>
          <Field label="表示名" validationMessage={errors.displayName?.message}>
            <Input
              autoFocus
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
          <Checkbox label="有効" {...register("collectionEnabled")} />
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
          {hubs.map((hub) => (
            <article className={styles.row} key={hub.id}>
              <Subtitle1 as="h2">{hub.displayName}</Subtitle1>
              <div className={styles.meta}>識別子: {hub.id}</div>
              <div>{hub.url}</div>
              <div>
                状態: {hub.collectionEnabled ? "有効" : "無効"} / 資格情報:{" "}
                {presentStatus(hub.credentialState).label} / 接続:{" "}
                {presentStatus(hub.connectionState).label}
              </div>
              {hub.connectionFailureNote && (
                <div className={styles.meta}>{hub.connectionFailureNote}</div>
              )}
              <div className={styles.actions}>
                <Button onClick={() => beginEdit(hub)}>編集</Button>
                <Button
                  onClick={() => void checkConnection(hub)}
                  disabled={!hub.collectionEnabled || !hub.credentialReady}
                >
                  接続確認
                </Button>
                {hub.collectionEnabled ? (
                  <Button onClick={() => void disable(hub)}>無効化</Button>
                ) : (
                  <Button
                    onClick={() =>
                      void backend
                        .setHubCollectionEnabled(hub.id, true)
                        .then((saved) =>
                          setHubs((current) =>
                            current.map((item) =>
                              item.id === saved.id ? saved : item,
                            ),
                          ),
                        )
                        .catch((err) => setError(errorMessage(err)))
                    }
                  >
                    再有効化
                  </Button>
                )}
                <Button
                  onClick={() => void deleteSecret(hub)}
                  disabled={hub.credentialState === "unregistered"}
                >
                  共有秘密を削除
                </Button>
              </div>
            </article>
          ))}
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
