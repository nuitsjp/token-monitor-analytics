import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import { createFakeBackend, type UsageSnapshot } from "../../lib/backend";
import { UsagePage } from "./UsagePage";

const usage: UsageSnapshot = {
  generatedAt: "2026-08-26T00:00:00Z",
  from: "2026-08-01T00:00:00Z",
  to: "2026-08-27T00:00:00Z",
  displayTimeZone: "Asia/Tokyo",
  granularity: "day",
  groupBy: "hub",
  summary: {
    tokens: 12_500,
    sharedTokens: 2_500,
    apiCostUsd: 3.25,
    sharedApiCostUsd: 0.75,
    apiCostUsdText: "3.25",
    sharedApiCostUsdText: "0.75",
    sourceCount: 2,
    observationCount: 4,
  },
  series: [
    {
      periodStart: "2026-08-26T00:00:00+09:00",
      periodEnd: "2026-08-27T00:00:00+09:00",
      tokens: 12_500,
      sharedTokens: 2_500,
      apiCostUsd: 3.25,
      sharedApiCostUsd: 0.75,
      apiCostUsdText: "3.25",
      sharedApiCostUsdText: "0.75",
      observationCount: 4,
      breakdown: [
        {
          key: "hub",
          categoryKey: "hub",
          label: "Home Hub",
          attribution: "単一アカウントに帰属する利用実績",
          tokens: 10_000,
          apiCostUsd: 2.5,
          apiCostUsdText: "2.5",
          observationCount: 2,
          evidenceRoute: "/evidence?usageObservationId=owned-end",
        },
        {
          key: "hub:shared",
          categoryKey: "hub",
          label: "Home Hub",
          attribution: "共有利用実績",
          tokens: 2_500,
          apiCostUsd: 0.75,
          apiCostUsdText: "0.75",
          observationCount: 2,
          evidenceRoute: "/evidence?usageObservationId=end",
        },
      ],
    },
  ],
  breakdown: [
    {
      key: "hub",
      categoryKey: "hub",
      label: "Home Hub",
      attribution: "単一アカウントに帰属する利用実績",
      tokens: 10_000,
      apiCostUsd: 2.5,
      apiCostUsdText: "2.5",
      observationCount: 2,
      evidenceRoute: "/evidence?usageObservationId=owned-end",
    },
    {
      key: "hub:shared",
      categoryKey: "hub",
      label: "Home Hub",
      attribution: "共有利用実績",
      tokens: 2_500,
      apiCostUsd: 0.75,
      apiCostUsdText: "0.75",
      observationCount: 2,
      evidenceRoute: "/evidence?usageObservationId=end",
    },
  ],
  nativeAmounts: [],
  evidence: [],
};

it("SCREEN-M02 AC-P2-05 AC-P2-06 renders usage, shared attribution and filter controls", async () => {
  const { container } = render(
    <MemoryRouter>
      <UsagePage
        backend={createFakeBackend({ usage })}
        displayTimeZone="Asia/Tokyo"
      />
    </MemoryRouter>,
  );
  expect(await screen.findByText("12,500")).toBeInTheDocument();
  expect(screen.getAllByText("共有利用実績").length).toBeGreaterThan(0);
  expect(screen.getByDisplayValue("Asia/Tokyo")).toBeInTheDocument();
  expect(
    screen.getByRole("group", {
      name: "利用量とAPI換算利用金額の分類別積み上げ棒グラフ",
    }),
  ).toBeInTheDocument();
  expect(screen.getByText("時系列データ")).toBeInTheDocument();
  expect(container.querySelectorAll('[data-category-key="hub"]')).toHaveLength(
    1,
  );
  const patternRects = container.querySelectorAll("svg defs pattern rect");
  expect(patternRects).toHaveLength(2);
  expect(patternRects[0]?.getAttribute("fill")).toBe(
    patternRects[1]?.getAttribute("fill"),
  );
  await userEvent.click(
    screen.getByRole("button", {
      name: /利用量 12,500 トークン、API換算利用金額 3.25 USD/,
    }),
  );
  expect(screen.getByText("選択中の期間")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "期間合計へ戻す" }),
  ).toBeInTheDocument();
  await userEvent.selectOptions(screen.getByLabelText("集計単位"), "week");
  expect(screen.getByLabelText("集計単位")).toHaveValue("week");
  const results = await axe.run(container);
  expect(results.violations).toHaveLength(0);
});

it("switches the common classification used by both usage axes", async () => {
  const backend = createFakeBackend({ usage });
  const getUsage = vi.spyOn(backend, "getUsage");
  render(
    <MemoryRouter>
      <UsagePage backend={backend} displayTimeZone="Asia/Tokyo" />
    </MemoryRouter>,
  );

  await screen.findByText("12,500");
  const classification = screen.getByLabelText("積み上げの分類");
  expect(classification).toHaveValue("model");
  expect(
    screen.getByRole("option", { name: "契約（プラン版）" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("option", {
      name: "AIエージェント（観測クライアント）",
    }),
  ).toBeInTheDocument();

  await userEvent.selectOptions(classification, "contract");
  await waitFor(() =>
    expect(
      getUsage.mock.calls[getUsage.mock.calls.length - 1]?.[0].groupBy,
    ).toBe("contract"),
  );
  expect(screen.getByText(/契約（プラン版）で共通分類/)).toBeInTheDocument();
});

it("P2-VIS-01 renders collapsible advanced filters with count, chip and clear", async () => {
  const backend = createFakeBackend({ usage });
  const getUsage = vi.spyOn(backend, "getUsage");
  render(
    <MemoryRouter>
      <UsagePage backend={backend} displayTimeZone="Asia/Tokyo" />
    </MemoryRouter>,
  );

  await screen.findByText("12,500");
  const filterButton = screen.getByRole("button", { name: "詳細フィルター" });
  expect(filterButton).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(filterButton);
  expect(screen.getByLabelText("収集端末")).toBeInTheDocument();
  expect(screen.getByLabelText("Hub 端末レコード")).toBeInTheDocument();
  expect(screen.getByLabelText("正式サービス")).toBeInTheDocument();
  expect(screen.getByLabelText("論理アカウント")).toBeInTheDocument();
  expect(screen.getByLabelText("プラン版")).toBeInTheDocument();
  expect(screen.getByLabelText("利用枠定義")).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText("モデル"), "gpt-5");
  expect(getUsage.mock.calls[getUsage.mock.calls.length - 1]?.[0].model).toBe(
    "gpt-5",
  );
  expect(screen.getByText("モデル: gpt-5")).toBeInTheDocument();
  expect(screen.getByLabelText("適用中 1件")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "すべて解除" }));
  expect(screen.queryByText("モデル: gpt-5")).not.toBeInTheDocument();
});
