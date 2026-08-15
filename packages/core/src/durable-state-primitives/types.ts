export const DURABLE_STATE_SCHEMA_VERSION = 1 as const;

export type DurableSha256 = `sha256:${string}`;

export interface AggregateIdentity {
  readonly schema_version: 1;
  readonly project_id: string;
  readonly change_key: string;
}

export type HostActorAuthorityKind = "user" | "agent" | "service";

export interface HostActorAuthority {
  readonly schema_version: 1;
  readonly actor_id: string;
  readonly authority_kind: HostActorAuthorityKind;
  readonly authority_ref: string;
}

export interface RecordDescriptor {
  readonly schema_version: 1;
  readonly record_kind: string;
  readonly record_id: string;
  readonly record_schema_version: number;
  readonly content_hash: DurableSha256;
  /** Optional descriptor-only references for compound durable records. Never embeds payload. */
  readonly profile_ref?: RecordDescriptor;
  readonly planned_phase_set_ref?: RecordDescriptor;
}

export interface ArtifactBlobRef {
  readonly schema_version: 1;
  readonly content_sha256: DurableSha256;
  readonly byte_length: number;
  readonly media_type: string;
  readonly encoding: "identity" | "gzip" | "br";
  readonly storage_ref: string;
}

export interface DurableCommandIdentity {
  readonly schema_version: 1;
  readonly idempotency_key: string;
  readonly command_hash: DurableSha256;
}

export interface RevisionExpectation {
  readonly expected_revision: number | null;
}

export type DurableMutationOutcome =
  | "committed"
  | "replayed"
  | "revision_conflict"
  | "idempotency_conflict";

export interface DurableMutationReceipt {
  readonly schema_version: 1;
  readonly receipt_id: string;
  readonly outcome: "committed" | "replayed";
  readonly aggregate: AggregateIdentity;
  readonly command: DurableCommandIdentity;
  readonly revision: number;
  readonly descriptor: RecordDescriptor;
  readonly audit_event_id: string;
}

export type DurableAuditStreamKind =
  | "instruction_proposal"
  | "plan_classification"
  | "planning_context"
  | "plan_decision"
  | "plan_artifact"
  | "plan_quality"
  | "plan_finalization";

export interface AuditEnvelopeV1 {
  readonly schema_version: 1;
  readonly event_id: string;
  readonly aggregate: AggregateIdentity;
  readonly stream_kind: DurableAuditStreamKind;
  readonly stream_revision: number;
  readonly event_kind: string;
  readonly occurred_at: string;
  readonly actor: HostActorAuthority;
  readonly command: DurableCommandIdentity;
  readonly descriptor: RecordDescriptor;
  readonly previous_descriptor: RecordDescriptor | null;
  /** Optional run correlation; never part of aggregate identity. */
  readonly run_id?: string;
}

export interface DurableAuditCursor {
  readonly schema_version: 1;
  readonly stream_revision: number;
  readonly event_id: string;
}

export interface DurableCommitInput extends RevisionExpectation {
  readonly aggregate: AggregateIdentity;
  readonly actor: HostActorAuthority;
  readonly command: DurableCommandIdentity;
  readonly descriptor: RecordDescriptor;
  readonly stream_kind: DurableAuditStreamKind;
  readonly event_kind: string;
  readonly previous_descriptor: RecordDescriptor | null;
  readonly occurred_at: string;
  /** Optional run correlation carried only by the audit event. */
  readonly run_id?: string;
}

export interface DurableCommitResult {
  readonly outcome: DurableMutationOutcome;
  readonly receipt: DurableMutationReceipt | null;
  readonly current_revision: number;
}

export interface DurableAuditPage {
  readonly aggregate: AggregateIdentity;
  readonly stream_kind: DurableAuditStreamKind;
  readonly events: readonly AuditEnvelopeV1[];
  readonly next_cursor: string | null;
}
