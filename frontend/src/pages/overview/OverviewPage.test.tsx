import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type {
  OverviewSnapshot,
  StatusPresentationSnapshot,
} from "../../../bindings/token-monitor-analytics/internal/desktop/models.js";
import {
  createFakeBackend,
  emptyDataManagementState,
  emptyOverviewSnapshot,
} from "../../lib/backend";
import type { DataManagementStateSnapshot } from "../../lib/backend";
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

function renderPage(
  snapshot: OverviewSnapshot = emptyOverviewSnapshot,
  dataManagementState: DataManagementStateSnapshot = emptyDataManagementState,
) {
  const backend = createFakeBackend({
    overview: snapshot,
    dataManagementState,
  });
  render(
    <MemoryRouter>
      <main>
        <OverviewPage backend={backend} displayTimeZone="Asia/Tokyo" />
      </main>
    </MemoryRouter>,
  );
  return backend;
}

function dataManagementSummary(): DataManagementStateSnapshot {
  return {
    ...emptyDataManagementState,
    backup: {
      ...emptyDataManagementState.backup,
      status: "succeeded",
      artifact: {
        path: "D:\\backup\\latest.zip",
        artifactSha256: "a".repeat(64),
        sizeBytes: 1024,
        formatVersion: 1,
        schemaVersion: 1,
        appVersion: "test",
        createdAt: "2026-08-26T00:08:00Z",
        warning: "",
      },
    },
    restore: {
      ...emptyDataManagementState.restore,
      trial: {
        ...emptyDataManagementState.restore.trial,
        status: "passed",
        testedAt: "2026-08-26T00:09:00Z",
      },
    },
  };
}

describe("OverviewPage", () => {
  it("shows recovery, checklist, Hub, review and available estimation data only", async () => {
    renderPage(populatedOverview(), dataManagementSummary());

    expect(await screen.findByText("復元を回復")).toBeVisible();
    expect(screen.getByText("接続状態")).toBeVisible();
    expect(screen.getByText("現在の実行状態")).toBeVisible();
    expect(screen.getByText("最終取得結果")).toBeVisible();
    expect(screen.getByText("推定状態")).toBeVisible();
    expect(screen.getByText("検証済み推定")).toBeVisible();
    expect(screen.getByText("旧区間を表示中")).toBeVisible();
    expect(screen.getByText("サービス・プラン同定候補")).toBeVisible();
    expect(screen.getByText("バックアップ")).toBeVisible();
    expect(screen.getByText("成功 · 8/26 9:08")).toBeVisible();
    expect(screen.getByText("復元試験")).toBeVisible();
    expect(screen.getByText("合格 · 8/26 9:09")).toBeVisible();
    expect(
      screen.getAllByRole("link", { name: "利用上限・価値を開く" }),
    ).toHaveLength(1);
    expect(
      screen.getByRole("link", { name: "データ管理を開く" }),
    ).toBeVisible();
    const user = userEvent.setup();
    const next = screen.getByRole("button", { name: "確認する" });
    next.focus();
    expect(next).toHaveFocus();
    await user.keyboard("{Enter}");
  });

  it("shows zero-valued Phase 1 summaries without Phase 2 cards", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { name: "概要" })).toBeVisible();
    expect(screen.getByText("推定状態")).toBeVisible();
    expect(screen.getByText("推定対象 0件")).toBeVisible();
    expect(screen.getByText("バックアップ")).toBeVisible();
    expect(screen.getAllByText("未実施")).toHaveLength(2);
    expect(
      screen.getByText("バックアップには資格情報を含みません。"),
    ).toBeVisible();
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
    expect(await screen.findByText("復元中")).toBeVisible();
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
    const user = userEvent.setup();
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
    const review = screen.getByRole("link", { name: "要確認を開く" });
    review.focus();
    expect(review).toHaveFocus();

    backend.emit("navigation:open", "/overview");

    expect(heading).toHaveFocus();
  });
});
