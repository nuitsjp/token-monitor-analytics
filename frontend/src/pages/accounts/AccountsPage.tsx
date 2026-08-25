import {
  Body1,
  Button,
  Checkbox,
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
  AccountSnapshot,
  CreateLogicalAccountFromCandidateInput,
  CreateLogicalAccountInput,
  CreatePlanHistoryInput,
  FrontendAdapter,
  HubSnapshot,
  LogicalAccountSnapshot,
  PlanVersionSnapshot,
  ServiceSnapshot,
  SplitLogicalAccountInput,
  UpdateLogicalAccountInput,
  UpdatePlanHistoryInput,
} from "../../lib/backend";

const useStyles = makeStyles({
  page: { display: "grid", gap: tokens.spacingVerticalL, maxWidth: "96rem" },
  intro: { display: "grid", gap: tokens.spacingVerticalXS },
  tabs: { overflowX: "auto" },
  content: { display: "grid", gap: tokens.spacingVerticalL },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 22rem), 1fr))",
    gap: tokens.spacingVerticalM,
  },
  card: {
    display: "grid",
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalL,
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: tokens.shadow4,
    minWidth: 0,
  },
  form: {
    display: "grid",
    gap: tokens.spacingVerticalM,
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
  meta: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    overflowWrap: "anywhere",
  },
  detail: {
    display: "grid",
    gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalS,
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusSmall,
  },
  list: { display: "grid", gap: tokens.spacingVerticalM },
  sectionTitle: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalM,
    flexWrap: "wrap",
  },
  inline: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "end",
    gap: tokens.spacingHorizontalS,
  },
});

type AccountTab = "logical" | "hub" | "history";
type DirtyForm = "logical" | "split" | "merge" | "candidate" | "history";
type AccountsData = {
  accounts: NonNullable<AccountSnapshot["logicalAccounts"]>;
  candidates: NonNullable<AccountSnapshot["hubAccountCandidates"]>;
  histories: NonNullable<AccountSnapshot["planHistories"]>;
  hubs: HubSnapshot[];
  services: ServiceSnapshot[];
  versions: PlanVersionSnapshot[];
};

const emptyData: AccountsData = {
  accounts: [],
  candidates: [],
  histories: [],
  hubs: [],
  services: [],
  versions: [],
};

const emptyAccountForm: CreateLogicalAccountInput = {
  serviceId: "",
  displayName: "",
};

const emptyHistoryForm: CreatePlanHistoryInput = {
  logicalAccountId: "",
  planVersionId: "",
  validFrom: "",
  validTo: "",
};

const emptyDirtyForms: Record<DirtyForm, boolean> = {
  logical: false,
  split: false,
  merge: false,
  candidate: false,
  history: false,
};

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "保存に失敗しました。";
}

