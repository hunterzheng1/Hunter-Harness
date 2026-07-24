import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/bin.js";

const resourcesRoot = fileURLToPath(new URL("../../workflow-data-harness", import.meta.url));

describe("hunter-harness rules-sync CLI", () => {
  it("converges agent rules, projects them, and emits review-derived candidates", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-rules-sync-cli-"));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const run = (args: string[]) => runCli(args, {
      cwd: root,
      resourcesRoot,
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value)
    });
    expect(await run([
      "--profile", "general", "--agents", "all", "--non-interactive", "--yes"
    ])).toBe(0);
    await writeFile(join(root, ".cursor", "rules", "team-custom.mdc"), "Use focused tests.\n");
    for (const archive of ["change-a", "change-b"]) {
      const directory = join(root, ".harness", "archive", archive, "runtime");
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "review-findings-input.json"),
        JSON.stringify({
          findings: [{
            severity: "YELLOW",
            title: "Missing focused test",
            suggestion: "Every bug fix must include a focused regression test."
          }]
        }) + "\n"
      );
    }

    stdout.length = 0;
    stderr.length = 0;
    const code = await run(["rules-sync", "--json"]);
    const output = JSON.parse(stdout.join("")) as {
      command: string;
      summary: { migrated: number; conflicts: number; rule_candidates: number };
    };

    expect(code).toBe(0);
    expect(output.command).toBe("rules-sync");
    expect(output.summary).toMatchObject({
      migrated: 1,
      conflicts: 0,
      rule_candidates: 1
    });
    expect(await readFile(
      join(root, ".harness", "rules", "team-custom.md"),
      "utf8"
    )).toBe("Use focused tests.\n");
    expect(await readFile(
      join(root, ".claude", "rules", "team-custom.md"),
      "utf8"
    )).toBe("Use focused tests.\n");
    expect(await readFile(
      join(root, ".harness", "knowledge", "rule-candidates.json"),
      "utf8"
    )).toContain("\"status\": \"candidate\"");
  });
});
