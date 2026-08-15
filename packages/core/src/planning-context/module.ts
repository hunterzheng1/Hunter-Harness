import { PlanningContextError } from "./errors.js";
import { knowledgeConflictDecisionId } from "./identity.js";
import {
  plannedPhaseSetSchema,
  planProfileSchema
} from "../plan-classification/schemas.js";
import {
  evidenceMapSchema,
  intentContractSchema,
  knowledgeContextSchema,
  knowledgeQueryReceiptSchema,
  planningContextSchema
} from "./schemas.js";
import {
  boundedText,
  compareCodepoint,
  deepFreeze,
  exact,
  exactWithOptional,
  idPattern,
  plainDataRecord,
  shaPattern,
  sortedUnique,
  stableHash,
  validTime
} from "./stable.js";
import type {
  EvidenceMap,
  EvidenceMapInput,
  EvidenceSourceRef,
  IntentContract,
  IntentInput,
  KnowledgeContext,
  KnowledgeQueryPlan,
  KnowledgeQueryReceipt,
  KnowledgeQueryState,
  KnowledgeResult,
  PlanningContext,
  PlanningContextModule,
  PlanningPartition,
  PlanningPartitionUpdate
} from "./types.js";

const partitions: readonly PlanningPartition[] = [
  "intent", "knowledge", "evidence", "rules", "map", "profile", "phases"
];
const allowedKnowledgeKinds = new Set(["archive_knowledge", "implementation_fact"]);

function sourceRefIdentity(source: Pick<EvidenceSourceRef, "source_kind" | "source_id">): string {
  return `${source.source_kind}\0${source.source_id}`;
}

function stringList(value: readonly string[], minimum: number, maximum: number): boolean {
  return Array.isArray(value) && value.length >= minimum && value.length <= maximum &&
    value.every((item) => boundedText(item, 256)) && new Set(value).size === value.length;
}

function validIntent(intent: IntentContract): boolean {
  return intentContractSchema.safeParse(intent).success;
}

function queryText(intent: IntentContract, signals: readonly string[] = []): string {
  return [intent.goal, ...intent.in_scope.slice(0, 8), ...intent.constraints.slice(0, 8), ...signals]
    .join(" ").slice(0, 512);
}

function queryPlan(
  intent: IntentContract,
  ordinal: 1 | 2,
  reason: KnowledgeQueryPlan["reason_code"],
  question: string,
  signals: readonly string[]
): KnowledgeQueryPlan {
  const query = queryText(intent, signals);
  const query_hash = stableHash({ intent_hash: intent.intent_hash, ordinal, query, question, signals });
  return deepFreeze({
    schema_version: 1,
    query_id: `knowledge_query:${query_hash.slice(7)}`,
    ordinal,
    query,
    query_hash,
    reason_code: reason,
    planning_question: question,
    signal_refs: [...signals]
  });
}

function validReceipt(receipt: KnowledgeQueryReceipt): boolean {
  return knowledgeQueryReceiptSchema.safeParse(receipt).success;
}

function validKnowledgeQueryState(state: unknown): state is KnowledgeQueryState {
  if (!plainDataRecord(state) || !exactWithOptional(state, [
    "receipts", "first_result_sufficient", "first_result_conflicted", "exploration_signals"
  ], ["planning_question"]) || !Array.isArray(state.receipts) || state.receipts.length !== 1 ||
      state.receipts.some((receipt) => !validReceipt(receipt as KnowledgeQueryReceipt)) ||
      typeof state.first_result_sufficient !== "boolean" ||
      typeof state.first_result_conflicted !== "boolean" ||
      !Array.isArray(state.exploration_signals) || state.exploration_signals.length > 16 ||
      (state.planning_question !== undefined && !boundedText(state.planning_question, 256))) {
    return false;
  }
  return state.exploration_signals.every((signal) => plainDataRecord(signal) &&
    exact(signal, ["kind", "value"]) &&
    (["module", "symbol", "error_code", "migration_id"] as const).includes(signal.kind as never) &&
    boundedText(signal.value, 128));
}

