import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubSnapshot } from "../../lib/backend";
import { createFakeBackend } from "../../lib/backend";
import { HubsPage } from "./HubsPage";

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

const hub = (overrides: Partial<HubSnapshot> = {}): HubSnapshot => ({
  id: "hub-1",
  displayName: "既存 Hub",
  url: "https://hub.example.test",
  enabled: true,
  collectionEnabled: true,
  collectionIntervalSeconds: 300,
  apiContract: "",
  credentialState: "registered",
  credentialReady: true,
  connectionState: "not_checked",
  connectionCheckedAt: "",
  connectionFailureNote: "",
  ...overrides,
});

function renderPage(
  backend: ReturnType<typeof createFakeBackend>,
  initialEntry = "/hubs",
) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <main aria-label="メイン画面">
        <HubsPage backend={backend} onDirtyChange={vi.fn()} />
      </main>
    </MemoryRouter>,
  );
}

async function fillForm(
  user: ReturnType<typeof userEvent.setup>,
  values: { displayName: string; url: string; secret?: string },
) {
  await user.clear(screen.getByRole("textbox", { name: "表示名" }));
  await user.type(
    screen.getByRole("textbox", { name: "表示名" }),
    values.displayName,
  );
  await user.clear(screen.getByRole("textbox", { name: "URL" }));
  await user.type(screen.getByRole("textbox", { name: "URL" }), values.url);
  if (values.secret !== undefined) {
    await user.type(
      screen.getByLabelText("共有秘密（保存済みは再表示しません）"),
      values.secret,
    );
  }
  await user.click(screen.getByRole("button", { name: "保存" }));
}

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

