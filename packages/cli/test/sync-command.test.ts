import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { initializeProject } from "@hunter-harness/core";

import { runCli } from "../src/bin.js";
import { recoveryEnv } from "./recovery-env.js";

const resourcesRoot = fileURLToPath(new URL("../../workflow-data-harness", import.meta.url));

describe("hunter-harness sync", () => {
  it("keeps dry-run read-only and returns no persistent report path", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-sync-dry-run-"));
    await initializeProject({
      projectRoot: root,
      resourcesRoot,
      config: { agents: ["claude-code"], profile: "general" },
      dryRun: false
    });
    const projectedSkill = join(
      root,
      ".claude",
      "skills",
      "harness-sync",
      "SKILL.md"
    );
    await stat(projectedSkill);
    await rm(projectedSkill);
    const stdout: string[] = [];
    try {
      const code = await runCli([
        "sync", "--project", root, "--profile", "interactive", "--dry-run", "--verbose", "--json"
      ], {
        cwd: root,
        resourcesRoot,
        stdout: (value) => stdout.push(value),
        stderr: () => undefined,
        env: {
          ...recoveryEnv,
          HUNTER_HARNESS_PYTHON:
            "C:\\Users\\WINDOWS\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe"
        }
      });
      expect([0, 5], stdout.join("")).toContain(code);
      const payload = JSON.parse(stdout.join("")) as {
        reportPath: string | null;
        reportSha256: string | null;
        componentOutcomes: Array<{
          component: string;
          details?: { applied?: number };
        }>;
        partialEffects: {
          persisted: string[];
          notPersisted: string[];
          summary: string;
        };
      };
      expect(payload.reportPath).toBeNull();
      expect(payload.reportSha256).toBeNull();
      expect(payload.componentOutcomes.find((item) =>
        item.component === "adapter-projection"
      )?.details?.applied).toBeGreaterThan(0);
      expect(payload.partialEffects.persisted).toEqual([]);
      expect(payload.partialEffects.notPersisted).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/只读预览了 \d+ 项 Adapter 投影变更/)
        ])
      );
      expect(payload.partialEffects.summary).toContain("没有产生持久化变更");
      await expect(stat(projectedSkill)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(root, ".harness", "runtime", "sync"))).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("runs one bounded entrypoint without writing sync logs or monitoring state", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-sync-command-"));
    await initializeProject({
      projectRoot: root,
      resourcesRoot,
      config: { agents: ["claude-code"], profile: "general" },
      dryRun: false
    });
    const stdout: string[] = [];
    try {
      const code = await runCli([
        "sync", "--project", root, "--profile", "interactive", "--json"
      ], {
        cwd: root,
        resourcesRoot,
        stdout: (value) => stdout.push(value),
        stderr: () => undefined,
        env: {
          ...recoveryEnv,
          HUNTER_HARNESS_PYTHON:
            "C:\\Users\\WINDOWS\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe"
        }
      });
      expect([0, 5], stdout.join("")).toContain(code);
      const text = stdout.join("");
      expect(Buffer.byteLength(text)).toBeLessThan(16 * 1024);
      const payload = JSON.parse(text) as {
        status: string;
        runId: string;
        components: Record<string, number>;
        reportPath: string | null;
        reportSha256: string | null;
      };
      expect(payload.status).toMatch(/^(OK|ADVISORY|WARN)$/);
      expect(payload.reportPath).toBeNull();
      expect(payload.reportSha256).toBeNull();
      await expect(stat(join(root, ".harness", "knowledge")))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(root, ".harness", "runtime", "sync")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("validates only instruction entrypoints owned by enabled Agents", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-sync-codebuddy-entrypoint-"));
    await initializeProject({
      projectRoot: root,
      resourcesRoot,
      config: { agents: ["codebuddy"], profile: "general" },
      dryRun: false
    });
    const stdout: string[] = [];
    try {
      const code = await runCli([
        "sync", "--project", root, "--profile", "interactive", "--dry-run", "--verbose", "--json"
      ], {
        cwd: root,
        resourcesRoot,
        stdout: (value) => stdout.push(value),
        stderr: () => undefined,
        env: {
          ...recoveryEnv,
          HUNTER_HARNESS_PYTHON:
            "C:\\Users\\WINDOWS\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe"
        }
      });
      expect([0, 5]).toContain(code);
      const payload = JSON.parse(stdout.join("")) as {
        componentOutcomes: Array<{
          component: string;
          status: string;
          details?: { unresolvedReferenceSamples?: string[]; reachableFileSamples?: string[] };
        }>;
      };
      const instructionGraph = payload.componentOutcomes.find((item) =>
        item.component === "instruction-graph"
      );
      expect(instructionGraph?.status).not.toBe("FAIL");
      expect(instructionGraph?.details?.unresolvedReferenceSamples ?? []).not.toContain("CLAUDE.md");
      expect(instructionGraph?.details?.reachableFileSamples).toEqual(
        expect.arrayContaining(["AGENTS.md", "CODEBUDDY.md"])
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
