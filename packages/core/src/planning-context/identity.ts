import { sortedUnique, stableHash } from "./stable.js";
import type { KnowledgeQueryReceipt, PlanningSha256 } from "./types.js";

export interface KnowledgeResultSetIdentity {
  readonly index_generation: string | null;
  readonly result_ids: readonly string[];
  readonly source_versions: readonly string[];
}

export function knowledgeResultSetIdentity(input: Pick<KnowledgeQueryReceipt,
  "index_generation" | "result_ids" | "source_versions"
>): KnowledgeResultSetIdentity {
  return {
    index_generation: input.index_generation ?? null,
    result_ids: sortedUnique(input.result_ids),
    source_versions: sortedUnique(input.source_versions)
  };
}

export function knowledgeResultSetHash(input: Pick<KnowledgeQueryReceipt,
  "index_generation" | "result_ids" | "source_versions"
>): PlanningSha256 {
  return stableHash(knowledgeResultSetIdentity(input));
}

export function knowledgeQueryReceiptIdentity(input: Omit<KnowledgeQueryReceipt, "receipt_id">): object {
  return {
    schema_version: input.schema_version,
    query_hash: input.query_hash,
    project_id: input.project_id,
    index_generation: input.index_generation ?? null,
    result_ids: sortedUnique(input.result_ids),
    source_versions: sortedUnique(input.source_versions),
    result_set_hash: input.result_set_hash,
    status: input.status,
    executed_at: input.executed_at,
    reason_code: input.reason_code,
    failure_code: input.failure_code ?? null,
    supersedes: input.supersedes ?? null
  };
}

export function knowledgeQueryReceiptId(
  input: Omit<KnowledgeQueryReceipt, "receipt_id">
): `knowledge_query_receipt:${string}` {
  return `knowledge_query_receipt:${stableHash(knowledgeQueryReceiptIdentity(input))
    .slice("sha256:".length)}`;
}

export function knowledgeConflictDecisionId(
  intent_contract_ref: `intent:${string}`,
  result_id: string
): `knowledge_conflict:${string}` {
  const intent_hash = `sha256:${intent_contract_ref.slice("intent:".length)}`;
  return `knowledge_conflict:${stableHash({ intent_hash, result_id }).slice("sha256:".length)}`;
}
