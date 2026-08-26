import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AccountSnapshot,
  CatalogSnapshot,
  HubSnapshot,
  LinkingSnapshot,
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

const secondHub: HubSnapshot = {
  ...hub,
  id: "hub-2",
  displayName: "第2検証Hub",
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
  serviceIdentifierMappings: [
    {
      id: "mapping-cost-1",
      kind: "usage_cost",
      rawIdentifier: "provider.cost",
      serviceId: "service-1",
      validFrom: "2026-08-01T00:00:00Z",
      validTo: "",
      createdAt: "2026-08-24T00:00:00Z",
    },
    {
      id: "mapping-limit-1",
      kind: "usage_limit",
      rawIdentifier: "provider.limit",
      serviceId: "service-1",
      validFrom: "2026-08-01T00:00:00Z",
      validTo: "",
      createdAt: "2026-08-24T00:00:00Z",
    },
  ],
  limitDefinitions: [
    {
      id: "limit-definition-1",
      serviceId: "service-1",
      cycleType: "weekly",
      meaning: "週次利用枠",
      unit: "%",
      billingConfirmation: "not_applicable",
      archivedAt: "",
      createdAt: "2026-08-24T00:00:00Z",
      updatedAt: "2026-08-24T00:00:00Z",
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

const linking: LinkingSnapshot = {
  usageCostSources: [
    {
      id: "cost-source-1",
      hubId: "hub-1",
      deviceId: "device-1",
      rawServiceIdentifier: "provider.cost",
      createdAt: "2026-08-24T00:00:00Z",
    },
  ],
  usageLimitSources: [
    {
      id: "limit-source-1",
      hubId: "hub-2",
      deviceId: "device-2",
      accountKey: "provider-key",
      rawServiceIdentifier: "provider.limit",
      windowKey: "weekly-percent",
      normalizedKind: "weekly",
      normalizedMetric: "percent",
      normalizedLabel: "Weekly",
      createdAt: "2026-08-24T00:00:00Z",
    },
  ],
  usageCostAssociations: [
    {
      id: "cost-association-1",
      usageCostSourceId: "cost-source-1",
      logicalAccountId: "logical-1",
      validFrom: "2026-08-24T00:00:00Z",
      validTo: "",
      createdAt: "2026-08-24T00:00:00Z",
      updatedAt: "2026-08-24T00:00:00Z",
    },
  ],
  usageLimitAssociations: [],
  usageCostSourceCompleteness: [],
  hubSwitches: [],
};

function renderPage(initialEntry = "/accounts") {
  const backend = createFakeBackend({
    accounts,
    hubs: [hub, secondHub],
    catalog,
    linking,
  });
  const onDirtyChange = vi.fn();
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <main aria-label="メイン画面">
        <AccountsPage
          backend={backend}
          onDirtyChange={onDirtyChange}
          displayTimeZone="Asia/Tokyo"
        />
      </main>
    </MemoryRouter>,
  );
  return { backend, onDirtyChange };
}

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

describe("AccountsPage", () => {
  it("shows the seven M05 tabs and supports account editing", async () => {
    const { backend, onDirtyChange } = renderPage();
    const user = userEvent.setup();

    expect(
      await screen.findByRole("heading", { name: "アカウント・関連付け" }),
    ).toBeVisible();
    expect(screen.getByRole("tab", { name: "論理アカウント" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Hubアカウント" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "プラン履歴" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "利用額関連付け" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "利用枠関連付け" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "活動主体の完全性" })).toBeVisible();
    expect(
      screen.getByRole("tab", { name: "収集端末・Hub切替" }),
    ).toBeVisible();

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
      screen.getByRole("textbox", { name: "開始日時（UTC）" }),
      "2026-08-25T00:00:00Z",
    );
    await user.type(
      screen.getByRole("textbox", {
        name: "終了日時（UTC・空欄可）",
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
    expect((await screen.findAllByText(/有効期間:/)).length).toBeGreaterThan(0);
  });

  it("previews and confirms usage-cost and usage-limit associations", async () => {
    const { backend } = renderPage();
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const costPreview = vi.spyOn(backend, "previewUsageCostAssociation");
    const costCreate = vi.spyOn(backend, "createUsageCostAssociation");
    await screen.findByRole("heading", { name: "既存アカウント" });
    await user.click(screen.getByRole("tab", { name: "利用額関連付け" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "利用額ソース" }),
      "cost-source-1",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "論理アカウント" }),
      "logical-1",
    );
    await user.type(
      screen.getByRole("textbox", { name: "開始日時（UTC）" }),
      "2026-08-25T00:00:00Z",
    );
    await user.click(screen.getByRole("button", { name: "影響を確認" }));
    await waitFor(() => expect(costPreview).toHaveBeenCalled());
    expect(await screen.findByText("対象観測: 0件")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "確定" }));
    await waitFor(() => expect(costCreate).toHaveBeenCalled());
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("影響"));

    const limitPreview = vi.spyOn(backend, "previewUsageLimitAssociation");
    const limitCreate = vi.spyOn(backend, "createUsageLimitAssociation");
    await user.click(screen.getByRole("tab", { name: "利用枠関連付け" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "利用枠ソース" }),
      "limit-source-1",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "論理アカウント" }),
      "logical-1",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "利用枠定義" }),
      "limit-definition-1",
    );
    await user.type(
      screen.getByRole("textbox", { name: "開始日時（UTC）" }),
      "2026-08-25T00:00:00Z",
    );
    await user.click(screen.getByRole("button", { name: "影響を確認" }));
    await waitFor(() => expect(limitPreview).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "確定" }));
    await waitFor(() => expect(limitCreate).toHaveBeenCalled());
  });

  it("limits completeness candidates to linked accounts and requires a preview before saving", async () => {
    const { backend } = renderPage();
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const previewCompleteness = vi.spyOn(
      backend,
      "previewUsageCostSourceCompleteness",
    );
    const confirmCompleteness = vi.spyOn(
      backend,
      "confirmUsageCostSourceCompleteness",
    );
    await screen.findByRole("heading", { name: "既存アカウント" });
    await user.click(screen.getByRole("tab", { name: "活動主体の完全性" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "利用額ソース" }),
      "cost-source-1",
    );
    await user.type(
      screen.getByRole("textbox", { name: "開始日時（UTC）" }),
      "2026-08-25T00:00:00Z",
    );
    expect(
      screen.getByRole("checkbox", { name: "既存アカウント" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "確定" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "既存アカウント" }));
    await user.click(
      screen.getByRole("checkbox", {
        name: "上記の全有効論理アカウントを含み、除外対象がないことを明示確認する",
      }),
    );
    await user.click(screen.getByRole("button", { name: "影響を確認" }));
    await waitFor(() => expect(previewCompleteness).toHaveBeenCalled());
    expect(await screen.findByText("影響計算区間（半開）:")).toBeVisible();
    expect(screen.getByRole("button", { name: "確定" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "確定" }));
    await waitFor(() => expect(confirmCompleteness).toHaveBeenCalled());
  });

  it("requires a preview before confirming a Hub switch", async () => {
    const { backend } = renderPage();
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const previewSwitch = vi.spyOn(backend, "previewHubSwitch");
    const confirmSwitch = vi.spyOn(backend, "confirmHubSwitch");
    await screen.findByRole("heading", { name: "既存アカウント" });
    await user.click(screen.getByRole("tab", { name: "収集端末・Hub切替" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "旧Hub" }),
      "hub-1",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "旧Hub端末レコード" }),
      "device-1",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "新Hub" }),
      "hub-2",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "新Hub端末レコード" }),
      "device-2",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "収集端末" }),
      "device-1",
    );
    await user.type(
      screen.getByRole("textbox", { name: "切替日時（UTC）" }),
      "2026-08-25T00:00:00Z",
    );
    expect(screen.getByRole("button", { name: "確定" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "影響を確認" }));
    await waitFor(() => expect(previewSwitch).toHaveBeenCalled());
    expect(await screen.findByText("影響計算区間（半開）:")).toBeVisible();
    expect(screen.getByRole("button", { name: "確定" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "確定" }));
    await waitFor(() => expect(confirmSwitch).toHaveBeenCalled());
  });

  it("filters and highlights the account selected by an audit link", async () => {
    renderPage("/accounts?accountId=logical-1");

    expect(await screen.findByTestId("target-account")).toHaveTextContent(
      "既存アカウント",
    );
    expect(screen.getByRole("textbox", { name: "検索" })).toHaveValue(
      "既存アカウント",
    );
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
