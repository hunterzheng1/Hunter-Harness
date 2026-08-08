import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { initializeProject } from "../src/project/initialize.js";
import { pushProject } from "../src/push/push.js";

const resourcesRoot = fileURLToPath(new URL("../../workflow-data-harness", import.meta.url));

describe("pushProject archive summaries", () => {
  it("keeps every archive path out of generic push proposals", async () => {
    const root = await mkdtemp(join(tmpdir(), "hh-push-archive-"));
    await initializeProject({
      projectRoot: root,
      resourcesRoot,
      config: { agents: ["claude-code"], profile: "general" },
      dryRun: false
    });

    const archiveName = "2026-07-16-sample-change";
    const summaryRel =
      `.harness/archive/${archiveName}/reports/final/summary-data.json`;
    const designRel = `.harness/archive/${archiveName}/spec/design.md`;
    const planRel = `.harness/archive/${archiveName}/plans/sample-plan.md`;
    const reviewRel = `.harness/archive/${archiveName}/reports/review/review-report.md`;
    const testRel = `.harness/archive/${archiveName}/reports/test/test-report.md`;
    const metaRel = `.harness/archive/${archiveName}/meta/archive-meta.md`;
    const contextRel = `.harness/archive/${archiveName}/meta/change-context.json`;
    const summaryDir = join(root, ".harness", "archive", archiveName, "reports", "final");
    await mkdir(summaryDir, { recursive: true });
    await mkdir(join(root, ".harness", "archive", archiveName, "spec"), { recursive: true });
    await mkdir(join(root, ".harness", "archive", archiveName, "plans"), { recursive: true });
    await mkdir(join(root, ".harness", "archive", archiveName, "reports", "review"), {
      recursive: true
    });
    await mkdir(join(root, ".harness", "archive", archiveName, "reports", "test"), {
      recursive: true
    });
    await mkdir(join(root, ".harness", "archive", archiveName, "meta"), { recursive: true });
    await writeFile(
      join(summaryDir, "summary-data.json"),
      JSON.stringify({
        changeName: "sample-change",
        finalStatus: "OK",
        schemaVersion: "2.2"
      }, null, 2) + "\n",
      "utf8"
    );
    await writeFile(
      join(root, ".harness", "archive", archiveName, "spec", "design.md"),
      "# Design\n",
      "utf8"
    );
    await writeFile(
      join(root, ".harness", "archive", archiveName, "plans", "sample-plan.md"),
      "# Plan\n",
      "utf8"
    );
    await writeFile(
      join(root, ".harness", "archive", archiveName, "reports", "review", "review-report.md"),
      "# Review\n",
      "utf8"
    );
    await writeFile(
      join(root, ".harness", "archive", archiveName, "reports", "test", "test-report.md"),
      "# Test\n",
      "utf8"
    );
    await writeFile(
      join(root, ".harness", "archive", archiveName, "meta", "archive-meta.md"),
      "# Archive meta\n",
      "utf8"
    );
    await writeFile(
      join(root, ".harness", "archive", archiveName, "meta", "change-context.json"),
      JSON.stringify({ changeName: "sample-change" }) + "\n",
      "utf8"
    );
    await writeFile(
      join(root, ".harness", "archive", archiveName, "meta-note.txt"),
      "should not be pushed\n",
      "utf8"
    );
    await writeFile(
      join(summaryDir, "final-summary.html"),
      "<html>should not be pushed</html>\n",
      "utf8"
    );
    await mkdir(join(root, ".harness", "archive", archiveName, "evidence"), { recursive: true });
    await writeFile(
      join(root, ".harness", "archive", archiveName, "evidence", "blob.bin"),
      "diagnostic\n",
      "utf8"
    );

    const result = await pushProject({
      projectRoot: root,
      resourcesRoot,
      env: {},
      dryRun: true
    });

    const proposedPaths = result.preview.operations.map((item) => item.path);
    expect(proposedPaths.some((path) => path.startsWith(".harness/archive/"))).toBe(false);
    expect(
      result.preview.skipped
        .filter((item) => item.path.startsWith(".harness/archive/"))
        .map((item) => [item.path, item.reason])
    ).toEqual(expect.arrayContaining([
      [summaryRel, "policy-never"],
      [designRel, "policy-never"],
      [planRel, "policy-never"],
      [reviewRel, "policy-never"],
      [testRel, "policy-never"],
      [metaRel, "policy-never"],
      [contextRel, "policy-never"]
    ]));
  });
});
