import { deepFreeze } from "../instruction-governance/stable.js";
import { fail } from "./shared.js";
import type { LegacyInstructionProposalView } from "./types.js";

export function normalizeLegacyInstructionProposal(input: unknown): LegacyInstructionProposalView {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("INSTRUCTION_LEGACY_PROPOSAL_INVALID", "legacy proposal must be an object");
  }
  const record = input as Record<string, unknown>;
  if (record.schema_version !== 0 || typeof record.proposal_id !== "string" ||
      record.proposal_id.length === 0 || record.proposal_id.length > 256) {
    fail("INSTRUCTION_LEGACY_PROPOSAL_INVALID", "legacy identity is invalid");
  }
  return deepFreeze({
    schema_version: 1,
    source_schema_version: 0,
    legacy_proposal_id: record.proposal_id,
    status: "legacy_unverified",
    ready: false,
    reason_codes: ["INSTRUCTION_LEGACY_REINSPECTION_REQUIRED"]
  });
}
