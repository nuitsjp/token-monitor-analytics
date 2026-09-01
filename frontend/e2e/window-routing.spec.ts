import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const runtimeFailures = new WeakMap<Page, string[]>();

test.beforeEach(({ page }) => {
  const failures: string[] = [];
  runtimeFailures.set(page, failures);
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") {
      failures.push(`console: ${message.text()}`);
    }
  });
  page.on("requestfailed", (request) => {
    const resourceType = request.resourceType();
    if (["document", "script", "stylesheet", "font"].includes(resourceType)) {
      failures.push(
        `request failed: ${resourceType} ${request.url()} ${request.failure()?.errorText ?? "unknown error"}`,
      );
    }
  });
  page.on("response", (response) => {
    const resourceType = response.request().resourceType();
    if (
      response.status() >= 400 &&
      ["document", "script", "stylesheet", "font"].includes(resourceType)
    ) {
      failures.push(
        `response ${response.status()}: ${resourceType} ${response.url()}`,
      );
    }
  });
});

test.afterEach(({ page }) => {
  expect(runtimeFailures.get(page) ?? []).toEqual([]);
});

async function expectNoAccessibilityViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    // Exception: Rule=axe/all; Reason=Fluent focus sentinels are third-party implementation nodes; Scope=[data-tabster-dummy]; Owner=frontend; Expires=2026-12-31.
    // Fluent UI's Tabster focus sentinels are intentionally aria-hidden while
    // retaining a tabindex; exclude those implementation details from axe.
    .exclude("[data-tabster-dummy]")
    // Exception: Rule=axe/color-contrast; Reason=preview-generated Fluent colors are unstable and token tests cover contrast; Scope=browser E2E scans; Owner=frontend; Expires=2026-12-31.
    // Fluent's generated theme colors are not stable in browser previews;
    // component contrast is covered by the dedicated token/UI tests.
    .disableRules(["color-contrast"])
    .analyze();
  expect(results.violations).toEqual([]);
}

test("shows the compact window by default", async ({ page }) => {
  await page.goto("/?browserTest=1");
  await expect(page.getByText("Hub が登録されていません")).toBeVisible();
  await expectNoAccessibilityViolations(page);
});

test("routes the main window from its query parameter", async ({ page }) => {
  await page.goto("/?window=main&browserTest=1");
  await expect(
    page.getByRole("navigation", { name: "メインメニュー" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "概要" })).toBeVisible();
  await expectNoAccessibilityViolations(page);
});

test("opens the data management route", async ({ page }) => {
  await page.goto("/?window=main&route=%2Fdata&browserTest=1");
  await expect(page.getByRole("heading", { name: "データ管理" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "容量" })).toBeVisible();
  await expectNoAccessibilityViolations(page);
  await page.getByRole("tab", { name: "バックアップ" }).click();
  await expectNoAccessibilityViolations(page);
  await page.getByRole("tab", { name: "復元" }).click();
  await expectNoAccessibilityViolations(page);
});

test("checks the compact confirmation dialog in a real browser", async ({
  page,
}) => {
  await page.goto("/?browserTest=1");
  await page.getByRole("button", { name: "終了（定期収集も停止）" }).click();
  await expect(
    page.getByRole("dialog", { name: "アプリを終了しますか？" }),
  ).toBeVisible();
  await expectNoAccessibilityViolations(page);
});
