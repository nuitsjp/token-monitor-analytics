import {
  createFakeBackend,
  emptyDataManagementState,
  emptyOverviewSnapshot,
  type AuditRecord,
  type CatalogSnapshot,
  type DataManagementStateSnapshot,
  type HubSnapshot,
  type LimitObservationSnapshot,
  type LimitSeriesSnapshot,
  type OverviewRecentLimitSnapshot,
  type OverviewSnapshot,
  type ReviewItemSnapshot,
  type UsageSnapshot,
} from "./backend";
import type { StatusPresentationSnapshot } from "./backend";

const now = "2026-08-26T00:10:00Z";

function status(
  code: string,
  label: string,
  intent = "informative",
  icon = "info",
): StatusPresentationSnapshot {
  return {
    code,
    label,
    intent,
    icon,
    description: `${label}です。`,
    nextAction: "",
    nextRoute: "",
  };
}

const hub: HubSnapshot = {
  id: "hub-evaluation",
  displayName: "評価 Hub（192.168.0.16）",
  url: "http://192.168.0.16:17321",
  enabled: true,
  collectionEnabled: true,
  collectionIntervalSeconds: 300,
  apiContract: "schema=1; runtime=node-hub; usageUpdatedAt=true",
  credentialState: "registered",
  credentialReady: true,
  connectionState: "connected",
  connectionCheckedAt: "2026-08-26T00:05:00Z",
  connectionFailureNote: "",
};

const showcaseLimit: OverviewRecentLimitSnapshot = {
  logicalAccountId: "account-codex",
  limitDefinitionId: "limit-weekly",
  serviceName: "Codex",
  accountName: "個人アカウント",
  limitName: "Weekly",
  cycleType: "weekly",
  remainingPercent: 74.5,
  remainingLabel: "74.5%",
  remainingDetailLabel: "74.50%",
  remaining: status("remaining_high", "残量良好", "success", "checkmark"),
  estimatedUsageLabel: "$31.36",
  estimatedLimitLabel: "$123.00",
  resetAt: "2026-09-01T00:00:00Z",
  reset: status("reset_scheduled", "リセット予定"),
  lastIncrease: { occurredAt: "2026-08-26T00:00:00Z", ageLabel: "10分前" },
  freshness: {
    status: status("freshness_current", "最新", "success", "checkmark"),
    reason: "最新の取得に含まれています。",
    observationAt: "2026-08-26T00:05:00Z",
    ageLabel: "5分前",
  },
  privacyMasked: false,
  accessibleLabel: "Codex、個人アカウント、残り 74.5%",
  tooltip: "週次利用枠、残り 74.5%",
};

const currentStatsBody = JSON.stringify(
  {
    devices: [
      {
        deviceId: "device-evaluation",
        usage: {
          providers: [
            {
              rawServiceIdentifier: "codex",
              usageUpdatedAt: "2026-08-26T00:05:00Z",
              costUsd: "31.365",
            },
          ],
        },
        limits: {
          providers: [
            {
              rawServiceIdentifier: "codex",
              providerUpdatedAt: "2026-08-26T00:05:00Z",
              accountKey: "account-key",
              planLabel: "Plus",
              windows: [
                {
                  windowKey: "weekly-percent",
                  normalizedKind: "weekly",
                  usedPercent: 25.5,
                  remainingPercent: 74.5,
                  resetsAt: "2026-09-01T00:00:00Z",
                },
              ],
            },
            {
              rawServiceIdentifier: "claude",
              providerUpdatedAt: "2026-08-26T00:05:00Z",
              planLabel: "Pro",
              windows: [
                {
                  windowKey: "five-hour-percent",
                  normalizedKind: "five_hour",
                  usedPercent: 58,
                  remainingPercent: 42,
                  resetsAt: "2026-08-26T05:00:00Z",
                },
              ],
            },
          ],
        },
        secret: "[MASKED]",
      },
    ],
  },
  null,
  2,
);

const startStatsBody = JSON.stringify(
  {
    devices: [
      {
        deviceId: "device-evaluation",
        usage: {
          providers: [
            {
              rawServiceIdentifier: "codex",
              usageUpdatedAt: "2026-08-25T00:05:00Z",
              costUsd: "0.000",
            },
          ],
        },
        limits: {
          providers: [
            {
              rawServiceIdentifier: "codex",
              providerUpdatedAt: "2026-08-25T00:05:00Z",
              accountKey: "account-key",
              planLabel: "Plus",
              windows: [
                {
                  windowKey: "weekly-percent",
                  normalizedKind: "weekly",
                  usedPercent: 0,
                  remainingPercent: 100,
                  resetsAt: "2026-09-01T00:00:00Z",
                },
              ],
            },
          ],
        },
        secret: "[MASKED]",
      },
    ],
  },
  null,
  2,
);

