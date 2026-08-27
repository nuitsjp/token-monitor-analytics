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
import { useCallback, useEffect, useState } from "react";
import { StatusBadge } from "../../components/StatusBadge";
import { formatOverviewInstant } from "../../lib/overviewDisplay";
import type {
  CatalogSnapshot,
  CandidateSplitInput,
  FrontendAdapter,
  HubSnapshot,
  LabelChangeDecisionInput,
  LimitDefinitionInput,
  PlanInput,
  PlanLimitRuleInput,
  PlanVersionInput,
  ServiceIdentifierMappingInput,
  ServiceSnapshot,
  CreateServiceInput,
  StandardPriceInput,
  StatusPresentationSnapshot,
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
  raw: {
    fontFamily: "Consolas, 'Cascadia Code', monospace",
    overflowWrap: "anywhere",
    whiteSpace: "pre-wrap",
  },
  evidence: {
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
});

type TabName =
  "services" | "candidates" | "limits" | "plans" | "versions" | "prices";
type DirtyForm =
  | "service"
  | "mapping"
  | "candidate"
  | "label"
  | "limit"
  | "plan"
  | "version"
  | "rule"
  | "price";
const emptyCatalog: CatalogSnapshot = {
  services: [],
  serviceIdentifierMappings: [],
  limitDefinitions: [],
  plans: [],
  planVersions: [],
  planLimitRules: [],
  standardPrices: [],
  identificationCandidates: [],
  labelChangeCandidates: [],
};
const emptyDirtyForms: Record<DirtyForm, boolean> = {
  service: false,
  mapping: false,
  candidate: false,
  label: false,
  limit: false,
  plan: false,
  version: false,
  rule: false,
  price: false,
};

