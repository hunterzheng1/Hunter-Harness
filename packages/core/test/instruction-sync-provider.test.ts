import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import type { MapEvidenceBundle } from "../src/codebase/map-v2/types.js";
import { sha256Bytes } from "../src/fs/hash.js";
import {
  inspectInstructions,
  type InstructionInspectionInput,
  type InstructionProjectionPlan
} from "../src/instruction-governance/index.js";
import { stableHash as instructionHash } from "../src/instruction-governance/stable.js";
import {
  planInstructionApply,
  proposeInstructionChanges,
  recordInstructionApplyReceipt,
  selectInstructionEvidence,
  type InstructionActionDecision,
  type InstructionApplyResult,
  type InstructionManifestWriteInput,
  type InstructionProposal
} from "../src/instruction-proposal/index.js";
import {
  createSyncContext,
  createSyncMaintenanceModule,
  stableHash,
  type SyncActionPlan,
  type SyncActionReceipt,
  type SyncApplyConfirmation
} from "../src/sync-maintenance/index.js";
import {
  createInstructionSyncProvider,
  InstructionSyncProviderError,
  readInstructionSyncProviderFixture,
  type InstructionExecutionPort,
  type InstructionExecutionReadback,
  type InstructionExecutionRequest,
  type InstructionExecutionResult,
  type InstructionRollbackRequest,
  type InstructionRollbackResult,
  type InstructionSyncProviderSnapshotV1
} from "../src/sync-providers/instruction/index.js";

const completedAt = "2026-08-13T09:00:00.000Z";
const H = (character: string): `sha256:${string}` =>
  `sha256:${character.repeat(64)}`;

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as unknown;
}

async function baseSnapshot(): Promise<InstructionSyncProviderSnapshotV1> {
  return await fixture("instruction-sync-provider-v1-current.json") as
    InstructionSyncProviderSnapshotV1;
}

function context(options: { platform?: boolean; commit?: string } = {}) {
  const commit = options.commit ?? "1111111111111111111111111111111111111111";
  return createSyncContext({
    schema_version: 1,
    project_identity: "project-1",
    repository_identity: "repository-1",
    worktree_identity: "worktree-1",
    current_commit: commit,
    project_change_set: {
      schema_version: 1,
      baseline_available: true,
      head_commit: commit,
      dirty_paths: [],
      untracked_paths: []
    },
    enabled_agents: ["codex"],
    agent_profiles: { codex: "general" },
    ...(options.platform ? { platform_binding: { project_id: "project-1" } } : {}),
    feature_flags: { instruction_governance: true }
  });
}

function confirmation(action: SyncActionPlan, allowWrites = true): SyncApplyConfirmation {
  return {
    schema_version: 1,
    plan_id: "sync_plan:test",
    preview_hash: stableHash("preview"),
    approved_action_ids: [action.action_id],
    allow_writes: allowWrites,
    allow_network: false,
    allow_model: false,
    confirmed_at: completedAt
  };
}

function sameKeyReceiptTampering(receipt: SyncActionReceipt): readonly SyncActionReceipt[] {
  return [
    { ...receipt, modified_paths: [".harness/rules/invented.md", "AGENTS.md"] },
    { ...receipt, wrote: !receipt.wrote },
    {
      ...receipt,
      rollback: receipt.rollback.available
        ? { strategy: "automatic", available: true, rollback_token: "instruction_rollback:tampered" }
        : { strategy: "automatic", available: true, rollback_token: "instruction_rollback:tampered" }
    },
    { ...receipt, evidence_sources: ["invented_receipt"] },
    { ...receipt, completed_at: "2026-08-13T09:00:01.000Z" }
  ];
}

async function evidence() {
  const raw = await fixture("instruction-proposal-v1-current.json") as {
    map_bundle: MapEvidenceBundle;
    candidates: readonly unknown[];
  };
  return selectInstructionEvidence(raw.map_bundle, raw.candidates, {
    map_topics: ["testing"],
    candidate_rule_topics: { pcc_rule_01: "testing" },
    executable_architecture_candidate_ids: [],
    max_items: 8,
    max_characters: 2_000,
    max_utf8_bytes: 3_000
  });
}

const proposalScope = {
  map_topics: ["testing"] as const,
  candidate_rule_topics: { pcc_rule_01: "testing" as const },
  executable_architecture_candidate_ids: [] as const,
  max_items: 8,
  max_characters: 2_000,
  max_utf8_bytes: 3_000
};

const rawProposalAction = {
  operation: "modify" as const,
  target_path: ".harness/rules/testing.md",
  topic: "testing" as const,
  content: "# 测试规则\n\n所有改动必须运行聚焦测试。\n",
  evidence_refs: ["candidate:pcc_rule_01"] as const,
  rationale_zh: "该规则具有重复评审证据，需要人工确认后应用。",
  confidence: "high" as const,
  review_mode: "confirmation_required" as const
};

