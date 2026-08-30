import { readFile } from "node:fs/promises";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      name: "strip-broken-tabster-source-map",
      enforce: "pre",
      async load(id) {
        const file = id.split("?", 1)[0];
        if (
          !/[\\/]node_modules[\\/]tabster[\\/]dist[\\/]cjs[\\/].+\.cjs$/.test(
            file,
          )
        ) {
          return null;
        }
        const code = await readFile(file, "utf8");
        return code.replace(/\s*\/\/# sourceMappingURL=.*$/m, "");
      },
    },
    react(),
  ],
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/test/**", "src/vite-env.d.ts"],
      reporter: ["text", "json-summary", "lcov"],
      thresholds: {
        lines: 68,
        branches: 58,
        functions: 57,
        statements: 66,
      },
    },
    environment: "jsdom",
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
    setupFiles: ["./src/test/setup.ts"],
    server: {
      deps: {
        inline: [/@fluentui/, /tabster/, /keyborg/],
      },
    },
  },
});
