import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import type {
  LimitSeriesDetailSnapshot,
  LimitSeriesSnapshot,
} from "../../lib/backend";
import { createFakeBackend } from "../../lib/backend";
import { LimitsPage } from "./LimitsPage";

vi.mock("keyborg", async (importOriginal) => {
  const actual = await importOriginal<typeof import("keyborg")>();
  return {
    ...actual,
    createKeyborg: () => ({
      isNavigatingWithKeyboard: () => false,
      subscribe: () => undefined,
      unsubscribe: () => undefined,
      setVal: () => undefined,
    }),
    disposeKeyborg: () => undefined,
  };
});

vi.mock("../../components/StatusBadge", () => ({
  StatusBadge: ({ status }: { status: { label: string } }) => (
    <span>{status.label}</span>
  ),
}));

function series(): LimitSeriesSnapshot {
  return {
    id: "association-1",
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
    planLimit: 1000,
    planLimitLabel: "1000.00",
    multiplier: null,
    usedPercent: 25.5,
    usedPercentLabel: "25.5",
    usedPercentDetailLabel: "25.50",
    remainingPercent: 74.5,
    remainingLabel: "74.5%",
    remainingDetailLabel: "74.50%",
    resetAt: "2026-08-27T00:00:00Z",
    latestObservationAt: "2026-08-26T11:00:00Z",
    seriesState: "normal",
    state: {
      code: "estimated",
      label: "推定済み",
      intent: "success",
      icon: "checkmark",
      description: "利用上限の推定を算出できました。",
      nextAction: "",
      nextRoute: "",
    },
    stateReasonCode: "positive_unique_solution",
    stateReason: "利用枠観測から利用上限を算出しました。",
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
      roleLabel: "カレント",
      estimatedLimit: null,
      estimatedLimitLabel: "",
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
    },
    result: {
      id: "result-1",
      resultSetKey: "key",
      status: {
        code: "estimated",
        label: "推定済み",
        intent: "success",
        icon: "checkmark",
        description: "利用上限の推定を算出できました。",
        nextAction: "",
        nextRoute: "",
      },
      statusReasonCode: "positive_unique_solution",
      statusReason: "必要十分な差分行から推定しました。",
      limits: [123],
      observationPointCount: 2,
      differenceRowCount: 1,
      rank: 1,
      maxTimeDelta: "1s",
      calculationLogicVersion: "logic",
      matchingRuleVersion: "matching",
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
          cost: 12,
          accepted: false,
          exclusionReasonCode: "negative_utilization_delta",
          exclusionReason: "利用率が減少した隣接行です。",
        },
      ],
      evidence: [
        {
          id: "evidence-1",
          kind: "matched_observation",
          pointId: "point-1",
          sourceId: "source-1",
          observationId: "observation-1",
          snapshotId: "snapshot-1",
          associationId: "association-1",
          completenessId: "",
          planHistoryId: "history-1",
          logicalAccountId: "account-1",
          planVersionId: "version-1",
          observedAt: "2026-08-26T01:00:00Z",
          timeDelta: "1s",
          normalizationGeneration: 1,
          normalizationRuleVersion: "rule",
          normalizationLogicVersion: "logic",
          detailsJson: "{}",
          m08Route: "/evidence?observationId=observation-1",
        },
      ],
    },
    latestValidReference: null,
    estimatedLimit: 123,
    estimatedLimitLabel: "123.00",
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
}

function backend(
  limitSeries: LimitSeriesSnapshot[] = [series()],
  limitSeriesDetails: Record<string, LimitSeriesDetailSnapshot> = {},
) {
  return createFakeBackend({
    catalog: {
      services: [
        {
          id: "service-1",
          provider: "provider",
          name: "Service",
          officialKey: "service",
          archivedAt: "",
          createdAt: "",
          updatedAt: "",
        },
      ],
      limitDefinitions: [
        {
          id: "definition-1",
          serviceId: "service-1",
          cycleType: "weekly",
          meaning: "Weekly",
          unit: "percent",
          billingConfirmation: "not_applicable",
          archivedAt: "",
          createdAt: "",
          updatedAt: "",
        },
      ],
      planVersions: [
        {
          id: "version-1",
          planId: "plan-1",
          name: "Plan",
          validFrom: "2026-01-01T00:00:00Z",
          validTo: "",
          officialSourceUrl: "https://example.test/plan",
          createdAt: "",
        },
      ],
    },
    limitSeries,
    limitSeriesDetails,
  });
}

