export type PlanningSha256 = `sha256:${string}`;

export interface IntentInput {
  readonly schema_version: 1;
  readonly source_input: string;
  readonly goal: string;
  readonly user_visible_outcome: string;
  readonly in_scope: readonly string[];
  readonly out_of_scope: readonly string[];
  readonly constraints: readonly string[];
  readonly acceptance_examples: readonly string[];
  readonly uncertainties: readonly string[];
  readonly created_at: string;
}

export interface IntentContract extends Omit<IntentInput, "source_input"> {
  readonly intent_id: `intent:${string}`;
  readonly source_input_hash: PlanningSha256;
  readonly intent_hash: PlanningSha256;
}

export type KnowledgeQueryReason = "initial_intent" | "directed_evidence_followup";
export interface KnowledgeExplorationSignal {
  readonly kind: "module" | "symbol" | "error_code" | "migration_id";
  readonly value: string;
}

export interface KnowledgeQueryReceipt {
  readonly schema_version: 1;
  readonly receipt_id: `knowledge_query_receipt:${string}`;
  readonly query_hash: PlanningSha256;
  readonly project_id: string;
  readonly index_generation?: string | undefined;
  readonly result_ids: readonly string[];
  readonly source_versions: readonly string[];
  readonly result_set_hash: PlanningSha256;
  readonly status: "succeeded" | "failed";
  readonly executed_at: string;
  readonly reason_code: KnowledgeQueryReason | "remote_knowledge_unavailable";
  readonly failure_code?: string | undefined;
  readonly supersedes?: string | undefined;
}

export interface KnowledgeQueryPlan {
  readonly schema_version: 1;
  readonly query_id: `knowledge_query:${string}`;
  readonly ordinal: 1 | 2;
  readonly query: string;
  readonly query_hash: PlanningSha256;
  readonly reason_code: KnowledgeQueryReason;
  readonly planning_question: string;
  readonly signal_refs: readonly string[];
}

export interface KnowledgeQueryState {
  readonly receipts: readonly KnowledgeQueryReceipt[];
  readonly first_result_sufficient: boolean;
  readonly first_result_conflicted: boolean;
  readonly exploration_signals: readonly KnowledgeExplorationSignal[];
  readonly planning_question?: string | undefined;
}

export interface KnowledgeResult {
  readonly result_id: string;
  readonly kind: "archive_knowledge" | "implementation_fact" | "design" | "rule" | "change_document";
  readonly summary: string;
  readonly relevance: "high" | "medium" | "low";
  readonly source?: string | undefined;
  readonly verified_at?: string | undefined;
  readonly source_version?: string | undefined;
  readonly conflicts_with_intent: boolean;
  readonly conflict_summary?: string | undefined;
}

export interface KnowledgeContextItem {
  readonly result_id: string;
  readonly source?: string | undefined;
  readonly verified_at?: string | undefined;
  readonly source_version?: string | undefined;
  readonly provenance_status: "complete" | "incomplete";
  readonly relevance: "high" | "medium" | "low";
  readonly summary: string;
  readonly conflict: boolean;
}

export interface KnowledgeContext {
  readonly schema_version: 1;
  readonly knowledge_context_id: `knowledge_context:${string}`;
  readonly intent_contract_ref: `intent:${string}`;
  readonly query_receipt_ref: string;
  readonly query_receipt: KnowledgeQueryReceipt;
  readonly retained_result_ids: readonly string[];
  readonly items: readonly KnowledgeContextItem[];
  readonly compression_hash: PlanningSha256;
  readonly truncation_reasons: readonly ("result_limit" | "fewer_than_recommended" | "non_knowledge_kind")[];
  readonly provenance_status: "complete" | "incomplete";
  readonly unresolved_decision_ids: readonly string[];
}

export interface EvidenceSourceRef {
  readonly source_kind: "map" | "codegraph" | "file" | "config";
  readonly source_id: string;
  readonly source_version: string;
  readonly content_hash: PlanningSha256;
  readonly module_refs: readonly string[];
  readonly symbol_refs: readonly string[];
  readonly consumer_refs: readonly string[];
  readonly test_refs: readonly string[];
  readonly constraint_refs: readonly string[];
  readonly unknown_refs: readonly string[];
}

export interface EvidenceMapInput {
  readonly schema_version: 1;
  readonly map_manifest_hash?: PlanningSha256 | undefined;
  readonly codegraph_index_hash?: PlanningSha256 | undefined;
  readonly sources: readonly EvidenceSourceRef[];
  readonly budget: { readonly max_sources: number; readonly max_refs: number };
  readonly created_at: string;
}

