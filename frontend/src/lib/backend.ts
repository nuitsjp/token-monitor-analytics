import { Events } from "@wailsio/runtime";
import {
  AccountService,
  AuditService,
  CatalogService,
  CollectionService,
  EstimationService,
  HubService,
  OverviewService,
  ReviewService,
  SettingsService,
  WindowService,
} from "../../bindings/token-monitor-analytics/internal/desktop/index.js";
import type {
  AccountSnapshot,
  AuditFilterInput,
  AuditPage,
  AuditRecord,
  CollectionAttemptSnapshot,
  CostObservationSnapshot,
  CandidateCorrectionInput,
  CandidateDecisionInput,
  CandidateSplitInput,
  CatalogSnapshot,
  CreateHubInput,
  CreateLogicalAccountFromCandidateInput,
  CreateLogicalAccountInput,
  CreatePlanHistoryInput,
  CreateServiceInput,
  HubSnapshot,
  LimitObservationSnapshot,
  OverviewSnapshot,
  LabelChangeDecisionInput,
  LimitDefinitionInput,
  PlanInput,
  PlanLimitRuleInput,
  PlanVersionInput,
  RawSnapshotDetail,
  RawSnapshotSnapshot,
  ReviewFilterInput,
  ReviewItemSnapshot,
  ReviewPage,
  ServiceIdentifierMappingInput,
  ServiceSnapshot,
  SplitLogicalAccountInput,
  StandardPriceInput,
  UpdateHubInput,
  UpdateLogicalAccountInput,
  UpdatePlanHistoryInput,
  UpdateServiceInput,
  HubSwitchInput,
  HubSwitchSnapshot,
  ImpactPreviewSnapshot,
  LinkingSnapshot,
  UsageCostAssociationInput,
  UsageCostAssociationSnapshot,
  UsageCostSourceCompletenessInput,
  UsageCostSourceCompletenessSnapshot,
  UsageLimitAssociationInput,
  UsageLimitAssociationSnapshot,
  LimitSeriesFilterInput,
  LimitSeriesSnapshot,
  LimitSeriesDetailSnapshot,
} from "../../bindings/token-monitor-analytics/internal/desktop/models.js";

export type ThemePreference = "light" | "dark" | "system";

export type {
  AccountSnapshot,
  AuditFilterInput,
  AuditPage,
  AuditRecord,
  CollectionAttemptSnapshot,
  CostObservationSnapshot,
  CandidateCorrectionInput,
  CandidateDecisionInput,
  CandidateSplitInput,
  CatalogSnapshot,
  CreateServiceInput,
  CreateLogicalAccountFromCandidateInput,
  CreateLogicalAccountInput,
  CreatePlanHistoryInput,
  HubSnapshot,
  IdentificationCandidateSnapshot,
  LabelChangeCandidateSnapshot,
  LabelChangeDecisionInput,
  LimitDefinitionInput,
  LimitObservationSnapshot,
  OverviewSnapshot,
  PlanInput,
  PlanLimitRuleInput,
  PlanVersionInput,
  RawSnapshotDetail,
  RawSnapshotSnapshot,
  ReviewFilterInput,
  ReviewItemSnapshot,
  ReviewPage,
  ServiceIdentifierMappingInput,
  ServiceSnapshot,
  SplitLogicalAccountInput,
  StandardPriceInput,
  UpdateLogicalAccountInput,
  UpdatePlanHistoryInput,
  UpdateServiceInput,
  HubSwitchInput,
  HubSwitchSnapshot,
  ImpactPreviewSnapshot,
  LinkingSnapshot,
  UsageCostAssociationInput,
  UsageCostAssociationSnapshot,
  UsageCostSourceCompletenessInput,
  UsageCostSourceCompletenessSnapshot,
  UsageLimitAssociationInput,
  UsageLimitAssociationSnapshot,
  LimitSeriesFilterInput,
  LimitSeriesSnapshot,
  LimitSeriesDetailSnapshot,
  EstimationEvidenceSnapshot,
} from "../../bindings/token-monitor-analytics/internal/desktop/models.js";

export type {
  LogicalAccountSnapshot,
  PlanHistorySnapshot,
  PlanVersionSnapshot,
} from "../../bindings/token-monitor-analytics/internal/desktop/models.js";

export interface SettingsSnapshot {
  theme: ThemePreference;
  displayTimeZone: string;
  ianaTimeZones: readonly string[];
  systemDark?: boolean;
}

export interface SettingsServiceAdapter {
  getSettings(): Promise<SettingsSnapshot> | SettingsSnapshot;
  saveSettings(
    settings: Pick<SettingsSnapshot, "theme" | "displayTimeZone">,
  ): Promise<SettingsSnapshot> | SettingsSnapshot;
}

export type FrontendEventName =
  | "app:quit-requested"
  | "window:main-close-requested"
  | "navigation:open"
  | "settings:theme-changed";

