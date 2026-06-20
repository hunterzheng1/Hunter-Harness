import { describe, expect, it } from "vitest";

import {
  assessCodebaseMap,
  CODEBASE_MAP_DOCUMENTS,
  validateCodebaseMapArtifacts
} from "../src/index.js";

describe("codebase map support", () => {
  it("requires the seven generated-reviewable documents", () => {
    expect(CODEBASE_MAP_DOCUMENTS).toEqual([
      "STACK.md",
      "INTEGRATIONS.md",
      "ARCHITECTURE.md",
      "STRUCTURE.md",
      "CONVENTIONS.md",
      "TESTING.md",
      "CONCERNS.md"
    ]);
    expect(() => validateCodebaseMapArtifacts({ "STACK.md": "# Stack\n" })).toThrow(
      /missing.*INTEGRATIONS\.md/i
    );
  });

  it("accepts complete non-empty documents and labels every output", () => {
    const files = Object.fromEntries(
      CODEBASE_MAP_DOCUMENTS.map((name) => [name, "# " + name + "\nEvidence.\n"])
    );
    expect(validateCodebaseMapArtifacts(files)).toEqual(
      CODEBASE_MAP_DOCUMENTS.map((name) => ({
        path: ".harness/codebase/map/" + name,
        file_kind: "generated_reviewable"
      }))
    );
  });

  it("recommends but never automatically runs missing or stale mapping", () => {
    expect(assessCodebaseMap(null, new Date("2026-06-20T00:00:00Z"))).toEqual({
      status: "missing",
      recommend_refresh: true,
      auto_run: false,
      reason: "map manifest is missing"
    });
    expect(assessCodebaseMap({
      generated_at: "2026-06-01T00:00:00Z",
      source_revision: "abc",
      documents: [...CODEBASE_MAP_DOCUMENTS]
    }, new Date("2026-06-20T00:00:00Z"))).toMatchObject({
      status: "stale",
      recommend_refresh: true,
      auto_run: false
    });
  });
});
