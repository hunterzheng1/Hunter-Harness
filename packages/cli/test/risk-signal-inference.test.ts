import { describe, expect, it } from "vitest";

import {
  inferRiskSignals,
  parsePorcelainPaths
} from "../src/plan-evidence/risk-signal-inference.js";

describe("parsePorcelainPaths", () => {
  it("parses status lines, renames, and quoted paths", () => {
    expect(parsePorcelainPaths(
      " M src/auth/token.ts\n" +
      "?? docs/guide.md\n" +
      "R  old/name.ts -> new/name.ts\n" +
      " M \"src/with space/file.ts\"\n"
    )).toEqual([
      "src/auth/token.ts",
      "docs/guide.md",
      "new/name.ts",
      "src/with space/file.ts"
    ]);
  });

  it("normalizes backslashes", () => {
    expect(parsePorcelainPaths(" M src\\auth\\token.ts\n")).toEqual(["src/auth/token.ts"]);
  });
});

describe("inferRiskSignals", () => {
  it("hits the marker table on affected_paths", () => {
    const result = inferRiskSignals({
      declared: [],
      affectedPaths: ["src/auth/token-service.ts"]
    });
    expect(result.effective).toContain("auth");
    expect(result.effective).toContain("production_code");
    expect(result.provenance).toContainEqual({ signal: "auth", source: "inferred" });
  });

  it("docs-only paths produce docs_only and no production_code", () => {
    const result = inferRiskSignals({
      declared: [],
      affectedPaths: ["docs/guide.md", "README.md"]
    });
    expect(result.effective).toContain("docs_only");
    expect(result.effective).not.toContain("production_code");
  });

  it("unions declared and inferred, never subtracting", () => {
    const result = inferRiskSignals({
      declared: ["docs_only"],
      affectedPaths: ["src/workflow-policy/loader.ts"]
    });
    // 反向冲突取并集：declared=docs_only + inferred=production_code/shared_state
    expect(result.effective).toContain("docs_only");
    expect(result.effective).toContain("production_code");
    expect(result.effective).toContain("shared_state");
    expect(result.provenance).toContainEqual({ signal: "docs_only", source: "declared" });
    expect(result.provenance).toContainEqual({ signal: "production_code", source: "inferred" });
  });

  it("marks signals present in both as declared+inferred", () => {
    const result = inferRiskSignals({
      declared: ["auth"],
      affectedPaths: ["src/auth/token.ts"]
    });
    expect(result.provenance).toContainEqual({ signal: "auth", source: "declared+inferred" });
  });

  it("merges git status paths as the secondary source", () => {
    const result = inferRiskSignals({
      declared: [],
      affectedPaths: ["docs/note.md"],
      gitStatusPaths: ["src/migration/001-init.sql"]
    });
    expect(result.effective).toContain("migration");
    expect(result.effective).toContain("production_code");
  });

  it("empty everything yields no signals", () => {
    const result = inferRiskSignals({ declared: [], affectedPaths: [] });
    expect(result.effective).toEqual([]);
    expect(result.provenance).toEqual([]);
  });
});
