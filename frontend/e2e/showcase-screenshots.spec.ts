import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const output = (name: string) =>
  path.resolve(process.cwd(), "../artifacts/screenshots", name);

async function captureMain(
  page: Page,
  route: string,
  heading: string,
  file: string,
  value: string,
) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(
    `/?window=main&route=${encodeURIComponent(route)}&showcase=1`,
  );
  await expect(page.getByText(heading, { exact: true }).first()).toBeVisible();
  await expect(
    page.getByText(value, { exact: true }).filter({ visible: true }).first(),
  ).toBeVisible();
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur(),
  );
  await page.screenshot({ path: output(file) });
}

test("captures populated showcase screens at their intended window sizes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 540 });
  await page.goto("/?showcase=1");
  await expect(page.getByText("74.5%").first()).toBeVisible();
  await page.screenshot({ path: output("T01-compact.png") });

  await captureMain(
    page,
    "/overview",
    "概要",
    "M00-M01-overview.png",
    "取得成功",
  );
  await captureMain(
    page,
    "/limits",
    "利用上限・価値",
    "M03-limits.png",
    "74.5%",
  );
  await captureMain(
    page,
    "/review",
    "要確認",
    "M04-review.png",
    "Codex / Plus",
  );
  await captureMain(
    page,
    "/accounts",
    "アカウント・関連付け",
    "M05-accounts.png",
    "個人アカウント",
  );
  await captureMain(
    page,
    "/catalog",
    "サービス・プラン",
    "M06-catalog.png",
    "OpenAI / Codex",
  );
  await captureMain(
    page,
    "/hubs",
    "Hub・収集",
    "M07-hubs.png",
    "評価 Hub（192.168.0.16）",
  );
  await captureMain(
    page,
    "/evidence",
    "観測と根拠",
    "M08-evidence.png",
    "manual / succeeded",
  );
  await captureMain(
    page,
    "/data",
    "データ管理",
    "M09-data-management.png",
    "24",
  );
  await captureMain(
    page,
    "/audit",
    "監査記録",
    "M10-audit.png",
    "hub_connection_succeeded",
  );
  await captureMain(
    page,
    "/settings",
    "表示設定",
    "M11-settings.png",
    "Asia/Tokyo",
  );
});
