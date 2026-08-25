import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  OverviewRecentLimitSnapshot,
  OverviewSnapshot,
  StatusPresentationSnapshot,
} from "../../../bindings/token-monitor-analytics/internal/desktop/models.js";
import { AppProviders } from "../../app/providers";
import {
  createFakeBackend,
  emitFakeBackendEvent,
  emptyOverviewSnapshot,
} from "../../lib/backend";
import type { FrontendAdapter, HubSnapshot } from "../../lib/backend";
import { CompactWindow, compactRefreshMilliseconds } from "./CompactWindow";

function hub(collectionEnabled: boolean): HubSnapshot {
  return {
    id: "hub-1",
    displayName: "検証Hub",
    url: "https://hub.example.test",
    enabled: true,
    collectionEnabled,
    collectionIntervalSeconds: 300,
    apiContract: "v1",
    credentialState: "registered",
    credentialReady: true,
    connectionState: "connected",
    connectionCheckedAt: "2026-08-26T00:00:00Z",
    connectionFailureNote: "",
  };
}

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
    description: `${label}の説明`,
    nextAction: "",
    nextRoute: "",
  };
}

function recentLimit(
  index: number,
  masked = false,
): OverviewRecentLimitSnapshot {
  const account = masked ? "••••" : `機微アカウント${index}`;
  const remainingLabel = masked ? "••••" : `${70 + index}.0%`;
  return {
    logicalAccountId: `account-${index}`,
    limitDefinitionId: `definition-${index}`,
    serviceName: `Service ${index}`,
    accountName: account,
    limitName: `Weekly ${index}`,
    cycleType: "weekly",
    remainingPercent: masked ? null : 70 + index,
    remainingLabel,
    remainingDetailLabel: masked ? "••••" : `${70 + index}.00%`,
    remaining: masked
      ? status("privacy_hidden", "非表示", "subtle")
      : status("remaining_high", "残量良好", "success", "checkmark"),
    resetAt: masked ? "" : "2026-08-27T00:00:00Z",
    reset: masked
      ? status("privacy_hidden", "非表示", "subtle")
      : status("reset_scheduled", "リセット予定"),
    lastIncrease: {
      occurredAt: "2026-08-26T00:00:00Z",
      ageLabel: "10分前",
    },
    freshness: {
      status: status("freshness_current", "最新", "success", "checkmark"),
      reason: "保存された取得間隔内です。",
      observationAt: "2026-08-26T00:05:00Z",
      ageLabel: "5分前",
    },
    privacyMasked: masked,
    accessibleLabel: `Service ${index}、${account}、残り ${remainingLabel}`,
    tooltip: `残り ${remainingLabel}`,
  };
}

function overview(masked = false): OverviewSnapshot {
  return {
    ...emptyOverviewSnapshot,
    generatedAt: "2026-08-26T00:10:00Z",
    timezoneConfirmed: true,
    hubs: {
      ...emptyOverviewSnapshot.hubs,
      totalCount: 1,
      enabledCount: 1,
      scheduledCount: 1,
      items: [
        {
          id: "hub-1",
          displayName: "検証Hub",
          enabled: true,
          collectionEnabled: true,
          connection: status("connected", "接続済み", "success", "checkmark"),
          currentCollection: status(
            "collection_idle",
            "待機中",
            "subtle",
            "info",
          ),
          lastCollection: status(
            "collection_succeeded",
            "取得成功",
            "success",
            "checkmark",
          ),
          lastCollectionAt: "2026-08-26T00:05:00Z",
          lastSuccessAt: "2026-08-26T00:05:00Z",
          lastFailureAt: "",
          lastSkippedAt: "",
        },
      ],
    },
    capacity: {
      databaseSizeBytes: 4096,
      rawSnapshotCount: 2,
      oldestSnapshotAt: "2026-08-26T00:00:00Z",
      latestSnapshotAt: "2026-08-26T00:05:00Z",
    },
    recentLimits: [1, 2, 3, 4].map((index) => recentLimit(index, masked)),
  };
}

function renderCompact(backend: FrontendAdapter) {
  return render(
    <AppProviders backend={backend}>
      <CompactWindow backend={backend} />
    </AppProviders>,
  );
}

afterEach(() => {
  vi.useRealTimers();
  document.documentElement.style.fontSize = "";
});