async function trustedProposalWire(input: InstructionInspectionInput): Promise<string> {
  const raw = await fixture("instruction-proposal-v1-current.json") as {
    map_bundle: MapEvidenceBundle;
    candidates: readonly unknown[];
  };
  const health = inspectInstructions(input);
  return JSON.stringify({
    schema_version: 1,
    map_bundle: raw.map_bundle,
    candidates: raw.candidates,
    selection_scope: proposalScope,
    inspection_ref: health.inspection_ref,
    current_inspection_ref: health.inspection_ref,
    expected_baseline_hash: health.canonical_hash,
    canonical_file_hashes: {
      ".harness/rules/core.md": H("a"),
      ".harness/rules/testing.md": H("b")
    },
    created_at: "2026-08-13T08:00:00.000Z",
    expires_at: "2026-08-14T08:00:00.000Z",
    prompt_version: "instruction-proposal-v1",
    model_identity: "memory:test-model",
    raw_model_actions: [rawProposalAction],
    verified_at: completedAt
  });
}

async function proposalFor(input: InstructionInspectionInput): Promise<InstructionProposal> {
  const health = inspectInstructions(input);
  return proposeInstructionChanges({
    inspection_ref: health.inspection_ref,
    current_inspection_ref: health.inspection_ref,
    evidence: await evidence(),
    expected_baseline_hash: health.canonical_hash,
    canonical_file_hashes: {
      ".harness/rules/core.md": H("a"),
      ".harness/rules/testing.md": H("b")
    },
    created_at: "2026-08-13T08:00:00.000Z",
    expires_at: "2026-08-14T08:00:00.000Z",
    prompt_version: "instruction-proposal-v1",
    model_identity: "memory:test-model"
  }, {
    propose: vi.fn(async () => ({
      actions: [rawProposalAction]
    }))
  });
}

function projection(candidate: InstructionProposal, accepted: boolean): InstructionProjectionPlan {
  if (!accepted) {
    const base = {
      schema_version: 1 as const,
      canonical_hash: candidate.expected_baseline_hash,
      adapter_version: "instruction_projection_v1" as const,
      status: "ready" as const,
      executable: true,
      operations: [],
      failures: [],
      projection_hashes: {}
    };
    return { ...base, plan_hash: instructionHash(base) };
  }
  const content = "# Managed instruction projection\n";
  const operation = {
    operation: "write" as const,
    path: "AGENTS.md",
    target_agents: ["codex" as const],
    source_paths: [".harness/rules/testing.md"],
    expected_content_hash: H("d"),
    content_hash: sha256Bytes(content),
    content,
    adapter_version: "instruction_projection_v1" as const
  };
  const base = {
    schema_version: 1 as const,
    canonical_hash: H("f"),
    adapter_version: "instruction_projection_v1" as const,
    status: "ready" as const,
    executable: true,
    operations: [operation],
    failures: [],
    projection_hashes: { codex: instructionHash([{ path: operation.path, content_hash: operation.content_hash }]) }
  };
  return { ...base, plan_hash: instructionHash(base) };
}

function manifestWrite(candidate: InstructionProposal, reviewedAt: string): InstructionManifestWriteInput {
  const action = candidate.actions[0];
  if (action === undefined) throw new Error("proposal fixture is empty");
  const content = JSON.stringify({
    schema_version: 1,
    ruleset_version: "ruleset-2026-08-apply",
    generator: {
      name: "hunter-harness",
      version: "0.1.0",
      prompt_version: candidate.prompt_version
    },
    project_identity: "project-1",
    canonical_root: ".harness/rules",
    files: [{
      path: ".harness/rules/core.md",
      topic: "core",
      status: "active",
      content_hash: H("a"),
      activation: "always",
      globs: [],
      module_refs: [],
      target_agents: ["codex"],
      context_budget: 500,
      evidence_refs: ["manual:core"]
    }, {
      path: action.target_path,
      topic: action.topic,
      status: "active",
      content_hash: action.content_hash,
      activation: "path",
      globs: ["packages/**"],
      module_refs: [],
      target_agents: ["codex"],
      context_budget: 500,
      evidence_refs: [...action.evidence_refs]
    }],
    proposal_id: candidate.proposal_id,
    reviewed_at: reviewedAt
  });
  return { content, content_hash: sha256Bytes(content), expected_content_hash: H("9") };
}

function selfHashProposalAction(
  candidate: InstructionProposal,
  changes: Readonly<Record<string, unknown>>
): InstructionProposal {
  const current = candidate.actions[0];
  if (current === undefined) throw new Error("proposal fixture is empty");
  const {
    action_id: ignoredActionId,
    content_hash: ignoredContentHash,
    before_content_hash: ignoredBeforeHash,
    ...draft
  } = current;
  void ignoredActionId;
  void ignoredContentHash;
  void ignoredBeforeHash;
  const changedDraft = { ...draft, ...changes };
  const contentHash = sha256Bytes(String(changedDraft.content));
  const actionIdentity = instructionHash({
    ...changedDraft,
    target_path: changedDraft.target_path,
    content_hash: contentHash
  });
  const action = {
    ...changedDraft,
    action_id: `ia_${actionIdentity.slice("sha256:".length, "sha256:".length + 24)}`,
    before_content_hash: current.before_content_hash,
    content_hash: contentHash
  } as InstructionProposal["actions"][number];
  const withoutIdentity = {
    schema_version: candidate.schema_version,
    inspection_ref: candidate.inspection_ref,
    input_fingerprint: candidate.input_fingerprint,
    expected_baseline_hash: candidate.expected_baseline_hash,
    evidence_hash: candidate.evidence_hash,
    prompt_version: candidate.prompt_version,
    model_identity: candidate.model_identity,
    actions: [action],
    evidence_refs: [...action.evidence_refs].sort(),
    status: candidate.status,
    created_at: candidate.created_at,
    expires_at: candidate.expires_at
  };
  const proposalHash = instructionHash(withoutIdentity);
  return {
    ...withoutIdentity,
    proposal_id: `ip_${proposalHash.slice("sha256:".length, "sha256:".length + 24)}`,
    proposal_hash: proposalHash
  };
}

