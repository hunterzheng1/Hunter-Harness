import { PlanningContextError } from "./errors.js";
import {
  knowledgeConflictDecisionId,
  knowledgeQueryReceiptId,
  knowledgeResultSetHash,
  knowledgeResultSetIdentity
} from "./identity.js";
import {
  boundedText,
  exactWithOptional,
  plainDataRecord,
  shaPattern,
  stableHash,
  validTime
} from "./stable.js";
import type {
  EvidenceMap,
  IntentContract,
  KnowledgeContext,
  KnowledgeQueryReceipt,
  PlanningContext,
  PlanningPartition
} from "./types.js";

export interface PlanningRuntimeSchema<T> {
  parse(value: unknown): T;
  safeParse(value: unknown): { readonly success: true; readonly data: T } | { readonly success: false };
}

const plainRecord = plainDataRecord;

function schema<T>(code: ConstructorParameters<typeof PlanningContextError>[0], parse: (value: unknown) => T): PlanningRuntimeSchema<T> {
  return {
    parse(value) {
      try { return parse(value); } catch (error) {
        if (error instanceof PlanningContextError) throw error;
        throw new PlanningContextError(code);
      }
    },
    safeParse(value) {
      try { return { success: true, data: parse(value) }; } catch { return { success: false }; }
    }
  };
}

function strings(value: unknown, minimum: number, maximum: number): value is readonly string[] {
  return Array.isArray(value) && value.length >= minimum && value.length <= maximum &&
    value.every((item) => boundedText(item, 1_024)) && new Set(value).size === value.length;
}

export const intentContractSchema = schema<IntentContract>("PLANNING_INTENT_INVALID", (value) => {
  if (!plainRecord(value) || !exactWithOptional(value, ["schema_version", "intent_id", "goal",
    "user_visible_outcome", "in_scope", "out_of_scope", "constraints", "acceptance_examples",
    "uncertainties", "source_input_hash", "intent_hash", "created_at"]) || value.schema_version !== 1 ||
    typeof value.intent_id !== "string" || !/^intent:[a-f0-9]{64}$/u.test(value.intent_id) ||
    !boundedText(value.goal, 512) || !boundedText(value.user_visible_outcome, 512) ||
    !strings(value.in_scope, 1, 32) || !strings(value.out_of_scope, 0, 32) ||
    !strings(value.constraints, 0, 32) || !strings(value.acceptance_examples, 2, 5) ||
    !strings(value.uncertainties, 0, 16) || typeof value.source_input_hash !== "string" ||
    !shaPattern.test(value.source_input_hash) || typeof value.intent_hash !== "string" ||
    !shaPattern.test(value.intent_hash) || typeof value.created_at !== "string" || !validTime(value.created_at)) {
    throw new Error("invalid intent");
  }
  const { intent_id, intent_hash, ...body } = value;
  if (intent_hash !== stableHash(body) || intent_id !== `intent:${intent_hash.slice(7)}`) throw new Error("intent identity drift");
  return value as unknown as IntentContract;
});

export const knowledgeQueryReceiptSchema = schema<KnowledgeQueryReceipt>(
  "PLANNING_KNOWLEDGE_RECEIPT_INVALID",
  (value) => {
    if (!plainRecord(value) || !exactWithOptional(value, ["schema_version", "receipt_id", "query_hash",
      "project_id", "result_ids", "source_versions", "result_set_hash", "status", "executed_at",
      "reason_code"], ["index_generation", "failure_code", "supersedes"]) || value.schema_version !== 1 ||
      typeof value.receipt_id !== "string" || !/^knowledge_query_receipt:[a-f0-9]{64}$/u.test(value.receipt_id) ||
      typeof value.query_hash !== "string" || !shaPattern.test(value.query_hash) ||
      !boundedText(value.project_id, 128) || !strings(value.result_ids, 0, 10) ||
      !strings(value.source_versions, 0, 10) || typeof value.result_set_hash !== "string" ||
      !shaPattern.test(value.result_set_hash) || typeof value.executed_at !== "string" ||
      !validTime(value.executed_at) ||
      (value.index_generation !== undefined && !boundedText(value.index_generation, 128)) ||
      (value.supersedes !== undefined && (typeof value.supersedes !== "string" ||
        !/^knowledge_query_receipt:[a-f0-9]{64}$/u.test(value.supersedes))) ||
      !((value.status === "succeeded" &&
        (value.reason_code === "initial_intent" || value.reason_code === "directed_evidence_followup") &&
        value.failure_code === undefined &&
        (value.result_ids.length > 0 || value.source_versions.length === 0)) ||
        (value.status === "failed" && value.reason_code === "remote_knowledge_unavailable" &&
          boundedText(value.failure_code, 128) && value.result_ids.length === 0 &&
          value.source_versions.length === 0))) throw new Error("invalid receipt");
    const receipt = value as unknown as KnowledgeQueryReceipt;
    const canonicalResultSet = knowledgeResultSetIdentity(receipt);
    if (JSON.stringify(receipt.result_ids) !== JSON.stringify(canonicalResultSet.result_ids) ||
        JSON.stringify(receipt.source_versions) !== JSON.stringify(canonicalResultSet.source_versions) ||
        receipt.result_set_hash !== knowledgeResultSetHash(receipt)) {
      throw new Error("result set identity drift");
    }
    const { receipt_id: receiptId, ...receiptBody } = receipt;
    if (receiptId !== knowledgeQueryReceiptId(receiptBody) || receipt.supersedes === receipt.receipt_id) {
      throw new Error("receipt identity drift");
    }
    return receipt;
  }
);