const overview: OverviewSnapshot = {
  ...emptyOverviewSnapshot,
  generatedAt: now,
  timezoneConfirmed: true,
  checklist: [
    {
      step: 1,
      title: "表示タイムゾーンを確認",
      status: status("complete", "完了", "success", "checkmark"),
      route: "/settings",
      actionable: false,
    },
    {
      step: 2,
      title: "Hub と資格情報を登録",
      status: status("complete", "完了", "success", "checkmark"),
      route: "/hubs",
      actionable: false,
    },
  ],
  hubs: {
    ...emptyOverviewSnapshot.hubs,
    totalCount: 1,
    enabledCount: 1,
    scheduledCount: 1,
    credentialReadyCount: 1,
    lastSuccessAt: "2026-08-26T00:05:00Z",
    connectionStates: [
      {
        status: status("connected", "接続済み", "success", "checkmark"),
        count: 1,
      },
    ],
    currentCollectionStates: [
      { status: status("collection_idle", "待機中"), count: 1 },
    ],
    lastCollectionStates: [
      {
        status: status(
          "collection_succeeded",
          "取得成功",
          "success",
          "checkmark",
        ),
        count: 1,
      },
    ],
    items: [
      {
        id: hub.id,
        displayName: hub.displayName,
        enabled: true,
        collectionEnabled: true,
        connection: status("connected", "接続済み", "success", "checkmark"),
        currentCollection: status("collection_idle", "待機中"),
        lastCollection: status(
          "collection_succeeded",
          "取得成功",
          "success",
          "checkmark",
        ),
        lastCollectionAt: "2026-08-26T00:05:00Z",
        lastSuccessAt: "2026-08-26T00:05:00Z",
        lastFailureAt: "2026-08-26T00:00:00Z",
        lastSkippedAt: "",
      },
    ],
  },
  review: {
    ...emptyOverviewSnapshot.review,
    actionItems: {
      ...emptyOverviewSnapshot.review.actionItems,
      count: 1,
    },
    warnings: { ...emptyOverviewSnapshot.review.warnings, count: 1 },
    actionKinds: [
      { code: "identification_candidate", label: "サービス同定候補", count: 1 },
    ],
    warningKinds: [
      {
        code: "missing_account_key",
        label: "アカウント識別情報なし",
        count: 1,
      },
    ],
  },
  estimation: {
    states: [
      {
        status: status("provisional", "暫定推定", "informative", "info"),
        count: 1,
      },
    ],
  },
  capacity: {
    databaseSizeBytes: 12_582_912,
    rawSnapshotCount: 24,
    oldestSnapshotAt: "2026-08-25T00:00:00Z",
    latestSnapshotAt: "2026-08-26T00:05:00Z",
  },
  recentLimits: [
    showcaseLimit,
    {
      ...showcaseLimit,
      logicalAccountId: "account-claude",
      limitDefinitionId: "limit-claude-weekly",
      serviceName: "Claude Code",
      accountName: "仕事",
      remainingPercent: 64,
      remainingLabel: "64.0%",
      remainingDetailLabel: "64.00%",
      estimatedUsageLabel: "$44.28",
      resetAt: "2026-08-30T00:00:00Z",
      accessibleLabel: "Claude Code、仕事、残り 64.0%",
    },
    {
      ...showcaseLimit,
      logicalAccountId: "account-copilot",
      limitDefinitionId: "limit-copilot-monthly",
      serviceName: "Copilot",
      limitName: "Monthly",
      remainingPercent: 8.5,
      remainingLabel: "8.5%",
      remainingDetailLabel: "8.50%",
      estimatedUsageLabel: "$112.55",
      remaining: status("remaining_low", "残量少", "danger", "error"),
      resetAt: "2026-08-31T15:00:00Z",
      accessibleLabel: "Copilot、個人アカウント、残り 8.5%",
    },
    {
      ...showcaseLimit,
      logicalAccountId: "account-gemini",
      limitDefinitionId: "limit-gemini-daily",
      serviceName: "Gemini",
      accountName: "仕事",
      limitName: "Daily",
      cycleType: "daily",
      remainingPercent: 91.4,
      remainingLabel: "91.4%",
      remainingDetailLabel: "91.40%",
      estimatedUsageLabel: "$10.58",
      resetAt: "2026-08-26T15:00:00Z",
      accessibleLabel: "Gemini、仕事、残り 91.4%",
    },
    {
      ...showcaseLimit,
      logicalAccountId: "account-codex-work",
      limitDefinitionId: "limit-codex-5h",
      accountName: "仕事",
      limitName: "5h",
      cycleType: "five_hour",
      remainingPercent: 27,
      remainingLabel: "27.0%",
      remainingDetailLabel: "27.00%",
      estimatedUsageLabel: "$89.79",
      remaining: status("remaining_medium", "残量注意", "caution", "warning"),
      resetAt: "2026-08-26T04:00:00Z",
      accessibleLabel: "Codex、仕事、残り 27.0%",
    },
    {
      ...showcaseLimit,
      logicalAccountId: "account-claude-opus",
      limitDefinitionId: "limit-claude-opus-weekly",
      serviceName: "Claude Opus",
      accountName: "個人アカウント",
      remainingPercent: 52,
      remainingLabel: "52.0%",
      remainingDetailLabel: "52.00%",
      estimatedUsageLabel: "$59.04",
      accessibleLabel: "Claude Opus、個人アカウント、残り 52.0%",
    },
  ],
};

const privacyOverview: OverviewSnapshot = {
  ...overview,
  recentLimits: (overview.recentLimits ?? []).map((item) => {
    const hidden = status("privacy_hidden", "非表示", "subtle");
    return {
      ...item,
      accountName: "••••",
      remainingPercent: null,
      remainingLabel: "••••",
      remainingDetailLabel: "••••",
      estimatedUsageLabel: "••••",
      estimatedLimitLabel: "••••",
      remaining: hidden,
      resetAt: "",
      reset: hidden,
      privacyMasked: true,
      accessibleLabel: `${item.serviceName}、••••、${item.limitName}、残り ••••、非表示、利用増加 ${item.lastIncrease.ageLabel}、最新観測 ${item.freshness.ageLabel}`,
      tooltip: `残り ••••・利用増加 ${item.lastIncrease.ageLabel}（UTC ${item.lastIncrease.occurredAt}）・最新観測 ${item.freshness.ageLabel}（UTC ${item.freshness.observationAt}）`,
    };
  }),
};

