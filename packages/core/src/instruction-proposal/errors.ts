export type InstructionProposalErrorCode =
  | "INSTRUCTION_CANDIDATE_WIRE_INVALID"
  | "INSTRUCTION_EVIDENCE_INPUT_INVALID"
  | "INSTRUCTION_EVIDENCE_SENSITIVE"
  | "INSTRUCTION_REINSPECTION_REQUIRED"
  | "INSTRUCTION_MODEL_OUTPUT_INVALID"
  | "INSTRUCTION_PROPOSAL_PATH_INVALID"
  | "INSTRUCTION_PROPOSAL_EVIDENCE_INVALID"
  | "INSTRUCTION_PROPOSAL_CONTENT_SENSITIVE"
  | "INSTRUCTION_LEGACY_PROPOSAL_INVALID";

export class InstructionProposalError extends Error {
  readonly code: InstructionProposalErrorCode;

  constructor(code: InstructionProposalErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "InstructionProposalError";
    this.code = code;
  }
}
