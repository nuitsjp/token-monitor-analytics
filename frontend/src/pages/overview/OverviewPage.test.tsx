import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type {
  OverviewSnapshot,
  StatusPresentationSnapshot,
} from "../../../bindings/token-monitor-analytics/internal/desktop/models.js";
import { createFakeBackend, emptyOverviewSnapshot } from "../../lib/backend";
import { OverviewPage } from "./OverviewPage";

function status(
  code: string,
  label: string,
  intent: string,
  icon: string,
): StatusPresentationSnapshot {
  return {
    code,
    label,
    intent,
    icon,
    description: `${label}の説明`,
    nextAction: "確認する",
    nextRoute: "/overview",
  };
}

function populatedOverview(): OverviewSnapshot {
  return {
    ...emptyOverviewSnapshot,
    timezoneConfirmed: true,
    recoveryNotice: {
      status: status(
        "recovery_rolled_back",
        "復元を回復",
        "warning",
        "warning",
      ),
      artifactSha256: "a".repeat(64),
    },
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
        status: status("action_required", "要対応", "warning", "warning"),
        route: "/hubs",
        actionable: true,
      },
    ],
    hubs: {
      ...emptyOverviewSnapshot.hubs,
      totalCount: 1,
      enabledCount: 1,
      scheduledCount: 1,
      abnormalCount: 1,
      lastSuccessAt: "2026-08-26T00:05:00Z",
      connectionStates: [
        {
          status: status(
            "authentication_failed",
            "認証失敗",
            "danger",
            "error",
          ),
          count: 1,
        },
      ],
      currentCollectionStates: [
        {
          status: status("collection_idle", "待機中", "subtle", "info"),
          count: 1,
        },
      ],
      lastCollectionStates: [],
    },
    review: {
      ...emptyOverviewSnapshot.review,
      actionItems: {
        ...emptyOverviewSnapshot.review.actionItems,
        count: 2,
      },
      actionKinds: [
        {
          code: "identification_candidate",
          label: "サービス・プラン同定候補",
          count: 2,
        },
      ],
    },
    estimation: {
      states: [
        {
          status: status("verified", "検証済み推定", "success", "checkmark"),
          count: 3,
        },
      ],
    },
    capacity: {
      databaseSizeBytes: 4096,
      rawSnapshotCount: 2,
      oldestSnapshotAt: "2026-08-25T23:00:00Z",
      latestSnapshotAt: "2026-08-26T00:05:00Z",
    },
  };
}

function renderPage(snapshot: OverviewSnapshot = emptyOverviewSnapshot) {
  const backend = createFakeBackend({ overview: snapshot });
  render(
    <MemoryRouter>
      <main>
        <OverviewPage backend={backend} displayTimeZone="Asia/Tokyo" />
      </main>
    </MemoryRouter>,
  );
  return backend;
}

describe("OverviewPage", () => {
  it("shows recovery, checklist, Hub, review and available estimation data only", async () => {
    const user = userEvent.setup();
    renderPage(populatedOverview());

    expect(await screen.findByText("復元を回復")).toBeVisible();
    expect(screen.getByText("推定状態")).toBeVisible();
    expect(screen.getByText("検証済み推定")).toBeVisible();
    expect(screen.getByText("サービス・プラン同定候補: 2 件")).toBeVisible();
    const next = screen.getByRole("button", { name: "次の設定へ" });
    next.focus();
    expect(next).toHaveFocus();
    await user.keyboard("{Enter}");
  });

  it("does not render empty unimplemented metric cards", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { name: "概要" })).toBeVisible();
    expect(screen.queryByText("推定状態")).not.toBeInTheDocument();
    expect(
      screen.queryByText("利用増加を最近確認した利用枠"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/当日.*トークン/)).not.toBeInTheDocument();
  });

  it("shows restore maintenance instead of operational values", async () => {
    renderPage({
      ...populatedOverview(),
      maintenance: {
        operation: "restore",
        phase: "restore_apply",
        status: {
          code: "restore_apply",
          label: "復元中",
          intent: "warning",
          icon: "warning",
          description:
            "バックアップを復元しています。完了後に値を再表示します。",
          nextAction: "",
          nextRoute: "",
        },
      },
    });
    expect(
      await screen.findByLabelText(
        "復元中。バックアップを復元しています。完了後に値を再表示します。",
      ),
    ).toBeVisible();
    expect(screen.queryByText("推定状態")).not.toBeInTheDocument();
    expect(
      screen.queryByText("利用増加を最近確認した利用枠"),
    ).not.toBeInTheDocument();
  });

  it("shows a retryable error after the loading state", async () => {
    let reject = true;
    const backend = createFakeBackend({
      onGetOverview: async () => {
        if (reject) throw new Error("read failed");
        return emptyOverviewSnapshot;
      },
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <main>
          <OverviewPage backend={backend} displayTimeZone="UTC" />
        </main>
      </MemoryRouter>,
    );
    expect(screen.getByLabelText("概要を読み込み中")).toBeVisible();
    expect(
      await screen.findByText("概要を読み込めませんでした。"),
    ).toBeVisible();
    reject = false;
    await user.click(screen.getByRole("button", { name: "再試行" }));
    expect(await screen.findByRole("heading", { name: "概要" })).toBeVisible();
  });

  it("has no automatically detectable accessibility violation", async () => {
    renderPage(populatedOverview());
    expect(await screen.findByRole("heading", { name: "概要" })).toBeVisible();
    const result = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations).toEqual([]);
  });

  it("moves focus to the M01 heading when T01 opens the current route", async () => {
    const backend = renderPage(populatedOverview());
    const heading = await screen.findByRole("heading", { name: "概要" });
    const review = screen.getByRole("button", { name: "要確認を開く" });
    review.focus();
    expect(review).toHaveFocus();

    backend.emit("navigation:open", "/overview");

    expect(heading).toHaveFocus();
  });
});