const limitSeries: LimitSeriesSnapshot = {
  id: "series-codex-weekly",
  serviceId: "service-codex",
  serviceName: "Codex",
  logicalAccountId: "account-codex",
  logicalAccountName: "個人アカウント",
  limitDefinitionId: "limit-weekly",
  limitDefinitionName: "週次利用枠",
  cycleType: "weekly",
  billingConfirmation: "not_applicable",
  usageLimitSourceId: "source-weekly",
  associationId: "association-weekly",
  normalizedKind: "weekly",
  normalizedMetric: "percent",
  planHistoryId: "plan-history-plus",
  planVersionId: "plan-plus-2026",
  planVersionName: "Plus 2026",
  planLimitRuleId: "rule-plus-weekly",
  planLimit: 1000,
  planLimitLabel: "1,000.00",
  multiplier: null,
  usedPercent: 25.5,
  usedPercentLabel: "25.5",
  usedPercentDetailLabel: "25.50",
  remainingPercent: 74.5,
  remainingLabel: "74.5%",
  remainingDetailLabel: "74.50%",
  resetAt: "2026-09-01T00:00:00Z",
  latestObservationAt: "2026-08-26T00:05:00Z",
  seriesState: "normal",
  state: status("provisional", "暫定推定", "informative", "info"),
  stateReasonCode: "exactly_identified",
  stateReason: "利用枠観測から暫定値を算出しました。",
  currentInterval: {
    id: "interval-codex-weekly-current",
    serviceId: "service-codex",
    logicalAccountId: "account-codex",
    usageLimitSourceId: "source-weekly",
    limitDefinitionId: "limit-weekly",
    planVersionId: "plan-plus-2026",
    cycleType: "weekly",
    validFrom: "2026-08-25T00:00:00Z",
    validTo: "2026-09-01T00:00:00Z",
    state: "estimable",
    stateLabel: "推定可能",
    exclusionReasonCode: "",
    exclusionReason: "",
    boundaryIds: ["boundary-weekly-start", "boundary-weekly-end"],
    boundaries: [
      {
        id: "boundary-weekly-start",
        kindCode: "limit_reset",
        kind: "利用枠リセット",
        at: "2026-08-25T00:00:00Z",
        reason: "週次利用枠の開始を観測しました。",
        relatedId: "observation-weekly-start",
      },
      {
        id: "boundary-weekly-end",
        kindCode: "scheduled_reset",
        kind: "次回リセット",
        at: "2026-09-01T00:00:00Z",
        reason: "観測されたリセット予定時刻です。",
        relatedId: "observation-weekly",
      },
    ],
    role: "current",
    roleLabel: "カレント",
    estimatedLimit: 123,
    estimatedLimitLabel: "123.00 USD相当",
    monthlyEquivalentLimit: 534.819375,
    monthlyEquivalentLimitLabel: "$534.82 / 月",
    standardPriceUsdMonthlyPerSeat: 20,
    standardPriceSourceUrl: "https://openai.com/chatgpt/pricing/",
    standardPriceValidFrom: "2026-01-01T00:00:00Z",
    standardPriceValidTo: "",
    valueMultiplier: 26.74096875,
    valueMultiplierLabel: "26.74×",
    valueReasonCode: "calculated",
    valueReason: "有効な USD 建て標準価格と月間換算上限から算出しました。",
  },
  result: {
    id: "result-codex-weekly",
    resultSetKey: "codex-weekly-2026-08-25",
    status: status("provisional", "暫定推定", "informative", "info"),
    statusReasonCode: "exactly_identified",
    statusReason: "2つの観測点と利用額差分から一意に推定しました。",
    limits: [123],
    observationPointCount: 2,
    differenceRowCount: 1,
    rank: 1,
    absoluteErrorRatio: 0,
    absoluteErrorRatioLabel: "0.00%",
    maxTimeDelta: "1秒",
    calculationLogicVersion: "limit-estimation-v1",
    matchingRuleVersion: "nearest-observation-v1",
    inputFingerprint: "showcase-codex-weekly-v1",
    calculationIntervalIds: ["interval-codex-weekly-current"],
    validFrom: "2026-08-25T00:00:00Z",
    validTo: "2026-09-01T00:00:00Z",
    differenceRows: [
      {
        id: "difference-codex-weekly",
        startPointId: "point-weekly-start",
        endPointId: "point-weekly-current",
        startAt: "2026-08-25T00:05:00Z",
        endAt: "2026-08-26T00:05:00Z",
        coefficients: [0.255],
        cost: 31.365,
        accepted: true,
        exclusionReasonCode: "",
        exclusionReason: "",
      },
    ],
    evidence: [
      {
        id: "evidence-weekly-start",
        kind: "matched_observation",
        pointId: "point-weekly-start",
        sourceId: "source-weekly",
        observationId: "observation-weekly-start",
        snapshotId: "stats-snapshot-01",
        associationId: "association-weekly",
        completenessId: "completeness-codex",
        planHistoryId: "plan-history-plus",
        logicalAccountId: "account-codex",
        planVersionId: "plan-plus-2026",
        observedAt: "2026-08-25T00:05:00Z",
        timeDelta: "0秒",
        normalizationGeneration: 1,
        normalizationRuleVersion: "api-stats-v1",
        normalizationLogicVersion: "t012-normalize-v1",
        detailsJson: '{"remainingPercent":100,"costUsd":"0.000"}',
        m08Route: "/evidence?observationId=observation-weekly-start",
      },
      {
        id: "evidence-weekly-current",
        kind: "matched_observation",
        pointId: "point-weekly-current",
        sourceId: "source-weekly",
        observationId: "observation-weekly",
        snapshotId: "stats-snapshot-24",
        associationId: "association-weekly",
        completenessId: "completeness-codex",
        planHistoryId: "plan-history-plus",
        logicalAccountId: "account-codex",
        planVersionId: "plan-plus-2026",
        observedAt: "2026-08-26T00:05:00Z",
        timeDelta: "1秒",
        normalizationGeneration: 1,
        normalizationRuleVersion: "api-stats-v1",
        normalizationLogicVersion: "t012-normalize-v1",
        detailsJson: '{"remainingPercent":74.5,"costUsd":"31.365"}',
        m08Route: "/evidence?observationId=observation-weekly",
      },
    ],
  },
  latestValidReference: null,
  estimatedLimit: 123,
  estimatedLimitLabel: "123.00 USD相当",
  monthlyEquivalentLimit: 534.819375,
  monthlyEquivalentLimitLabel: "$534.82 / 月",
  standardPriceUsdMonthlyPerSeat: 20,
  standardPriceSourceUrl: "https://openai.com/chatgpt/pricing/",
  standardPriceValidFrom: "2026-01-01T00:00:00Z",
  standardPriceValidTo: "",
  valueMultiplier: 26.74096875,
  valueMultiplierLabel: "26.74×",
  valueReasonCode: "calculated",
  valueReason: "有効な USD 建て標準価格と月間換算上限から算出しました。",
};

