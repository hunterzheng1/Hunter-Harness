import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  classifyPlan,
  configurePlannedPhases,
  type PlanCapabilities,
  type PlannedPhaseSet
} from "../src/plan-classification/index.js";
import {
  ArchiveEngineError,
  createArchiveEngine,
  InMemoryArchivePort,
  normalizeArchiveRecord,
  type ArchiveChangeRef,
  type ClosurePolicy
} from "../src/archive-engine/index.js";

const sha = (value: string): `sha256:${string}` =>
  `sha256:${value.repeat(64)}`;
const completedAt = "2026-08-13T08:00:00.000Z";

function phaseSet(): PlannedPhaseSet {
  const profile = classifyPlan({
    schema_version: 1,
    change_id: "archive-engine-change",
    risk_signals: ["narrow_fix"],
    created_at: completedAt
  });
  const capabilities: PlanCapabilities = {
    schema_version: 1,
    is_git: true,
    has_remote: true,
    uses_worktree: false,
    available_phases: [
      "plan", "run", "test", "review", "package", "apidoc", "submit", "merge", "archive"
    ],
    requested_optional_phases: [],
    requested_omissions: [],
    configured_at: completedAt
  };
  return configurePlannedPhases(profile, capabilities);
}

function change(overrides: Partial<ArchiveChangeRef> = {}): ArchiveChangeRef {
  return {
    schema_version: 1,
    change_identity: "project-1/change-1",
    archive_schema_version: 1,
    archive_path: ".harness/archive/2026-08-13-change-1",
    ...overrides
  };
}

function completedPolicy(
  archive_intent: ClosurePolicy["archive_intent"] = "record_only",
  overrides: Partial<ClosurePolicy> = {}
): ClosurePolicy {
  return {
    schema_version: 1,
    disposition: "completed",
    archive_intent,
    planned_phase_set_ref: phaseSet(),
    available_evidence: {
      phase_terminals: [
        { phase: "plan", status: "passed", evidence_hash: sha("2") },
        { phase: "run", status: "passed", evidence_hash: sha("3") },
        { phase: "test", status: "not_run" }
      ]
    },
    ...overrides
  };
}

function port(): InMemoryArchivePort {
  return new InMemoryArchivePort({
    changes: [{
      change_identity: change().change_identity,
      files: [
        { path: "spec/goal.md", content: "# Goal\nShip the feature.\n" },
        { path: "plans/implementation.md", content: "# Plan\nImplement it.\n" },
        { path: ".env.production", content: "TOKEN=not-for-archive\n" },
        { path: "nested/credentials.local.yaml", content: "token: secret\n" }
      ]
    }]
  });
}

function engine(localPort = port()) {
  return {
    localPort,
    archive: createArchiveEngine({
      port: localPort,
      clock: () => new Date(completedAt),
      owner_id: "archive-worker-1",
      lease_ms: 30_000
    })
  };
}