async function executableSnapshot(decision: "accept" | "reject" | "retain" = "accept") {
  const base = await baseSnapshot();
  if (!base.configured) throw new Error("fixture must be configured");
  const candidate = await proposalFor(base.inspection_input);
  const action = candidate.actions[0];
  if (action === undefined) throw new Error("proposal fixture is empty");
  const decisions: readonly InstructionActionDecision[] = [{ action_id: action.action_id, decision }];
  const projectionPlan = projection(candidate, decision === "accept");
  const plannedAt = "2026-08-13T08:30:00.000Z";
  const manifest = decision === "accept" ? manifestWrite(candidate, plannedAt) : undefined;
  const applyPlan = planInstructionApply(
    candidate,
    decisions,
    candidate.expected_baseline_hash,
    projectionPlan,
    plannedAt,
    manifest
  );
  expect(applyPlan.status).toBe("ready");
  return {
    snapshot: {
      ...base,
      proposal_json: JSON.stringify(candidate),
      trusted_json: await trustedProposalWire(base.inspection_input),
      apply_bundle: {
        apply_plan: applyPlan,
        projection_plan: projectionPlan,
        ...(manifest === undefined ? {} : { manifest_write: manifest })
      }
    } satisfies InstructionSyncProviderSnapshotV1,
    candidate,
    applyPlan
  };
}

class MemoryInstructionPort implements InstructionExecutionPort {
  readonly calls = { execute: 0, readback: 0, rollback: 0 };
  execute_mode:
    | "valid"
    | "tampered_receipt"
    | "custom_prototype"
    | "duplicate_paths"
    | "invalid_timestamp"
    | "reject_after_effect" = "valid";
  readback_mode: "valid" | "mismatch" | "sparse" = "valid";
  rollback_mode: "success" | "fail" | "invalid" = "success";
  last_request?: InstructionExecutionRequest;
  last_result?: InstructionExecutionResult;

  async execute(request: InstructionExecutionRequest): Promise<InstructionExecutionResult> {
    this.calls.execute += 1;
    this.last_request = request;
    if (this.execute_mode === "reject_after_effect") {
      throw new Error("effect may already have happened");
    }
    const apply_result: InstructionApplyResult = {
      completed_at: completedAt,
      resulting_canonical_hash: request.apply_plan.resulting_canonical_hash,
      projection_receipt_ref: H("8"),
      applied_operations: request.apply_plan.operations.map((operation) => ({
        path: operation.path,
        content_hash: operation.content_hash
      }))
    };
    const receipt = recordInstructionApplyReceipt(request.apply_plan, apply_result);
    const result: InstructionExecutionResult = {
      apply_result: this.execute_mode === "invalid_timestamp"
        ? { ...apply_result, completed_at: "2026-02-31T09:00:00.000Z" }
        : apply_result,
      receipt: this.execute_mode === "tampered_receipt"
        ? { ...receipt, canonical_hash: H("7") }
        : receipt,
      modified_paths: this.execute_mode === "duplicate_paths" && receipt.changed_paths[0] !== undefined
        ? [receipt.changed_paths[0], receipt.changed_paths[0]]
        : [...receipt.changed_paths].sort(),
      rollback_token: request.rollback_capability.available
        ? request.rollback_capability.rollback_token
        : "not_available"
    };
    this.last_result = result;
    if (this.execute_mode === "custom_prototype") {
      return Object.assign(Object.create({ inherited: true }), result) as InstructionExecutionResult;
    }
    return result;
  }

  async readback(receipt_id: string): Promise<InstructionExecutionReadback> {
    void receipt_id;
    this.calls.readback += 1;
    if (this.last_result === undefined) throw new Error("missing execution");
    if (this.readback_mode === "mismatch") {
      return {
        receipt: this.last_result.receipt,
        apply_result: { ...this.last_result.apply_result, resulting_canonical_hash: H("6") }
      };
    }
    if (this.readback_mode === "sparse") {
      const operations = [...this.last_result.apply_result.applied_operations];
      delete operations[0];
      return {
        receipt: this.last_result.receipt,
        apply_result: { ...this.last_result.apply_result, applied_operations: operations }
      };
    }
    return {
      receipt: this.last_result.receipt,
      apply_result: this.last_result.apply_result
    };
  }

  async rollback(request: InstructionRollbackRequest): Promise<InstructionRollbackResult> {
    this.calls.rollback += 1;
    if (this.rollback_mode === "fail") throw new Error("rollback failed");
    if (this.rollback_mode === "invalid") {
      return { rolled_back: true, resulting_canonical_hash: request.expected_current_canonical_hash };
    }
    return {
      rolled_back: true,
      resulting_canonical_hash: request.expected_previous_canonical_hash
    };
  }
}

