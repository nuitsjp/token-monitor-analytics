import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CompactWindow } from "./CompactWindow";
import { createFakeBackend, emitFakeBackendEvent } from "../../lib/backend";
import type { HubSnapshot } from "../../lib/backend";

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

describe("CompactWindow", () => {
  it("toggles the native T01 width and exposes its expanded state", async () => {
    const user = userEvent.setup();
    const expandedStates: boolean[] = [];
    const backend = createFakeBackend({
      canOpenMain: true,
      onSetCompactExpanded: (expanded) => expandedStates.push(expanded),
    });
    render(<CompactWindow backend={backend} />);

    const root = screen.getByRole("main");
    expect(root).toHaveAttribute("data-compact-expanded", "false");
    await user.click(screen.getByRole("button", { name: "利用枠を展開" }));

    expect(root).toHaveAttribute("data-compact-expanded", "true");
    expect(
      screen.getByRole("button", { name: "利用枠を折りたたむ" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(expandedStates).toEqual([true]);
    expect(root.querySelector('[data-region="limit-list"]')).not.toBeNull();
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
    render(<CompactWindow backend={backend} />);

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
    render(<CompactWindow backend={backend} />);

    emitFakeBackendEvent(backend, "app:quit-requested");
    await user.click(await screen.findByRole("button", { name: "終了" }));

    expect(
      await screen.findByText(
        "収集処理を停止できなかったため、終了していません。",
      ),
    ).toBeVisible();
  });
});
