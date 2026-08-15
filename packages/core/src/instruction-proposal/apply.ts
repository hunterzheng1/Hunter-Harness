import { classifyContentPath } from "@hunter-harness/contracts";

import { sha256Bytes } from "../fs/hash.js";
import { normalizeManagedPath } from "../fs/path-safety.js";
import { rulesManifestSchema } from "../instruction-governance/schema.js";
import { deepFreeze, stableHash } from "../instruction-governance/stable.js";
import { scanSensitiveFiles } from "../security/scanner.js";
import { recomputeProposalHash } from "./proposal.js";
import { RFC3339, SHA256 } from "./shared.js";
import type {
  InstructionActionDecision,
  InstructionApplyOperation,
  InstructionApplyPlan,
  InstructionApplyReasonCode,
  InstructionApplyReceipt,
  InstructionApplyResult,
  InstructionManifestWriteInput,
  InstructionManifestWriteOperation,
  InstructionProposal,
  InstructionReceiptReasonCode,
  InstructionReceiptVerification,
  InstructionRollbackStep,
  ProjectionPlanInput
} from "./types.js";

function addReason(reasons: InstructionApplyReasonCode[], reason: InstructionApplyReasonCode): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function validTimestamp(value: string): boolean {
  return RFC3339.test(value) && !Number.isNaN(Date.parse(value));
}

function proposalIsValid(proposal: InstructionProposal): boolean {
  if (proposal === null || typeof proposal !== "object" || proposal.schema_version !== 1 ||
      proposal.status !== "ready" || !SHA256.test(proposal.proposal_hash) ||
      !SHA256.test(proposal.expected_baseline_hash) || !validTimestamp(proposal.created_at) ||
      !validTimestamp(proposal.expires_at) || !Array.isArray(proposal.actions) ||
      proposal.actions.length === 0 || proposal.actions.length > 32) return false;
  try {
    return recomputeProposalHash(proposal) === proposal.proposal_hash &&
      proposal.proposal_id === `ip_${proposal.proposal_hash.slice(7, 31)}` &&
      proposal.expected_baseline_hash === proposal.inspection_ref.canonical_hash &&
      proposal.input_fingerprint === proposal.inspection_ref.input_fingerprint;
  } catch {
    return false;
  }
}

function decisionsFor(
  proposal: InstructionProposal,
  selections: readonly InstructionActionDecision[],
  reasons: InstructionApplyReasonCode[]
): readonly InstructionActionDecision[] {
  if (!Array.isArray(selections) || selections.length !== proposal.actions.length) {
    addReason(reasons, "INSTRUCTION_APPLY_SELECTION_INVALID");
    return [];
  }
  const byId = new Map<string, InstructionActionDecision>();
  for (const selection of selections) {
    if (selection === null || typeof selection !== "object" ||
        !["accept", "reject", "retain"].includes(selection.decision) ||
        byId.has(selection.action_id)) {
      addReason(reasons, "INSTRUCTION_APPLY_SELECTION_INVALID");
      return [];
    }
    byId.set(selection.action_id, {
      action_id: selection.action_id,
      decision: selection.decision
    });
  }
  const ordered: InstructionActionDecision[] = [];
  for (const action of proposal.actions) {
    const selected = byId.get(action.action_id);
    if (selected === undefined) {
      addReason(reasons, "INSTRUCTION_APPLY_SELECTION_INVALID");
      return [];
    }
    ordered.push(selected);
  }
  if ([...byId.keys()].some((id) => !proposal.actions.some((action) => action.action_id === id))) {
    addReason(reasons, "INSTRUCTION_APPLY_SELECTION_INVALID");
    return [];
  }
  return ordered;
}

