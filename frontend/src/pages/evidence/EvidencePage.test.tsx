import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { expect, it } from "vitest";
import { MemoryRouter } from "react-router";
import { createFakeBackend } from "../../lib/backend";
import type {
  LimitSeriesDetailSnapshot,
  LimitSeriesSnapshot,
} from "../../../bindings/token-monitor-analytics/internal/desktop/models.js";
import { EvidencePage } from "./EvidencePage";

const series: LimitSeriesSnapshot = {
  id: "series-1",
  serviceId: "service-1",
  serviceName: "Service",
  logicalAccountId: "account-1",
  logicalAccountName: "Account",
  limitDefinitionId: "definition-1",
  limitDefinitionName: "Weekly",
  cycleType: "weekly",
  billingConfirmation: "not_applicable",
  usageLimitSourceId: "source-1",
  associationId: "association-1",
  normalizedKind: "weekly",
  normalizedMetric: "percent",
  planHistoryId: "history-1",
  planVersionId: "version-1",
  planVersionName: "Plan",
  planLimitRuleId: "rule-1",
  planLimit: 100,
  planLimitLabel: "100",
  multiplier: null,
  usedPercent: 25,
  usedPercentLabel: "25",
  usedPercentDetailLabel: "25.00",
  remainingPercent: 75,
  remainingLabel: "75%",
  remainingDetailLabel: "75.00%",
  resetAt: "2026-08-27T00:00:00Z",
  latestObservationAt: "2026-08-26T11:00:00Z",
  seriesState: "normal",
  state: {
    code: "provisional",
    label: "暫定推定",
    intent: "informative",
    icon: "info",
    description: "暫定推定です。",
    nextAction: "根拠を確認",
    nextRoute: "/evidence?seriesId=series-1",
  },
  stateReasonCode: "exactly_identified",
  stateReason: "必要な根拠があります。",
  currentInterval: {
    id: "interval-1",
    serviceId: "service-1",
    logicalAccountId: "account-1",
    usageLimitSourceId: "source-1",
    limitDefinitionId: "definition-1",
    planVersionId: "version-1",
    cycleType: "weekly",
    validFrom: "2026-08-26T00:00:00Z",
    validTo: "2026-09-02T00:00:00Z",
    state: "estimable",
    stateLabel: "推定可能",
    exclusionReasonCode: "",
    exclusionReason: "",
    boundaryIds: [],
    boundaries: [],
    role: "current",
    roleLabel: "現在区間",
  },
  result: {
    id: "result-1",
    resultSetKey: "result-set-1",
    status: {
      code: "provisional",
      label: "暫定推定",
      intent: "informative",
      icon: "info",
      description: "暫定推定です。",
      nextAction: "根拠を確認",
      nextRoute: "/evidence?seriesId=series-1",
    },
    statusReasonCode: "exactly_identified",
    statusReason: "観測根拠に基づきます。",
    limits: [100],
    observationPointCount: 2,
    differenceRowCount: 1,
    rank: 1,
    absoluteErrorRatio: 0,
    absoluteErrorRatioLabel: "0.00%",
    maxTimeDelta: "1s",
    calculationLogicVersion: "logic-v1",
    matchingRuleVersion: "matching-v1",
    inputFingerprint: "fingerprint",
    calculationIntervalIds: ["interval-1"],
    validFrom: "2026-08-26T00:00:00Z",
    validTo: "2026-09-02T00:00:00Z",
    differenceRows: [
      {
        id: "difference-1",
        startPointId: "point-1",
        endPointId: "point-2",
        startAt: "2026-08-26T01:00:00Z",
        endAt: "2026-08-26T02:00:00Z",
        coefficients: [0.25],
        cost: 1,
        accepted: true,
        exclusionReasonCode: "",
        exclusionReason: "",
      },
    ],
    evidence: [
      {
        id: "evidence-1",
        kind: "matched_observation",
        pointId: "point-1",
        sourceId: "source-1",
        observationId: "limit-1",
        snapshotId: "stats-1",
        associationId: "association-1",
        completenessId: "",
        planHistoryId: "history-1",
        logicalAccountId: "account-1",
        planVersionId: "version-1",
        observedAt: "2026-08-26T01:00:00Z",
        timeDelta: "1s",
        normalizationGeneration: 1,
        normalizationRuleVersion: "rule-v1",
        normalizationLogicVersion: "logic-v1",
        detailsJson: "{}",
        m08Route: "/evidence?observationId=limit-1",
      },
    ],
  },
  latestValidReference: null,
  estimatedLimit: 100,
  estimatedLimitLabel: "100",
  monthlyEquivalentLimit: null,
  monthlyEquivalentLimitLabel: "",
  standardPriceUsdMonthlyPerSeat: null,
  standardPriceSourceUrl: "",
  standardPriceValidFrom: "",
  standardPriceValidTo: "",
  valueMultiplier: null,
  valueMultiplierLabel: "",
  valueReasonCode: "",
  valueReason: "",
};

