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
import { useSearchParams } from "react-router";
import type { StatusPresentationSnapshot } from "../../../bindings/token-monitor-analytics/internal/desktop/models.js";
import { StatusBadge } from "../../components/StatusBadge";
import { formatOverviewInstant } from "../../lib/overviewDisplay";
import type {
  AccountSnapshot,
  CatalogSnapshot,
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
  HubSwitchInput,
  ImpactPreviewSnapshot,
  LinkingSnapshot,
  UsageCostAssociationInput,
  UsageCostSourceCompletenessInput,
  UsageLimitAssociationInput,
} from "../../lib/backend";
import { cycleTypeLabel } from "../../lib/displayLabels";

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
  targetCard: {
    outline: `2px solid ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorBrandBackground2,
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

type AccountTab =
  | "logical"
  | "hub"
  | "history"
  | "usage-cost"
  | "usage-limit"
  | "completeness"
  | "switch";
type DirtyForm = "logical" | "split" | "merge" | "candidate" | "history";
type AccountsData = {
  accounts: NonNullable<AccountSnapshot["logicalAccounts"]>;
  candidates: NonNullable<AccountSnapshot["hubAccountCandidates"]>;
  histories: NonNullable<AccountSnapshot["planHistories"]>;
  hubs: HubSnapshot[];
  services: ServiceSnapshot[];
  versions: PlanVersionSnapshot[];
  linking: LinkingSnapshot;
  catalog: CatalogSnapshot;
};

const emptyData: AccountsData = {
  accounts: [],
  candidates: [],
  histories: [],
  hubs: [],
  services: [],
  versions: [],
  linking: {
    usageCostSources: [],
    usageLimitSources: [],
    usageCostAssociations: [],
    usageLimitAssociations: [],
    usageCostSourceCompleteness: [],
    hubSwitches: [],
  },
  catalog: {
    services: [],
    serviceIdentifierMappings: [],
    limitDefinitions: [],
    plans: [],
    planVersions: [],
    planLimitRules: [],
    standardPrices: [],
    identificationCandidates: [],
    labelChangeCandidates: [],
  },
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
  const [searchParams] = useSearchParams();
  const targetAccountID = searchParams.get("accountId") ?? "";
  const [data, setData] = useState<AccountsData>(emptyData);
  const [tab, setTab] = useState<AccountTab>("logical");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [linkingDirty, setLinkingDirty] = useState(false);
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
      const [accounts, hubs, catalog, linking] = await Promise.all([
        backend.getAccounts(),
        backend.getHubs(),
        backend.getCatalog(),
        backend.getLinkingSnapshot(),
      ]);
      setData({
        accounts: accounts.logicalAccounts ?? [],
        candidates: accounts.hubAccountCandidates ?? [],
        histories: accounts.planHistories ?? [],
        hubs,
        services: catalog.services ?? [],
        versions: catalog.planVersions ?? [],
        linking,
        catalog,
      });
      const targetAccount = (accounts.logicalAccounts ?? []).find(
        (item) => item.id === targetAccountID,
      );
      if (targetAccount) {
        setTab("logical");
        setSearch(targetAccount.displayName);
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [backend, targetAccountID]);

  useEffect(() => {
    // The initial read synchronizes this page with the external Wails adapter.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  useEffect(() => {
    onDirtyChange(
      (Object.values(dirtyForms).some(Boolean) || linkingDirty) && !saving,
    );
  }, [dirtyForms, linkingDirty, onDirtyChange, saving]);

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
          有効期間は UTC の半開区間 [開始, 終了) です。日時は UTC
          として入力します。
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
            <Tab value="usage-cost">利用額関連付け</Tab>
            <Tab value="usage-limit">利用枠関連付け</Tab>
            <Tab value="completeness">活動主体の完全性</Tab>
            <Tab value="switch">収集端末・Hub切替</Tab>
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
                  <article
                    className={`${styles.card} ${item.id === targetAccountID ? styles.targetCard : ""}`}
                    key={item.id}
                    data-testid={
                      item.id === targetAccountID ? "target-account" : undefined
                    }
                  >
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
                      <StatusBadge
                        status={logicalAccountStatus(
                          item.archivedAt ? "archived" : "active",
                        )}
                      />
                      {item.archivedAt ? (
                        <>
                          （
                          {formatInstantPair(item.archivedAt, displayTimeZone)}
                          ）
                        </>
                      ) : null}
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
                      <StatusBadge
                        status={accountCandidateStatus(item.state)}
                      />
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
                        ～{" "}
                        {formatInstant(
                          item.lastObservedAt,
                          displayTimeZone,
                          "継続中",
                        )}
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
                <Field label="開始日時（UTC）" required>
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
                <Field label="終了日時（UTC・空欄可）">
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
                      {formatInstant(item.validTo, displayTimeZone, "継続中")})
                    </div>
                  </article>
                ))
              )}
            </div>
          </div>
          <LinkingTabs
            backend={backend}
            linking={data.linking}
            accounts={data.accounts}
            hubs={data.hubs}
            catalog={data.catalog}
            selectedTab={tab}
            displayTimeZone={displayTimeZone}
            onDirtyChange={setLinkingDirty}
            onRefresh={refresh}
          />
        </>
      )}
    </div>
  );
}

function accountCandidateStatus(state: string): StatusPresentationSnapshot {
  const statuses: Record<
    string,
    [
      string,
      StatusPresentationSnapshot["intent"],
      StatusPresentationSnapshot["icon"],
    ]
  > = {
    unconfirmed: ["未確認", "warning", "warning"],
    associated: ["関連付け済み", "success", "checkmark"],
    rejected: ["対象外", "subtle", "info"],
    archived_reconfirmation: ["アーカイブ後再確認", "warning", "warning"],
  };
  const [label, intent, icon] = statuses[state] ?? [
    "状態を確認",
    "warning",
    "warning",
  ];
  return accountStatusSnapshot(state, label, intent, icon, "候補の状態です。");
}

function logicalAccountStatus(
  state: "active" | "archived",
): StatusPresentationSnapshot {
  return state === "active"
    ? accountStatusSnapshot(
        state,
        "有効",
        "success",
        "checkmark",
        "利用中の論理アカウントです。",
      )
    : accountStatusSnapshot(
        state,
        "アーカイブ済み",
        "subtle",
        "info",
        "アーカイブされた論理アカウントです。",
      );
}

function completenessStatus(state: string): StatusPresentationSnapshot {
  return state === "confirmed"
    ? accountStatusSnapshot(
        state,
        "確認済み",
        "success",
        "checkmark",
        "完全性が確認されています。",
      )
    : accountStatusSnapshot(
        state,
        "未確認",
        "warning",
        "warning",
        "完全性の確認が必要です。",
      );
}

function accountStatusSnapshot(
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

type LinkingDirtyForm = "cost" | "limit" | "completeness" | "switch";

const emptyLinkingDirtyForms: Record<LinkingDirtyForm, boolean> = {
  cost: false,
  limit: false,
  completeness: false,
  switch: false,
};

const emptyCostAssociation: UsageCostAssociationInput = {
  id: "",
  usageCostSourceId: "",
  logicalAccountId: "",
  validFrom: "",
  validTo: "",
};

const emptyLimitAssociation: UsageLimitAssociationInput = {
  id: "",
  usageLimitSourceId: "",
  logicalAccountId: "",
  limitDefinitionId: "",
  validFrom: "",
  validTo: "",
};

const emptyCompleteness: UsageCostSourceCompletenessInput = {
  id: "",
  usageCostSourceId: "",
  validFrom: "",
  validTo: "",
  state: "unconfirmed",
  logicalAccountIds: [],
  excludedActivity: [],
};

const emptyHubSwitch: HubSwitchInput = {
  id: "",
  oldHubId: "",
  oldDeviceId: "",
  newHubId: "",
  newDeviceId: "",
  collectionDeviceId: "",
  switchedAt: "",
};

function LinkingTabs({
  backend,
  linking,
  accounts,
  hubs,
  catalog,
  selectedTab,
  displayTimeZone,
  onDirtyChange,
  onRefresh,
}: {
  backend: FrontendAdapter;
  linking: LinkingSnapshot;
  accounts: NonNullable<AccountSnapshot["logicalAccounts"]>;
  hubs: HubSnapshot[];
  catalog: CatalogSnapshot;
  selectedTab: AccountTab;
  displayTimeZone: string;
  onDirtyChange: (dirty: boolean) => void;
  onRefresh: () => Promise<void>;
}) {
  const styles = useStyles();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [search, setSearch] = useState("");
  const [dirtyForms, setDirtyForms] = useState(emptyLinkingDirtyForms);
  const [costForm, setCostForm] = useState(emptyCostAssociation);
  const [costPreview, setCostPreview] = useState<ImpactPreviewSnapshot | null>(
    null,
  );
  const [editingCostID, setEditingCostID] = useState("");
  const [limitForm, setLimitForm] = useState(emptyLimitAssociation);
  const [limitPreview, setLimitPreview] =
    useState<ImpactPreviewSnapshot | null>(null);
  const [editingLimitID, setEditingLimitID] = useState("");
  const [completenessForm, setCompletenessForm] = useState(emptyCompleteness);
  const [completenessConfirmed, setCompletenessConfirmed] = useState(false);
  const [completenessPreview, setCompletenessPreview] =
    useState<ImpactPreviewSnapshot | null>(null);
  const [editingCompletenessID, setEditingCompletenessID] = useState("");
  const [switchForm, setSwitchForm] = useState(emptyHubSwitch);
  const [switchPreview, setSwitchPreview] =
    useState<ImpactPreviewSnapshot | null>(null);

  const setFormDirty = useCallback((form: LinkingDirtyForm, dirty: boolean) => {
    setDirtyForms((current) =>
      current[form] === dirty ? current : { ...current, [form]: dirty },
    );
  }, []);
  useEffect(() => {
    onDirtyChange(Object.values(dirtyForms).some(Boolean) && !saving);
  }, [dirtyForms, onDirtyChange, saving]);

  const runSave = useCallback(
    async (action: () => Promise<void>, message: string): Promise<boolean> => {
      setSaving(true);
      setError("");
      setSuccess("");
      try {
        await action();
        await onRefresh();
        setSuccess(message);
        return true;
      } catch (cause) {
        setError(errorMessage(cause));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [onRefresh],
  );

  const serviceName = useCallback(
    (kind: string, rawIdentifier: string) => {
      const mapping = (catalog.serviceIdentifierMappings ?? []).find(
        (item) => item.kind === kind && item.rawIdentifier === rawIdentifier,
      );
      const service = mapping
        ? (catalog.services ?? []).find((item) => item.id === mapping.serviceId)
        : undefined;
      return service
        ? `${service.provider} / ${service.name}`
        : "サービス未対応";
    },
    [catalog.serviceIdentifierMappings, catalog.services],
  );
  const accountName = useCallback(
    (id: string) =>
      accounts.find((item) => item.id === id)?.displayName ??
      "論理アカウント未表示",
    [accounts],
  );
  const hubName = useCallback(
    (id: string) =>
      hubs.find((item) => item.id === id)?.displayName ?? "Hub未表示",
    [hubs],
  );
  const sourceName = useCallback(
    (kind: "usage_cost" | "usage_limit", sourceID: string) => {
      if (kind === "usage_cost") {
        const source = (linking.usageCostSources ?? []).find(
          (item) => item.id === sourceID,
        );
        return source
          ? `${hubName(source.hubId)} / ${source.deviceId} / ${source.rawServiceIdentifier}`
          : "利用額ソース未表示";
      }
      const source = (linking.usageLimitSources ?? []).find(
        (item) => item.id === sourceID,
      );
      return source
        ? `${hubName(source.hubId)} / ${source.deviceId} / ${source.rawServiceIdentifier} / ${source.windowKey}`
        : "利用枠ソース未表示";
    },
    [hubName, linking.usageCostSources, linking.usageLimitSources],
  );
  const query = search.trim().toLocaleLowerCase();
  const matches = useCallback(
    (values: string[]) =>
      !query || values.join(" ").toLocaleLowerCase().includes(query),
    [query],
  );
  const activeAccounts = useMemo(
    () => accounts.filter((item) => !item.archivedAt),
    [accounts],
  );
  const completenessEligibleAccounts = useMemo(() => {
    if (!completenessForm.usageCostSourceId || !completenessForm.validFrom) {
      return [];
    }
    const selectedStart = Date.parse(completenessForm.validFrom);
    if (!Number.isFinite(selectedStart)) return [];
    const selectedEnd = completenessForm.validTo
      ? Date.parse(completenessForm.validTo)
      : Number.POSITIVE_INFINITY;
    if (Number.isNaN(selectedEnd) || selectedStart >= selectedEnd) return [];
    const linkedIDs = new Set(
      (linking.usageCostAssociations ?? [])
        .filter(
          (item) =>
            item.usageCostSourceId === completenessForm.usageCostSourceId &&
            intervalsOverlap(
              item.validFrom,
              item.validTo,
              completenessForm.validFrom,
              completenessForm.validTo,
            ),
        )
        .map((item) => item.logicalAccountId),
    );
    return accounts.filter((item) => linkedIDs.has(item.id));
  }, [
    accounts,
    completenessForm.usageCostSourceId,
    completenessForm.validFrom,
    completenessForm.validTo,
    linking.usageCostAssociations,
  ]);

  const devices = useMemo(() => {
    const result: { hubId: string; deviceId: string }[] = [];
    const seen = new Set<string>();
    for (const source of [
      ...(linking.usageCostSources ?? []),
      ...(linking.usageLimitSources ?? []),
    ]) {
      const key = `${source.hubId}\u0000${source.deviceId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ hubId: source.hubId, deviceId: source.deviceId });
    }
    return result;
  }, [linking.usageCostSources, linking.usageLimitSources]);

  const resetCost = () => {
    setCostForm(emptyCostAssociation);
    setCostPreview(null);
    setEditingCostID("");
    setFormDirty("cost", false);
  };
  const resetLimit = () => {
    setLimitForm(emptyLimitAssociation);
    setLimitPreview(null);
    setEditingLimitID("");
    setFormDirty("limit", false);
  };
  const resetCompleteness = () => {
    setCompletenessForm(emptyCompleteness);
    setCompletenessConfirmed(false);
    setCompletenessPreview(null);
    setEditingCompletenessID("");
    setFormDirty("completeness", false);
  };
  const resetSwitch = () => {
    setSwitchForm(emptyHubSwitch);
    setSwitchPreview(null);
    setFormDirty("switch", false);
  };

  const costSources = (linking.usageCostSources ?? []).filter((item) =>
    matches([
      sourceName("usage_cost", item.id),
      serviceName("usage_cost", item.rawServiceIdentifier),
    ]),
  );
  const limitSources = (linking.usageLimitSources ?? []).filter((item) =>
    matches([
      sourceName("usage_limit", item.id),
      item.accountKey,
      item.normalizedLabel,
      serviceName("usage_limit", item.rawServiceIdentifier),
    ]),
  );
  const costAssociations = (linking.usageCostAssociations ?? []).filter(
    (item) =>
      matches([
        sourceName("usage_cost", item.usageCostSourceId),
        accountName(item.logicalAccountId),
      ]),
  );
  const limitAssociations = (linking.usageLimitAssociations ?? []).filter(
    (item) =>
      matches([
        sourceName("usage_limit", item.usageLimitSourceId),
        accountName(item.logicalAccountId),
      ]),
  );
  const completenessItems = (linking.usageCostSourceCompleteness ?? []).filter(
    (item) =>
      matches([
        sourceName("usage_cost", item.usageCostSourceId),
        item.state,
        ...(item.logicalAccountIds ?? []).map(accountName),
      ]),
  );
  const switches = (linking.hubSwitches ?? []).filter((item) =>
    matches([
      hubName(item.oldHubId),
      item.oldDeviceId,
      hubName(item.newHubId),
      item.newDeviceId,
      item.collectionDeviceId,
    ]),
  );

  const saveCost = () => {
    if (!costPreview) return;
    if (
      !window.confirm(
        `影響を確認しました。利用額関連付けを${editingCostID ? "修正" : "登録"}しますか？`,
      )
    )
      return;
    void runSave(
      () =>
        editingCostID
          ? backend.updateUsageCostAssociation({
              ...costForm,
              id: editingCostID,
            })
          : backend.createUsageCostAssociation(costForm).then(() => undefined),
      editingCostID
        ? "利用額関連付けを修正しました。"
        : "利用額関連付けを登録しました。",
    ).then((ok) => {
      if (ok) resetCost();
    });
  };
  const saveLimit = () => {
    if (!limitPreview) return;
    if (
      !window.confirm(
        `影響を確認しました。利用枠関連付けを${editingLimitID ? "修正" : "登録"}しますか？`,
      )
    )
      return;
    void runSave(
      () =>
        editingLimitID
          ? backend.updateUsageLimitAssociation({
              ...limitForm,
              id: editingLimitID,
            })
          : backend
              .createUsageLimitAssociation(limitForm)
              .then(() => undefined),
      editingLimitID
        ? "利用枠関連付けを修正しました。"
        : "利用枠関連付けを登録しました。",
    ).then((ok) => {
      if (ok) resetLimit();
    });
  };
  const saveCompleteness = () => {
    if (!completenessPreview || !completenessConfirmed) return;
    if (
      !window.confirm(
        `影響を確認しました。完全性を${editingCompletenessID ? "修正" : "登録"}しますか？`,
      )
    )
      return;
    const input = {
      ...completenessForm,
      state: completenessConfirmed ? "confirmed" : "unconfirmed",
      id: editingCompletenessID || completenessForm.id,
    };
    void runSave(
      () =>
        editingCompletenessID
          ? backend.updateUsageCostSourceCompleteness(input)
          : backend
              .confirmUsageCostSourceCompleteness(input)
              .then(() => undefined),
      editingCompletenessID
        ? "完全性を修正しました。"
        : "完全性を登録しました。",
    ).then((ok) => {
      if (ok) resetCompleteness();
    });
  };
  const saveSwitch = () => {
    if (!switchPreview) return;
    if (
      !window.confirm(
        "影響を確認しました。旧Hub端末から新Hub端末への切替を確定しますか？",
      )
    )
      return;
    void runSave(
      () => backend.confirmHubSwitch(switchForm).then(() => undefined),
      "Hub切替を記録しました。",
    ).then((ok) => {
      if (ok) resetSwitch();
    });
  };

  return (
    <>
      <div className={styles.content} hidden={selectedTab !== "usage-cost"}>
        <Field label="関連付けを検索">
          <Input
            value={search}
            onChange={(_, value) => setSearch(value.value)}
            placeholder="Hub、端末、生識別子、論理アカウント"
          />
        </Field>
        {error ? (
          <MessageBar intent="error">
            <MessageBarBody>{error}</MessageBarBody>
          </MessageBar>
        ) : null}
        {success ? (
          <MessageBar intent="success">
            <MessageBarBody>{success}</MessageBarBody>
          </MessageBar>
        ) : null}
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            if (
              !costForm.usageCostSourceId ||
              !costForm.logicalAccountId ||
              !costForm.validFrom
            )
              return;
            setSaving(true);
            setError("");
            void backend
              .previewUsageCostAssociation(costForm)
              .then((preview) => {
                setCostPreview(preview);
                setSuccess("対象観測と影響計算区間を確認してください。");
              })
              .catch((cause) => setError(errorMessage(cause)))
              .finally(() => setSaving(false));
          }}
        >
          <Subtitle1 as="h2">
            {editingCostID ? "利用額関連付けを修正" : "利用額関連付けを登録"}
          </Subtitle1>
          <Field label="利用額ソース" required>
            <Select
              value={costForm.usageCostSourceId}
              onChange={(event) => {
                setCostForm({
                  ...costForm,
                  usageCostSourceId: event.target.value,
                });
                setCostPreview(null);
                setFormDirty("cost", true);
              }}
            >
              <option value="">選択してください</option>
              {costSources.map((item) => (
                <option key={item.id} value={item.id}>
                  {sourceName("usage_cost", item.id)} /{" "}
                  {serviceName("usage_cost", item.rawServiceIdentifier)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="論理アカウント" required>
            <Select
              value={costForm.logicalAccountId}
              onChange={(event) => {
                setCostForm({
                  ...costForm,
                  logicalAccountId: event.target.value,
                });
                setCostPreview(null);
                setFormDirty("cost", true);
              }}
            >
              <option value="">選択してください</option>
              {activeAccounts.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.displayName}
                </option>
              ))}
            </Select>
          </Field>
          <div className={styles.grid}>
            <Field label="開始日時（UTC）" required>
              <Input
                value={costForm.validFrom}
                onChange={(_, value) => {
                  setCostForm({ ...costForm, validFrom: value.value });
                  setCostPreview(null);
                  setFormDirty("cost", true);
                }}
              />
            </Field>
            <Field label="終了日時（UTC・空欄可）">
              <Input
                value={costForm.validTo}
                onChange={(_, value) => {
                  setCostForm({ ...costForm, validTo: value.value });
                  setCostPreview(null);
                  setFormDirty("cost", true);
                }}
              />
            </Field>
          </div>
          <div className={styles.meta}>
            半開区間 [開始, 終了)。影響を確認後に確定します。
          </div>
          {costPreview ? (
            <ImpactPreviewSummary
              preview={costPreview}
              displayTimeZone={displayTimeZone}
            />
          ) : null}
          <div className={styles.actions}>
            <Button appearance="primary" type="submit" disabled={saving}>
              影響を確認
            </Button>
            <Button
              type="button"
              disabled={!costPreview || saving}
              onClick={saveCost}
            >
              確定
            </Button>
            <Button type="button" onClick={resetCost}>
              クリア
            </Button>
          </div>
        </form>
        <div className={styles.list} aria-label="利用額関連付け一覧">
          {costAssociations.length === 0 ? (
            <Body1>利用額関連付けはありません。</Body1>
          ) : (
            costAssociations.map((item) => (
              <article className={styles.card} key={item.id}>
                <div className={styles.sectionTitle}>
                  <Subtitle1 as="h2">
                    {accountName(item.logicalAccountId)}
                  </Subtitle1>
                  <Button
                    onClick={() => {
                      setEditingCostID(item.id);
                      setCostForm({
                        id: item.id,
                        usageCostSourceId: item.usageCostSourceId,
                        logicalAccountId: item.logicalAccountId,
                        validFrom: item.validFrom,
                        validTo: item.validTo,
                      });
                      setCostPreview(null);
                      setFormDirty("cost", true);
                    }}
                  >
                    期間を修正
                  </Button>
                </div>
                <div>{sourceName("usage_cost", item.usageCostSourceId)}</div>
                <div className={styles.meta}>
                  有効期間: [{formatInstant(item.validFrom, displayTimeZone)},{" "}
                  {formatInstant(item.validTo, displayTimeZone, "継続中")})
                </div>
              </article>
            ))
          )}
        </div>
      </div>

      <div className={styles.content} hidden={selectedTab !== "usage-limit"}>
        <Field label="関連付けを検索">
          <Input
            value={search}
            onChange={(_, value) => setSearch(value.value)}
            placeholder="Hub、端末、生識別子、論理アカウント"
          />
        </Field>
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            if (
              !limitForm.usageLimitSourceId ||
              !limitForm.logicalAccountId ||
              !limitForm.limitDefinitionId ||
              !limitForm.validFrom
            )
              return;
            setSaving(true);
            setError("");
            void backend
              .previewUsageLimitAssociation(limitForm)
              .then((preview) => {
                setLimitPreview(preview);
                setSuccess("対象観測と影響計算区間を確認してください。");
              })
              .catch((cause) => setError(errorMessage(cause)))
              .finally(() => setSaving(false));
          }}
        >
          <Subtitle1 as="h2">
            {editingLimitID ? "利用枠関連付けを修正" : "利用枠関連付けを登録"}
          </Subtitle1>
          <Field label="利用枠ソース" required>
            <Select
              value={limitForm.usageLimitSourceId}
              onChange={(event) => {
                setLimitForm({
                  ...limitForm,
                  usageLimitSourceId: event.target.value,
                });
                setLimitPreview(null);
                setFormDirty("limit", true);
              }}
            >
              <option value="">選択してください</option>
              {limitSources.map((item) => (
                <option key={item.id} value={item.id}>
                  {sourceName("usage_limit", item.id)} /{" "}
                  {item.normalizedLabel || item.accountKey}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="論理アカウント" required>
            <Select
              value={limitForm.logicalAccountId}
              onChange={(event) => {
                setLimitForm({
                  ...limitForm,
                  logicalAccountId: event.target.value,
                });
                setLimitPreview(null);
                setFormDirty("limit", true);
              }}
            >
              <option value="">選択してください</option>
              {activeAccounts.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.displayName}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="利用枠定義" required>
            <Select
              value={limitForm.limitDefinitionId}
              onChange={(event) => {
                setLimitForm({
                  ...limitForm,
                  limitDefinitionId: event.target.value,
                });
                setLimitPreview(null);
                setFormDirty("limit", true);
              }}
            >
              <option value="">選択してください</option>
              {(catalog.limitDefinitions ?? [])
                .filter((item) => !item.archivedAt)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.meaning} / {item.unit} /{" "}
                    {cycleTypeLabel(item.cycleType)}
                  </option>
                ))}
            </Select>
          </Field>
          <div className={styles.grid}>
            <Field label="開始日時（UTC）" required>
              <Input
                value={limitForm.validFrom}
                onChange={(_, value) => {
                  setLimitForm({ ...limitForm, validFrom: value.value });
                  setLimitPreview(null);
                  setFormDirty("limit", true);
                }}
              />
            </Field>
            <Field label="終了日時（UTC・空欄可）">
              <Input
                value={limitForm.validTo}
                onChange={(_, value) => {
                  setLimitForm({ ...limitForm, validTo: value.value });
                  setLimitPreview(null);
                  setFormDirty("limit", true);
                }}
              />
            </Field>
          </div>
          <div className={styles.meta}>
            半開区間 [開始,
            終了)。利用枠ソースは単一の論理アカウントへ関連付けます。
          </div>
          {limitPreview ? (
            <ImpactPreviewSummary
              preview={limitPreview}
              displayTimeZone={displayTimeZone}
            />
          ) : null}
          <div className={styles.actions}>
            <Button appearance="primary" type="submit" disabled={saving}>
              影響を確認
            </Button>
            <Button
              type="button"
              disabled={!limitPreview || saving}
              onClick={saveLimit}
            >
              確定
            </Button>
            <Button type="button" onClick={resetLimit}>
              クリア
            </Button>
          </div>
        </form>
        <div className={styles.list} aria-label="利用枠関連付け一覧">
          {limitAssociations.length === 0 ? (
            <Body1>利用枠関連付けはありません。</Body1>
          ) : (
            limitAssociations.map((item) => (
              <article className={styles.card} key={item.id}>
                <div className={styles.sectionTitle}>
                  <Subtitle1 as="h2">
                    {accountName(item.logicalAccountId)}
                  </Subtitle1>
                  <Button
                    onClick={() => {
                      setEditingLimitID(item.id);
                      setLimitForm({
                        id: item.id,
                        usageLimitSourceId: item.usageLimitSourceId,
                        logicalAccountId: item.logicalAccountId,
                        limitDefinitionId: item.limitDefinitionId,
                        validFrom: item.validFrom,
                        validTo: item.validTo,
                      });
                      setLimitPreview(null);
                      setFormDirty("limit", true);
                    }}
                  >
                    期間を修正
                  </Button>
                </div>
                <div>{sourceName("usage_limit", item.usageLimitSourceId)}</div>
                <div>
                  {(catalog.limitDefinitions ?? []).find(
                    (definition) => definition.id === item.limitDefinitionId,
                  )?.meaning ?? "利用枠定義未表示"}
                </div>
                <div className={styles.meta}>
                  有効期間: [{formatInstant(item.validFrom, displayTimeZone)},{" "}
                  {formatInstant(item.validTo, displayTimeZone, "継続中")})
                </div>
              </article>
            ))
          )}
        </div>
      </div>

      <div className={styles.content} hidden={selectedTab !== "completeness"}>
        <Field label="完全性を検索">
          <Input
            value={search}
            onChange={(_, value) => setSearch(value.value)}
            placeholder="Hub、利用額ソース、状態、論理アカウント"
          />
        </Field>
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            if (
              !completenessForm.usageCostSourceId ||
              !completenessForm.validFrom
            )
              return;
            const input = {
              ...completenessForm,
              state: completenessConfirmed ? "confirmed" : "unconfirmed",
              id: editingCompletenessID || completenessForm.id,
            };
            setSaving(true);
            setError("");
            void backend
              .previewUsageCostSourceCompleteness(input)
              .then((preview) => {
                setCompletenessPreview(preview);
                setSuccess(
                  "対象観測と影響計算区間を確認してください。確定前に内容を再確認してください。",
                );
              })
              .catch((cause) => setError(errorMessage(cause)))
              .finally(() => setSaving(false));
          }}
        >
          <Subtitle1 as="h2">
            {editingCompletenessID
              ? "活動主体の完全性を修正"
              : "活動主体の完全性を登録"}
          </Subtitle1>
          <Field label="利用額ソース" required>
            <Select
              value={completenessForm.usageCostSourceId}
              onChange={(event) => {
                setCompletenessForm({
                  ...completenessForm,
                  usageCostSourceId: event.target.value,
                  logicalAccountIds: [],
                });
                setCompletenessConfirmed(false);
                setCompletenessPreview(null);
                setFormDirty("completeness", true);
              }}
            >
              <option value="">選択してください</option>
              {costSources.map((item) => (
                <option key={item.id} value={item.id}>
                  {sourceName("usage_cost", item.id)}
                </option>
              ))}
            </Select>
          </Field>
          <div className={styles.grid}>
            <Field label="開始日時（UTC）" required>
              <Input
                value={completenessForm.validFrom}
                onChange={(_, value) => {
                  setCompletenessForm({
                    ...completenessForm,
                    validFrom: value.value,
                    logicalAccountIds: [],
                  });
                  setCompletenessConfirmed(false);
                  setCompletenessPreview(null);
                  setFormDirty("completeness", true);
                }}
              />
            </Field>
            <Field label="終了日時（UTC・空欄可）">
              <Input
                value={completenessForm.validTo}
                onChange={(_, value) => {
                  setCompletenessForm({
                    ...completenessForm,
                    validTo: value.value,
                    logicalAccountIds: [],
                  });
                  setCompletenessConfirmed(false);
                  setCompletenessPreview(null);
                  setFormDirty("completeness", true);
                }}
              />
            </Field>
          </div>
          <div className={styles.detail}>
            <strong>有効な全論理アカウント（除外なし）</strong>
            {completenessEligibleAccounts.length === 0 ? (
              <span>
                選択したソース・期間に有効な利用額関連付けはありません。
              </span>
            ) : (
              completenessEligibleAccounts.map((item) => (
                <Checkbox
                  key={item.id}
                  label={item.displayName}
                  checked={(completenessForm.logicalAccountIds ?? []).includes(
                    item.id,
                  )}
                  onChange={(_, value) => {
                    const currentIDs = completenessForm.logicalAccountIds ?? [];
                    const ids =
                      value.checked === true
                        ? [...currentIDs, item.id]
                        : currentIDs.filter((id) => id !== item.id);
                    setCompletenessForm({
                      ...completenessForm,
                      logicalAccountIds: ids,
                    });
                    setCompletenessConfirmed(false);
                    setCompletenessPreview(null);
                    setFormDirty("completeness", true);
                  }}
                />
              ))
            )}
          </div>
          <Checkbox
            label="上記の全有効論理アカウントを含み、除外対象がないことを明示確認する"
            checked={completenessConfirmed}
            disabled={
              completenessEligibleAccounts.some(
                (item) =>
                  !(completenessForm.logicalAccountIds ?? []).includes(item.id),
              ) || (completenessForm.excludedActivity ?? []).length > 0
            }
            onChange={(_, value) => {
              setCompletenessConfirmed(value.checked === true);
              setCompletenessPreview(null);
              setFormDirty("completeness", true);
            }}
          />
          <div className={styles.meta}>
            対象区間は半開区間 [開始,
            終了)。確定前に対象期間と全主体の選択内容を確認してください。保存後は完全性未確認・除外ありの区間を推定対象外として扱います。
          </div>
          {completenessPreview ? (
            <ImpactPreviewSummary
              preview={completenessPreview}
              displayTimeZone={displayTimeZone}
            />
          ) : null}
          <div className={styles.actions}>
            <Button appearance="primary" type="submit" disabled={saving}>
              影響を確認
            </Button>
            <Button
              type="button"
              disabled={
                !completenessPreview || !completenessConfirmed || saving
              }
              onClick={saveCompleteness}
            >
              確定
            </Button>
            <Button type="button" onClick={resetCompleteness}>
              クリア
            </Button>
          </div>
        </form>
        <div className={styles.list} aria-label="活動主体の完全性一覧">
          {completenessItems.length === 0 ? (
            <Body1>完全性の記録はありません。</Body1>
          ) : (
            completenessItems.map((item) => (
              <article className={styles.card} key={item.id}>
                <Subtitle1 as="h2">
                  {sourceName("usage_cost", item.usageCostSourceId)}
                </Subtitle1>
                <div>
                  状態: <StatusBadge status={completenessStatus(item.state)} />{" "}
                  / 対象主体:{" "}
                  {(item.logicalAccountIds ?? []).map(accountName).join("、") ||
                    "なし"}{" "}
                  / 除外対象:{" "}
                  {(item.excludedActivity ?? []).length > 0 ? "あり" : "なし"}
                </div>
                <div className={styles.meta}>
                  対象期間: [{formatInstant(item.validFrom, displayTimeZone)},{" "}
                  {formatInstant(item.validTo, displayTimeZone, "継続中")})
                </div>
                <Button
                  onClick={() => {
                    setEditingCompletenessID(item.id);
                    setCompletenessForm({
                      id: item.id,
                      usageCostSourceId: item.usageCostSourceId,
                      validFrom: item.validFrom,
                      validTo: item.validTo,
                      state: item.state,
                      logicalAccountIds: item.logicalAccountIds ?? [],
                      excludedActivity: item.excludedActivity ?? [],
                    });
                    setCompletenessConfirmed(
                      item.state === "confirmed" &&
                        (item.excludedActivity ?? []).length === 0 &&
                        completenessEligibleAccounts.every((account) =>
                          (item.logicalAccountIds ?? []).includes(account.id),
                        ),
                    );
                    setCompletenessPreview(null);
                    setFormDirty("completeness", true);
                  }}
                >
                  期間を修正
                </Button>
              </article>
            ))
          )}
        </div>
      </div>

      <div className={styles.content} hidden={selectedTab !== "switch"}>
        <Field label="Hub切替を検索">
          <Input
            value={search}
            onChange={(_, value) => setSearch(value.value)}
            placeholder="Hub、端末"
          />
        </Field>
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            if (
              !switchForm.oldHubId ||
              !switchForm.oldDeviceId ||
              !switchForm.newHubId ||
              !switchForm.newDeviceId ||
              !switchForm.collectionDeviceId ||
              !switchForm.switchedAt
            )
              return;
            setSaving(true);
            setError("");
            void backend
              .previewHubSwitch(switchForm)
              .then((preview) => {
                setSwitchPreview(preview);
                setSuccess(
                  "対象観測と影響計算区間を確認してください。確定前に内容を再確認してください。",
                );
              })
              .catch((cause) => setError(errorMessage(cause)))
              .finally(() => setSaving(false));
          }}
        >
          <Subtitle1 as="h2">収集端末・Hub切替を記録</Subtitle1>
          <div className={styles.grid}>
            <Field label="旧Hub">
              <Select
                value={switchForm.oldHubId}
                onChange={(event) => {
                  setSwitchForm({
                    ...switchForm,
                    oldHubId: event.target.value,
                    oldDeviceId: "",
                  });
                  setSwitchPreview(null);
                  setFormDirty("switch", true);
                }}
              >
                <option value="">選択してください</option>
                {hubs.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.displayName}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="旧Hub端末レコード">
              <Select
                value={switchForm.oldDeviceId}
                onChange={(event) => {
                  setSwitchForm({
                    ...switchForm,
                    oldDeviceId: event.target.value,
                  });
                  setSwitchPreview(null);
                  setFormDirty("switch", true);
                }}
              >
                <option value="">選択してください</option>
                {devices
                  .filter((item) => item.hubId === switchForm.oldHubId)
                  .map((item) => (
                    <option
                      key={`${item.hubId}-${item.deviceId}`}
                      value={item.deviceId}
                    >
                      {item.deviceId}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="新Hub">
              <Select
                value={switchForm.newHubId}
                onChange={(event) => {
                  setSwitchForm({
                    ...switchForm,
                    newHubId: event.target.value,
                    newDeviceId: "",
                  });
                  setSwitchPreview(null);
                  setFormDirty("switch", true);
                }}
              >
                <option value="">選択してください</option>
                {hubs.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.displayName}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="新Hub端末レコード">
              <Select
                value={switchForm.newDeviceId}
                onChange={(event) => {
                  setSwitchForm({
                    ...switchForm,
                    newDeviceId: event.target.value,
                  });
                  setSwitchPreview(null);
                  setFormDirty("switch", true);
                }}
              >
                <option value="">選択してください</option>
                {devices
                  .filter((item) => item.hubId === switchForm.newHubId)
                  .map((item) => (
                    <option
                      key={`${item.hubId}-${item.deviceId}`}
                      value={item.deviceId}
                    >
                      {item.deviceId}
                    </option>
                  ))}
              </Select>
            </Field>
          </div>
          <Field label="収集端末">
            <Select
              value={switchForm.collectionDeviceId}
              onChange={(event) => {
                setSwitchForm({
                  ...switchForm,
                  collectionDeviceId: event.target.value,
                });
                setSwitchPreview(null);
                setFormDirty("switch", true);
              }}
            >
              <option value="">選択してください</option>
              {devices.map((item) => (
                <option
                  key={`${item.hubId}-${item.deviceId}`}
                  value={item.deviceId}
                >
                  {hubName(item.hubId)} / {item.deviceId}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="切替日時（UTC）" required>
            <Input
              value={switchForm.switchedAt}
              onChange={(_, value) => {
                setSwitchForm({ ...switchForm, switchedAt: value.value });
                setSwitchPreview(null);
                setFormDirty("switch", true);
              }}
            />
          </Field>
          <div className={styles.meta}>
            切替日時以降を新しいHub端末の境界として記録します。画面日時と保存UTCを併記します。
          </div>
          {switchPreview ? (
            <ImpactPreviewSummary
              preview={switchPreview}
              displayTimeZone={displayTimeZone}
            />
          ) : null}
          <div className={styles.actions}>
            <Button appearance="primary" type="submit" disabled={saving}>
              影響を確認
            </Button>
            <Button
              type="button"
              disabled={!switchPreview || saving}
              onClick={saveSwitch}
            >
              確定
            </Button>
            <Button type="button" onClick={resetSwitch}>
              クリア
            </Button>
          </div>
        </form>
        <div className={styles.list} aria-label="Hub切替一覧">
          {switches.length === 0 ? (
            <Body1>Hub切替の記録はありません。</Body1>
          ) : (
            switches.map((item) => (
              <article className={styles.card} key={item.id}>
                <Subtitle1 as="h2">
                  {hubName(item.oldHubId)} / {item.oldDeviceId} →{" "}
                  {hubName(item.newHubId)} / {item.newDeviceId}
                </Subtitle1>
                <div>収集端末: {item.collectionDeviceId}</div>
                <div className={styles.meta}>
                  切替日時:{" "}
                  {formatInstantPair(item.switchedAt, displayTimeZone)}
                </div>
              </article>
            ))
          )}
        </div>
      </div>
    </>
  );
}

function ImpactPreviewSummary({
  preview,
  displayTimeZone,
}: {
  preview: ImpactPreviewSnapshot;
  displayTimeZone: string;
}) {
  const intervals = preview.affectedCalculationIntervals ?? [];
  return (
    <div className="impact-preview" aria-label="影響プレビュー">
      <strong>影響プレビュー</strong>
      <span>対象観測: {(preview.affectedObservationIds ?? []).length}件</span>
      <span>影響計算区間（半開）:</span>
      {intervals.length === 0 ? (
        <span>影響計算区間はありません。</span>
      ) : (
        <ul>
          {intervals.map((interval, index) => (
            <li key={`${interval.start}-${interval.end}-${index}`}>
              [{formatInstant(interval.start, displayTimeZone)},{" "}
              {formatInstant(interval.end, displayTimeZone, "継続中")})
            </li>
          ))}
        </ul>
      )}
      <span>
        影響する派生結果: {(preview.affectedDerivedResultIds ?? []).length}件
      </span>
    </div>
  );
}

function formatInstant(
  value: string,
  timeZone: string,
  emptyLabel = "不明",
): string {
  if (!value) return emptyLabel;
  try {
    return `${formatOverviewInstant(value, timeZone)}（UTC ${value}）`;
  } catch {
    return "日時不明";
  }
}

function formatInstantPair(value: string, timeZone: string): string {
  return value ? formatInstant(value, timeZone) : "不明";
}

function intervalsOverlap(
  firstStart: string,
  firstEnd: string,
  secondStart: string,
  secondEnd: string,
): boolean {
  const firstFrom = Date.parse(firstStart);
  const secondFrom = Date.parse(secondStart);
  if (!Number.isFinite(firstFrom) || !Number.isFinite(secondFrom)) return false;
  const firstTo = firstEnd ? Date.parse(firstEnd) : Number.POSITIVE_INFINITY;
  const secondTo = secondEnd ? Date.parse(secondEnd) : Number.POSITIVE_INFINITY;
  if (Number.isNaN(firstTo) || Number.isNaN(secondTo)) return false;
  return firstFrom < secondTo && secondFrom < firstTo;
}