export const knowledgeContextSchema = schema<KnowledgeContext>("PLANNING_KNOWLEDGE_RECEIPT_INVALID", (value) => {
  if (!plainRecord(value) || !exactWithOptional(value, ["schema_version", "knowledge_context_id",
    "intent_contract_ref", "query_receipt_ref", "query_receipt", "retained_result_ids", "items",
    "compression_hash", "truncation_reasons", "provenance_status", "unresolved_decision_ids"]) ||
    value.schema_version !== 1 ||
    typeof value.knowledge_context_id !== "string" ||
    !/^knowledge_context:[a-f0-9]{64}$/u.test(value.knowledge_context_id) ||
    typeof value.intent_contract_ref !== "string" ||
    !/^intent:[a-f0-9]{64}$/u.test(value.intent_contract_ref) ||
    typeof value.query_receipt_ref !== "string" ||
    !/^knowledge_query_receipt:[a-f0-9]{64}$/u.test(value.query_receipt_ref) ||
    !strings(value.retained_result_ids, 0, 5) ||
    !([0, 3, 4, 5].includes(value.retained_result_ids.length)) || !Array.isArray(value.items) ||
    value.items.length !== value.retained_result_ids.length || typeof value.compression_hash !== "string" ||
    !shaPattern.test(value.compression_hash) || !strings(value.truncation_reasons, 0, 3) ||
    (value.provenance_status !== "complete" && value.provenance_status !== "incomplete") ||
    !strings(value.unresolved_decision_ids, 0, 5)) throw new Error("invalid knowledge context");
  const receiptResult = knowledgeQueryReceiptSchema.safeParse(value.query_receipt);
  if (!receiptResult.success || receiptResult.data.status !== "succeeded" ||
      receiptResult.data.receipt_id !== value.query_receipt_ref ||
      (value.retained_result_ids as string[]).some((resultId) =>
        !receiptResult.data.result_ids.includes(resultId))) {
    throw new Error("knowledge receipt binding drift");
  }
  const items = value.items as unknown[];
  if (items.some((item, index) => !plainRecord(item) || !exactWithOptional(item, ["result_id",
    "provenance_status", "relevance", "summary", "conflict"], ["source", "verified_at", "source_version"]) ||
    item.result_id !== (value.retained_result_ids as string[])[index] ||
    (item.provenance_status !== "complete" && item.provenance_status !== "incomplete") ||
    (item.relevance !== "high" && item.relevance !== "medium" && item.relevance !== "low") ||
    !boundedText(item.summary, 1_024) || typeof item.conflict !== "boolean" ||
    (item.source !== undefined && !boundedText(item.source, 256)) ||
    (item.verified_at !== undefined && (typeof item.verified_at !== "string" || !validTime(item.verified_at))) ||
    (item.source_version !== undefined && (!boundedText(item.source_version, 128) ||
      !receiptResult.data.source_versions.includes(item.source_version))) ||
    item.provenance_status !== (item.source !== undefined && item.verified_at !== undefined &&
      item.source_version !== undefined ? "complete" : "incomplete"))) throw new Error("invalid item");
  if (value.provenance_status !== (items.every((item) =>
    (item as Record<string, unknown>).provenance_status === "complete") ? "complete" : "incomplete")) {
    throw new Error("knowledge provenance drift");
  }
  const expectedDecisions = items.filter((item) =>
    (item as Record<string, unknown>).conflict === true).map((item) =>
    knowledgeConflictDecisionId(
      value.intent_contract_ref as `intent:${string}`,
      (item as Record<string, unknown>).result_id as string
    ));
  if (JSON.stringify(value.unresolved_decision_ids) !== JSON.stringify(expectedDecisions)) {
    throw new Error("knowledge conflict decision drift");
  }
  const { knowledge_context_id, compression_hash, ...body } = value;
  if (compression_hash !== stableHash(body) ||
      knowledge_context_id !== `knowledge_context:${compression_hash.slice(7)}`) throw new Error("knowledge identity drift");
  return value as unknown as KnowledgeContext;
});