function validSource(source: EvidenceSourceRef): boolean {
  return exact(source, ["source_kind", "source_id", "source_version", "content_hash", "module_refs",
    "symbol_refs", "consumer_refs", "test_refs", "constraint_refs", "unknown_refs"]) &&
    (["map", "codegraph", "file", "config"] as const).includes(source.source_kind) &&
    boundedText(source.source_id, 256) && boundedText(source.source_version, 128) &&
    shaPattern.test(source.content_hash) && [source.module_refs, source.symbol_refs,
      source.consumer_refs, source.test_refs, source.constraint_refs, source.unknown_refs]
      .every((refs) => stringList(refs, 0, 64));
}

function takeRefs(values: readonly string[], remaining: { value: number }): string[] {
  const selected = sortedUnique(values).slice(0, remaining.value);
  remaining.value -= selected.length;
  return selected;
}

interface ParsedPartitionUpdate {
  readonly applies: boolean;
  readonly hash: PlanningContext["partition_hashes"][PlanningPartition];
}

function parsePartitionUpdate<T>(
  update: PlanningPartitionUpdate<T>,
  validValue: (value: unknown) => value is T
): ParsedPartitionUpdate {
  if (!plainDataRecord(update)) throw new PlanningContextError("PLANNING_CONTEXT_INVALID");
  if (update.operation === "unchanged" && exact(update, ["operation"])) {
    return { applies: false, hash: null };
  }
  if (update.operation === "remove" && exact(update, ["operation"])) {
    return { applies: true, hash: null };
  }
  if (update.operation === "set" && exact(update, ["operation", "value"]) &&
      validValue(update.value)) {
    return { applies: true, hash: stableHash(update.value) };
  }
  throw new PlanningContextError("PLANNING_CONTEXT_INVALID");
}