const reviewItem: ReviewItemSnapshot = {
  id: "review-claude-identification",
  kind: "identification_candidate",
  state: "unconfirmed",
  impact: "current_calculation_impact",
  hubId: hub.id,
  sourceId: "source-unassigned",
  targetId: "candidate-claude",
  target: "Claude / Pro",
  rawLimitServiceIdentifier: "claude",
  rawReportedPlanName: "Pro",
  accountKey: "",
  accountDisplayName: "作業アカウント",
  workspaceName: "Engineering",
  deviceName: "評価端末",
  firstObservedAt: "2026-08-25T00:00:00Z",
  lastObservedAt: "2026-08-26T00:05:00Z",
  targetPeriodStart: "2026-08-25T00:00:00Z",
  targetPeriodEnd: "2026-09-01T00:00:00Z",
  count: 2,
  evidenceIds: ["observation-unassigned"],
  estimationExclusionReason:
    "サービスとプランの同定が未確認のため推定対象へ関連付けていません。",
  currentAssociation: null,
};

const warningItem: ReviewItemSnapshot = {
  id: "review-missing-account-key",
  kind: "missing_account_key",
  state: "missing",
  impact: "calculation_interval_impossible",
  hubId: hub.id,
  sourceId: "source-unassigned",
  targetId: "observation-unassigned",
  target: "Claude / 5時間利用枠",
  rawLimitServiceIdentifier: "claude",
  rawReportedPlanName: "Pro",
  accountKey: "",
  accountDisplayName: "作業アカウント",
  workspaceName: "Engineering",
  deviceName: "評価端末",
  firstObservedAt: "2026-08-25T23:55:00Z",
  lastObservedAt: "2026-08-26T00:05:00Z",
  targetPeriodStart: "2026-08-25T23:55:00Z",
  targetPeriodEnd: "2026-08-26T05:00:00Z",
  count: 2,
  evidenceIds: ["observation-unassigned"],
  estimationExclusionReason:
    "アカウント識別情報がないため利用枠系列へ関連付けできません。",
  currentAssociation: null,
};

const audit: AuditRecord = {
  sequence: 12,
  auditId: "audit-hub-connected",
  occurredAt: "2026-08-26T00:05:00Z",
  actor: "user",
  action: "hub_connection_succeeded",
  entityType: "hub",
  entityId: hub.id,
  beforeJson: '{"connectionState":"not_checked"}',
  afterJson: '{"connectionState":"connected","credential":"[非表示]"}',
};

const dataManagementState: DataManagementStateSnapshot = {
  ...emptyDataManagementState,
  capacity: {
    status: "success",
    capacity: {
      databaseSizeBytes: 12_582_912,
      rawSnapshotCount: 24,
      oldestCompletedAt: "2026-08-25T00:00:00Z",
      latestCompletedAt: "2026-08-26T00:05:00Z",
      rawJsonBytes: 8_388_608,
    },
    error: null,
  },
  backup: {
    status: "success",
    cancelAllowed: false,
    artifact: {
      path: "D:\\Backups\\token-monitor-analytics-20260826.zip",
      artifactSha256:
        "d2d2a0c7a8ad71d45dfebcdfb8da39c16d6ed99d94c5897e58d6e3c2bf63213e",
      sizeBytes: 4_718_592,
      formatVersion: 1,
      schemaVersion: 14,
      appVersion: "0.1.0",
      createdAt: "2026-08-26T00:08:00Z",
      warning: "",
    },
    error: null,
  },
  restore: {
    validation: {
      status: "success",
      cancelAllowed: false,
      applyAllowed: true,
      operationId: "restore-validation-showcase",
      artifact: {
        path: "D:\\Backups\\token-monitor-analytics-20260826.zip",
        artifactSha256:
          "d2d2a0c7a8ad71d45dfebcdfb8da39c16d6ed99d94c5897e58d6e3c2bf63213e",
        sizeBytes: 4_718_592,
        formatVersion: 1,
        schemaVersion: 14,
        appVersion: "0.1.0",
        createdAt: "2026-08-26T00:08:00Z",
        warning: "",
      },
      error: null,
    },
    trial: {
      status: "passed",
      cancelAllowed: false,
      artifactSha256:
        "d2d2a0c7a8ad71d45dfebcdfb8da39c16d6ed99d94c5897e58d6e3c2bf63213e",
      testedAt: "2026-08-26T00:09:00Z",
      warning: "",
      error: null,
    },
    apply: emptyDataManagementState.restore.apply,
  },
};