function projectionIsValid(plan: ProjectionPlanInput): boolean {
  if (plan === null || typeof plan !== "object" || plan.schema_version !== 1 ||
      plan.adapter_version !== "instruction_projection_v1" || plan.status !== "ready" ||
      !plan.executable || plan.failures.length !== 0 || !SHA256.test(plan.canonical_hash) ||
      !SHA256.test(plan.plan_hash) || !Array.isArray(plan.operations)) return false;
  const { plan_hash: ignored, ...payload } = plan;
  void ignored;
  if (stableHash(payload) !== plan.plan_hash) return false;
  const paths = new Set<string>();
  for (const operation of plan.operations) {
    if (operation.operation !== "write" || operation.adapter_version !== "instruction_projection_v1" ||
        !SHA256.test(operation.content_hash) || sha256Bytes(operation.content) !== operation.content_hash ||
        (operation.expected_content_hash !== null && !SHA256.test(operation.expected_content_hash)) ||
        paths.has(operation.path)) return false;
    let path: string;
    try {
      path = normalizeManagedPath(operation.path);
    } catch {
      return false;
    }
    const classified = classifyContentPath({ schema_version: 1, path });
    if (!("content_kind" in classified) || scanSensitiveFiles({ [path]: operation.content }).blocked) {
      return false;
    }
    paths.add(path);
  }
  return true;
}

function rollbackSteps(
  proposal: InstructionProposal,
  decisions: readonly InstructionActionDecision[],
  baselineHash: string
): InstructionRollbackStep[] {
  const paths = new Set<string>();
  if (decisions.some((item) => item.decision === "accept")) {
    paths.add(".harness/rules/rules-manifest.json");
  }
  for (const selection of decisions.filter((item) => item.decision === "accept")) {
    const action = proposal.actions.find((item) => item.action_id === selection.action_id);
    if (action === undefined) continue;
    paths.add(action.target_path);
    if (action.source_path !== undefined) paths.add(action.source_path);
  }
  return [...paths].sort().map((path) => ({
    operation: "restore_baseline" as const,
    path,
    baseline_hash: baselineHash
  }));
}

function manifestOperation(
  proposal: InstructionProposal,
  decisions: readonly InstructionActionDecision[],
  plannedAt: string,
  input: InstructionManifestWriteInput | undefined,
  reasons: InstructionApplyReasonCode[]
): InstructionManifestWriteOperation | null {
  const accepted = decisions
    .filter((decision) => decision.decision === "accept")
    .map((decision) => decision.action_id);
  if (accepted.length === 0) {
    if (input !== undefined) addReason(reasons, "INSTRUCTION_APPLY_MANIFEST_INVALID");
    return null;
  }
  if (input === undefined || typeof input.content !== "string" ||
      !SHA256.test(input.content_hash) || sha256Bytes(input.content) !== input.content_hash ||
      !SHA256.test(input.expected_content_hash)) {
    addReason(reasons, "INSTRUCTION_APPLY_MANIFEST_INVALID");
    return null;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(input.content) as unknown;
  } catch {
    addReason(reasons, "INSTRUCTION_APPLY_MANIFEST_INVALID");
    return null;
  }
  const parsed = rulesManifestSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.proposal_id !== proposal.proposal_id ||
      parsed.data.reviewed_at !== plannedAt) {
    addReason(reasons, "INSTRUCTION_APPLY_MANIFEST_INVALID");
    return null;
  }
  for (const actionId of accepted) {
    const action = proposal.actions.find((candidate) => candidate.action_id === actionId);
    const file = action === undefined
      ? undefined
      : parsed.data.files.find((candidate) => candidate.path === action.target_path);
    if (action === undefined || file === undefined || file.content_hash !== action.content_hash ||
        file.topic !== action.topic ||
        (action.operation === "deprecate" && file.status !== "deprecated")) {
      addReason(reasons, "INSTRUCTION_APPLY_MANIFEST_INVALID");
      return null;
    }
  }
  return {
    operation: "write",
    path: ".harness/rules/rules-manifest.json",
    content: input.content,
    content_hash: input.content_hash,
    expected_content_hash: input.expected_content_hash,
    action_ids: accepted,
    layer: "canonical"
  };
}

