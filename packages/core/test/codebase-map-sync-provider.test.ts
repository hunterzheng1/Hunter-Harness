import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  CODEBASE_MAP_V2_DOCUMENTS,
  type MapHealth,
  type MapInspectionInput,
  type MapManifestDraftV2,
  type MapPublicationPlanInput
} from "../src/codebase/map-v2/index.js";
import {
  createSyncContext,
  createSyncMaintenanceModule,
  stableHash
} from "../src/sync-maintenance/index.js";
import type {
  SyncActionPlan,
  SyncApplyConfirmation
} from "../src/sync-maintenance/index.js";
import {
  createCodebaseMapSyncProvider,
  InMemoryMapExecutionPort,
  type CodebaseMapSyncProviderFixture,
  type MapExecutionRequest
} from "../src/sync-providers/codebase-map/index.js";

const completedAt = "2026-08-13T08:00:00.000Z";

async function fixture(name: string): Promise<CodebaseMapSyncProviderFixture> {
  return JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as
    CodebaseMapSyncProviderFixture;
}

function context(input: {
  current_commit?: string;
  dirty_paths?: readonly string[];
  untracked_paths?: readonly string[];
} = {}) {
  const currentCommit = input.current_commit ?? "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  return createSyncContext({
    schema_version: 1,
    project_identity: "project-1",
    repository_identity: "repository-1",
    worktree_identity: "worktree-1",
    current_commit: currentCommit,
    project_change_set: {
      schema_version: 1,
      baseline_available: true,
      head_commit: currentCommit,
      dirty_paths: input.dirty_paths ?? [],
      untracked_paths: input.untracked_paths ?? []
    },
    enabled_agents: ["codex"],
    agent_profiles: { codex: "general" },
    feature_flags: { codebase_map: true }
  });
}

function confirmation(action: SyncActionPlan): SyncApplyConfirmation {
  return {
    schema_version: 1,
    plan_id: "sync_plan:test",
    preview_hash: stableHash("preview"),
    approved_action_ids: [action.action_id],
    allow_writes: true,
    allow_network: false,
    allow_model: true,
    confirmed_at: completedAt
  };
}

function publicationInput(health: MapHealth): MapPublicationPlanInput {
  const mode = health.suggested_actions.includes("run_full_refresh") ||
    health.status === "missing" || health.status === "conflicted"
    ? "full"
    : "incremental";
  const documents = Object.fromEntries(CODEBASE_MAP_V2_DOCUMENTS.map((name) => [
    name,
    name === "ARCHITECTURE.md"
      ? "# Architecture\n\nVerified at `packages/core/src/index.ts`."
      : `# ${name.replace(".md", "")}\n\nVerified project fact.`
  ]));
  const manifestDraft: MapManifestDraftV2 = {
    schema_version: 2,
    generator: { name: "harness-codebase-map", version: "2.0.0" },
    project_identity: "project-1",
    repository_identity: "repository-1",
    branch_name: "main",
    source_commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    worktree_identity: "worktree-1",
    mode,
    scope: "repository",
    path_filters: [],
    input_fingerprint: health.input_fingerprint,
    documents: CODEBASE_MAP_V2_DOCUMENTS.map((name) => ({
      path: `.harness/codebase/map/${name}`,
      topics: [name.replace(/\.md$/u, "").toLowerCase()],
      evidence_sources: ["filesystem"],
      input_fingerprint: health.input_fingerprint,
      content_hash: stableHash(documents[name]),
      estimated_tokens: 20,
      status: "refreshed"
    })),
    summary_hash: stableHash("updated summary"),
    warnings: [],
    degradation_reasons: [],
    status: "ready"
  };
  return {
    schema_version: 2,
    published_at: completedAt,
    mode,
    affected_documents: mode === "full" ? CODEBASE_MAP_V2_DOCUMENTS : health.affected_documents,
    ...(health.manifest_hash === undefined ? {} : { previous_manifest_hash: health.manifest_hash }),
    previous_documents: documents,
    proposed_documents: Object.fromEntries(
      (mode === "full" ? CODEBASE_MAP_V2_DOCUMENTS : health.affected_documents)
        .map((name) => [name, documents[name]])
    ),
    manifest_draft: manifestDraft,
    summary_content: "updated summary"
  };
}

