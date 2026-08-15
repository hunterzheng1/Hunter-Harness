import type { PlanProfile } from "../../plan-classification/types.js";
import type {
  AggregateIdentity,
  AuditEnvelopeV1,
  DurableAuditPage,
  DurableCommitInput,
  DurableCommitResult,
  RecordDescriptor
} from "../../durable-state-primitives/index.js";
import type { PlanningContext, PlanningContextReadResult, PlanningPartitionUpdates } from "../types.js";

export const PLANNING_CONTEXT_STATE_RECORD_KIND = "planning_context_state" as const;
export const PLANNING_CONTEXT_STATE_STREAM_KIND = "planning_context" as const;

export type PlanningContextStateEventKind =
  | "context_created"
  | "context_replaced"
  | "partitions_invalidated";

export interface PlanningContextStateCommitInput
  extends Omit<DurableCommitInput, "stream_kind" | "event_kind" | "descriptor"> {
  /** Profile is an integrity witness; the authoritative stored payload is Context. */
  readonly profile: PlanProfile;
  readonly context: PlanningContext;
  readonly descriptor: RecordDescriptor;
  readonly stream_kind: typeof PLANNING_CONTEXT_STATE_STREAM_KIND;
  readonly event_kind: PlanningContextStateEventKind;
  /** Required only for partitions_invalidated; interpreted by the pure PlanningContext dependency graph. */
  readonly partition_updates?: PlanningPartitionUpdates | undefined;
}

export interface PlanningContextStateCurrent {
  readonly aggregate: AggregateIdentity;
  readonly revision: number;
  readonly descriptor: RecordDescriptor | null;
  readonly context: PlanningContext | null;
}

export type PlanningContextStateAuditEvent = AuditEnvelopeV1 & {
  readonly event_kind: PlanningContextStateEventKind;
  readonly context: PlanningContext;
};

export type PlanningContextStateAuditPage = Omit<DurableAuditPage, "events"> & {
  readonly events: readonly PlanningContextStateAuditEvent[];
};

export type PlanningContextEventDeliveryState = "pending" | "acknowledged";

export interface PlanningContextEventDeliveryRecord {
  readonly schema_version: 1;
  readonly outbox_id: `planning_context_event_outbox:${string}`;
  readonly aggregate: AggregateIdentity;
  readonly audit_event_id: string;
  readonly event: PlanningContextStateAuditEvent;
  readonly state: PlanningContextEventDeliveryState;
  readonly delivery: {
    readonly receipt_id: string;
    readonly acknowledged_at: string;
  } | null;
}

export interface PlanningContextEventDeliveryAckInput {
  readonly aggregate: AggregateIdentity;
  readonly outbox_id: PlanningContextEventDeliveryRecord["outbox_id"];
  readonly audit_event_id: string;
  readonly delivery_receipt_id: string;
  readonly acknowledged_at: string;
}

export interface PlanningContextStatePort {
  /** Atomically advances current Context and appends its payload-bearing audit record. */
  commit(input: PlanningContextStateCommitInput): Promise<DurableCommitResult>;
  getCurrent(aggregate: AggregateIdentity): Promise<PlanningContextStateCurrent>;
  listAudit(aggregate: AggregateIdentity, limit: number, cursor?: string): Promise<PlanningContextStateAuditPage>;
  listPendingDeliveries(aggregate: AggregateIdentity, limit: number): Promise<readonly PlanningContextEventDeliveryRecord[]>;
  getDelivery(aggregate: AggregateIdentity, outbox_id: PlanningContextEventDeliveryRecord["outbox_id"]):
    Promise<PlanningContextEventDeliveryRecord | null>;
  acknowledgeDelivery(input: PlanningContextEventDeliveryAckInput): Promise<PlanningContextEventDeliveryRecord>;
}

export type PlanningContextStateLegacyView = Extract<PlanningContextReadResult, {
  readonly source_schema_version: 0;
}>;