export interface FrontendAdapter {
  readonly canOpenMain: boolean;
  readonly initialSettings: SettingsSnapshot;
  getSettings(): Promise<SettingsSnapshot>;
  saveSettings(
    settings: Pick<SettingsSnapshot, "theme" | "displayTimeZone">,
  ): Promise<SettingsSnapshot>;
  OpenMain(): Promise<void>;
  OpenMainRoute(route: string): Promise<void>;
  SetCompactExpanded(expanded: boolean): Promise<void>;
  SetMainDirty(dirty: boolean): Promise<void>;
  ConfirmCloseMain(): Promise<void>;
  ConfirmQuit(): Promise<void>;
  getOverview(privacyMode: boolean): Promise<OverviewSnapshot>;
  getLimitSeries(input: LimitSeriesFilterInput): Promise<LimitSeriesSnapshot[]>;
  getLimitSeriesDetail(seriesID: string): Promise<LimitSeriesDetailSnapshot>;
  getHubs(): Promise<HubSnapshot[]>;
  createHub(input: CreateHubInput): Promise<HubSnapshot>;
  updateHub(input: UpdateHubInput): Promise<HubSnapshot>;
  setHubCollectionEnabled(
    hubID: string,
    enabled: boolean,
  ): Promise<HubSnapshot>;
  setHubEnabled(hubID: string, enabled: boolean): Promise<HubSnapshot>;
  saveCredential(hubID: string, secret: string): Promise<HubSnapshot>;
  deleteCredential(hubID: string): Promise<HubSnapshot>;
  checkHubConnection(hubID: string): Promise<HubSnapshot>;
  startCollection(hubID: string): Promise<void>;
  stopCollection(hubID: string): Promise<void>;
  collectNow(hubID: string): Promise<void>;
  getCollectionAttempts(hubID: string): Promise<CollectionAttemptSnapshot[]>;
  getRawSnapshots(hubID: string): Promise<RawSnapshotSnapshot[]>;
  getRawSnapshot(snapshotID: string): Promise<RawSnapshotDetail>;
  getCostObservations(hubID: string): Promise<CostObservationSnapshot[]>;
  getLimitObservations(hubID: string): Promise<LimitObservationSnapshot[]>;
  getAudits(filter: AuditFilterInput): Promise<AuditPage>;
  getReviewItems(filter: ReviewFilterInput): Promise<ReviewPage>;
  getCatalog(): Promise<CatalogSnapshot>;
  getAccounts(): Promise<AccountSnapshot>;
  getHubAccountCandidates(
    serviceID: string,
    state: string,
  ): Promise<NonNullable<AccountSnapshot["hubAccountCandidates"]>>;
  getLogicalAccounts(
    serviceID: string,
    includeArchived: boolean,
  ): Promise<NonNullable<AccountSnapshot["logicalAccounts"]>>;
  getPlanHistories(
    logicalAccountID: string,
  ): Promise<NonNullable<AccountSnapshot["planHistories"]>>;
  createLogicalAccount(
    input: CreateLogicalAccountInput,
  ): Promise<NonNullable<AccountSnapshot["logicalAccounts"]>[number]>;
  updateLogicalAccount(input: UpdateLogicalAccountInput): Promise<void>;
  archiveLogicalAccount(accountID: string): Promise<void>;
  restoreLogicalAccount(accountID: string): Promise<void>;
  createLogicalAccountFromCandidate(
    input: CreateLogicalAccountFromCandidateInput,
  ): Promise<NonNullable<AccountSnapshot["logicalAccounts"]>[number]>;
  associateHubAccountCandidate(
    candidateID: string,
    logicalAccountID: string,
  ): Promise<void>;
  rejectHubAccountCandidate(candidateID: string): Promise<void>;
  releaseHubAccountCandidate(candidateID: string): Promise<void>;
  splitLogicalAccount(
    input: SplitLogicalAccountInput,
  ): Promise<NonNullable<AccountSnapshot["logicalAccounts"]>[number]>;
  mergeLogicalAccounts(sourceID: string, targetID: string): Promise<void>;
  createPlanHistory(
    input: CreatePlanHistoryInput,
  ): Promise<NonNullable<AccountSnapshot["planHistories"]>[number]>;
  updatePlanHistory(input: UpdatePlanHistoryInput): Promise<void>;
  getLinkingSnapshot(): Promise<LinkingSnapshot>;
  createUsageCostAssociation(
    input: UsageCostAssociationInput,
  ): Promise<UsageCostAssociationSnapshot>;
  updateUsageCostAssociation(input: UsageCostAssociationInput): Promise<void>;
  previewUsageCostAssociation(
    input: UsageCostAssociationInput,
  ): Promise<ImpactPreviewSnapshot>;
  createUsageLimitAssociation(
    input: UsageLimitAssociationInput,
  ): Promise<UsageLimitAssociationSnapshot>;
  updateUsageLimitAssociation(input: UsageLimitAssociationInput): Promise<void>;
  previewUsageLimitAssociation(
    input: UsageLimitAssociationInput,
  ): Promise<ImpactPreviewSnapshot>;
  previewUsageCostSourceCompleteness(
    input: UsageCostSourceCompletenessInput,
  ): Promise<ImpactPreviewSnapshot>;
  confirmUsageCostSourceCompleteness(
    input: UsageCostSourceCompletenessInput,
  ): Promise<UsageCostSourceCompletenessSnapshot>;
  updateUsageCostSourceCompleteness(
    input: UsageCostSourceCompletenessInput,
  ): Promise<void>;
  previewHubSwitch(input: HubSwitchInput): Promise<ImpactPreviewSnapshot>;
  confirmHubSwitch(input: HubSwitchInput): Promise<HubSwitchSnapshot>;
  createService(input: CreateServiceInput): Promise<ServiceSnapshot>;
  updateService(input: UpdateServiceInput): Promise<ServiceSnapshot>;
  archiveService(serviceID: string): Promise<void>;
  restoreService(serviceID: string): Promise<void>;
  createServiceIdentifierMapping(
    input: ServiceIdentifierMappingInput,
  ): Promise<void>;
  updateServiceIdentifierMapping(
    input: ServiceIdentifierMappingInput,
  ): Promise<void>;
  createLimitDefinition(input: LimitDefinitionInput): Promise<void>;
  updateLimitDefinition(input: LimitDefinitionInput): Promise<void>;
  setBillingConfirmation(
    definitionID: string,
    confirmation: string,
  ): Promise<void>;
  createPlan(input: PlanInput): Promise<void>;
  updatePlan(input: PlanInput): Promise<void>;
  setBaselinePlan(serviceID: string, planID: string): Promise<void>;
  createPlanVersion(input: PlanVersionInput): Promise<void>;
  createPlanLimitRule(input: PlanLimitRuleInput): Promise<void>;
  createStandardPrice(input: StandardPriceInput): Promise<void>;
  confirmIdentificationCandidate(input: CandidateDecisionInput): Promise<void>;
  rejectIdentificationCandidate(candidateID: string): Promise<void>;
  releaseIdentificationCandidate(candidateID: string): Promise<void>;
  correctIdentificationCandidate(
    input: CandidateCorrectionInput,
  ): Promise<void>;
  splitIdentificationCandidate(input: CandidateSplitInput): Promise<void>;
  decideLabelChangeCandidate(input: LabelChangeDecisionInput): Promise<void>;
  on(event: FrontendEventName, callback: (data: unknown) => void): () => void;
}

export const defaultSettings: SettingsSnapshot = {
  theme: "system",
  displayTimeZone: "UTC",
  ianaTimeZones: ["UTC", "Asia/Tokyo", "America/Los_Angeles", "Europe/London"],
  systemDark: false,
};

function asSettings(
  value: unknown,
  fallback: SettingsSnapshot,
): SettingsSnapshot {
  if (!value || typeof value !== "object") return fallback;
  const record = value as Record<string, unknown>;
  const theme = record.theme;
  const displayTimeZone = record.displayTimeZone;
  const zones = record.ianaTimeZones;
  return {
    theme:
      theme === "light" || theme === "dark" || theme === "system"
        ? theme
        : fallback.theme,
    displayTimeZone:
      typeof displayTimeZone === "string" && displayTimeZone.length > 0
        ? displayTimeZone
        : fallback.displayTimeZone,
    ianaTimeZones:
      Array.isArray(zones) && zones.every((zone) => typeof zone === "string")
        ? zones
        : fallback.ianaTimeZones,
    systemDark:
      typeof record.systemDark === "boolean"
        ? record.systemDark
        : fallback.systemDark,
  };
}

function asPromise<T>(value: Promise<T> | T): Promise<T> {
  return Promise.resolve(value);
}

