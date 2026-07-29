import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  classifyKnowledgeResult,
  persistSyncPointers,
  probeCodeGraph,
  runProcess
} from "../src/commands/sync.js";

describe("sync bounded process runner", () => {
  it("SYNC-004 reports typed wall-timeout and termination evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-sync-process-"));
    try {
      const result = await runProcess(
        [process.execPath, "-e", "setInterval(() => undefined, 1000)"],
        root,
        {},
        () => undefined,
        80
      );
      const typed = result as typeof result & {
        timedOut: boolean;
        timeoutKind: "wall" | "stall" | null;
        termination: string;
        durationMs: number;
        heartbeatCount: number;
      };
      expect(typed.timedOut).toBe(true);
      expect(typed.timeoutKind).toBe("wall");
      expect(typed.termination).toMatch(/terminated|killed/);
      expect(typed.durationMs).toBeGreaterThanOrEqual(50);
      expect(typed.heartbeatCount).toBeGreaterThanOrEqual(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("SYNC-005 distinguishes stall timeout from wall timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-sync-stall-"));
    try {
      const result = await runProcess(
        [
          process.execPath,
          "-e",
          "process.stdout.write('ready'); setInterval(() => undefined, 1000)"
        ],
        root,
        {},
        () => undefined,
        {
          wallTimeoutMs: 1000,
          stallTimeoutMs: 80,
          heartbeatMs: 20,
          terminateGraceMs: 20
        }
      );
      expect(result.timedOut).toBe(true);
      expect(result.timeoutKind).toBe("stall");
      expect(Date.parse(result.lastActivityAt)).toBeGreaterThan(
        Date.parse(result.startedAt)
      );
      expect(Date.parse(result.lastActivityAt)).toBeLessThanOrEqual(
        Date.parse(result.completedAt)
      );
      expect(result.heartbeatCount).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("SYNC-006 preserves last-success when a later run fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-sync-pointers-"));
    try {
      const success = {
        schemaVersion: 1 as const,
        runId: "success",
        status: "OK" as const,
        completedAt: "2026-07-29T10:00:00.000Z",
        reportPath: "success.json",
        reportSha256: "a".repeat(64),
        headCommit: "head-a"
      };
      const failure = {
        ...success,
        runId: "failure",
        status: "FAIL" as const,
        reportPath: "failure.json",
        reportSha256: "b".repeat(64),
        headCommit: "head-b"
      };
      await persistSyncPointers(root, success, true);
      await persistSyncPointers(root, failure, false);
      const directory = join(root, ".harness", "runtime", "sync");
      const lastRun = JSON.parse(
        await readFile(join(directory, "last-run.json"), "utf8")
      ) as { runId: string };
      const lastSuccess = JSON.parse(
        await readFile(join(directory, "last-success.json"), "utf8")
      ) as { runId: string };
      expect(lastRun.runId).toBe("failure");
      expect(lastSuccess.runId).toBe("success");
      expect(classifyKnowledgeResult(
        {
          exitCode: 124,
          stdout: "{}",
          stderr: "",
          startedAt: success.completedAt,
          completedAt: success.completedAt,
          durationMs: 1,
          lastActivityAt: success.completedAt,
          timedOut: true,
          timeoutKind: "wall",
          termination: "terminated",
          signal: null,
          heartbeatCount: 0,
          stdoutTruncated: false,
          stderrTruncated: false
        },
        true
      )).toEqual({
        status: "WARN",
        reasonCode: "KNOWLEDGE_SYNC_TIMEOUT_OUTPUT_VALID"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("SYNC-007 probes CodeGraph metadata instead of returning a constant", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-sync-codegraph-"));
    try {
      await mkdir(join(root, ".codegraph"), { recursive: true });
      await writeFile(join(root, ".codegraph", "index.sqlite"), "sqlite");
      await writeFile(
        join(root, ".codegraph", "status.json"),
        JSON.stringify({
          indexedHead: "head",
          pendingFileCount: 0,
          watcherLagMs: 12
        })
      );
      const probe = await probeCodeGraph(root, "head");
      expect(probe.status).toBe("OK");
      expect(probe.reasonCode).toBe("OK");
      expect(probe.details).toMatchObject({
        indexPresent: true,
        indexedCommit: "head",
        pendingFileCount: 0,
        coverage: "CURRENT"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
