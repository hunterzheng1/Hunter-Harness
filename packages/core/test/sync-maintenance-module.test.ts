import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  InMemorySyncActionProvider,
  SyncMaintenanceError,
  createSyncMaintenanceModule,
  createSyncContext,
  normalizeSyncMaintenanceRecord,
  type SyncActionPlan,
  type SyncActionReceipt,
  type SyncContext,
  type SyncFinding,
  type SyncRollbackReceipt,
  type SyncVerification
} from "../src/sync-maintenance/index.js";

const now = "2026-08-13T10:00:00.000Z";
const later = "2026-08-13T10:05:00.000Z";

function context(overrides: Partial<Omit<SyncContext, "context_hash">> = {}): SyncContext {
  return createSyncContext({
    schema_version: 1,
    project_identity: "hunter-harness",
    repository_identity: "repo:hunter-harness",
    worktree_identity: "worktree:main",
    current_commit: "a".repeat(40),
    upstream_ref: "origin/main",
    project_change_set: {
      schema_version: 1,
      baseline_available: true,
      dirty_paths: [],
      untracked_paths: []
    },
    enabled_agents: ["codex", "claude-code"],
    agent_profiles: { codex: "general", "claude-code": "java" },
    platform_binding: { project_id: "project-1" },
    feature_flags: { codegraph: false },
    ...overrides
  });
}

function finding(
  provider_id: string,
  finding_id: string,
  overrides: Partial<SyncFinding> = {}
): SyncFinding {
  return {
    schema_version: 1,
    finding_id,
    provider_id,
    status: "WARN",
    urgency: "recommended",
    reason_code: "CONTENT_DRIFT",
    display_title_zh: "内容存在漂移",
    display_message_zh: "建议更新受管投影。",
    evidence: {
      source: "provider_inspection",
      input_hash: `sha256:${"1".repeat(64)}`,
      observed_hash: `sha256:${"2".repeat(64)}`
    },
    ...overrides
  };
}

function action(
  provider_id: string,
  action_id: string,
  overrides: Partial<SyncActionPlan> = {}
): SyncActionPlan {
  return {
    schema_version: 1,
    action_id,
    provider_id,
    finding_ids: [`${provider_id}:drift`],
    depends_on: [],
    conflicts_with: [],
    invalidates_providers: [provider_id],
    expected_writes: [`.harness/generated/${provider_id}.json`],
    network_access: false,
    model_access: false,
    risk: "low",
    rollback_strategy: "automatic",
    invalidation_hash: `sha256:${"3".repeat(64)}`,
    estimated_duration_ms: 10,
    ...overrides
  };
}

function receipt(
  provider_id: string,
  action_id: string,
  overrides: Partial<SyncActionReceipt> = {}
): SyncActionReceipt {
  return {
    schema_version: 1,
    action_id,
    provider_id,
    input_hash: `sha256:${"3".repeat(64)}`,
    output_hash: `sha256:${"4".repeat(64)}`,
    evidence_sources: ["post_apply_readback"],
    wrote: true,
    modified_paths: [`.harness/generated/${provider_id}.json`],
    rollback: { strategy: "automatic", available: true, rollback_token: `${action_id}:rollback` },
    auto_fixed: true,
    duration_ms: 5,
    completed_at: now,
    ...overrides
  };
}

function verification(provider_id: string, action_id: string): SyncVerification {
  return {
    schema_version: 1,
    action_id,
    provider_id,
    status: "verified",
    reason_code: "POST_APPLY_MATCH",
    evidence_hash: `sha256:${"5".repeat(64)}`,
    verified_at: now
  };
}

function rollbackReceipt(
  provider_id: string,
  action_id: string,
  status: SyncRollbackReceipt["status"] = "rolled_back"
): SyncRollbackReceipt {
  return {
    schema_version: 1,
    action_id,
    provider_id,
    status,
    reason_code: status === "rolled_back" ? "ROLLBACK_VERIFIED" : "ROLLBACK_FAILED",
    evidence_hash: `sha256:${"6".repeat(64)}`,
    completed_at: now
  };
}