const catalog: Partial<CatalogSnapshot> = {
  services: [
    {
      id: "service-codex",
      provider: "OpenAI",
      name: "Codex",
      officialKey: "openai.codex",
      archivedAt: "",
      createdAt: "2026-08-25T00:00:00Z",
      updatedAt: "2026-08-26T00:05:00Z",
    },
  ],
  serviceIdentifierMappings: [
    {
      id: "mapping-cost-codex",
      kind: "usage_cost",
      rawIdentifier: "codex",
      serviceId: "service-codex",
      validFrom: "2026-08-25T00:00:00Z",
      validTo: "",
      createdAt: "2026-08-25T00:00:00Z",
    },
    {
      id: "mapping-limit-codex",
      kind: "usage_limit",
      rawIdentifier: "codex",
      serviceId: "service-codex",
      validFrom: "2026-08-25T00:00:00Z",
      validTo: "",
      createdAt: "2026-08-25T00:00:00Z",
    },
  ],
  limitDefinitions: [
    {
      id: "limit-weekly",
      serviceId: "service-codex",
      cycleType: "weekly",
      meaning: "週次利用枠",
      unit: "%",
      billingConfirmation: "not_applicable",
      archivedAt: "",
      createdAt: "2026-08-25T00:00:00Z",
      updatedAt: "2026-08-26T00:05:00Z",
    },
  ],
  plans: [
    {
      id: "plan-plus",
      serviceId: "service-codex",
      name: "Plus",
      isBaseline: true,
      archivedAt: "",
      createdAt: "2026-08-25T00:00:00Z",
      updatedAt: "2026-08-26T00:05:00Z",
    },
  ],
  planVersions: [
    {
      id: "plan-plus-2026",
      planId: "plan-plus",
      name: "Plus 2026",
      validFrom: "2026-01-01T00:00:00Z",
      validTo: "",
      officialSourceUrl: "https://example.invalid/plans/plus",
      createdAt: "2026-08-25T00:00:00Z",
    },
  ],
  planLimitRules: [
    {
      id: "rule-plus-weekly",
      planVersionId: "plan-plus-2026",
      limitDefinitionId: "limit-weekly",
      limit: 1000,
      multiplier: null,
      officialSourceUrl: "https://example.invalid/plans/plus#weekly-limit",
      createdAt: "2026-08-25T00:00:00Z",
    },
  ],
  standardPrices: [
    {
      id: "price-plus-2026",
      planVersionId: "plan-plus-2026",
      usdMonthlyPerSeat: 20,
      sourceUrl: "https://openai.com/chatgpt/pricing/",
      validFrom: "2026-01-01T00:00:00Z",
      validTo: "",
      createdAt: "2026-08-25T00:00:00Z",
    },
  ],
  identificationCandidates: [
    {
      id: "candidate-codex",
      rawLimitServiceIdentifier: "codex",
      rawReportedPlanName: "Plus",
      state: "confirmed",
      serviceId: "service-codex",
      planId: "plan-plus",
      firstObservedAt: "2026-08-25T00:00:00Z",
      lastObservedAt: "2026-08-26T00:05:00Z",
      createdAt: "2026-08-25T00:00:00Z",
      updatedAt: "2026-08-26T00:05:00Z",
      observations: [
        {
          id: "candidate-observation-codex",
          candidateId: "candidate-codex",
          hubId: hub.id,
          hubAccountDisplay: "個人アカウント / Personal / 評価端末",
          observedAt: "2026-08-26T00:05:00Z",
        },
      ],
    },
    {
      id: "candidate-claude",
      rawLimitServiceIdentifier: "claude",
      rawReportedPlanName: "Pro",
      state: "unconfirmed",
      serviceId: "",
      planId: "",
      firstObservedAt: "2026-08-25T23:55:00Z",
      lastObservedAt: "2026-08-26T00:05:00Z",
      createdAt: "2026-08-25T23:55:00Z",
      updatedAt: "2026-08-26T00:05:00Z",
      observations: [
        {
          id: "candidate-observation-claude",
          candidateId: "candidate-claude",
          hubId: hub.id,
          hubAccountDisplay: "作業アカウント / Engineering / 評価端末",
          observedAt: "2026-08-26T00:05:00Z",
        },
      ],
    },
  ],
};

const limitObservation: LimitObservationSnapshot = {
  observationId: "observation-weekly",
  snapshotId: "stats-snapshot-24",
  hubId: hub.id,
  deviceId: "device-evaluation",
  rawServiceIdentifier: "codex",
  accountKey: "account-key",
  providerUpdatedAt: "2026-08-26T00:05:00Z",
  windowKey: "weekly-percent",
  normalizedKind: "weekly",
  normalizedMetric: "percent",
  normalizedLabel: "Weekly",
  planLabel: "Plus",
  usedPercent: 25.5,
  remainingPercent: 74.5,
  resetsAt: "2026-09-01T00:00:00Z",
  syncUploadIntervalMs: 300000,
  limitsRefreshMs: 300000,
  analyticsIntervalSeconds: 300,
  sourceTimezone: "Asia/Tokyo",
  sourceLocalDate: "2026-08-26",
  normalizationGeneration: 1,
  normalizationRuleVersion: "api-stats-v1",
  normalizationLogicVersion: "t012-normalize-v1",
  jsonPath: "$.devices[0].limits.providers[0].windows[0]",
  dedupeState: "canonical",
  dedupeKey: "evaluation-weekly",
  valueFingerprint: "25.5",
  windowKeyConflict: false,
};

const startLimitObservation: LimitObservationSnapshot = {
  ...limitObservation,
  observationId: "observation-weekly-start",
  snapshotId: "stats-snapshot-01",
  providerUpdatedAt: "2026-08-25T00:05:00Z",
  usedPercent: 0,
  remainingPercent: 100,
  sourceLocalDate: "2026-08-25",
  dedupeKey: "evaluation-weekly-start",
  valueFingerprint: "0",
};

const unassignedLimitObservation: LimitObservationSnapshot = {
  ...limitObservation,
  observationId: "observation-unassigned",
  rawServiceIdentifier: "claude",
  accountKey: "",
  windowKey: "five-hour-percent",
  normalizedKind: "five_hour",
  normalizedLabel: "5時間",
  planLabel: "Pro",
  usedPercent: 58,
  remainingPercent: 42,
  resetsAt: "2026-08-26T05:00:00Z",
  jsonPath: "$.devices[0].limits.providers[1].windows[0]",
  dedupeKey: "evaluation-five-hour-unassigned",
  valueFingerprint: "58",
};

