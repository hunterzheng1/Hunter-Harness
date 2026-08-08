import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  adapterAgentForRemediation,
  buildCompactSyncResult,
  buildSyncRemediations,
  buildPromoteCandidates,
  deriveSyncWritePolicy,
  persistSyncPointers,
  probeCodeGraph,
  runProcess,
  summarizePartialEffects
} from "../src/commands/sync.js";

describe("sync bounded process runner", () => {
  it("maps adapter remediation ids to one exact projection owner", () => {
    expect(adapterAgentForRemediation("refresh-managed-adapters-agents")).toBe("codex");
    expect(adapterAgentForRemediation("refresh-managed-adapters-claude")).toBe("claude-code");
    expect(adapterAgentForRemediation("refresh-managed-adapters-cursor")).toBe("cursor");
    expect(adapterAgentForRemediation("refresh-managed-adapters-codebuddy")).toBe("codebuddy");
    expect(adapterAgentForRemediation("refresh-managed-adapters-unknown")).toBeNull();
  });

  it("isolates targeted remediation writes from unrelated components", () => {
    expect(deriveSyncWritePolicy({}, true)).toEqual({
      adapterReadOnly: true
    });
    expect(deriveSyncWritePolicy(
      { fix: "refresh-managed-adapters-cursor" },
      false
    )).toEqual({
      adapterReadOnly: false
    });
    expect(deriveSyncWritePolicy({}, false)).toEqual({
      adapterReadOnly: false
    });
  });

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
          // Windows process startup can exceed 80 ms when the full suite is
          // contending for CPU. Keep the timeout relationship under test while
          // leaving enough time for the child's initial activity to arrive.
          wallTimeoutMs: 3000,
          stallTimeoutMs: 500,
          heartbeatMs: 50,
          terminateGraceMs: 100
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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("HH-ADAPTER-20260730-001 groups identical local adapter patches into one promotion proposal", () => {
    const candidates = buildPromoteCandidates([
      {
        source_path: "skills/harness-sync/SKILL.md",
        target_path: ".claude/skills/harness-sync/SKILL.md",
        adapter_content_sha256: "a".repeat(64)
      },
      {
        source_path: "skills/harness-sync/SKILL.md",
        target_path: ".cursor/skills/harness-sync/SKILL.md",
        adapter_content_sha256: "a".repeat(64)
      }
    ]);
    expect(candidates).toEqual([
      expect.objectContaining({
        patchHash: "a".repeat(64),
        adapterTargets: [
          ".claude/skills/harness-sync/SKILL.md",
          ".cursor/skills/harness-sync/SKILL.md"
        ],
        proposal: expect.objectContaining({ status: "PROPOSED" })
      })
    ]);
    expect(candidates[0]?.proposal.steps.join(" ")).toContain("harness/");
  });

  it("aggregates systematic adapter drift into one actionable remediation", () => {
    const conflicts = Array.from({ length: 100 }, (_, index) => ({
      source_path: `harness/example/file-${index}.md`,
      target_path: `.cursor/skills/example/file-${index}.md`,
      baseline_content_sha256: "b".repeat(64),
      adapter_content_sha256: "a".repeat(64)
    }));

    const remediations = buildSyncRemediations([
      {
        component: "adapter-projection",
        status: "WARN",
        reasonCode: "ADAPTER_PROJECTION_CONFLICT",
        observedAt: "2026-07-31T00:00:00.000Z",
        durationMs: 1,
        inputHash: null,
        outputHash: null,
        evidence: [],
        autoFixed: false,
        nextAction: "review",
        details: { conflicts }
      }
    ]);

    expect(remediations).toHaveLength(1);
    expect(remediations[0]).toMatchObject({
      id: "refresh-managed-adapters-cursor",
      component: "adapter-projection",
      risk: "medium",
      autoFixable: true,
      requiresConfirmation: true,
      affectedCount: 100
    });
  });

  it("keeps default JSON compact and exposes receipts only in verbose mode", () => {
    const components = [
      {
        component: "knowledge",
        status: "OK" as const,
        reasonCode: "OK",
        observedAt: "2026-07-31T00:00:00.000Z",
        durationMs: 1,
        inputHash: null,
        outputHash: null,
        evidence: [],
        autoFixed: false,
        nextAction: null,
        details: { payload: { veryLarge: true } }
      }
    ];
    const compact = buildCompactSyncResult({
      status: "OK",
      runId: "run",
      components,
      remediations: [],
      versions: {
        cliVersion: "0.2.44",
        workflowBundleVersion: "0.2.31",
        adapterBundleVersions: {}
      },
      reportPath: "report.json",
      reportSha256: "a".repeat(64),
      verbose: false
    });
    const verbose = buildCompactSyncResult({
      status: "OK",
      runId: "run",
      components,
      remediations: [],
      versions: {
        cliVersion: "0.2.44",
        workflowBundleVersion: "0.2.31",
        adapterBundleVersions: {}
      },
      reportPath: "report.json",
      reportSha256: "a".repeat(64),
      verbose: true
    });

    expect(compact).not.toHaveProperty("componentOutcomes");
    expect(verbose).toHaveProperty("componentOutcomes", components);
  });

  it("HH-UX-20260730-001 reports effects that persisted before a failure", () => {
    const partial = summarizePartialEffects([
      {
        component: "adapter-projection",
        status: "OK",
        reasonCode: "OK",
        observedAt: "2026-07-30T00:00:00.000Z",
        durationMs: 1,
        inputHash: null,
        outputHash: null,
        evidence: [],
        autoFixed: false,
        nextAction: null,
        effects: { persisted: ["adapter projection applied 1 change(s)"], notPersisted: [] }
      },
      {
        component: "knowledge",
        status: "FAIL",
        reasonCode: "KNOWLEDGE_REMOTE_UNAVAILABLE",
        observedAt: "2026-07-30T00:00:00.000Z",
        durationMs: 1,
        inputHash: null,
        outputHash: null,
        evidence: [],
        autoFixed: false,
        nextAction: "Retry sync",
        effects: { persisted: [], notPersisted: ["remote knowledge was unavailable; no local fallback"] }
      }
    ]);
    expect(partial.persisted).toEqual(["adapter projection applied 1 change(s)"]);
    expect(partial.notPersisted).toEqual(["remote knowledge was unavailable; no local fallback"]);
    expect(partial.summary).toContain("Durable effects already persisted");
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
