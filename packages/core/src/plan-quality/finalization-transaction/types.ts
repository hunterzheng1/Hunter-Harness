import type { PlanPhase } from "../../plan-classification/index.js";
import type { PlanArtifactPublicationPlan } from "../../plan-artifacts/publication/types.js";
import type {
  PlanDurablePublicationBaseline,
  PlanDurablePublicationFilesystemHostAuthority,
  PlanDurablePublicationFilesystemReadback,
  PlanDurablePublicationFilesystemTransactionInspection,
  PlanDurablePublicationFilesystemTransactionPort,
  PlanDurablePublicationModule,
  PlanDurablePublicationReceipt,
  PlanDurablePublicationSha256
} from "../index.js";
import type { Layer1Receipt, Layer2Receipt, Layer3Receipt, PlanEvent, PlanFinalizationReceipt } from "../types.js";
import type { PlanDurablePublicationFilesystemBinding } from "../durable-publication-filesystem-contract/types.js";

export const PLAN_FINALIZATION_TRANSACTION_SCHEMA_VERSION = 1 as const;
export const PLAN_FINALIZATION_TRANSACTION_RECORD_KIND = "plan_finalization_transaction" as const;
export const PLAN_FINALIZATION_EVENT_OUTBOX_SCHEMA_VERSION = 1 as const;
export const PLAN_FINALIZATION_EVENT_OUTBOX_RECORD_KIND = "plan_finalization_event_outbox" as const;
export const PLAN_FINALIZATION_CANONICAL_PAYLOAD_COUNT = 8 as const;

export type PlanFinalizationEventCommitStatus =
  | "publication_committed_event_pending"
  | "publication_committed_event_complete"
  | "publication_committed_event_ambiguous"
  | "publication_committed_event_failed";

export type PlanFinalizationTransactionStatus = PlanFinalizationEventCommitStatus |
  "publication_not_committed" | "blocked" | "legacy_read_only";

export interface PlanFinalizationExecutionContext {
  readonly schema_version: 1;
  readonly project_id: string;
  readonly change_key: string;
  readonly run_id: string;
  readonly branch_name: string;
  readonly attempt: number;
  readonly phase: PlanPhase;
  /** Supplied by the host. This module never derives root identity or a path. */
  readonly root_authority: PlanDurablePublicationFilesystemHostAuthority;
}

export interface PlanFinalizationEvidence {
  readonly schema_version: 1;
  readonly branch_name: string;
  readonly receipt: PlanFinalizationReceipt;
  readonly events: readonly PlanEvent[];
  /** Optional full quality verifier input; a verifier may re-run the pure Module. */
  readonly quality_verification_input?: unknown;
  readonly layer_receipts?: readonly [Layer1Receipt, Layer2Receipt, Layer3Receipt];
}

export interface PlanFinalizationRendererInput {
  readonly schema_version: 1;
  readonly context: PlanFinalizationExecutionContext;
  readonly finalization: PlanFinalizationEvidence;
}

export interface PlanFinalizationRendererPort {
  render(input: PlanFinalizationRendererInput): PlanArtifactPublicationPlan | Promise<PlanArtifactPublicationPlan>;
}

export interface PlanFinalizationQualityVerifierPort {
  verify(input: PlanFinalizationQualityVerificationInput): PlanFinalizationQualityVerificationProof | { readonly valid: false; readonly reason_code?: string } |
    Promise<PlanFinalizationQualityVerificationProof | { readonly valid: false; readonly reason_code?: string }>;
}

export interface PlanFinalizationQualityVerificationInput {
  readonly schema_version: 1;
  readonly operation_id: string;
  readonly context: PlanFinalizationExecutionContext;
  readonly finalization: PlanFinalizationEvidence;
  readonly plan: PlanArtifactPublicationPlan;
  readonly plan_hash: PlanDurablePublicationSha256;
  readonly event_bundle_hash: PlanDurablePublicationSha256;
}

export interface PlanFinalizationQualityVerificationProof {
  readonly schema_version: 1;
  readonly valid: true;
  readonly receipt_hash: PlanDurablePublicationSha256;
  readonly plan_hash: PlanDurablePublicationSha256;
  readonly layer_receipt_hashes: readonly [PlanDurablePublicationSha256, PlanDurablePublicationSha256, PlanDurablePublicationSha256];
  readonly event_bundle_hash: PlanDurablePublicationSha256;
  readonly proof_hash: PlanDurablePublicationSha256;
}

export interface PlanFinalizationEventOutboxEnqueueInput {
  readonly schema_version: 1;
  readonly record_kind: typeof PLAN_FINALIZATION_EVENT_OUTBOX_RECORD_KIND;
  readonly outbox_id: string;
  readonly operation_id: string;
  readonly idempotency_key: string;
  readonly context: PlanFinalizationExecutionContext;
  readonly publication_receipt: PlanDurablePublicationReceipt;
  readonly event_bundle_hash: PlanDurablePublicationSha256;
  readonly events: readonly PlanEvent[];
}

export interface PlanFinalizationEventOutboxRecord {
  readonly schema_version: 1;
  readonly record_kind: typeof PLAN_FINALIZATION_EVENT_OUTBOX_RECORD_KIND;
  readonly outbox_id: string;
  readonly operation_id: string;
  readonly idempotency_key: string;
  readonly project_id: string;
  readonly change_key: string;
  readonly run_id: string;
  readonly branch_name: string;
  readonly attempt: number;
  readonly publication_receipt_id: string;
  readonly publication_generation: number;
  readonly publication_manifest_hash: PlanDurablePublicationSha256;
  readonly event_bundle_hash: PlanDurablePublicationSha256;
  readonly events: readonly PlanEvent[];
  readonly state: "pending" | "delivered" | "ambiguous" | "failed";
  readonly created_at: string;
  readonly updated_at: string;
}