export const evidenceMapSchema = schema<EvidenceMap>("PLANNING_EVIDENCE_INVALID", (value) => {
  if (!plainRecord(value) || !exactWithOptional(value, ["schema_version", "evidence_map_id",
    "source_identity_hash", "modules", "symbols", "consumers", "tests", "constraints", "unknowns",
    "source_refs", "used_budget", "truncation_reasons", "created_at"],
    ["map_manifest_hash", "codegraph_index_hash"]) || value.schema_version !== 1 ||
    typeof value.evidence_map_id !== "string" || !/^evidence_map:[a-f0-9]{64}$/u.test(value.evidence_map_id) ||
    typeof value.source_identity_hash !== "string" || !shaPattern.test(value.source_identity_hash) ||
    !strings(value.modules, 0, 512) || !strings(value.symbols, 0, 512) ||
    !strings(value.consumers, 0, 512) || !strings(value.tests, 0, 512) ||
    !strings(value.constraints, 0, 512) || !strings(value.unknowns, 0, 512) ||
    !Array.isArray(value.source_refs) || value.source_refs.length === 0 || !plainRecord(value.used_budget) ||
    (value.map_manifest_hash !== undefined && (typeof value.map_manifest_hash !== "string" ||
      !shaPattern.test(value.map_manifest_hash))) ||
    (value.codegraph_index_hash !== undefined && (typeof value.codegraph_index_hash !== "string" ||
      !shaPattern.test(value.codegraph_index_hash))) ||
    !strings(value.truncation_reasons, 0, 2) || typeof value.created_at !== "string" || !validTime(value.created_at)) {
    throw new Error("invalid evidence map");
  }
  const sourceRefs = value.source_refs as unknown[];
  if (sourceRefs.some((sourceRef) => !plainRecord(sourceRef) || !exactWithOptional(sourceRef,
    ["source_kind", "source_id", "source_version", "content_hash"]) ||
    !(["map", "codegraph", "file", "config"] as const).includes(sourceRef.source_kind as never) ||
    !boundedText(sourceRef.source_id, 256) || !boundedText(sourceRef.source_version, 128) ||
    typeof sourceRef.content_hash !== "string" || !shaPattern.test(sourceRef.content_hash))) {
    throw new Error("invalid source ref");
  }
  const usedBudget = value.used_budget as Record<string, unknown>;
  const actualRefCount = [value.modules, value.symbols, value.consumers, value.tests,
    value.constraints, value.unknowns].reduce((total, refs) => total + (refs as unknown[]).length, 0);
  if (!exactWithOptional(usedBudget, ["sources", "refs"]) ||
      !Number.isSafeInteger(usedBudget.sources) || Number(usedBudget.sources) < 0 ||
      Number(usedBudget.sources) > 64 || Number(usedBudget.sources) !== sourceRefs.length ||
      !Number.isSafeInteger(usedBudget.refs) || Number(usedBudget.refs) < 0 ||
      Number(usedBudget.refs) > 512 || Number(usedBudget.refs) !== actualRefCount) {
    throw new Error("invalid evidence budget");
  }
  const canonicalSources = [...sourceRefs].sort((left, right) => {
    const leftRef = left as Record<string, unknown>;
    const rightRef = right as Record<string, unknown>;
    const leftIdentity = `${String(leftRef.source_kind)}\0${String(leftRef.source_id)}`;
    const rightIdentity = `${String(rightRef.source_kind)}\0${String(rightRef.source_id)}`;
    return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
  });
  const sourceIdentities = canonicalSources.map((sourceRef) => {
    const source = sourceRef as Record<string, unknown>;
    return `${String(source.source_kind)}\0${String(source.source_id)}`;
  });
  if (new Set(sourceIdentities).size !== sourceIdentities.length ||
      JSON.stringify(sourceRefs) !== JSON.stringify(canonicalSources)) {
    throw new Error("source refs must be canonical unique");
  }
  const expectedSourceIdentity = stableHash({
    map_manifest_hash: value.map_manifest_hash,
    codegraph_index_hash: value.codegraph_index_hash,
    sources: canonicalSources
  });
  if (value.source_identity_hash !== expectedSourceIdentity) throw new Error("source identity drift");
  const { evidence_map_id, ...body } = value;
  if (evidence_map_id !== `evidence_map:${stableHash(body).slice(7)}`) throw new Error("evidence identity drift");
  return value as unknown as EvidenceMap;
});

