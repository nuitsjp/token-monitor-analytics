import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { createFakeBackend, type UsageFilterInput } from "../../lib/backend";
import { UsagePage } from "./UsagePage";

const input: UsageFilterInput = {
  from: "2026-08-01T00:00:00Z",
  to: "2026-09-01T00:00:00Z",
  displayTimeZone: "Asia/Tokyo",
  granularity: "day",
  groupBy: "hub",
  hubId: "",
  collectionDeviceId: "",
  deviceId: "",
  serviceId: "",
  rawServiceIdentifier: "",
  logicalAccountId: "",
  planVersionId: "",
  limitDefinitionId: "",
  model: "",
};

it("P2-VIS-04 confirms scope and cancels background export without an artifact", async () => {
  const backend = createFakeBackend();
  let cancelled = false;
  backend.beginUsageExport = () => ({
    promise: new Promise(() => undefined),
    cancel: () => {
      cancelled = true;
    },
  });
  render(
    <MemoryRouter>
      <UsagePage backend={backend} displayTimeZone="Asia/Tokyo" />
    </MemoryRouter>,
  );

  await screen.findByText("トークン総使用量");
  await userEvent.click(screen.getByRole("button", { name: "CSV" }));
  expect(
    screen.getByRole("dialog", { name: "利用実績の出力確認" }),
  ).toHaveTextContent("機微データ");
  expect(screen.getByRole("dialog")).toHaveTextContent("スキーマ版: 2");
  await userEvent.click(screen.getByRole("button", { name: "出力を開始" }));
  expect(
    screen.getByText("利用実績をバックグラウンドで出力しています"),
  ).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "出力を取り消す" }));
  expect(cancelled).toBe(true);
  expect(screen.getByText(/未完成の成果物はありません/)).toBeInTheDocument();
});

it("P2-VIS-05 emits BOM CSV and versioned JSON from the same filtered rows", async () => {
  const backend = createFakeBackend();
  const csv = await backend.exportUsage(input, "csv");
  const json = await backend.exportUsage(input, "json");

  expect(csv.content.startsWith("\ufeff")).toBe(true);
  expect(csv.content).toContain("schemaVersion,displayTimeZone");
  expect(JSON.parse(json.content)).toMatchObject({
    schemaVersion: "2",
    metadata: {
      displayTimeZone: "Asia/Tokyo",
      observationType: "observed",
    },
    rows: [],
  });
});
