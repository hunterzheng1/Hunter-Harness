import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/bin.js";

const resourcesRoot = fileURLToPath(new URL("../../workflow-data-harness", import.meta.url));

describe("hunter-harness refresh CLI freshness JSON (变更簇 D / task 12)", () => {
  let root: string;
  let stdout: string[];
  let stderr: string[];

  async function run(args: string[]): Promise<number> {
    return runCli(args, {
      cwd: root,
      resourcesRoot,
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value)
    });
  }

  it("emits per-agent identity and freshness status while keeping legacy fields", async () => {
    root = await mkdtemp(join(tmpdir(), "hunter-refresh-freshness-cli-"));
    stdout = []; stderr = [];
    expect(await run(["--profile", "general", "--non-interactive", "--yes"])).toBe(0);

    stdout = []; stderr = [];
    const code = await run(["refresh", "--non-interactive", "--yes", "--json"]);
    expect(code).toBe(0);
    const output = JSON.parse(stdout.join("")) as {
      command: string;
      ok: boolean;
      summary: { applied: number; conflicts: number };
      items: unknown[];
      freshness: Array<{
        agent: string;
        profile: string | null;
        status: string;
        identity: {
          bundleVersion: string | null;
          installedBundleVersion: string | null;
          manifestHash: string | null;
          installedManifestHash: string | null;
        };
        driftedFiles: string[];
        missingFiles: string[];
      }>;
    };
    // legacy 字段保持兼容
    expect(output.command).toBe("refresh");
    expect(output.summary).toBeDefined();
    expect(Array.isArray(output.items)).toBe(true);
    // per-agent freshness + identity（refresh JSON 合同）
    expect(Array.isArray(output.freshness)).toBe(true);
    const entry = output.freshness.find((item) => item.agent === "claude-code");
    expect(entry, "freshness entry for claude-code").toBeDefined();
    expect(entry?.status).toBe("CURRENT");
    expect(entry?.profile).toBe("general");
    expect(entry?.identity.bundleVersion).toBeTruthy();
    expect(entry?.identity.manifestHash).toBeTruthy();
    expect(entry?.identity.installedManifestHash).toBe(entry?.identity.manifestHash);
  });

  it("reports LOCALLY_MODIFIED for a drifted managed file in JSON", async () => {
    root = await mkdtemp(join(tmpdir(), "hunter-refresh-freshness-drift-cli-"));
    stdout = []; stderr = [];
    expect(await run(["--profile", "general", "--non-interactive", "--yes"])).toBe(0);
    await writeFile(join(root, ".claude", "skills", "harness-review", "SKILL.md"), "user edited\n");

    stdout = []; stderr = [];
    await run(["refresh", "--non-interactive", "--yes", "--json"]);
    const output = JSON.parse(stdout.join("")) as {
      freshness: Array<{ agent: string; status: string; driftedFiles: string[] }>;
    };
    const entry = output.freshness.find((item) => item.agent === "claude-code");
    expect(entry?.status).toBe("LOCALLY_MODIFIED");
    expect(entry?.driftedFiles).toContain(".claude/skills/harness-review/SKILL.md");
  });
});
