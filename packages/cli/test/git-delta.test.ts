import { describe, expect, it } from "vitest";

import { summarizeChangedPaths } from "../src/sync/git-delta.js";

describe("bounded git delta", () => {
  it("excludes Harness runtime evidence and returns bounded aggregates", () => {
    const result = summarizeChangedPaths([
      "packages/core/src/index.ts",
      "packages/core/test/index.test.ts",
      "docs/guide.md",
      "config/build.json",
      ".harness/runtime/sync/report.json",
      ".harness/cache/knowledge.json"
    ]);

    expect(result.changedFileCount).toBe(4);
    expect(result.excludedFileCount).toBe(2);
    expect(result.categories).toEqual({
      source: 1,
      test: 1,
      docs: 1,
      config: 1,
      other: 0
    });
    expect(result.topDirectories.length).toBeLessThanOrEqual(10);
    expect(JSON.stringify(result)).not.toContain("report.json");
  });
});