export interface FakeBackendOptions {
  canOpenMain?: boolean;
  settings?: Partial<SettingsSnapshot>;
  onOpenMain?: () => void;
  onOpenMainRoute?: (route: string) => void;
  onSetCompactExpanded?: (expanded: boolean) => void;
  onSetMainDirty?: (dirty: boolean) => void;
  onConfirmCloseMain?: () => void;
  onConfirmQuit?: () => void;
  overview?: OverviewSnapshot;
  limitSeries?: LimitSeriesSnapshot[];
  limitSeriesDetails?: Record<string, LimitSeriesDetailSnapshot>;
  onGetOverview?: (
    privacyMode: boolean,
  ) => Promise<OverviewSnapshot> | OverviewSnapshot;
  hubs?: HubSnapshot[];
  collectionAttempts?: CollectionAttemptSnapshot[];
  rawSnapshots?: RawSnapshotDetail[];
  costObservations?: CostObservationSnapshot[];
  limitObservations?: LimitObservationSnapshot[];
  audits?: AuditRecord[];
  reviewItems?: ReviewItemSnapshot[];
  catalog?: Partial<CatalogSnapshot>;
  accounts?: Partial<AccountSnapshot>;
  linking?: Partial<LinkingSnapshot>;
}

export interface FakeFrontendAdapter extends FrontendAdapter {
  emit(event: FrontendEventName, data?: unknown): void;
}

const fakeStatus = (
  code: string,
  label: string,
  intent = "subtle",
): OverviewSnapshot["review"]["actionItems"]["status"] => ({
  code,
  label,
  intent,
  icon: "info",
  description: label,
  nextAction: "",
  nextRoute: "",
});

export const emptyOverviewSnapshot: OverviewSnapshot = {
  generatedAt: "2026-08-26T00:00:00Z",
  timezoneConfirmed: false,
  recoveryNotice: null,
  checklist: [
    {
      step: 1,
      title: "表示タイムゾーンを確認",
      status: fakeStatus("not_started", "未着手"),
      route: "/settings",
      actionable: true,
    },
  ],
  hubs: {
    totalCount: 0,
    enabledCount: 0,
    scheduledCount: 0,
    runningCount: 0,
    abnormalCount: 0,
    credentialReadyCount: 0,
    lastSuccessAt: "",
    connectionStates: [],
    currentCollectionStates: [],
    lastCollectionStates: [],
    items: [],
  },
  review: {
    actionItems: {
      status: fakeStatus("review_action_required", "要確認", "warning"),
      count: 0,
    },
    warnings: {
      status: fakeStatus("review_warning", "データ警告", "warning"),
      count: 0,
    },
    recalculationFailures: {
      status: fakeStatus("recalculation_failed", "処理失敗", "danger"),
      count: 0,
    },
    actionKinds: [],
    warningKinds: [],
  },
  estimation: { states: [] },
  capacity: {
    databaseSizeBytes: 0,
    rawSnapshotCount: 0,
    oldestSnapshotAt: "",
    latestSnapshotAt: "",
  },
  recentLimits: [],
};

