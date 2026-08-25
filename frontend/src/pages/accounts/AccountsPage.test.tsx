import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AccountSnapshot,
  CatalogSnapshot,
  HubSnapshot,
} from "../../../bindings/token-monitor-analytics/internal/desktop/models.js";
import { createFakeBackend } from "../../lib/backend";
import { AccountsPage } from "./AccountsPage";

const hub: HubSnapshot = {
  id: "hub-1",
  displayName: "検証Hub",
  url: "https://hub.example.test",
  enabled: true,
  collectionEnabled: true,
  collectionIntervalSeconds: 300,
  apiContract: "",
  credentialState: "registered",
  credentialReady: true,
  connectionState: "connected",
  connectionCheckedAt: "2026-08-25T00:00:00Z",
  connectionFailureNote: "",
};

const catalog: Partial<CatalogSnapshot> = {
  services: [
    {
      id: "service-1",
      provider: "Provider",
      name: "Analytics",
      officialKey: "provider.analytics",
      archivedAt: "",
      createdAt: "2026-08-24T00:00:00Z",
      updatedAt: "2026-08-24T00:00:00Z",
    },
  ],
  planVersions: [
    {
      id: "version-1",
      planId: "plan-1",
      name: "Standard v1",
      validFrom: "2026-08-01T00:00:00Z",
      validTo: "",
      officialSourceUrl: "https://provider.example/plan",
      createdAt: "2026-08-24T00:00:00Z",
    },
  ],
};

const accounts: AccountSnapshot = {
  logicalAccounts: [
    {
      id: "logical-1",
      serviceId: "service-1",
      displayName: "既存アカウント",
      archivedAt: "",
      createdAt: "2026-08-24T00:00:00Z",
      updatedAt: "2026-08-24T00:00:00Z",
    },
  ],
  hubAccountCandidates: [
    {
      id: "candidate-1",
      hubId: "hub-1",
      serviceId: "service-1",
      accountKey: "provider-key",
      displayName: "観測アカウント",
      email: "person@example.test",
      workspaceName: "Workspace",
      deviceName: "Device",
      state: "unconfirmed",
      logicalAccountId: "",
      firstObservedAt: "2026-08-24T00:00:00Z",
      lastObservedAt: "2026-08-25T00:00:00Z",
      createdAt: "2026-08-24T00:00:00Z",
      updatedAt: "2026-08-25T00:00:00Z",
    },
  ],
  planHistories: [],
};

function renderPage() {
  const backend = createFakeBackend({ accounts, hubs: [hub], catalog });
  const onDirtyChange = vi.fn();
  render(
    <main aria-label="メイン画面">
      <AccountsPage
        backend={backend}
        onDirtyChange={onDirtyChange}
        displayTimeZone="Asia/Tokyo"
      />
    </main>,
  );
  return { backend, onDirtyChange };
}

afterEach(() => vi.restoreAllMocks());

describe("AccountsPage", () => {
  it("shows only the three implemented M05 tabs and supports account editing", async () => {
    const { backend, onDirtyChange } = renderPage();
    const user = userEvent.setup();

    expect(
      await screen.findByRole("heading", { name: "アカウント・関連付け" }),
    ).toBeVisible();
    expect(screen.getByRole("tab", { name: "論理アカウント" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Hubアカウント" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "プラン履歴" })).toBeVisible();
    expect(screen.queryByText("利用額関連付け")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "編集" }));
    expect(screen.getByRole("textbox", { name: "表示名" })).toHaveValue(
      "既存アカウント",
    );
    await user.clear(screen.getByRole("textbox", { name: "表示名" }));
    await user.type(
      screen.getByRole("textbox", { name: "表示名" }),
      "編集済みアカウント",
    );
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    const update = vi.spyOn(backend, "updateLogicalAccount");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "logical-1",
          displayName: "編集済みアカウント",
        }),
      ),
    );
    expect(
      await screen.findByRole("heading", { name: "編集済みアカウント" }),
    ).toBeVisible();
  });

  it("confirms archive and exposes candidate reject/release actions", async () => {
    const { backend } = renderPage();
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const archive = vi.spyOn(backend, "archiveLogicalAccount");
    await screen.findByRole("heading", { name: "既存アカウント" });
    await user.click(screen.getByRole("button", { name: "アーカイブ" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("アーカイブ"));
    await waitFor(() => expect(archive).toHaveBeenCalledWith("logical-1"));

    await user.click(screen.getByRole("tab", { name: "Hubアカウント" }));
    expect(
      await screen.findByRole("heading", { name: "観測アカウント" }),
    ).toBeVisible();
    const reject = vi.spyOn(backend, "rejectHubAccountCandidate");
    await user.click(screen.getByRole("button", { name: "対象外" }));
    await waitFor(() => expect(reject).toHaveBeenCalledWith("candidate-1"));
    expect((await screen.findAllByText("対象外")).length).toBeGreaterThan(0);
    const release = vi.spyOn(backend, "releaseHubAccountCandidate");
    await user.click(screen.getByRole("button", { name: "解除" }));
    await waitFor(() => expect(release).toHaveBeenCalledWith("candidate-1"));
  });

  it("saves a plan history with an explicit half-open UTC interval", async () => {
    const { backend } = renderPage();
    const user = userEvent.setup();
    const create = vi.spyOn(backend, "createPlanHistory");
    await screen.findByRole("heading", { name: "既存アカウント" });
    await user.click(screen.getByRole("tab", { name: "プラン履歴" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "論理アカウント" }),
      "logical-1",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "プラン版" }),
      "version-1",
    );
    await user.type(
      screen.getByRole("textbox", { name: "開始（UTC / RFC3339Nano）" }),
      "2026-08-25T00:00:00Z",
    );
    await user.type(
      screen.getByRole("textbox", {
        name: "終了（UTC / RFC3339Nano、空欄可）",
      }),
      "2026-08-26T00:00:00Z",
    );
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          validFrom: "2026-08-25T00:00:00Z",
          validTo: "2026-08-26T00:00:00Z",
        }),
      ),
    );
    expect(await screen.findByText(/有効期間:/)).toBeVisible();
  });

  it("has no automatically detectable accessibility violations", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "既存アカウント" });
    const result = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations).toEqual([]);
  });
});
