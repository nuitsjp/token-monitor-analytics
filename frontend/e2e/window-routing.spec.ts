import { expect, test } from "@playwright/test";

test("shows the compact window by default", async ({ page }) => {
  await page.goto("/?browserTest=1");
  await expect(
    page.getByRole("heading", { name: "Hub を登録してください" }),
  ).toBeVisible();
});

test("routes the main window from its query parameter", async ({ page }) => {
  await page.goto("/?window=main&browserTest=1");
  await expect(
    page.getByRole("navigation", { name: "メインメニュー" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "表示設定" })).toBeVisible();
});
