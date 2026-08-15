export { InstructionProposalError } from "./errors.js";
export { normalizeInstructionEvidence, selectInstructionEvidence } from "./evidence.js";
export { normalizeLegacyInstructionProposal } from "./legacy.js";
export { proposeInstructionChanges } from "./proposal.js";
export {
  planInstructionApply,
  recordInstructionApplyReceipt,
  verifyInstructionApplyReceipt
} from "./apply.js";
export type {
  InstructionActionDecision,
  InstructionApplyOperation,
  InstructionApplyPlan,
  InstructionApplyReceipt,
  InstructionApplyResult,
  InstructionEvidenceBundle,
  InstructionEvidenceItem,
  InstructionEvidenceScope,
  InstructionProposal,
  InstructionProposalAction,
  InstructionProposalActionDraft,
  InstructionProposalModelPort,
  InstructionManifestWriteInput,
  InstructionReceiptVerification,
  LegacyInstructionProposalView,
  ProposeInstructionChangesInput
} from "./types.js";