const usage: UsageSnapshot = {
  generatedAt: now,
  from: "2026-08-01T00:00:00Z",
  to: "2026-08-27T00:00:00Z",
  displayTimeZone: "Asia/Tokyo",
  granularity: "day",
  groupBy: "hub",
  summary: {
    tokens: 18_742_680,
    sharedTokens: 4_216_400,
    apiCostUsd: 31.365,
    sharedApiCostUsd: 7.64,
    apiCostUsdText: "31.365",
    sharedApiCostUsdText: "7.64",
    sourceCount: 3,
    observationCount: 72,
  },
  series: Array.from({ length: 14 }, (_, index) => {
    const tokens =
      [
        620, 910, 840, 1280, 990, 1610, 1350, 1720, 1190, 1840, 1560, 2010,
        1730, 2210,
      ][index] * 1000;
    const costs = [
      1.02, 1.49, 1.34, 2.16, 1.67, 2.72, 2.24, 2.89, 1.93, 3.02, 2.61, 3.37,
      2.83, 3.98,
    ][index];
    const day = String(index + 13).padStart(2, "0");
    const nextDay = String(index + 14).padStart(2, "0");
    return {
      periodStart: `2026-08-${day}T00:00:00+09:00`,
      periodEnd: `2026-08-${nextDay}T00:00:00+09:00`,
      tokens,
      sharedTokens: index % 3 === 1 ? Math.round(tokens * 0.28) : 0,
      apiCostUsd: costs,
      sharedApiCostUsd: index % 3 === 1 ? Number((costs * 0.28).toFixed(3)) : 0,
      apiCostUsdText: String(costs),
      sharedApiCostUsdText:
        index % 3 === 1 ? String(Number((costs * 0.28).toFixed(3))) : "0",
      observationCount: 5,
      breakdown: [
        {
          key: "hub-evaluation",
          categoryKey: "hub-evaluation",
          label: "評価 Hub（192.168.0.16）",
          attribution: "単一アカウントに帰属する利用実績",
          tokens: tokens - (index % 3 === 1 ? Math.round(tokens * 0.28) : 0),
          apiCostUsd:
            costs - (index % 3 === 1 ? Number((costs * 0.28).toFixed(3)) : 0),
          apiCostUsdText: String(
            costs - (index % 3 === 1 ? Number((costs * 0.28).toFixed(3)) : 0),
          ),
          observationCount: index % 3 === 1 ? 4 : 5,
          evidenceRoute: "/evidence?usageObservationId=usage-codex-current",
        },
        ...(index % 3 === 1
          ? [
              {
                key: "hub-evaluation:shared",
                categoryKey: "hub-evaluation",
                label: "評価 Hub（192.168.0.16）",
                attribution: "共有利用実績",
                tokens: Math.round(tokens * 0.28),
                apiCostUsd: Number((costs * 0.28).toFixed(3)),
                apiCostUsdText: String(Number((costs * 0.28).toFixed(3))),
                observationCount: 1,
                evidenceRoute:
                  "/evidence?usageObservationId=usage-shared-current",
              },
            ]
          : []),
      ],
    };
  }),
  breakdown: [
    {
      key: "hub-evaluation",
      categoryKey: "hub-evaluation",
      label: "評価 Hub（192.168.0.16）",
      attribution: "単一アカウントに帰属する利用実績",
      tokens: 14_526_280,
      apiCostUsd: 23.725,
      apiCostUsdText: "23.725",
      observationCount: 54,
      evidenceRoute: "/evidence?usageObservationId=usage-codex-current",
    },
    {
      key: "hub-evaluation:shared",
      categoryKey: "hub-evaluation",
      label: "評価 Hub（192.168.0.16）",
      attribution: "共有利用実績",
      tokens: 4_216_400,
      apiCostUsd: 7.64,
      apiCostUsdText: "7.64",
      observationCount: 18,
      evidenceRoute: "/evidence?usageObservationId=usage-shared-current",
    },
  ],
  nativeAmounts: [
    {
      observationId: "native-credits-current",
      hubName: "評価 Hub（192.168.0.16）",
      deviceId: "device-evaluation",
      serviceIdentifier: "claude",
      label: "Extra usage credits",
      metric: "credits",
      used: "58",
      limit: "100",
      remaining: "42",
      currency: "CREDITS",
      observedAt: "2026-08-26T00:05:00Z",
      m08Route: "/evidence?snapshotId=stats-snapshot-24",
    },
  ],
  evidence: [
    {
      sourceId: "source-cost-codex",
      startObservationId: "usage-codex-start",
      endObservationId: "usage-codex-current",
      startSnapshotId: "stats-snapshot-01",
      endSnapshotId: "stats-snapshot-24",
      hubName: "評価 Hub（192.168.0.16）",
      collectionDeviceId: "device-evaluation",
      deviceId: "device-evaluation",
      rawServiceIdentifier: "codex",
      startAt: "2026-08-25T00:05:00Z",
      endAt: "2026-08-26T00:05:00Z",
      jsonPath: "$.devices[0].periods.allTime.clients.codex",
      m08Route: "/evidence?usageObservationId=usage-codex-current",
    },
    {
      sourceId: "source-cost-shared",
      startObservationId: "usage-shared-start",
      endObservationId: "usage-shared-current",
      startSnapshotId: "stats-snapshot-01",
      endSnapshotId: "stats-snapshot-24",
      hubName: "評価 Hub（192.168.0.16）",
      collectionDeviceId: "device-evaluation",
      deviceId: "device-evaluation",
      rawServiceIdentifier: "claude",
      startAt: "2026-08-25T00:05:00Z",
      endAt: "2026-08-26T00:05:00Z",
      jsonPath: "$.devices[0].periods.allTime.clients.claude",
      m08Route: "/evidence?usageObservationId=usage-shared-current",
    },
  ],
};

type ShowcaseUsageCategory = {
  key: string;
  label: string;
  tokenShare: number;
  costShare: number;
};

function showcaseUsageCategories(groupBy: string): ShowcaseUsageCategory[] {
  switch (groupBy) {
    case "model":
      return [
        { key: "gpt-5", label: "GPT-5", tokenShare: 0.36, costShare: 0.32 },
        {
          key: "claude-sonnet",
          label: "Claude Sonnet",
          tokenShare: 0.24,
          costShare: 0.3,
        },
        {
          key: "gpt-5-mini",
          label: "GPT-5 mini",
          tokenShare: 0.15,
          costShare: 0.1,
        },
        {
          key: "gemini-pro",
          label: "Gemini Pro",
          tokenShare: 0.1,
          costShare: 0.08,
        },
        {
          key: "claude-opus",
          label: "Claude Opus",
          tokenShare: 0.08,
          costShare: 0.12,
        },
        {
          key: "other",
          label: "それ以外",
          tokenShare: 0.07,
          costShare: 0.08,
        },
      ];
    case "contract":
      return [
        {
          key: "plan-plus-2026",
          label: "Plus 2026",
          tokenShare: 0.58,
          costShare: 0.5,
        },
        {
          key: "plan-team-2026",
          label: "Team 2026",
          tokenShare: 0.29,
          costShare: 0.37,
        },
        {
          key: "unidentified-contract",
          label: "契約未同定",
          tokenShare: 0.13,
          costShare: 0.13,
        },
      ];
    case "agent":
      return [
        { key: "codex", label: "codex", tokenShare: 0.61, costShare: 0.55 },
        {
          key: "claude",
          label: "claude",
          tokenShare: 0.31,
          costShare: 0.37,
        },
        { key: "gemini", label: "gemini", tokenShare: 0.08, costShare: 0.08 },
      ];
    default:
      return [];
  }
}

function roundedUsageCost(value: number): number {
  return Number(value.toFixed(6));
}