describe("ArchiveEngine v1 closure policy", () => {
  it("uses only planned_phases and records evidence for an unplanned phase as not_run", async () => {
    const { archive } = engine();
    const plan = await archive.prepareArchive(change(), completedPolicy());

    expect(plan.blockers).toEqual([]);
    expect(plan.planned_phase_set_ref?.planned_phases).toEqual(["plan", "run", "archive"]);
    expect(plan.phase_outcomes).toEqual([
      { phase: "plan", status: "passed", evidence_hash: sha("2") },
      { phase: "run", status: "passed", evidence_hash: sha("3") },
      { phase: "test", status: "not_run" }
    ]);
    expect(plan.phase_outcomes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "review" }),
      expect.objectContaining({ phase: "submit" })
    ]));
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.phase_outcomes)).toBe(true);
  });

  it("blocks a completed record-only archive when a planned phase has no terminal", async () => {
    const { archive } = engine();
    const plan = await archive.prepareArchive(change(), completedPolicy("record_only", {
      available_evidence: {
        phase_terminals: [{ phase: "plan", status: "passed", evidence_hash: sha("2") }]
      }
    }));

    expect(plan.blockers).toEqual([expect.objectContaining({
      reason_code: "PLANNED_PHASE_TERMINAL_MISSING",
      classification: "auto_fixable",
      phase: "run"
    })]);
  });

  it.each([
    { planned_phase_set_id: "planned_phase_set:one", planned_phase_set_hash: sha("1"), planned_phases: ["plan", "run"] },
    { ...phaseSet(), phase_set_id: `planned_phase_set:${"f".repeat(64)}` },
    { ...phaseSet(), outcome: "not_publishable", reason_code: "required_phase_omission_rejected" }
  ])("rejects a weak or forged planned phase set reference", async (planned_phase_set_ref) => {
    const { archive } = engine();
    await expect(archive.prepareArchive(change(), completedPolicy("record_only", {
      planned_phase_set_ref: planned_phase_set_ref as PlannedPhaseSet
    }))).rejects.toMatchObject({
      code: "ARCHIVE_INPUT_INVALID",
      classification: "irrecoverable"
    });
  });

  it("requires every release proof and never silently downgrades release_candidate", async () => {
    const { archive } = engine();
    const plan = await archive.prepareArchive(change(), completedPolicy("release_candidate", {
      available_evidence: {
        phase_terminals: [
          { phase: "plan", status: "passed", evidence_hash: sha("2") },
          { phase: "run", status: "passed", evidence_hash: sha("3") }
        ],
        release: {
          git_repository: true,
          upstream_configured: false,
          source_committed: true,
          source_pushed: false,
          ci_passed: false,
          candidate_verified: false
        }
      }
    }));

    expect(plan.archive_intent).toBe("release_candidate");
    expect(plan.blockers.map((item) => item.reason_code)).toEqual([
      "RELEASE_UPSTREAM_REQUIRED",
      "RELEASE_PUSH_REQUIRED",
      "RELEASE_CI_REQUIRED",
      "RELEASE_CANDIDATE_PROOF_REQUIRED"
    ]);
    expect(plan.blockers.every((item) => item.classification === "release_only"))
      .toBe(true);
    await expect(archive.finalizeLocalArchive(plan)).rejects.toMatchObject({
      code: "ARCHIVE_PLAN_BLOCKED",
      classification: "release_only"
    });
  });

  it("accepts a strict completed release candidate only with full proof", async () => {
    const { archive } = engine();
    const plan = await archive.prepareArchive(change(), completedPolicy("release_candidate", {
      available_evidence: {
        phase_terminals: [
          { phase: "plan", status: "passed", evidence_hash: sha("2") },
          { phase: "run", status: "passed", evidence_hash: sha("3") }
        ],
        release: {
          git_repository: true,
          upstream_configured: true,
          source_committed: true,
          source_pushed: true,
          ci_passed: true,
          candidate_verified: true
        }
      }
    }));
    expect(plan.blockers).toEqual([]);
  });

  it("allows completed record-only without Git, upstream, push, CI, or candidate proof", async () => {
    const { archive } = engine();
    const plan = await archive.prepareArchive(change(), completedPolicy("record_only", {
      available_evidence: {
        phase_terminals: [
          { phase: "plan", status: "passed", evidence_hash: sha("2") },
          { phase: "run", status: "failed", evidence_hash: sha("3") }
        ],
        release: {
          git_repository: false,
          upstream_configured: false,
          source_committed: false,
          source_pushed: false,
          ci_passed: false,
          candidate_verified: false
        }
      }
    }));
    expect(plan.blockers).toEqual([]);
    expect(plan.archive_intent).toBe("record_only");
  });

  it("requires any reported unplanned phase to remain not_run", async () => {
    const { archive } = engine();
    const plan = await archive.prepareArchive(change(), completedPolicy("record_only", {
      available_evidence: {
        phase_terminals: [
          { phase: "plan", status: "passed", evidence_hash: sha("2") },
          { phase: "run", status: "passed", evidence_hash: sha("3") },
          { phase: "review", status: "passed", evidence_hash: sha("4") }
        ]
      }
    }));
    expect(plan.blockers).toContainEqual(expect.objectContaining({
      reason_code: "UNPLANNED_PHASE_MUST_BE_NOT_RUN",
      classification: "auto_fixable",
      phase: "review"
    }));
  });

  it.each([
    ["abandoned", "用户终止了本次变更", undefined],
    ["superseded", "", "project-1/change-2"],
    ["superseded", "由后续变更替代", undefined]
  ] as const)("allows %s record-only with minimum terminal facts", async (
    disposition,
    termination_reason_zh,
    superseded_by
  ) => {
    const { archive } = engine();
    const plan = await archive.prepareArchive(change(), {
      schema_version: 1,
      disposition,
      archive_intent: "record_only",
      available_evidence: {
        phase_terminals: [],
        ...(termination_reason_zh === "" ? {} : { termination_reason_zh }),
        ...(superseded_by === undefined ? {} : { superseded_by })
      }
    });
    expect(plan.blockers).toEqual([]);
  });

  it("rejects release intent for unfinished closure and classifies missing reasons", async () => {
    const { archive } = engine();
    const release = await archive.prepareArchive(change(), {
      schema_version: 1,
      disposition: "abandoned",
      archive_intent: "release_candidate",
      available_evidence: { phase_terminals: [], termination_reason_zh: "用户终止" }
    });
    expect(release.blockers).toContainEqual(expect.objectContaining({
      reason_code: "UNFINISHED_RELEASE_INTENT_FORBIDDEN",
      classification: "user_choice"
    }));

    const missing = await archive.prepareArchive(change(), {
      schema_version: 1,
      disposition: "abandoned",
      archive_intent: "record_only",
      available_evidence: { phase_terminals: [] }
    });
    expect(missing.blockers).toContainEqual(expect.objectContaining({
      reason_code: "TERMINATION_REASON_REQUIRED",
      classification: "user_choice"
    }));
  });
});