function renderLimits(
  initialEntry: string,
  displayTimeZone: string,
  backendInstance = backend(),
) {
  const page = (
    <LimitsPage backend={backendInstance} displayTimeZone={displayTimeZone} />
  );
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/limits" element={page} />
        <Route path="/limits/:seriesID" element={page} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => vi.restoreAllMocks());

it("shows M03 Go-owned state/remaining/estimate and all evidence rows", async () => {
  vi.spyOn(Date, "now").mockReturnValue(
    new Date("2026-08-26T00:00:00Z").getTime(),
  );
  const user = userEvent.setup();
  renderLimits("/limits", "Asia/Tokyo");
  expect(await screen.findByText("74.5%")).toBeVisible();
  expect(screen.getByText("74.5%")).toBeVisible();
  expect(screen.getByText("123.00")).toBeVisible();
  expect(screen.getByText("リセット")).toBeVisible();
  expect(screen.getByText("8/27 9:00")).toBeVisible();
  expect(screen.getByText("25.5%")).toBeVisible();
  expect(screen.queryByText("25.50%")).not.toBeInTheDocument();
  await user.click(screen.getByRole("link", { name: "詳細" }));
  expect(await screen.findByRole("tab", { name: "根拠" })).toBeVisible();
  await user.click(screen.getByRole("tab", { name: "根拠" }));
  expect(screen.getByText("利用率が減少した隣接行です。")).toBeVisible();
  expect(
    screen.getByRole("link", { name: "観測と根拠で確認" }),
  ).toHaveAttribute("href", "/evidence?observationId=observation-1");
});

it("labels unknown and elapsed reset instants explicitly", async () => {
  vi.spyOn(Date, "now").mockReturnValue(
    new Date("2026-08-26T00:00:00Z").getTime(),
  );
  const unknown = { ...series(), id: "unknown-reset", resetAt: "" };
  const elapsed = {
    ...series(),
    id: "elapsed-reset",
    logicalAccountId: "account-2",
    resetAt: "2026-08-25T00:00:00Z",
  };

  renderLimits("/limits", "UTC", backend([unknown, elapsed]));

  expect(await screen.findByText("経過済み")).toBeVisible();
  expect(screen.getAllByText("不明").length).toBeGreaterThan(0);
});

it("P1-UI-04 shows current state, API-converted estimate, quality, and an uncomputed reason", async () => {
  const complete = series();
  const uncomputed: LimitSeriesSnapshot = {
    ...series(),
    id: "series-uncomputed",
    logicalAccountId: "account-uncomputed",
    logicalAccountName: "Uncomputed account",
    state: {
      code: "insufficient_observations",
      label: "観測不足",
      intent: "warning",
      icon: "warning",
      description: "観測が不足しています。",
      nextAction: "未算出理由を確認",
      nextRoute: "/limits",
    },
    stateReasonCode: "insufficient_observations",
    stateReason: "観測が不足しているため未算出です。",
    result: null,
    planLimit: null,
    planLimitLabel: "",
    estimatedLimit: null,
    estimatedLimitLabel: "",
  };
  const user = userEvent.setup();
  renderLimits("/limits", "UTC", backend([complete, uncomputed]));

  expect((await screen.findAllByText("観測不足")).length).toBeGreaterThan(0);
  expect(screen.getByText("観測が不足しているため未算出です。")).toBeVisible();
  expect(screen.getByText("123.00")).toBeVisible();

  const details = screen.getAllByRole("link", { name: "詳細" });
  await user.click(details[0]);
  expect(await screen.findByText("推定済み")).toBeVisible();
  expect(screen.getByText("123.00")).toBeVisible();
  await user.click(screen.getByRole("tab", { name: "品質" }));
  expect(screen.getByText("計算論理版: logic")).toBeVisible();
  expect(screen.getByText("差分行数: 1")).toBeVisible();
});

