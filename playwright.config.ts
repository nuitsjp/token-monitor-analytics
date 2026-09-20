import { defineConfig, devices } from '@playwright/test';
const workers = Number(process.env.E2E_WORKERS ?? 4);
if (!Number.isInteger(workers) || workers < 1)
    throw new Error('E2E_WORKERSは正の整数です。');
export default defineConfig({
    testDir: './tests/e2e', fullyParallel: true, workers, retries: 0, forbidOnly: !!process.env.CI,
    timeout: 45000, expect: { timeout: 10000 }, outputDir: '.e2e-results',
    reporter: [['list'], ['html', { open: 'never' }]],
    use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'],
                launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : undefined } }],
    // webServer/baseURLを共有しない。各テストfixtureが本番entry/DB/portを所有する。
});
