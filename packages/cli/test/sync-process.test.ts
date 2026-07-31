import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  adapterAgentForRemediation,
  buildCompactSyncResult,
  buildSyncRemediations,
  buildPromoteCandidates,
  classifyKnowledgeResult,
  deriveKnowledgeOutputValid,
  deriveSyncWritePolicy,
  persistSyncPointers,
  probeCodeGraph,
  resolveKnowledgeNextAction,
  runProcess,
  shouldApplyKnowledgeMaintenance,
  summarizePartialEffects
} from "../src/commands/sync.js";

function okProcessResult(stdout: string): Parameters<typeof classifyKnowledgeResult>[0] {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    startedAt: "2026-07-30T00:00:00.000Z",
    completedAt: "2026-07-30T00:00:01.000Z",
    durationMs: 1000,
    lastActivityAt: "2026-07-30T00:00:01.000Z",
    timedOut: false,
    timeoutKind: null,
    termination: "exited",
    signal: null,
    heartbeatCount: 0,
    stdoutTruncated: false,
    stderrTruncated: false
  };
}

describe("sync bounded process runner", () => {
  it("maps adapter remediation ids to one exact projection owner", () => {
    expect(adapterAgentForRemediation("refresh-managed-adapters-agents")).toBe("codex");
    expect(adapterAgentForRemediation("refresh-managed-adapters-claude")).toBe("claude-code");
    expect(adapterAgentForRemediation("refresh-managed-adapters-cursor")).toBe("cursor");
    expect(adapterAgentForRemediation("refresh-managed-adapters-codebuddy")).toBe("codebuddy");
    expect(adapterAgentForRemediation("refresh-managed-adapters-unknown")).toBeNull();
  });

  it("keeps remediation previews read-only even when a fix id is supplied", () => {
    expect(shouldApplyKnowledgeMaintenance(
      { fix: "knowledge-maintain" },
      true
    )).toBe(false);
    expect(shouldApplyKnowledgeMaintenance(
      { apply: "safe" },
      true
    )).toBe(false);
    expect(shouldApplyKnowledgeMaintenance(
      { apply: "safe" },
      false
    )).toBe(true);
  });

  it("isolates targeted remediation writes from unrelated components", () => {
    expect(deriveSyncWritePolicy({}, true)).toEqual({
      adapterReadOnly: true,
      knowledgeMode: "check",
      rulesReadOnly: true
    });
    expect(deriveSyncWritePolicy(
      { fix: "refresh-managed-adapters-cursor" },
      false
    )).toEqual({
      adapterReadOnly: false,
      knowledgeMode: "check",
      rulesReadOnly: true
    });
    expect(deriveSyncWritePolicy(
      { fix: "knowledge-maintain" },
      false
    )).toEqual({
      adapterReadOnly: true,
      knowledgeMode: "auto",
      rulesReadOnly: true
    });
    expect(deriveSyncWritePolicy({}, false)).toEqual({
      adapterReadOnly: false,
      knowledgeMode: "update",
      rulesReadOnly: false
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

  it("HH-KNOW-20260730-001 treats sync_status ok:true as valid output", () => {
    const payload = { ok: true, upToDate: true, maintenance: { attempted: true, ok: true } };
    expect(deriveKnowledgeOutputValid(payload)).toBe(true);
    expect(classifyKnowledgeResult(okProcessResult(JSON.stringify(payload)), true, payload))
      .toEqual({ status: "OK", reasonCode: "OK" });
  });

  it("reports knowledge health separately from freshness", () => {
    const payload = {
      ok: true,
      upToDate: true,
      freshness: {
        status: "OK",
        archivesScanned: 5,
        archivesIndexed: 5,
        headCurrent: true
      },
      health: {
        status: "WARN",
        contentLifecycle: { active: 0, candidate: 52, conflicted: 2 },
        reviewState: { pending: 0, deferred: 54, decided: 0 },
        publicationState: { publishable: 42, blocked: 108, unverified: 0 },
        validationState: { covered: 27, uncovered: 123, failed: 0 },
        duplicateGroups: 64
      }
    };

    expect(deriveKnowledgeOutputValid(payload)).toBe(true);
    expect(classifyKnowledgeResult(okProcessResult(JSON.stringify(payload)), true, payload))
      .toEqual({ status: "WARN", reasonCode: "KNOWLEDGE_HEALTH_WARN" });
  });

  it("HH-KNOW-20260730-001 flags an un-drained maintenance outbox as WARN with a next action", () => {
    const payload = {
      ok: false,
      upToDate: true,
      reasons: [],
      maintenance: {
        attempted: true,
        skipped: false,
        ok: false,
        processed: 1,
        remaining: 1,
        results: [{ ok: false, archiveId: "2026-07-30-example", status: "failed" }]
      },
      nextAction: "Retry `hunter-harness sync` to drain the maintenance outbox."
    };
    expect(deriveKnowledgeOutputValid(payload)).toBe(false);
    const outcome = classifyKnowledgeResult(okProcessResult(JSON.stringify(payload)), false, payload);
    expect(outcome).toEqual({ status: "WARN", reasonCode: "KNOWLEDGE_OUTBOX_PENDING" });
    const nextAction = resolveKnowledgeNextAction(outcome.status, outcome.reasonCode, payload);
    expect(nextAction).toBe(payload.nextAction);
  });

  it("HH-KNOW-20260730-001 falls back to a generic next action when the payload omits one", () => {
    const payload = {
      ok: false,
      upToDate: true,
      maintenance: { attempted: true, skipped: false, ok: false, processed: 0, remaining: 3 }
    };
    const outcome = classifyKnowledgeResult(okProcessResult(JSON.stringify(payload)), false, payload);
    expect(outcome.status).toBe("WARN");
    expect(outcome.reasonCode).toBe("KNOWLEDGE_OUTBOX_PENDING");
    const nextAction = resolveKnowledgeNextAction(outcome.status, outcome.reasonCode, payload);
    expect(nextAction).toBeTruthy();
    expect(nextAction).toMatch(/harness_knowledge\.py maintain .*--drain/);
  });

  it("HH-KNOW-20260730-001 treats a stale index (maintenance skipped) as unverified, not outbox-pending", () => {
    const payload = {
      ok: false,
      upToDate: false,
      reasons: ["archive added: .harness/archive/2026-07-30-example"],
      maintenance: { attempted: false, skipped: true, ok: true, pending: 0, failed: 0 }
    };
    expect(deriveKnowledgeOutputValid(payload)).toBe(false);
    const outcome = classifyKnowledgeResult(okProcessResult(JSON.stringify(payload)), false, payload);
    expect(outcome).toEqual({ status: "WARN", reasonCode: "KNOWLEDGE_OUTPUT_UNVERIFIED" });
    expect(resolveKnowledgeNextAction(outcome.status, outcome.reasonCode, payload)).toBeTruthy();
  });

  it("resolveKnowledgeNextAction returns null on OK status", () => {
    expect(resolveKnowledgeNextAction("OK", "OK", { ok: true })).toBeNull();
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
        reasonCode: "KNOWLEDGE_SYNC_FAILED",
        observedAt: "2026-07-30T00:00:00.000Z",
        durationMs: 1,
        inputHash: null,
        outputHash: null,
        evidence: [],
        autoFixed: false,
        nextAction: "Retry sync",
        effects: { persisted: [], notPersisted: ["knowledge output was not verified"] }
      }
    ]);
    expect(partial.persisted).toEqual(["adapter projection applied 1 change(s)"]);
    expect(partial.notPersisted).toEqual(["knowledge output was not verified"]);
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
