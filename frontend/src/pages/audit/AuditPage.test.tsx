import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditRecord } from "../../lib/backend";
import { createFakeBackend } from "../../lib/backend";
import { AuditPage } from "./AuditPage";

const audit = (overrides: Partial<AuditRecord> = {}): AuditRecord => ({
  sequence: 2,
  auditId: "audit-2",
  occurredAt: "2026-08-02T00:00:00Z",
  actor: "user",
  action: "credential_saved",
  entityType: "hub_credential",
  entityId: "hub-1",
  beforeJson: '{"credentialState":"unregistered"}',
  afterJson: '{"credentialState":"registered"}',
  ...overrides,
});

function renderPage(backend: ReturnType<typeof createFakeBackend>) {
  return render(
    <MemoryRouter>
      <main aria-label="メイン画面">
        <AuditPage backend={backend} />
      </main>
    </MemoryRouter>,
  );
}

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

describe("AuditPage", () => {
  it("shows loading, then the read-only sanitized before/after table", async () => {
    const backend = createFakeBackend({
      audits: [
        audit({
          beforeJson: '{"displayName":"Hub","secret":"[非表示]"}',
        }),
      ],
    });
    renderPage(backend);

    expect(screen.getByText("監査記録を読み込み中")).toBeVisible();
    expect(
      await screen.findByRole("columnheader", { name: "変更前" }),
    ).toBeVisible();
    expect(screen.getByText("資格情報を保存")).toBeVisible();
    expect(screen.queryByText("credential_saved")).not.toBeInTheDocument();
    expect(screen.queryByText("hub-1")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Hubの詳細" })).toHaveAttribute(
      "href",
      "/hubs?hubId=hub-1",
    );
    expect(screen.getByRole("cell", { name: /\[非表示\]/ })).toBeVisible();
    expect(screen.queryByText("sentinel-secret")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /削除/ }),
    ).not.toBeInTheDocument();
  });

  it("passes date, target, and action filters to the backend", async () => {
    const backend = createFakeBackend({ audits: [audit()] });
    const getAudits = vi.spyOn(backend, "getAudits");
    const user = userEvent.setup();
    renderPage(backend);
    await screen.findByRole("columnheader", { name: "変更前" });

    await user.type(
      screen.getByLabelText("開始日時（UTC）"),
      "2026-08-01T09:00",
    );
    await user.type(
      screen.getByLabelText("終了日時（UTC・含まない）"),
      "2026-08-03T09:00",
    );
    await user.type(screen.getByLabelText("対象種別"), "hub_credential");
    await user.type(screen.getByLabelText("操作種別"), "credential_saved");
    await user.click(screen.getByRole("button", { name: "絞り込む" }));

    await waitFor(() =>
      expect(getAudits).toHaveBeenLastCalledWith(
        expect.objectContaining({
          entityType: "hub_credential",
          action: "credential_saved",
          from: "2026-08-01T09:00:00.000Z",
          to: "2026-08-03T09:00:00.000Z",
        }),
      ),
    );
  });

  it("distinguishes a normal empty audit state", async () => {
    renderPage(createFakeBackend());
    expect(await screen.findByText("監査記録はまだありません。")).toBeVisible();
  });

  it("shows a retryable backend error", async () => {
    const backend = createFakeBackend();
    vi.spyOn(backend, "getAudits").mockRejectedValue(new Error("読み込み失敗"));
    renderPage(backend);
    expect(await screen.findByText("読み込み失敗")).toBeVisible();
    expect(screen.getByRole("button", { name: "再試行" })).toBeVisible();
  });

  it("has no automatically detectable accessibility violations", async () => {
    renderPage(createFakeBackend({ audits: [audit()] }));
    await screen.findByRole("columnheader", { name: "変更前" });
    const result = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations).toEqual([]);
  });
});
