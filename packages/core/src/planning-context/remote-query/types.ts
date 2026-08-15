import type {
  KnowledgeQueryReason,
  KnowledgeResult,
  KnowledgeQueryReceipt,
  PlanningSha256
} from "../types.js";

export const REMOTE_KNOWLEDGE_QUERY_SCHEMA_VERSION = 1 as const;
export const REMOTE_KNOWLEDGE_MAX_RESULTS = 10 as const;
export const REMOTE_KNOWLEDGE_MAX_SUMMARY_BYTES = 65_536 as const;
export const REMOTE_KNOWLEDGE_MAX_DEADLINE_MS = 60_000 as const;

export interface RemoteKnowledgeQueryBudget {
  readonly max_results: number;
  readonly max_total_summary_bytes: number;
  readonly deadline_ms: number;
}

/** Browser-safe request. The authenticated actor is supplied by the host, never by this body. */
export interface RemoteKnowledgeQueryRequest {
  readonly schema_version: 1;
  readonly project_id: string;
  readonly query_id: `knowledge_query:${string}`;
  readonly query_hash: PlanningSha256;
  readonly reason_code: KnowledgeQueryReason;
  readonly query: string;
  readonly budget: RemoteKnowledgeQueryBudget;
}

export interface RemoteKnowledgeQueryResponse {
  readonly schema_version: 1;
  readonly query_id: `knowledge_query:${string}`;
  readonly project_id: string;
  readonly receipt: KnowledgeQueryReceipt;
  readonly results: readonly KnowledgeResult[];
}

/** One narrow transport seam; implementations must return a native Promise. */
export interface RemoteKnowledgeQueryPort {
  readonly execute: (
    request: RemoteKnowledgeQueryRequest,
    signal?: AbortSignal
  ) => Promise<RemoteKnowledgeQueryResponse>;
}

export interface RemoteKnowledgeQueryModule {
  query(
    request: RemoteKnowledgeQueryRequest,
    signal?: AbortSignal
  ): Promise<RemoteKnowledgeQueryResponse>;
}

export type RemoteKnowledgeQueryErrorCode =
  | "REMOTE_KNOWLEDGE_REQUEST_INVALID"
  | "REMOTE_KNOWLEDGE_PORT_INVALID"
  | "REMOTE_KNOWLEDGE_RESPONSE_INVALID"
  | "REMOTE_KNOWLEDGE_UNAVAILABLE"
  | "REMOTE_KNOWLEDGE_ABORTED";

export class RemoteKnowledgeQuerySeamError extends Error {
  readonly code: RemoteKnowledgeQueryErrorCode;

  constructor(code: RemoteKnowledgeQueryErrorCode) {
    super(code);
    this.name = "RemoteKnowledgeQuerySeamError";
    this.code = code;
  }
}