describe("InstructionSyncActionProvider", () => {
  it("is not applicable when instruction governance is not configured", async () => {
    const port = new MemoryInstructionPort();
    const provider = createInstructionSyncProvider({
      snapshot: { schema_version: 1, configured: false },
      execution_port: port,
      clock: () => new Date(completedAt)
    });
    expect(await provider.applicable(context())).toEqual({
      applicability: "not_applicable",
      reason_code: "INSTRUCTION_NOT_CONFIGURED"
    });
    expect(await provider.inspect(context())).toEqual([]);
    expect(await provider.plan(context(), ["instruction:health"])).toEqual([]);
    expect(port.calls).toEqual({ execute: 0, readback: 0, rollback: 0 });
  });

  it("keeps unchanged input current and never asks the Port to propose or execute", async () => {
    const source = await baseSnapshot();
    if (!source.configured) throw new Error("fixture must be configured");
    const first = inspectInstructions(source.inspection_input);
    const current: InstructionSyncProviderSnapshotV1 = {
      ...source,
      inspection_input: {
        ...source.inspection_input,
        previous_input_fingerprint: first.input_fingerprint
      }
    };
    const port = new MemoryInstructionPort();
    const provider = createInstructionSyncProvider({
      snapshot: current,
      execution_port: port,
      clock: () => new Date(completedAt)
    });
    const findings = await provider.inspect(context());
    expect(findings).toMatchObject([{
      status: "OK",
      urgency: "none",
      reason_code: "INSTRUCTION_CURRENT"
    }]);
    expect(await provider.plan(context(), ["instruction:health"])).toEqual([]);
    expect(await provider.plan(context(), ["instruction:health"])).toEqual([]);
    expect(port.calls).toEqual({ execute: 0, readback: 0, rollback: 0 });
  });

  it("reports proposal needed without inventing an apply action or calling a model", async () => {
    const port = new MemoryInstructionPort();
    const provider = createInstructionSyncProvider({
      snapshot: await baseSnapshot(),
      execution_port: port,
      clock: () => new Date(completedAt)
    });
    expect(await provider.inspect(context())).toMatchObject([{
      status: "ADVISORY",
      urgency: "recommended",
      reason_code: "INSTRUCTION_PROPOSAL_REQUIRED"
    }]);
    expect(await provider.plan(context(), ["instruction:health"])).toEqual([]);
    expect(port.calls).toEqual({ execute: 0, readback: 0, rollback: 0 });
  });

  it.each(["accept", "reject", "retain"] as const)(
    "binds a real 07B %s plan without re-running proposal generation",
    async (decision) => {
      const { snapshot, applyPlan } = await executableSnapshot(decision);
      const port = new MemoryInstructionPort();
      const provider = createInstructionSyncProvider({
        snapshot,
        execution_port: port,
        clock: () => new Date(completedAt)
      });
      const findings = await provider.inspect(context());
      const actions = await provider.plan(context(), findings.map((item) => item.finding_id));
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        action_id: "instruction:apply_proposal",
        provider_id: "instruction",
        network_access: false,
        model_access: false,
        risk: decision === "accept" ? "medium" : "low",
        rollback_strategy: decision === "accept" ? "automatic" : "none"
      });
      expect(actions[0]?.expected_writes).toEqual(
        [...new Set(applyPlan.operations.map((operation) => operation.path))].sort()
      );
      expect(port.calls.execute).toBe(0);
    }
  );

  it("applies and verifies accepted writes, allowing 04A to emit only one remote intent", async () => {
    const { snapshot, applyPlan } = await executableSnapshot("accept");
    const port = new MemoryInstructionPort();
    const provider = createInstructionSyncProvider({
      snapshot,
      execution_port: port,
      clock: () => new Date(completedAt)
    });
    const module = createSyncMaintenanceModule({
      providers: [provider],
      clock: () => new Date(completedAt)
    });
    const plan = await module.inspect(context({ platform: true }));
    const action = plan.actions[0];
    if (action === undefined) throw new Error("expected instruction action");
    const result = await module.apply(plan.plan_id, plan.preview_hash, [action.action_id], {
      ...confirmation(action),
      plan_id: plan.plan_id,
      preview_hash: plan.preview_hash
    });
    expect(result.changed_paths).toEqual(
      [...new Set(applyPlan.operations.map((operation) => operation.path))].sort()
    );
    expect(result.remote_sync_request_intent?.reason_code).toBe("local_sync_changes_available");
    expect(result.receipts[0]).toMatchObject({
      provider_id: "instruction",
      wrote: true,
      auto_fixed: true,
      output_hash: applyPlan.resulting_canonical_hash
    });
    expect(result.verifications[0]?.status).toBe("verified");
    expect(port.calls).toEqual({ execute: 1, readback: 1, rollback: 0 });
  });

  it("rejects same-key receipt and action tampering after verify and rollback caches are warm", async () => {
    const { snapshot } = await executableSnapshot("accept");
    const port = new MemoryInstructionPort();
    const provider = createInstructionSyncProvider({
      snapshot,
      execution_port: port,
      clock: () => new Date(completedAt)
    });
    const findings = await provider.inspect(context());
    const action = (await provider.plan(context(), findings.map((item) => item.finding_id)))[0];
    if (action === undefined) throw new Error("expected instruction action");
    const receipt = await provider.apply(action, confirmation(action));
    expect((await provider.verify(receipt)).status).toBe("verified");
    expect((await provider.rollback(action, receipt)).status).toBe("rolled_back");
    const callsAtCacheWarm = { ...port.calls };

    for (const hostile of sameKeyReceiptTampering(receipt)) {
      await expect(provider.verify(hostile)).rejects.toMatchObject({
        code: "INSTRUCTION_EXECUTION_RECEIPT_NOT_FOUND"
      });
      await expect(provider.rollback(action, hostile)).rejects.toMatchObject({
        code: "INSTRUCTION_EXECUTION_RECEIPT_NOT_FOUND"
      });
    }
    const hostileAction = { ...action, risk: action.risk === "low" ? "high" as const : "low" as const };
    await expect(provider.rollback(hostileAction, receipt)).rejects.toMatchObject({
      code: "INSTRUCTION_EXECUTION_RECEIPT_NOT_FOUND"
    });
    const getter = vi.fn(() => receipt.action_id);
    const accessorReceipt = { ...receipt } as Record<string, unknown>;
    Object.defineProperty(accessorReceipt, "action_id", { enumerable: true, get: getter });
    await expect(provider.verify(accessorReceipt as unknown as SyncActionReceipt)).rejects.toMatchObject({
      code: "INSTRUCTION_EXECUTION_RECEIPT_NOT_FOUND"
    });
    expect(getter).not.toHaveBeenCalled();
    expect(port.calls).toEqual(callsAtCacheWarm);
  });

  it.each(["reject", "retain"] as const)(
    "records %s with zero changed paths and never creates a remote intent",
    async (decision) => {
      const { snapshot } = await executableSnapshot(decision);
      const port = new MemoryInstructionPort();
      const provider = createInstructionSyncProvider({
        snapshot,
        execution_port: port,
        clock: () => new Date(completedAt)
      });
      const module = createSyncMaintenanceModule({ providers: [provider], clock: () => new Date(completedAt) });
      const plan = await module.inspect(context({ platform: true }));
      const action = plan.actions[0];
      if (action === undefined) throw new Error("expected instruction action");
      const result = await module.apply(plan.plan_id, plan.preview_hash, [action.action_id], {
        ...confirmation(action, false),
        plan_id: plan.plan_id,
        preview_hash: plan.preview_hash
      });
      expect(result.changed_paths).toEqual([]);
      expect(result.no_changes).toBe(true);
      expect(result.remote_sync_request_intent).toBeUndefined();
      expect(result.receipts[0]).toMatchObject({ wrote: false, auto_fixed: false });
    }
  );

  it("rejects stale context, proposal expiry, and changed inspection before executing", async () => {
    const { snapshot } = await executableSnapshot("accept");
    let currentSnapshot = snapshot;
    const port = new MemoryInstructionPort();
    const provider = createInstructionSyncProvider({
      snapshot: () => currentSnapshot,
      execution_port: port,
      clock: () => new Date(completedAt)
    });
    const findings = await provider.inspect(context());
    const action = (await provider.plan(context(), findings.map((item) => item.finding_id)))[0];
    if (action === undefined) throw new Error("expected instruction action");
    if (!currentSnapshot.configured) throw new Error("fixture must be configured");
    currentSnapshot = {
      ...currentSnapshot,
      inspection_input: { ...currentSnapshot.inspection_input, prompt_version: "instruction-v2" }
    };
    await expect(provider.apply(action, confirmation(action))).rejects.toMatchObject({
      code: "INSTRUCTION_ACTION_STALE"
    });
    expect(port.calls.execute).toBe(0);

    const expiredProvider = createInstructionSyncProvider({
      snapshot,
      execution_port: port,
      clock: () => new Date("2026-08-15T09:00:00.000Z")
    });
    const expiredFindings = await expiredProvider.inspect(context());
    const expiredAction = (await expiredProvider.plan(
      context(),
      expiredFindings.map((item) => item.finding_id)
    ))[0];
    if (expiredAction === undefined) throw new Error("expected expired action preview");
    await expect(expiredProvider.apply(expiredAction, confirmation(expiredAction))).rejects.toMatchObject({
      code: "INSTRUCTION_ACTION_STALE"
    });
    expect(port.calls.execute).toBe(0);
  });

  it.each(["projection", "manifest", "cas"] as const)(
    "rejects a %s drifted apply snapshot instead of inventing fields",
    async (kind) => {
      const { snapshot } = await executableSnapshot("accept");
      if (!snapshot.configured || snapshot.apply_bundle === undefined) throw new Error("fixture incomplete");
      const bundle = snapshot.apply_bundle;
      if (bundle.manifest_write === undefined) throw new Error("manifest fixture is missing");
      const drifted: InstructionSyncProviderSnapshotV1 = {
        ...snapshot,
        apply_bundle: kind === "projection"
          ? { ...bundle, projection_plan: { ...bundle.projection_plan, canonical_hash: H("1") } }
          : kind === "manifest"
            ? { ...bundle, manifest_write: { ...bundle.manifest_write, expected_content_hash: H("2") } }
            : {
              ...bundle,
              apply_plan: { ...bundle.apply_plan, expected_baseline_hash: H("3") }
            }
      };
      const provider = createInstructionSyncProvider({
        snapshot: drifted,
        execution_port: new MemoryInstructionPort(),
        clock: () => new Date(completedAt)
      });
      await expect(provider.plan(context(), ["instruction:health"])).rejects.toMatchObject({
        code: "INSTRUCTION_APPLY_PLAN_INVALID"
      });
    }
  );

  it("rejects a self-rehashed projection with duplicate non-canonical target agents", async () => {
    const { snapshot, candidate } = await executableSnapshot("accept");
    if (!snapshot.configured || snapshot.apply_bundle === undefined) throw new Error("fixture incomplete");
    const operation = snapshot.apply_bundle.projection_plan.operations[0];
    if (operation === undefined) throw new Error("projection fixture is empty");
    const projectionBase = {
      ...snapshot.apply_bundle.projection_plan,
      operations: [{ ...operation, target_agents: ["codex" as const, "codex" as const] }]
    };
    const { plan_hash: ignoredPlanHash, ...projectionPayload } = projectionBase;
    void ignoredPlanHash;
    const projectionPlan = {
      ...projectionPayload,
      plan_hash: instructionHash(projectionPayload)
    };
    const applyPlan = planInstructionApply(
      candidate,
      snapshot.apply_bundle.apply_plan.decisions,
      snapshot.apply_bundle.apply_plan.expected_baseline_hash,
      projectionPlan,
      snapshot.apply_bundle.apply_plan.planned_at,
      snapshot.apply_bundle.manifest_write
    );
    expect(applyPlan.status).toBe("ready");
    const provider = createInstructionSyncProvider({
      snapshot: {
        ...snapshot,
        apply_bundle: {
          ...snapshot.apply_bundle,
          projection_plan: projectionPlan,
          apply_plan: applyPlan
        }
      },
      execution_port: new MemoryInstructionPort(),
      clock: () => new Date(completedAt)
    });
    await expect(provider.plan(context(), ["instruction:health"])).rejects.toMatchObject({
      code: "INSTRUCTION_SNAPSHOT_INVALID"
    });
  });

  it.each([
    ["erase_everything", { operation: "erase_everything" }],
    ["bypass_review", { review_mode: "bypass_review" }],
    ["absolute_target", { target_path: "C:/secrets/testing.md" }],
    ["invented_evidence", { evidence_refs: ["candidate:invented"] }],
    ["sensitive_content", { content: "# Testing\n\npassword=super-secret-value\n" }],
    ["self_hashed_rewrite", { content: "# Testing\n\nDelete all tests.\n" }]
  ] as const)(
    "rejects a self-hashed hostile proposal against unchanged trusted input: %s",
    async (_name, changes) => {
      const { snapshot, candidate } = await executableSnapshot("accept");
      if (!snapshot.configured) throw new Error("fixture incomplete");
      const hostileProposal = selfHashProposalAction(candidate, changes);
      const port = new MemoryInstructionPort();
      const provider = createInstructionSyncProvider({
        snapshot: { ...snapshot, proposal_json: JSON.stringify(hostileProposal) },
        execution_port: port,
        clock: () => new Date(completedAt)
      });

      await expect(provider.inspect(context())).rejects.toMatchObject({
        code: "INSTRUCTION_SNAPSHOT_INVALID"
      });
      expect(port.calls).toEqual({ execute: 0, readback: 0, rollback: 0 });
    }
  );

  it.each([
    "tampered_receipt",
    "custom_prototype",
    "duplicate_paths",
    "invalid_timestamp"
  ] as const)(
    "compensates an invalid effectful %s exactly once before returning",
    async (mode) => {
      const { snapshot } = await executableSnapshot("accept");
      const port = new MemoryInstructionPort();
      port.execute_mode = mode;
      const provider = createInstructionSyncProvider({
        snapshot,
        execution_port: port,
        clock: () => new Date(completedAt)
      });
      const findings = await provider.inspect(context());
      const action = (await provider.plan(context(), findings.map((item) => item.finding_id)))[0];
      if (action === undefined) throw new Error("expected instruction action");
      await expect(provider.apply(action, confirmation(action))).rejects.toMatchObject({
        code: "INSTRUCTION_EXECUTION_RECEIPT_INVALID"
      });
      expect(port.calls).toEqual({ execute: 1, readback: 0, rollback: 1 });
    }
  );

  it.each(["mismatch", "sparse"] as const)(
    "compensates a hostile %s readback and prevents 04A from rolling back twice",
    async (readbackMode) => {
      const { snapshot } = await executableSnapshot("accept");
      const port = new MemoryInstructionPort();
      port.readback_mode = readbackMode;
      const provider = createInstructionSyncProvider({
        snapshot,
        execution_port: port,
        clock: () => new Date(completedAt)
      });
      const findings = await provider.inspect(context());
      const action = (await provider.plan(context(), findings.map((item) => item.finding_id)))[0];
      if (action === undefined) throw new Error("expected instruction action");
      const receipt = await provider.apply(action, confirmation(action));
      const first = await provider.verify(receipt);
      const second = await provider.verify(receipt);
      expect(first).toEqual(second);
      expect(first).toMatchObject({ status: "failed", reason_code: "INSTRUCTION_RECEIPT_MISMATCH" });
      const rollback1 = await provider.rollback(action, receipt);
      const rollback2 = await provider.rollback(action, receipt);
      expect(rollback1).toEqual(rollback2);
      expect(rollback1.status).toBe("rolled_back");
      expect(port.calls).toEqual({ execute: 1, readback: 1, rollback: 1 });
    }
  );

  it("preserves compensation failure evidence and never retries physical rollback", async () => {
    const { snapshot } = await executableSnapshot("accept");
    const port = new MemoryInstructionPort();
    port.readback_mode = "mismatch";
    port.rollback_mode = "fail";
    const provider = createInstructionSyncProvider({
      snapshot,
      execution_port: port,
      clock: () => new Date(completedAt)
    });
    const findings = await provider.inspect(context());
    const action = (await provider.plan(context(), findings.map((item) => item.finding_id)))[0];
    if (action === undefined) throw new Error("expected instruction action");
    const receipt = await provider.apply(action, confirmation(action));
    expect(await provider.verify(receipt)).toMatchObject({
      status: "failed",
      reason_code: "INSTRUCTION_EXECUTION_COMPENSATION_FAILED"
    });
    const first = await provider.rollback(action, receipt);
    const second = await provider.rollback(action, receipt);
    expect(first).toEqual(second);
    expect(first.status).toBe("failed");
    expect(port.calls).toEqual({ execute: 1, readback: 1, rollback: 1 });
  });

  it("precomputes the execution identity and compensates an execute rejection exactly once", async () => {
    const { snapshot } = await executableSnapshot("accept");
    const port = new MemoryInstructionPort();
    port.execute_mode = "reject_after_effect";
    const provider = createInstructionSyncProvider({
      snapshot,
      execution_port: port,
      clock: () => new Date(completedAt)
    });
    const findings = await provider.inspect(context());
    const action = (await provider.plan(context(), findings.map((item) => item.finding_id)))[0];
    if (action === undefined) throw new Error("expected instruction action");

    const receipt = await provider.apply(action, confirmation(action));
    const request = port.last_request;
    if (request === undefined) throw new Error("expected execution request");
    expect(port.last_request).toMatchObject({
      transaction_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      operation_id: expect.stringMatching(/^instruction_execution:[a-f0-9]{24}$/u),
      rollback_capability: {
        strategy: "automatic",
        available: true,
        rollback_token: expect.stringMatching(/^instruction_rollback:[a-f0-9]{64}$/u)
      }
    });
    const verification1 = await provider.verify(receipt);
    const verification2 = await provider.verify(receipt);
    expect(verification1).toEqual(verification2);
    expect(verification1).toMatchObject({
      status: "failed",
      reason_code: "INSTRUCTION_EXECUTION_REJECTED",
      evidence_hash: stableHash({
        transaction_hash: request.transaction_hash,
        expected_canonical_hash: request.apply_plan.resulting_canonical_hash,
        execute_error_name: "Error",
        rollback_result: {
          rolled_back: true,
          resulting_canonical_hash: request.apply_plan.expected_baseline_hash
        }
      })
    });
    const rollback1 = await provider.rollback(action, receipt);
    const rollback2 = await provider.rollback(action, receipt);
    expect(rollback1).toEqual(rollback2);
    expect(rollback1.status).toBe("rolled_back");
    expect(port.calls).toEqual({ execute: 1, readback: 0, rollback: 1 });
  });

  it("keeps execute-rejection compensation failure evidence without a second physical rollback", async () => {
    const { snapshot } = await executableSnapshot("accept");
    const port = new MemoryInstructionPort();
    port.execute_mode = "reject_after_effect";
    port.rollback_mode = "fail";
    const provider = createInstructionSyncProvider({
      snapshot,
      execution_port: port,
      clock: () => new Date(completedAt)
    });
    const findings = await provider.inspect(context());
    const action = (await provider.plan(context(), findings.map((item) => item.finding_id)))[0];
    if (action === undefined) throw new Error("expected instruction action");

    const receipt = await provider.apply(action, confirmation(action));
    const request = port.last_request;
    if (request === undefined) throw new Error("expected execution request");
    const verification1 = await provider.verify(receipt);
    const verification2 = await provider.verify(receipt);
    expect(verification1).toEqual(verification2);
    expect(verification1).toMatchObject({
      status: "failed",
      reason_code: "INSTRUCTION_EXECUTION_COMPENSATION_FAILED",
      evidence_hash: stableHash({
        reason_code: "INSTRUCTION_EXECUTION_COMPENSATION_FAILED",
        evidence: {
          transaction_hash: request.transaction_hash,
          expected_canonical_hash: request.apply_plan.resulting_canonical_hash,
          execute_error_name: "Error",
          rollback_error_name: "Error"
        }
      })
    });
    const rollback1 = await provider.rollback(action, receipt);
    const rollback2 = await provider.rollback(action, receipt);
    expect(rollback1).toEqual(rollback2);
    expect(rollback1).toMatchObject({
      status: "failed",
      reason_code: "INSTRUCTION_EXECUTION_COMPENSATION_FAILED"
    });
    expect(port.calls).toEqual({ execute: 1, readback: 0, rollback: 1 });
  });

  it.each(["success", "fail"] as const)(
    "binds execute-rejection %s compensation caches to the complete receipt",
    async (rollbackMode) => {
      const { snapshot } = await executableSnapshot("accept");
      const port = new MemoryInstructionPort();
      port.execute_mode = "reject_after_effect";
      port.rollback_mode = rollbackMode;
      const provider = createInstructionSyncProvider({
        snapshot,
        execution_port: port,
        clock: () => new Date(completedAt)
      });
      const findings = await provider.inspect(context());
      const action = (await provider.plan(context(), findings.map((item) => item.finding_id)))[0];
      if (action === undefined) throw new Error("expected instruction action");
      const receipt = await provider.apply(action, confirmation(action));
      const callsAtCacheWarm = { ...port.calls };

      for (const hostile of sameKeyReceiptTampering(receipt)) {
        await expect(provider.verify(hostile)).rejects.toMatchObject({
          code: "INSTRUCTION_EXECUTION_RECEIPT_NOT_FOUND"
        });
        await expect(provider.rollback(action, hostile)).rejects.toMatchObject({
          code: "INSTRUCTION_EXECUTION_RECEIPT_NOT_FOUND"
        });
      }
      expect(port.calls).toEqual(callsAtCacheWarm);
    }
  );

  it("rejects invalid Gregorian timestamps and accessor snapshots without invoking getters", async () => {
    const { snapshot, candidate } = await executableSnapshot("accept");
    if (!snapshot.configured) throw new Error("fixture incomplete");
    const invalidDate: InstructionSyncProviderSnapshotV1 = {
      ...snapshot,
      proposal_json: JSON.stringify({ ...candidate, expires_at: "2026-02-31T08:00:00.000Z" })
    };
    const invalidProvider = createInstructionSyncProvider({
      snapshot: invalidDate,
      execution_port: new MemoryInstructionPort(),
      clock: () => new Date(completedAt)
    });
    await expect(invalidProvider.inspect(context())).rejects.toMatchObject({
      code: "INSTRUCTION_SNAPSHOT_INVALID"
    });

    const getter = vi.fn(() => snapshot);
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "schema_version", { enumerable: true, get: getter });
    const hostileProvider = createInstructionSyncProvider({
      snapshot: hostile as InstructionSyncProviderSnapshotV1,
      execution_port: new MemoryInstructionPort(),
      clock: () => new Date(completedAt)
    });
    await expect(hostileProvider.inspect(context())).rejects.toBeInstanceOf(InstructionSyncProviderError);
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects excessively deep snapshots without throwing a native recursion error", async () => {
    const deep = { schema_version: 1, configured: true } as Record<string, unknown>;
    let cursor = deep;
    for (let index = 0; index < 20_000; index += 1) {
      const child: Record<string, unknown> = {};
      cursor.child = child;
      cursor = child;
    }
    const provider = createInstructionSyncProvider({
      snapshot: deep as InstructionSyncProviderSnapshotV1,
      execution_port: new MemoryInstructionPort(),
      clock: () => new Date(completedAt)
    });

    await expect(provider.inspect(context())).rejects.toMatchObject({
      code: "INSTRUCTION_SNAPSHOT_INVALID"
    });
  });

  it("reads v1 strictly and exposes v0 only as a frozen read-only migration view", async () => {
    const current = readInstructionSyncProviderFixture(await fixture(
      "instruction-sync-provider-v1-current.json"
    ));
    expect(current).toMatchObject({ ok: true, source_schema_version: 1 });
    expect(Object.isFrozen(current)).toBe(true);

    const { snapshot: executable } = await executableSnapshot("accept");
    if (!executable.configured || executable.apply_bundle === undefined) {
      throw new Error("fixture incomplete");
    }
    expect(readInstructionSyncProviderFixture({
      ...executable,
      apply_bundle: {
        ...executable.apply_bundle,
        apply_plan: {
          ...executable.apply_bundle.apply_plan,
          expected_baseline_hash: H("4")
        }
      }
    })).toEqual({ ok: false, reason_code: "INSTRUCTION_SYNC_RECORD_INVALID" });

    const legacy = readInstructionSyncProviderFixture(await fixture(
      "instruction-sync-provider-v0-legacy.json"
    ));
    expect(legacy).toEqual({
      ok: true,
      source_schema_version: 0,
      readiness: "legacy_read_only",
      legacy: {
        status: "ADVISORY",
        input_hash: null,
        report_path: null,
        report_sha256: null
      },
      reason_codes: ["INSTRUCTION_LEGACY_REINSPECTION_REQUIRED"]
    });
    expect(Object.isFrozen(legacy)).toBe(true);
    expect(readInstructionSyncProviderFixture({ schema_version: 7 })).toEqual({
      ok: false,
      reason_code: "INSTRUCTION_SYNC_RECORD_VERSION_UNSUPPORTED"
    });
  });
});
