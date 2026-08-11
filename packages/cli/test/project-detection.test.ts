import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectProject } from "../src/commands/refresh.js";

describe("project state detection", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hunter-project-detection-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("treats retained rules, config, codebase, and adapter markers as reinitializable", async () => {
    const retained = [
      join(root, ".harness", "config", "local.yaml"),
      join(root, ".harness", "rules", "team.md"),
      join(root, ".harness", "codebase", "map", "summary.md"),
      join(root, ".agents", "skills", "harness-run", ".harness-build.json")
    ];
    for (const path of retained) {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, "retained\n", "utf8");
    }
    await writeFile(
      join(root, "AGENTS.md"),
      "<!-- hunter-harness:start id=legacy -->\n旧说明\n<!-- hunter-harness:end -->\n",
      "utf8"
    );

    await expect(detectProject(root)).resolves.toEqual({ status: "absent" });
  });

  it.each([
    ["archive", "existing/reports/final/summary-data.json"],
    ["changes", "unfinished/plans/unfinished-plan.md"]
  ])("protects non-empty .harness/%s records", async (directory, relativePath) => {
    const path = join(root, ".harness", directory, ...relativePath.split("/"));
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "preserve\n", "utf8");

    const detection = await detectProject(root);

    expect(detection).toMatchObject({
      status: "partial",
      reasonCode: "PARTIAL_HARNESS_STATE_DETECTED",
      sentinels: [`.harness/${directory}`]
    });
  });

  it("keeps unfinished local transactions behind the recovery gate", async () => {
    const journal = join(
      root,
      ".harness",
      "state",
      "transactions",
      "txn-1",
      "journal.json"
    );
    await mkdir(join(journal, ".."), { recursive: true });
    await writeFile(journal, JSON.stringify({ state: "interrupted" }), "utf8");

    await expect(detectProject(root)).resolves.toMatchObject({
      status: "recovery-required",
      reasonCode: "LOCAL_HARNESS_RECOVERY_REQUIRED",
      recoveryTransactions: ["txn-1"]
    });
  });
});
