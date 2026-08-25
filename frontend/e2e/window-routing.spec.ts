import { expect, test } from "@playwright/test";

test("shows the compact window by default", async ({ page }) => {
  await page.goto("/?browserTest=1");
  await expect(page.getByText("Hub が登録されていません")).toBeVisible();
});

test("routes the main window from its query parameter", async ({ page }) => {
  await page.goto("/?window=main&browserTest=1");
  await expect(
    page.getByRole("navigation", { name: "メインメニュー" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "概要" })).toBeVisible();
});

test("opens the data management route", async ({ page }) => {
  await page.goto("/?window=main&route=%2Fdata&browserTest=1");
  await expect(page.getByRole("heading", { name: "データ管理" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "容量" })).toBeVisible();
});