describe("CodebaseMapSyncProvider", () => {
  it("maps a current Map v2 drift assessment to one bounded refresh action without doing I/O", async () => {
    const current = await fixture("codebase-map-sync-provider-v1-current.json");
    const execution = new InMemoryMapExecutionPort({ clock: () => new Date(completedAt) });
    const provider = createCodebaseMapSyncProvider({
      inspection_input: current.inspection_input,
      publication_input: publicationInput,
      execution_port: execution,
      clock: () => new Date(completedAt)
    });

    expect(await provider.applicable(context())).toEqual({
      applicability: "applicable",
      reason_code: "MAP_APPLICABLE"
    });
    const findings = await provider.inspect(context());
    const actions = await provider.plan(context(), findings.map((finding) => finding.finding_id));

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      provider_id: "codebase_map",
      status: "WARN",
      urgency: "recommended",
      reason_code: "MAP_SOURCE_COMMIT_CHANGED"
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      action_id: "codebase_map:refresh",
      provider_id: "codebase_map",
      network_access: false,
      model_access: true,
      rollback_strategy: "automatic",
      risk: "medium"
    });
    expect(actions[0]?.expected_writes).toEqual([
      ...CODEBASE_MAP_V2_DOCUMENTS.map((name) => `.harness/codebase/map/${name}`),
      ".harness/codebase/map-summary.md",
      ".harness/codebase/map-manifest.json"
    ].sort());
    expect(execution.calls).toEqual({ execute: 0, readback: 0, rollback: 0 });
  });

  it("returns not_applicable with no finding or warning when Map is not adopted", async () => {
    const current = await fixture("codebase-map-sync-provider-v1-current.json");
    const inspectionInput: MapInspectionInput = {
      ...current.inspection_input,
      manifest: undefined,
      manifest_hash: undefined,
      affected_paths: [],
      feature_flags: {
        ...current.inspection_input.feature_flags,
        map_enabled: false,
        auto_check_enabled: false,
        explicit_request: false
      }
    };
    const provider = createCodebaseMapSyncProvider({
      inspection_input: inspectionInput,
      publication_input: () => {
        throw new Error("publication must not be planned");
      },
      execution_port: new InMemoryMapExecutionPort()
    });

    expect(await provider.applicable(context())).toEqual({
      applicability: "not_applicable",
      reason_code: "MAP_NOT_ADOPTED"
    });
    expect(await provider.inspect(context())).toEqual([]);
    expect(await provider.plan(context(), ["codebase_map:health"])).toEqual([]);
  });

  it("does not plan an action when inputs are unchanged and reports CodeGraph degradation without claiming current", async () => {
    const current = await fixture("codebase-map-sync-provider-v1-current.json");
    const source: MapInspectionInput = {
      ...current.inspection_input,
      current_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      affected_paths: [],
      feature_flags: {
        ...current.inspection_input.feature_flags,
        codegraph_available: false
      }
    };
    const provider = createCodebaseMapSyncProvider({
      inspection_input: source,
      publication_input: () => {
        throw new Error("publication must not be planned");
      },
      execution_port: new InMemoryMapExecutionPort()
    });
    const matchingContext = context({
      current_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });

    const findings = await provider.inspect(matchingContext);
    expect(findings).toMatchObject([{
      status: "ADVISORY",
      urgency: "optional",
      reason_code: "MAP_CODEGRAPH_UNAVAILABLE"
    }]);
    expect(await provider.plan(matchingContext, ["codebase_map:health"])).toEqual([]);
  });

  it("returns OK with no action when all inputs and the authoritative Map snapshot are unchanged", async () => {
    const current = await fixture("codebase-map-sync-provider-v1-current.json");
    const source: MapInspectionInput = {
      ...current.inspection_input,
      current_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      affected_paths: []
    };
    const provider = createCodebaseMapSyncProvider({
      inspection_input: source,
      publication_input: () => {
        throw new Error("publication must not be planned");
      },
      execution_port: new InMemoryMapExecutionPort()
    });
    const matchingContext = context({
      current_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });

    expect(await provider.inspect(matchingContext)).toMatchObject([{
      status: "OK",
      urgency: "none",
      reason_code: "MAP_CURRENT"
    }]);
    expect(await provider.plan(matchingContext, ["codebase_map:health"])).toEqual([]);
  });

  it("executes only the Stage 05 publication plan and verifies its durable receipt", async () => {
    const current = await fixture("codebase-map-sync-provider-v1-current.json");
    const execution = new InMemoryMapExecutionPort({ clock: () => new Date(completedAt) });
    const provider = createCodebaseMapSyncProvider({
      inspection_input: current.inspection_input,
      publication_input: publicationInput,
      execution_port: execution,
      clock: () => new Date(completedAt)
    });
    const findings = await provider.inspect(context());
    const [action] = await provider.plan(context(), findings.map((finding) => finding.finding_id));
    expect(action).toBeDefined();
    if (action === undefined) return;

    const receipt = await provider.apply(action, confirmation(action));
    expect(receipt).toMatchObject({
      action_id: action.action_id,
      input_hash: action.invalidation_hash,
      wrote: true,
      auto_fixed: true,
      rollback: { strategy: "automatic", available: true }
    });
    expect(receipt.modified_paths).toEqual(action.expected_writes);
    expect(execution.requests[0]).toMatchObject({
      expected_previous_manifest_hash: current.inspection_input.manifest_hash,
      execution_policy: { mode: "incremental", model_tier: "light" },
      publication_plan: { ok: true }
    });
    expect(await provider.verify(receipt)).toMatchObject({
      status: "verified",
      reason_code: "MAP_RECEIPT_VERIFIED"
    });
    expect(execution.calls).toEqual({ execute: 1, readback: 1, rollback: 0 });
  });

  it("rolls an applied publication back through the compensation seam", async () => {
    const current = await fixture("codebase-map-sync-provider-v1-current.json");
    const execution = new InMemoryMapExecutionPort({ clock: () => new Date(completedAt) });
    const provider = createCodebaseMapSyncProvider({
      inspection_input: current.inspection_input,
      publication_input: publicationInput,
      execution_port: execution,
      clock: () => new Date(completedAt)
    });
    const [finding] = await provider.inspect(context());
    expect(finding).toBeDefined();
    if (finding === undefined) return;
    const [action] = await provider.plan(context(), [finding.finding_id]);
    expect(action).toBeDefined();
    if (action === undefined) return;
    const receipt = await provider.apply(action, confirmation(action));

    expect(await provider.rollback(action, receipt)).toMatchObject({
      status: "rolled_back",
      reason_code: "MAP_ROLLBACK_COMPLETED"
    });
    expect(execution.calls.rollback).toBe(1);
  });

  it("fails closed before execution when the typed inspection input changes after planning", async () => {
    const current = await fixture("codebase-map-sync-provider-v1-current.json");
    let source = current.inspection_input;
    const execution = new InMemoryMapExecutionPort();
    const provider = createCodebaseMapSyncProvider({
      inspection_input: () => source,
      publication_input: publicationInput,
      execution_port: execution
    });
    const [finding] = await provider.inspect(context());
    expect(finding).toBeDefined();
    if (finding === undefined) return;
    const [action] = await provider.plan(context(), [finding.finding_id]);
    expect(action).toBeDefined();
    if (action === undefined) return;
    source = { ...source, affected_paths: [...source.affected_paths, "package.json"] };

    await expect(provider.apply(action, confirmation(action))).rejects.toMatchObject({
      code: "MAP_ACTION_STALE"
    });
    expect(execution.calls.execute).toBe(0);
  });

  it("keeps legacy Map fixtures read-only and offers a full current-format refresh", async () => {
    const legacy = await fixture("codebase-map-sync-provider-v0-legacy.json");
    const provider = createCodebaseMapSyncProvider({
      inspection_input: legacy.inspection_input,
      publication_input: publicationInput,
      execution_port: new InMemoryMapExecutionPort()
    });

    const findings = await provider.inspect(context());
    const actions = await provider.plan(context(), findings.map((finding) => finding.finding_id));
    expect(findings).toMatchObject([{
      reason_code: "MAP_LEGACY_IDENTITY_UNKNOWN",
      status: "WARN"
    }]);
    expect(actions).toMatchObject([{
      action_id: "codebase_map:refresh",
      model_access: true,
      network_access: false
    }]);
  });

  it("maps local Map conflicts to a high-risk action and never resolves them inside Sync", async () => {
    const current = await fixture("codebase-map-sync-provider-v1-current.json");
    const dirtyContext = context({
      dirty_paths: [".harness/codebase/map/ARCHITECTURE.md"]
    });
    const provider = createCodebaseMapSyncProvider({
      inspection_input: current.inspection_input,
      publication_input: publicationInput,
      execution_port: new InMemoryMapExecutionPort()
    });

    const findings = await provider.inspect(dirtyContext);
    const actions = await provider.plan(dirtyContext, findings.map((finding) => finding.finding_id));
    expect(findings).toMatchObject([{
      reason_code: "MAP_LOCAL_MODIFICATION_CONFLICT",
      status: "BLOCKED",
      urgency: "required"
    }]);
    expect(actions).toMatchObject([{ risk: "high", rollback_strategy: "automatic" }]);
  });

  it("retains the canonical Map when the execution Port fails before publication", async () => {
    const current = await fixture("codebase-map-sync-provider-v1-current.json");
    const execution = new InMemoryMapExecutionPort({ execute_error: new Error("mapper failed") });
    const provider = createCodebaseMapSyncProvider({
      inspection_input: current.inspection_input,
      publication_input: publicationInput,
      execution_port: execution
    });
    const [finding] = await provider.inspect(context());
    expect(finding).toBeDefined();
    if (finding === undefined) return;
    const [action] = await provider.plan(context(), [finding.finding_id]);
    expect(action).toBeDefined();
    if (action === undefined) return;

    await expect(provider.apply(action, confirmation(action))).rejects.toThrow("mapper failed");
    expect(execution.calls).toEqual({ execute: 1, readback: 0, rollback: 0 });
  });

  it("does not freeze or mutate the Adapter-owned inspection snapshot", async () => {
    const current = await fixture("codebase-map-sync-provider-v1-current.json");
    const source = current.inspection_input;
    const manifest = source.manifest as object;
    const provider = createCodebaseMapSyncProvider({
      inspection_input: source,
      publication_input: publicationInput,
      execution_port: new InMemoryMapExecutionPort()
    });

    await provider.inspect(context());
    expect(Object.isFrozen(source)).toBe(false);
    expect(Object.isFrozen(manifest)).toBe(false);
    expect(source.affected_paths).toEqual(["packages/core/src/example.ts"]);
  });

  it("rejects a tampered Sync receipt instead of trusting its hashes", async () => {
    const current = await fixture("codebase-map-sync-provider-v1-current.json");
    const provider = createCodebaseMapSyncProvider({
      inspection_input: current.inspection_input,
      publication_input: publicationInput,
      execution_port: new InMemoryMapExecutionPort({ clock: () => new Date(completedAt) }),
      clock: () => new Date(completedAt)
    });
    const [finding] = await provider.inspect(context());
    expect(finding).toBeDefined();
    if (finding === undefined) return;
    const [action] = await provider.plan(context(), [finding.finding_id]);
    expect(action).toBeDefined();
    if (action === undefined) return;
    const receipt = await provider.apply(action, confirmation(action));

    await expect(provider.verify({
      ...receipt,
      modified_paths: receipt.modified_paths.slice(1)
    })).rejects.toMatchObject({ code: "MAP_EXECUTION_RECEIPT_NOT_FOUND" });
  });

  it("satisfies the Stage 04 transaction contract end to end", async () => {
    const current = await fixture("codebase-map-sync-provider-v1-current.json");
    const provider = createCodebaseMapSyncProvider({
      inspection_input: current.inspection_input,
      publication_input: publicationInput,
      execution_port: new InMemoryMapExecutionPort({ clock: () => new Date(completedAt) }),
      clock: () => new Date(completedAt)
    });
    const sync = createSyncMaintenanceModule({
      providers: [provider],
      clock: () => new Date(completedAt)
    });
    const plan = await sync.inspect(context());
    const action = plan.actions[0];
    expect(action).toBeDefined();
    if (action === undefined) return;

    const result = await sync.apply(plan.plan_id, plan.preview_hash, [action.action_id], {
      schema_version: 1,
      plan_id: plan.plan_id,
      preview_hash: plan.preview_hash,
      approved_action_ids: [action.action_id],
      allow_writes: true,
      allow_network: false,
      allow_model: true,
      confirmed_at: completedAt
    });

    expect(result).toMatchObject({
      applied_action_ids: ["codebase_map:refresh"],
      no_changes: false,
      verifications: [{ status: "verified" }]
    });
    expect(result.changed_paths).toEqual(action.expected_writes);
    expect(result).not.toHaveProperty("remote_sync_request_intent");
  });

  it("compensates an effectful execution before rejecting an invalid Map receipt", async () => {
    const current = await fixture("codebase-map-sync-provider-v1-current.json");
    const execution = new InMemoryMapExecutionPort({
      verification: {
        seven_documents_valid: true,
        references_valid: false,
        sensitive_scan_passed: true,
        atomic_publication_completed: true
      }
    });
    const provider = createCodebaseMapSyncProvider({
      inspection_input: current.inspection_input,
      publication_input: publicationInput,
      execution_port: execution
    });
    const [finding] = await provider.inspect(context());
    expect(finding).toBeDefined();
    if (finding === undefined) return;
    const [action] = await provider.plan(context(), [finding.finding_id]);
    expect(action).toBeDefined();
    if (action === undefined) return;

    await expect(provider.apply(action, confirmation(action))).rejects.toMatchObject({
      code: "MAP_EXECUTION_RECEIPT_INVALID"
    });
    expect(execution.calls).toEqual({ execute: 1, readback: 0, rollback: 1 });
  });

  it.each([
    ["branch_name", "other"],
    ["worktree_identity", "other-worktree"],
    ["source_commit", "cccccccccccccccccccccccccccccccccccccccc"]
  ] as const)("rejects publication identity drift in %s", async (field, value) => {
    const current = await fixture("codebase-map-sync-provider-v1-current.json");
    const provider = createCodebaseMapSyncProvider({
      inspection_input: current.inspection_input,
      publication_input: (health) => {
        const proposal = publicationInput(health);
        return {
          ...proposal,
          manifest_draft: { ...proposal.manifest_draft, [field]: value }
        };
      },
      execution_port: new InMemoryMapExecutionPort()
    });
    const findings = await provider.inspect(context());

    await expect(provider.plan(context(), findings.map((finding) => finding.finding_id)))
      .rejects.toMatchObject({ code: "MAP_PUBLICATION_PLAN_INVALID" });
  });

  it("rejects an incremental publication that omits an affected Map document", async () => {
    const current = await fixture("codebase-map-sync-provider-v1-current.json");
    const provider = createCodebaseMapSyncProvider({
      inspection_input: current.inspection_input,
      publication_input: (health) => {
        const proposal = publicationInput(health);
        return {
          ...proposal,
          affected_documents: proposal.affected_documents.slice(1),
          proposed_documents: Object.fromEntries(
            Object.entries(proposal.proposed_documents).slice(1)
          )
        };
      },
      execution_port: new InMemoryMapExecutionPort()
    });
    const findings = await provider.inspect(context());

    await expect(provider.plan(context(), findings.map((finding) => finding.finding_id)))
      .rejects.toMatchObject({ code: "MAP_PUBLICATION_PLAN_INVALID" });
  });

  it("compensates a structurally invalid execution receipt instead of accepting self-reported success", async () => {
    const current = await fixture("codebase-map-sync-provider-v1-current.json");
    class InvalidExecutionReceiptPort extends InMemoryMapExecutionPort {
      override async execute(request: MapExecutionRequest) {
        const result = await super.execute(request);
        return {
          ...result,
          receipt: {
            ...result.receipt,
            execution: {
              ...result.receipt.execution,
              provider: "",
              model: "",
              duration_ms: -1,
              input_tokens: -1,
              output_tokens: -1,
              model_attempts: 99
            }
          }
        };
      }
    }
    const execution = new InvalidExecutionReceiptPort();
    const provider = createCodebaseMapSyncProvider({
      inspection_input: current.inspection_input,
      publication_input: publicationInput,
      execution_port: execution
    });
    const findings = await provider.inspect(context());
    const [action] = await provider.plan(context(), findings.map((finding) => finding.finding_id));
    expect(action).toBeDefined();
    if (action === undefined) return;

    await expect(provider.apply(action, confirmation(action))).rejects.toMatchObject({
      code: "MAP_EXECUTION_RECEIPT_INVALID"
    });
    expect(execution.calls.rollback).toBe(1);
  });

  it("rejects execution receipt schema drift and compensates the publication", async () => {
    const current = await fixture("codebase-map-sync-provider-v1-current.json");
    class DriftedReceiptPort extends InMemoryMapExecutionPort {
      override async execute(request: MapExecutionRequest) {
        const result = await super.execute(request);
        return {
          ...result,
          receipt: { ...result.receipt, invented_field: true }
        };
      }
    }
    const execution = new DriftedReceiptPort();
    const provider = createCodebaseMapSyncProvider({
      inspection_input: current.inspection_input,
      publication_input: publicationInput,
      execution_port: execution
    });
    const findings = await provider.inspect(context());
    const [action] = await provider.plan(context(), findings.map((finding) => finding.finding_id));
    expect(action).toBeDefined();
    if (action === undefined) return;

    await expect(provider.apply(action, confirmation(action))).rejects.toMatchObject({
      code: "MAP_EXECUTION_RECEIPT_INVALID"
    });
    expect(execution.calls.rollback).toBe(1);
  });

  it("rejects a custom-prototype execution receipt and compensates the publication", async () => {
    const current = await fixture("codebase-map-sync-provider-v1-current.json");
    class CustomReceiptPort extends InMemoryMapExecutionPort {
      override async execute(request: MapExecutionRequest) {
        const result = await super.execute(request);
        return {
          ...result,
          receipt: Object.assign(Object.create({ untrusted: true }) as object, result.receipt)
        } as typeof result;
      }
    }
    const execution = new CustomReceiptPort();
    const provider = createCodebaseMapSyncProvider({
      inspection_input: current.inspection_input,
      publication_input: publicationInput,
      execution_port: execution
    });
    const findings = await provider.inspect(context());
    const [action] = await provider.plan(context(), findings.map((finding) => finding.finding_id));
    expect(action).toBeDefined();
    if (action === undefined) return;

    await expect(provider.apply(action, confirmation(action))).rejects.toMatchObject({
      code: "MAP_EXECUTION_RECEIPT_INVALID"
    });
    expect(execution.calls.rollback).toBe(1);
  });

  it("keeps CodeGraph degradation readable alongside a refresh finding without duplicating actions", async () => {
    const current = await fixture("codebase-map-sync-provider-v1-current.json");
    const provider = createCodebaseMapSyncProvider({
      inspection_input: {
        ...current.inspection_input,
        feature_flags: {
          ...current.inspection_input.feature_flags,
          codegraph_available: false
        }
      },
      publication_input: publicationInput,
      execution_port: new InMemoryMapExecutionPort()
    });
    const findings = await provider.inspect(context());
    const actions = await provider.plan(context(), findings.map((finding) => finding.finding_id));

    expect(findings).toMatchObject([
      { reason_code: "MAP_SOURCE_COMMIT_CHANGED", status: "WARN" },
      { reason_code: "MAP_CODEGRAPH_UNAVAILABLE", status: "ADVISORY", urgency: "optional" }
    ]);
    expect(actions).toHaveLength(1);
  });

  it("returns stable evidence when invalid execution compensation fails", async () => {
    const current = await fixture("codebase-map-sync-provider-v1-current.json");
    const execution = new InMemoryMapExecutionPort({
      rollback_succeeds: false,
      verification: {
        seven_documents_valid: true,
        references_valid: false,
        sensitive_scan_passed: true,
        atomic_publication_completed: true
      }
    });
    const provider = createCodebaseMapSyncProvider({
      inspection_input: current.inspection_input,
      publication_input: publicationInput,
      execution_port: execution
    });
    const findings = await provider.inspect(context());
    const [action] = await provider.plan(context(), findings.map((finding) => finding.finding_id));
    expect(action).toBeDefined();
    if (action === undefined) return;

    const receipt = await provider.apply(action, confirmation(action));
    expect(receipt).toMatchObject({
      wrote: true,
      evidence_sources: [
        "map_publication_plan",
        "map_execution_receipt",
        "MAP_EXECUTION_COMPENSATION_FAILED"
      ],
      rollback: { strategy: "automatic", available: true }
    });
    expect(await provider.verify(receipt)).toMatchObject({
      status: "failed",
      reason_code: "MAP_EXECUTION_COMPENSATION_FAILED"
    });
    expect(await provider.rollback(action, receipt)).toMatchObject({
      status: "failed",
      reason_code: "MAP_EXECUTION_COMPENSATION_FAILED"
    });
    expect(execution.calls.rollback).toBe(1);
  });

  it("exposes compensation failure to Stage 04 without retrying the physical rollback", async () => {
    const current = await fixture("codebase-map-sync-provider-v1-current.json");
    const execution = new InMemoryMapExecutionPort({
      rollback_succeeds: false,
      verification: {
        seven_documents_valid: true,
        references_valid: false,
        sensitive_scan_passed: true,
        atomic_publication_completed: true
      }
    });
    const provider = createCodebaseMapSyncProvider({
      inspection_input: current.inspection_input,
      publication_input: publicationInput,
      execution_port: execution,
      clock: () => new Date(completedAt)
    });
    const sync = createSyncMaintenanceModule({
      providers: [provider],
      clock: () => new Date(completedAt)
    });
    const plan = await sync.inspect(context());
    const action = plan.actions[0];
    expect(action).toBeDefined();
    if (action === undefined) return;

    await expect(sync.apply(plan.plan_id, plan.preview_hash, [action.action_id], {
      schema_version: 1,
      plan_id: plan.plan_id,
      preview_hash: plan.preview_hash,
      approved_action_ids: [action.action_id],
      allow_writes: true,
      allow_network: false,
      allow_model: true,
      confirmed_at: completedAt
    })).rejects.toMatchObject({
      code: "SYNC_ROLLBACK_FAILED",
      failure_evidence: {
        reason_code: "PROVIDER_VERIFICATION_FAILED",
        receipts: [{
          evidence_sources: expect.arrayContaining(["MAP_EXECUTION_COMPENSATION_FAILED"])
        }],
        rollback_receipts: [{
          status: "failed",
          reason_code: "MAP_EXECUTION_COMPENSATION_FAILED"
        }]
      }
    });
    expect(execution.calls.rollback).toBe(1);
  });

  it.each([
    ["numeric rollback token", (result: Awaited<ReturnType<InMemoryMapExecutionPort["execute"]>>) => ({
      ...result,
      rollback_token: 7
    })],
    ["non-string changed document", (result: Awaited<ReturnType<InMemoryMapExecutionPort["execute"]>>) => ({
      ...result,
      receipt: { ...result.receipt, changed_documents: [7] }
    })],
    ["changed document array with an extra property", (
      result: Awaited<ReturnType<InMemoryMapExecutionPort["execute"]>>
    ) => {
      const changed = [...result.receipt.changed_documents];
      Object.defineProperty(changed, "extra", { value: true, enumerable: true });
      return { ...result, receipt: { ...result.receipt, changed_documents: changed } };
    }],
    ["custom-prototype modified paths", (result: Awaited<ReturnType<InMemoryMapExecutionPort["execute"]>>) => {
      const paths = [...result.modified_paths];
      Object.setPrototypeOf(paths, { inherited: true });
      return { ...result, modified_paths: paths };
    }],
    ["duplicate modified path", (result: Awaited<ReturnType<InMemoryMapExecutionPort["execute"]>>) => ({
      ...result,
      modified_paths: [...result.modified_paths, result.modified_paths[0]]
    })],
    ["duplicate changed document", (result: Awaited<ReturnType<InMemoryMapExecutionPort["execute"]>>) => ({
      ...result,
      receipt: {
        ...result.receipt,
        changed_documents: [...result.receipt.changed_documents, result.receipt.changed_documents[0]]
      }
    })],
    ["sparse preserved documents", (result: Awaited<ReturnType<InMemoryMapExecutionPort["execute"]>>) => {
      const preserved = [...result.receipt.preserved_documents];
      delete preserved[0];
      return { ...result, receipt: { ...result.receipt, preserved_documents: preserved } };
    }],
    ["non-canonical changed documents", (
      result: Awaited<ReturnType<InMemoryMapExecutionPort["execute"]>>
    ) => ({
      ...result,
      receipt: { ...result.receipt, changed_documents: [...result.receipt.changed_documents].reverse() }
    })],
    ["non-RFC3339 completion time", (result: Awaited<ReturnType<InMemoryMapExecutionPort["execute"]>>) => ({
      ...result,
      receipt: { ...result.receipt, completed_at: "2026-08-13" }
    })],
    ["impossible RFC3339 calendar date", (
      result: Awaited<ReturnType<InMemoryMapExecutionPort["execute"]>>
    ) => ({
      ...result,
      receipt: { ...result.receipt, completed_at: "2026-02-30T00:00:00Z" }
    })],
    ["RFC3339 hour 24", (result: Awaited<ReturnType<InMemoryMapExecutionPort["execute"]>>) => ({
      ...result,
      receipt: { ...result.receipt, completed_at: "2026-01-01T24:00:00Z" }
    })]
  ])("compensates hostile effectful result: %s", async (_label, mutate) => {
    const current = await fixture("codebase-map-sync-provider-v1-current.json");
    class HostileExecutionPort extends InMemoryMapExecutionPort {
      override async execute(request: MapExecutionRequest) {
        return mutate(await super.execute(request)) as Awaited<ReturnType<InMemoryMapExecutionPort["execute"]>>;
      }
    }
    const execution = new HostileExecutionPort();
    const provider = createCodebaseMapSyncProvider({
      inspection_input: current.inspection_input,
      publication_input: publicationInput,
      execution_port: execution
    });
    const findings = await provider.inspect(context());
    const [action] = await provider.plan(context(), findings.map((finding) => finding.finding_id));
    expect(action).toBeDefined();
    if (action === undefined) return;

    await expect(provider.apply(action, confirmation(action))).rejects.toMatchObject({
      code: "MAP_EXECUTION_RECEIPT_INVALID"
    });
    expect(execution.calls.rollback).toBe(1);
  });

  it.each([
    "2026-01-01T00:00:00Z",
    "2026-01-01T08:00:00+08:00"
  ])("accepts a strict RFC3339 completion time: %s", async (completed_at) => {
    const current = await fixture("codebase-map-sync-provider-v1-current.json");
    class TimestampExecutionPort extends InMemoryMapExecutionPort {
      override async execute(request: MapExecutionRequest) {
        const result = await super.execute(request);
        return { ...result, receipt: { ...result.receipt, completed_at } };
      }
    }
    const execution = new TimestampExecutionPort();
    const provider = createCodebaseMapSyncProvider({
      inspection_input: current.inspection_input,
      publication_input: publicationInput,
      execution_port: execution
    });
    const findings = await provider.inspect(context());
    const [action] = await provider.plan(context(), findings.map((finding) => finding.finding_id));
    expect(action).toBeDefined();
    if (action === undefined) return;

    await expect(provider.apply(action, confirmation(action))).resolves.toMatchObject({ completed_at });
    expect(execution.calls.rollback).toBe(0);
  });

  it("compensates a failed readback verification before returning failed", async () => {
    const current = await fixture("codebase-map-sync-provider-v1-current.json");
    class MismatchedReadbackPort extends InMemoryMapExecutionPort {
      override async readback(operation_id: string) {
        const readback = await super.readback(operation_id);
        return { ...readback, manifest_hash: stableHash("tampered") };
      }
    }
    const execution = new MismatchedReadbackPort();
    const provider = createCodebaseMapSyncProvider({
      inspection_input: current.inspection_input,
      publication_input: publicationInput,
      execution_port: execution
    });
    const findings = await provider.inspect(context());
    const [action] = await provider.plan(context(), findings.map((finding) => finding.finding_id));
    expect(action).toBeDefined();
    if (action === undefined) return;
    const receipt = await provider.apply(action, confirmation(action));

    expect(await provider.verify(receipt)).toMatchObject({
      status: "failed",
      reason_code: "MAP_RECEIPT_MISMATCH"
    });
    expect(execution.calls).toEqual({ execute: 1, readback: 1, rollback: 1 });
    expect(await provider.rollback(action, receipt)).toMatchObject({ status: "rolled_back" });
    expect(execution.calls.rollback).toBe(1);
  });

  it("keeps the first readback compensation failure terminal without retrying rollback", async () => {
    const current = await fixture("codebase-map-sync-provider-v1-current.json");
    class MismatchedReadbackPort extends InMemoryMapExecutionPort {
      override async readback(operation_id: string) {
        const readback = await super.readback(operation_id);
        return { ...readback, manifest_hash: stableHash("tampered") };
      }
    }
    const execution = new MismatchedReadbackPort({ rollback_succeeds: false });
    const provider = createCodebaseMapSyncProvider({
      inspection_input: current.inspection_input,
      publication_input: publicationInput,
      execution_port: execution
    });
    const findings = await provider.inspect(context());
    const [action] = await provider.plan(context(), findings.map((finding) => finding.finding_id));
    expect(action).toBeDefined();
    if (action === undefined) return;
    const receipt = await provider.apply(action, confirmation(action));

    expect(await provider.verify(receipt)).toMatchObject({
      status: "failed",
      reason_code: "MAP_EXECUTION_COMPENSATION_FAILED"
    });
    expect(await provider.rollback(action, receipt)).toMatchObject({
      status: "failed",
      reason_code: "MAP_EXECUTION_COMPENSATION_FAILED"
    });
    expect(execution.calls.rollback).toBe(1);
  });

  it.each([
    ["null", () => null],
    ["accessor", () => Object.defineProperty({}, "rolled_back", {
      enumerable: true,
      get() { throw new Error("hostile getter"); }
    })],
    ["schema drift", () => ({ rolled_back: false, invented: true })]
  ])("keeps hostile rollback output terminal through Stage 04: %s", async (_label, rawResult) => {
    const current = await fixture("codebase-map-sync-provider-v1-current.json");
    class HostileRollbackPort extends InMemoryMapExecutionPort {
      override async readback(operation_id: string) {
        const readback = await super.readback(operation_id);
        return { ...readback, manifest_hash: stableHash("tampered") };
      }

      override async rollback() {
        this.calls.rollback += 1;
        return rawResult() as never;
      }
    }
    const execution = new HostileRollbackPort({ clock: () => new Date(completedAt) });
    const provider = createCodebaseMapSyncProvider({
      inspection_input: current.inspection_input,
      publication_input: publicationInput,
      execution_port: execution,
      clock: () => new Date(completedAt)
    });
    const sync = createSyncMaintenanceModule({
      providers: [provider],
      clock: () => new Date(completedAt)
    });
    const plan = await sync.inspect(context());
    const action = plan.actions[0];
    expect(action).toBeDefined();
    if (action === undefined) return;

    await expect(sync.apply(plan.plan_id, plan.preview_hash, [action.action_id], {
      schema_version: 1,
      plan_id: plan.plan_id,
      preview_hash: plan.preview_hash,
      approved_action_ids: [action.action_id],
      allow_writes: true,
      allow_network: false,
      allow_model: true,
      confirmed_at: completedAt
    })).rejects.toMatchObject({
      code: "SYNC_ROLLBACK_FAILED",
      failure_evidence: {
        reason_code: "PROVIDER_VERIFICATION_FAILED",
        rollback_receipts: [{
          status: "failed",
          reason_code: "MAP_EXECUTION_COMPENSATION_FAILED"
        }]
      }
    });
    expect(execution.calls.rollback).toBe(1);
  });

  it("makes successful readback compensation a stable repeated-verify terminal", async () => {
    const current = await fixture("codebase-map-sync-provider-v1-current.json");
    class MismatchedReadbackPort extends InMemoryMapExecutionPort {
      override async readback(operation_id: string) {
        const readback = await super.readback(operation_id);
        return { ...readback, manifest_hash: stableHash("tampered") };
      }
    }
    const execution = new MismatchedReadbackPort({ clock: () => new Date(completedAt) });
    const provider = createCodebaseMapSyncProvider({
      inspection_input: current.inspection_input,
      publication_input: publicationInput,
      execution_port: execution,
      clock: () => new Date(completedAt)
    });
    const findings = await provider.inspect(context());
    const [action] = await provider.plan(context(), findings.map((finding) => finding.finding_id));
    expect(action).toBeDefined();
    if (action === undefined) return;
    const receipt = await provider.apply(action, confirmation(action));

    const first = await provider.verify(receipt);
    const second = await provider.verify(receipt);
    expect(second).toEqual(first);
    expect(execution.calls).toEqual({ execute: 1, readback: 1, rollback: 1 });
  });
});