describe("HubsPage", () => {
  it("stores the secret without exposing it in text, attributes, or a reopened form", async () => {
    const secretSentinel = "QL-PRIVACY-SENTINEL-do-not-expose";
    const backend = createFakeBackend();
    const createHub = vi.spyOn(backend, "createHub");
    const user = userEvent.setup();
    renderPage(backend);

    await user.click(await screen.findByRole("button", { name: "Hub を登録" }));
    const secret =
      screen.getByLabelText("共有秘密（保存済みは再表示しません）");
    expect(secret).toHaveAttribute("type", "password");
    await fillForm(user, {
      displayName: "秘密付き Hub",
      url: "https://secret.example.test",
      secret: secretSentinel,
    });

    expect(
      await screen.findByRole("heading", { name: "秘密付き Hub" }),
    ).toBeVisible();
    expect(createHub).toHaveBeenCalledWith(
      expect.objectContaining({ secret: secretSentinel }),
    );
    expect(screen.queryByDisplayValue(secretSentinel)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(secretSentinel);
    for (const element of document.body.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        expect(attribute.value).not.toContain(secretSentinel);
      }
    }

    await user.click(screen.getByRole("button", { name: "編集" }));
    expect(
      await screen.findByLabelText("共有秘密（保存済みは再表示しません）"),
    ).toHaveValue("");
  });

  it("keeps two registrations with the same URL in the list", async () => {
    const backend = createFakeBackend();
    const user = userEvent.setup();
    renderPage(backend);
    const url = "https://same.example.test";

    await user.click(await screen.findByRole("button", { name: "Hub を登録" }));
    await fillForm(user, { displayName: "一つ目", url, secret: "secret-1" });
    await screen.findByRole("heading", { name: "一つ目" });

    await user.click(screen.getByRole("button", { name: "Hub を登録" }));
    await fillForm(user, { displayName: "二つ目", url, secret: "secret-2" });

    expect(
      await screen.findByRole("heading", { name: "二つ目" }),
    ).toBeVisible();
    expect(screen.getAllByText(url, { exact: true })).toHaveLength(2);
    expect(screen.getAllByRole("article")).toHaveLength(2);
  });

  it("sends the existing ID when a hub is edited", async () => {
    const backend = createFakeBackend({ hubs: [hub()] });
    const updateHub = vi.spyOn(backend, "updateHub");
    const user = userEvent.setup();
    renderPage(backend);

    await user.click(await screen.findByRole("button", { name: "編集" }));
    await fillForm(user, {
      displayName: "編集後の Hub",
      url: "https://hub.example.test/updated",
    });

    await waitFor(() =>
      expect(updateHub).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "hub-1",
          displayName: "編集後の Hub",
          url: "https://hub.example.test/updated",
        }),
      ),
    );
    expect(await screen.findByText("識別子: hub-1")).toBeVisible();
    expect(screen.getByRole("heading", { name: "編集後の Hub" })).toBeVisible();
  });

  it("confirms before disabling a hub and shows the disabled state", async () => {
    const backend = createFakeBackend({ hubs: [hub({ id: "hub-disable" })] });
    const stopCollection = vi.spyOn(backend, "stopCollection");
    const setHubEnabled = vi.spyOn(backend, "setHubEnabled");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    renderPage(backend);

    await user.click(await screen.findByRole("button", { name: "無効化" }));

    expect(confirm).toHaveBeenCalledWith(
      "この Hub を無効にしますか？保存済みの履歴は残ります。",
    );
    await waitFor(() =>
      expect(stopCollection).toHaveBeenCalledWith("hub-disable"),
    );
    expect(setHubEnabled).toHaveBeenCalledWith("hub-disable", false);
    expect(await screen.findByLabelText("Hub: 無効")).toBeVisible();
  });

  it("allows manual collection while periodic collection is stopped", async () => {
    const backend = createFakeBackend({
      hubs: [hub({ collectionEnabled: false })],
    });
    const collectNow = vi.spyOn(backend, "collectNow");
    const user = userEvent.setup();
    renderPage(backend);

    await user.click(await screen.findByRole("button", { name: "今すぐ取得" }));

    expect(collectNow).toHaveBeenCalledWith("hub-1");
    expect(
      screen.getByRole("button", { name: "定期収集を開始" }),
    ).toBeEnabled();
  });

  it("shows collection schedule, latest results, API capability, and detailed history", async () => {
    const backend = createFakeBackend({
      hubs: [
        hub({
          apiContract: "schema=1; runtime=node-hub; usageUpdatedAt=false",
        }),
      ],
      collectionAttempts: [
        {
          attemptId: "attempt-success",
          hubId: "hub-1",
          trigger: "manual",
          state: "succeeded",
          startedAt: "2026-08-26T00:04:59Z",
          completedAt: "2026-08-26T00:05:00Z",
          analyticsIntervalSeconds: 300,
          healthHttpStatus: 200,
          statsHttpStatus: 200,
          apiContract: "schema=1; runtime=node-hub; usageUpdatedAt=false",
          healthSnapshotId: "health-1",
          statsSnapshotId: "stats-1",
          failureCode: "",
          failureDetail: "",
          normalizationErrorPath: "",
        },
        {
          attemptId: "attempt-failure",
          hubId: "hub-1",
          trigger: "scheduled",
          state: "failed",
          startedAt: "2026-08-25T23:59:59Z",
          completedAt: "2026-08-26T00:00:00Z",
          analyticsIntervalSeconds: 300,
          healthHttpStatus: 200,
          statsHttpStatus: 503,
          apiContract: "schema=1; runtime=node-hub; usageUpdatedAt=false",
          healthSnapshotId: "health-0",
          statsSnapshotId: "",
          failureCode: "stats_http_error",
          failureDetail: "一時的に利用できません。",
          normalizationErrorPath: "",
        },
      ],
    });
    const user = userEvent.setup();
    renderPage(backend);

    expect(await screen.findByText("収集間隔: 5分")).toBeVisible();
    expect(screen.getByText(/次回予定: .*登録間隔から算出/)).toBeVisible();
    expect(screen.getByText(/最終成功: 8\/26 0:05/)).toBeVisible();
    expect(screen.getByText(/最終失敗: 8\/26 0:00/)).toBeVisible();
    expect(
      screen.getByText("対応 API 契約: スキーマ 1 / 実装 node-hub"),
    ).toBeVisible();
    expect(
      screen.getByText(
        "収集能力: 利用枠・利用額に対応（利用額観測時刻は非対応）",
      ),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "取得履歴" }));
    expect(
      await screen.findByText(/接続確認 HTTP: 200 \/ 統計 HTTP: 503/),
    ).toBeVisible();
    expect(screen.getAllByText(/統計 API の取得失敗/)[0]).toBeVisible();
  });

  it("keeps the Hub list usable when one history request fails", async () => {
    const backend = createFakeBackend({
      hubs: [hub(), hub({ id: "hub-2", displayName: "別 Hub" })],
    });
    vi.spyOn(backend, "getCollectionAttempts").mockImplementation(
      async (hubID) => {
        if (hubID === "hub-2") throw new Error("履歴取得失敗");
        return [];
      },
    );

    renderPage(backend);

    expect(
      await screen.findByRole("heading", { name: "既存 Hub" }),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "別 Hub" })).toBeVisible();
    expect(screen.getByText(/別 Hub の取得履歴を読み込めません/)).toBeVisible();
  });

  it("opens and highlights the Hub selected by an audit link", async () => {
    const backend = createFakeBackend({
      hubs: [hub(), hub({ id: "hub-2", displayName: "対象 Hub" })],
    });

    renderPage(backend, "/hubs?hubId=hub-2");

    expect(await screen.findByTestId("target-hub")).toHaveTextContent(
      "対象 Hub",
    );
    expect(screen.getByLabelText("取得履歴")).toBeVisible();
  });

  it("displays a backend error when saving fails", async () => {
    const backend = createFakeBackend();
    vi.spyOn(backend, "createHub").mockRejectedValue(
      new Error("保存できません"),
    );
    const user = userEvent.setup();
    renderPage(backend);

    await user.click(await screen.findByRole("button", { name: "Hub を登録" }));
    await fillForm(user, {
      displayName: "失敗する Hub",
      url: "https://error.example.test",
      secret: "secret",
    });

    expect(await screen.findByText("保存できません")).toBeVisible();
  });

  it("has no automatically detectable accessibility violations", async () => {
    const backend = createFakeBackend({ hubs: [hub()] });
    renderPage(backend);
    await screen.findByRole("heading", { name: "既存 Hub" });

    const result = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations).toEqual([]);
  });
});