describe("ArchiveEngine v1 local transaction", () => {
  it("builds one inventory and reuses it for budget, summary, manifest and staging", async () => {
    const { archive, localPort } = engine();
    const plan = await archive.prepareArchive(change(), completedPolicy());
    expect(localPort.read_counts.get(change().change_identity)).toBe(1);
    expect(plan.included_items.map((item) => item.path)).toEqual([
      "plans/implementation.md",
      "spec/goal.md"
    ]);
    expect(plan.excluded_items.map((item) => item.reason_code)).toEqual([
      "ARCHIVE_ENV_PATH_EXCLUDED",
      "ARCHIVE_CREDENTIAL_PATH_EXCLUDED"
    ]);

    const receipt = await archive.finalizeLocalArchive(plan);
    expect(localPort.read_counts.get(change().change_identity)).toBe(2);
    expect(localPort.stage_write_counts.get(plan.operation_id)).toBe(1);
    expect(receipt).toMatchObject({
      schema_version: 1,
      operation_id: plan.operation_id,
      change_identity: change().change_identity,
      closure_disposition: "completed",
      archive_intent: "record_only",
      source_snapshot_hash: plan.source_snapshot_hash,
      archive_schema_version: 1,
      archive_path: change().archive_path,
      completed_at: completedAt
    });
    expect(localPort.network_calls).toBe(0);
    expect(localPort.model_calls).toBe(0);
    expect(localPort.terminal_events).toHaveLength(1);

    const files = localPort.archives.get(change().archive_path)?.files;
    expect(files?.has("summary/change-summary.json")).toBe(true);
    expect(files?.has("attestations/verification.json")).toBe(true);
    expect(files?.has("archive-meta.json")).toBe(true);
    expect(files?.has("archive-manifest.json")).toBe(true);
    expect(files?.has(".env.production")).toBe(false);
    const manifestPayload = files?.get("archive-manifest.json");
    expect(manifestPayload).toBeDefined();
    const manifestHash = `sha256:${(await import("node:crypto")).createHash("sha256")
      .update(manifestPayload ?? new Uint8Array()).digest("hex")}`;
    expect(receipt.archive_manifest_hash).toBe(manifestHash);
    const manifest = JSON.parse(new TextDecoder().decode(manifestPayload)) as {
      files: Array<{ path: string; content_hash: string; size_bytes: number }>;
    };
    for (const entry of manifest.files) {
      const payload = files?.get(entry.path);
      expect(payload, entry.path).toBeDefined();
      expect(entry.size_bytes).toBe(payload?.byteLength);
      expect(entry.content_hash).toBe(
        `sha256:${(await import("node:crypto")).createHash("sha256")
          .update(payload ?? new Uint8Array()).digest("hex")}`
      );
    }
  });

  it("derives operation identity only from change, source snapshot, and schema", async () => {
    const { archive } = engine();
    const first = await archive.prepareArchive(change(), completedPolicy());
    const changedPolicy = await archive.prepareArchive(change(), completedPolicy("record_only", {
      available_evidence: {
        phase_terminals: [
          { phase: "plan", status: "warning", evidence_hash: sha("2") },
          { phase: "run", status: "passed", evidence_hash: sha("3") }
        ]
      }
    }));
    expect(first.operation_id).toBe(changedPolicy.operation_id);
    expect(first.closure_policy_hash).not.toBe(changedPolicy.closure_policy_hash);
  });

  it("rejects a stale plan before staging when source input drifts", async () => {
    const { archive, localPort } = engine();
    const plan = await archive.prepareArchive(change(), completedPolicy());
    localPort.setChange(change().change_identity, [
      { path: "spec/goal.md", content: "changed after confirmation\n" }
    ]);

    await expect(archive.finalizeLocalArchive(plan)).rejects.toMatchObject({
      code: "ARCHIVE_PLAN_STALE",
      classification: "user_choice"
    });
    expect(localPort.stage_write_counts.get(plan.operation_id) ?? 0).toBe(0);
    expect(localPort.archives.size).toBe(0);
  });

  it("returns the immutable receipt for the same finalized input", async () => {
    const { archive, localPort } = engine();
    const plan = await archive.prepareArchive(change(), completedPolicy());
    const first = await archive.finalizeLocalArchive(plan);
    const second = await archive.finalizeLocalArchive(plan);

    expect(second).toEqual(first);
    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(localPort.operations.get(plan.operation_id)?.completed_at).toBe(first.completed_at);
    const completed = localPort.operations.get(plan.operation_id);
    expect(completed).toBeDefined();
    if (completed === undefined) throw new Error("completed operation must exist");
    await expect(localPort.saveOperation({
      ...completed,
      completed_at: "2026-08-13T09:00:00.000Z"
    })).rejects.toMatchObject({ code: "ARCHIVE_IMMUTABLE_CONFLICT" });
    expect(localPort.stage_write_counts.get(plan.operation_id)).toBe(1);
    expect(localPort.terminal_events).toHaveLength(1);
  });

  it("keeps a completed operation intact when prepare is repeated with identical input", async () => {
    const { archive, localPort } = engine();
    const firstPlan = await archive.prepareArchive(change(), completedPolicy());
    const firstReceipt = await archive.finalizeLocalArchive(firstPlan);
    const repeatedPlan = await archive.prepareArchive(change(), completedPolicy());
    const repeatedReceipt = await archive.finalizeLocalArchive(repeatedPlan);

    expect(repeatedPlan).toBe(firstPlan);
    expect(repeatedReceipt).toBe(firstReceipt);
    expect(localPort.stage_write_counts.get(firstPlan.operation_id)).toBe(1);
    expect(localPort.terminal_events).toHaveLength(1);
  });

  it.each([
    ["operation_id", `archive_operation:${"f".repeat(64)}`],
    ["change_identity", "project-2/change-1"],
    ["closure_disposition", "abandoned"],
    ["archive_intent", "release_candidate"],
    ["source_snapshot_hash", sha("d")],
    ["archive_schema_version", 2],
    ["archive_path", ".harness/archive/other"],
    ["archive_manifest_hash", sha("e")],
    ["completed_at", "2026-08-13T09:00:00.000Z"]
  ] as const)("rejects a cached receipt with mismatched %s", async (field, value) => {
    const { archive, localPort } = engine();
    const plan = await archive.prepareArchive(change(), completedPolicy());
    const receipt = await archive.finalizeLocalArchive(plan);
    localPort.receipts.set(plan.operation_id, { ...receipt, [field]: value });

    await expect(archive.resumeArchive(plan.operation_id)).rejects.toMatchObject({
      code: "ARCHIVE_IMMUTABLE_CONFLICT",
      classification: "irrecoverable"
    });
  });

  it.each(["after_stage", "after_publish", "after_receipt"] as const)(
    "resumes idempotently after %s crash",
    async (step) => {
      const { archive, localPort } = engine();
      const plan = await archive.prepareArchive(change(), completedPolicy());
      localPort.injectCrash(step);
      await expect(archive.finalizeLocalArchive(plan)).rejects.toBeInstanceOf(Error);

      const receipt = await archive.resumeArchive(plan.operation_id);
      const repeated = await archive.resumeArchive(plan.operation_id);
      expect(repeated).toEqual(receipt);
      expect(localPort.archives.size).toBe(1);
      expect(localPort.receipts.size).toBe(1);
      expect(localPort.terminal_events).toHaveLength(1);
      expect(localPort.quiesce_counts.get(change().change_identity)).toBe(1);
      expect(localPort.read_counts.get(change().change_identity)).toBe(2);
    }
  );

  it("rejects tampered staged bytes even when cached summary and manifest hash are unchanged", async () => {
    const { archive, localPort } = engine();
    const plan = await archive.prepareArchive(change(), completedPolicy());
    localPort.injectCrash("after_stage");
    await expect(archive.finalizeLocalArchive(plan)).rejects.toThrow("injected crash");
    const stage = localPort.stages.get(plan.operation_id);
    expect(stage).toBeDefined();
    stage?.files.set("spec/goal.md", new TextEncoder().encode("tampered bytes\n"));

    await expect(archive.resumeArchive(plan.operation_id)).rejects.toMatchObject({
      code: "ARCHIVE_STAGE_INVALID",
      classification: "irrecoverable"
    });
    expect(localPort.archives.size).toBe(0);
  });

  it("rejects a published archive when its files no longer close over its manifest", async () => {
    const { archive, localPort } = engine();
    const plan = await archive.prepareArchive(change(), completedPolicy());
    const receipt = await archive.finalizeLocalArchive(plan);
    localPort.archives.get(receipt.archive_path)?.files.set(
      "spec/goal.md", new TextEncoder().encode("tampered after publish\n")
    );

    await expect(archive.resumeArchive(plan.operation_id)).rejects.toMatchObject({
      code: "ARCHIVE_IMMUTABLE_CONFLICT",
      classification: "irrecoverable"
    });
  });

  it.each([
    "summary/change-summary.json",
    "attestations/verification.json",
    "archive-meta.json",
    "archive-manifest.json"
  ])("fails before staging when source collides with generated path %s", async (path) => {
    const localPort = port();
    localPort.setChange(change().change_identity, [{ path, content: "user bytes" }]);
    const archive = createArchiveEngine({
      port: localPort,
      clock: () => new Date(completedAt),
      owner_id: "archive-worker-1"
    });
    await expect(archive.prepareArchive(change(), completedPolicy())).rejects.toMatchObject({
      code: "ARCHIVE_PATH_INVALID",
      classification: "irrecoverable"
    });
    expect(localPort.stages.size).toBe(0);
  });

  it.each([
    ["Archive-Manifest.json", "archive-manifest.json"],
    ["ARCHIVE-META.JSON", "archive-meta.json"],
    ["docs/Caf\u00e9.md", "docs/Cafe\u0301.md"],
    ["docs/Readme.md", "docs/README.md"]
  ])("rejects NFC/case-fold source collisions between %s and %s", async (first, second) => {
    const localPort = port();
    localPort.setChange(change().change_identity, [
      { path: first, content: "first" },
      { path: second, content: "second" }
    ]);
    const archive = createArchiveEngine({ port: localPort, owner_id: "archive-worker-1" });
    await expect(archive.prepareArchive(change(), completedPolicy())).rejects.toMatchObject({
      code: "ARCHIVE_PATH_INVALID",
      classification: "irrecoverable"
    });
  });

  it("reconciles an expired orphan operation as recoverable and validates identity", async () => {
    const { archive, localPort } = engine();
    const plan = await archive.prepareArchive(change(), completedPolicy());
    localPort.expireOperation(plan.operation_id);
    localPort.setOwnerActive("archive-worker-1", false);

    const result = await archive.reconcileArchive(change().change_identity);
    expect(result).toMatchObject({
      schema_version: 1,
      change_identity: change().change_identity,
      status: "recoverable"
    });
    expect(result.operations).toContainEqual(expect.objectContaining({
      operation_id: plan.operation_id,
      suggested_action: "resume"
    }));
  });

  it("fails closed when a published archive has the operation identity but wrong hash", async () => {
    const { archive, localPort } = engine();
    const plan = await archive.prepareArchive(change(), completedPolicy());
    localPort.seedMismatchedArchive(plan.operation_id, change().archive_path, sha("f"));
    await expect(archive.resumeArchive(plan.operation_id)).rejects.toMatchObject({
      code: "ARCHIVE_IMMUTABLE_CONFLICT",
      classification: "irrecoverable"
    });
  });

  it("exposes stable error fields without depending on Chinese text", () => {
    const error = new ArchiveEngineError(
      "ARCHIVE_PLAN_STALE",
      "user_choice",
      "输入已变化，请重新确认归档计划",
      true
    );
    expect(error).toMatchObject({
      code: "ARCHIVE_PLAN_STALE",
      classification: "user_choice",
      retryable: true
    });
  });
});

