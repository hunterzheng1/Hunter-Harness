import type {
  AggregateIdentity,
  AuditEnvelopeV1,
  DurableAuditPage,
  DurableCommitInput,
  DurableCommitResult,
  RecordDescriptor
} from "../../durable-state-primitives/index.js";
import type { LegacyInstructionProposalView } from "../types.js";

export const INSTRUCTION_PROPOSAL_STATE_RECORD_KIND = "instruction_proposal_state" as const;
export const INSTRUCTION_PROPOSAL_STATE_STREAM_KIND = "instruction_proposal" as const;

export type InstructionProposalStateEventKind =
  | "proposal_created"
  | "candidate_decided"
  | "decision_batch";

export interface InstructionProposalStateCommitInput extends Omit<DurableCommitInput, "stream_kind" | "event_kind"> {
  readonly stream_kind: typeof INSTRUCTION_PROPOSAL_STATE_STREAM_KIND;
  readonly event_kind: InstructionProposalStateEventKind;
}

export interface InstructionProposalStateCurrent {
  readonly revision: number;
  /** The descriptor is the canonical proposal/candidate lifecycle snapshot. */
  readonly descriptor: RecordDescriptor | null;
}

export type InstructionProposalStateAuditPage = DurableAuditPage & {
  readonly events: readonly (AuditEnvelopeV1 & { readonly event_kind: InstructionProposalStateEventKind })[];
};

export interface InstructionProposalStatePort {
  /** Atomically advances the current descriptor and appends its audit event. */
  commit(input: InstructionProposalStateCommitInput): Promise<DurableCommitResult>;
  getCurrent(aggregate: AggregateIdentity): Promise<InstructionProposalStateCurrent>;
  listAudit(aggregate: AggregateIdentity, limit: number, cursor?: string): Promise<InstructionProposalStateAuditPage>;
}

export type InstructionProposalStateLegacyView = LegacyInstructionProposalView;