describe("CompactWindow", () => {
  it("shows two real limits collapsed and four after native expansion", async () => {
    const user = userEvent.setup();
    const expandedStates: boolean[] = [];
    const backend = createFakeBackend({
      canOpenMain: true,
      overview: overview(),
      onSetCompactExpanded: (expanded) => expandedStates.push(expanded),
    });
    renderCompact(backend);

    const root = screen.getByRole("main");
    expect(root).toHaveAttribute("data-compact-expanded", "false");
    expect(await screen.findByText("Weekly 1")).toBeVisible();
    expect(screen.getByText("Weekly 2")).toBeVisible();
    expect(screen.queryByText("Weekly 3")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "利用枠を展開" }));

    expect(root).toHaveAttribute("data-compact-expanded", "true");
    expect(screen.getByText("Weekly 4")).toBeVisible();
    expect(screen.getByText("現在の実行")).toBeVisible();
    expect(screen.getByText("待機中")).toBeVisible();
    expect(expandedStates).toEqual([true]);
    expect(root.querySelector('[data-region="limit-list"]')).not.toBeNull();
  });

  it("requests the Go-masked DTO for shortcut privacy mode and removes raw values immediately", async () => {
    const calls: boolean[] = [];
    const backend = createFakeBackend({
      overview: overview(),
      onGetOverview: async (privacyMode) => {
        calls.push(privacyMode);
        return overview(privacyMode);
      },
    });
    const user = userEvent.setup();
    renderCompact(backend);
    expect(await screen.findByText(/機微アカウント1/)).toBeVisible();

    await user.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
    expect(screen.queryByText(/機微アカウント1/)).not.toBeInTheDocument();
    expect(await screen.findAllByText(/••••/)).not.toHaveLength(0);
    expect(calls.slice(0, 2)).toEqual([false, true]);
    expect(document.body.textContent).not.toContain("71.0%");
  });

  it("periodically refreshes without moving keyboard focus", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const backend = createFakeBackend({
      overview: overview(),
      onGetOverview: () => {
        calls += 1;
        return overview();
      },
    });
    renderCompact(backend);
    await vi.waitFor(() => expect(calls).toBe(1));
    const privacy = screen.getByRole("button", {
      name: "プライバシーモード",
    });
    privacy.focus();

    await vi.advanceTimersByTimeAsync(compactRefreshMilliseconds);
    await vi.waitFor(() => expect(calls).toBe(2));
    expect(document.activeElement).toBe(privacy);
  });

  it("opens fixed main routes from detail and status controls", async () => {
    const routes: string[] = [];
    const backend = createFakeBackend({
      canOpenMain: true,
      overview: overview(),
      onOpenMainRoute: (route) => routes.push(route),
    });
    const user = userEvent.setup();
    renderCompact(backend);
    await user.click(await screen.findByRole("button", { name: "詳細" }));
    await user.click(screen.getByRole("button", { name: /異常 Hub/ }));
    expect(routes).toEqual(["/overview", "/hubs"]);
  });

  it("shows loading, empty and retryable error states", async () => {
    let reject = true;
    const backend = createFakeBackend({
      onGetOverview: async () => {
        if (reject) throw new Error("read failed");
        return emptyOverviewSnapshot;
      },
    });
    const user = userEvent.setup();
    renderCompact(backend);
    expect(screen.getByText("運用状態を読み込み中")).toBeVisible();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "最新状態を読み込めませんでした。",
    );
    reject = false;
    await user.click(screen.getByRole("button", { name: "再試行" }));
    expect(await screen.findByText("Hub が登録されていません")).toBeVisible();
  });

  it("stops enabled Hub collection before confirming whole-app quit", async () => {
    const calls: string[] = [];
    const backend = createFakeBackend({
      hubs: [hub(true), { ...hub(false), id: "hub-2" }],
      onConfirmQuit: () => calls.push("quit"),
    });
    backend.stopCollection = async (hubID) => {
      calls.push(`stop:${hubID}`);
    };
    const user = userEvent.setup();
    renderCompact(backend);

    emitFakeBackendEvent(backend, "app:quit-requested");
    await user.click(await screen.findByRole("button", { name: "終了" }));

    await waitFor(() => expect(calls).toEqual(["stop:hub-1", "quit"]));
  });

  it("keeps the quit request open when collection stop fails", async () => {
    const backend = createFakeBackend({
      hubs: [hub(true)],
      onConfirmQuit: () => {
        throw new Error("should not quit");
      },
    });
    backend.stopCollection = async () => {
      throw new Error("stop failed");
    };
    const user = userEvent.setup();
    renderCompact(backend);

    emitFakeBackendEvent(backend, "app:quit-requested");
    await user.click(await screen.findByRole("button", { name: "終了" }));

    expect(
      await screen.findByText(
        "収集処理を停止できなかったため、終了していません。",
      ),
    ).toBeVisible();
  });

  it("has no automatically detectable accessibility violation at 200% text size", async () => {
    document.documentElement.style.fontSize = "200%";
    const backend = createFakeBackend({ overview: overview() });
    renderCompact(backend);
    expect(await screen.findByText("Weekly 1")).toBeVisible();
    const result = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations).toEqual([]);
  });
});