function showcaseUsageByGroup(groupBy: string): UsageSnapshot {
  const categories = showcaseUsageCategories(groupBy);
  if (categories.length === 0) return { ...usage, groupBy };
  const series = (usage.series ?? []).map((point) => {
    let remainingTokens = point.tokens;
    let remainingCost = point.apiCostUsd;
    const values = categories.map((category, index) => {
      const last = index === categories.length - 1;
      const tokens = last
        ? remainingTokens
        : Math.round(point.tokens * category.tokenShare);
      const cost = last
        ? roundedUsageCost(remainingCost)
        : roundedUsageCost(point.apiCostUsd * category.costShare);
      remainingTokens -= tokens;
      remainingCost = roundedUsageCost(remainingCost - cost);
      return { category, tokens, cost };
    });
    const breakdown: NonNullable<UsageSnapshot["breakdown"]> = [];
    for (const [index, value] of values.entries()) {
      const sharedTokens =
        index === 0 ? Math.min(value.tokens, point.sharedTokens) : 0;
      const sharedCost =
        index === 0 ? Math.min(value.cost, point.sharedApiCostUsd) : 0;
      const ownedTokens = value.tokens - sharedTokens;
      const ownedCost = roundedUsageCost(value.cost - sharedCost);
      if (ownedTokens > 0 || ownedCost > 0) {
        breakdown.push({
          key: value.category.key,
          categoryKey: value.category.key,
          label: value.category.label,
          attribution: "単一アカウントに帰属する利用実績",
          tokens: ownedTokens,
          apiCostUsd: ownedCost,
          apiCostUsdText: String(ownedCost),
          observationCount: 4,
          evidenceRoute: "/evidence?usageObservationId=usage-codex-current",
        });
      }
      if (sharedTokens > 0 || sharedCost > 0) {
        breakdown.push({
          key: `${value.category.key}:shared`,
          categoryKey: value.category.key,
          label: value.category.label,
          attribution: "共有利用実績",
          tokens: sharedTokens,
          apiCostUsd: sharedCost,
          apiCostUsdText: String(sharedCost),
          observationCount: 1,
          evidenceRoute: "/evidence?usageObservationId=usage-shared-current",
        });
      }
    }
    return { ...point, breakdown };
  });
  const byKey = new Map<
    string,
    NonNullable<UsageSnapshot["breakdown"]>[number]
  >();
  for (const point of series) {
    for (const row of point.breakdown ?? []) {
      const current = byKey.get(row.key);
      if (!current) {
        byKey.set(row.key, { ...row });
        continue;
      }
      current.tokens += row.tokens;
      current.apiCostUsd = roundedUsageCost(
        current.apiCostUsd + row.apiCostUsd,
      );
      current.apiCostUsdText = String(current.apiCostUsd);
      current.observationCount += row.observationCount;
    }
  }
  return { ...usage, groupBy, series, breakdown: [...byKey.values()] };
}