function canonicalOperations(
  proposal: InstructionProposal,
  decisions: readonly InstructionActionDecision[]
): InstructionApplyOperation[] {
  const operations: InstructionApplyOperation[] = [];
  for (const selection of decisions) {
    if (selection.decision !== "accept") continue;
    const action = proposal.actions.find((item) => item.action_id === selection.action_id);
    if (action === undefined) continue;
    if (action.operation === "move" && action.source_path !== undefined) {
      operations.push({
        operation: "delete",
        path: action.source_path,
        content_hash: null,
        expected_content_hash: action.before_content_hash,
        action_id: action.action_id,
        layer: "canonical"
      });
    }
    operations.push({
      operation: "write",
      path: action.target_path,
      content: action.content,
      content_hash: action.content_hash,
      expected_content_hash: action.operation === "move" ? null : action.before_content_hash,
      action_id: action.action_id,
      layer: "canonical"
    });
  }
  return operations;
}

export function planInstructionApply(
  proposal: InstructionProposal,
  selections: readonly InstructionActionDecision[],
  expectedBaselineHash: string,
  projectionPlan: ProjectionPlanInput,
  plannedAt: string,
  manifestWrite?: InstructionManifestWriteInput
): InstructionApplyPlan {
  const reasons: InstructionApplyReasonCode[] = [];
  if (!proposalIsValid(proposal)) addReason(reasons, "INSTRUCTION_APPLY_PROPOSAL_INVALID");
  const decisions = decisionsFor(proposal, selections, reasons);
  if (!SHA256.test(expectedBaselineHash) || expectedBaselineHash !== proposal.expected_baseline_hash) {
    addReason(reasons, "INSTRUCTION_APPLY_BASELINE_MISMATCH");
  }
  if (!validTimestamp(plannedAt) || Date.parse(plannedAt) >= Date.parse(proposal.expires_at)) {
    addReason(reasons, "INSTRUCTION_APPLY_PROPOSAL_EXPIRED");
  }
  if (!projectionIsValid(projectionPlan)) {
    addReason(reasons, "INSTRUCTION_APPLY_PROJECTION_INVALID");
  }
  const acceptedPaths = decisions
    .filter((selection) => selection.decision === "accept")
    .flatMap((selection) => {
      const action = proposal.actions.find((item) => item.action_id === selection.action_id);
      return action === undefined ? [] : [action.target_path];
    });
  const projectedSources = new Set(projectionPlan.operations.flatMap((operation) => operation.source_paths));
  if (acceptedPaths.some((path) => !projectedSources.has(path)) ||
      (acceptedPaths.length > 0 && projectionPlan.canonical_hash === proposal.expected_baseline_hash)) {
    addReason(reasons, "INSTRUCTION_APPLY_PROJECTION_UNBOUND");
  }
  const rollbackPlan = rollbackSteps(proposal, decisions, expectedBaselineHash);
  const manifest = manifestOperation(proposal, decisions, plannedAt, manifestWrite, reasons);
  const operations = reasons.length === 0
    ? [
      ...canonicalOperations(proposal, decisions),
      ...(manifest === null ? [] : [manifest]),
      ...(acceptedPaths.length === 0 ? [] : projectionPlan.operations.map((operation) => ({
        ...operation,
        target_agents: [...operation.target_agents],
        source_paths: [...operation.source_paths],
        layer: "projection" as const
      })))
    ]
    : [];
  const base: Omit<InstructionApplyPlan, "transaction_hash"> = {
    schema_version: 1,
    proposal_id: proposal.proposal_id,
    proposal_hash: proposal.proposal_hash,
    inspection_ref: proposal.inspection_ref,
    expected_baseline_hash: expectedBaselineHash,
    projection_plan_ref: projectionPlan.plan_hash,
    resulting_canonical_hash: projectionPlan.canonical_hash,
    status: reasons.length === 0 ? "ready" : "blocked",
    reason_codes: reasons,
    decisions,
    operations,
    rollback_plan: rollbackPlan,
    planned_at: plannedAt
  };
  return deepFreeze({ ...base, transaction_hash: stableHash(base) });
}

function receiptPayload(receipt: Omit<InstructionApplyReceipt, "receipt_id" | "receipt_hash">): unknown {
  return receipt;
}

