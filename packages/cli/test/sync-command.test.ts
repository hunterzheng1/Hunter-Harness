import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { initializeProject } from "@hunter-harness/core";

import { runCli } from "../src/bin.js";

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
        "sync", "--project", root, "--profile", "interactive", "--dry-run", "--json"
      ], {
        cwd: root,
        resourcesRoot,
        stdout: (value) => stdout.push(value),
        stderr: () => undefined,
        env: {
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
          expect.stringMatching(/adapter projection previewed \d+ change/)
        ])
      );
      expect(payload.partialEffects.summary).toContain("No durable sync effects");
      await expect(stat(projectedSkill)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(root, ".harness", "runtime", "sync"))).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("runs one bounded entrypoint and emits a compact summary plus verifiable report", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-sync-command-"));
    await initializeProject({
      projectRoot: root,
      resourcesRoot,
      config: { agents: ["claude-code"], profile: "general" },
      dryRun: false
    });
    await mkdir(join(root, ".harness", "knowledge"), { recursive: true });
    await writeFile(
      join(root, ".harness", "knowledge", "index.json"),
      JSON.stringify({ schemaVersion: 1, entries: [] })
    );
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
        reportPath: string;
        reportSha256: string;
      };
      expect(payload.status).toMatch(/^(OK|WARN)$/);
      expect(payload.reportPath).toMatch(/^\.harness\/runtime\/sync\//);
      expect(payload.reportSha256).toMatch(/^[a-f0-9]{64}$/);
      const report = JSON.parse(
        await readFile(join(root, payload.reportPath), "utf8")
      ) as { components: Array<{ status: string; reasonCode: string }> };
      expect(report.components.length).toBeGreaterThan(3);
      expect(report.components.every((item) =>
        /^(OK|WARN|FAIL|BLOCKED|UNKNOWN)$/.test(item.status)
      )).toBe(true);
      const lastRun = JSON.parse(
        await readFile(
          join(root, ".harness", "runtime", "sync", "last-run.json"),
          "utf8"
        )
      ) as { runId: string; status: string };
      const lastSuccess = JSON.parse(
        await readFile(
          join(root, ".harness", "runtime", "sync", "last-success.json"),
          "utf8"
        )
      ) as { runId: string; status: string };
      expect(lastRun.runId).toBe(payload.runId);
      expect(lastSuccess.runId).toBe(payload.runId);
      expect(lastRun.status).toBe(payload.status);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