export function CatalogPage({
  backend,
  onDirtyChange,
  displayTimeZone = backend.initialSettings.displayTimeZone,
}: {
  backend: FrontendAdapter;
  onDirtyChange: (dirty: boolean) => void;
  displayTimeZone?: string;
}) {
  const styles = useStyles();
  const [catalog, setCatalog] = useState<CatalogSnapshot>(emptyCatalog);
  const [hubs, setHubs] = useState<HubSnapshot[]>([]);
  const [tab, setTab] = useState<TabName>("services");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [dirtyForms, setDirtyForms] =
    useState<Record<DirtyForm, boolean>>(emptyDirtyForms);
  const setFormDirty = useCallback((form: DirtyForm, dirty: boolean) => {
    setDirtyForms((current) =>
      current[form] === dirty ? current : { ...current, [form]: dirty },
    );
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [nextCatalog, nextHubs] = await Promise.all([
        backend.getCatalog(),
        backend.getHubs(),
      ]);
      setCatalog(nextCatalog);
      setHubs(nextHubs);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [backend]);
  useEffect(() => {
    // Exception: Rule=react-hooks/set-state-in-effect; Reason=mount synchronizes adapter-backed state; Scope=next line; Owner=frontend; Expires=2026-12-31.
    // The initial read synchronizes this page with the external Wails adapter.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);
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

  const services = catalog.services ?? [];
  const mappings = catalog.serviceIdentifierMappings ?? [];
  const limits = catalog.limitDefinitions ?? [];
  const plans = catalog.plans ?? [];
  const versions = catalog.planVersions ?? [];
  const rules = catalog.planLimitRules ?? [];
  const prices = catalog.standardPrices ?? [];
  const labelCandidates = catalog.labelChangeCandidates ?? [];
  return (
    <div
      className={styles.page}
      role="region"
      aria-label="サービス・プラン画面"
    >
      <div className={styles.intro}>
        <Subtitle1 as="h1">サービス・プラン</Subtitle1>
        <Body1>
          ユーザーが確認したサービス、利用枠、プランだけをカタログとして管理します。製品名や倍率を文字列から推測しません。
        </Body1>
        <div className={styles.meta}>
          期間は UTC の半開区間 [開始, 終了)
          です。終了を空欄にした期間は継続中です。
        </div>
      </div>
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            {error}
            <Button appearance="transparent" onClick={() => void refresh()}>
              再読み込み
            </Button>
          </MessageBarBody>
        </MessageBar>
      )}
      {success && (
        <MessageBar intent="success">
          <MessageBarBody>{success}</MessageBarBody>
        </MessageBar>
      )}
      {loading ? (
        <Spinner label="カタログを読み込み中" />
      ) : (
        <>
          <TabList
            className={styles.tabs}
            selectedValue={tab}
            onTabSelect={(_, data) => setTab(data.value as TabName)}
          >
            <Tab value="services">サービス・生 ID</Tab>
            <Tab value="candidates">同定候補</Tab>
            <Tab value="limits">利用枠定義</Tab>
            <Tab value="plans">プラン</Tab>
            <Tab value="versions">プラン版・倍率</Tab>
            <Tab value="prices">標準価格</Tab>
          </TabList>
          <div className={styles.content}>
            <div hidden={tab !== "services"}>
              <ServicesTab
                backend={backend}
                services={services}
                mappings={mappings}
                displayTimeZone={displayTimeZone}
                runSave={runSave}
                setServiceDirty={(dirty) => setFormDirty("service", dirty)}
                setMappingDirty={(dirty) => setFormDirty("mapping", dirty)}
                saving={saving}
              />
            </div>
            <div hidden={tab !== "candidates"}>
              <CandidatesTab
                backend={backend}
                catalog={catalog}
                hubs={hubs}
                displayTimeZone={displayTimeZone}
                runSave={runSave}
                setDirty={(dirty) => setFormDirty("candidate", dirty)}
                saving={saving}
              />
              {labelCandidates.length > 0 && (
                <LabelChangeList
                  backend={backend}
                  candidates={labelCandidates}
                  limits={limits}
                  hubs={hubs}
                  displayTimeZone={displayTimeZone}
                  runSave={runSave}
                  setDirty={(dirty) => setFormDirty("label", dirty)}
                  saving={saving}
                />
              )}
            </div>
            <div hidden={tab !== "limits"}>
              <LimitsTab
                backend={backend}
                services={services}
                limits={limits}
                runSave={runSave}
                setDirty={(dirty) => setFormDirty("limit", dirty)}
                saving={saving}
              />
            </div>
            <div hidden={tab !== "plans"}>
              <PlansTab
                backend={backend}
                services={services}
                plans={plans}
                runSave={runSave}
                setDirty={(dirty) => setFormDirty("plan", dirty)}
                saving={saving}
              />
            </div>
            <div hidden={tab !== "versions"}>
              <VersionsTab
                backend={backend}
                plans={plans}
                versions={versions}
                limits={limits}
                rules={rules}
                displayTimeZone={displayTimeZone}
                runSave={runSave}
                setVersionDirty={(dirty) => setFormDirty("version", dirty)}
                setRuleDirty={(dirty) => setFormDirty("rule", dirty)}
                saving={saving}
              />
            </div>
            <div hidden={tab !== "prices"}>
              <PricesTab
                backend={backend}
                plans={plans}
                versions={versions}
                prices={prices}
                displayTimeZone={displayTimeZone}
                runSave={runSave}
                setDirty={(dirty) => setFormDirty("price", dirty)}
                saving={saving}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ServicesTab({
  backend,
  services,
  mappings,
  displayTimeZone,
  runSave,
  setServiceDirty,
  setMappingDirty,
  saving,
}: {
  backend: FrontendAdapter;
  services: ServiceSnapshot[];
  mappings: CatalogSnapshot["serviceIdentifierMappings"];
  displayTimeZone: string;
  runSave: (action: () => Promise<void>, message: string) => Promise<boolean>;
  setServiceDirty: (dirty: boolean) => void;
  setMappingDirty: (dirty: boolean) => void;
  saving: boolean;
}) {
  const styles = useStyles();
  const [service, setService] = useState<CreateServiceInput>({
    provider: "",
    name: "",
    officialKey: "",
  });
  const [mapping, setMapping] = useState<ServiceIdentifierMappingInput>({
    id: "",
    kind: "usage_cost",
    rawIdentifier: "",
    serviceId: "",
    validFrom: "",
    validTo: "",
  });
  const [editingService, setEditingService] = useState<ServiceSnapshot | null>(
    null,
  );
  const saveService = async () => {
    if (
      !service.provider.trim() ||
      !service.name.trim() ||
      !service.officialKey.trim()
    )
      return;
    if (
      !(await runSave(
        () =>
          editingService
            ? backend
                .updateService({
                  ...service,
                  id: editingService.id,
                  archived: Boolean(editingService.archivedAt),
                })
                .then(() => undefined)
            : backend.createService(service).then(() => undefined),
        "サービスを保存しました。",
      ))
    ) {
      return;
    }
    setService({ provider: "", name: "", officialKey: "" });
    setEditingService(null);
    setServiceDirty(false);
  };
  const saveMapping = async () => {
    const input = {
      ...mapping,
      validFrom: toUTC(mapping.validFrom),
      validTo: toUTC(mapping.validTo),
    };
    if (!input.rawIdentifier.trim() || !input.serviceId || !input.validFrom)
      return;
    if (
      !(await runSave(
        () =>
          input.id
            ? backend.updateServiceIdentifierMapping(input)
            : backend.createServiceIdentifierMapping(input),
        "生サービス ID の対応を保存しました。",
      ))
    ) {
      return;
    }
    setMapping({
      id: "",
      kind: "usage_cost",
      rawIdentifier: "",
      serviceId: "",
      validFrom: "",
      validTo: "",
    });
    setMappingDirty(false);
  };
  return (
    <>
      <div className={styles.grid}>
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void saveService();
          }}
        >
          <Subtitle1 as="h2">正式なサービス</Subtitle1>
          <Field label="提供者">
            <Input
              value={service.provider}
              onChange={(_, d) => {
                setService((v) => ({ ...v, provider: d.value }));
                setServiceDirty(true);
              }}
            />
          </Field>
          <Field label="サービス名">
            <Input
              value={service.name}
              onChange={(_, d) => {
                setService((v) => ({ ...v, name: d.value }));
                setServiceDirty(true);
              }}
            />
          </Field>
          <Field label="正式キー" hint="推測せず、利用者が登録した識別キー">
            <Input
              value={service.officialKey}
              onChange={(_, d) => {
                setService((v) => ({ ...v, officialKey: d.value }));
                setServiceDirty(true);
              }}
            />
          </Field>
          <div className={styles.actions}>
            <Button appearance="primary" type="submit" disabled={saving}>
              保存
            </Button>
            <Button
              type="button"
              onClick={() => {
                setService({ provider: "", name: "", officialKey: "" });
                setEditingService(null);
                setServiceDirty(false);
              }}
            >
              クリア
            </Button>
          </div>
        </form>
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void saveMapping();
          }}
        >
          <Subtitle1 as="h2">生サービス ID の対応（期間付き）</Subtitle1>
          <Field label="種類">
            <Select
              value={mapping.kind}
              onChange={(event) => {
                setMapping((v) => ({ ...v, kind: event.target.value }));
                setMappingDirty(true);
              }}
            >
              <option value="usage_cost">生利用額サービス識別子</option>
              <option value="usage_limit">生利用枠サービス識別子</option>
            </Select>
          </Field>
          <Field label="原形識別子" hint="完全一致で保存">
            <Input
              value={mapping.rawIdentifier}
              onChange={(_, d) => {
                setMapping((v) => ({ ...v, rawIdentifier: d.value }));
                setMappingDirty(true);
              }}
            />
          </Field>
          <Field label="正式なサービス">
            <Select
              value={mapping.serviceId}
              onChange={(event) => {
                setMapping((v) => ({ ...v, serviceId: event.target.value }));
                setMappingDirty(true);
              }}
            >
              <option value="">選択してください</option>
              {services.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.provider} / {item.name}
                </option>
              ))}
            </Select>
          </Field>
          <PeriodFields
            from={mapping.validFrom}
            to={mapping.validTo}
            onChange={(validFrom, validTo) => {
              setMapping((v) => ({ ...v, validFrom, validTo }));
              setMappingDirty(true);
            }}
          />
          <Button appearance="primary" type="submit" disabled={saving}>
            対応を保存
          </Button>
        </form>
      </div>
      <div className={styles.list} aria-label="正式なサービス一覧">
        {services.length === 0 ? (
          <Body1>正式なサービスはまだありません。</Body1>
        ) : (
          services.map((item) => (
            <article className={styles.card} key={item.id}>
              <div className={styles.sectionTitle}>
                <Subtitle1 as="h2">
                  {item.provider} / {item.name}
                </Subtitle1>
                <Button
                  onClick={() => {
                    setEditingService(item);
                    setService({
                      provider: item.provider,
                      name: item.name,
                      officialKey: item.officialKey,
                    });
                    setServiceDirty(true);
                  }}
                >
                  編集
                </Button>
              </div>
              <div className={styles.meta}>正式キー: {item.officialKey}</div>
              <div>
                対応履歴:{" "}
                {mappings?.filter((mapping) => mapping.serviceId === item.id)
                  .length ?? 0}{" "}
                件
              </div>
            </article>
          ))
        )}
      </div>
      <div className={styles.card}>
        <Subtitle1 as="h2">生 ID の別一覧</Subtitle1>
        <div className={styles.grid}>
          <IdentifierList
            title="生利用額サービス識別子"
            items={mappings?.filter((item) => item.kind === "usage_cost") ?? []}
            displayTimeZone={displayTimeZone}
          />
          <IdentifierList
            title="生利用枠サービス識別子"
            items={
              mappings?.filter((item) => item.kind === "usage_limit") ?? []
            }
            displayTimeZone={displayTimeZone}
          />
        </div>
      </div>
    </>
  );
}