const seriesDetail: LimitSeriesDetailSnapshot = {
  series,
  current: series.currentInterval,
  history: [],
};

const backend = () =>
  createFakeBackend({
    hubs: [
      {
        id: "hub-1",
        displayName: "評価 Hub",
        url: "https://hub.example.test",
        enabled: true,
        collectionEnabled: false,
        collectionIntervalSeconds: 300,
        apiContract: "schema=1",
        credentialState: "registered",
        credentialReady: true,
        connectionState: "connected",
        connectionCheckedAt: "2026-08-25T12:00:00Z",
        connectionFailureNote: "",
      },
    ],
    collectionAttempts: [
      {
        attemptId: "attempt-1",
        hubId: "hub-1",
        trigger: "manual",
        state: "succeeded",
        startedAt: "2026-08-25T12:00:00Z",
        completedAt: "2026-08-25T12:00:01Z",
        analyticsIntervalSeconds: 300,
        healthHttpStatus: 200,
        statsHttpStatus: 200,
        apiContract: "schema=1",
        healthSnapshotId: "health-1",
        statsSnapshotId: "stats-1",
        failureCode: "",
        failureDetail: "",
        normalizationErrorPath: "",
      },
    ],
    rawSnapshots: [
      {
        snapshotId: "stats-1",
        attemptId: "attempt-1",
        hubId: "hub-1",
        responseKind: "stats",
        receivedStartedAt: "2026-08-25T12:00:00Z",
        receivedCompletedAt: "2026-08-25T12:00:01Z",
        httpStatus: 200,
        apiContract: "schema=1",
        body: '{"devices":[{"deviceId":"device-1","accessToken":"[MASKED]"}]}',
      },
    ],
    costObservations: [
      {
        observationId: "cost-1",
        snapshotId: "stats-1",
        hubId: "hub-1",
        deviceId: "device-1",
        rawServiceIdentifier: "codex",
        usageUpdatedAt: "2026-08-25T12:00:00Z",
        costUsdText: "31.365",
        syncUploadIntervalMs: 300000,
        analyticsIntervalSeconds: 300,
        sourceTimezone: "Asia/Tokyo",
        sourceLocalDate: "2026-08-25",
        normalizationGeneration: 1,
        normalizationRuleVersion: "api-stats-v1",
        normalizationLogicVersion: "t012-normalize-v1",
        jsonPath: "$.devices[0].usage.providers[0]",
        dedupeState: "canonical",
        dedupeKey: "cost-key",
        valueFingerprint: "31.365",
      },
    ],
    limitObservations: [
      {
        observationId: "limit-1",
        snapshotId: "stats-1",
        hubId: "hub-1",
        deviceId: "device-1",
        rawServiceIdentifier: "codex",
        accountKey: "account",
        providerUpdatedAt: "2026-08-25T12:00:00Z",
        windowKey: "weekly-percent",
        normalizedKind: "weekly",
        normalizedMetric: "percent",
        normalizedLabel: "Weekly",
        planLabel: "Plus",
        usedPercent: 25,
        remainingPercent: 75,
        resetsAt: "",
        syncUploadIntervalMs: 300000,
        limitsRefreshMs: 300000,
        analyticsIntervalSeconds: 300,
        sourceTimezone: "Asia/Tokyo",
        sourceLocalDate: "2026-08-25",
        normalizationGeneration: 1,
        normalizationRuleVersion: "api-stats-v1",
        normalizationLogicVersion: "t012-normalize-v1",
        jsonPath: "$.devices[0].limits.providers[0].windows[0]",
        dedupeState: "canonical",
        dedupeKey: "key",
        valueFingerprint: "fingerprint",
        windowKeyConflict: false,
      },
    ],
    limitSeries: [series],
    limitSeriesDetails: { "series-1": seriesDetail },
  });

