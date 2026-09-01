import { defineConfig } from "@playwright/test";
import baseConfig from "./playwright.config";

export default defineConfig({
  ...baseConfig,
  webServer: {
    command: "npm run preview:e2e",
    url: "http://127.0.0.1:9245",
    reuseExistingServer: false,
  },
});