describe("SyncMaintenance Module v1 read-only planning", () => {
  it("separates applicability, status and urgency while isolating provider failure", async () => {
    const healthy = new InMemorySyncActionProvider({
      provider_id: "adapter",
      applicability: { applicability: "applicable", reason_code: "ADAPTER_CONFIGURED" },
      findings: [
        finding("adapter", "adapter:drift"),
        finding("adapter", "adapter:review", {
          status: "ADVISORY",
          urgency: "required",
          reason_code: "REVIEW_REQUIRED"
        })
      ],
      actions: [action("adapter", "adapter:update")]
    });
    const skipped = new InMemorySyncActionProvider({
      provider_id: "codegraph",
      applicability: { applicability: "not_applicable", reason_code: "FEATURE_NOT_ENABLED" }
    });
    const failed = new InMemorySyncActionProvider({
      provider_id: "change",
      applicability: { applicability: "applicable", reason_code: "ACTIVE_CHANGE" },
      inspect_error: new Error("python unavailable")
    });
    const sync = createSyncMaintenanceModule({
      providers: [healthy, skipped, failed],
      clock: () => new Date(now),
      plan_ttl_ms: 300_000,
      max_concurrency: 2
    });

    const plan = await sync.inspect(context());

    expect(plan.provider_results).toEqual([
      expect.objectContaining({
        provider_id: "adapter",
        applicability: "applicable",
        status: "WARN",
        urgency: "required",
        reason_code: "CONTENT_DRIFT"
      }),
      expect.objectContaining({
        provider_id: "change",
        applicability: "unavailable",
        status: "UNKNOWN",
        urgency: "none",
        reason_code: "PROVIDER_INSPECTION_FAILED"
      }),
      expect.objectContaining({
        provider_id: "codegraph",
        applicability: "not_applicable",
        status: "UNKNOWN",
        urgency: "none",
        reason_code: "FEATURE_NOT_ENABLED"
      })
    ]);
    expect(plan.actions.map((item) => item.action_id)).toEqual(["adapter:update"]);
    expect(plan.summary).toMatchObject({
      schema_version: 1,
      provider_count: 3,
      not_applicable_count: 1,
      unavailable_count: 1,
      status_counts: { WARN: 1, UNKNOWN: 2 }
    });
    expect(healthy.calls).toMatchObject({ applicable: 1, inspect: 1, plan: 1, apply: 0 });
    expect(skipped.calls).toMatchObject({ applicable: 1, inspect: 0, plan: 0, apply: 0 });
    expect(failed.calls).toMatchObject({ applicable: 1, inspect: 1, plan: 0, apply: 0 });
  });

  it("keeps bounded planning concurrency and does not serialize independent providers", async () => {
    let active = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const providers = ["one", "two", "three"].map((provider_id) => ({
      provider_id,
      async applicable() {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => release.push(resolve));
        active -= 1;
        return { applicability: "not_applicable" as const, reason_code: "FEATURE_NOT_ENABLED" };
      },
      async inspect() { return []; },
      async plan() { return []; },
      async apply() { throw new Error("not applicable"); },
      async verify() { throw new Error("not applicable"); },
      async rollback() { throw new Error("not applicable"); }
    }));
    const sync = createSyncMaintenanceModule({
      providers, clock: () => new Date(now), max_concurrency: 2
    });
    const pending = sync.inspect(context());
    await vi.waitFor(() => expect(release).toHaveLength(2));
    release.splice(0).forEach((resolve) => resolve());
    await vi.waitFor(() => expect(release).toHaveLength(1));
    release.splice(0).forEach((resolve) => resolve());
    await pending;
    expect(peak).toBe(2);
  });

  it("rejects incomplete agent profiles and non-normalized optional identities", () => {
    const { context_hash: _contextHash, ...valid } = context();
    void _contextHash;
    const accessorProfiles = Object.defineProperty({}, "codex", {
      enumerable: true,
      get: () => { throw new Error("profile accessor must not execute"); }
    }) as Readonly<Record<string, string>>;
    const customPrototypeProfiles = Object.assign(Object.create({ inherited: true }), {
      codex: "general"
    }) as Readonly<Record<string, string>>;
    const tooManyAgents = Array.from({ length: 33 }, (_, index) => `agent-${index}`);
    const invalidInputs = [
      { ...valid, enabled_agents: [], agent_profiles: {} },
      {
        ...valid,
        enabled_agents: ["0"],
        agent_profiles: ["general"] as unknown as Readonly<Record<string, string>>
      },
      { ...valid, enabled_agents: ["codex", "claude-code"], agent_profiles: { codex: "general" } },
      { ...valid, enabled_agents: ["codex"], agent_profiles: { codex: "general", extra: "java" } },
      { ...valid, enabled_agents: ["codex"], agent_profiles: { codex: "" } },
      { ...valid, enabled_agents: ["codex"], agent_profiles: { codex: " general " } },
      { ...valid, enabled_agents: ["codex"], agent_profiles: { codex: "x".repeat(129) } },
      { ...valid, enabled_agents: ["codex"], agent_profiles: accessorProfiles },
      { ...valid, enabled_agents: ["codex"], agent_profiles: customPrototypeProfiles },
      {
        ...valid,
        enabled_agents: tooManyAgents,
        agent_profiles: Object.fromEntries(tooManyAgents.map((agent) => [agent, "general"]))
      },
      { ...valid, enabled_agents: [`agent-${"x".repeat(64)}`], agent_profiles: {} },
      { ...valid, repository_identity: " repo:hunter-harness" },
      { ...valid, worktree_identity: "" },
      { ...valid, upstream_ref: " " },
      { ...valid, upstream_ref: "origin\\main" },
      { ...valid, platform_binding: { project_id: " project-1" } }
    ];

    for (const invalid of invalidInputs) {
      expect(() => createSyncContext(invalid)).toThrowError(
        expect.objectContaining({ code: "SYNC_CONTEXT_INVALID" })
      );
    }
    const nullPrototypeProfiles = Object.assign(Object.create(null), { codex: "general" }) as
      Readonly<Record<string, string>>;
    const normalized = createSyncContext({
      ...valid,
      enabled_agents: ["codex"],
      agent_profiles: nullPrototypeProfiles
    });
    expect(normalized.agent_profiles).toEqual({ codex: "general" });
    expect(Object.isFrozen(normalized.enabled_agents)).toBe(true);
    expect(Object.isFrozen(normalized.agent_profiles)).toBe(true);
  });

  it("keeps preview identity independent from localeCompare monkeypatching", async () => {
    const providers = () => ["zeta", "alpha"].map((provider_id) =>
      new InMemorySyncActionProvider({
        provider_id,
        applicability: { applicability: "applicable", reason_code: "PROVIDER_CONFIGURED" },
        findings: [finding(provider_id, `${provider_id}:drift`)],
        actions: [action(provider_id, `${provider_id}:update`)]
      }));
    const baseline = await createSyncMaintenanceModule({
      providers: providers(), clock: () => new Date(now)
    }).inspect(context());
    const localeCompare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(
      function reverse(this: string, other: string): number {
        return this < other ? 1 : this > other ? -1 : 0;
      }
    );
    try {
      const attacked = await createSyncMaintenanceModule({
        providers: providers(), clock: () => new Date(now)
      }).inspect(context());
      expect(attacked.preview_hash).toBe(baseline.preview_hash);
      expect(attacked.plan_id).toBe(baseline.plan_id);
    } finally {
      localeCompare.mockRestore();
    }
  });
});