/** A deterministic adapter for component tests and browser development. */
export function createFakeBackend(
  options: FakeBackendOptions = {},
): FakeFrontendAdapter {
  let settings = asSettings(
    { ...defaultSettings, ...options.settings },
    defaultSettings,
  );
  const limitSeries = [...(options.limitSeries ?? [])];
  const limitSeriesDetails = { ...(options.limitSeriesDetails ?? {}) };
  const listeners = new Map<FrontendEventName, Set<(data: unknown) => void>>();
  let hubs = [...(options.hubs ?? [])];
  const collectionAttempts = [...(options.collectionAttempts ?? [])];
  const rawSnapshots = [...(options.rawSnapshots ?? [])];
  const costObservations = [...(options.costObservations ?? [])];
  const limitObservations = [...(options.limitObservations ?? [])];
  const audits = [...(options.audits ?? [])];
  const reviewItems = [...(options.reviewItems ?? [])];
  let catalog = {
    services: options.catalog?.services ?? [],
    serviceIdentifierMappings: options.catalog?.serviceIdentifierMappings ?? [],
    limitDefinitions: options.catalog?.limitDefinitions ?? [],
    plans: options.catalog?.plans ?? [],
    planVersions: options.catalog?.planVersions ?? [],
    planLimitRules: options.catalog?.planLimitRules ?? [],
    standardPrices: options.catalog?.standardPrices ?? [],
    identificationCandidates: options.catalog?.identificationCandidates ?? [],
    labelChangeCandidates: options.catalog?.labelChangeCandidates ?? [],
  };
  let accounts: AccountSnapshot = {
    hubAccountCandidates: options.accounts?.hubAccountCandidates ?? [],
    logicalAccounts: options.accounts?.logicalAccounts ?? [],
    planHistories: options.accounts?.planHistories ?? [],
  };
  let linking: LinkingSnapshot = {
    usageCostSources: options.linking?.usageCostSources ?? [],
    usageLimitSources: options.linking?.usageLimitSources ?? [],
    usageCostAssociations: options.linking?.usageCostAssociations ?? [],
    usageLimitAssociations: options.linking?.usageLimitAssociations ?? [],
    usageCostSourceCompleteness:
      options.linking?.usageCostSourceCompleteness ?? [],
    hubSwitches: options.linking?.hubSwitches ?? [],
  };
  const accountNow = () => new Date().toISOString();
  const accountWithUpdatedAt = <T extends { updatedAt: string }>(
    value: T,
  ): T => ({ ...value, updatedAt: accountNow() });
  const linkingNow = () => new Date().toISOString();
  const fakeImpactPreview = (
    sourceId: string,
    sourceKind: string,
    intervalStart: string,
    intervalEnd: string,
  ): ImpactPreviewSnapshot => ({
    sourceId,
    sourceKind,
    intervalStart,
    intervalEnd: intervalEnd || "9999-12-31T23:59:59.999999999Z",
    affectedObservationIds: [],
    affectedCalculationIntervals: intervalEnd
      ? [{ start: intervalStart, end: intervalEnd }]
      : [],
    affectedDerivedResultIds: [],
  });
  const createFakeLogicalAccount = (input: CreateLogicalAccountInput) => {
    const now = accountNow();
    const account = {
      id: `fake-account-${(accounts.logicalAccounts ?? []).length + 1}`,
      serviceId: input.serviceId,
      displayName: input.displayName,
      archivedAt: "",
      createdAt: now,
      updatedAt: now,
    };
    accounts = {
      ...accounts,
      logicalAccounts: [...(accounts.logicalAccounts ?? []), account],
    };
    return account;
  };
  const backend: FakeFrontendAdapter = {
    canOpenMain: options.canOpenMain ?? false,
    initialSettings: settings,
    getSettings: async () => settings,
    saveSettings: async (next) => {
      settings = asSettings({ ...settings, ...next }, settings);
      return settings;
    },
    OpenMain: async () => options.onOpenMain?.(),
    OpenMainRoute: async (route) => options.onOpenMainRoute?.(route),
    SetCompactExpanded: async (expanded) =>
      options.onSetCompactExpanded?.(expanded),
    SetMainDirty: async (dirty) => options.onSetMainDirty?.(dirty),
    ConfirmCloseMain: async () => options.onConfirmCloseMain?.(),
    ConfirmQuit: async () => options.onConfirmQuit?.(),
    getOverview: async (privacyMode) =>
      options.onGetOverview?.(privacyMode) ??
      options.overview ??
      emptyOverviewSnapshot,
    getLimitSeries: async (input) =>
      limitSeries.filter(
        (item) =>
          (!input.serviceId || item.serviceId === input.serviceId) &&
          (!input.status || item.state.code === input.status) &&
          (!input.planVersionId ||
            item.planVersionId === input.planVersionId) &&
          (!input.limitDefinitionId ||
            item.limitDefinitionId === input.limitDefinitionId),
      ),
    getLimitSeriesDetail: async (seriesID) => {
      const value = limitSeriesDetails[seriesID];
      if (value) return value;
      const series = limitSeries.find((item) => item.id === seriesID);
      if (!series) throw new Error("limit series was not found");
      return { series, current: series.currentInterval, history: [] };
    },
    getHubs: async () => hubs,
    createHub: async (input) => {
      const hub: HubSnapshot = {
        id: `fake-${hubs.length + 1}`,
        displayName: input.displayName,
        url: input.url,
        enabled: true,
        collectionEnabled: input.collectionEnabled,
        collectionIntervalSeconds: input.collectionIntervalSeconds,
        apiContract: "",
        credentialState: input.secret ? "registered" : "unregistered",
        credentialReady: Boolean(input.secret),
        connectionState: "not_checked",
        connectionCheckedAt: "",
        connectionFailureNote: "",
      };
      hubs = [...hubs, hub];
      return hub;
    },
    updateHub: async (input) => {
      const current = hubs.find((hub) => hub.id === input.id);
      if (!current) throw new Error("hub was not found");
      const hub = {
        ...current,
        displayName: input.displayName,
        url: input.url,
        collectionIntervalSeconds: input.collectionIntervalSeconds,
      };
      hubs = hubs.map((item) => (item.id === hub.id ? hub : item));
      return hub;
    },
    setHubCollectionEnabled: async (hubID, enabled) => {
      hubs = hubs.map((hub) =>
        hub.id === hubID ? { ...hub, collectionEnabled: enabled } : hub,
      );
      return hubs.find((hub) => hub.id === hubID)!;
    },
    setHubEnabled: async (hubID, enabled) => {
      hubs = hubs.map((hub) =>
        hub.id === hubID
          ? {
              ...hub,
              enabled,
              collectionEnabled: enabled ? hub.collectionEnabled : false,
            }
          : hub,
      );
      return hubs.find((hub) => hub.id === hubID)!;
    },
    saveCredential: async (hubID) => {
      hubs = hubs.map((hub) =>
        hub.id === hubID
          ? { ...hub, credentialState: "registered", credentialReady: true }
          : hub,
      );
      return hubs.find((hub) => hub.id === hubID)!;
    },
    deleteCredential: async (hubID) => {
      hubs = hubs.map((hub) =>
        hub.id === hubID
          ? { ...hub, credentialState: "unregistered", credentialReady: false }
          : hub,
      );
      return hubs.find((hub) => hub.id === hubID)!;
    },
    checkHubConnection: async (hubID) => {
      hubs = hubs.map((hub) =>
        hub.id === hubID ? { ...hub, connectionState: "connected" } : hub,
      );
      return hubs.find((hub) => hub.id === hubID)!;
    },
    startCollection: async (hubID) => {
      hubs = hubs.map((hub) =>
        hub.id === hubID ? { ...hub, collectionEnabled: true } : hub,
      );
    },
    stopCollection: async (hubID) => {
      hubs = hubs.map((hub) =>
        hub.id === hubID ? { ...hub, collectionEnabled: false } : hub,
      );
    },
    collectNow: async () => undefined,
    getCollectionAttempts: async (hubID) =>
      collectionAttempts.filter((item) => item.hubId === hubID),
    getRawSnapshots: async (hubID) =>
      rawSnapshots
        .filter((item) => item.hubId === hubID)
        .map((item) => ({
          snapshotId: item.snapshotId,
          attemptId: item.attemptId,
          hubId: item.hubId,
          responseKind: item.responseKind,
          receivedStartedAt: item.receivedStartedAt,
          receivedCompletedAt: item.receivedCompletedAt,
          httpStatus: item.httpStatus,
          apiContract: item.apiContract,
        })),
    getRawSnapshot: async (snapshotID) => {
      const item = rawSnapshots.find(
        (snapshot) => snapshot.snapshotId === snapshotID,
      );
      if (!item) throw new Error("raw snapshot was not found");
      return item;
    },
    getCostObservations: async (hubID) =>
      costObservations.filter((item) => item.hubId === hubID),
    getLimitObservations: async (hubID) =>
      limitObservations.filter((item) => item.hubId === hubID),
    getAudits: async (filter) => {
      const filtered = audits.filter(
        (audit) =>
          (!filter.action || audit.action === filter.action) &&
          (!filter.entityType || audit.entityType === filter.entityType) &&
          (!filter.from || audit.occurredAt >= filter.from) &&
          (!filter.to || audit.occurredAt < filter.to),
      );
      const limit = filter.limit > 0 ? filter.limit : 50;
      const offset = filter.cursor
        ? Number.parseInt(atob(filter.cursor), 10)
        : 0;
      const items = Number.isFinite(offset)
        ? filtered.slice(offset, offset + limit + 1)
        : filtered.slice(0, limit + 1);
      const hasMore = items.length > limit;
      return {
        items: hasMore ? items.slice(0, limit) : items,
        hasMore,
        nextCursor: hasMore
          ? btoa(String((Number.isFinite(offset) ? offset : 0) + limit))
          : "",
      };
    },
    getReviewItems: async (filter) => {
      const filtered = reviewItems.filter(
        (item) =>
          (!filter.kind || item.kind === filter.kind) &&
          (!filter.state || item.state === filter.state) &&
          (!filter.impact || item.impact === filter.impact) &&
          (!filter.hubId || item.hubId === filter.hubId) &&
          (!filter.from || item.lastObservedAt >= filter.from) &&
          (!filter.to || item.lastObservedAt < filter.to),
      );
      const limit = filter.limit > 0 ? filter.limit : 50;
      const offset = filter.cursor
        ? Number.parseInt(atob(filter.cursor), 10)
        : 0;
      const items = Number.isFinite(offset)
        ? filtered.slice(offset, offset + limit + 1)
        : filtered.slice(0, limit + 1);
      const hasMore = items.length > limit;
      return {
        items: hasMore ? items.slice(0, limit) : items,
        hasMore,
        nextCursor: hasMore
          ? btoa(String((Number.isFinite(offset) ? offset : 0) + limit))
          : "",
      };
    },
    getCatalog: async () => catalog,
    getAccounts: async () => accounts,
    getHubAccountCandidates: async (serviceID, state) =>
      (accounts.hubAccountCandidates ?? []).filter(
        (item) =>
          (!serviceID || item.serviceId === serviceID) &&
          (!state || item.state === state),
      ),
    getLogicalAccounts: async (serviceID, includeArchived) =>
      (accounts.logicalAccounts ?? []).filter(
        (item) =>
          (!serviceID || item.serviceId === serviceID) &&
          (includeArchived || !item.archivedAt),
      ),
    getPlanHistories: async (logicalAccountID) =>
      (accounts.planHistories ?? []).filter(
        (item) =>
          !logicalAccountID || item.logicalAccountId === logicalAccountID,
      ),
    createLogicalAccount: async (input) => createFakeLogicalAccount(input),
    updateLogicalAccount: async (input) => {
      const current = (accounts.logicalAccounts ?? []).find(
        (item) => item.id === input.id,
      );
      if (!current) throw new Error("logical account was not found");
      const account = accountWithUpdatedAt({
        ...current,
        serviceId: input.serviceId,
        displayName: input.displayName,
      });
      accounts = {
        ...accounts,
        logicalAccounts: (accounts.logicalAccounts ?? []).map((item) =>
          item.id === account.id ? account : item,
        ),
      };
    },
    archiveLogicalAccount: async (accountID) => {
      accounts = {
        ...accounts,
        logicalAccounts: (accounts.logicalAccounts ?? []).map((item) =>
          item.id === accountID
            ? accountWithUpdatedAt({ ...item, archivedAt: accountNow() })
            : item,
        ),
      };
    },
    restoreLogicalAccount: async (accountID) => {
      accounts = {
        ...accounts,
        logicalAccounts: (accounts.logicalAccounts ?? []).map((item) =>
          item.id === accountID
            ? accountWithUpdatedAt({ ...item, archivedAt: "" })
            : item,
        ),
      };
    },
    createLogicalAccountFromCandidate: async (input) => {
      const account = createFakeLogicalAccount(input);
      accounts = {
        ...accounts,
        hubAccountCandidates: (accounts.hubAccountCandidates ?? []).map(
          (item) =>
            item.id === input.candidateId
              ? accountWithUpdatedAt({
                  ...item,
                  state: "associated",
                  logicalAccountId: account.id,
                })
              : item,
        ),
      };
      return account;
    },
    associateHubAccountCandidate: async (candidateID, logicalAccountID) => {
      accounts = {
        ...accounts,
        hubAccountCandidates: (accounts.hubAccountCandidates ?? []).map(
          (item) =>
            item.id === candidateID
              ? accountWithUpdatedAt({
                  ...item,
                  state: "associated",
                  logicalAccountId: logicalAccountID,
                })
              : item,
        ),
      };
    },
    rejectHubAccountCandidate: async (candidateID) => {
      accounts = {
        ...accounts,
        hubAccountCandidates: (accounts.hubAccountCandidates ?? []).map(
          (item) =>
            item.id === candidateID
              ? accountWithUpdatedAt({
                  ...item,
                  state: "rejected",
                  logicalAccountId: "",
                })
              : item,
        ),
      };
    },
    releaseHubAccountCandidate: async (candidateID) => {
      accounts = {
        ...accounts,
        hubAccountCandidates: (accounts.hubAccountCandidates ?? []).map(
          (item) =>
            item.id === candidateID
              ? accountWithUpdatedAt({
                  ...item,
                  state: "unconfirmed",
                  logicalAccountId: "",
                })
              : item,
        ),
      };
    },
    splitLogicalAccount: async (input) => {
      const account = createFakeLogicalAccount({
        serviceId: input.serviceId,
        displayName: input.displayName,
      });
      accounts = {
        ...accounts,
        hubAccountCandidates: (accounts.hubAccountCandidates ?? []).map(
          (item) =>
            input.candidateIds?.includes(item.id)
              ? accountWithUpdatedAt({
                  ...item,
                  state: "associated",
                  logicalAccountId: account.id,
                })
              : item,
        ),
      };
      return account;
    },
    mergeLogicalAccounts: async (sourceID, targetID) => {
      accounts = {
        ...accounts,
        logicalAccounts: (accounts.logicalAccounts ?? []).map((item) =>
          item.id === sourceID
            ? accountWithUpdatedAt({ ...item, archivedAt: accountNow() })
            : item,
        ),
        hubAccountCandidates: (accounts.hubAccountCandidates ?? []).map(
          (item) =>
            item.logicalAccountId === sourceID
              ? accountWithUpdatedAt({
                  ...item,
                  logicalAccountId: targetID,
                  state: "associated",
                })
              : item,
        ),
      };
    },
    createPlanHistory: async (input) => {
      const now = accountNow();
      const history = {
        id: `fake-history-${(accounts.planHistories ?? []).length + 1}`,
        ...input,
        createdAt: now,
        updatedAt: now,
      };
      accounts = {
        ...accounts,
        planHistories: [...(accounts.planHistories ?? []), history],
      };
      return history;
    },
    updatePlanHistory: async (input) => {
      const current = (accounts.planHistories ?? []).find(
        (item) => item.id === input.id,
      );
      if (!current) throw new Error("plan history was not found");
      accounts = {
        ...accounts,
        planHistories: (accounts.planHistories ?? []).map((item) =>
          item.id === input.id
            ? { ...current, ...input, updatedAt: accountNow() }
            : item,
        ),
      };
    },
    getLinkingSnapshot: async () => linking,
    createUsageCostAssociation: async (input) => {
      const now = linkingNow();
      const association: UsageCostAssociationSnapshot = {
        id:
          input.id ||
          `fake-cost-association-${(linking.usageCostAssociations ?? []).length + 1}`,
        usageCostSourceId: input.usageCostSourceId,
        logicalAccountId: input.logicalAccountId,
        validFrom: input.validFrom,
        validTo: input.validTo,
        createdAt: now,
        updatedAt: now,
      };
      linking = {
        ...linking,
        usageCostAssociations: [
          ...(linking.usageCostAssociations ?? []),
          association,
        ],
      };
      return association;
    },
    updateUsageCostAssociation: async (input) => {
      linking = {
        ...linking,
        usageCostAssociations: (linking.usageCostAssociations ?? []).map(
          (item) =>
            item.id === input.id
              ? { ...item, ...input, updatedAt: linkingNow() }
              : item,
        ),
      };
    },
    previewUsageCostAssociation: async (input) =>
      fakeImpactPreview(
        input.usageCostSourceId,
        "usage_cost",
        input.validFrom,
        input.validTo,
      ),
    createUsageLimitAssociation: async (input) => {
      const now = linkingNow();
      const association: UsageLimitAssociationSnapshot = {
        id:
          input.id ||
          `fake-limit-association-${(linking.usageLimitAssociations ?? []).length + 1}`,
        usageLimitSourceId: input.usageLimitSourceId,
        logicalAccountId: input.logicalAccountId,
        limitDefinitionId: input.limitDefinitionId,
        validFrom: input.validFrom,
        validTo: input.validTo,
        createdAt: now,
        updatedAt: now,
      };
      linking = {
        ...linking,
        usageLimitAssociations: [
          ...(linking.usageLimitAssociations ?? []),
          association,
        ],
      };
      return association;
    },
    updateUsageLimitAssociation: async (input) => {
      linking = {
        ...linking,
        usageLimitAssociations: (linking.usageLimitAssociations ?? []).map(
          (item) =>
            item.id === input.id
              ? { ...item, ...input, updatedAt: linkingNow() }
              : item,
        ),
      };
    },
    previewUsageLimitAssociation: async (input) =>
      fakeImpactPreview(
        input.usageLimitSourceId,
        "usage_limit",
        input.validFrom,
        input.validTo,
      ),
    previewUsageCostSourceCompleteness: async (input) =>
      fakeImpactPreview(
        input.usageCostSourceId,
        "usage_cost_completeness",
        input.validFrom,
        input.validTo,
      ),
    confirmUsageCostSourceCompleteness: async (input) => {
      const now = linkingNow();
      const completeness: UsageCostSourceCompletenessSnapshot = {
        id:
          input.id ||
          `fake-completeness-${(linking.usageCostSourceCompleteness ?? []).length + 1}`,
        usageCostSourceId: input.usageCostSourceId,
        validFrom: input.validFrom,
        validTo: input.validTo,
        state: input.state || "unconfirmed",
        logicalAccountIds: input.logicalAccountIds,
        excludedActivity: input.excludedActivity,
        createdAt: now,
        updatedAt: now,
      };
      linking = {
        ...linking,
        usageCostSourceCompleteness: [
          ...(linking.usageCostSourceCompleteness ?? []),
          completeness,
        ],
      };
      return completeness;
    },
    updateUsageCostSourceCompleteness: async (input) => {
      linking = {
        ...linking,
        usageCostSourceCompleteness: (
          linking.usageCostSourceCompleteness ?? []
        ).map((item) =>
          item.id === input.id
            ? { ...item, ...input, updatedAt: linkingNow() }
            : item,
        ),
      };
    },
    previewHubSwitch: async (input) =>
      fakeImpactPreview(
        input.newHubId,
        "hub_switch",
        input.switchedAt,
        input.switchedAt,
      ),
    confirmHubSwitch: async (input) => {
      const record: HubSwitchSnapshot = {
        ...input,
        id:
          input.id ||
          `fake-hub-switch-${(linking.hubSwitches ?? []).length + 1}`,
        createdAt: linkingNow(),
      };
      linking = {
        ...linking,
        hubSwitches: [...(linking.hubSwitches ?? []), record],
      };
      return record;
    },
    createService: async (input) => {
      const service: ServiceSnapshot = {
        id: `fake-service-${catalog.services.length + 1}`,
        provider: input.provider,
        name: input.name,
        officialKey: input.officialKey,
        archivedAt: "",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      catalog = { ...catalog, services: [...catalog.services, service] };
      return service;
    },
    updateService: async (input) => {
      const current = catalog.services.find((item) => item.id === input.id);
      if (!current) throw new Error("service was not found");
      const service = {
        ...current,
        provider: input.provider,
        name: input.name,
        officialKey: input.officialKey,
        archivedAt: input.archived ? new Date().toISOString() : "",
        updatedAt: new Date().toISOString(),
      };
      catalog = {
        ...catalog,
        services: catalog.services.map((item) =>
          item.id === service.id ? service : item,
        ),
      };
      return service;
    },
    archiveService: async (serviceID) => {
      catalog = {
        ...catalog,
        services: catalog.services.map((item) =>
          item.id === serviceID
            ? { ...item, archivedAt: new Date().toISOString() }
            : item,
        ),
      };
    },
    restoreService: async (serviceID) => {
      catalog = {
        ...catalog,
        services: catalog.services.map((item) =>
          item.id === serviceID ? { ...item, archivedAt: "" } : item,
        ),
      };
    },
    createServiceIdentifierMapping: async (input) => {
      catalog = {
        ...catalog,
        serviceIdentifierMappings: [
          ...catalog.serviceIdentifierMappings,
          {
            ...input,
            id:
              input.id ||
              `fake-mapping-${catalog.serviceIdentifierMappings.length + 1}`,
            createdAt: new Date().toISOString(),
          },
        ],
      };
    },
    updateServiceIdentifierMapping: async (input) => {
      catalog = {
        ...catalog,
        serviceIdentifierMappings: catalog.serviceIdentifierMappings.map(
          (item) => (item.id === input.id ? { ...item, ...input } : item),
        ),
      };
    },
    createLimitDefinition: async (input) => {
      catalog = {
        ...catalog,
        limitDefinitions: [
          ...catalog.limitDefinitions,
          {
            ...input,
            id: input.id || `fake-limit-${catalog.limitDefinitions.length + 1}`,
            archivedAt: "",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      };
    },
    updateLimitDefinition: async (input) => {
      catalog = {
        ...catalog,
        limitDefinitions: catalog.limitDefinitions.map((item) =>
          item.id === input.id
            ? { ...item, ...input, updatedAt: new Date().toISOString() }
            : item,
        ),
      };
    },
    setBillingConfirmation: async (definitionID, confirmation) => {
      catalog = {
        ...catalog,
        limitDefinitions: catalog.limitDefinitions.map((item) =>
          item.id === definitionID
            ? {
                ...item,
                billingConfirmation: confirmation,
                updatedAt: new Date().toISOString(),
              }
            : item,
        ),
      };
    },
    createPlan: async (input) => {
      catalog = {
        ...catalog,
        plans: [
          ...catalog.plans,
          {
            ...input,
            id: input.id || `fake-plan-${catalog.plans.length + 1}`,
            archivedAt: "",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      };
    },
    updatePlan: async (input) => {
      catalog = {
        ...catalog,
        plans: catalog.plans.map((item) =>
          item.id === input.id
            ? { ...item, ...input, updatedAt: new Date().toISOString() }
            : item,
        ),
      };
    },
    setBaselinePlan: async (serviceID, planID) => {
      catalog = {
        ...catalog,
        plans: catalog.plans.map((item) =>
          item.serviceId === serviceID
            ? { ...item, isBaseline: item.id === planID }
            : item,
        ),
      };
    },
    createPlanVersion: async (input) => {
      catalog = {
        ...catalog,
        planVersions: [
          ...catalog.planVersions,
          {
            ...input,
            id: input.id || `fake-version-${catalog.planVersions.length + 1}`,
            createdAt: new Date().toISOString(),
          },
        ],
      };
    },
    createPlanLimitRule: async (input) => {
      catalog = {
        ...catalog,
        planLimitRules: [
          ...catalog.planLimitRules,
          {
            ...input,
            id: input.id || `fake-rule-${catalog.planLimitRules.length + 1}`,
            createdAt: new Date().toISOString(),
          },
        ],
      };
    },
    createStandardPrice: async (input) => {
      catalog = {
        ...catalog,
        standardPrices: [
          ...catalog.standardPrices,
          {
            ...input,
            id: input.id || `fake-price-${catalog.standardPrices.length + 1}`,
            createdAt: new Date().toISOString(),
          },
        ],
      };
    },
    confirmIdentificationCandidate: async (input) => {
      catalog = {
        ...catalog,
        identificationCandidates: catalog.identificationCandidates.map(
          (item) =>
            item.id === input.candidateId
              ? {
                  ...item,
                  state: "confirmed",
                  serviceId: input.serviceId,
                  planId: input.planId,
                }
              : item,
        ),
      };
    },
    rejectIdentificationCandidate: async (candidateID) => {
      catalog = {
        ...catalog,
        identificationCandidates: catalog.identificationCandidates.map(
          (item) =>
            item.id === candidateID
              ? { ...item, state: "rejected", serviceId: "", planId: "" }
              : item,
        ),
      };
    },
    releaseIdentificationCandidate: async (candidateID) => {
      catalog = {
        ...catalog,
        identificationCandidates: catalog.identificationCandidates.map(
          (item) =>
            item.id === candidateID
              ? { ...item, state: "unconfirmed", serviceId: "", planId: "" }
              : item,
        ),
      };
    },
    correctIdentificationCandidate: async (input) => {
      catalog = {
        ...catalog,
        identificationCandidates: catalog.identificationCandidates.map(
          (item) =>
            item.id === input.candidateId
              ? {
                  ...item,
                  ...input,
                  state: "unconfirmed",
                  serviceId: "",
                  planId: "",
                }
              : item,
        ),
      };
    },
    splitIdentificationCandidate: async () => undefined,
    decideLabelChangeCandidate: async (input) => {
      catalog = {
        ...catalog,
        labelChangeCandidates: catalog.labelChangeCandidates.map((item) =>
          item.id === input.candidateId
            ? {
                ...item,
                state: input.state,
                limitDefinitionId: input.limitDefinitionId,
              }
            : item,
        ),
      };
    },
    on: (event, callback) => {
      const callbacks = listeners.get(event) ?? new Set();
      callbacks.add(callback);
      listeners.set(event, callbacks);
      return () => callbacks.delete(callback);
    },
    emit: (event, data) => {
      listeners.get(event)?.forEach((callback) => callback(data));
    },
  };
  return backend;
}

export function emitFakeBackendEvent(
  backend: FakeFrontendAdapter,
  event: FrontendEventName,
  data?: unknown,
): void {
  backend.emit(event, data);
}

function normalizeThemeEvent(
  data: unknown,
  current: SettingsSnapshot,
): SettingsSnapshot | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = data as Record<string, unknown>;
  if (
    value.theme !== "light" &&
    value.theme !== "dark" &&
    value.theme !== "system"
  ) {
    return undefined;
  }
  return asSettings({ ...current, ...value }, current);
}

function createWailsSettingsAdapter(
  service: SettingsServiceAdapter | undefined,
): SettingsServiceAdapter {
  if (service) return service;
  return {
    getSettings: () =>
      asPromise(
        SettingsService.GetSettings() as unknown as Promise<unknown>,
      ).then((value) => asSettings(value, defaultSettings)),
    saveSettings: (next) =>
      asPromise(
        SettingsService.SaveSettings(next) as unknown as Promise<unknown>,
      ).then((value) => asSettings(value, defaultSettings)),
  };
}

export interface ProductionBackendOptions {
  canOpenMain?: boolean;
  settingsService?: SettingsServiceAdapter;
  initialSettings?: SettingsSnapshot;
}

/**
 * Production adapter. Generated Wails bindings stay on this side of the UI;
 * tests can replace the whole adapter with `createFakeBackend`.
 */
export function createProductionBackend(
  options: ProductionBackendOptions = {},
): FrontendAdapter {
  const initial = asSettings(
    options.initialSettings ?? defaultSettings,
    defaultSettings,
  );
  const settings = createWailsSettingsAdapter(options.settingsService);
  return {
    canOpenMain: options.canOpenMain ?? false,
    initialSettings: initial,
    getSettings: () =>
      asPromise(settings.getSettings()).then((value) =>
        asSettings(value, initial),
      ),
    saveSettings: (next) =>
      asPromise(settings.saveSettings(next)).then((value) =>
        asSettings(value, initial),
      ),
    OpenMain: () => asPromise(WindowService.OpenMain()),
    OpenMainRoute: (route) => asPromise(WindowService.OpenMainRoute(route)),
    SetCompactExpanded: (expanded) =>
      asPromise(WindowService.SetCompactExpanded(expanded)),
    SetMainDirty: (dirty) => asPromise(WindowService.SetMainDirty(dirty)),
    ConfirmCloseMain: () => asPromise(WindowService.ConfirmCloseMain()),
    ConfirmQuit: () => asPromise(WindowService.ConfirmQuit()),
    getOverview: (privacyMode) =>
      asPromise(OverviewService.GetOverview(privacyMode)),
    getLimitSeries: (input) =>
      asPromise(EstimationService.GetLimitSeries(input)).then(
        (value) => value ?? [],
      ),
    getLimitSeriesDetail: (seriesID) =>
      asPromise(EstimationService.GetLimitSeriesDetail(seriesID)),
    getHubs: () => asPromise(HubService.GetHubs()).then((value) => value ?? []),
    createHub: (input) => asPromise(HubService.CreateHub(input)),
    updateHub: (input) => asPromise(HubService.UpdateHub(input)),
    setHubCollectionEnabled: (hubID, enabled) =>
      asPromise(HubService.SetHubCollectionEnabled(hubID, enabled)),
    setHubEnabled: (hubID, enabled) =>
      asPromise(HubService.SetHubEnabled(hubID, enabled)),
    saveCredential: (hubID, secret) =>
      asPromise(HubService.SaveCredential(hubID, secret)),
    deleteCredential: (hubID) => asPromise(HubService.DeleteCredential(hubID)),
    checkHubConnection: (hubID) =>
      asPromise(HubService.CheckHubConnection(hubID)),
    startCollection: (hubID) =>
      asPromise(CollectionService.StartCollection(hubID)),
    stopCollection: (hubID) =>
      asPromise(CollectionService.StopCollection(hubID)),
    collectNow: (hubID) => asPromise(CollectionService.CollectNow(hubID)),
    getCollectionAttempts: (hubID) =>
      asPromise(CollectionService.GetCollectionAttempts(hubID)).then(
        (value) => value ?? [],
      ),
    getRawSnapshots: (hubID) =>
      asPromise(CollectionService.GetRawSnapshots(hubID)).then(
        (value) => value ?? [],
      ),
    getRawSnapshot: (snapshotID) =>
      asPromise(CollectionService.GetRawSnapshot(snapshotID)),
    getCostObservations: (hubID) =>
      asPromise(CollectionService.GetCostObservations(hubID)).then(
        (value) => value ?? [],
      ),
    getLimitObservations: (hubID) =>
      asPromise(CollectionService.GetLimitObservations(hubID)).then(
        (value) => value ?? [],
      ),
    getAudits: (filter) => asPromise(AuditService.GetAudits(filter)),
    getReviewItems: (filter) =>
      asPromise(ReviewService.GetReviewItems(filter)).then(
        (value) => value ?? { items: [], hasMore: false, nextCursor: "" },
      ),
    getCatalog: () => asPromise(CatalogService.GetCatalog()),
    getAccounts: () => asPromise(AccountService.GetAccounts()),
    getHubAccountCandidates: (serviceID, state) =>
      asPromise(AccountService.GetHubAccountCandidates(serviceID, state)).then(
        (value) => value ?? [],
      ),
    getLogicalAccounts: (serviceID, includeArchived) =>
      asPromise(
        AccountService.GetLogicalAccounts(serviceID, includeArchived),
      ).then((value) => value ?? []),
    getPlanHistories: (logicalAccountID) =>
      asPromise(AccountService.GetPlanHistories(logicalAccountID)).then(
        (value) => value ?? [],
      ),
    createLogicalAccount: (input) =>
      asPromise(AccountService.CreateLogicalAccount(input)),
    updateLogicalAccount: (input) =>
      asPromise(AccountService.UpdateLogicalAccount(input)),
    archiveLogicalAccount: (accountID) =>
      asPromise(AccountService.ArchiveLogicalAccount(accountID)),
    restoreLogicalAccount: (accountID) =>
      asPromise(AccountService.RestoreLogicalAccount(accountID)),
    createLogicalAccountFromCandidate: (input) =>
      asPromise(AccountService.CreateLogicalAccountFromCandidate(input)),
    associateHubAccountCandidate: (candidateID, logicalAccountID) =>
      asPromise(
        AccountService.AssociateHubAccountCandidate(
          candidateID,
          logicalAccountID,
        ),
      ),
    rejectHubAccountCandidate: (candidateID) =>
      asPromise(AccountService.RejectHubAccountCandidate(candidateID)),
    releaseHubAccountCandidate: (candidateID) =>
      asPromise(AccountService.ReleaseHubAccountCandidate(candidateID)),
    splitLogicalAccount: (input) =>
      asPromise(AccountService.SplitLogicalAccount(input)),
    mergeLogicalAccounts: (sourceID, targetID) =>
      asPromise(AccountService.MergeLogicalAccounts(sourceID, targetID)),
    createPlanHistory: (input) =>
      asPromise(AccountService.CreatePlanHistory(input)),
    updatePlanHistory: (input) =>
      asPromise(AccountService.UpdatePlanHistory(input)),
    getLinkingSnapshot: () => asPromise(AccountService.GetLinkingSnapshot()),
    createUsageCostAssociation: (input) =>
      asPromise(AccountService.CreateUsageCostAssociation(input)),
    updateUsageCostAssociation: (input) =>
      asPromise(AccountService.UpdateUsageCostAssociation(input)),
    previewUsageCostAssociation: (input) =>
      asPromise(AccountService.PreviewUsageCostAssociation(input)),
    createUsageLimitAssociation: (input) =>
      asPromise(AccountService.CreateUsageLimitAssociation(input)),
    updateUsageLimitAssociation: (input) =>
      asPromise(AccountService.UpdateUsageLimitAssociation(input)),
    previewUsageLimitAssociation: (input) =>
      asPromise(AccountService.PreviewUsageLimitAssociation(input)),
    previewUsageCostSourceCompleteness: (input) =>
      asPromise(AccountService.PreviewUsageCostSourceCompleteness(input)),
    confirmUsageCostSourceCompleteness: (input) =>
      asPromise(AccountService.ConfirmUsageCostSourceCompleteness(input)),
    updateUsageCostSourceCompleteness: (input) =>
      asPromise(AccountService.UpdateUsageCostSourceCompleteness(input)),
    previewHubSwitch: (input) =>
      asPromise(AccountService.PreviewHubSwitch(input)),
    confirmHubSwitch: (input) =>
      asPromise(AccountService.ConfirmHubSwitch(input)),
    createService: (input) => asPromise(CatalogService.CreateService(input)),
    updateService: (input) => asPromise(CatalogService.UpdateService(input)),
    archiveService: (serviceID) =>
      asPromise(CatalogService.ArchiveService(serviceID)),
    restoreService: (serviceID) =>
      asPromise(CatalogService.RestoreService(serviceID)),
    createServiceIdentifierMapping: (input) =>
      asPromise(CatalogService.CreateServiceIdentifierMapping(input)),
    updateServiceIdentifierMapping: (input) =>
      asPromise(CatalogService.UpdateServiceIdentifierMapping(input)),
    createLimitDefinition: (input) =>
      asPromise(CatalogService.CreateLimitDefinition(input)),
    updateLimitDefinition: (input) =>
      asPromise(CatalogService.UpdateLimitDefinition(input)),
    setBillingConfirmation: (definitionID, confirmation) =>
      asPromise(
        CatalogService.SetBillingConfirmation(definitionID, confirmation),
      ),
    createPlan: (input) => asPromise(CatalogService.CreatePlan(input)),
    updatePlan: (input) => asPromise(CatalogService.UpdatePlan(input)),
    setBaselinePlan: (serviceID, planID) =>
      asPromise(CatalogService.SetBaselinePlan(serviceID, planID)),
    createPlanVersion: (input) =>
      asPromise(CatalogService.CreatePlanVersion(input)),
    createPlanLimitRule: (input) =>
      asPromise(CatalogService.CreatePlanLimitRule(input)),
    createStandardPrice: (input) =>
      asPromise(CatalogService.CreateStandardPrice(input)),
    confirmIdentificationCandidate: (input) =>
      asPromise(CatalogService.ConfirmIdentificationCandidate(input)),
    rejectIdentificationCandidate: (candidateID) =>
      asPromise(CatalogService.RejectIdentificationCandidate(candidateID)),
    releaseIdentificationCandidate: (candidateID) =>
      asPromise(CatalogService.ReleaseIdentificationCandidate(candidateID)),
    correctIdentificationCandidate: (input) =>
      asPromise(CatalogService.CorrectIdentificationCandidate(input)),
    splitIdentificationCandidate: (input) =>
      asPromise(CatalogService.SplitIdentificationCandidate(input)),
    decideLabelChangeCandidate: (input) =>
      asPromise(CatalogService.DecideLabelChangeCandidate(input)),
    on: (event, callback) =>
      Events.On(event, (wailsEvent) => callback(wailsEvent.data)),
  };
}

/**
 * Keep browser tests and the first-run compact window usable before the Go
 * settings service is generated. The parent process can inject the production
 * adapter at the application boundary.
 */
export const defaultBackend: FrontendAdapter = createProductionBackend({
  canOpenMain: true,
});

export function applyThemeEvent(
  data: unknown,
  current: SettingsSnapshot,
): SettingsSnapshot | undefined {
  return normalizeThemeEvent(data, current);
}