export function createPlanningContextModule(): PlanningContextModule {
  const compressedReceipts = new Set<string>();
  const evidenceIdentities = new Set<string>();
  return {
    buildIntent(input: IntentInput): IntentContract {
      if (input === null || typeof input !== "object" || Array.isArray(input) || !exact(input, [
        "schema_version", "source_input", "goal", "user_visible_outcome", "in_scope", "out_of_scope",
        "constraints", "acceptance_examples", "uncertainties", "created_at"
      ]) || input.schema_version !== 1 || !boundedText(input.source_input, 8_192) ||
          !boundedText(input.goal, 512) || !boundedText(input.user_visible_outcome, 512) ||
          !stringList(input.in_scope, 1, 32) || !stringList(input.out_of_scope, 0, 32) ||
          !stringList(input.constraints, 0, 32) || !stringList(input.acceptance_examples, 2, 5) ||
          !stringList(input.uncertainties, 0, 16) || !validTime(input.created_at)) {
        throw new PlanningContextError("PLANNING_INTENT_INVALID");
      }
      const body = {
        schema_version: 1 as const,
        goal: input.goal,
        user_visible_outcome: input.user_visible_outcome,
        in_scope: sortedUnique(input.in_scope),
        out_of_scope: sortedUnique(input.out_of_scope),
        constraints: sortedUnique(input.constraints),
        acceptance_examples: [...input.acceptance_examples],
        uncertainties: sortedUnique(input.uncertainties),
        source_input_hash: stableHash(input.source_input),
        created_at: input.created_at
      };
      const intent_hash = stableHash(body);
      return deepFreeze(intentContractSchema.parse({
        ...body, intent_id: `intent:${intent_hash.slice(7)}`, intent_hash
      }));
    },

    buildKnowledgeQuery(intent: IntentContract, state?: KnowledgeQueryState): readonly KnowledgeQueryPlan[] {
      if (!validIntent(intent)) throw new PlanningContextError("PLANNING_KNOWLEDGE_QUERY_INVALID");
      if (state === undefined) {
        return [queryPlan(intent, 1, "initial_intent", "Find prior verified implementation facts.", [])];
      }
      if (!validKnowledgeQueryState(state)) {
        throw new PlanningContextError("PLANNING_KNOWLEDGE_QUERY_INVALID");
      }
      const first = state.receipts[0];
      if (first === undefined) throw new PlanningContextError("PLANNING_KNOWLEDGE_QUERY_INVALID");
      if (first.status === "failed" || (state.first_result_sufficient && !state.first_result_conflicted)) {
        return [];
      }
      const signals = sortedUnique(state.exploration_signals.map((signal) => {
        return `${signal.kind}:${signal.value}`;
      }));
      if (signals.length === 0 || !boundedText(state.planning_question, 256)) return [];
      return [queryPlan(intent, 2, "directed_evidence_followup", state.planning_question, signals)];
    },

    compressKnowledge(
      receipt: KnowledgeQueryReceipt,
      results: readonly KnowledgeResult[],
      intent: IntentContract
    ): KnowledgeContext {
      if (!validReceipt(receipt) || receipt.status !== "succeeded" || !validIntent(intent) ||
          results.length > 10 ||
          sortedUnique(results.map((item) => item.result_id)).join("\0") !==
            sortedUnique(receipt.result_ids).join("\0")) {
        throw new PlanningContextError("PLANNING_KNOWLEDGE_RECEIPT_INVALID");
      }
      if (compressedReceipts.has(receipt.receipt_id)) {
        throw new PlanningContextError("PLANNING_KNOWLEDGE_ALREADY_COMPRESSED");
      }
      const optionalResult = ["source", "verified_at", "source_version", "conflict_summary"];
      const requiredResult = ["result_id", "kind", "summary", "relevance", "conflicts_with_intent"];
      if (results.some((result) => !exactWithOptional(result, requiredResult, optionalResult) ||
          !idPattern.test(result.result_id) || !boundedText(result.summary, 1_024) ||
          !(["high", "medium", "low"] as const).includes(result.relevance) ||
          (result.source !== undefined && !boundedText(result.source, 256)) ||
          (result.verified_at !== undefined && !validTime(result.verified_at)) ||
          (result.source_version !== undefined && !boundedText(result.source_version, 128)) ||
          (result.source_version !== undefined &&
            !receipt.source_versions.includes(result.source_version)) ||
          typeof result.conflicts_with_intent !== "boolean" ||
          (result.conflicts_with_intent && !boundedText(result.conflict_summary, 512)))) {
        throw new PlanningContextError("PLANNING_KNOWLEDGE_RECEIPT_INVALID");
      }
      const eligible = results.filter((result) => allowedKnowledgeKinds.has(result.kind))
        .sort((left, right) => {
          const rank: Record<KnowledgeResult["relevance"], number> = { high: 0, medium: 1, low: 2 };
          return rank[left.relevance] - rank[right.relevance] || compareCodepoint(left.result_id, right.result_id);
        });
      const retained = eligible.length >= 3 ? eligible.slice(0, 5) : [];
      const items = retained.map((result) => ({
        result_id: result.result_id,
        ...(result.source === undefined ? {} : { source: result.source }),
        ...(result.verified_at === undefined ? {} : { verified_at: result.verified_at }),
        ...(result.source_version === undefined ? {} : { source_version: result.source_version }),
        provenance_status: result.source !== undefined && result.verified_at !== undefined &&
          result.source_version !== undefined
          ? "complete" as const : "incomplete" as const,
        relevance: result.relevance,
        summary: result.summary,
        conflict: result.conflicts_with_intent
      }));
      const unresolved = retained.filter((item) => item.conflicts_with_intent).map((item) =>
        knowledgeConflictDecisionId(intent.intent_id, item.result_id)
      );
      const truncation = sortedUnique([
        ...(results.some((result) => !allowedKnowledgeKinds.has(result.kind)) ? ["non_knowledge_kind"] : []),
        ...(eligible.length > 5 ? ["result_limit"] : []),
        ...(eligible.length < 3 ? ["fewer_than_recommended"] : [])
      ]) as KnowledgeContext["truncation_reasons"];
      const body = {
        schema_version: 1 as const,
        intent_contract_ref: intent.intent_id,
        query_receipt_ref: receipt.receipt_id,
        query_receipt: structuredClone(receipt),
        retained_result_ids: items.map((item) => item.result_id),
        items,
        truncation_reasons: truncation,
        provenance_status: items.every((item) => item.provenance_status === "complete")
          ? "complete" as const : "incomplete" as const,
        unresolved_decision_ids: unresolved
      };
      const compression_hash = stableHash(body);
      compressedReceipts.add(receipt.receipt_id);
      return deepFreeze(knowledgeContextSchema.parse({
        ...body,
        knowledge_context_id: `knowledge_context:${compression_hash.slice(7)}`,
        compression_hash
      }));
    },

    buildEvidenceMap(input: EvidenceMapInput): EvidenceMap {
      if (input === null || typeof input !== "object" || Array.isArray(input) ||
          !exactWithOptional(input, ["schema_version", "sources", "budget", "created_at"],
            ["map_manifest_hash", "codegraph_index_hash"]) ||
          input.schema_version !== 1 || !Array.isArray(input.sources) || input.sources.length === 0 ||
          input.sources.some((source) => !validSource(source)) || !validTime(input.created_at) ||
          (input.map_manifest_hash !== undefined && !shaPattern.test(input.map_manifest_hash)) ||
          (input.codegraph_index_hash !== undefined && !shaPattern.test(input.codegraph_index_hash)) ||
          !exact(input.budget, ["max_sources", "max_refs"]) ||
          !Number.isSafeInteger(input.budget.max_sources) || input.budget.max_sources < 1 ||
          input.budget.max_sources > 64 || !Number.isSafeInteger(input.budget.max_refs) ||
          input.budget.max_refs < 1 || input.budget.max_refs > 512) {
        throw new PlanningContextError("PLANNING_EVIDENCE_INVALID");
      }
      const sourceIdentity = stableHash({
        map_manifest_hash: input.map_manifest_hash,
        codegraph_index_hash: input.codegraph_index_hash,
        sources: input.sources.map((source) => ({
          source_kind: source.source_kind, source_id: source.source_id,
          source_version: source.source_version, content_hash: source.content_hash
        })).sort((left, right) => compareCodepoint(sourceRefIdentity(left), sourceRefIdentity(right)))
      });
      if (evidenceIdentities.has(sourceIdentity)) throw new PlanningContextError("PLANNING_EVIDENCE_INVALID");
      if (new Set(input.sources.map(sourceRefIdentity)).size !== input.sources.length) {
        throw new PlanningContextError("PLANNING_EVIDENCE_INVALID");
      }
      const sources = [...input.sources].sort((left, right) =>
        compareCodepoint(sourceRefIdentity(left), sourceRefIdentity(right)))
        .slice(0, input.budget.max_sources);
      const remaining = { value: input.budget.max_refs };
      const modules = takeRefs(sources.flatMap((source) => source.module_refs), remaining);
      const symbols = takeRefs(sources.flatMap((source) => source.symbol_refs), remaining);
      const consumers = takeRefs(sources.flatMap((source) => source.consumer_refs), remaining);
      const tests = takeRefs(sources.flatMap((source) => source.test_refs), remaining);
      const constraints = takeRefs(sources.flatMap((source) => source.constraint_refs), remaining);
      const unknowns = takeRefs(sources.flatMap((source) => source.unknown_refs), remaining);
      const usedRefs = input.budget.max_refs - remaining.value;
      const body = {
        schema_version: 1 as const,
        source_identity_hash: sourceIdentity,
        ...(input.map_manifest_hash === undefined ? {} : { map_manifest_hash: input.map_manifest_hash }),
        ...(input.codegraph_index_hash === undefined ? {} : {
          codegraph_index_hash: input.codegraph_index_hash
        }),
        modules, symbols, consumers,
        tests, constraints, unknowns,
        source_refs: sources.map(({ source_kind, source_id, source_version, content_hash }) =>
          ({ source_kind, source_id, source_version, content_hash })),
        used_budget: { sources: sources.length, refs: usedRefs },
        truncation_reasons: [
          ...(sources.length < input.sources.length ? ["source_budget_exhausted" as const] : []),
          ...(remaining.value === 0 ? ["reference_budget_exhausted" as const] : [])
        ],
        created_at: input.created_at
      };
      evidenceIdentities.add(sourceIdentity);
      return deepFreeze(evidenceMapSchema.parse({
        ...body, evidence_map_id: `evidence_map:${stableHash(body).slice(7)}`
      }));
    },

    buildPlanningContext(input): PlanningContext {
      if (!exactWithOptional(input, ["profile", "phase_set", "intent", "evidence", "created_at"],
        ["knowledge", "trusted_knowledge_receipt", "rules_manifest_hash", "map_manifest_hash",
          "supersedes"]) ||
          !planProfileSchema.safeParse(input.profile).success ||
          !plannedPhaseSetSchema.safeParse(input.phase_set).success ||
          input.phase_set.outcome !== "configured" ||
          input.phase_set.profile_classification_hash !== input.profile.classification_hash ||
          !validIntent(input.intent) || !evidenceMapSchema.safeParse(input.evidence).success ||
          (input.knowledge !== undefined && !knowledgeContextSchema.safeParse(input.knowledge).success) ||
          (input.trusted_knowledge_receipt !== undefined &&
            !knowledgeQueryReceiptSchema.safeParse(input.trusted_knowledge_receipt).success) ||
          (input.knowledge === undefined) !== (input.trusted_knowledge_receipt === undefined) ||
          (input.knowledge !== undefined && input.trusted_knowledge_receipt !== undefined &&
            (input.knowledge.intent_contract_ref !== input.intent.intent_id ||
              input.knowledge.query_receipt_ref !== input.trusted_knowledge_receipt.receipt_id ||
              stableHash(input.knowledge.query_receipt) !==
                stableHash(input.trusted_knowledge_receipt))) ||
          !validTime(input.created_at) ||
          (input.rules_manifest_hash !== undefined && !shaPattern.test(input.rules_manifest_hash)) ||
          (input.map_manifest_hash !== undefined && !shaPattern.test(input.map_manifest_hash))) {
        throw new PlanningContextError("PLANNING_CONTEXT_INVALID");
      }
      const partition_hashes = {
        intent: stableHash(input.intent.intent_hash),
        knowledge: input.knowledge === undefined ? null : stableHash(input.knowledge.knowledge_context_id),
        evidence: stableHash(input.evidence.evidence_map_id),
        rules: input.rules_manifest_hash === undefined ? null : stableHash(input.rules_manifest_hash),
        map: input.map_manifest_hash === undefined ? null : stableHash(input.map_manifest_hash),
        profile: stableHash(input.profile.classification_hash),
        phases: stableHash(input.phase_set.phase_set_id)
      };
      const body = {
        schema_version: 1 as const,
        plan_profile_ref: input.profile.profile_id,
        planned_phase_set_ref: input.phase_set.phase_set_id,
        intent_contract_ref: input.intent.intent_id,
        ...(input.knowledge === undefined ? {} : { knowledge_context_ref: input.knowledge.knowledge_context_id }),
        evidence_map_ref: input.evidence.evidence_map_id,
        ...(input.rules_manifest_hash === undefined ? {} : { rules_manifest_hash: input.rules_manifest_hash }),
        ...(input.map_manifest_hash === undefined ? {} : { map_manifest_hash: input.map_manifest_hash }),
        partition_hashes,
        unresolved_decision_ids: sortedUnique([
          ...input.intent.uncertainties.map((uncertainty) =>
            `intent_uncertainty:${stableHash(uncertainty).slice(7)}`),
          ...(input.knowledge?.unresolved_decision_ids ?? [])
        ]),
        created_at: input.created_at,
        ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes })
      };
      const status = body.unresolved_decision_ids.length === 0 ? "ready" as const : "decisions_required" as const;
      const identity = stableHash({ ...body, status });
      return deepFreeze(planningContextSchema.parse({
        ...body, status, context_id: `planning_context:${identity.slice(7)}`
      }));
    },

    invalidatePartitions(previous, changed) {
      if (!plainDataRecord(changed) || !exact(changed, [
        "intent_hash", "knowledge_context_ref", "evidence_map_ref", "rules_manifest_hash",
        "map_manifest_hash", "profile_classification_hash", "phase_set_ref"
      ])) throw new PlanningContextError("PLANNING_CONTEXT_INVALID");
      const updates = {
        intent: parsePartitionUpdate(changed.intent_hash, (value): value is `sha256:${string}` =>
          typeof value === "string" && shaPattern.test(value)),
        knowledge: parsePartitionUpdate(changed.knowledge_context_ref,
          (value): value is `knowledge_context:${string}` => typeof value === "string" &&
            /^knowledge_context:[a-f0-9]{64}$/u.test(value)),
        evidence: parsePartitionUpdate(changed.evidence_map_ref,
          (value): value is `evidence_map:${string}` => typeof value === "string" &&
            /^evidence_map:[a-f0-9]{64}$/u.test(value)),
        rules: parsePartitionUpdate(changed.rules_manifest_hash, (value): value is `sha256:${string}` =>
          typeof value === "string" && shaPattern.test(value)),
        map: parsePartitionUpdate(changed.map_manifest_hash, (value): value is `sha256:${string}` =>
          typeof value === "string" && shaPattern.test(value)),
        profile: parsePartitionUpdate(changed.profile_classification_hash,
          (value): value is `sha256:${string}` => typeof value === "string" && shaPattern.test(value)),
        phases: parsePartitionUpdate(changed.phase_set_ref,
          (value): value is `planned_phase_set:${string}` => typeof value === "string" &&
            /^planned_phase_set:[a-f0-9]{64}$/u.test(value))
      };
      const invalid = new Set<PlanningPartition>();
      if (updates.intent.applies && updates.intent.hash !== previous.partition_hashes.intent) {
        invalid.add("intent"); invalid.add("knowledge"); invalid.add("evidence");
      }
      if (updates.knowledge.applies && updates.knowledge.hash !== previous.partition_hashes.knowledge) {
        invalid.add("knowledge");
      }
      if (updates.evidence.applies && updates.evidence.hash !== previous.partition_hashes.evidence) {
        invalid.add("evidence");
      }
      if (updates.rules.applies && updates.rules.hash !== previous.partition_hashes.rules) invalid.add("rules");
      if (updates.map.applies && updates.map.hash !== previous.partition_hashes.map) {
        invalid.add("map"); invalid.add("evidence");
      }
      if (updates.profile.applies && updates.profile.hash !== previous.partition_hashes.profile) {
        invalid.add("profile"); invalid.add("phases");
      }
      if (updates.phases.applies && updates.phases.hash !== previous.partition_hashes.phases) {
        invalid.add("phases");
      }
      const invalidated_partitions = partitions.filter((partition) => invalid.has(partition)).sort(compareCodepoint);
      return deepFreeze({
        invalidated_partitions,
        retained_partitions: partitions.filter((partition) => !invalid.has(partition)).sort(compareCodepoint)
      });
    }
  };
}
