import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import { CatalogPage } from "./CatalogPage";
import { createFakeBackend } from "../../lib/backend";

const catalog = {
  services: [
    {
      id: "service-1",
      provider: "利用者登録",
      name: "分析サービス",
      officialKey: "official.service",
      archivedAt: "",
      createdAt: "2026-08-25T00:00:00Z",
      updatedAt: "2026-08-25T00:00:00Z",
    },
  ],
  serviceIdentifierMappings: [
    {
      id: "mapping-1",
      kind: "usage_limit",
      rawIdentifier: "raw-limit-exact",
      serviceId: "service-1",
      validFrom: "2026-08-01T00:00:00Z",
      validTo: "",
      createdAt: "2026-08-25T00:00:00Z",
    },
  ],
  limitDefinitions: [
    {
      id: "limit-1",
      serviceId: "service-1",
      cycleType: "billing",
      meaning: "利用枠",
      unit: "tokens",
      billingConfirmation: "unconfirmed",
      archivedAt: "",
      createdAt: "2026-08-25T00:00:00Z",
      updatedAt: "2026-08-25T00:00:00Z",
    },
  ],
  plans: [
    {
      id: "plan-1",
      serviceId: "service-1",
      name: "登録プラン",
      isBaseline: true,
      archivedAt: "",
      createdAt: "2026-08-25T00:00:00Z",
      updatedAt: "2026-08-25T00:00:00Z",
    },
  ],
  planVersions: [],
  planLimitRules: [],
  standardPrices: [],
  identificationCandidates: [
    {
      id: "candidate-1",
      rawLimitServiceIdentifier: "raw-limit-exact",
      rawReportedPlanName: "報告名そのまま",
      state: "unconfirmed",
      serviceId: "",
      planId: "",
      firstObservedAt: "2026-08-20T00:00:00Z",
      lastObservedAt: "2026-08-25T00:00:00Z",
      createdAt: "2026-08-25T00:00:00Z",
      updatedAt: "2026-08-25T00:00:00Z",
      observations: [
        {
          id: "observation-1",
          candidateId: "candidate-1",
          hubId: "hub-1",
          hubAccountDisplay: "表示用アカウント",
          observedAt: "2026-08-25T00:00:00Z",
        },
      ],
    },
  ],
  labelChangeCandidates: [],
};

describe("CatalogPage", () => {
  it("keeps raw candidate evidence separate and has no axe violations", async () => {
    const backend = createFakeBackend({ catalog });
    const user = userEvent.setup();
    render(<CatalogPage backend={backend} onDirtyChange={vi.fn()} />);
    await user.click(await screen.findByRole("tab", { name: "同定候補" }));
    expect(
      await screen.findByRole("heading", { name: "raw-limit-exact" }),
    ).toBeVisible();
    expect(screen.getAllByText(/報告名そのまま/).length).toBeGreaterThan(0);
    expect(screen.getByLabelText("未確認。同定候補の状態です。")).toBeVisible();
    expect(screen.queryByText("ID: service-1")).not.toBeInTheDocument();
    expect(screen.queryByText("2026-08-20T00:00:00Z")).not.toBeInTheDocument();
    expect(screen.queryByText(/Hub: hub-1/)).not.toBeInTheDocument();
    const result = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations).toEqual([]);
  });

  it("supports keyboard tab movement and candidate confirmation", async () => {
    const backend = createFakeBackend({ catalog });
    const dirty = vi.fn();
    const user = userEvent.setup();
    render(<CatalogPage backend={backend} onDirtyChange={dirty} />);
    await user.click(await screen.findByRole("tab", { name: "同定候補" }));
    await user.click(screen.getByRole("button", { name: /raw-limit-exact/ }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "正式なサービス" }),
      "service-1",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "正式なプラン" }),
      "plan-1",
    );
    await user.click(screen.getByRole("button", { name: "確認" }));
    await waitFor(async () =>
      expect(
        (await backend.getCatalog()).identificationCandidates?.[0]?.state,
      ).toBe("confirmed"),
    );
    expect(dirty).toHaveBeenCalledWith(true);
  });

  it("keeps a draft in another tab dirty after a candidate save", async () => {
    const backend = createFakeBackend({ catalog });
    const dirty = vi.fn();
    const user = userEvent.setup();
    render(<CatalogPage backend={backend} onDirtyChange={dirty} />);
    await user.type(
      await screen.findByRole("textbox", { name: "提供者" }),
      " draft",
    );
    await user.click(await screen.findByRole("tab", { name: "同定候補" }));
    await user.click(screen.getByRole("button", { name: /raw-limit-exact/ }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "正式なサービス" }),
      "service-1",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "正式なプラン" }),
      "plan-1",
    );
    await user.click(screen.getByRole("button", { name: "確認" }));
    await waitFor(async () =>
      expect(
        (await backend.getCatalog()).identificationCandidates?.[0]?.state,
      ).toBe("confirmed"),
    );
    expect(dirty).toHaveBeenLastCalledWith(true);
  });
});
