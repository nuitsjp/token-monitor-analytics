import { describe, expect, it } from "vitest";
import { findEntryChunkCycle, type EmittedChunkGraph } from "./chunkGraph";

describe("findEntryChunkCycle", () => {
  it("accepts an acyclic production chunk graph", () => {
    const graph: EmittedChunkGraph = new Map([
      ["index.js", { isEntry: true, imports: ["vendor.js"] }],
      ["vendor.js", { isEntry: false, imports: [] }],
    ]);

    expect(findEntryChunkCycle(graph)).toBeNull();
  });

  it("rejects a cycle reachable from the application entry", () => {
    const graph: EmittedChunkGraph = new Map([
      ["index.js", { isEntry: true, imports: ["fluent-ui.js"] }],
      ["fluent-ui.js", { isEntry: false, imports: ["index.js"] }],
    ]);

    expect(findEntryChunkCycle(graph)).toEqual([
      "index.js",
      "fluent-ui.js",
      "index.js",
    ]);
  });

  it("ignores an unreachable cycle and external imports", () => {
    const graph: EmittedChunkGraph = new Map([
      [
        "index.js",
        {
          isEntry: true,
          imports: ["vendor.js", "external-package"],
        },
      ],
      ["vendor.js", { isEntry: false, imports: [] }],
      ["unused-a.js", { isEntry: false, imports: ["unused-b.js"] }],
      ["unused-b.js", { isEntry: false, imports: ["unused-a.js"] }],
    ]);

    expect(findEntryChunkCycle(graph)).toBeNull();
  });

  it("checks every entry and rejects a self-import", () => {
    const graph: EmittedChunkGraph = new Map([
      ["first.js", { isEntry: true, imports: ["shared.js"] }],
      ["shared.js", { isEntry: false, imports: [] }],
      ["second.js", { isEntry: true, imports: ["second.js"] }],
    ]);

    expect(findEntryChunkCycle(graph)).toEqual(["second.js", "second.js"]);
  });
});
