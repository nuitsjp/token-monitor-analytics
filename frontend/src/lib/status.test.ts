import { describe, expect, it } from "vitest";
import { presentStatus } from "./status";

describe("presentStatus", () => {
  it("keeps credential and connection meanings distinct", () => {
    expect(presentStatus("registered")).toMatchObject({
      label: "登録済み",
      intent: "success",
    });
    expect(presentStatus("authentication_failed")).toMatchObject({
      label: "認証失敗",
      intent: "error",
      nextAction: "資格情報を更新",
    });
    expect(presentStatus("unsupported_contract")).toMatchObject({
      label: "未対応API契約",
      intent: "warning",
    });
  });

  it("does not present an unknown code as success", () => {
    expect(presentStatus("future_state")).toEqual({
      label: "future_state",
      intent: "warning",
      description: "未定義の状態です。",
    });
  });
});
