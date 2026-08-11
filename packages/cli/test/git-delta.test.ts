import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { observeGitDelta, summarizeChangedPaths } from "../src/sync/git-delta.js";

describe("bounded git delta", () => {
  it("ignores legacy sync receipts because sync no longer persists a baseline", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-sync-delta-"));
    const git = (...args: string[]): string => execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    try {
      git("init");
      git("config", "user.email", "hunter-harness@example.invalid");
      git("config", "user.name", "Hunter Harness Test");
      await writeFile(join(root, "app.ts"), "export const first = true;\n");
      git("add", "app.ts");
      git("commit", "-m", "first");
      const legacyHead = git("rev-parse", "HEAD");
      await writeFile(join(root, "app.ts"), "export const second = true;\n");
      git("add", "app.ts");
      git("commit", "-m", "second");
      await mkdir(join(root, ".harness", "runtime", "sync"), { recursive: true });
      await writeFile(
        join(root, ".harness", "runtime", "sync", "last-success.json"),
        JSON.stringify({ headCommit: legacyHead })
      );

      const result = await observeGitDelta(root);

      expect(result.baselineSource).toBe("none");
      expect(result.baselineCommit).toBeNull();
      expect(result.changedFileCount).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
