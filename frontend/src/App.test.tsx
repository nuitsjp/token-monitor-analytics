import { render, screen } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("compact window", () => {
  it("shows the first-run state without exposing an internal screen ID", () => {
    render(<App />);
    expect(
      screen.getByRole("heading", { name: "Hub を登録してください" }),
    ).toBeVisible();
    expect(screen.queryByText(/T01|M00|Phase/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "メイン画面を開く" }),
    ).toBeDisabled();
  });

  it("has no automatically detectable accessibility violation", async () => {
    render(<App />);
    const result = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations).toEqual([]);
  });
});