it("shows acquisition, masked raw evidence, and source observations", async () => {
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <EvidencePage backend={backend()} displayTimeZone="Asia/Tokyo" />
    </MemoryRouter>,
  );

  expect(await screen.findByText("手動取得 / 成功")).toBeVisible();
  await user.click(screen.getByRole("tab", { name: "原 JSON" }));
  expect(screen.getByText(/未知フィールドと秘密値/)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "マスク済み詳細" }));
  expect(await screen.findByText(/\[MASKED\]/)).toBeInTheDocument();
  expect(screen.getByLabelText("JSON ツリー")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: /原 JSON 全体.*コピー/ }),
  ).not.toBeInTheDocument();

  await user.type(screen.getByLabelText("原 JSON 内を検索"), "accessToken");
  const pathButtons = screen.getAllByRole("button", {
    name: "JSON パスをコピー",
  });
  await user.click(pathButtons[pathButtons.length - 1]);
  expect(
    await screen.findByText(/\$\.devices\[0\]\.accessToken/),
  ).toBeVisible();

  await user.click(screen.getByRole("button", { name: "折り返しテキスト" }));
  expect(screen.getByLabelText("折り返し原 JSON")).toBeVisible();
  expect(screen.getByText("accessToken")).toBeVisible();

  await user.click(screen.getByRole("tab", { name: "元観測" }));
  expect(await screen.findByText(/31\.365 USD/)).toBeVisible();
  expect(await screen.findByText(/利用 25% \/ 残り 75%/)).toBeVisible();
});

it("selects and highlights an observation from an M08 query", async () => {
  render(
    <MemoryRouter initialEntries={["/evidence?observationId=limit-1"]}>
      <EvidencePage backend={backend()} displayTimeZone="UTC" />
    </MemoryRouter>,
  );
  expect(await screen.findByTestId("target-observation")).toBeVisible();
  expect(screen.getByRole("tab", { name: "元観測" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

it("selects and highlights a raw snapshot from an M08 query", async () => {
  render(
    <MemoryRouter initialEntries={["/evidence?snapshotId=stats-1"]}>
      <EvidencePage backend={backend()} displayTimeZone="UTC" />
    </MemoryRouter>,
  );
  expect(await screen.findByTestId("target-snapshot")).toBeVisible();
  expect(screen.getByRole("tab", { name: "原 JSON" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

it("traces a limit series and its calculation evidence from an M08 series query", async () => {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={["/evidence?seriesId=series-1"]}>
      <EvidencePage backend={backend()} displayTimeZone="Asia/Tokyo" />
    </MemoryRouter>,
  );
  expect(await screen.findByText(/系列の状態と区間/)).toBeVisible();
  expect(screen.getAllByText("暫定推定")[0]).toBeVisible();
  expect(screen.getByText(/現在区間:/)).toBeVisible();
  expect(screen.getByRole("tab", { name: "利用枠系列" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await user.click(screen.getByRole("tab", { name: "計算根拠" }));
  expect(
    await screen.findByRole("heading", { name: "計算結果" }),
  ).toBeVisible();
  expect(screen.getByText(/観測根拠に基づきます/)).toBeVisible();
  expect(
    screen.getByRole("link", { name: "観測と根拠で確認" }),
  ).toHaveAttribute("href", "/evidence?observationId=limit-1");
});

it("has no automatically detectable accessibility violations", async () => {
  render(
    <MemoryRouter>
      <EvidencePage backend={backend()} displayTimeZone="UTC" />
    </MemoryRouter>,
  );
  await screen.findByText("手動取得 / 成功");
  const result = await axe.run(document.body, {
    rules: { "color-contrast": { enabled: false } },
  });
  expect(result.violations).toEqual([]);
});
