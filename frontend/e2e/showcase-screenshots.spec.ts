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
  await captureCurrent(page, file);
}

async function captureCurrent(page: Page, file: string) {
  await page.evaluate(async () => {
    if (!document.getElementById("showcase-screenshot-stability")) {
      const style = document.createElement("style");
      style.id = "showcase-screenshot-stability";
      style.textContent = `
        *, *::before, *::after {
          animation: none !important;
          caret-color: transparent !important;
          transition: none !important;
        }
      `;
      document.head.append(style);
    }
    await document.fonts.ready;
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
    for (const element of document.querySelectorAll<HTMLElement>("*")) {
      if (element.scrollTop > 0) element.scrollTop = 0;
      if (element.scrollLeft > 0) element.scrollLeft = 0;
    }
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.screenshot({ path: output(file) });
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(100 * (attempt + 1));
    }
  }
  throw lastError;
}

async function captureTab(page: Page, name: string, file: string) {
  const tab = page.getByRole("tab", { name, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await captureCurrent(page, file);
}

test("captures populated showcase screens at their intended window sizes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 600 });
  await page.goto("/?showcase=1");
  await expect(page.getByText("74.5%").first()).toBeVisible();
  await expect(page.getByLabel("サンプルデータ（モック Hub）")).toBeVisible();
  await captureCurrent(page, "T01-compact.png");

  await page.getByRole("button", { name: "利用枠を展開" }).click();
  await expect(page.getByRole("button", { name: "要確認 1 件" })).toBeVisible();
  await page.setViewportSize({ width: 360, height: 600 });
  await captureCurrent(page, "T01-compact-expanded.png");
  await page.getByRole("button", { name: "プライバシーモード" }).click();
  await expect(page.getByText("••••").first()).toBeVisible();
  await captureCurrent(page, "T01-compact-privacy.png");

  await captureMain(
    page,
    "/overview",
    "概要",
    "M00-M01-overview.png",
    "取得成功",
  );
  await captureMain(
    page,
    "/usage",
    "利用状況分析",
    "M02-usage.png",
    "18,742,680",
  );
  const usageAnalysis = page.getByRole("article", {
    name: "利用量と利用金額の時系列分析",
  });
  await expect(usageAnalysis).toBeVisible();
  await usageAnalysis.screenshot({ path: output("M02-usage-analysis.png") });
  const usageChart = page.getByRole("group", {
    name: "利用量とAPI換算利用金額の分類別積み上げ棒グラフ",
  });
  await usageChart.getByRole("button").last().click();
  await expect(page.getByText("選択中の期間")).toBeVisible();
  await usageAnalysis.screenshot({
    path: output("M02-usage-analysis-period.png"),
  });
  await page.getByRole("button", { name: "期間合計へ戻す" }).click();
  await page
    .getByRole("button", { name: "詳細フィルター", exact: true })
    .click();
  await expect(page.getByLabel("プラン版")).toBeVisible();
  await captureCurrent(page, "M02-usage-filters.png");
  await page
    .getByRole("button", { name: "詳細フィルター", exact: true })
    .click();
  await page.getByRole("button", { name: "CSV", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "利用実績の出力確認" }),
  ).toBeVisible();
  await captureCurrent(page, "M02-usage-export.png");
  await captureMain(
    page,
    "/limits",
    "利用上限・価値",
    "M03-limits.png",
    "74.5%",
  );
  await page.getByRole("link", { name: "詳細", exact: true }).first().click();
  await expect(page.getByRole("tab", { name: "現在" })).toBeVisible();
  await captureCurrent(page, "M03-limit-detail-current.png");
  await captureTab(page, "利用枠系列", "M03-limit-detail-series.png");
  await captureTab(page, "品質", "M03-limit-detail-quality.png");
  await captureTab(page, "履歴", "M03-limit-detail-history.png");
  await captureTab(page, "根拠", "M03-limit-detail-evidence.png");
  await captureMain(
    page,
    "/review",
    "要確認",
    "M04-review.png",
    "Claude / Pro",
  );
  await captureTab(page, "データ警告", "M04-review-warnings.png");
  await captureMain(
    page,
    "/accounts",
    "アカウント・関連付け",
    "M05-accounts.png",
    "個人アカウント",
  );
  await captureTab(page, "Hubアカウント", "M05-accounts-hub.png");
  await expect(page.getByLabel("候補状態")).toBeVisible();
  await expect(page.getByText("論理アカウントを登録")).toBeHidden();
  await captureTab(page, "プラン履歴", "M05-accounts-plan-history.png");
  await expect(
    page.getByRole("heading", { name: "プラン履歴を追加" }),
  ).toBeVisible();
  await captureTab(page, "利用額関連付け", "M05-accounts-cost-link.png");
  await expect(
    page.getByRole("heading", { name: "利用額関連付けを登録" }),
  ).toBeVisible();
  await captureTab(page, "利用枠関連付け", "M05-accounts-limit-link.png");
  await expect(
    page.getByRole("heading", { name: "利用枠関連付けを登録" }),
  ).toBeVisible();
  await captureTab(page, "活動主体の完全性", "M05-accounts-completeness.png");
  await expect(
    page.getByRole("heading", { name: "活動主体の完全性を登録" }),
  ).toBeVisible();
  await captureTab(page, "収集端末・Hub切替", "M05-accounts-hub-switch.png");
  await expect(
    page.getByRole("heading", { name: "収集端末・Hub切替を記録" }),
  ).toBeVisible();
  await captureMain(
    page,
    "/catalog",
    "サービス・プラン",
    "M06-catalog.png",
    "OpenAI / Codex",
  );
  await captureTab(page, "同定候補", "M06-catalog-candidates.png");
  await captureTab(page, "利用枠定義", "M06-catalog-limit-definitions.png");
  await captureTab(page, "プラン", "M06-catalog-plans.png");
  await captureTab(page, "プラン版・倍率", "M06-catalog-plan-versions.png");
  await captureTab(page, "標準価格", "M06-catalog-standard-prices.png");
  await expect(page.getByText("$20.00 / 月 / 1シート")).toBeVisible();
  await captureMain(
    page,
    "/hubs",
    "Hub・収集",
    "M07-hubs.png",
    "評価 Hub（192.168.0.16）",
  );
  await page.getByRole("button", { name: "取得履歴" }).click();
  const history = page.getByLabel("取得履歴");
  await expect(history).toContainText("成功");
  await history.scrollIntoViewIfNeeded();
  await page.screenshot({ path: output("M07-hubs-collection-history.png") });
  await captureMain(
    page,
    "/evidence",
    "観測と根拠",
    "M08-evidence.png",
    "手動取得 / 成功",
  );
  await captureTab(page, "原 JSON", "M08-evidence-raw-json.png");
  await page.getByRole("button", { name: "マスク済み詳細" }).first().click();
  const jsonTree = page.getByLabel("JSON ツリー");
  await expect(jsonTree).toBeVisible();
  await jsonTree.locator("summary").first().click();
  await jsonTree.locator("details").evaluateAll((details) => {
    for (const detail of details) {
      (detail as HTMLDetailsElement).open = true;
    }
  });
  await expect(
    jsonTree.getByText('deviceId: "device-evaluation"'),
  ).toBeVisible();
  await captureCurrent(page, "M08-evidence-raw-json-detail.png");
  await captureTab(page, "元観測", "M08-evidence-observations.png");
  await captureTab(page, "利用枠系列", "M08-evidence-limit-series.png");
  await captureTab(page, "計算根拠", "M08-evidence-calculation.png");
  await captureTab(page, "集計根拠", "M08-evidence-aggregation.png");
  await expect(
    page.getByText("usage-codex-start → usage-codex-current"),
  ).toBeVisible();
  await captureMain(
    page,
    "/data",
    "データ管理",
    "M09-data-management.png",
    "24",
  );
  await captureTab(page, "バックアップ", "M09-data-management-backup.png");
  await captureTab(page, "復元", "M09-data-management-restore.png");
  await captureTab(page, "明示パージ", "M09-data-management-purge.png");
  await captureMain(
    page,
    "/audit",
    "監査記録",
    "M10-audit.png",
    "Hub接続確認に成功",
  );
  await captureMain(
    page,
    "/settings",
    "表示設定",
    "M11-settings.png",
    "Asia/Tokyo",
  );
});
