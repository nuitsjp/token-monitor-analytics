import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { expect, it } from "vitest";
import { createFakeBackend } from "../../lib/backend";
import { EvidencePage } from "./EvidencePage";

const backend = () =>
  createFakeBackend({
    hubs: [
      {
        id: "hub-1",
        displayName: "評価 Hub",
        url: "https://hub.example.test",
        enabled: true,
        collectionEnabled: false,
        collectionIntervalSeconds: 300,
        apiContract: "schema=1",
        credentialState: "registered",
        credentialReady: true,
        connectionState: "connected",
        connectionCheckedAt: "2026-08-25T12:00:00Z",
        connectionFailureNote: "",
      },
    ],
    collectionAttempts: [
      {
        attemptId: "attempt-1",
        hubId: "hub-1",
        trigger: "manual",
        state: "succeeded",
        startedAt: "2026-08-25T12:00:00Z",
        completedAt: "2026-08-25T12:00:01Z",
        analyticsIntervalSeconds: 300,
        healthHttpStatus: 200,
        statsHttpStatus: 200,
        apiContract: "schema=1",
        healthSnapshotId: "health-1",
        statsSnapshotId: "stats-1",
        failureCode: "",
        failureDetail: "",
        normalizationErrorPath: "",
      },
    ],
    rawSnapshots: [
      {
        snapshotId: "stats-1",
        attemptId: "attempt-1",
        hubId: "hub-1",
        responseKind: "stats",
        receivedStartedAt: "2026-08-25T12:00:00Z",
        receivedCompletedAt: "2026-08-25T12:00:01Z",
        httpStatus: 200,
        apiContract: "schema=1",
        body: '{"devices":[{"deviceId":"device-1","accessToken":"[MASKED]"}]}',
      },
    ],
    limitObservations: [
      {
        observationId: "limit-1",
        snapshotId: "stats-1",
        hubId: "hub-1",
        deviceId: "device-1",
        rawServiceIdentifier: "codex",
        accountKey: "account",
        providerUpdatedAt: "2026-08-25T12:00:00Z",
        windowKey: "weekly-percent",
        normalizedKind: "weekly",
        normalizedMetric: "percent",
        normalizedLabel: "Weekly",
        planLabel: "Plus",
        usedPercent: 25,
        remainingPercent: 75,
        resetsAt: "",
        syncUploadIntervalMs: 300000,
        limitsRefreshMs: 300000,
        analyticsIntervalSeconds: 300,
        sourceTimezone: "Asia/Tokyo",
        sourceLocalDate: "2026-08-25",
        normalizationGeneration: 1,
        normalizationRuleVersion: "api-stats-v1",
        normalizationLogicVersion: "t012-normalize-v1",
        jsonPath: "$.devices[0].limits.providers[0].windows[0]",
        dedupeState: "canonical",
        dedupeKey: "key",
        valueFingerprint: "fingerprint",
        windowKeyConflict: false,
      },
    ],
  });

it("shows acquisition, masked raw evidence, and source observations", async () => {
  const user = userEvent.setup();
  render(<EvidencePage backend={backend()} displayTimeZone="Asia/Tokyo" />);

  expect(await screen.findByText("manual / succeeded")).toBeVisible();
  await user.click(screen.getByRole("tab", { name: "原 JSON" }));
  expect(screen.getByText(/未知フィールドと秘密値/)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "マスク済み詳細" }));
  expect(await screen.findByText(/\[MASKED\]/)).toBeInTheDocument();
  expect(screen.getByLabelText("JSON ツリー")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: /原 JSON 全体.*コピー/ }),
  ).not.toBeInTheDocument();

  await user.type(screen.getByLabelText("原 JSON 内を検索"), "accessToken");
  const pathButtons = screen.getAllByRole("button", {
    name: "JSON パスをコピー",
  });
  await user.click(pathButtons[pathButtons.length - 1]);
  expect(
    await screen.findByText(/\$\.devices\[0\]\.accessToken/),
  ).toBeVisible();

  await user.click(screen.getByRole("button", { name: "折り返しテキスト" }));
  expect(screen.getByLabelText("折り返し原 JSON")).toBeVisible();
  expect(screen.getByText("accessToken")).toBeVisible();

  await user.click(screen.getByRole("tab", { name: "元観測" }));
  expect(await screen.findByText(/利用 25% \/ 残り 75%/)).toBeVisible();
});

it("has no automatically detectable accessibility violations", async () => {
  render(<EvidencePage backend={backend()} displayTimeZone="UTC" />);
  await screen.findByText("manual / succeeded");
  const result = await axe.run(document.body, {
    rules: { "color-contrast": { enabled: false } },
  });
  expect(result.violations).toEqual([]);
});
