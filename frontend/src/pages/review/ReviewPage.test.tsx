import { MemoryRouter } from "react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import { createFakeBackend } from "../../lib/backend";
import type { ReviewItemSnapshot } from "../../lib/backend";
import { ReviewPage } from "./ReviewPage";

const review = (
  overrides: Partial<ReviewItemSnapshot> = {},
): ReviewItemSnapshot => ({
  id: "review-1",
  kind: "identification_candidate",
  state: "unconfirmed",
  impact: "current_calculation_impact",
  hubId: "hub-1",
  sourceId: "source-1",
  targetId: "target-1",
  target: "サービス候補 A",
  rawLimitServiceIdentifier: "",
  rawReportedPlanName: "",
  accountKey: "account-key",
  accountDisplayName: "表示アカウント",
  workspaceName: "ワークスペース",
  deviceName: "端末 A",
  firstObservedAt: "2026-08-01T00:00:00Z",
  lastObservedAt: "2026-08-02T00:00:00Z",
  targetPeriodStart: "2026-08-01T00:00:00Z",
  targetPeriodEnd: "2026-09-01T00:00:00Z",
  count: 2,
  evidenceIds: ["evidence-1", "evidence-2"],
  estimationExclusionReason: "未確認のため推定から除外",
  currentAssociation: {
    logicalAccountDisplayName: "論理アカウント A",
    limitMeaning: "入力上限",
    planVersionName: "Plan A v1",
    associationValidFrom: "2026-07-01T00:00:00Z",
    associationValidTo: "2026-12-01T00:00:00Z",
    planValidFrom: "2026-08-01T00:00:00Z",
    planValidTo: "2026-09-01T00:00:00Z",
  },
  ...overrides,
});

function renderPage(backend: ReturnType<typeof createFakeBackend>) {
  return render(
    <MemoryRouter initialEntries={["/review"]}>
      <main aria-label="メイン画面">
        <ReviewPage backend={backend} displayTimeZone="Asia/Tokyo" />
      </main>
    </MemoryRouter>,
  );
}