describe("SyncMaintenance Module v1 protected apply", () => {
  it("requires a closed, conflict-free selection and an exact confirmation", async () => {
    const provider = new InMemorySyncActionProvider({
      provider_id: "config",
      applicability: { applicability: "applicable", reason_code: "CONFIG_PRESENT" },
      findings: [finding("config", "config:drift")],
      actions: [
        action("config", "config:prepare", { expected_writes: [] }),
        action("config", "config:update", { depends_on: ["config:prepare"] }),
        action("config", "config:alternative", { conflicts_with: ["config:update"] })
      ],
      receipts: {
        "config:prepare": receipt("config", "config:prepare", {
          wrote: false,
          modified_paths: [],
          output_hash: `sha256:${"3".repeat(64)}`,
          rollback: { strategy: "automatic", available: false },
          auto_fixed: false
        }),
        "config:update": receipt("config", "config:update"),
        "config:alternative": receipt("config", "config:alternative")
      },
      verifications: {
        "config:prepare": verification("config", "config:prepare"),
        "config:update": verification("config", "config:update"),
        "config:alternative": verification("config", "config:alternative")
      }
    });
    const sync = createSyncMaintenanceModule({
      providers: [provider], clock: () => new Date(now)
    });
    const plan = await sync.inspect(context());
    const confirmation = (ids: readonly string[]) => ({
      schema_version: 1 as const,
      plan_id: plan.plan_id,
      preview_hash: plan.preview_hash,
      approved_action_ids: ids,
      allow_writes: true,
      allow_network: false,
      allow_model: false,
      confirmed_at: now
    });

    await expect(sync.apply(
      plan.plan_id, plan.preview_hash, ["config:update"], confirmation(["config:update"])
    )).rejects.toMatchObject({ code: "SYNC_ACTION_SELECTION_INVALID" });
    await expect(sync.apply(
      plan.plan_id,
      plan.preview_hash,
      ["config:prepare", "config:update", "config:alternative"],
      confirmation(["config:prepare", "config:update", "config:alternative"])
    )).rejects.toMatchObject({ code: "SYNC_ACTION_SELECTION_INVALID" });
    await expect(sync.apply(
      plan.plan_id,
      plan.preview_hash,
      ["config:prepare", "config:update"],
      { ...confirmation(["config:prepare", "config:update"]), allow_writes: false }
    )).rejects.toMatchObject({ code: "SYNC_CONFIRMATION_REQUIRED" });
  });

  it("rejects expired, stale and replayed plans before provider apply", async () => {
    let current = new Date(now);
    const provider = new InMemorySyncActionProvider({
      provider_id: "adapter",
      applicability: { applicability: "applicable", reason_code: "ADAPTER_CONFIGURED" },
      findings: [finding("adapter", "adapter:drift")],
      actions: [action("adapter", "adapter:update")],
      receipts: { "adapter:update": receipt("adapter", "adapter:update") },
      verifications: { "adapter:update": verification("adapter", "adapter:update") }
    });
    const sync = createSyncMaintenanceModule({
      providers: [provider], clock: () => current, plan_ttl_ms: 1_000
    });
    const plan = await sync.inspect(context());
    const confirmation = {
      schema_version: 1 as const,
      plan_id: plan.plan_id,
      preview_hash: plan.preview_hash,
      approved_action_ids: ["adapter:update"],
      allow_writes: true,
      allow_network: false,
      allow_model: false,
      confirmed_at: now
    };

    await expect(sync.apply(
      plan.plan_id, `sha256:${"f".repeat(64)}`, ["adapter:update"], confirmation
    )).rejects.toMatchObject({ code: "SYNC_PLAN_STALE" });
    current = new Date(later);
    await expect(sync.apply(
      plan.plan_id, plan.preview_hash, ["adapter:update"], confirmation
    )).rejects.toMatchObject({ code: "SYNC_PLAN_EXPIRED" });
    expect(provider.calls.apply).toBe(0);
  });

  it("applies in dependency order, rechecks only invalidated providers and emits one intent", async () => {
    const applied: string[] = [];
    const config = new InMemorySyncActionProvider({
      provider_id: "config",
      applicability: { applicability: "applicable", reason_code: "CONFIG_PRESENT" },
      findings: [finding("config", "config:drift")],
      actions: [
        action("config", "config:prepare", {
          expected_writes: [],
          invalidates_providers: []
        }),
        action("config", "config:update", {
          depends_on: ["config:prepare"],
          invalidates_providers: ["config", "adapter"]
        })
      ],
      receipts: {
        "config:prepare": receipt("config", "config:prepare", {
          wrote: false,
          modified_paths: [],
          output_hash: `sha256:${"3".repeat(64)}`,
          rollback: { strategy: "automatic", available: false },
          auto_fixed: false
        }),
        "config:update": receipt("config", "config:update")
      },
      verifications: {
        "config:prepare": verification("config", "config:prepare"),
        "config:update": verification("config", "config:update")
      }
    });
    const originalApply = config.apply.bind(config);
    config.apply = async (item, confirmation) => {
      applied.push(item.action_id);
      return originalApply(item, confirmation);
    };
    const adapter = new InMemorySyncActionProvider({
      provider_id: "adapter",
      applicability: { applicability: "applicable", reason_code: "ADAPTER_CONFIGURED" },
      findings: [],
      actions: []
    });
    const untouched = new InMemorySyncActionProvider({
      provider_id: "codegraph",
      applicability: { applicability: "not_applicable", reason_code: "FEATURE_NOT_ENABLED" }
    });
    const sync = createSyncMaintenanceModule({
      providers: [config, adapter, untouched], clock: () => new Date(now)
    });
    const plan = await sync.inspect(context());
    const before = {
      config: { ...config.calls }, adapter: { ...adapter.calls }, untouched: { ...untouched.calls }
    };
    const ids = ["config:update", "config:prepare"];
    const result = await sync.apply(plan.plan_id, plan.preview_hash, ids, {
      schema_version: 1,
      plan_id: plan.plan_id,
      preview_hash: plan.preview_hash,
      approved_action_ids: ids,
      allow_writes: true,
      allow_network: false,
      allow_model: false,
      confirmed_at: now
    });

    expect(applied).toEqual(["config:prepare", "config:update"]);
    expect(result.changed_paths).toEqual([".harness/generated/config.json"]);
    expect(result.no_changes).toBe(false);
    expect(result.remote_sync_request_intent).toEqual(expect.objectContaining({
      schema_version: 1,
      changed_paths: [".harness/generated/config.json"],
      reason_code: "local_sync_changes_available"
    }));
    expect(result.rechecked_providers.map((item) => item.provider_id)).toEqual([
      "adapter", "config"
    ]);
    expect(adapter.calls.inspect).toBe(before.adapter.inspect + 1);
    expect(config.calls.inspect).toBe(before.config.inspect + 1);
    expect(untouched.calls).toEqual(before.untouched);
    await expect(sync.apply(plan.plan_id, plan.preview_hash, ids, {
      schema_version: 1,
      plan_id: plan.plan_id,
      preview_hash: plan.preview_hash,
      approved_action_ids: ids,
      allow_writes: true,
      allow_network: false,
      allow_model: false,
      confirmed_at: now
    })).rejects.toMatchObject({ code: "SYNC_PLAN_STALE" });
  });

  it("does not emit a remote intent when verified actions made no changes", async () => {
    const provider = new InMemorySyncActionProvider({
      provider_id: "rules",
      applicability: { applicability: "applicable", reason_code: "RULES_PRESENT" },
      findings: [finding("rules", "rules:inspect", {
        status: "ADVISORY", urgency: "optional", reason_code: "REVIEW_AVAILABLE"
      })],
      actions: [action("rules", "rules:inspect", {
        finding_ids: ["rules:inspect"], expected_writes: []
      })],
      receipts: {
        "rules:inspect": receipt("rules", "rules:inspect", {
          wrote: false,
          modified_paths: [],
          output_hash: `sha256:${"3".repeat(64)}`,
          rollback: { strategy: "automatic", available: false },
          auto_fixed: false
        })
      },
      verifications: { "rules:inspect": verification("rules", "rules:inspect") }
    });
    const sync = createSyncMaintenanceModule({ providers: [provider], clock: () => new Date(now) });
    const plan = await sync.inspect(context());
    const result = await sync.apply(plan.plan_id, plan.preview_hash, ["rules:inspect"], {
      schema_version: 1,
      plan_id: plan.plan_id,
      preview_hash: plan.preview_hash,
      approved_action_ids: ["rules:inspect"],
      allow_writes: false,
      allow_network: false,
      allow_model: false,
      confirmed_at: now
    });
    expect(result.no_changes).toBe(true);
    expect(result).not.toHaveProperty("remote_sync_request_intent");
  });

  it("rolls back successful actions in reverse topology and preserves failure evidence", async () => {
    const rollbackOrder: string[] = [];
    const providers = ["alpha", "beta", "gamma"].map((provider_id, index) => {
      const action_id = `${provider_id}:update`;
      const provider = new InMemorySyncActionProvider({
        provider_id,
        applicability: { applicability: "applicable", reason_code: "PROVIDER_CONFIGURED" },
        findings: [finding(provider_id, `${provider_id}:drift`)],
        actions: [action(provider_id, action_id, {
          depends_on: index === 0 ? [] : [`${["alpha", "beta"][index - 1]}:update`]
        })],
        receipts: { [action_id]: receipt(provider_id, action_id) },
        verifications: { [action_id]: verification(provider_id, action_id) },
        rollback_receipts: { [action_id]: rollbackReceipt(provider_id, action_id) },
        ...(provider_id === "gamma" ? {
          apply_errors: { [action_id]: new Error("gamma apply failed") }
        } : {})
      });
      const originalRollback = provider.rollback.bind(provider);
      provider.rollback = async (item, appliedReceipt) => {
        rollbackOrder.push(item.action_id);
        return originalRollback(item, appliedReceipt);
      };
      return provider;
    });
    const sync = createSyncMaintenanceModule({ providers, clock: () => new Date(now) });
    const plan = await sync.inspect(context());
    const ids = ["alpha:update", "beta:update", "gamma:update"];

    const failure = await sync.apply(plan.plan_id, plan.preview_hash, ids, {
      schema_version: 1,
      plan_id: plan.plan_id,
      preview_hash: plan.preview_hash,
      approved_action_ids: ids,
      allow_writes: true,
      allow_network: false,
      allow_model: false,
      confirmed_at: now
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "SYNC_APPLY_FAILED",
      retryable: false,
      failure_evidence: {
        failed_action_id: "gamma:update",
        reason_code: "PROVIDER_APPLY_FAILED",
        receipts: [
          expect.objectContaining({ action_id: "alpha:update" }),
          expect.objectContaining({ action_id: "beta:update" })
        ],
        rollback_receipts: [
          expect.objectContaining({ action_id: "beta:update", status: "rolled_back" }),
          expect.objectContaining({ action_id: "alpha:update", status: "rolled_back" })
        ]
      }
    });
    expect(rollbackOrder).toEqual(["beta:update", "alpha:update"]);
    await expect(sync.apply(plan.plan_id, plan.preview_hash, ids, {
      schema_version: 1,
      plan_id: plan.plan_id,
      preview_hash: plan.preview_hash,
      approved_action_ids: ids,
      allow_writes: true,
      allow_network: false,
      allow_model: false,
      confirmed_at: now
    })).rejects.toMatchObject({ code: "SYNC_PLAN_STALE" });
  });

  it("uses a stable rollback failure code and retains every available receipt", async () => {
    const provider = new InMemorySyncActionProvider({
      provider_id: "config",
      applicability: { applicability: "applicable", reason_code: "CONFIG_PRESENT" },
      findings: [finding("config", "config:drift")],
      actions: [
        action("config", "config:first"),
        action("config", "config:second", { depends_on: ["config:first"] })
      ],
      receipts: { "config:first": receipt("config", "config:first") },
      verifications: { "config:first": verification("config", "config:first") },
      apply_errors: { "config:second": new Error("second failed") },
      rollback_errors: { "config:first": new Error("rollback failed") }
    });
    const sync = createSyncMaintenanceModule({ providers: [provider], clock: () => new Date(now) });
    const plan = await sync.inspect(context());
    const ids = ["config:first", "config:second"];
    const failure = await sync.apply(plan.plan_id, plan.preview_hash, ids, {
      schema_version: 1,
      plan_id: plan.plan_id,
      preview_hash: plan.preview_hash,
      approved_action_ids: ids,
      allow_writes: true,
      allow_network: false,
      allow_model: false,
      confirmed_at: now
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "SYNC_ROLLBACK_FAILED",
      failure_evidence: {
        receipts: [expect.objectContaining({ action_id: "config:first" })],
        rollback_receipts: [expect.objectContaining({
          action_id: "config:first",
          status: "failed",
          reason_code: "PROVIDER_ROLLBACK_FAILED"
        })]
      }
    });
  });

  it.each([
    ["invalid receipt", "PROVIDER_RECEIPT_INVALID"],
    ["failed verification", "PROVIDER_VERIFICATION_FAILED"]
  ] as const)("rolls back and preserves the %s evidence", async (failureKind, reasonCode) => {
    const actionId = "config:update";
    const provider = new InMemorySyncActionProvider({
      provider_id: "config",
      applicability: { applicability: "applicable", reason_code: "CONFIG_PRESENT" },
      findings: [finding("config", "config:drift")],
      actions: [action("config", actionId)],
      receipts: {
        [actionId]: receipt("config", actionId, failureKind === "invalid receipt" ? {
          output_hash: `sha256:${"3".repeat(64)}`
        } : {})
      },
      verifications: {
        [actionId]: failureKind === "failed verification"
          ? { ...verification("config", actionId), status: "failed", reason_code: "READBACK_MISMATCH" }
          : verification("config", actionId)
      },
      rollback_receipts: { [actionId]: rollbackReceipt("config", actionId) }
    });
    const sync = createSyncMaintenanceModule({ providers: [provider], clock: () => new Date(now) });
    const plan = await sync.inspect(context());
    const failure = await sync.apply(plan.plan_id, plan.preview_hash, [actionId], {
      schema_version: 1,
      plan_id: plan.plan_id,
      preview_hash: plan.preview_hash,
      approved_action_ids: [actionId],
      allow_writes: true,
      allow_network: false,
      allow_model: false,
      confirmed_at: now
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "SYNC_APPLY_FAILED",
      retryable: false,
      failure_evidence: {
        failed_action_id: actionId,
        reason_code: reasonCode,
        receipts: [expect.objectContaining({ action_id: actionId })],
        rollback_receipts: [expect.objectContaining({ action_id: actionId, status: "rolled_back" })]
      }
    });
  });

  it("allows retry when plan refresh fails before the first side-effect boundary", async () => {
    const actionId = "config:update";
    const provider = new InMemorySyncActionProvider({
      provider_id: "config",
      applicability: { applicability: "applicable", reason_code: "CONFIG_PRESENT" },
      findings: [finding("config", "config:drift")],
      actions: [action("config", actionId)],
      receipts: { [actionId]: receipt("config", actionId) },
      verifications: { [actionId]: verification("config", actionId) }
    });
    const originalPlan = provider.plan.bind(provider);
    let failBeforeApply = true;
    provider.plan = async (inputContext, findingIds) => {
      if (provider.calls.plan > 0 && failBeforeApply) {
        failBeforeApply = false;
        throw new Error("refresh unavailable");
      }
      return originalPlan(inputContext, findingIds);
    };
    const sync = createSyncMaintenanceModule({ providers: [provider], clock: () => new Date(now) });
    const plan = await sync.inspect(context());
    const confirmation = {
      schema_version: 1 as const,
      plan_id: plan.plan_id,
      preview_hash: plan.preview_hash,
      approved_action_ids: [actionId],
      allow_writes: true,
      allow_network: false,
      allow_model: false,
      confirmed_at: now
    };

    await expect(sync.apply(plan.plan_id, plan.preview_hash, [actionId], confirmation))
      .rejects.toMatchObject({
        code: "SYNC_PLAN_STALE",
        retryable: true
      });
    expect(provider.calls.apply).toBe(0);
    await expect(sync.apply(plan.plan_id, plan.preview_hash, [actionId], confirmation))
      .resolves.toMatchObject({ applied_action_ids: [actionId] });
  });
});

