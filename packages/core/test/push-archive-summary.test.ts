import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { initializeProject } from "../src/project/initialize.js";
import { pushProject } from "../src/push/push.js";

const resourcesRoot = fileURLToPath(new URL("../../workflow-data-harness", import.meta.url));

describe("pushProject archive summaries", () => {
  it("includes only archive summary-data.json in the dry-run preview", async () => {
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
    const summaryDir = join(root, ".harness", "archive", archiveName, "reports", "final");
    await mkdir(summaryDir, { recursive: true });
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
      join(root, ".harness", "archive", archiveName, "meta-note.txt"),
      "should not be pushed\n",
      "utf8"
    );
    await writeFile(
      join(summaryDir, "final-summary.html"),
      "<html>should not be pushed</html>\n",
      "utf8"
    );

    const result = await pushProject({
      projectRoot: root,
      resourcesRoot,
      env: {},
      dryRun: true
    });

    const proposedPaths = result.preview.operations.map((item) => item.path);
    expect(proposedPaths).toContain(summaryRel);
    expect(proposedPaths.some((path) => path.endsWith("meta-note.txt"))).toBe(false);
    expect(proposedPaths.some((path) => path.endsWith("final-summary.html"))).toBe(false);
    expect(proposedPaths.filter((path) => path.startsWith(".harness/archive/"))).toEqual([
      summaryRel
    ]);
  });
});
