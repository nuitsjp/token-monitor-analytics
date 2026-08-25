import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import App from "./App";
import { createFakeBackend, emitFakeBackendEvent } from "./lib/backend";
import { identifyWindow } from "./lib/window";

describe("compact window", () => {
  it("shows the first-run state without exposing an internal screen ID", async () => {
    render(<App backend={createFakeBackend({ canOpenMain: true })} />);
    expect(await screen.findByText("Hub が登録されていません")).toBeVisible();
    expect(screen.queryByText(/T01|M00|Phase/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "メイン画面を開く" }),
    ).toBeEnabled();
  });

  it("has no automatically detectable accessibility violation", async () => {
    render(<App backend={createFakeBackend({ canOpenMain: true })} />);
    const result = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations).toEqual([]);
  });

  it("identifies the compact and main roots from the initial URL", () => {
    expect(identifyWindow("http://localhost/?window=t01")).toBe("compact");
    expect(identifyWindow("http://localhost/?window=m00")).toBe("main");
    expect(identifyWindow("http://localhost/main")).toBe("main");
  });

  it("confirms before the compact window exits the whole app", async () => {
    let confirmations = 0;
    const backend = createFakeBackend({
      canOpenMain: true,
      onConfirmQuit: () => {
        confirmations += 1;
      },
    });
    const user = userEvent.setup();
    render(<App backend={backend} windowKind="compact" />);

    emitFakeBackendEvent(backend, "app:quit-requested");
    expect(
      await screen.findByRole("heading", { name: "アプリを終了しますか？" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "終了" }));
    expect(confirmations).toBe(1);
  });

  it("uses a MemoryRouter and opens M01 as the default main route", async () => {
    const backend = createFakeBackend({ canOpenMain: true });
    render(<App backend={backend} location="http://localhost/?window=main" />);

    expect(await screen.findByRole("heading", { name: "概要" })).toBeVisible();
    expect(
      screen.getByRole("navigation", { name: "メインメニュー" }),
    ).toBeVisible();
    expect(screen.getAllByRole("link", { name: /表示設定/ })).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: /概要/ })).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: /監査記録/ })).toHaveLength(1);
    expect(screen.queryByText(/M0[01]|T01/)).not.toBeInTheDocument();
  });

  it("opens a fixed main route requested by T01", async () => {
    const backend = createFakeBackend({ canOpenMain: true });
    render(<App backend={backend} windowKind="main" />);
    expect(await screen.findByRole("heading", { name: "概要" })).toBeVisible();

    emitFakeBackendEvent(backend, "navigation:open", "/settings");
    expect(
      await screen.findByRole("heading", { name: "表示設定" }),
    ).toBeVisible();
  });

  it("QL-UI-05 saves all theme choices, follows the OS in system mode, and applies Go events", async () => {
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    const media = {
      matches: false,
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addEventListener: (
        _: string,
        listener: (event: MediaQueryListEvent) => void,
      ) => listeners.add(listener),
      removeEventListener: (
        _: string,
        listener: (event: MediaQueryListEvent) => void,
      ) => listeners.delete(listener),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
    const matchMedia = vi
      .spyOn(window, "matchMedia")
      .mockImplementation(() => media as MediaQueryList);
    const backend = createFakeBackend({
      canOpenMain: true,
      settings: { theme: "light" },
    });
    const user = userEvent.setup();
    render(<App backend={backend} windowKind="main" />);

    await user.click(await screen.findByRole("link", { name: "表示設定" }));
    await user.click(await screen.findByRole("radio", { name: "ダーク" }));
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(async () =>
      expect((await backend.getSettings()).theme).toBe("dark"),
    );
    expect(document.documentElement.dataset.theme).toBe("dark");

    await user.click(screen.getByRole("radio", { name: "ライト" }));
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(async () =>
      expect((await backend.getSettings()).theme).toBe("light"),
    );
    expect(document.documentElement.dataset.theme).toBe("light");

    await user.click(
      screen.getByRole("radio", { name: "システム設定に合わせる" }),
    );
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(async () =>
      expect((await backend.getSettings()).theme).toBe("system"),
    );
    expect(document.documentElement.dataset.theme).toBe("light");

    media.matches = true;
    act(() =>
      listeners.forEach((listener) =>
        listener({ matches: true } as MediaQueryListEvent),
      ),
    );
    await waitFor(() =>
      expect(document.documentElement.dataset.theme).toBe("dark"),
    );

    act(() =>
      emitFakeBackendEvent(backend, "settings:theme-changed", {
        theme: "light",
        displayTimeZone: "UTC",
        timezoneConfirmed: true,
        systemDark: true,
      }),
    );
    await waitFor(() =>
      expect(document.documentElement.dataset.theme).toBe("light"),
    );
    matchMedia.mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  it("shows the shared dirty-state guard for a main close request", async () => {
    let confirmations = 0;
    const backend = createFakeBackend({
      canOpenMain: true,
      onConfirmCloseMain: () => {
        confirmations += 1;
      },
    });
    const user = userEvent.setup();
    render(<App backend={backend} windowKind="main" />);

    await user.click(await screen.findByRole("link", { name: "表示設定" }));
    await user.click(await screen.findByRole("radio", { name: "ダーク" }));
    emitFakeBackendEvent(backend, "window:main-close-requested");
    expect(
      await screen.findByRole("heading", { name: "メイン画面を閉じますか？" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(confirmations).toBe(0);

    emitFakeBackendEvent(backend, "window:main-close-requested");
    await user.click(
      await screen.findByRole("button", { name: "破棄して続行" }),
    );
    expect(confirmations).toBe(1);
  });

  it("keeps the main shell reflowable and forced-color friendly", async () => {
    render(<App backend={createFakeBackend()} windowKind="main" />);
    const shell = await screen.findByRole("main", { name: "メイン画面" });
    expect(shell.parentElement).toHaveAttribute("data-window", "main");
    expect(document.documentElement.dataset.theme).toMatch(/light|dark/);
    const result = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations).toEqual([]);
  });
});
