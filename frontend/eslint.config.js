import js from "@eslint/js";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores(["bindings/**", "dist/**", "test-results/**"]),
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["src/**/*.{ts,tsx}"],
  })),
  reactHooks.configs.flat["recommended-latest"],
  reactRefresh.configs.vite,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { "jsx-a11y": jsxA11y },
    settings: {
      "jsx-a11y": {
        components: {
          Button: "button",
          Checkbox: "input",
          Dialog: "dialog",
          Dropdown: "select",
          Input: "input",
          Option: "option",
          Radio: "input",
          Tab: "button",
          TabList: "div",
          Textarea: "textarea",
        },
      },
    },
    rules: {
      ...jsxA11y.configs.recommended.rules,
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },
  {
    files: ["src/lib/backend.ts", "src/**/*.test.{ts,tsx}"],
    rules: {
      // Rule: @typescript-eslint/require-await. Reason: the fake backend and
      // test fixtures expose synchronous callbacks through Promise-shaped
      // adapter methods. Scope: backend.ts and frontend tests. Owner:
      // frontend. Expires: 2026-12-31.
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    linterOptions: { reportUnusedDisableDirectives: "error" },
  },
);