describe("SyncMaintenance Module v1 compatibility", () => {
  it("reads the current plan fixture and rejects semantic identity drift", async () => {
    const fixture = JSON.parse(await readFile(
      new URL("./fixtures/sync-maintenance-v1-current.json", import.meta.url), "utf8"
    )) as Record<string, unknown>;
    const normalized = normalizeSyncMaintenanceRecord(fixture);
    expect(normalized).toMatchObject({ ok: true, source_schema_version: 1 });
    expect(normalizeSyncMaintenanceRecord({ ...fixture, preview_hash: `sha256:${"f".repeat(64)}` }))
      .toEqual({ ok: false, reason_code: "SYNC_RECORD_INVALID" });
    expect(normalizeSyncMaintenanceRecord({ ...fixture, extra: true }))
      .toEqual({ ok: false, reason_code: "SYNC_RECORD_INVALID" });
  });

  it("projects legacy status read-only without restoring placeholder receipts", async () => {
    const fixture = JSON.parse(await readFile(
      new URL("./fixtures/sync-maintenance-v0-legacy.json", import.meta.url), "utf8"
    )) as unknown;
    expect(normalizeSyncMaintenanceRecord(fixture)).toEqual({
      ok: true,
      source_schema_version: 0,
      readiness: "legacy_read_only",
      legacy: {
        status: "WARN",
        input_hash: null,
        report_path: null,
        report_sha256: null
      },
      reason_codes: [
        "LEGACY_PLAN_ID_UNKNOWN",
        "LEGACY_PREVIEW_HASH_UNKNOWN",
        "LEGACY_RECEIPTS_UNTRUSTED"
      ]
    });
  });

  it.each([
    { dirty_paths: ["../escape"] },
    { untracked_paths: [".env.production"] }
  ])("rejects unsafe context paths before provider inspection", (project_change_set) => {
    expect(() => context({
      project_change_set: {
        schema_version: 1,
        baseline_available: true,
        dirty_paths: [],
        untracked_paths: [],
        ...project_change_set
      }
    })).toThrowError(SyncMaintenanceError);
  });
});
