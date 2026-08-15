import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import {
  PLAN_PHASES,
  classifyPlan,
  configurePlannedPhases
} from "../src/plan-classification/index.js";

import {
  createPlanningContextModule,
  evidenceMapSchema,
  intentContractSchema,
  knowledgeQueryReceiptId,
  knowledgeResultSetIdentity,
  knowledgeResultSetHash,
  knowledgeContextSchema,
  knowledgeQueryReceiptSchema,
  planningContextSchema,
  normalizePlanningContextRecord,
  type KnowledgeQueryReceipt
} from "../src/planning-context/index.js";

const now = "2026-08-13T10:00:00.000Z";
const sha = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}` as const;
function attackHash(value: unknown): `sha256:${string}` {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, canonical(child)]));
    }
    return input;
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}

function knowledgeReceipt(
  input: Omit<KnowledgeQueryReceipt, "receipt_id" | "result_set_hash">
): KnowledgeQueryReceipt {
  const canonical = knowledgeResultSetIdentity(input);
  const result_set_hash = knowledgeResultSetHash(canonical);
  const body = {
    ...input,
    result_ids: canonical.result_ids,
    source_versions: canonical.source_versions,
    result_set_hash
  };
  return { ...body, receipt_id: knowledgeQueryReceiptId(body) };
}

function intentInput() {
  return {
    schema_version: 1 as const,
    source_input: "修复 archive resume 冲突，同时保持旧 receipt 兼容；不要改 CLI。",
    goal: "修复 archive resume 冲突",
    user_visible_outcome: "恢复流程能拒绝被篡改的 receipt",
    in_scope: ["archive_engine", "resume"],
    out_of_scope: ["cli"],
    constraints: ["legacy_receipt_compatible"],
    acceptance_examples: [
      "合法 receipt 可恢复",
      "篡改 receipt 返回 immutable_conflict"
    ],
    uncertainties: [],
    created_at: now
  };
}

function profileAndPhaseSet() {
  const profile = classifyPlan({
    schema_version: 1,
    change_id: "change-09",
    risk_signals: ["narrow_fix"],
    created_at: now
  });
  const phase_set = configurePlannedPhases(profile, {
    schema_version: 1,
    is_git: true,
    has_remote: true,
    uses_worktree: false,
    available_phases: PLAN_PHASES,
    requested_optional_phases: [],
    requested_omissions: [],
    configured_at: now
  });
  return { profile, phase_set };
}

function unchangedPartitionUpdates() {
  return {
    intent_hash: { operation: "unchanged" as const },
    knowledge_context_ref: { operation: "unchanged" as const },
    evidence_map_ref: { operation: "unchanged" as const },
    rules_manifest_hash: { operation: "unchanged" as const },
    map_manifest_hash: { operation: "unchanged" as const },
    profile_classification_hash: { operation: "unchanged" as const },
    phase_set_ref: { operation: "unchanged" as const }
  };
}

describe("PlanningContext Module v1 intent", () => {
  it("builds a strict canonical intent identity without copying conversational noise", () => {
    const module = createPlanningContextModule();
    const intent = module.buildIntent(intentInput());
    expect(intent).toMatchObject({
      schema_version: 1,
      goal: "修复 archive resume 冲突",
      in_scope: ["archive_engine", "resume"],
      out_of_scope: ["cli"],
      acceptance_examples: [
        "合法 receipt 可恢复",
        "篡改 receipt 返回 immutable_conflict"
      ],
      source_input_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      intent_id: expect.stringMatching(/^intent:[a-f0-9]{64}$/u)
    });
    expect(intent).not.toHaveProperty("source_input");
    expect(Object.isFrozen(intent)).toBe(true);
    expect(() => module.buildIntent({ ...intentInput(), extra: true } as never))
      .toThrowError(expect.objectContaining({ code: "PLANNING_INTENT_INVALID" }));
    expect(() => module.buildIntent({ ...intentInput(), acceptance_examples: ["only one"] }))
      .toThrowError(expect.objectContaining({ code: "PLANNING_INTENT_INVALID" }));
    expect(intentContractSchema.safeParse({ ...intent, goal: "tampered" }).success).toBe(false);
  });
});

describe("PlanningContext Module v1 knowledge", () => {
  it("builds one bounded query and permits a second only for explicit new evidence", () => {
    const module = createPlanningContextModule();
    const intent = module.buildIntent(intentInput());
    const initial = module.buildKnowledgeQuery(intent);
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({ ordinal: 1, reason_code: "initial_intent" });
    expect(initial[0]?.query.length).toBeLessThanOrEqual(512);

    const receipt = knowledgeReceipt({
      schema_version: 1,
      query_hash: initial[0]?.query_hash ?? sha("a"),
      project_id: "project-1",
      index_generation: "generation-7",
      result_ids: [],
      source_versions: [],
      status: "succeeded",
      executed_at: now,
      reason_code: "initial_intent"
    });
    expect(knowledgeQueryReceiptSchema.safeParse(receipt).success).toBe(true);
    const orphanSourceVersion = knowledgeReceipt({
      schema_version: 1,
      query_hash: initial[0]?.query_hash ?? sha("a"),
      project_id: "project-1",
      index_generation: "generation-7",
      result_ids: [],
      source_versions: ["orphan-v1"],
      status: "succeeded",
      executed_at: now,
      reason_code: "initial_intent"
    });
    expect(knowledgeQueryReceiptSchema.safeParse(orphanSourceVersion).success).toBe(false);
    expect(knowledgeQueryReceiptSchema.safeParse({ ...receipt, result_set_hash: sha("b") }).success)
      .toBe(false);
    expect(module.buildKnowledgeQuery(intent, {
      receipts: [receipt], first_result_sufficient: true, first_result_conflicted: false,
      exploration_signals: [{ kind: "error_code", value: "IMMUTABLE_CONFLICT" }],
      planning_question: "Which prior migration introduced IMMUTABLE_CONFLICT?"
    })).toEqual([]);
    const followup = module.buildKnowledgeQuery(intent, {
      receipts: [receipt], first_result_sufficient: false, first_result_conflicted: false,
      exploration_signals: [{ kind: "error_code", value: "IMMUTABLE_CONFLICT" }],
      planning_question: "Which prior migration introduced IMMUTABLE_CONFLICT?"
    });
    expect(followup).toHaveLength(1);
    expect(followup[0]).toMatchObject({ ordinal: 2, reason_code: "directed_evidence_followup" });
    const validFollowupState = {
      receipts: [receipt], first_result_sufficient: false, first_result_conflicted: false,
      exploration_signals: [{ kind: "error_code" as const, value: "IMMUTABLE_CONFLICT" }],
      planning_question: "Which prior migration introduced IMMUTABLE_CONFLICT?"
    };
    const hostileStates = [
      { ...validFollowupState, extra: true },
      { ...validFollowupState, first_result_sufficient: "false" },
      { ...validFollowupState, planning_question: 42 },
      { ...validFollowupState,
        exploration_signals: [{ kind: "error_code", value: "IMMUTABLE_CONFLICT", extra: true }] },
      Object.assign(Object.create({ inherited: true }) as object, validFollowupState)
    ];
    for (const hostileState of hostileStates) {
      expect(() => module.buildKnowledgeQuery(intent, hostileState as never))
        .toThrowError(expect.objectContaining({ code: "PLANNING_KNOWLEDGE_QUERY_INVALID" }));
    }
    expect(() => module.buildKnowledgeQuery(intent, {
      receipts: [receipt, knowledgeReceipt({
        ...receipt,
        query_hash: sha("c"),
        supersedes: receipt.receipt_id
      })],
      first_result_sufficient: false, first_result_conflicted: true,
      exploration_signals: [{ kind: "symbol", value: "resumeArchive" }],
      planning_question: "Anything else?"
    })).toThrowError(expect.objectContaining({ code: "PLANNING_KNOWLEDGE_QUERY_INVALID" }));
  });

  it("records one remote failure without creating a fallback query loop", () => {
    const module = createPlanningContextModule();
    const intent = module.buildIntent(intentInput());
    const initial = module.buildKnowledgeQuery(intent)[0];
    expect(initial).toBeDefined();
    if (initial === undefined) throw new Error("initial query was not built");
    const failed = knowledgeReceipt({
      schema_version: 1,
      query_hash: initial.query_hash,
      project_id: "project-1",
      result_ids: [],
      source_versions: [],
      status: "failed",
      failure_code: "REMOTE_TIMEOUT",
      executed_at: now,
      reason_code: "remote_knowledge_unavailable"
    });
    expect(module.buildKnowledgeQuery(intent, {
      receipts: [failed], first_result_sufficient: false, first_result_conflicted: false,
      exploration_signals: []
    })).toEqual([]);
  });

  it("compresses knowledge once, excludes documents, and exposes provenance conflicts", () => {
    const module = createPlanningContextModule();
    const intent = module.buildIntent(intentInput());
    const receipt = knowledgeReceipt({
      schema_version: 1,
      query_hash: sha("1"), project_id: "project-1", index_generation: "g1",
      result_ids: ["fact-1", "fact-2", "fact-3", "design-1"], source_versions: ["v1"],
      status: "succeeded", executed_at: now,
      reason_code: "initial_intent"
    });
    const results = [
      { result_id: "fact-1", kind: "archive_knowledge" as const, summary: "旧 receipt 需要兼容读取。", relevance: "high" as const, source: "archive:a", verified_at: now, source_version: "v1", conflicts_with_intent: false },
      { result_id: "fact-2", kind: "implementation_fact" as const, summary: "历史建议同时修改 CLI。", relevance: "high" as const, conflicts_with_intent: true, conflict_summary: "与 out_of_scope cli 冲突" },
      { result_id: "fact-3", kind: "implementation_fact" as const, summary: "恢复验证必须绑定输入哈希。", relevance: "medium" as const, source: "archive:b", verified_at: now, conflicts_with_intent: false },
      { result_id: "design-1", kind: "design" as const, summary: "完整设计正文不得进入知识。", relevance: "high" as const, source: "design.md", verified_at: now, conflicts_with_intent: false }
    ];
    expect(() => module.compressKnowledge(receipt, results.map((result) =>
      result.result_id === "fact-1" ? { ...result, source_version: "unbound-v9" } : result
    ), intent)).toThrowError(expect.objectContaining({ code: "PLANNING_KNOWLEDGE_RECEIPT_INVALID" }));
    const context = module.compressKnowledge(receipt, results, intent);
    expect(context.retained_result_ids).toEqual(["fact-1", "fact-2", "fact-3"]);
    expect(context.provenance_status).toBe("incomplete");
    expect(context.items[1]).toMatchObject({ provenance_status: "incomplete", conflict: true });
    expect(context.items[2]).toMatchObject({ provenance_status: "incomplete" });
    expect(context.unresolved_decision_ids).toHaveLength(1);
    expect(knowledgeContextSchema.safeParse({ ...context, items: [] }).success).toBe(false);
    const replacementReceipt = knowledgeReceipt({
      schema_version: 1,
      query_hash: sha("2"), project_id: "project-1", index_generation: "g2",
      result_ids: ["fact-1", "fact-2", "replacement"], source_versions: ["v1"],
      status: "succeeded", executed_at: now,
      reason_code: "initial_intent"
    });
    const { knowledge_context_id: _contextId, compression_hash: _compressionHash,
      ...contextBody } = context;
    void _contextId;
    void _compressionHash;
    const replacedReceiptBody = {
      ...contextBody,
      query_receipt_ref: replacementReceipt.receipt_id
    };
    expect(knowledgeContextSchema.safeParse({
      ...replacedReceiptBody,
      compression_hash: attackHash(replacedReceiptBody),
      knowledge_context_id: `knowledge_context:${attackHash(replacedReceiptBody).slice(7)}`
    }).success).toBe(false);
    const hiddenConflictBody = { ...contextBody, unresolved_decision_ids: [] };
    expect(knowledgeContextSchema.safeParse({
      ...hiddenConflictBody,
      compression_hash: attackHash(hiddenConflictBody),
      knowledge_context_id: `knowledge_context:${attackHash(hiddenConflictBody).slice(7)}`
    }).success).toBe(false);
    expect(() => module.compressKnowledge(receipt, results, intent))
      .toThrowError(expect.objectContaining({ code: "PLANNING_KNOWLEDGE_ALREADY_COMPRESSED" }));
  });
});

describe("PlanningContext Module v1 evidence and recovery", () => {
  it("builds one bounded ref-only EvidenceMap and rejects a repeated source identity", () => {
    const module = createPlanningContextModule();
    const input = {
      schema_version: 1 as const,
      map_manifest_hash: sha("3"),
      codegraph_index_hash: sha("4"),
      sources: [{
        source_kind: "codegraph" as const, source_id: "archive-call-path", source_version: "index-1",
        content_hash: sha("5"), module_refs: ["archive_engine"], symbol_refs: ["resumeArchive"],
        consumer_refs: ["ArchiveAdapter"], test_refs: ["archive-engine-module.test.ts"],
        constraint_refs: ["immutable_receipt"], unknown_refs: ["platform_adapter"]
      }],
      budget: { max_sources: 4, max_refs: 12 }, created_at: now
    };
    const evidence = module.buildEvidenceMap(input);
    expect(evidence).toMatchObject({ modules: ["archive_engine"], symbols: ["resumeArchive"] });
    expect(evidence).not.toHaveProperty("content");
    const { evidence_map_id: _evidenceMapId, ...forgedBody } = evidence;
    void _evidenceMapId;
    const forgedBudgetBody = { ...forgedBody, used_budget: { sources: 9, refs: 99 } };
    expect(evidenceMapSchema.safeParse({
      ...forgedBudgetBody,
      evidence_map_id: `evidence_map:${attackHash(forgedBudgetBody).slice("sha256:".length)}`
    }).success).toBe(false);
    expect(evidenceMapSchema.safeParse({ ...evidence, modules: ["other"] }).success).toBe(false);
    expect(() => module.buildEvidenceMap(input))
      .toThrowError(expect.objectContaining({ code: "PLANNING_EVIDENCE_INVALID" }));
  });

  it("builds ref-only partition identities and locally invalidates goal changes", () => {
    const module = createPlanningContextModule();
    const intent = module.buildIntent(intentInput());
    const evidence = module.buildEvidenceMap({
      schema_version: 1, map_manifest_hash: sha("3"), sources: [{
        source_kind: "map", source_id: "map:architecture", source_version: "manifest-1",
        content_hash: sha("5"), module_refs: ["archive_engine"], symbol_refs: [], consumer_refs: [],
        test_refs: [], constraint_refs: [], unknown_refs: []
      }], budget: { max_sources: 2, max_refs: 10 }, created_at: now
    });
    const context = module.buildPlanningContext({
      ...profileAndPhaseSet(),
      intent, evidence, rules_manifest_hash: sha("7"), map_manifest_hash: sha("3"), created_at: now
    });
    expect(context).not.toHaveProperty("intent");
    expect(() => module.buildPlanningContext({
      ...profileAndPhaseSet(), intent,
      evidence: { ...evidence, used_budget: { sources: 99, refs: 99 } },
      created_at: now
    })).toThrowError(expect.objectContaining({ code: "PLANNING_CONTEXT_INVALID" }));
    expect(() => module.buildPlanningContext({
      ...profileAndPhaseSet(), intent, evidence,
      knowledge: {
        knowledge_context_id: `knowledge_context:${"f".repeat(64)}`
      } as never,
      created_at: now
    })).toThrowError(expect.objectContaining({ code: "PLANNING_CONTEXT_INVALID" }));
    expect(context.partition_hashes.knowledge).toBeNull();
    expect(planningContextSchema.safeParse({ ...context, status: "decisions_required" }).success)
      .toBe(false);
    expect(module.invalidatePartitions(context, {
      ...unchangedPartitionUpdates(), intent_hash: { operation: "set", value: sha("8") }
    }).invalidated_partitions)
      .toEqual(["evidence", "intent", "knowledge"]);
    expect(module.invalidatePartitions(context, {
      ...unchangedPartitionUpdates(), rules_manifest_hash: { operation: "set", value: sha("9") }
    }).invalidated_partitions)
      .toEqual(["rules"]);

    const knowledgeReceiptForContext = knowledgeReceipt({
      schema_version: 1,
      query_hash: sha("a"), project_id: "project-1", index_generation: "g1",
      result_ids: ["fact-a", "fact-b", "fact-c"], source_versions: [],
      status: "succeeded", executed_at: now,
      reason_code: "initial_intent"
    });
    const knowledge = module.compressKnowledge(knowledgeReceiptForContext, [
      { result_id: "fact-a", kind: "implementation_fact", summary: "fact a", relevance: "high", conflicts_with_intent: false },
      { result_id: "fact-b", kind: "implementation_fact", summary: "fact b", relevance: "medium", conflicts_with_intent: false },
      { result_id: "fact-c", kind: "implementation_fact", summary: "fact c", relevance: "low", conflicts_with_intent: false }
    ], intent);
    const alternateReceipt = knowledgeReceipt({
      ...knowledgeReceiptForContext,
      executed_at: "2026-08-13T10:00:01.000Z"
    });
    const { knowledge_context_id: _knowledgeId, compression_hash: _knowledgeHash,
      ...knowledgeBody } = knowledge;
    void _knowledgeId;
    void _knowledgeHash;
    const alternateReceiptBody = {
      ...knowledgeBody,
      query_receipt_ref: alternateReceipt.receipt_id,
      query_receipt: alternateReceipt
    };
    const alternateReceiptKnowledge = {
      ...alternateReceiptBody,
      compression_hash: attackHash(alternateReceiptBody),
      knowledge_context_id: `knowledge_context:${attackHash(alternateReceiptBody).slice(7)}` as const
    };
    expect(() => module.buildPlanningContext({
      ...profileAndPhaseSet(), intent, knowledge: alternateReceiptKnowledge, evidence,
      trusted_knowledge_receipt: knowledgeReceiptForContext, created_at: now
    })).toThrowError(expect.objectContaining({ code: "PLANNING_CONTEXT_INVALID" }));
    expect(() => module.buildPlanningContext({
      ...profileAndPhaseSet(), intent, knowledge, evidence, created_at: now
    })).toThrowError(expect.objectContaining({ code: "PLANNING_CONTEXT_INVALID" }));
    const contextWithKnowledge = module.buildPlanningContext({
      ...profileAndPhaseSet(), intent, knowledge, evidence,
      trusted_knowledge_receipt: knowledgeReceiptForContext,
      rules_manifest_hash: sha("7"), map_manifest_hash: sha("3"), created_at: now
    });
    expect(contextWithKnowledge).toMatchObject({
      knowledge_context_ref: knowledge.knowledge_context_id,
      unresolved_decision_ids: [] ,
      status: "ready"
    });
    expect(module.invalidatePartitions(contextWithKnowledge, {
      ...unchangedPartitionUpdates(),
      knowledge_context_ref: { operation: "remove" },
      rules_manifest_hash: { operation: "remove" },
      map_manifest_hash: { operation: "remove" }
    }).invalidated_partitions).toEqual(["evidence", "knowledge", "map", "rules"]);

    const conflictModule = createPlanningContextModule();
    const conflictKnowledge = conflictModule.compressKnowledge(knowledgeReceiptForContext, [
      { result_id: "fact-a", kind: "implementation_fact", summary: "fact a", relevance: "high", conflicts_with_intent: true, conflict_summary: "conflicts with scope" },
      { result_id: "fact-b", kind: "implementation_fact", summary: "fact b", relevance: "medium", conflicts_with_intent: false },
      { result_id: "fact-c", kind: "implementation_fact", summary: "fact c", relevance: "low", conflicts_with_intent: false }
    ], intent);
    const foreignIntent = conflictModule.buildIntent({
      ...intentInput(), source_input: "foreign intent", goal: "foreign goal"
    });
    const { knowledge_context_id: _conflictId, compression_hash: _conflictHash,
      ...conflictBody } = conflictKnowledge;
    void _conflictId;
    void _conflictHash;
    const foreignIntentBody = {
      ...conflictBody,
      intent_contract_ref: foreignIntent.intent_id,
      unresolved_decision_ids: [`knowledge_conflict:${attackHash({
        intent_hash: foreignIntent.intent_hash,
        result_id: "fact-a"
      }).slice(7)}`]
    };
    const foreignIntentKnowledge = {
      ...foreignIntentBody,
      compression_hash: attackHash(foreignIntentBody),
      knowledge_context_id: `knowledge_context:${attackHash(foreignIntentBody).slice(7)}` as const
    };
    expect(() => conflictModule.buildPlanningContext({
      ...profileAndPhaseSet(), intent, knowledge: foreignIntentKnowledge, evidence,
      trusted_knowledge_receipt: knowledgeReceiptForContext, created_at: now
    })).toThrowError(expect.objectContaining({ code: "PLANNING_CONTEXT_INVALID" }));
    expect(conflictModule.buildPlanningContext({
      ...profileAndPhaseSet(), intent, knowledge: conflictKnowledge, evidence,
      trusted_knowledge_receipt: knowledgeReceiptForContext, created_at: now
    })).toMatchObject({
      status: "decisions_required",
      unresolved_decision_ids: conflictKnowledge.unresolved_decision_ids
    });
  });

  it("reads current fixture and projects legacy as read-only, never ready", async () => {
    const current = JSON.parse(await readFile(new URL("./fixtures/planning-context-v1-current.json", import.meta.url), "utf8")) as unknown;
    const legacy = JSON.parse(await readFile(new URL("./fixtures/planning-context-v0-legacy.json", import.meta.url), "utf8")) as unknown;
    expect(normalizePlanningContextRecord(current)).toMatchObject({ ok: true, readiness: "current" });
    expect(normalizePlanningContextRecord({ ...(current as object), extra: true }))
      .toEqual({ ok: false, reason_code: "PLANNING_CONTEXT_RECORD_INVALID" });
    expect(normalizePlanningContextRecord({ ...(current as object), status: "decisions_required" }))
      .toEqual({ ok: false, reason_code: "PLANNING_CONTEXT_RECORD_INVALID" });
    expect(normalizePlanningContextRecord(legacy)).toEqual({ ok: true, source_schema_version: 0, readiness: "legacy_read_only", legacy_ref: "legacy-plan-context-1" });
  });
});
