import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/bin.js";
import {
  assertWorkflowCompatibility,
  WorkflowCompatibilityError
} from "../src/workflow-data/compatibility.js";
import { runSync } from "../src/commands/sync.js";

const resourcesRoot = fileURLToPath(new URL("../../workflow-data-harness", import.meta.url));

describe("CLI/workflow capability contract", () => {
  it("reports parser capabilities and workflow requirements as JSON", async () => {
    const stdout: string[] = [];
    const root = await mkdtemp(join(tmpdir(), "hunter-capabilities-"));
    try {
      const code = await runCli(["capabilities", "--json"], {
        cwd: root,
        resourcesRoot,
        stdout: (value) => stdout.push(value),
        stderr: () => undefined
      });
      expect(code).toBe(0);
      const payload = JSON.parse(stdout.join("")) as {
        cliVersion: string;
        workflowPackageVersion: string;
        workflowBundleVersion: string;
        capabilities: string[];
        commands: Record<string, { available: boolean; schemaVersion: number }>;
        compatibility: { compatible: boolean };
      };
      const packageJson = JSON.parse(
        await readFile(join(process.cwd(), "packages", "cli", "package.json"), "utf8")
      ) as { version: string };
      expect(payload.cliVersion).toBe(packageJson.version);
      expect(payload.workflowPackageVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(payload.workflowBundleVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(payload.commands.sync).toEqual({ available: true, schemaVersion: 2 });
      expect(payload.commands["rules-sync"]).toEqual({ available: true, schemaVersion: 1 });
      expect(payload.commands["rules-review"]).toEqual({ available: true, schemaVersion: 1 });
      expect(payload.commands.archive).toEqual({ available: true, schemaVersion: 1 });
      expect(payload.commands.knowledge).toEqual({ available: true, schemaVersion: 1 });
      expect(payload.commands.instructions).toEqual({ available: true, schemaVersion: 1 });
      expect(payload.commands["harness-push"]).toEqual({ available: true, schemaVersion: 1 });
      expect(payload.commands["harness-pull"]).toEqual({ available: true, schemaVersion: 1 });
      expect(payload.capabilities).toEqual(expect.arrayContaining([
        "build-profile@3",
        "verification-graph@1",
        "execution-session@1",
        "external-convergence@1",
        "sync@2",
        "knowledge-sync@3",
        "codegraph-status@2",
        "doctor-capability@1",
        "registry-governance@1"
      ]));
      expect(payload.capabilities).toEqual(expect.arrayContaining([
        "remote-sync-push@1",
        "remote-sync-pull@1"
      ]));
      expect(payload.compatibility.compatible).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks an old CLI before project writes when workflow requirements are newer", () => {
    expect(() => assertWorkflowCompatibility(
      {
        minimumCliVersion: "0.2.31",
        capabilities: ["rules-sync@1", "rules-review@1"]
      },
      {
        cliVersion: "0.2.20",
        capabilities: ["rules-sync@1"]
      }
    )).toThrow(WorkflowCompatibilityError);

    try {
      assertWorkflowCompatibility(
        {
          minimumCliVersion: "0.2.31",
          capabilities: ["rules-sync@1", "rules-review@1"]
        },
        { cliVersion: "0.2.20", capabilities: ["rules-sync@1"] }
      );
    } catch (error) {
      expect((error as WorkflowCompatibilityError).code).toBe("BLOCKED_CAPABILITY_MISMATCH");
      expect((error as WorkflowCompatibilityError).exitCode).toBe(7);
    }
  });

  it("performs the capability gate inside sync before runtime or project work", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-sync-capability-"));
    const workflow = join(root, "workflow");
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      await mkdir(workflow, { recursive: true });
      await writeFile(join(workflow, "hunter-workflow-family.json"), JSON.stringify({
        minimumCliVersion: "99.0.0",
        capabilities: ["sync@99"]
      }));
      const code = await runSync(
        { project: root, check: true, json: true, progress: "none" },
        {
          cwd: root,
          resourcesRoot: workflow,
          stdout: (value) => stdout.push(value),
          stderr: (value) => stderr.push(value),
          prompt: async () => "",
          fetch
        }
      );
      expect(code).toBe(7);
      expect(stderr.join("")).toBe("");
      const payload = JSON.parse(stdout.join("")) as {
        status: string;
        componentOutcomes?: Array<{ component: string }>;
        remediations: Array<{ component: string }>;
      };
      expect(payload.status).toBe("BLOCKED");
      expect(payload.remediations).toEqual(expect.arrayContaining([
        expect.objectContaining({ component: "capabilities" })
      ]));
      expect(await readFile(join(workflow, "hunter-workflow-family.json"), "utf8"))
        .toContain("\"sync@99\"");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