export function AccountsPage({
  backend,
  onDirtyChange,
  displayTimeZone,
}: {
  backend: FrontendAdapter;
  onDirtyChange: (dirty: boolean) => void;
  displayTimeZone: string;
}) {
  const styles = useStyles();
  const [data, setData] = useState<AccountsData>(emptyData);
  const [tab, setTab] = useState<AccountTab>("logical");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [dirtyForms, setDirtyForms] =
    useState<Record<DirtyForm, boolean>>(emptyDirtyForms);
  const [search, setSearch] = useState("");
  const [candidateState, setCandidateState] = useState("");
  const [logicalForm, setLogicalForm] =
    useState<CreateLogicalAccountInput>(emptyAccountForm);
  const [editingLogicalID, setEditingLogicalID] = useState("");
  const [splitSourceID, setSplitSourceID] = useState("");
  const [splitName, setSplitName] = useState("");
  const [splitCandidateIDs, setSplitCandidateIDs] = useState<string[]>([]);
  const [mergeSourceID, setMergeSourceID] = useState("");
  const [mergeTargetID, setMergeTargetID] = useState("");
  const [candidateActionID, setCandidateActionID] = useState("");
  const [candidateAction, setCandidateAction] = useState<
    "create" | "associate" | ""
  >("");
  const [candidateName, setCandidateName] = useState("");
  const [candidateTargetID, setCandidateTargetID] = useState("");
  const [historyForm, setHistoryForm] =
    useState<CreatePlanHistoryInput>(emptyHistoryForm);
  const [editingHistoryID, setEditingHistoryID] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [accounts, hubs, catalog] = await Promise.all([
        backend.getAccounts(),
        backend.getHubs(),
        backend.getCatalog(),
      ]);
      setData({
        accounts: accounts.logicalAccounts ?? [],
        candidates: accounts.hubAccountCandidates ?? [],
        histories: accounts.planHistories ?? [],
        hubs,
        services: catalog.services ?? [],
        versions: catalog.planVersions ?? [],
      });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [backend]);

  useEffect(() => {
    // The initial read synchronizes this page with the external Wails adapter.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  useEffect(() => {
    onDirtyChange(Object.values(dirtyForms).some(Boolean) && !saving);
  }, [dirtyForms, onDirtyChange, saving]);

  const setFormDirty = useCallback((form: DirtyForm, value: boolean) => {
    setDirtyForms((current) =>
      current[form] === value ? current : { ...current, [form]: value },
    );
  }, []);

  const runSave = useCallback(
    async (action: () => Promise<void>, message: string): Promise<boolean> => {
      setSaving(true);
      setError("");
      setSuccess("");
      try {
        await action();
        await refresh();
        setSuccess(message);
        return true;
      } catch (cause) {
        setError(errorMessage(cause));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [refresh],
  );

  const serviceName = useCallback(
    (serviceID: string) => {
      const service = data.services.find((item) => item.id === serviceID);
      return service
        ? `${service.provider} / ${service.name}`
        : "サービス未表示";
    },
    [data.services],
  );
  const accountName = useCallback(
    (accountID: string) =>
      data.accounts.find((item) => item.id === accountID)?.displayName ??
      "論理アカウント未表示",
    [data.accounts],
  );
  const hubName = useCallback(
    (hubID: string) =>
      data.hubs.find((item) => item.id === hubID)?.displayName ?? "Hub未表示",
    [data.hubs],
  );
  const versionName = useCallback(
    (versionID: string) =>
      data.versions.find((item) => item.id === versionID)?.name ??
      "プラン版未表示",
    [data.versions],
  );
  const filteredAccounts = useMemo(() => {
    const value = search.trim().toLocaleLowerCase();
    if (!value) return data.accounts;
    return data.accounts.filter(
      (item) =>
        item.displayName.toLocaleLowerCase().includes(value) ||
        serviceName(item.serviceId).toLocaleLowerCase().includes(value),
    );
  }, [data.accounts, search, serviceName]);
  const filteredCandidates = useMemo(() => {
    const value = search.trim().toLocaleLowerCase();
    return data.candidates.filter(
      (item) =>
        (!candidateState || item.state === candidateState) &&
        (!value ||
          [
            item.displayName,
            item.accountKey,
            item.email,
            hubName(item.hubId),
            serviceName(item.serviceId),
          ]
            .join(" ")
            .toLocaleLowerCase()
            .includes(value)),
    );
  }, [candidateState, data.candidates, hubName, search, serviceName]);
  const filteredHistories = useMemo(() => {
    const value = search.trim().toLocaleLowerCase();
    return data.histories.filter(
      (item) =>
        !value ||
        [accountName(item.logicalAccountId), versionName(item.planVersionId)]
          .join(" ")
          .toLocaleLowerCase()
          .includes(value),
    );
  }, [accountName, data.histories, search, versionName]);

  const resetLogicalForm = () => {
    setLogicalForm(emptyAccountForm);
    setEditingLogicalID("");
    setFormDirty("logical", false);
  };
  const resetHistoryForm = () => {
    setHistoryForm(emptyHistoryForm);
    setEditingHistoryID("");
    setFormDirty("history", false);
  };
  const beginSplit = (account: LogicalAccountSnapshot) => {
    setSplitSourceID(account.id);
    setSplitName(`${account.displayName}（分割）`);
    setSplitCandidateIDs([]);
    setFormDirty("split", true);
  };
  const beginCandidateAction = (
    candidateID: string,
    action: "create" | "associate",
  ) => {
    const candidate = data.candidates.find((item) => item.id === candidateID);
    if (!candidate) return;
    setCandidateActionID(candidateID);
    setCandidateAction(action);
    setCandidateName(candidate.displayName || candidate.accountKey);
    setCandidateTargetID("");
    setFormDirty("candidate", true);
  };

  return (
    <div
      className={styles.page}
      role="region"
      aria-label="アカウント・関連付け画面"
    >
      <div className={styles.intro}>
        <Subtitle1 as="h1">アカウント・関連付け</Subtitle1>
        <Body1>
          Hubアカウントと論理アカウントを分けて管理し、同じ accountKey
          を別Hub間で自動統合しません。
        </Body1>
        <div className={styles.meta}>
          有効期間は UTC の半開区間 [開始, 終了) です。入力日時は RFC3339Nano の
          UTC 瞬時を使用します。
        </div>
      </div>
      {error ? (
        <MessageBar intent="error">
          <MessageBarBody>
            {error}
            <Button appearance="transparent" onClick={() => void refresh()}>
              再読み込み
            </Button>
          </MessageBarBody>
        </MessageBar>
      ) : null}
      {success ? (
        <MessageBar intent="success">
          <MessageBarBody>{success}</MessageBarBody>
        </MessageBar>
      ) : null}
      {loading ? (
        <Spinner label="アカウント情報を読み込み中" />
      ) : (
        <>
          <div className={styles.inline}>
            <Field label="検索">
              <Input
                value={search}
                onChange={(_, value) => setSearch(value.value)}
                placeholder="表示名、Hub、サービス"
              />
            </Field>
          </div>
          <TabList
            className={styles.tabs}
            selectedValue={tab}
            onTabSelect={(_, value) => setTab(value.value as AccountTab)}
          >
            <Tab value="logical">論理アカウント</Tab>
            <Tab value="hub">Hubアカウント</Tab>
            <Tab value="history">プラン履歴</Tab>
          </TabList>

          <div className={styles.content} hidden={tab !== "logical"}>
            <div className={styles.grid}>
              <form
                className={styles.form}
                onSubmit={(event) => {
                  event.preventDefault();
                  const input = editingLogicalID
                    ? ({
                        ...logicalForm,
                        id: editingLogicalID,
                      } as UpdateLogicalAccountInput)
                    : logicalForm;
                  if (!input.serviceId || !input.displayName.trim()) return;
                  void runSave(
                    () =>
                      editingLogicalID
                        ? backend.updateLogicalAccount(
                            input as UpdateLogicalAccountInput,
                          )
                        : backend
                            .createLogicalAccount(
                              input as CreateLogicalAccountInput,
                            )
                            .then(() => undefined),
                    editingLogicalID
                      ? "論理アカウントを更新しました。"
                      : "論理アカウントを登録しました。",
                  ).then((ok) => {
                    if (ok) resetLogicalForm();
                  });
                }}
              >
                <Subtitle1 as="h2">
                  {editingLogicalID
                    ? "論理アカウントを編集"
                    : "論理アカウントを登録"}
                </Subtitle1>
                <Field label="サービス" required>
                  <Select
                    value={logicalForm.serviceId}
                    onChange={(event) => {
                      setLogicalForm((current) => ({
                        ...current,
                        serviceId: event.target.value,
                      }));
                      setFormDirty("logical", true);
                    }}
                  >
                    <option value="">選択してください</option>
                    {data.services.map((item) => (
                      <option key={item.id} value={item.id}>
                        {serviceName(item.id)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="表示名" required>
                  <Input
                    value={logicalForm.displayName}
                    onChange={(_, value) => {
                      setLogicalForm((current) => ({
                        ...current,
                        displayName: value.value,
                      }));
                      setFormDirty("logical", true);
                    }}
                  />
                </Field>
                <div className={styles.actions}>
                  <Button appearance="primary" type="submit" disabled={saving}>
                    保存
                  </Button>
                  <Button type="button" onClick={resetLogicalForm}>
                    クリア
                  </Button>
                </div>
              </form>

              <form
                className={styles.form}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (
                    !splitSourceID ||
                    !splitName.trim() ||
                    splitCandidateIDs.length === 0
                  )
                    return;
                  const source = data.accounts.find(
                    (item) => item.id === splitSourceID,
                  );
                  if (!source) return;
                  const input: SplitLogicalAccountInput = {
                    sourceId: source.id,
                    serviceId: source.serviceId,
                    displayName: splitName,
                    candidateIds: splitCandidateIDs,
                  };
                  void runSave(
                    () =>
                      backend.splitLogicalAccount(input).then(() => undefined),
                    "論理アカウントを分割しました。",
                  ).then((ok) => {
                    if (ok) {
                      setSplitSourceID("");
                      setSplitName("");
                      setSplitCandidateIDs([]);
                      setFormDirty("split", false);
                    }
                  });
                }}
              >
                <Subtitle1 as="h2">論理アカウントを分割</Subtitle1>
                <Field label="分割元">
                  <Select
                    value={splitSourceID}
                    onChange={(event) => {
                      setSplitSourceID(event.target.value);
                      setSplitCandidateIDs([]);
                      setFormDirty("split", true);
                    }}
                  >
                    <option value="">選択してください</option>
                    {data.accounts
                      .filter((item) => !item.archivedAt)
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.displayName}
                        </option>
                      ))}
                  </Select>
                </Field>
                <Field label="新しい表示名" required>
                  <Input
                    value={splitName}
                    onChange={(_, value) => {
                      setSplitName(value.value);
                      setFormDirty("split", true);
                    }}
                  />
                </Field>
                <div className={styles.detail}>
                  <span>移動するHubアカウント（1件以上）</span>
                  {data.candidates.filter(
                    (item) => item.logicalAccountId === splitSourceID,
                  ).length === 0 ? (
                    <span className={styles.meta}>
                      分割元に関連付いた候補はありません。
                    </span>
                  ) : (
                    data.candidates
                      .filter((item) => item.logicalAccountId === splitSourceID)
                      .map((item) => (
                        <Checkbox
                          key={item.id}
                          label={`${item.displayName || item.accountKey}（${hubName(item.hubId)}）`}
                          checked={splitCandidateIDs.includes(item.id)}
                          onChange={(_, value) => {
                            setSplitCandidateIDs((current) =>
                              value.checked
                                ? [...current, item.id]
                                : current.filter((id) => id !== item.id),
                            );
                            setFormDirty("split", true);
                          }}
                        />
                      ))
                  )}
                </div>
                <Button
                  appearance="primary"
                  type="submit"
                  disabled={
                    saving || !splitSourceID || splitCandidateIDs.length === 0
                  }
                >
                  分割を保存
                </Button>
              </form>
            </div>

            <form
              className={styles.form}
              onSubmit={(event) => {
                event.preventDefault();
                if (
                  !mergeSourceID ||
                  !mergeTargetID ||
                  mergeSourceID === mergeTargetID
                )
                  return;
                if (
                  !window.confirm(
                    "選択した論理アカウントを統合しますか？統合元はアーカイブされ、履歴は書き換えません。",
                  )
                )
                  return;
                void runSave(
                  () =>
                    backend.mergeLogicalAccounts(mergeSourceID, mergeTargetID),
                  "論理アカウントを統合しました。",
                ).then((ok) => {
                  if (ok) {
                    setMergeSourceID("");
                    setMergeTargetID("");
                    setFormDirty("merge", false);
                  }
                });
              }}
            >
              <Subtitle1 as="h2">論理アカウントを統合</Subtitle1>
              <div className={styles.inline}>
                <Field label="統合元">
                  <Select
                    value={mergeSourceID}
                    onChange={(event) => {
                      setMergeSourceID(event.target.value);
                      setFormDirty("merge", true);
                    }}
                  >
                    <option value="">選択してください</option>
                    {data.accounts
                      .filter((item) => !item.archivedAt)
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.displayName}
                        </option>
                      ))}
                  </Select>
                </Field>
                <Field label="統合先">
                  <Select
                    value={mergeTargetID}
                    onChange={(event) => {
                      setMergeTargetID(event.target.value);
                      setFormDirty("merge", true);
                    }}
                  >
                    <option value="">選択してください</option>
                    {data.accounts
                      .filter((item) => !item.archivedAt)
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.displayName}
                        </option>
                      ))}
                  </Select>
                </Field>
                <Button
                  appearance="primary"
                  type="submit"
                  disabled={
                    saving ||
                    !mergeSourceID ||
                    !mergeTargetID ||
                    mergeSourceID === mergeTargetID
                  }
                >
                  統合を保存
                </Button>
              </div>
            </form>

            <div className={styles.list} aria-label="論理アカウント一覧">
              {filteredAccounts.length === 0 ? (
                <Body1>論理アカウントはありません。</Body1>
              ) : (
                filteredAccounts.map((item) => (
                  <article className={styles.card} key={item.id}>
                    <div className={styles.sectionTitle}>
                      <Subtitle1 as="h2">{item.displayName}</Subtitle1>
                      <div className={styles.actions}>
                        <Button
                          onClick={() => {
                            setEditingLogicalID(item.id);
                            setLogicalForm({
                              serviceId: item.serviceId,
                              displayName: item.displayName,
                            });
                            setFormDirty("logical", true);
                          }}
                        >
                          編集
                        </Button>
                        {item.archivedAt ? (
                          <Button
                            disabled={saving}
                            onClick={() =>
                              void runSave(
                                () => backend.restoreLogicalAccount(item.id),
                                "論理アカウントをアーカイブ解除しました。",
                              )
                            }
                          >
                            アーカイブ解除
                          </Button>
                        ) : (
                          <Button
                            disabled={saving}
                            onClick={() => {
                              if (
                                window.confirm(
                                  "この論理アカウントをアーカイブしますか？履歴と関連付けは保持されます。",
                                )
                              )
                                void runSave(
                                  () => backend.archiveLogicalAccount(item.id),
                                  "論理アカウントをアーカイブしました。",
                                );
                            }}
                          >
                            アーカイブ
                          </Button>
                        )}
                        <Button onClick={() => beginSplit(item)}>分割</Button>
                      </div>
                    </div>
                    <div>{serviceName(item.serviceId)}</div>
                    <div className={styles.meta}>
                      {item.archivedAt
                        ? `アーカイブ済み（${formatInstantPair(item.archivedAt, displayTimeZone)}）`
                        : "有効"}
                    </div>
                    <div className={styles.meta}>
                      登録: {formatInstantPair(item.createdAt, displayTimeZone)}{" "}
                      / 更新:{" "}
                      {formatInstantPair(item.updatedAt, displayTimeZone)}
                    </div>
                  </article>
                ))
              )}
            </div>
          </div>

          <div className={styles.content} hidden={tab !== "hub"}>
            <div className={styles.inline}>
              <Field label="候補状態">
                <Select
                  value={candidateState}
                  onChange={(event) => setCandidateState(event.target.value)}
                >
                  <option value="">すべて</option>
                  <option value="unconfirmed">未確認</option>
                  <option value="associated">関連付け済み</option>
                  <option value="rejected">対象外</option>
                  <option value="archived_reconfirmation">
                    アーカイブ後再確認
                  </option>
                </Select>
              </Field>
            </div>
            {candidateActionID ? (
              <form
                className={styles.form}
                onSubmit={(event) => {
                  event.preventDefault();
                  const candidate = data.candidates.find(
                    (item) => item.id === candidateActionID,
                  );
                  if (!candidate) return;
                  if (candidateAction === "create") {
                    const input: CreateLogicalAccountFromCandidateInput = {
                      candidateId: candidate.id,
                      serviceId: candidate.serviceId,
                      displayName: candidateName,
                    };
                    if (!input.displayName.trim()) return;
                    void runSave(
                      () =>
                        backend
                          .createLogicalAccountFromCandidate(input)
                          .then(() => undefined),
                      "候補から論理アカウントを作成しました。",
                    ).then((ok) => {
                      if (ok) {
                        setCandidateActionID("");
                        setCandidateAction("");
                        setFormDirty("candidate", false);
                      }
                    });
                  } else if (candidateTargetID) {
                    void runSave(
                      () =>
                        backend.associateHubAccountCandidate(
                          candidate.id,
                          candidateTargetID,
                        ),
                      "Hubアカウントを関連付けました。",
                    ).then((ok) => {
                      if (ok) {
                        setCandidateActionID("");
                        setCandidateAction("");
                        setFormDirty("candidate", false);
                      }
                    });
                  }
                }}
              >
                <Subtitle1 as="h2">
                  {candidateAction === "create"
                    ? "候補から論理アカウントを作成"
                    : "既存の論理アカウントへ関連付け"}
                </Subtitle1>
                <div className={styles.meta}>
                  対象:{" "}
                  {data.candidates.find((item) => item.id === candidateActionID)
                    ?.displayName ||
                    data.candidates.find(
                      (item) => item.id === candidateActionID,
                    )?.accountKey}
                </div>
                {candidateAction === "create" ? (
                  <Field label="表示名" required>
                    <Input
                      value={candidateName}
                      onChange={(_, value) => {
                        setCandidateName(value.value);
                        setFormDirty("candidate", true);
                      }}
                    />
                  </Field>
                ) : (
                  <Field label="論理アカウント" required>
                    <Select
                      value={candidateTargetID}
                      onChange={(event) => {
                        setCandidateTargetID(event.target.value);
                        setFormDirty("candidate", true);
                      }}
                    >
                      <option value="">選択してください</option>
                      {data.accounts
                        .filter(
                          (item) =>
                            item.serviceId ===
                              data.candidates.find(
                                (candidate) =>
                                  candidate.id === candidateActionID,
                              )?.serviceId && !item.archivedAt,
                        )
                        .map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.displayName}
                          </option>
                        ))}
                    </Select>
                  </Field>
                )}
                <div className={styles.actions}>
                  <Button appearance="primary" type="submit" disabled={saving}>
                    保存
                  </Button>
                  <Button
                    type="button"
                    onClick={() => {
                      setCandidateActionID("");
                      setCandidateAction("");
                      setFormDirty("candidate", false);
                    }}
                  >
                    キャンセル
                  </Button>
                </div>
              </form>
            ) : null}
            <div className={styles.list} aria-label="Hubアカウント候補一覧">
              {filteredCandidates.length === 0 ? (
                <Body1>該当するHubアカウント候補はありません。</Body1>
              ) : (
                filteredCandidates.map((item) => (
                  <article className={styles.card} key={item.id}>
                    <div className={styles.sectionTitle}>
                      <Subtitle1 as="h2">
                        {item.displayName || item.accountKey}
                      </Subtitle1>
                      <span>{candidateStateLabel(item.state)}</span>
                    </div>
                    <div>
                      {hubName(item.hubId)} / {serviceName(item.serviceId)}
                    </div>
                    <div className={styles.detail}>
                      <span>accountKey: {item.accountKey}</span>
                      {item.email ? <span>メール: {item.email}</span> : null}
                      {item.workspaceName ? (
                        <span>ワークスペース: {item.workspaceName}</span>
                      ) : null}
                      {item.deviceName ? (
                        <span>端末: {item.deviceName}</span>
                      ) : null}
                      {item.logicalAccountId ? (
                        <span>
                          関連先: {accountName(item.logicalAccountId)}
                        </span>
                      ) : null}
                      <span>
                        観測期間:{" "}
                        {formatInstant(item.firstObservedAt, displayTimeZone)}{" "}
                        ～ {formatInstant(item.lastObservedAt, displayTimeZone)}{" "}
                        / UTC: [{item.firstObservedAt || "不明"},{" "}
                        {item.lastObservedAt || "継続中"})
                      </span>
                    </div>
                    <div className={styles.actions}>
                      {item.state === "unconfirmed" ||
                      item.state === "rejected" ? (
                        <Button
                          onClick={() =>
                            beginCandidateAction(item.id, "create")
                          }
                        >
                          候補から作成
                        </Button>
                      ) : null}
                      {item.state !== "associated" &&
                      item.state !== "archived_reconfirmation" ? (
                        <Button
                          onClick={() =>
                            beginCandidateAction(item.id, "associate")
                          }
                        >
                          既存へ関連
                        </Button>
                      ) : null}
                      {item.state === "unconfirmed" ? (
                        <Button
                          disabled={saving}
                          onClick={() => {
                            if (
                              window.confirm(
                                "このHubアカウント候補を対象外にしますか？自動関連付けは行われません。",
                              )
                            )
                              void runSave(
                                () =>
                                  backend.rejectHubAccountCandidate(item.id),
                                "候補を対象外にしました。",
                              );
                          }}
                        >
                          対象外
                        </Button>
                      ) : null}
                      {item.state === "rejected" ||
                      item.state === "associated" ||
                      item.state === "archived_reconfirmation" ? (
                        <Button
                          disabled={saving}
                          onClick={() => {
                            if (
                              window.confirm(
                                "この候補の判断または関連付けを解除しますか？",
                              )
                            )
                              void runSave(
                                () =>
                                  backend.releaseHubAccountCandidate(item.id),
                                "候補の判断を解除しました。",
                              );
                          }}
                        >
                          解除
                        </Button>
                      ) : null}
                    </div>
                  </article>
                ))
              )}
            </div>
          </div>

          <div className={styles.content} hidden={tab !== "history"}>
            <form
              className={styles.form}
              onSubmit={(event) => {
                event.preventDefault();
                if (
                  !historyForm.logicalAccountId ||
                  !historyForm.planVersionId ||
                  !historyForm.validFrom
                )
                  return;
                const input = editingHistoryID
                  ? ({
                      ...historyForm,
                      id: editingHistoryID,
                    } as UpdatePlanHistoryInput)
                  : historyForm;
                void runSave(
                  () =>
                    editingHistoryID
                      ? backend.updatePlanHistory(
                          input as UpdatePlanHistoryInput,
                        )
                      : backend
                          .createPlanHistory(input as CreatePlanHistoryInput)
                          .then(() => undefined),
                  editingHistoryID
                    ? "プラン履歴を修正しました。"
                    : "プラン履歴を登録しました。",
                ).then((ok) => {
                  if (ok) resetHistoryForm();
                });
              }}
            >
              <Subtitle1 as="h2">
                {editingHistoryID ? "プラン履歴を修正" : "プラン履歴を追加"}
              </Subtitle1>
              <div className={styles.grid}>
                <Field label="論理アカウント" required>
                  <Select
                    value={historyForm.logicalAccountId}
                    onChange={(event) => {
                      setHistoryForm((current) => ({
                        ...current,
                        logicalAccountId: event.target.value,
                      }));
                      setFormDirty("history", true);
                    }}
                  >
                    <option value="">選択してください</option>
                    {data.accounts.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.displayName}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="プラン版" required>
                  <Select
                    value={historyForm.planVersionId}
                    onChange={(event) => {
                      setHistoryForm((current) => ({
                        ...current,
                        planVersionId: event.target.value,
                      }));
                      setFormDirty("history", true);
                    }}
                  >
                    <option value="">選択してください</option>
                    {data.versions.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="開始（UTC / RFC3339Nano）" required>
                  <Input
                    value={historyForm.validFrom}
                    placeholder="2026-08-25T00:00:00Z"
                    onChange={(_, value) => {
                      setHistoryForm((current) => ({
                        ...current,
                        validFrom: value.value,
                      }));
                      setFormDirty("history", true);
                    }}
                  />
                </Field>
                <Field label="終了（UTC / RFC3339Nano、空欄可）">
                  <Input
                    value={historyForm.validTo}
                    placeholder="継続中"
                    onChange={(_, value) => {
                      setHistoryForm((current) => ({
                        ...current,
                        validTo: value.value,
                      }));
                      setFormDirty("history", true);
                    }}
                  />
                </Field>
              </div>
              <div className={styles.meta}>
                半開区間 [開始,
                終了)。終了を空欄にすると継続中です。保存値はUTC瞬時として扱われます。
              </div>
              <div className={styles.actions}>
                <Button appearance="primary" type="submit" disabled={saving}>
                  保存
                </Button>
                <Button type="button" onClick={resetHistoryForm}>
                  クリア
                </Button>
              </div>
            </form>
            <div className={styles.list} aria-label="プラン履歴一覧">
              {filteredHistories.length === 0 ? (
                <Body1>プラン履歴はありません。</Body1>
              ) : (
                filteredHistories.map((item) => (
                  <article className={styles.card} key={item.id}>
                    <div className={styles.sectionTitle}>
                      <Subtitle1 as="h2">
                        {accountName(item.logicalAccountId)}
                      </Subtitle1>
                      <Button
                        onClick={() => {
                          setEditingHistoryID(item.id);
                          setHistoryForm({
                            logicalAccountId: item.logicalAccountId,
                            planVersionId: item.planVersionId,
                            validFrom: item.validFrom,
                            validTo: item.validTo,
                          });
                          setFormDirty("history", true);
                        }}
                      >
                        期間を修正
                      </Button>
                    </div>
                    <div>{versionName(item.planVersionId)}</div>
                    <div className={styles.meta}>
                      有効期間: [
                      {formatInstant(item.validFrom, displayTimeZone)},{" "}
                      {formatInstant(item.validTo, displayTimeZone)}) / UTC: [
                      {item.validFrom}, {item.validTo || "継続中"})
                    </div>
                  </article>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function candidateStateLabel(state: string): string {
  switch (state) {
    case "associated":
      return "関連付け済み";
    case "rejected":
      return "対象外";
    case "archived_reconfirmation":
      return "アーカイブ後再確認";
    default:
      return "未確認";
  }
}

function formatInstant(
  value: string,
  timeZone: string,
  emptyLabel = "不明",
): string {
  if (!value) return emptyLabel;
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

function formatInstantPair(value: string, timeZone: string): string {
  return value ? `${formatInstant(value, timeZone)} / UTC: ${value}` : "不明";
}