export function createShowcaseBackend() {
  return createFakeBackend({
    canOpenMain: true,
    isShowcase: true,
    settings: { displayTimeZone: "Asia/Tokyo", timezoneConfirmed: true },
    overview,
    usage,
    onGetUsage: (input) => showcaseUsageByGroup(input.groupBy),
    onGetOverview: (privacyMode) => (privacyMode ? privacyOverview : overview),
    hubs: [hub],
    limitSeries: [limitSeries],
    limitSeriesDetails: {
      [limitSeries.id]: {
        series: limitSeries,
        current: limitSeries.currentInterval,
        history: limitSeries.currentInterval
          ? [
              {
                ...limitSeries.currentInterval,
                id: "interval-codex-weekly-previous",
                validFrom: "2026-08-18T00:00:00Z",
                validTo: "2026-08-25T00:00:00Z",
                boundaryIds: ["boundary-weekly-previous"],
                boundaries: [
                  {
                    id: "boundary-weekly-previous",
                    kindCode: "limit_reset",
                    kind: "利用枠リセット",
                    at: "2026-08-18T00:00:00Z",
                    reason: "前回の週次利用枠の開始を観測しました。",
                    relatedId: "observation-weekly-start",
                  },
                ],
                role: "historical",
                roleLabel: "履歴",
              },
            ]
          : [],
      },
    },
    reviewItems: [reviewItem, warningItem],
    audits: [audit],
    dataManagementState,
    catalog,
    accounts: {
      hubAccountCandidates: [
        {
          id: "hub-account-codex",
          hubId: hub.id,
          serviceId: "service-codex",
          accountKey: "account-key",
          displayName: "個人アカウント",
          email: "sample@example.invalid",
          workspaceName: "Personal",
          deviceName: "評価端末",
          state: "associated",
          logicalAccountId: "account-codex",
          firstObservedAt: "2026-08-25T00:00:00Z",
          lastObservedAt: "2026-08-26T00:05:00Z",
          createdAt: "2026-08-25T00:00:00Z",
          updatedAt: "2026-08-26T00:05:00Z",
        },
      ],
      logicalAccounts: [
        {
          id: "account-codex",
          serviceId: "service-codex",
          displayName: "個人アカウント",
          archivedAt: "",
          createdAt: "2026-08-25T00:00:00Z",
          updatedAt: "2026-08-26T00:05:00Z",
        },
      ],
      planHistories: [
        {
          id: "plan-history-plus",
          logicalAccountId: "account-codex",
          planVersionId: "plan-plus-2026",
          validFrom: "2026-01-01T00:00:00Z",
          validTo: "",
          createdAt: "2026-08-25T00:00:00Z",
          updatedAt: "2026-08-26T00:05:00Z",
        },
      ],
    },
    linking: {
      usageCostSources: [
        {
          id: "cost-source-codex",
          hubId: hub.id,
          deviceId: "device-evaluation",
          rawServiceIdentifier: "codex",
          createdAt: "2026-08-25T00:00:00Z",
        },
      ],
      usageLimitSources: [
        {
          id: "source-weekly",
          hubId: hub.id,
          deviceId: "device-evaluation",
          accountKey: "account-key",
          rawServiceIdentifier: "codex",
          windowKey: "weekly-percent",
          normalizedKind: "weekly",
          normalizedMetric: "percent",
          normalizedLabel: "Weekly",
          createdAt: "2026-08-25T00:00:00Z",
        },
      ],
      usageCostAssociations: [
        {
          id: "cost-association-codex",
          usageCostSourceId: "cost-source-codex",
          logicalAccountId: "account-codex",
          validFrom: "2026-08-25T00:00:00Z",
          validTo: "",
          createdAt: "2026-08-25T00:00:00Z",
          updatedAt: "2026-08-26T00:05:00Z",
        },
      ],
      usageLimitAssociations: [
        {
          id: "association-weekly",
          usageLimitSourceId: "source-weekly",
          logicalAccountId: "account-codex",
          limitDefinitionId: "limit-weekly",
          validFrom: "2026-08-25T00:00:00Z",
          validTo: "",
          createdAt: "2026-08-25T00:00:00Z",
          updatedAt: "2026-08-26T00:05:00Z",
        },
      ],
      usageCostSourceCompleteness: [
        {
          id: "completeness-codex",
          usageCostSourceId: "cost-source-codex",
          validFrom: "2026-08-25T00:00:00Z",
          validTo: "",
          state: "confirmed",
          logicalAccountIds: ["account-codex"],
          excludedActivity: [],
          createdAt: "2026-08-25T00:00:00Z",
          updatedAt: "2026-08-26T00:05:00Z",
        },
      ],
      hubSwitches: [
        {
          id: "hub-switch-evaluation-device",
          oldHubId: hub.id,
          oldDeviceId: "device-evaluation-old",
          newHubId: hub.id,
          newDeviceId: "device-evaluation",
          collectionDeviceId: "device-evaluation",
          switchedAt: "2026-08-25T00:00:00Z",
          createdAt: "2026-08-25T00:10:00Z",
        },
      ],
    },
    collectionAttempts: [
      {
        attemptId: "attempt-24",
        hubId: hub.id,
        trigger: "manual",
        state: "succeeded",
        startedAt: "2026-08-26T00:04:59Z",
        completedAt: "2026-08-26T00:05:00Z",
        analyticsIntervalSeconds: 300,
        healthHttpStatus: 200,
        statsHttpStatus: 200,
        apiContract: hub.apiContract,
        healthSnapshotId: "health-snapshot-24",
        statsSnapshotId: "stats-snapshot-24",
        failureCode: "",
        failureDetail: "",
        normalizationErrorPath: "",
      },
      {
        attemptId: "attempt-23",
        hubId: hub.id,
        trigger: "scheduled",
        state: "failed",
        startedAt: "2026-08-25T23:59:59Z",
        completedAt: "2026-08-26T00:00:00Z",
        analyticsIntervalSeconds: 300,
        healthHttpStatus: 200,
        statsHttpStatus: 503,
        apiContract: hub.apiContract,
        healthSnapshotId: "health-snapshot-23",
        statsSnapshotId: "",
        failureCode: "stats_http_error",
        failureDetail: "stats API が HTTP 503 を返しました。",
        normalizationErrorPath: "",
      },
      {
        attemptId: "attempt-01",
        hubId: hub.id,
        trigger: "scheduled",
        state: "succeeded",
        startedAt: "2026-08-25T00:04:59Z",
        completedAt: "2026-08-25T00:05:00Z",
        analyticsIntervalSeconds: 300,
        healthHttpStatus: 200,
        statsHttpStatus: 200,
        apiContract: hub.apiContract,
        healthSnapshotId: "health-snapshot-01",
        statsSnapshotId: "stats-snapshot-01",
        failureCode: "",
        failureDetail: "",
        normalizationErrorPath: "",
      },
    ],
    rawSnapshots: [
      {
        snapshotId: "stats-snapshot-24",
        attemptId: "attempt-24",
        hubId: hub.id,
        responseKind: "stats",
        receivedStartedAt: "2026-08-26T00:04:59Z",
        receivedCompletedAt: "2026-08-26T00:05:00Z",
        httpStatus: 200,
        apiContract: hub.apiContract,
        body: currentStatsBody,
      },
      {
        snapshotId: "stats-snapshot-01",
        attemptId: "attempt-01",
        hubId: hub.id,
        responseKind: "stats",
        receivedStartedAt: "2026-08-25T00:04:59Z",
        receivedCompletedAt: "2026-08-25T00:05:00Z",
        httpStatus: 200,
        apiContract: hub.apiContract,
        body: startStatsBody,
      },
    ],
    costObservations: [
      {
        observationId: "cost-observation-codex-start",
        snapshotId: "stats-snapshot-01",
        hubId: hub.id,
        deviceId: "device-evaluation",
        rawServiceIdentifier: "codex",
        usageUpdatedAt: "2026-08-25T00:05:00Z",
        costUsdText: "0.000",
        syncUploadIntervalMs: 300000,
        analyticsIntervalSeconds: 300,
        sourceTimezone: "Asia/Tokyo",
        sourceLocalDate: "2026-08-25",
        normalizationGeneration: 1,
        normalizationRuleVersion: "api-stats-v1",
        normalizationLogicVersion: "t012-normalize-v1",
        jsonPath: "$.devices[0].usage.providers[0]",
        dedupeState: "canonical",
        dedupeKey: "evaluation-cost-codex-start",
        valueFingerprint: "0.000",
      },
      {
        observationId: "cost-observation-codex",
        snapshotId: "stats-snapshot-24",
        hubId: hub.id,
        deviceId: "device-evaluation",
        rawServiceIdentifier: "codex",
        usageUpdatedAt: "2026-08-26T00:05:00Z",
        costUsdText: "31.365",
        syncUploadIntervalMs: 300000,
        analyticsIntervalSeconds: 300,
        sourceTimezone: "Asia/Tokyo",
        sourceLocalDate: "2026-08-26",
        normalizationGeneration: 1,
        normalizationRuleVersion: "api-stats-v1",
        normalizationLogicVersion: "t012-normalize-v1",
        jsonPath: "$.devices[0].usage.providers[0]",
        dedupeState: "canonical",
        dedupeKey: "evaluation-cost-codex",
        valueFingerprint: "31.365",
      },
    ],
    limitObservations: [
      startLimitObservation,
      limitObservation,
      unassignedLimitObservation,
    ],
  });
}