describe("ReviewPage", () => {
  it("P1-UI-02 exposes each review work category and archived reconfirmation", async () => {
    const workItems = [
      review({
        id: "review-identification",
        kind: "identification_candidate",
        target: "サービス候補",
      }),
      review({
        id: "review-account",
        kind: "hub_account_candidate",
        target: "Hubアカウント候補",
      }),
      review({
        id: "review-cost",
        kind: "usage_cost_unassociated",
        target: "未関連付け利用額",
      }),
      review({
        id: "review-limit",
        kind: "usage_limit_unassociated",
        target: "未関連付け利用枠",
      }),
      review({
        id: "review-label",
        kind: "label_change",
        target: "利用枠名称変更",
      }),
      review({
        id: "review-plan",
        kind: "plan_history_inconsistency",
        target: "プラン履歴不整合",
      }),
      review({
        id: "review-completeness",
        kind: "completeness",
        target: "活動主体の完全性",
      }),
      review({
        id: "review-archived",
        kind: "hub_account_candidate",
        state: "archived_reconfirmation",
        target: "アーカイブ後の新規観測",
      }),
    ];
    const user = userEvent.setup();
    renderPage(createFakeBackend({ reviewItems: workItems }));

    expect(
      await screen.findByRole("button", { name: "サービス候補" }),
    ).toBeVisible();
    expect(screen.getByRole("list", { name: "要確認作業一覧" })).toBeVisible();
    expect(screen.getAllByRole("listitem")).toHaveLength(workItems.length);
    expect(
      screen.getByRole("option", { name: "アーカイブ後再確認" }),
    ).toBeInTheDocument();

    for (const item of workItems) {
      await user.click(screen.getByRole("button", { name: item.target }));
      expect(
        screen.getAllByText(kindLabelForTest(item.kind)).length,
      ).toBeGreaterThan(0);
    }
    expect(screen.getAllByText("アーカイブ後再確認").length).toBeGreaterThan(0);
  });

  it("shows separate read-only work and warning tabs with non-secret detail", async () => {
    const backend = createFakeBackend({
      reviewItems: [
        review(),
        review({
          id: "review-warning",
          kind: "missing_account_key",
          state: "missing",
          target: "警告対象",
          estimationExclusionReason: "accountKey が空のため除外",
          currentAssociation: null,
        }),
      ],
    });
    const user = userEvent.setup();
    renderPage(backend);

    expect(screen.getByText("要確認項目を読み込み中")).toBeVisible();
    expect(
      await screen.findByRole("button", { name: "サービス候補 A" }),
    ).toBeVisible();
    expect(screen.getByText("未確認のため推定から除外")).toBeVisible();
    expect(screen.getByText(/現在の関連付け/)).toBeVisible();
    expect(screen.getByText(/論理アカウント: 論理アカウント A/)).toBeVisible();
    expect(screen.getByText(/プラン履歴有効期間/)).toBeVisible();
    expect(screen.queryByText("review-1")).not.toBeInTheDocument();
    expect(screen.queryByText("evidence-1")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "データ警告" }));
    expect(
      await screen.findByRole("button", { name: "警告対象" }),
    ).toBeVisible();
    expect(screen.queryByText("サービス候補 A")).not.toBeInTheDocument();
    expect(screen.getByText("accountKey が空のため除外")).toBeVisible();
    expect(screen.getByText("なし")).toBeVisible();
  });

  it("passes half-open date and classification filters to the adapter", async () => {
    const backend = createFakeBackend({ reviewItems: [review()] });
    const getReviewItems = vi.spyOn(backend, "getReviewItems");
    const user = userEvent.setup();
    renderPage(backend);
    await screen.findByRole("button", { name: "サービス候補 A" });

    await user.type(
      screen.getByLabelText("開始日時（UTC）"),
      "2026-08-01T09:00",
    );
    await user.type(
      screen.getByLabelText("終了日時（UTC・含まない）"),
      "2026-08-03T09:00",
    );
    await user.selectOptions(screen.getByLabelText("状態"), "unconfirmed");
    await user.selectOptions(
      screen.getByLabelText("影響区分"),
      "current_calculation_impact",
    );
    await user.click(screen.getByRole("button", { name: "絞り込む" }));

    await waitFor(() =>
      expect(getReviewItems).toHaveBeenLastCalledWith(
        expect.objectContaining({
          state: "unconfirmed",
          impact: "current_calculation_impact",
          from: "2026-08-01T09:00:00.000Z",
          to: "2026-08-03T09:00:00.000Z",
        }),
      ),
    );
  });

  it("shows empty and retryable error states", async () => {
    const backend = createFakeBackend();
    renderPage(backend);
    expect(
      await screen.findByText(
        "要確認作業はありません。完全一致した設定は自動的に関連付け済みです。",
      ),
    ).toBeVisible();

    const failed = createFakeBackend();
    vi.spyOn(failed, "getReviewItems").mockRejectedValue(
      new Error("読み込み失敗"),
    );
    renderPage(failed);
    expect(await screen.findByText("読み込み失敗")).toBeVisible();
    expect(screen.getAllByRole("button", { name: "再試行" }).length).toBe(1);
  });

  it("has no automatically detectable accessibility violations", async () => {
    renderPage(createFakeBackend({ reviewItems: [review()] }));
    await screen.findByRole("button", { name: "サービス候補 A" });
    const result = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations).toEqual([]);
  });
});

function kindLabelForTest(kind: string): string {
  const labels: Record<string, string> = {
    identification_candidate: "サービス・プラン同定候補",
    hub_account_candidate: "Hubアカウント候補",
    usage_cost_unassociated: "未関連付け利用額",
    usage_limit_unassociated: "未関連付け利用枠",
    label_change: "利用枠名称変更候補",
    plan_history_inconsistency: "プラン履歴不整合",
    completeness: "活動主体の完全性",
  };
  return labels[kind] ?? kind;
}