it("P1-UI-06 distinguishes the current interval from the latest valid historical interval", async () => {
  const current = series();
  const currentInterval = current.currentInterval!;
  const historical = {
    ...currentInterval,
    id: "interval-history",
    validFrom: "2026-08-12T00:00:00Z",
    validTo: "2026-08-19T00:00:00Z",
    stateLabel: "過去の算出可能区間",
    role: "historical",
    roleLabel: "非カレント",
  };
  current.latestValidReference = {
    resultId: "result-history",
    status: current.state,
    validFrom: historical.validFrom,
    validTo: historical.validTo,
    age: "14日",
    observedAt: "2026-08-18T00:00:00Z",
  };
  const details: Record<string, LimitSeriesDetailSnapshot> = {
    "association-1": {
      series: current,
      current: currentInterval,
      history: [historical, currentInterval],
    },
  };
  const user = userEvent.setup();
  renderLimits("/limits", "UTC", backend([current], details));

  expect(await screen.findByText(/過去の最新有効区間を参照/)).toBeVisible();
  expect(screen.getByText(/経過 14日/)).toBeVisible();
  await user.click(screen.getByRole("link", { name: "詳細" }));
  await user.click(screen.getByRole("tab", { name: "履歴" }));
  expect(screen.getByText(/非カレント/)).toBeVisible();
  expect(screen.getByText("カレント")).toBeVisible();
});

it("P2-VIS-02 shows current and latest valid interval values as separate history rows", async () => {
  const current = series();
  const currentInterval = {
    ...current.currentInterval!,
    estimatedLimit: 123,
    estimatedLimitLabel: "123.00",
    monthlyEquivalentLimit: 534.82,
    monthlyEquivalentLimitLabel: "534.82",
    standardPriceUsdMonthlyPerSeat: 10,
    standardPriceSourceUrl: "https://vendor.example/current-prices",
    standardPriceValidFrom: "2026-08-20T00:00:00Z",
    standardPriceValidTo: "",
    valueMultiplier: 53.48,
    valueMultiplierLabel: "53.48×",
    valueReasonCode: "computed",
    valueReason: "算出済み",
  };
  const historical = {
    ...currentInterval,
    id: "interval-history",
    validFrom: "2026-08-12T00:00:00Z",
    validTo: "2026-08-19T00:00:00Z",
    role: "latest_valid_reference",
    roleLabel: "最新有効参照",
    estimatedLimit: 77,
    estimatedLimitLabel: "77.00",
    monthlyEquivalentLimit: 336.94,
    monthlyEquivalentLimitLabel: "336.94",
    standardPriceUsdMonthlyPerSeat: 8,
    standardPriceSourceUrl: "https://vendor.example/historical-prices",
    standardPriceValidFrom: "2026-08-01T00:00:00Z",
    standardPriceValidTo: "2026-08-20T00:00:00Z",
    valueMultiplier: 42.12,
    valueMultiplierLabel: "42.12×",
  };
  current.currentInterval = currentInterval;
  const details: Record<string, LimitSeriesDetailSnapshot> = {
    "association-1": {
      series: current,
      current: currentInterval,
      history: [historical, currentInterval],
    },
  };
  const user = userEvent.setup();
  renderLimits("/limits", "UTC", backend([current], details));

  await user.click(await screen.findByRole("link", { name: "詳細" }));
  await user.click(screen.getByRole("tab", { name: "履歴" }));

  expect(screen.getByText("カレント")).toBeVisible();
  expect(screen.getByText("最新有効参照")).toBeVisible();
  expect(screen.getByText("123.00")).toBeVisible();
  expect(screen.getByText("77.00")).toBeVisible();
  expect(screen.getByText("534.82")).toBeVisible();
  expect(screen.getByText("336.94")).toBeVisible();
  expect(screen.getByText("$10.00 / 月")).toBeVisible();
  expect(screen.getByText("$8.00 / 月")).toBeVisible();
  expect(screen.getByText("53.48×")).toBeVisible();
  expect(screen.getByText("42.12×")).toBeVisible();
  expect(
    screen.getByRole("link", {
      name: "https://vendor.example/historical-prices",
    }),
  ).toHaveAttribute("href", "https://vendor.example/historical-prices");
  expect(screen.getByText(/有効期間: 8\/1 0:00/)).toBeVisible();
});

it("has no automatically detectable accessibility violations", async () => {
  renderLimits("/limits", "UTC");
  await screen.findByText("74.5%");
  const result = await axe.run(document.body, {
    rules: { "color-contrast": { enabled: false } },
  });
  expect(result.violations).toEqual([]);
});
