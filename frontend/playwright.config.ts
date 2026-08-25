import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  use: {
    baseURL: "http://127.0.0.1:9245",
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:9245",
    reuseExistingServer: true,
  },
});