export interface EvidenceMap {
  readonly schema_version: 1;
  readonly evidence_map_id: `evidence_map:${string}`;
  readonly source_identity_hash: PlanningSha256;
  readonly map_manifest_hash?: PlanningSha256 | undefined;
  readonly codegraph_index_hash?: PlanningSha256 | undefined;
  readonly modules: readonly string[];
  readonly symbols: readonly string[];
  readonly consumers: readonly string[];
  readonly tests: readonly string[];
  readonly constraints: readonly string[];
  readonly unknowns: readonly string[];
  readonly source_refs: readonly { readonly source_kind: EvidenceSourceRef["source_kind"]; readonly source_id: string; readonly source_version: string; readonly content_hash: PlanningSha256 }[];
  readonly used_budget: { readonly sources: number; readonly refs: number };
  readonly truncation_reasons: readonly ("source_budget_exhausted" | "reference_budget_exhausted")[];
  readonly created_at: string;
}

export type PlanningPartition = "intent" | "knowledge" | "evidence" | "rules" | "map" | "profile" | "phases";
export type PlanningPartitionUpdate<T> =
  | { readonly operation: "unchanged" }
  | { readonly operation: "set"; readonly value: T }
  | { readonly operation: "remove" };
export interface PlanningPartitionUpdates {
  readonly intent_hash: PlanningPartitionUpdate<PlanningSha256>;
  readonly knowledge_context_ref: PlanningPartitionUpdate<`knowledge_context:${string}`>;
  readonly evidence_map_ref: PlanningPartitionUpdate<`evidence_map:${string}`>;
  readonly rules_manifest_hash: PlanningPartitionUpdate<PlanningSha256>;
  readonly map_manifest_hash: PlanningPartitionUpdate<PlanningSha256>;
  readonly profile_classification_hash: PlanningPartitionUpdate<PlanningSha256>;
  readonly phase_set_ref: PlanningPartitionUpdate<`planned_phase_set:${string}`>;
}
export interface PlanningContext {
  readonly schema_version: 1;
  readonly context_id: `planning_context:${string}`;
  readonly plan_profile_ref: string;
  readonly planned_phase_set_ref: string;
  readonly intent_contract_ref: string;
  readonly knowledge_context_ref?: string | undefined;
  readonly evidence_map_ref: string;
  readonly rules_manifest_hash?: PlanningSha256 | undefined;
  readonly map_manifest_hash?: PlanningSha256 | undefined;
  readonly partition_hashes: Readonly<Record<PlanningPartition, PlanningSha256 | null>>;
  readonly unresolved_decision_ids: readonly string[];
  readonly status: "ready" | "decisions_required";
  readonly created_at: string;
  readonly supersedes?: string | undefined;
}

export interface PlanningContextModule {
  buildIntent(input: IntentInput): IntentContract;
  buildKnowledgeQuery(intent: IntentContract, state?: KnowledgeQueryState): readonly KnowledgeQueryPlan[];
  compressKnowledge(receipt: KnowledgeQueryReceipt, results: readonly KnowledgeResult[], intent: IntentContract): KnowledgeContext;
  buildEvidenceMap(input: EvidenceMapInput): EvidenceMap;
  buildPlanningContext(input: {
    readonly profile: PlanProfile;
    readonly phase_set: PlannedPhaseSet;
    readonly intent: IntentContract;
    readonly knowledge?: KnowledgeContext | undefined;
    readonly trusted_knowledge_receipt?: KnowledgeQueryReceipt | undefined;
    readonly evidence: EvidenceMap;
    readonly rules_manifest_hash?: PlanningSha256 | undefined;
    readonly map_manifest_hash?: PlanningSha256 | undefined;
    readonly created_at: string;
    readonly supersedes?: string | undefined;
  }): PlanningContext;
  invalidatePartitions(previous: PlanningContext, changed: PlanningPartitionUpdates): {
    readonly invalidated_partitions: readonly PlanningPartition[];
    readonly retained_partitions: readonly PlanningPartition[];
  };
}

export type PlanningContextReadResult =
  | { readonly ok: true; readonly source_schema_version: 1; readonly readiness: "current"; readonly context: PlanningContext }
  | { readonly ok: true; readonly source_schema_version: 0; readonly readiness: "legacy_read_only"; readonly legacy_ref: string }
  | { readonly ok: false; readonly reason_code: "PLANNING_CONTEXT_RECORD_INVALID" | "PLANNING_CONTEXT_VERSION_UNSUPPORTED" };
import type { PlanProfile, PlannedPhaseSet } from "../plan-classification/types.js";