function IdentifierList({
  title,
  items,
  displayTimeZone,
}: {
  title: string;
  items: NonNullable<CatalogSnapshot["serviceIdentifierMappings"]>;
  displayTimeZone: string;
}) {
  const styles = useStyles();
  return (
    <div>
      <Body1>{title}</Body1>
      {items.length === 0 ? (
        <div className={styles.meta}>登録なし</div>
      ) : (
        items.map((item) => (
          <div className={styles.evidence} key={item.id}>
            <span className={styles.raw}>{item.rawIdentifier}</span>
            <span className={styles.meta}>
              {formatInstant(item.validFrom, displayTimeZone)} ～{" "}
              {formatInstant(item.validTo, displayTimeZone, "継続中")}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

function CandidatesTab({
  backend,
  catalog,
  hubs,
  displayTimeZone,
  runSave,
  setDirty,
  saving,
}: {
  backend: FrontendAdapter;
  catalog: CatalogSnapshot;
  hubs: HubSnapshot[];
  displayTimeZone: string;
  runSave: (action: () => Promise<void>, message: string) => Promise<boolean>;
  setDirty: (dirty: boolean) => void;
  saving: boolean;
}) {
  const styles = useStyles();
  const services = catalog.services ?? [];
  const plans = catalog.plans ?? [];
  const [state, setState] = useState("unconfirmed");
  const candidates = (catalog.identificationCandidates ?? []).filter(
    (item) => item.state === state,
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [serviceID, setServiceID] = useState("");
  const [planID, setPlanID] = useState("");
  const [correction, setCorrection] = useState({
    rawLimitServiceIdentifier: "",
    rawReportedPlanName: "",
  });
  const [splitIDs, setSplitIDs] = useState<string[]>([]);
  const candidate =
    candidates.find((item) => item.id === selected) ?? candidates[0];
  useEffect(() => {
    if (!candidate) {
      // Exception: Rule=react-hooks/set-state-in-effect; Reason=selection changes reset the candidate editor; Scope=next line; Owner=frontend; Expires=2026-12-31.
      // Candidate selection mirrors the selected evidence into the edit controls.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelected(null);
      return;
    }
    setSelected(candidate.id);
    setCorrection({
      rawLimitServiceIdentifier: candidate.rawLimitServiceIdentifier,
      rawReportedPlanName: candidate.rawReportedPlanName,
    });
    setSplitIDs([]);
    // Exception: Rule=react-hooks/exhaustive-deps; Reason=the candidate identity alone defines when the editor resets; Scope=next line; Owner=frontend; Expires=2026-12-31.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidate?.id]);
  const saveCandidate = async (
    action: () => Promise<void>,
    message: string,
  ) => {
    if (!(await runSave(action, message))) {
      return;
    }
    setSelected(null);
    setDirty(false);
  };
  return (
    <>
      <div className={styles.actions}>
        <label>
          状態{" "}
          <Select
            value={state}
            onChange={(event) => setState(event.target.value)}
          >
            <option value="unconfirmed">未確認</option>
            <option value="confirmed">確認済み</option>
            <option value="rejected">対象外</option>
          </Select>
        </label>
      </div>
      {candidates.length === 0 ? (
        <Body1>この状態の同定候補はありません。</Body1>
      ) : (
        <div className={styles.grid}>
          {candidates.map((item) => (
            <button
              className={styles.card}
              type="button"
              key={item.id}
              onClick={() => setSelected(item.id)}
              aria-pressed={item.id === candidate?.id}
            >
              <Subtitle1 as="h2">{item.rawLimitServiceIdentifier}</Subtitle1>
              <div className={styles.raw}>
                報告プラン名: {item.rawReportedPlanName}
              </div>
              <div className={styles.meta}>
                状態:{" "}
                <StatusBadge status={catalogCandidateStatus(item.state)} /> /
                観測: {formatInstant(item.firstObservedAt, displayTimeZone)} ～{" "}
                {formatInstant(item.lastObservedAt, displayTimeZone, "継続中")}
              </div>
              <div className={styles.meta}>
                Hub 件数:{" "}
                {
                  new Set(
                    (item.observations ?? []).map(
                      (observation) => observation.hubId,
                    ),
                  ).size
                }
              </div>
            </button>
          ))}
        </div>
      )}
      {candidate && (
        <article className={styles.card} aria-label="同定候補の根拠と判断">
          <Subtitle1 as="h2">候補の根拠・判断</Subtitle1>
          <div className={styles.raw}>
            生利用枠サービス識別子（原形）:{" "}
            {candidate.rawLimitServiceIdentifier}
          </div>
          <div className={styles.raw}>
            生報告プラン名（原形）: {candidate.rawReportedPlanName}
          </div>
          <div className={styles.meta}>
            最初: {formatInstant(candidate.firstObservedAt, displayTimeZone)} /
            最後:{" "}
            {formatInstant(candidate.lastObservedAt, displayTimeZone, "継続中")}
          </div>
          <div className={styles.evidence}>
            {(candidate.observations ?? []).map((observation) => (
              <div key={observation.id}>
                Hub: {hubDisplayName(observation.hubId, hubs)} / アカウント表示:{" "}
                {observation.hubAccountDisplay || "—"} /{" "}
                {formatInstant(observation.observedAt, displayTimeZone)}
              </div>
            ))}
          </div>
          <div className={styles.grid}>
            <Field label="正式なサービス">
              <Select
                value={serviceID}
                onChange={(event) => {
                  setServiceID(event.target.value);
                  setDirty(true);
                }}
              >
                <option value="">選択してください</option>
                {services.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.provider} / {item.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="正式なプラン">
              <Select
                value={planID}
                onChange={(event) => {
                  setPlanID(event.target.value);
                  setDirty(true);
                }}
              >
                <option value="">選択してください</option>
                {plans
                  .filter((item) => !serviceID || item.serviceId === serviceID)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </Select>
            </Field>
          </div>
          <div className={styles.actions}>
            <Button
              appearance="primary"
              disabled={saving || !serviceID || !planID}
              onClick={() =>
                void saveCandidate(
                  () =>
                    backend.confirmIdentificationCandidate({
                      candidateId: candidate.id,
                      serviceId: serviceID,
                      planId: planID,
                    }),
                  "候補を確認済みにしました。",
                )
              }
            >
              確認
            </Button>
            <Button
              disabled={saving}
              onClick={() =>
                void saveCandidate(
                  () => backend.rejectIdentificationCandidate(candidate.id),
                  "候補を対象外にしました。",
                )
              }
            >
              対象外
            </Button>
            <Button
              disabled={saving || candidate.state === "unconfirmed"}
              onClick={() =>
                void saveCandidate(
                  () => backend.releaseIdentificationCandidate(candidate.id),
                  "候補の確認を解除しました。",
                )
              }
            >
              確認解除
            </Button>
          </div>
          <form
            className={styles.form}
            onSubmit={(event) => {
              event.preventDefault();
              void saveCandidate(
                () =>
                  backend.correctIdentificationCandidate({
                    candidateId: candidate.id,
                    ...correction,
                  }),
                "候補を修正しました。",
              );
            }}
          >
            <Subtitle1 as="h3">原形の修正</Subtitle1>
            <Field label="生利用枠サービス識別子">
              <Input
                value={correction.rawLimitServiceIdentifier}
                onChange={(_, d) => {
                  setCorrection((v) => ({
                    ...v,
                    rawLimitServiceIdentifier: d.value,
                  }));
                  setDirty(true);
                }}
              />
            </Field>
            <Field label="生報告プラン名">
              <Input
                value={correction.rawReportedPlanName}
                onChange={(_, d) => {
                  setCorrection((v) => ({
                    ...v,
                    rawReportedPlanName: d.value,
                  }));
                  setDirty(true);
                }}
              />
            </Field>
            <Button type="submit" disabled={saving}>
              修正を保存
            </Button>
          </form>
          {(candidate.observations ?? []).length > 0 && (
            <div className={styles.form}>
              <Subtitle1 as="h3">観測を選択して分割</Subtitle1>
              {(candidate.observations ?? []).map((observation) => (
                <Checkbox
                  key={observation.id}
                  label={`${hubDisplayName(observation.hubId, hubs)} / ${formatInstant(observation.observedAt, displayTimeZone)}`}
                  checked={splitIDs.includes(observation.id)}
                  onChange={(_, data) => {
                    setSplitIDs((ids) =>
                      data.checked
                        ? [...ids, observation.id]
                        : ids.filter((id) => id !== observation.id),
                    );
                    setDirty(true);
                  }}
                />
              ))}
              <Button
                disabled={saving || splitIDs.length === 0}
                onClick={() => {
                  const input: CandidateSplitInput = {
                    sourceCandidateId: candidate.id,
                    rawLimitServiceIdentifier:
                      correction.rawLimitServiceIdentifier,
                    rawReportedPlanName: correction.rawReportedPlanName,
                    observationIds: splitIDs,
                  };
                  void saveCandidate(
                    () => backend.splitIdentificationCandidate(input),
                    "観測を分割しました。",
                  );
                }}
              >
                選択観測で分割
              </Button>
            </div>
          )}
        </article>
      )}
    </>
  );
}

function LabelChangeList({
  backend,
  candidates,
  limits,
  hubs,
  displayTimeZone,
  runSave,
  setDirty,
  saving,
}: {
  backend: FrontendAdapter;
  candidates: NonNullable<CatalogSnapshot["labelChangeCandidates"]>;
  limits: NonNullable<CatalogSnapshot["limitDefinitions"]>;
  hubs: HubSnapshot[];
  displayTimeZone: string;
  runSave: (action: () => Promise<void>, message: string) => Promise<boolean>;
  setDirty: (dirty: boolean) => void;
  saving: boolean;
}) {
  const styles = useStyles();
  const [selectedLimits, setSelectedLimits] = useState<Record<string, string>>(
    {},
  );
  return (
    <div className={styles.list}>
      <Subtitle1 as="h2">利用枠名称変更候補</Subtitle1>
      {candidates.map((candidate) => {
        const limitID = selectedLimits[candidate.id] ?? "";
        return (
          <article className={styles.card} key={candidate.id}>
            <div className={styles.raw}>
              {candidate.oldLabel} → {candidate.newLabel}
            </div>
            <div className={styles.meta}>
              Hub: {hubDisplayName(candidate.hubId, hubs)} / 端末:{" "}
              {candidate.deviceRecordKey} / 生 識別子:{" "}
              {candidate.rawLimitServiceIdentifier}
            </div>
            <div className={styles.meta}>
              kind: {candidate.normalizedKind} / metric:{" "}
              {candidate.normalizedMetric} / 観測期間:{" "}
              {formatInstant(candidate.firstObservedAt, displayTimeZone)} ～{" "}
              {formatInstant(
                candidate.lastObservedAt,
                displayTimeZone,
                "継続中",
              )}
            </div>
            <div className={styles.evidence}>
              {(candidate.windows ?? []).map((window) => (
                <div key={window.id}>
                  {window.windowKey} / {window.label} /{" "}
                  {formatInstant(window.observedAt, displayTimeZone)}
                </div>
              ))}
            </div>
            <Field label="同じ利用枠として確認する定義">
              <Select
                value={limitID}
                onChange={(event) => {
                  setSelectedLimits((current) => ({
                    ...current,
                    [candidate.id]: event.target.value,
                  }));
                  setDirty(true);
                }}
              >
                <option value="">選択してください</option>
                {limits.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.meaning} / {item.unit}
                  </option>
                ))}
              </Select>
            </Field>
            <div className={styles.actions}>
              <Button
                disabled={saving || !limitID}
                onClick={() => {
                  const input: LabelChangeDecisionInput = {
                    candidateId: candidate.id,
                    state: "confirmed_same_limit",
                    limitDefinitionId: limitID,
                  };
                  void runSave(
                    () => backend.decideLabelChangeCandidate(input),
                    "同じ利用枠として確認しました。",
                  ).then((saved) => {
                    if (saved) setDirty(false);
                  });
                }}
              >
                同じ利用枠
              </Button>
              <Button
                disabled={saving}
                onClick={() =>
                  void runSave(
                    () =>
                      backend.decideLabelChangeCandidate({
                        candidateId: candidate.id,
                        state: "confirmed_different_limit",
                        limitDefinitionId: "",
                      }),
                    "別の利用枠として確認しました。",
                  ).then((saved) => {
                    if (saved) setDirty(false);
                  })
                }
              >
                別の利用枠
              </Button>
              <Button
                disabled={saving}
                onClick={() =>
                  void runSave(
                    () =>
                      backend.decideLabelChangeCandidate({
                        candidateId: candidate.id,
                        state: "rejected",
                        limitDefinitionId: "",
                      }),
                    "名称変更候補を対象外にしました。",
                  ).then((saved) => {
                    if (saved) setDirty(false);
                  })
                }
              >
                対象外
              </Button>
              <Button
                disabled={saving}
                onClick={() =>
                  void runSave(
                    () =>
                      backend.decideLabelChangeCandidate({
                        candidateId: candidate.id,
                        state: "unconfirmed",
                        limitDefinitionId: "",
                      }),
                    "名称変更候補を未確認へ戻しました。",
                  ).then((saved) => {
                    if (saved) setDirty(false);
                  })
                }
              >
                確認解除
              </Button>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function LimitsTab({
  backend,
  services,
  limits,
  runSave,
  setDirty,
  saving,
}: {
  backend: FrontendAdapter;
  services: ServiceSnapshot[];
  limits: NonNullable<CatalogSnapshot["limitDefinitions"]>;
  runSave: (action: () => Promise<void>, message: string) => Promise<boolean>;
  setDirty: (dirty: boolean) => void;
  saving: boolean;
}) {
  const styles = useStyles();
  const [value, setValue] = useState<LimitDefinitionInput>({
    id: "",
    serviceId: "",
    cycleType: "weekly",
    meaning: "",
    unit: "",
    billingConfirmation: "not_applicable",
  });
  const submit = () => {
    if (!value.serviceId || !value.cycleType || !value.meaning || !value.unit)
      return;
    void runSave(
      () =>
        value.id
          ? backend.updateLimitDefinition(value)
          : backend.createLimitDefinition(value),
      "利用枠定義を保存しました。",
    ).then((saved) => {
      if (!saved) return;
      setValue({
        id: "",
        serviceId: "",
        cycleType: "weekly",
        meaning: "",
        unit: "",
        billingConfirmation: "not_applicable",
      });
      setDirty(false);
    });
  };
  return (
    <>
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Subtitle1 as="h2">利用枠定義</Subtitle1>
        <div className={styles.grid}>
          <Field label="サービス">
            <Select
              value={value.serviceId}
              onChange={(event) => {
                setValue((v) => ({ ...v, serviceId: event.target.value }));
                setDirty(true);
              }}
            >
              <option value="">選択してください</option>
              {services.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.provider} / {item.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="周期種別">
            <Input
              value={value.cycleType}
              placeholder="weekly / billing"
              onChange={(_, d) => {
                setValue((v) => ({
                  ...v,
                  cycleType: d.value,
                  billingConfirmation:
                    d.value === "billing" ? "unconfirmed" : "not_applicable",
                }));
                setDirty(true);
              }}
            />
          </Field>
          <Field label="意味">
            <Input
              value={value.meaning}
              onChange={(_, d) => {
                setValue((v) => ({ ...v, meaning: d.value }));
                setDirty(true);
              }}
            />
          </Field>
          <Field label="単位">
            <Input
              value={value.unit}
              onChange={(_, d) => {
                setValue((v) => ({ ...v, unit: d.value }));
                setDirty(true);
              }}
            />
          </Field>
          {value.cycleType === "billing" && (
            <Field label="billing の月次確認">
              <Select
                value={value.billingConfirmation}
                onChange={(event) => {
                  setValue((v) => ({
                    ...v,
                    billingConfirmation: event.target.value,
                  }));
                  setDirty(true);
                }}
              >
                <option value="unconfirmed">未確認</option>
                <option value="confirmed">月次利用枠として確認済み</option>
              </Select>
            </Field>
          )}
        </div>
        <Button appearance="primary" type="submit" disabled={saving}>
          保存
        </Button>
      </form>
      <div className={styles.grid}>
        {limits.map((item) => (
          <article className={styles.card} key={item.id}>
            <Subtitle1 as="h3">
              {item.meaning} / {item.unit}
            </Subtitle1>
            <div>
              {serviceName(services, item.serviceId)} / 周期:{" "}
              {cycleTypeLabel(item.cycleType)}
            </div>
            <div className={styles.meta}>
              billing:{" "}
              <StatusBadge status={billingStatus(item.billingConfirmation)} />
            </div>
            <Button
              onClick={() => {
                setValue({
                  id: item.id,
                  serviceId: item.serviceId,
                  cycleType: item.cycleType,
                  meaning: item.meaning,
                  unit: item.unit,
                  billingConfirmation: item.billingConfirmation,
                });
                setDirty(true);
              }}
            >
              編集
            </Button>
          </article>
        ))}
      </div>
    </>
  );
}

function PlansTab({
  backend,
  services,
  plans,
  runSave,
  setDirty,
  saving,
}: {
  backend: FrontendAdapter;
  services: ServiceSnapshot[];
  plans: NonNullable<CatalogSnapshot["plans"]>;
  runSave: (action: () => Promise<void>, message: string) => Promise<boolean>;
  setDirty: (dirty: boolean) => void;
  saving: boolean;
}) {
  const styles = useStyles();
  const [value, setValue] = useState<PlanInput>({
    id: "",
    serviceId: "",
    name: "",
    isBaseline: false,
  });
  const savePlan = () => {
    if (!value.serviceId || !value.name.trim()) return;
    const existing = plans.find((item) => item.id === value.id);
    const input = { ...value, isBaseline: existing?.isBaseline ?? false };
    void runSave(
      () =>
        value.id
          ? backend.updatePlan(input)
          : backend.createPlan({ ...value, isBaseline: false }),
      "プランを保存しました。",
    ).then((saved) => {
      if (!saved) return;
      setValue({ id: "", serviceId: "", name: "", isBaseline: false });
      setDirty(false);
    });
  };
  return (
    <>
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          savePlan();
        }}
      >
        <Subtitle1 as="h2">プラン・基準プラン</Subtitle1>
        <div className={styles.grid}>
          <Field label="サービス">
            <Select
              value={value.serviceId}
              onChange={(event) => {
                setValue((v) => ({ ...v, serviceId: event.target.value }));
                setDirty(true);
              }}
            >
              <option value="">選択してください</option>
              {services.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.provider} / {item.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="プラン名">
            <Input
              value={value.name}
              onChange={(_, d) => {
                setValue((v) => ({ ...v, name: d.value }));
                setDirty(true);
              }}
            />
          </Field>
          <div className={styles.meta}>
            基準プランの変更は、保存後に一覧の「基準にする」操作で確定します。
          </div>
        </div>
        <Button appearance="primary" type="submit" disabled={saving}>
          保存
        </Button>
      </form>
      <div className={styles.grid}>
        {plans.map((item) => (
          <article className={styles.card} key={item.id}>
            <Subtitle1 as="h3">
              {item.name}
              {item.isBaseline ? "（基準）" : ""}
            </Subtitle1>
            <div>{serviceName(services, item.serviceId)}</div>
            <div className={styles.actions}>
              <Button
                onClick={() => {
                  setValue({
                    id: item.id,
                    serviceId: item.serviceId,
                    name: item.name,
                    isBaseline: item.isBaseline,
                  });
                  setDirty(true);
                }}
              >
                編集
              </Button>
              <Button
                disabled={saving || item.isBaseline}
                onClick={() => {
                  void runSave(
                    () => backend.setBaselinePlan(item.serviceId, item.id),
                    "基準プランを変更しました。",
                  );
                }}
              >
                基準にする
              </Button>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}

function VersionsTab({
  backend,
  plans,
  versions,
  limits,
  rules,
  displayTimeZone,
  runSave,
  setVersionDirty,
  setRuleDirty,
  saving,
}: {
  backend: FrontendAdapter;
  plans: NonNullable<CatalogSnapshot["plans"]>;
  versions: NonNullable<CatalogSnapshot["planVersions"]>;
  limits: NonNullable<CatalogSnapshot["limitDefinitions"]>;
  rules: NonNullable<CatalogSnapshot["planLimitRules"]>;
  displayTimeZone: string;
  runSave: (action: () => Promise<void>, message: string) => Promise<boolean>;
  setVersionDirty: (dirty: boolean) => void;
  setRuleDirty: (dirty: boolean) => void;
  saving: boolean;
}) {
  const styles = useStyles();
  const [version, setVersion] = useState<PlanVersionInput>({
    id: "",
    planId: "",
    name: "",
    validFrom: "",
    validTo: "",
    officialSourceUrl: "",
  });
  const [rule, setRule] = useState<PlanLimitRuleInput>({
    id: "",
    planVersionId: "",
    limitDefinitionId: "",
    limit: null,
    multiplier: null,
    officialSourceUrl: "",
  });
  const saveVersion = () => {
    if (
      !version.planId ||
      !version.name ||
      !version.validFrom ||
      !version.officialSourceUrl
    )
      return;
    const input = {
      ...version,
      validFrom: toUTC(version.validFrom),
      validTo: toUTC(version.validTo),
    };
    void runSave(
      () => backend.createPlanVersion(input),
      "追記型プラン版を保存しました。",
    ).then((saved) => {
      if (!saved) return;
      setVersion({
        id: "",
        planId: "",
        name: "",
        validFrom: "",
        validTo: "",
        officialSourceUrl: "",
      });
      setVersionDirty(false);
    });
  };
  const saveRule = () => {
    if (
      !rule.planVersionId ||
      !rule.limitDefinitionId ||
      !rule.officialSourceUrl
    )
      return;
    void runSave(
      () => backend.createPlanLimitRule(rule),
      "利用上限倍率と根拠 URL を保存しました。",
    ).then((saved) => {
      if (!saved) return;
      setRule({
        id: "",
        planVersionId: "",
        limitDefinitionId: "",
        limit: null,
        multiplier: null,
        officialSourceUrl: "",
      });
      setRuleDirty(false);
    });
  };
  return (
    <>
      <div className={styles.meta}>
        既存のプラン版は上書きせず、属性変更は新しい版として登録します。同じプランの期間重複は保存時に拒否されます。
      </div>
      <div className={styles.grid}>
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            saveVersion();
          }}
        >
          <Subtitle1 as="h2">追記型プラン版</Subtitle1>
          <Field label="プラン">
            <Select
              value={version.planId}
              onChange={(event) => {
                setVersion((v) => ({ ...v, planId: event.target.value }));
                setVersionDirty(true);
              }}
            >
              <option value="">選択してください</option>
              {plans.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="版の名称">
            <Input
              value={version.name}
              onChange={(_, d) => {
                setVersion((v) => ({ ...v, name: d.value }));
                setVersionDirty(true);
              }}
            />
          </Field>
          <PeriodFields
            from={version.validFrom}
            to={version.validTo}
            onChange={(validFrom, validTo) => {
              setVersion((v) => ({ ...v, validFrom, validTo }));
              setVersionDirty(true);
            }}
          />
          <Field label="公式根拠 URL">
            <Input
              type="url"
              value={version.officialSourceUrl}
              onChange={(_, d) => {
                setVersion((v) => ({ ...v, officialSourceUrl: d.value }));
                setVersionDirty(true);
              }}
            />
          </Field>
          <Button appearance="primary" type="submit" disabled={saving}>
            プラン版を追加
          </Button>
        </form>
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            saveRule();
          }}
        >
          <Subtitle1 as="h2">プラン版 × 利用枠定義</Subtitle1>
          <Field label="プラン版">
            <Select
              value={rule.planVersionId}
              onChange={(event) => {
                setRule((v) => ({ ...v, planVersionId: event.target.value }));
                setRuleDirty(true);
              }}
            >
              <option value="">選択してください</option>
              {versions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} ({formatInstant(item.validFrom, displayTimeZone)})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="利用枠定義">
            <Select
              value={rule.limitDefinitionId}
              onChange={(event) => {
                setRule((v) => ({
                  ...v,
                  limitDefinitionId: event.target.value,
                }));
                setRuleDirty(true);
              }}
            >
              <option value="">選択してください</option>
              {limits.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.meaning} / {item.unit}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="利用上限（任意）">
            <Input
              type="number"
              min={0}
              value={String(rule.limit ?? "")}
              onChange={(_, d) => {
                setRule((v) => ({
                  ...v,
                  limit: d.value === "" ? null : Number(d.value),
                }));
                setRuleDirty(true);
              }}
            />
          </Field>
          <Field label="利用上限倍率（任意）">
            <Input
              type="number"
              min={0}
              step="any"
              value={String(rule.multiplier ?? "")}
              onChange={(_, d) => {
                setRule((v) => ({
                  ...v,
                  multiplier: d.value === "" ? null : Number(d.value),
                }));
                setRuleDirty(true);
              }}
            />
          </Field>
          <Field label="公式根拠 URL">
            <Input
              type="url"
              value={rule.officialSourceUrl}
              onChange={(_, d) => {
                setRule((v) => ({ ...v, officialSourceUrl: d.value }));
                setRuleDirty(true);
              }}
            />
          </Field>
          <Button appearance="primary" type="submit" disabled={saving}>
            倍率を保存
          </Button>
        </form>
      </div>
      <div className={styles.list}>
        {versions.map((item) => (
          <article className={styles.card} key={item.id}>
            <Subtitle1 as="h3">{item.name}</Subtitle1>
            <div>
              {planName(plans, item.planId)} / [
              {formatInstant(item.validFrom, displayTimeZone)},{" "}
              {formatInstant(item.validTo, displayTimeZone, "∞")})
            </div>
            <div className={styles.meta}>根拠: {item.officialSourceUrl}</div>
            {rules
              .filter((rule) => rule.planVersionId === item.id)
              .map((rule) => (
                <div className={styles.evidence} key={rule.id}>
                  利用枠: {limitName(limits, rule.limitDefinitionId)} / 上限:{" "}
                  {rule.limit ?? "—"} / 倍率: {rule.multiplier ?? "—"} / 根拠:{" "}
                  {rule.officialSourceUrl}
                </div>
              ))}
          </article>
        ))}
      </div>
    </>
  );
}

function PricesTab({
  backend,
  plans,
  versions,
  prices,
  displayTimeZone,
  runSave,
  setDirty,
  saving,
}: {
  backend: FrontendAdapter;
  plans: NonNullable<CatalogSnapshot["plans"]>;
  versions: NonNullable<CatalogSnapshot["planVersions"]>;
  prices: NonNullable<CatalogSnapshot["standardPrices"]>;
  displayTimeZone: string;
  runSave: (action: () => Promise<void>, message: string) => Promise<boolean>;
  setDirty: (dirty: boolean) => void;
  saving: boolean;
}) {
  const styles = useStyles();
  const empty: StandardPriceInput = {
    id: "",
    planVersionId: "",
    usdMonthlyPerSeat: 0,
    sourceUrl: "",
    validFrom: "",
    validTo: "",
  };
  const [price, setPrice] = useState<StandardPriceInput>(empty);
  const save = async () => {
    const input = {
      ...price,
      validFrom: toUTC(price.validFrom),
      validTo: toUTC(price.validTo),
    };
    if (
      !input.planVersionId ||
      input.usdMonthlyPerSeat <= 0 ||
      !input.sourceUrl.trim() ||
      !input.validFrom
    )
      return;
    const saved = await runSave(
      () =>
        input.id
          ? backend.updateStandardPrice(input)
          : backend.createStandardPrice(input),
      "USD 建て月額標準シート単価を保存しました。",
    );
    if (saved) {
      setPrice(empty);
      setDirty(false);
    }
  };
  return (
    <>
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Subtitle1 as="h2">
          {price.id ? "標準価格を編集" : "標準価格を登録"}
        </Subtitle1>
        <Body1>
          USD
          建ての月額標準シート単価だけを登録します。年払い、割引、税、実請求額、為替換算値は使用しません。
        </Body1>
        <Field label="プラン版">
          <Select
            value={price.planVersionId}
            onChange={(event) => {
              setPrice((current) => ({
                ...current,
                planVersionId: event.target.value,
              }));
              setDirty(true);
            }}
          >
            <option value="">選択してください</option>
            {versions.map((version) => (
              <option key={version.id} value={version.id}>
                {planName(plans, version.planId)} / {version.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="USD 月額 / 1シート">
          <Input
            type="number"
            min={0.01}
            step={0.01}
            value={String(price.usdMonthlyPerSeat || "")}
            onChange={(_, data) => {
              setPrice((current) => ({
                ...current,
                usdMonthlyPerSeat: Number(data.value),
              }));
              setDirty(true);
            }}
          />
        </Field>
        <Field label="出典 URL">
          <Input
            type="url"
            value={price.sourceUrl}
            onChange={(_, data) => {
              setPrice((current) => ({
                ...current,
                sourceUrl: data.value,
              }));
              setDirty(true);
            }}
          />
        </Field>
        <PeriodFields
          from={price.validFrom}
          to={price.validTo}
          onChange={(validFrom, validTo) => {
            setPrice((current) => ({ ...current, validFrom, validTo }));
            setDirty(true);
          }}
        />
        <div className={styles.actions}>
          <Button type="submit" appearance="primary" disabled={saving}>
            保存
          </Button>
          <Button
            type="button"
            onClick={() => {
              setPrice(empty);
              setDirty(false);
            }}
          >
            クリア
          </Button>
        </div>
      </form>
      <div className={styles.list} aria-label="標準価格一覧">
        {prices.length === 0 ? (
          <Body1>標準価格はまだありません。</Body1>
        ) : (
          prices.map((item) => {
            const version = versions.find(
              (candidate) => candidate.id === item.planVersionId,
            );
            return (
              <article className={styles.card} key={item.id}>
                <div className={styles.sectionTitle}>
                  <Subtitle1 as="h2">
                    {version
                      ? `${planName(plans, version.planId)} / ${version.name}`
                      : "プラン版未表示"}
                  </Subtitle1>
                  <Button
                    onClick={() => {
                      setPrice({
                        id: item.id,
                        planVersionId: item.planVersionId,
                        usdMonthlyPerSeat: item.usdMonthlyPerSeat,
                        sourceUrl: item.sourceUrl,
                        validFrom: toDateTimeInput(item.validFrom),
                        validTo: toDateTimeInput(item.validTo),
                      });
                      setDirty(true);
                    }}
                  >
                    編集
                  </Button>
                </div>
                <Body1>
                  ${item.usdMonthlyPerSeat.toFixed(2)} / 月 / 1シート
                </Body1>
                <a href={item.sourceUrl} target="_blank" rel="noreferrer">
                  価格の出典
                </a>
                <div className={styles.meta}>
                  {formatInstant(item.validFrom, displayTimeZone)} ～{" "}
                  {formatInstant(item.validTo, displayTimeZone, "継続中")}
                </div>
              </article>
            );
          })
        )}
      </div>
    </>
  );
}

function PeriodFields({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
}) {
  return (
    <div style={{ display: "grid", gap: tokens.spacingVerticalS }}>
      <Field label="開始（UTC）">
        <Input
          type="datetime-local"
          value={from}
          onChange={(_, d) => onChange(d.value, to)}
        />
      </Field>
      <Field label="終了（UTC・含まない）">
        <Input
          type="datetime-local"
          value={to}
          onChange={(_, d) => onChange(from, d.value)}
        />
      </Field>
    </div>
  );
}
function toUTC(value: string): string {
  if (!value) return "";
  const date = new Date(`${value}:00Z`);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}
function toDateTimeInput(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 16);
}
function serviceName(services: ServiceSnapshot[], id: string): string {
  const service = services.find((item) => item.id === id);
  return service ? `${service.provider} / ${service.name}` : "サービス未表示";
}
function planName(
  plans: NonNullable<CatalogSnapshot["plans"]>,
  id: string,
): string {
  return plans.find((item) => item.id === id)?.name ?? "プラン未表示";
}

function limitName(
  limits: NonNullable<CatalogSnapshot["limitDefinitions"]>,
  id: string,
): string {
  const limit = limits.find((item) => item.id === id);
  return limit ? `${limit.meaning} / ${limit.unit}` : "利用枠定義未表示";
}

function hubDisplayName(hubID: string, hubs: HubSnapshot[]): string {
  return hubs.find((hub) => hub.id === hubID)?.displayName || "Hub未表示";
}

function catalogCandidateStatus(state: string): StatusPresentationSnapshot {
  const statuses: Record<
    string,
    [
      string,
      StatusPresentationSnapshot["intent"],
      StatusPresentationSnapshot["icon"],
    ]
  > = {
    unconfirmed: ["未確認", "warning", "warning"],
    confirmed: ["確認済み", "success", "checkmark"],
    rejected: ["対象外", "subtle", "info"],
  };
  const [label, intent, icon] = statuses[state] ?? [
    "状態を確認",
    "warning",
    "warning",
  ];
  return catalogStatusSnapshot(
    state,
    label,
    intent,
    icon,
    "同定候補の状態です。",
  );
}

function billingStatus(state: string): StatusPresentationSnapshot {
  const statuses: Record<
    string,
    [
      string,
      StatusPresentationSnapshot["intent"],
      StatusPresentationSnapshot["icon"],
    ]
  > = {
    unconfirmed: ["未確認", "warning", "warning"],
    confirmed: ["月次利用枠として確認済み", "success", "checkmark"],
    not_applicable: ["対象外", "subtle", "info"],
  };
  const [label, intent, icon] = statuses[state] ?? [
    "状態を確認",
    "warning",
    "warning",
  ];
  return catalogStatusSnapshot(
    state,
    label,
    intent,
    icon,
    "月次確認の状態です。",
  );
}

function catalogStatusSnapshot(
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
  emptyLabel = "—",
): string {
  if (!value) return emptyLabel;
  try {
    return `${formatOverviewInstant(value, timeZone)}（UTC ${value}）`;
  } catch {
    return "日時不明";
  }
}
function errorMessage(cause: unknown): string {
  return cause instanceof Error
    ? cause.message
    : "カタログ操作に失敗しました。入力と期間を確認してください。";
}
