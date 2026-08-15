import type {
  AggregateIdentity,
  AuditEnvelopeV1,
  DurableAuditPage,
  DurableCommitInput,
  DurableCommitResult,
  RecordDescriptor
} from "../../durable-state-primitives/index.js";

export const PLAN_CLASSIFICATION_STATE_RECORD_KIND = "plan_classification_state" as const;
export const PLAN_CLASSIFICATION_STATE_STREAM_KIND = "plan_classification" as const;
export const PLAN_PROFILE_RECORD_KIND = "plan_profile" as const;
export const PLANNED_PHASE_SET_RECORD_KIND = "planned_phase_set" as const;

export type PlanClassificationStateEventKind =
  | "classification_created"
  | "classification_reclassified"
  | "phase_set_configured"
  | "classification_state_committed";

export interface PlanClassificationChangeIdentity {
  readonly schema_version: 1;
  readonly project_id: string;
  /** Public Change id is intentionally the same canonical value as change_key. */
  readonly change_id: string;
  readonly change_key: string;
}

export interface PlanClassificationStateCommitInput
  extends Omit<DurableCommitInput, "stream_kind" | "event_kind" | "descriptor" | "aggregate"> {
  readonly aggregate: AggregateIdentity;
  readonly change_id: string;
  readonly profile_ref: RecordDescriptor;
  readonly planned_phase_set_ref: RecordDescriptor;
  readonly descriptor: RecordDescriptor;
  readonly stream_kind: typeof PLAN_CLASSIFICATION_STATE_STREAM_KIND;
  readonly event_kind: PlanClassificationStateEventKind;
}

export interface PlanClassificationStateCurrent {
  readonly aggregate: AggregateIdentity;
  readonly change_id: string;
  readonly revision: number;
  readonly descriptor: RecordDescriptor | null;
  readonly profile_ref: RecordDescriptor | null;
  readonly planned_phase_set_ref: RecordDescriptor | null;
}

export type PlanClassificationStateAuditPage = DurableAuditPage & {
  readonly events: readonly (AuditEnvelopeV1 & {
    readonly event_kind: PlanClassificationStateEventKind;
  })[];
};

export interface PlanClassificationStatePort {
  /** Atomically advances Profile + PlannedPhaseSet references and appends one audit event. */
  commit(input: PlanClassificationStateCommitInput): Promise<DurableCommitResult>;
  getCurrent(identity: PlanClassificationChangeIdentity): Promise<PlanClassificationStateCurrent>;
  listAudit(identity: PlanClassificationChangeIdentity, limit: number, cursor?: string):
    Promise<PlanClassificationStateAuditPage>;
}

