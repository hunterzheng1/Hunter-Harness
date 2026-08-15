import type {
  PlanArtifactPublicationPlan,
  PlanPublicationPayloadDescriptor
} from "../../plan-artifacts/publication/types.js";

export const PLAN_DURABLE_PUBLICATION_SCHEMA_VERSION = 1 as const;
export const PLAN_DURABLE_PUBLICATION_PAYLOAD_COUNT = 8 as const;

export type PlanDurablePublicationSha256 = `sha256:${string}`;

export type PlanDurablePublicationBaseline =
  | { readonly state: "absent"; readonly manifest_hash: null; readonly generation: 0 }
  | { readonly state: "present"; readonly manifest_hash: PlanDurablePublicationSha256; readonly generation: number };

export interface PlanDurablePublicationCommitInput {
  readonly schema_version: 1;
  readonly operation_id: string;
  readonly idempotency_key: string;
  readonly project_id: string;
  readonly change_key: string;
  readonly expected_baseline: PlanDurablePublicationBaseline;
  readonly plan: PlanArtifactPublicationPlan;
  /** Existing v1 finalization is accepted only for read-only migration checks. */
  readonly finalization?: unknown;
}

export interface PlanDurablePublicationLookupInput {
  readonly schema_version: 1;
  readonly operation_id: string;
  readonly idempotency_key: string;
  readonly project_id: string;
  readonly change_key: string;
  readonly publication_intent_id: string;
  readonly plan_hash: PlanDurablePublicationSha256;
  readonly manifest_hash: PlanDurablePublicationSha256;
}

export interface PlanDurablePublicationRollbackInput {
  readonly schema_version: 1;
  readonly operation_id: string;
  readonly idempotency_key: string;
  readonly project_id: string;
  readonly change_key: string;
  readonly expected_baseline: PlanDurablePublicationBaseline;
  readonly target_manifest_hash: PlanDurablePublicationSha256;
  readonly target_generation: number;
  readonly plan_hash: PlanDurablePublicationSha256;
}

export interface PlanDurablePublicationReceipt {
  readonly schema_version: 1;
  readonly receipt_id: `plan_durable_publication_receipt:${string}`;
  readonly operation_id: string;
  readonly idempotency_key: string;
  readonly project_id: string;
  readonly change_key: string;
  readonly publication_intent_id: string;
  readonly plan_hash: PlanDurablePublicationSha256;
  readonly previous_manifest_hash: PlanDurablePublicationSha256 | null;
  readonly manifest_hash: PlanDurablePublicationSha256;
  readonly previous_generation: number;
  readonly generation: number;
  readonly modified_paths: readonly string[];
  readonly preserved_paths: readonly string[];
  /** Opaque durable audit-event reference issued by the Port; never interpreted as a local event. */
  readonly event_id: string;
  readonly committed_at: string;
  readonly rollback_of_operation_id?: string;
}

export type PlanDurablePublicationPortResult =
  | { readonly state: "committed" | "replayed"; readonly receipt: PlanDurablePublicationReceipt }
  | { readonly state: "unknown"; readonly receipt: null }
  | { readonly state: "baseline_conflict" | "idempotency_conflict"; readonly receipt: null };

export interface PlanDurablePublicationEventDescriptor {
  readonly schema_version: 1;
  readonly event_kind: "publication_durable";
  readonly operation_id: string;
  readonly change_key: string;
  readonly publication_intent_id: string;
  readonly receipt_id: string;
  readonly generation: number;
  readonly occurred_at: string;
}

/** Async effect boundary. The Port owns CAS and durable transaction semantics. */
export interface PlanDurablePublicationPort {
  publish(input: PlanDurablePublicationCommitInput | PlanDurablePublicationRollbackInput): Promise<unknown>;
  lookup(input: PlanDurablePublicationLookupInput): Promise<unknown>;
}

export type PlanDurablePublicationResult =
  | { readonly ok: true; readonly outcome: "committed" | "replayed"; readonly receipt: PlanDurablePublicationReceipt;
      readonly event_allowed: true; readonly event: PlanDurablePublicationEventDescriptor }
  | { readonly ok: false; readonly outcome: "unknown" | "baseline_conflict" | "idempotency_conflict" | "legacy_read_only";
      readonly receipt: null; readonly operation_id: string };

export interface PlanDurablePublicationModule {
  publish(input: unknown): Promise<PlanDurablePublicationResult>;
  rollback(input: unknown): Promise<PlanDurablePublicationResult>;
  lookup(input: unknown): Promise<PlanDurablePublicationResult>;
  readReceipt(input: unknown):
    | { readonly ok: true; readonly mode: "current"; readonly value: PlanDurablePublicationReceipt }
    | { readonly ok: true; readonly mode: "legacy_read_only"; readonly source_schema_version: 0 | 1 }
    | { readonly ok: false; readonly reason_code: "PLAN_DURABLE_PUBLICATION_RECEIPT_INVALID" };
}

export type PlanDurablePublicationPlanDescriptor = PlanPublicationPayloadDescriptor;