const partitionNames: readonly PlanningPartition[] = ["intent", "knowledge", "evidence", "rules", "map", "profile", "phases"];
export const planningContextSchema = schema<PlanningContext>("PLANNING_CONTEXT_INVALID", (value) => {
  if (!plainRecord(value) || !exactWithOptional(value, ["schema_version", "context_id", "plan_profile_ref",
    "planned_phase_set_ref", "intent_contract_ref", "evidence_map_ref", "partition_hashes",
    "unresolved_decision_ids", "status", "created_at"], ["knowledge_context_ref", "rules_manifest_hash",
    "map_manifest_hash", "supersedes"]) || value.schema_version !== 1 || typeof value.context_id !== "string" ||
    !/^planning_context:[a-f0-9]{64}$/u.test(value.context_id) || !plainRecord(value.partition_hashes) ||
    typeof value.plan_profile_ref !== "string" || !/^plan_profile:[a-f0-9]{64}$/u.test(value.plan_profile_ref) ||
    typeof value.planned_phase_set_ref !== "string" ||
      !/^planned_phase_set:[a-f0-9]{64}$/u.test(value.planned_phase_set_ref) ||
    typeof value.intent_contract_ref !== "string" || !/^intent:[a-f0-9]{64}$/u.test(value.intent_contract_ref) ||
    typeof value.evidence_map_ref !== "string" || !/^evidence_map:[a-f0-9]{64}$/u.test(value.evidence_map_ref) ||
    (value.knowledge_context_ref !== undefined && (typeof value.knowledge_context_ref !== "string" ||
      !/^knowledge_context:[a-f0-9]{64}$/u.test(value.knowledge_context_ref))) ||
    (value.rules_manifest_hash !== undefined && (typeof value.rules_manifest_hash !== "string" ||
      !shaPattern.test(value.rules_manifest_hash))) ||
    (value.map_manifest_hash !== undefined && (typeof value.map_manifest_hash !== "string" ||
      !shaPattern.test(value.map_manifest_hash))) ||
    (value.supersedes !== undefined && (typeof value.supersedes !== "string" ||
      !/^planning_context:[a-f0-9]{64}$/u.test(value.supersedes) || value.supersedes === value.context_id)) ||
    Object.keys(value.partition_hashes as Record<string, unknown>).length !== partitionNames.length || !partitionNames.every((name) => {
      const partitionHashes = value.partition_hashes as Record<string, unknown>;
      const hash = partitionHashes[name];
      return Object.hasOwn(partitionHashes, name) && (hash === null ||
        (typeof hash === "string" && shaPattern.test(hash)));
    }) || !strings(value.unresolved_decision_ids, 0, 64) ||
    value.status !== (value.unresolved_decision_ids.length === 0 ? "ready" : "decisions_required") ||
    typeof value.created_at !== "string" || !validTime(value.created_at)) throw new Error("invalid context");
  const partitionHashes = value.partition_hashes as Record<PlanningPartition, string | null>;
  if (partitionHashes.intent !== stableHash(`sha256:${value.intent_contract_ref.slice("intent:".length)}`) ||
      partitionHashes.evidence !== stableHash(value.evidence_map_ref) ||
      partitionHashes.phases !== stableHash(value.planned_phase_set_ref) ||
      partitionHashes.knowledge !== (value.knowledge_context_ref === undefined
        ? null : stableHash(value.knowledge_context_ref)) ||
      partitionHashes.rules !== (value.rules_manifest_hash === undefined
        ? null : stableHash(value.rules_manifest_hash)) ||
      partitionHashes.map !== (value.map_manifest_hash === undefined
        ? null : stableHash(value.map_manifest_hash)) || partitionHashes.profile === null) {
    throw new Error("partition identity drift");
  }
  const { context_id, ...identity } = value;
  if (context_id !== `planning_context:${stableHash(identity).slice(7)}`) throw new Error("context identity drift");
  return value as unknown as PlanningContext;
});
