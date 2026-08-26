import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AppProviders } from "../../app/providers";
import { createFakeBackend } from "../../lib/backend";
import { SettingsPage } from "./SettingsPage";

function renderPage(backend: ReturnType<typeof createFakeBackend>) {
  return render(
    <AppProviders backend={backend}>
      <SettingsPage onDirtyChange={() => undefined} />
    </AppProviders>,
  );
}

describe("SettingsPage", () => {
  it("requires explicit confirmation and previews half-open calendar periods", async () => {
    const user = userEvent.setup();
    const backend = createFakeBackend({
      settings: { displayTimeZone: "Asia/Tokyo", timezoneConfirmed: false },
    });
    renderPage(backend);

    expect(await screen.findByText(/未確認です/)).toBeVisible();
    expect(screen.getByRole("button", { name: "確認して保存" })).toBeEnabled();
    expect(screen.getByText(/期間プレビュー（Asia\/Tokyo）/)).toBeVisible();
    expect(screen.getByText(/週（月曜始まり）/)).toBeVisible();
    expect(screen.getByText(/半開区間/)).toBeVisible();
    expect(screen.getByText(/23時間または25時間/)).toBeVisible();
    expect(screen.getByText(/タイムゾーンが不明/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "確認して保存" }));
    expect(await screen.findByRole("button", { name: "保存" })).toBeDisabled();
    expect((await backend.getSettings()).timezoneConfirmed).toBe(true);
  });

  it("shows a save failure without losing the pending confirmation", async () => {
    const user = userEvent.setup();
    const backend = createFakeBackend({
      settings: { timezoneConfirmed: false },
    });
    vi.spyOn(backend, "saveSettings").mockRejectedValueOnce(
      new Error("保存失敗"),
    );
    renderPage(backend);

    await user.click(
      await screen.findByRole("button", { name: "確認して保存" }),
    );
    expect(await screen.findByText("保存失敗")).toBeVisible();
    expect(screen.getByRole("button", { name: "確認して保存" })).toBeEnabled();
  });

  it("keeps an unmapped Windows timezone selectable without crashing the preview", async () => {
    const backend = createFakeBackend({
      settings: { displayTimeZone: "", timezoneConfirmed: false },
    });
    renderPage(backend);

    expect(await screen.findByText(/変換できませんでした/)).toBeVisible();
    expect(
      screen.getByText("タイムゾーンを選択すると期間を確認できます。"),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "確認して保存" })).toBeDisabled();
  });
});