function expectedReceiptPayload(
  proposal: Pick<InstructionProposal, "proposal_id" | "proposal_hash">,
  plan: InstructionApplyPlan,
  execution: InstructionApplyResult
): Omit<InstructionApplyReceipt, "receipt_id" | "receipt_hash"> {
  return {
    schema_version: 1,
    proposal_id: proposal.proposal_id,
    proposal_hash: proposal.proposal_hash,
    transaction_hash: plan.transaction_hash,
    applied_action_ids: plan.decisions
      .filter((decision) => decision.decision === "accept")
      .map((decision) => decision.action_id),
    skipped_action_ids: plan.decisions
      .filter((decision) => decision.decision !== "accept")
      .map((decision) => decision.action_id),
    action_outcomes: plan.decisions.map((decision) => ({ ...decision })),
    changed_paths: plan.operations.map((operation) => operation.path),
    canonical_hash: plan.resulting_canonical_hash,
    projection_receipt_ref: execution.projection_receipt_ref,
    verification: { status: "verified", operation_count: plan.operations.length },
    rollback_ref: stableHash(plan.rollback_plan),
    completed_at: execution.completed_at
  };
}

function receiptWithoutIdentity(
  receipt: InstructionApplyReceipt
): Omit<InstructionApplyReceipt, "receipt_id" | "receipt_hash"> {
  const { receipt_id: ignoredId, receipt_hash: ignoredHash, ...payload } = receipt;
  void ignoredId;
  void ignoredHash;
  return payload;
}

function executionMatchesPlan(plan: InstructionApplyPlan, execution: InstructionApplyResult): boolean {
  return plan.status === "ready" && validTimestamp(execution.completed_at) &&
    Date.parse(execution.completed_at) >= Date.parse(plan.planned_at) &&
    execution.resulting_canonical_hash === plan.resulting_canonical_hash &&
    SHA256.test(execution.projection_receipt_ref) && Array.isArray(execution.applied_operations) &&
    execution.applied_operations.length === plan.operations.length &&
    execution.applied_operations.every((operation, index) => {
      const expected = plan.operations[index];
      return expected !== undefined && operation.path === expected.path &&
        operation.content_hash === expected.content_hash;
    });
}

export function recordInstructionApplyReceipt(
  plan: InstructionApplyPlan,
  result: InstructionApplyResult
): InstructionApplyReceipt {
  if (!executionMatchesPlan(plan, result)) {
    throw new Error("INSTRUCTION_APPLY_RESULT_INVALID");
  }
  const withoutIdentity = expectedReceiptPayload({
    proposal_id: plan.proposal_id,
    proposal_hash: plan.proposal_hash
  }, plan, result);
  const receiptHash = stableHash(receiptPayload(withoutIdentity));
  return deepFreeze({
    ...withoutIdentity,
    receipt_id: `ir_${receiptHash.slice(7, 31)}`,
    receipt_hash: receiptHash
  });
}

export function verifyInstructionApplyReceipt(
  receipt: InstructionApplyReceipt,
  proposal: InstructionProposal,
  plan: InstructionApplyPlan,
  execution?: InstructionApplyResult
): InstructionReceiptVerification {
  const reasons: InstructionReceiptReasonCode[] = [];
  if (receipt.proposal_id !== proposal.proposal_id ||
      receipt.proposal_hash !== proposal.proposal_hash) {
    reasons.push("INSTRUCTION_RECEIPT_PROPOSAL_MISMATCH");
  }
  if (receipt.transaction_hash !== plan.transaction_hash ||
      receipt.canonical_hash !== plan.resulting_canonical_hash) {
    reasons.push("INSTRUCTION_RECEIPT_PLAN_MISMATCH");
  }
  if (execution === undefined || !executionMatchesPlan(plan, execution) ||
      stableHash(receiptPayload(expectedReceiptPayload(proposal, plan, execution))) !==
        stableHash(receiptPayload(receiptWithoutIdentity(receipt)))) {
    reasons.push("INSTRUCTION_RECEIPT_EXECUTION_MISMATCH");
  }
  const payload = receiptWithoutIdentity(receipt);
  const recomputed = stableHash(receiptPayload(payload));
  if (receipt.receipt_hash !== recomputed || receipt.receipt_id !== `ir_${recomputed.slice(7, 31)}`) {
    reasons.push("INSTRUCTION_RECEIPT_HASH_INVALID");
  }
  return deepFreeze({ valid: reasons.length === 0, reason_codes: reasons });
}