describe("ArchiveEngine v1 compatibility", () => {
  it("reads a current receipt fixture as ready", async () => {
    const fixture = JSON.parse(await readFile(
      new URL("./fixtures/archive-engine-v1-current.json", import.meta.url), "utf8"
    )) as unknown;
    expect(normalizeArchiveRecord(fixture)).toMatchObject({
      ok: true,
      source_schema_version: 1,
      readiness: "ready"
    });
  });

  it("projects legacy v0 without inventing operation identity or release evidence", async () => {
    const fixture = JSON.parse(await readFile(
      new URL("./fixtures/archive-engine-v0-legacy.json", import.meta.url), "utf8"
    )) as unknown;
    expect(normalizeArchiveRecord(fixture)).toEqual({
      ok: true,
      source_schema_version: 0,
      readiness: "unavailable",
      legacy: {
        change_identity: "legacy-change",
        archive_path: ".harness/archive/2026-01-01-legacy-change",
        completed_at: "2026-01-01T00:00:00.000Z"
      },
      reason_codes: [
        "LEGACY_OPERATION_ID_UNKNOWN",
        "LEGACY_SOURCE_SNAPSHOT_UNKNOWN",
        "LEGACY_CLOSURE_POLICY_UNKNOWN",
        "LEGACY_MANIFEST_IDENTITY_UNKNOWN"
      ]
    });
  });

  it.each([
    { schema_version: 1, extra: true },
    {
      schema_version: 1,
      operation_id: `archive_operation:${"a".repeat(64)}`,
      change_identity: "change",
      closure_disposition: "completed",
      archive_intent: "record_only",
      source_snapshot_hash: sha("b"),
      archive_schema_version: 1,
      archive_path: ".harness/archive/change",
      archive_manifest_hash: sha("c"),
      completed_at: "2026-02-30T00:00:00Z"
    }
  ])("rejects malformed current records without widening compatibility", (record) => {
    expect(normalizeArchiveRecord(record)).toEqual({
      ok: false,
      reason_code: "ARCHIVE_RECORD_INVALID"
    });
  });

  it.each([
    ["archive_path", "C:/archive/change"],
    ["archive_path", ".harness/archive/../change"],
    ["change_identity", "project\\change"],
    ["operation_id", "archive_operation:not-a-hash"]
  ] as const)("rejects current receipt with invalid canonical %s", async (field, value) => {
    const fixture = JSON.parse(await readFile(
      new URL("./fixtures/archive-engine-v1-current.json", import.meta.url), "utf8"
    )) as Record<string, unknown>;
    expect(normalizeArchiveRecord({ ...fixture, [field]: value })).toEqual({
      ok: false,
      reason_code: "ARCHIVE_RECORD_INVALID"
    });
  });
});