export interface PlanFinalizationTransactionRecord {
  readonly schema_version: 1;
  readonly record_kind: typeof PLAN_FINALIZATION_TRANSACTION_RECORD_KIND;
  readonly record_hash: PlanDurablePublicationSha256;
  readonly operation_id: string;
  readonly idempotency_key: string;
  readonly project_id: string;
  readonly change_key: string;
  readonly run_id: string;
  readonly branch_name: string;
  readonly attempt: number;
  readonly context: PlanFinalizationExecutionContext;
  readonly expected_baseline: PlanDurablePublicationBaseline;
  readonly finalization_receipt_hash: PlanDurablePublicationSha256;
  readonly event_bundle_hash: PlanDurablePublicationSha256;
  readonly plan_hash: PlanDurablePublicationSha256 | null;
  readonly manifest_hash: PlanDurablePublicationSha256 | null;
  readonly ownership_paths: readonly string[];
  readonly filesystem_binding: PlanDurablePublicationFilesystemBinding | null;
  readonly publication_receipt: PlanDurablePublicationReceipt | null;
  readonly event_outbox_id: string | null;
  readonly status: PlanFinalizationTransactionStatus;
  readonly reason_code: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface PlanFinalizationEventOutboxDeliveryInput {
  readonly schema_version: 1;
  readonly outbox_id: string;
  readonly operation_id: string;
  readonly idempotency_key: string;
  readonly event_bundle_hash: PlanDurablePublicationSha256;
  readonly publication_receipt_id: string;
}

export interface PlanFinalizationEventOutboxPort {
  prepareTransaction(input: PlanFinalizationTransactionRecord): PlanFinalizationTransactionRecord | Promise<PlanFinalizationTransactionRecord>;
  updateTransaction(input: PlanFinalizationTransactionRecord): PlanFinalizationTransactionRecord | Promise<PlanFinalizationTransactionRecord>;
  inspectTransaction(input: { readonly operation_id: string; readonly idempotency_key?: string }): PlanFinalizationTransactionRecord | undefined |
    Promise<PlanFinalizationTransactionRecord | undefined>;
  enqueue(input: PlanFinalizationEventOutboxEnqueueInput): PlanFinalizationEventOutboxRecord | Promise<PlanFinalizationEventOutboxRecord>;
  deliver(input: PlanFinalizationEventOutboxDeliveryInput): PlanFinalizationEventOutboxRecord | Promise<PlanFinalizationEventOutboxRecord>;
  inspect(input: { readonly outbox_id: string; readonly operation_id: string; readonly idempotency_key: string }): PlanFinalizationEventOutboxRecord | undefined |
    Promise<PlanFinalizationEventOutboxRecord | undefined>;
}

export type PlanFinalizationFilesystemPort = PlanDurablePublicationFilesystemTransactionPort;

export interface PlanFinalizationTransactionInput {
  readonly schema_version: 1;
  readonly operation_id: string;
  readonly idempotency_key: string;
  readonly context: PlanFinalizationExecutionContext;
  readonly finalization: PlanFinalizationEvidence;
  readonly expected_baseline: PlanDurablePublicationBaseline;
  readonly plan?: PlanArtifactPublicationPlan;
  readonly recovery_token: `plan_recovery:${string}`;
}

export interface PlanFinalizationTransactionDependencies {
  readonly filesystem: PlanFinalizationFilesystemPort;
  readonly publication: PlanDurablePublicationModule;
  readonly event_outbox: PlanFinalizationEventOutboxPort;
  readonly renderer: PlanFinalizationRendererPort;
  readonly quality_verifier: PlanFinalizationQualityVerifierPort;
  readonly clock: () => string;
}

export interface PlanFinalizationTransactionResult {
  readonly ok: boolean;
  readonly status: PlanFinalizationTransactionStatus;
  readonly operation_id: string;
  readonly publication_receipt: PlanDurablePublicationReceipt | null;
  readonly event_outbox: PlanFinalizationEventOutboxRecord | null;
  readonly event_bundle_hash: PlanDurablePublicationSha256 | null;
  readonly record: PlanFinalizationTransactionRecord | null;
  readonly reason_code?: string;
}

export interface PlanFinalizationTransactionInspection {
  readonly operation_id: string;
  readonly filesystem: PlanDurablePublicationFilesystemTransactionInspection | null;
  readonly readback: PlanDurablePublicationFilesystemReadback | null;
  readonly publication_receipt: PlanDurablePublicationReceipt | null;
  readonly event_outbox: PlanFinalizationEventOutboxRecord | null;
  readonly record: PlanFinalizationTransactionRecord | null;
}

export interface PlanFinalizationTransactionModule {
  finalize(input: unknown): Promise<PlanFinalizationTransactionResult>;
  resume(input: unknown): Promise<PlanFinalizationTransactionResult>;
  inspect(input: unknown): Promise<PlanFinalizationTransactionInspection>;
  readRecord(input: unknown): PlanFinalizationTransactionResult | { readonly ok: false; readonly reason_code: "PLAN_FINALIZATION_RECORD_INVALID" };
}

export interface InMemoryPlanFinalizationFilesystemPortOptions {
  readonly apply_outcome?: "complete" | "ambiguous" | "failed";
}

export interface InMemoryPlanFinalizationEventOutboxPortOptions {
  readonly delivery?: "complete" | "ambiguous" | "failed" | "pending";
}
