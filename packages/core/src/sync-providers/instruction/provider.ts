import {
  inspectInstructions,
  type InstructionHealth,
  type InstructionInspectionInput,
  type InstructionProjectionPlan
} from "../../instruction-governance/index.js";
import {
  stableHash as instructionHash,
  stableJson as instructionJson
} from "../../instruction-governance/stable.js";
import {
  planInstructionApply,
  recordInstructionApplyReceipt,
  verifyInstructionApplyReceipt,
  type InstructionApplyOperation,
  type InstructionApplyPlan,
  type InstructionApplyReceipt,
  type InstructionApplyResult,
  type InstructionManifestWriteInput,
  type InstructionProposal
} from "../../instruction-proposal/index.js";
import { verifyCurrentInstructionProposal } from "../../instruction-proposal/proposal.js";
import {
  compareCodepoint,
  deepFreeze,
  sortedUnique,
  stableHash,
  type ProviderApplicability,
  type SyncActionPlan,
  type SyncActionProvider,
  type SyncActionReceipt,
  type SyncApplyConfirmation,
  type SyncContext,
  type SyncFinding,
  type SyncRollbackReceipt,
  type SyncSha256,
  type SyncVerification
} from "../../sync-maintenance/index.js";
import {
  InstructionSyncProviderError,
  type InstructionExecutionCompensationEvidence
} from "./errors.js";
import type {
  InstructionApplyBundleSnapshot,
  InstructionExecutionReadback,
  InstructionExecutionRequest,
  InstructionExecutionResult,
  InstructionRollbackRequest,
  InstructionRollbackResult,
  InstructionSyncProviderInput,
  InstructionSyncProviderSnapshotV1
} from "./types.js";

const PROVIDER_ID = "instruction";
const FINDING_ID = "instruction:health";
const ACTION_ID = "instruction:apply_proposal";
const SHA256 = /^sha256:[a-f0-9]{64}$/u;

interface PreparedAction {
  readonly action: SyncActionPlan;
  readonly context: SyncContext;
  readonly health: InstructionHealth;
  readonly proposal: InstructionProposal;
  readonly apply_plan: InstructionApplyPlan;
  readonly expected_writes: readonly string[];
}

interface AppliedRecord {
  readonly prepared: PreparedAction;
  readonly execution: InstructionExecutionResult;
  readonly sync_receipt: SyncActionReceipt;
}

interface CompensationFailureRecord {
  readonly sync_receipt: SyncActionReceipt;
  readonly verification: SyncVerification;
  readonly rollback_receipt: SyncRollbackReceipt;
}

interface ReceiptIdentityRecord {
  readonly sync_receipt: SyncActionReceipt;
  readonly receipt_hash: SyncSha256;
  readonly receipt_serialized: string;
  readonly action: SyncActionPlan;
  readonly action_hash: SyncSha256;
  readonly action_serialized: string;
}

type PlainSnapshotResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false };

type RollbackBoundaryOutcome =
  | { readonly status: "ok"; readonly result: InstructionRollbackResult }
  | { readonly status: "failed"; readonly error_name: string };

function snapshotPlain(
  value: unknown,
  active = new Set<object>(),
  depth = 0
): PlainSnapshotResult {
  if (depth > 64) return { ok: false };
  if (value === null || value === undefined ||
      ["string", "number", "boolean"].includes(typeof value)) {
    return { ok: true, value };
  }
  if (typeof value !== "object") return { ok: false };
  if (active.has(value)) return { ok: false };
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return { ok: false };
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key !== "string" ||
          (key !== "length" && !/^(?:0|[1-9]\d*)$/u.test(key)))) return { ok: false };
      const output: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
          return { ok: false };
        }
        const child = snapshotPlain(descriptor.value, active, depth + 1);
        if (!child.ok) return child;
        output.push(child.value);
      }
      if (Object.keys(value).length !== value.length) return { ok: false };
      return { ok: true, value: output };
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return { ok: false };
    const output: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return { ok: false };
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        return { ok: false };
      }
      const child = snapshotPlain(descriptor.value, active, depth + 1);
      if (!child.ok) return child;
      output[key] = child.value;
    }
    return { ok: true, value: output };
  } finally {
    active.delete(value);
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key));
}

function isSha256(value: unknown): value is SyncSha256 {
  return typeof value === "string" && SHA256.test(value);
}

function boundedText(value: unknown, maximum = 1_024): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    value === value.trim() && value === value.normalize("NFC") &&
    ![...value].some((character) => {
      const codepoint = character.codePointAt(0) ?? 0;
      return codepoint <= 31 || codepoint === 127;
    });
}

function strictRfc3339(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/u.exec(value);
  if (match === null) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (year === undefined || month === undefined || day === undefined || hour === undefined ||
      minute === undefined || second === undefined || year < 1 || month < 1 || month > 12 ||
      day < 1 || hour > 23 || minute > 59 || second > 59) return false;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > days) return false;
  if (match[8] !== "Z") {
    const offsetHour = Number(match[10]);
    const offsetMinute = Number(match[11]);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return false;
  }
  return Number.isFinite(Date.parse(value));
}

function denseStringArray(
  value: unknown,
  options: { readonly canonical?: boolean; readonly allowEmpty?: boolean } = {}
): readonly string[] | undefined {
  if (!Array.isArray(value) || (!options.allowEmpty && value.length === 0) || value.length > 256) {
    return undefined;
  }
  const plain = snapshotPlain(value);
  if (!plain.ok || !Array.isArray(plain.value)) return undefined;
  const result = plain.value;
  if (result.some((item) => !boundedText(item)) || new Set(result).size !== result.length) {
    return undefined;
  }
  if (options.canonical && result.some((item, index) =>
    index > 0 && compareCodepoint(result[index - 1] as string, item as string) >= 0)) {
    return undefined;
  }
  return result as readonly string[];
}

function validateInspectionInputShape(input: unknown): input is InstructionInspectionInput {
  if (!plainRecord(input) || !exactKeys(input, [
    "schema_version", "project_identity", "enabled_agents", "manifest", "canonical_files",
    "entrypoints", "projection_files", "map_evidence_refs", "configuration_hashes",
    "prompt_version", "agent_context_usage", "agent_context_budgets"
  ], [
    "archive_evidence_cursor", "previous_input_fingerprint", "last_proposal_ref",
    "last_apply_receipt_ref"
  ])) return false;
  if (!Array.isArray(input.canonical_files) || !Array.isArray(input.entrypoints) ||
      !Array.isArray(input.projection_files)) return false;
  if (input.canonical_files.some((item) => !plainRecord(item) ||
      !exactKeys(item, ["path", "content_hash", "references"])) ||
      input.entrypoints.some((item) => !plainRecord(item) ||
        !exactKeys(item, ["agent", "path", "content_hash", "references"])) ||
      input.projection_files.some((item) => !plainRecord(item) ||
        !exactKeys(item, [
          "agent", "path", "content_hash", "expected_content_hash", "canonical_refs"
        ]))) return false;
  return true;
}

function validInspectionRef(value: unknown): boolean {
  return plainRecord(value) && exactKeys(value, [
    "schema_version", "input_fingerprint", "canonical_hash", "result_hash"
  ]) && value.schema_version === 1 && isSha256(value.input_fingerprint) &&
    isSha256(value.canonical_hash) && isSha256(value.result_hash);
}

function validateProjectionPlanShape(value: unknown): value is InstructionProjectionPlan {
  if (!plainRecord(value) || !exactKeys(value, [
    "schema_version", "canonical_hash", "adapter_version", "status", "executable",
    "operations", "failures", "projection_hashes", "plan_hash"
  ]) || !Array.isArray(value.operations) || !Array.isArray(value.failures) ||
      !plainRecord(value.projection_hashes)) return false;
  return value.operations.every((operation) => plainRecord(operation) && exactKeys(operation, [
    "operation", "path", "target_agents", "source_paths", "expected_content_hash",
    "content_hash", "content", "adapter_version"
  ]) && denseStringArray(operation.target_agents, { canonical: true }) !== undefined &&
    denseStringArray(operation.source_paths, { canonical: true }) !== undefined) &&
    value.failures.every((failure) => plainRecord(failure) && exactKeys(
    failure,
    ["reason_code"],
    ["target_agent", "path"]
  ));
}

function validateManifestWriteShape(value: unknown): value is InstructionManifestWriteInput {
  return plainRecord(value) && exactKeys(value, [
    "content", "content_hash", "expected_content_hash"
  ]) && typeof value.content === "string" && isSha256(value.content_hash) &&
    isSha256(value.expected_content_hash);
}

function validateApplyPlanShape(value: unknown): value is InstructionApplyPlan {
  if (!plainRecord(value) || !exactKeys(value, [
    "schema_version", "proposal_id", "proposal_hash", "inspection_ref",
    "expected_baseline_hash", "projection_plan_ref", "resulting_canonical_hash", "status",
    "reason_codes", "decisions", "operations", "rollback_plan", "planned_at",
    "transaction_hash"
  ]) || !validInspectionRef(value.inspection_ref) || !Array.isArray(value.reason_codes) ||
      !Array.isArray(value.decisions) || !Array.isArray(value.operations) ||
      !Array.isArray(value.rollback_plan) || !strictRfc3339(value.planned_at) ||
      !isSha256(value.proposal_hash) || !isSha256(value.expected_baseline_hash) ||
      !isSha256(value.projection_plan_ref) || !isSha256(value.resulting_canonical_hash) ||
      !isSha256(value.transaction_hash)) return false;
  if (value.decisions.some((decision) => !plainRecord(decision) ||
      !exactKeys(decision, ["action_id", "decision"]))) return false;
  if (value.rollback_plan.some((step) => !plainRecord(step) ||
      !exactKeys(step, ["operation", "path", "baseline_hash"]))) return false;
  return value.operations.every(validateApplyOperationShape);
}

function validateApplyOperationShape(operation: unknown): operation is InstructionApplyOperation {
  if (!plainRecord(operation) || typeof operation.layer !== "string") return false;
  if (operation.layer === "projection") {
    return exactKeys(operation, [
      "operation", "path", "target_agents", "source_paths", "expected_content_hash",
      "content_hash", "content", "adapter_version", "layer"
    ]);
  }
  if (operation.path === ".harness/rules/rules-manifest.json") {
    return exactKeys(operation, [
      "operation", "path", "content", "content_hash", "expected_content_hash",
      "action_ids", "layer"
    ]);
  }
  if (operation.operation === "delete") {
    return exactKeys(operation, [
      "operation", "path", "content_hash", "expected_content_hash", "action_id", "layer"
    ]);
  }
  return exactKeys(operation, [
    "operation", "path", "content", "content_hash", "expected_content_hash", "action_id", "layer"
  ]);
}

function normalizeSnapshot(
  raw: unknown,
  context?: SyncContext
): {
  readonly snapshot: InstructionSyncProviderSnapshotV1;
  readonly health?: InstructionHealth;
  readonly proposal?: InstructionProposal;
} {
  const plain = snapshotPlain(raw);
  if (!plain.ok || !plainRecord(plain.value) || plain.value.schema_version !== 1 ||
      typeof plain.value.configured !== "boolean") {
    throw new InstructionSyncProviderError("INSTRUCTION_SNAPSHOT_INVALID");
  }
  if (plain.value.configured === false) {
    if (!exactKeys(plain.value, ["schema_version", "configured"])) {
      throw new InstructionSyncProviderError("INSTRUCTION_SNAPSHOT_INVALID");
    }
    return { snapshot: deepFreeze({ schema_version: 1, configured: false }) };
  }
  if (!exactKeys(plain.value, ["schema_version", "configured", "inspection_input"], [
    "proposal_json", "trusted_json", "apply_bundle"
  ]) || !validateInspectionInputShape(plain.value.inspection_input)) {
    throw new InstructionSyncProviderError("INSTRUCTION_SNAPSHOT_INVALID");
  }
  let health: InstructionHealth;
  try {
    health = inspectInstructions(plain.value.inspection_input);
  } catch {
    throw new InstructionSyncProviderError("INSTRUCTION_SNAPSHOT_INVALID");
  }
  if (context !== undefined) {
    const enabled = sortedUnique(context.enabled_agents);
    const snapshotEnabled = sortedUnique(plain.value.inspection_input.enabled_agents);
    if (plain.value.inspection_input.project_identity !== context.project_identity ||
        instructionHash(enabled) !== instructionHash(snapshotEnabled)) {
      throw new InstructionSyncProviderError("INSTRUCTION_CONTEXT_IDENTITY_MISMATCH");
    }
  }
  const proposalWire = plain.value.proposal_json;
  const trustedWire = plain.value.trusted_json;
  const bundle = plain.value.apply_bundle;
  if ((proposalWire === undefined) !== (trustedWire === undefined) ||
      (proposalWire !== undefined && typeof proposalWire !== "string") ||
      (trustedWire !== undefined && typeof trustedWire !== "string")) {
    throw new InstructionSyncProviderError("INSTRUCTION_SNAPSHOT_INVALID");
  }
  const proposalVerification = proposalWire === undefined || trustedWire === undefined
    ? undefined
    : verifyCurrentInstructionProposal(proposalWire, trustedWire);
  if (proposalVerification !== undefined && !proposalVerification.valid) {
    throw new InstructionSyncProviderError("INSTRUCTION_SNAPSHOT_INVALID");
  }
  const proposal = proposalVerification?.proposal;
  if (bundle !== undefined) {
    if (proposal === undefined || !plainRecord(bundle) || !exactKeys(bundle, [
      "apply_plan", "projection_plan"
    ], ["manifest_write"]) || !validateApplyPlanShape(bundle.apply_plan) ||
        !validateProjectionPlanShape(bundle.projection_plan) ||
        (bundle.manifest_write !== undefined && !validateManifestWriteShape(bundle.manifest_write))) {
      throw new InstructionSyncProviderError("INSTRUCTION_SNAPSHOT_INVALID");
    }
    const typedBundle = bundle as unknown as InstructionApplyBundleSnapshot;
    if (!sameInspection(proposal.inspection_ref, health.inspection_ref) ||
        proposal.expected_baseline_hash !== health.canonical_hash) {
      throw new InstructionSyncProviderError("INSTRUCTION_APPLY_PLAN_INVALID");
    }
    realApplyPlan(proposal, typedBundle);
  }
  return {
    snapshot: deepFreeze(plain.value as unknown as InstructionSyncProviderSnapshotV1),
    health,
    ...(proposal === undefined ? {} : { proposal })
  };
}

function sameInspection(
  left: InstructionHealth["inspection_ref"],
  right: InstructionHealth["inspection_ref"]
): boolean {
  return instructionHash(left) === instructionHash(right);
}

function realApplyPlan(
  proposal: InstructionProposal,
  bundle: InstructionApplyBundleSnapshot
): InstructionApplyPlan {
  let recomputed: InstructionApplyPlan;
  try {
    recomputed = planInstructionApply(
      proposal,
      bundle.apply_plan.decisions,
      bundle.apply_plan.expected_baseline_hash,
      bundle.projection_plan,
      bundle.apply_plan.planned_at,
      bundle.manifest_write
    );
  } catch {
    throw new InstructionSyncProviderError("INSTRUCTION_APPLY_PLAN_INVALID");
  }
  if (recomputed.status !== "ready" || recomputed.reason_codes.length !== 0 ||
      instructionHash(recomputed) !== instructionHash(bundle.apply_plan)) {
    throw new InstructionSyncProviderError("INSTRUCTION_APPLY_PLAN_INVALID");
  }
  return recomputed;
}

function actionRisk(proposal: InstructionProposal, plan: InstructionApplyPlan): "low" | "medium" | "high" {
  const accepted = new Set(plan.decisions
    .filter((decision) => decision.decision === "accept")
    .map((decision) => decision.action_id));
  const modes = proposal.actions
    .filter((action) => accepted.has(action.action_id))
    .map((action) => action.review_mode);
  if (modes.includes("suggestion_only")) return "high";
  if (modes.includes("confirmation_required")) return "medium";
  return "low";
}

function findingPresentation(
  health: InstructionHealth,
  snapshot: Extract<InstructionSyncProviderSnapshotV1, { readonly configured: true }>,
  proposal: InstructionProposal | undefined
): Pick<SyncFinding, "status" | "urgency" | "reason_code" | "display_title_zh" | "display_message_zh"> {
  if (health.status === "current") return {
    status: "OK",
    urgency: "none",
    reason_code: "INSTRUCTION_CURRENT",
    display_title_zh: "项目指令已是最新",
    display_message_zh: "当前输入指纹与已应用基线一致，无需重复生成规则提案。"
  };
  if (health.status === "conflicted") return {
    status: "BLOCKED",
    urgency: "required",
    reason_code: "INSTRUCTION_CONFLICTED",
    display_title_zh: "项目指令存在冲突",
    display_message_zh: "canonical 规则或 Agent 投影存在冲突，需要先确认本地状态。"
  };
  if (health.status === "invalid") return {
    status: "FAIL",
    urgency: "required",
    reason_code: "INSTRUCTION_INVALID",
    display_title_zh: "项目指令结构无效",
    display_message_zh: "指令入口、引用或 canonical 文件不完整，不能直接应用提案。"
  };
  if (proposal === undefined) return {
    status: "ADVISORY",
    urgency: "recommended",
    reason_code: "INSTRUCTION_PROPOSAL_REQUIRED",
    display_title_zh: "项目指令需要复查",
    display_message_zh: "输入已经变化；只有用户选择后才进入中文提案流程。"
  };
  if (snapshot.apply_bundle === undefined) return {
    status: "ADVISORY",
    urgency: "recommended",
    reason_code: "INSTRUCTION_PROPOSAL_READY",
    display_title_zh: "项目指令提案待审阅",
    display_message_zh: "提案已生成，请逐条选择接受、拒绝或保留后再应用。"
  };
  return {
    status: "ADVISORY",
    urgency: "recommended",
    reason_code: "INSTRUCTION_APPLY_READY",
    display_title_zh: "项目指令变更待应用",
    display_message_zh: "已形成绑定基线与投影计划的变更，确认后可事务性应用。"
  };
}

function validateApplyResultShape(value: unknown): value is InstructionApplyResult {
  if (!plainRecord(value) || !exactKeys(value, [
    "completed_at", "resulting_canonical_hash", "projection_receipt_ref", "applied_operations"
  ]) || !strictRfc3339(value.completed_at) || !isSha256(value.resulting_canonical_hash) ||
      !isSha256(value.projection_receipt_ref) || !Array.isArray(value.applied_operations)) return false;
  return value.applied_operations.every((operation) => plainRecord(operation) &&
    exactKeys(operation, ["path", "content_hash"]) && boundedText(operation.path) &&
    (operation.content_hash === null || isSha256(operation.content_hash)));
}

function validateReceiptShape(value: unknown): value is InstructionApplyReceipt {
  if (!plainRecord(value) || !exactKeys(value, [
    "schema_version", "receipt_id", "proposal_id", "proposal_hash", "transaction_hash",
    "applied_action_ids", "skipped_action_ids", "action_outcomes", "changed_paths",
    "canonical_hash", "projection_receipt_ref", "verification", "rollback_ref",
    "completed_at", "receipt_hash"
  ]) || value.schema_version !== 1 || !boundedText(value.receipt_id) ||
      !boundedText(value.proposal_id) || !isSha256(value.proposal_hash) ||
      !isSha256(value.transaction_hash) || !isSha256(value.canonical_hash) ||
      !isSha256(value.projection_receipt_ref) || !isSha256(value.rollback_ref) ||
      !isSha256(value.receipt_hash) || !strictRfc3339(value.completed_at) ||
      denseStringArray(value.applied_action_ids, { allowEmpty: true }) === undefined ||
      denseStringArray(value.skipped_action_ids, { allowEmpty: true }) === undefined ||
      denseStringArray(value.changed_paths, { allowEmpty: true }) === undefined ||
      !Array.isArray(value.action_outcomes) || !plainRecord(value.verification) ||
      !exactKeys(value.verification, ["status", "operation_count"])) return false;
  return value.action_outcomes.every((outcome) => plainRecord(outcome) &&
    exactKeys(outcome, ["action_id", "decision"]));
}

function snapshotExecutionResult(raw: unknown): InstructionExecutionResult | undefined {
  const plain = snapshotPlain(raw);
  if (!plain.ok || !plainRecord(plain.value) || !exactKeys(plain.value, [
    "apply_result", "receipt", "modified_paths", "rollback_token"
  ]) || !validateApplyResultShape(plain.value.apply_result) ||
      !validateReceiptShape(plain.value.receipt) ||
      denseStringArray(plain.value.modified_paths, { canonical: true, allowEmpty: true }) === undefined ||
      !boundedText(plain.value.rollback_token)) return undefined;
  return deepFreeze(plain.value as unknown as InstructionExecutionResult);
}

function snapshotReadback(raw: unknown): InstructionExecutionReadback | undefined {
  const plain = snapshotPlain(raw);
  if (!plain.ok || !plainRecord(plain.value) || !exactKeys(plain.value, [
    "receipt", "apply_result"
  ]) || !validateReceiptShape(plain.value.receipt) ||
      !validateApplyResultShape(plain.value.apply_result)) return undefined;
  return deepFreeze(plain.value as unknown as InstructionExecutionReadback);
}

function snapshotRollbackResult(raw: unknown): InstructionRollbackResult | undefined {
  const plain = snapshotPlain(raw);
  if (!plain.ok || !plainRecord(plain.value) || !exactKeys(plain.value, [
    "rolled_back", "resulting_canonical_hash"
  ]) || typeof plain.value.rolled_back !== "boolean" ||
      !isSha256(plain.value.resulting_canonical_hash)) return undefined;
  return deepFreeze(plain.value as unknown as InstructionRollbackResult);
}

function executionValid(
  prepared: PreparedAction,
  result: InstructionExecutionResult,
  request: InstructionExecutionRequest
): boolean {
  let expected: InstructionApplyReceipt;
  try {
    expected = recordInstructionApplyReceipt(prepared.apply_plan, result.apply_result);
  } catch {
    return false;
  }
  const verification = verifyInstructionApplyReceipt(
    result.receipt,
    prepared.proposal,
    prepared.apply_plan,
    result.apply_result
  );
  return verification.valid && instructionHash(result.receipt) === instructionHash(expected) &&
    instructionHash(result.modified_paths) === instructionHash(prepared.expected_writes) &&
    result.apply_result.completed_at === result.receipt.completed_at &&
    (request.rollback_capability.available
      ? result.rollback_token === request.rollback_capability.rollback_token
      : result.rollback_token === "not_available");
}

function appliedKey(receipt: Pick<SyncActionReceipt, "input_hash" | "output_hash">): string {
  return `${receipt.input_hash}:${receipt.output_hash}`;
}

function snapshotSyncReceipt(value: unknown): SyncActionReceipt | undefined {
  const plain = snapshotPlain(value);
  if (!plain.ok || !plainRecord(plain.value) || !exactKeys(plain.value, [
    "schema_version", "action_id", "provider_id", "input_hash", "output_hash",
    "evidence_sources", "wrote", "modified_paths", "rollback", "auto_fixed",
    "duration_ms", "completed_at"
  ]) || plain.value.schema_version !== 1 || plain.value.action_id !== ACTION_ID ||
      plain.value.provider_id !== PROVIDER_ID || !isSha256(plain.value.input_hash) ||
      !isSha256(plain.value.output_hash) || typeof plain.value.wrote !== "boolean" ||
      typeof plain.value.auto_fixed !== "boolean" ||
      !Number.isSafeInteger(plain.value.duration_ms) || (plain.value.duration_ms as number) < 0 ||
      !strictRfc3339(plain.value.completed_at)) return undefined;
  const evidenceSources = denseStringArray(plain.value.evidence_sources);
  const modifiedPaths = denseStringArray(plain.value.modified_paths, {
    canonical: true,
    allowEmpty: true
  });
  const rollback = plain.value.rollback;
  if (evidenceSources === undefined || modifiedPaths === undefined || !plainRecord(rollback) ||
      !exactKeys(rollback, ["strategy", "available"], ["rollback_token"]) ||
      typeof rollback.available !== "boolean" ||
      (rollback.strategy !== "automatic" && rollback.strategy !== "none") ||
      rollback.available !== (typeof rollback.rollback_token === "string") ||
      (rollback.rollback_token !== undefined && !boundedText(rollback.rollback_token)) ||
      plain.value.wrote !== (modifiedPaths.length > 0) ||
      plain.value.auto_fixed !== plain.value.wrote ||
      (plain.value.wrote
        ? rollback.strategy !== "automatic" || !rollback.available ||
          plain.value.output_hash === plain.value.input_hash
        : rollback.strategy !== "none" || rollback.available ||
          plain.value.output_hash !== plain.value.input_hash)) return undefined;
  return deepFreeze({
    schema_version: 1,
    action_id: ACTION_ID,
    provider_id: PROVIDER_ID,
    input_hash: plain.value.input_hash,
    output_hash: plain.value.output_hash,
    evidence_sources: evidenceSources,
    wrote: plain.value.wrote,
    modified_paths: modifiedPaths,
    rollback: rollback.available
      ? {
        strategy: "automatic",
        available: true,
        rollback_token: rollback.rollback_token as string
      }
      : { strategy: "none", available: false },
    auto_fixed: plain.value.auto_fixed,
    duration_ms: plain.value.duration_ms as number,
    completed_at: plain.value.completed_at
  });
}

export function createInstructionSyncProvider(
  input: InstructionSyncProviderInput
): SyncActionProvider {
  const clock = input.clock ?? (() => new Date());
  const estimatedDuration = input.estimated_duration_ms ?? 30_000;
  if (!Number.isSafeInteger(estimatedDuration) || estimatedDuration <= 0) {
    throw new InstructionSyncProviderError("INSTRUCTION_SNAPSHOT_INVALID");
  }
  const preparedByHash = new Map<string, PreparedAction>();
  const applied = new Map<string, AppliedRecord>();
  const verificationCache = new Map<string, SyncVerification>();
  const rollbackCache = new Map<string, SyncRollbackReceipt>();
  const compensationFailures = new Map<string, CompensationFailureRecord>();
  const receiptIdentities = new Map<string, ReceiptIdentityRecord>();

  function rememberReceiptIdentity(prepared: PreparedAction, receipt: SyncActionReceipt): void {
    receiptIdentities.set(appliedKey(receipt), deepFreeze({
      sync_receipt: receipt,
      receipt_hash: instructionHash(receipt) as SyncSha256,
      receipt_serialized: instructionJson(receipt),
      action: prepared.action,
      action_hash: instructionHash(prepared.action) as SyncSha256,
      action_serialized: instructionJson(prepared.action)
    }));
  }

  function requireReceiptIdentity(
    rawReceipt: unknown,
    rawAction?: unknown
  ): { readonly receipt: SyncActionReceipt; readonly key: string } {
    const receipt = snapshotSyncReceipt(rawReceipt);
    if (receipt === undefined) {
      throw new InstructionSyncProviderError("INSTRUCTION_EXECUTION_RECEIPT_NOT_FOUND");
    }
    const key = appliedKey(receipt);
    const identity = receiptIdentities.get(key);
    if (identity === undefined || instructionHash(receipt) !== identity.receipt_hash ||
        instructionJson(receipt) !== identity.receipt_serialized ||
        instructionHash(receipt) !== instructionHash(identity.sync_receipt)) {
      throw new InstructionSyncProviderError("INSTRUCTION_EXECUTION_RECEIPT_NOT_FOUND");
    }
    if (rawAction !== undefined) {
      const action = snapshotPlain(rawAction);
      let actionHash: string | undefined;
      let actionSerialized: string | undefined;
      try {
        if (action.ok && plainRecord(action.value)) {
          actionHash = instructionHash(action.value);
          actionSerialized = instructionJson(action.value);
        }
      } catch {
        actionHash = undefined;
        actionSerialized = undefined;
      }
      if (actionHash === undefined || actionHash !== identity.action_hash ||
          actionSerialized !== identity.action_serialized ||
          actionHash !== instructionHash(identity.action) ||
          receipt.input_hash !== identity.action.invalidation_hash) {
        throw new InstructionSyncProviderError("INSTRUCTION_EXECUTION_RECEIPT_NOT_FOUND");
      }
    }
    return { receipt, key };
  }

  function current(context: SyncContext) {
    const raw = typeof input.snapshot === "function" ? input.snapshot(context) : input.snapshot;
    return normalizeSnapshot(raw, context);
  }

  function prepare(context: SyncContext, findingIds: readonly string[]): PreparedAction | undefined {
    if (!findingIds.includes(FINDING_ID)) return undefined;
    const normalized = current(context);
    if (!normalized.snapshot.configured || normalized.health === undefined ||
        normalized.health.status !== "review_required" ||
        normalized.proposal === undefined || normalized.snapshot.apply_bundle === undefined) {
      return undefined;
    }
    const proposal = normalized.proposal;
    if (!sameInspection(proposal.inspection_ref, normalized.health.inspection_ref) ||
        proposal.expected_baseline_hash !== normalized.health.canonical_hash) {
      throw new InstructionSyncProviderError("INSTRUCTION_APPLY_PLAN_INVALID");
    }
    const applyPlan = realApplyPlan(proposal, normalized.snapshot.apply_bundle);
    const expectedWrites = sortedUnique(applyPlan.operations.map((operation) => operation.path));
    if (expectedWrites.length !== applyPlan.operations.length) {
      throw new InstructionSyncProviderError("INSTRUCTION_APPLY_PLAN_INVALID");
    }
    const invalidationHash = stableHash({
      context_hash: context.context_hash,
      inspection_ref: normalized.health.inspection_ref,
      proposal_hash: proposal.proposal_hash,
      proposal_expires_at: proposal.expires_at,
      transaction_hash: applyPlan.transaction_hash,
      projection_plan_ref: applyPlan.projection_plan_ref,
      decisions: applyPlan.decisions,
      expected_writes: expectedWrites
    });
    const action: SyncActionPlan = deepFreeze({
      schema_version: 1,
      action_id: ACTION_ID,
      provider_id: PROVIDER_ID,
      finding_ids: [FINDING_ID],
      depends_on: [],
      conflicts_with: [],
      invalidates_providers: [PROVIDER_ID],
      expected_writes: expectedWrites,
      network_access: false,
      model_access: false,
      risk: actionRisk(proposal, applyPlan),
      rollback_strategy: expectedWrites.length === 0 ? "none" : "automatic",
      invalidation_hash: invalidationHash,
      estimated_duration_ms: estimatedDuration
    });
    const prepared = deepFreeze({
      action,
      context,
      health: normalized.health,
      proposal,
      apply_plan: applyPlan,
      expected_writes: expectedWrites
    });
    preparedByHash.set(invalidationHash, prepared);
    return prepared;
  }

  async function executeRollback(request: InstructionRollbackRequest): Promise<RollbackBoundaryOutcome> {
    try {
      const result = snapshotRollbackResult(await input.execution_port.rollback(request));
      return result === undefined
        ? { status: "failed", error_name: "invalid_rollback_result" }
        : { status: "ok", result };
    } catch (error) {
      return {
        status: "failed",
        error_name: error instanceof Error ? error.name : "unknown_error"
      };
    }
  }

  function executionRequest(prepared: PreparedAction): InstructionExecutionRequest {
    const operationId = `instruction_execution:${prepared.apply_plan.transaction_hash.slice(
      "sha256:".length,
      "sha256:".length + 24
    )}` as const;
    const hasWrites = prepared.expected_writes.length > 0;
    const rollbackToken = `instruction_rollback:${stableHash({
      operation_id: operationId,
      transaction_hash: prepared.apply_plan.transaction_hash,
      expected_current_canonical_hash: prepared.apply_plan.resulting_canonical_hash,
      expected_previous_canonical_hash: prepared.apply_plan.expected_baseline_hash
    }).slice("sha256:".length)}` as const;
    return deepFreeze({
      schema_version: 1,
      action_id: ACTION_ID,
      operation_id: operationId,
      transaction_hash: prepared.apply_plan.transaction_hash,
      expected_input_fingerprint: prepared.health.input_fingerprint,
      proposal: prepared.proposal,
      apply_plan: prepared.apply_plan,
      rollback_capability: hasWrites
        ? {
          strategy: "automatic" as const,
          available: true as const,
          rollback_token: rollbackToken,
          expected_current_canonical_hash: prepared.apply_plan.resulting_canonical_hash,
          expected_previous_canonical_hash: prepared.apply_plan.expected_baseline_hash
        }
        : { strategy: "none" as const, available: false as const }
    });
  }

  function rollbackRequest(
    prepared: PreparedAction,
    request = executionRequest(prepared)
  ): InstructionRollbackRequest {
    if (!request.rollback_capability.available) {
      throw new InstructionSyncProviderError("INSTRUCTION_EXECUTION_RECEIPT_INVALID");
    }
    return deepFreeze({
      schema_version: 1,
      operation_id: request.operation_id,
      transaction_hash: prepared.apply_plan.transaction_hash,
      rollback_token: request.rollback_capability.rollback_token,
      expected_current_canonical_hash: prepared.apply_plan.resulting_canonical_hash,
      expected_previous_canonical_hash: prepared.apply_plan.expected_baseline_hash
    });
  }

  function rememberCompensationFailure(
    prepared: PreparedAction,
    receipt: SyncActionReceipt,
    evidence: InstructionExecutionCompensationEvidence,
    completedAt: string
  ): CompensationFailureRecord {
    const evidenceHash = stableHash({
      reason_code: "INSTRUCTION_EXECUTION_COMPENSATION_FAILED",
      evidence
    });
    const record = deepFreeze({
      sync_receipt: receipt,
      verification: {
        schema_version: 1 as const,
        action_id: receipt.action_id,
        provider_id: PROVIDER_ID,
        status: "failed" as const,
        reason_code: "INSTRUCTION_EXECUTION_COMPENSATION_FAILED",
        evidence_hash: evidenceHash,
        verified_at: completedAt
      },
      rollback_receipt: {
        schema_version: 1 as const,
        action_id: receipt.action_id,
        provider_id: PROVIDER_ID,
        status: "failed" as const,
        reason_code: "INSTRUCTION_EXECUTION_COMPENSATION_FAILED",
        evidence_hash: evidenceHash,
        completed_at: completedAt
      }
    });
    compensationFailures.set(appliedKey(receipt), record);
    rememberReceiptIdentity(prepared, receipt);
    verificationCache.set(appliedKey(receipt), record.verification);
    rollbackCache.set(appliedKey(receipt), record.rollback_receipt);
    return record;
  }

  async function compensateInvalidExecution(
    prepared: PreparedAction,
    request: InstructionExecutionRequest,
    rawResult: unknown,
    started: number
  ): Promise<SyncActionReceipt> {
    const outcome = request.rollback_capability.available
      ? await executeRollback(rollbackRequest(prepared, request))
      : { status: "failed" as const, error_name: "rollback_not_available" };
    const evidenceBase = {
      transaction_hash: prepared.apply_plan.transaction_hash,
      expected_canonical_hash: prepared.apply_plan.resulting_canonical_hash
    };
    if (outcome.status === "ok" && outcome.result.rolled_back &&
        outcome.result.resulting_canonical_hash === prepared.apply_plan.expected_baseline_hash) {
      throw new InstructionSyncProviderError("INSTRUCTION_EXECUTION_RECEIPT_INVALID", evidenceBase);
    }
    const evidence: InstructionExecutionCompensationEvidence = outcome.status === "ok"
      ? { ...evidenceBase, rollback_result: outcome.result }
      : { ...evidenceBase, compensation_error_name: outcome.error_name };
    const completedAt = clock().toISOString();
    const failureHash = stableHash({
      reason_code: "INSTRUCTION_EXECUTION_COMPENSATION_FAILED",
      evidence
    });
    const wrote = prepared.expected_writes.length > 0;
    const receipt: SyncActionReceipt = deepFreeze({
      schema_version: 1,
      action_id: prepared.action.action_id,
      provider_id: PROVIDER_ID,
      input_hash: prepared.action.invalidation_hash,
      output_hash: wrote
        ? prepared.apply_plan.resulting_canonical_hash as SyncSha256
        : prepared.action.invalidation_hash,
      evidence_sources: [
        "instruction_apply_plan_v1",
        "instruction_apply_receipt_v1",
        "INSTRUCTION_EXECUTION_COMPENSATION_FAILED"
      ],
      wrote,
      modified_paths: prepared.expected_writes,
      rollback: wrote
        ? { strategy: "automatic", available: true, rollback_token: failureHash }
        : { strategy: "none", available: false },
      auto_fixed: wrote,
      duration_ms: Math.max(0, clock().getTime() - started),
      completed_at: completedAt
    });
    rememberCompensationFailure(prepared, receipt, evidence, completedAt);
    return receipt;
  }

  async function compensateRejectedExecution(
    prepared: PreparedAction,
    request: InstructionExecutionRequest,
    started: number,
    executeErrorName: string
  ): Promise<SyncActionReceipt> {
    const wrote = prepared.expected_writes.length > 0;
    const outcome = request.rollback_capability.available
      ? await executeRollback(rollbackRequest(prepared, request))
      : { status: "failed" as const, error_name: "rollback_not_available" };
    const completedAt = clock().toISOString();
    const evidenceBase = {
      transaction_hash: prepared.apply_plan.transaction_hash,
      expected_canonical_hash: prepared.apply_plan.resulting_canonical_hash,
      execute_error_name: executeErrorName
    };
    const receipt: SyncActionReceipt = deepFreeze({
      schema_version: 1,
      action_id: prepared.action.action_id,
      provider_id: PROVIDER_ID,
      input_hash: prepared.action.invalidation_hash,
      output_hash: wrote
        ? prepared.apply_plan.resulting_canonical_hash as SyncSha256
        : prepared.action.invalidation_hash,
      evidence_sources: [
        "instruction_apply_plan_v1",
        "INSTRUCTION_EXECUTION_REJECTED"
      ],
      wrote,
      modified_paths: prepared.expected_writes,
      rollback: wrote && request.rollback_capability.available
        ? {
          strategy: "automatic",
          available: true,
          rollback_token: request.rollback_capability.rollback_token
        }
        : { strategy: "none", available: false },
      auto_fixed: wrote,
      duration_ms: Math.max(0, clock().getTime() - started),
      completed_at: completedAt
    });
    const key = appliedKey(receipt);
    if (outcome.status === "ok" && outcome.result.rolled_back &&
        outcome.result.resulting_canonical_hash === prepared.apply_plan.expected_baseline_hash) {
      const evidenceHash = stableHash({ ...evidenceBase, rollback_result: outcome.result });
      const verification: SyncVerification = deepFreeze({
        schema_version: 1,
        action_id: receipt.action_id,
        provider_id: PROVIDER_ID,
        status: "failed",
        reason_code: "INSTRUCTION_EXECUTION_REJECTED",
        evidence_hash: evidenceHash,
        verified_at: completedAt
      });
      const rollbackReceipt: SyncRollbackReceipt = deepFreeze({
        schema_version: 1,
        action_id: receipt.action_id,
        provider_id: PROVIDER_ID,
        status: "rolled_back",
        reason_code: "INSTRUCTION_ROLLBACK_COMPLETED",
        evidence_hash: evidenceHash,
        completed_at: completedAt
      });
      verificationCache.set(key, verification);
      rollbackCache.set(key, rollbackReceipt);
      rememberReceiptIdentity(prepared, receipt);
      return receipt;
    }
    const evidence: InstructionExecutionCompensationEvidence = outcome.status === "ok"
      ? {
        ...evidenceBase,
        rollback_result: outcome.result
      }
      : {
        ...evidenceBase,
        rollback_error_name: outcome.error_name
      };
    rememberCompensationFailure(prepared, receipt, evidence, completedAt);
    return receipt;
  }

  async function compensateAppliedRecord(key: string, record: AppliedRecord): Promise<boolean> {
    const outcome = await executeRollback(rollbackRequest(record.prepared));
    if (outcome.status === "ok" && outcome.result.rolled_back &&
        outcome.result.resulting_canonical_hash === record.prepared.apply_plan.expected_baseline_hash) {
      const receipt = deepFreeze({
        schema_version: 1 as const,
        action_id: record.sync_receipt.action_id,
        provider_id: PROVIDER_ID,
        status: "rolled_back" as const,
        reason_code: "INSTRUCTION_ROLLBACK_COMPLETED",
        evidence_hash: stableHash({ receipt: record.sync_receipt, internally_compensated: true }),
        completed_at: clock().toISOString()
      });
      rollbackCache.set(key, receipt);
      return true;
    }
    const evidence: InstructionExecutionCompensationEvidence = outcome.status === "ok"
      ? {
        transaction_hash: record.prepared.apply_plan.transaction_hash,
        expected_canonical_hash: record.prepared.apply_plan.resulting_canonical_hash,
        rollback_result: outcome.result
      }
      : {
        transaction_hash: record.prepared.apply_plan.transaction_hash,
        expected_canonical_hash: record.prepared.apply_plan.resulting_canonical_hash,
        compensation_error_name: outcome.error_name
      };
    rememberCompensationFailure(
      record.prepared,
      record.sync_receipt,
      evidence,
      clock().toISOString()
    );
    return false;
  }

  return Object.freeze({
    provider_id: PROVIDER_ID,

    async applicable(context: SyncContext): Promise<ProviderApplicability> {
      const normalized = current(context);
      return deepFreeze(normalized.snapshot.configured
        ? { applicability: "applicable", reason_code: "INSTRUCTION_APPLICABLE" }
        : { applicability: "not_applicable", reason_code: "INSTRUCTION_NOT_CONFIGURED" });
    },

    async inspect(context: SyncContext): Promise<readonly SyncFinding[]> {
      const normalized = current(context);
      if (!normalized.snapshot.configured || normalized.health === undefined) return deepFreeze([]);
      const presentation = findingPresentation(
        normalized.health,
        normalized.snapshot,
        normalized.proposal
      );
      return deepFreeze([{
        schema_version: 1,
        finding_id: FINDING_ID,
        provider_id: PROVIDER_ID,
        ...presentation,
        evidence: {
          source: "instruction_inspection_v1",
          input_hash: stableHash({
            inspection_ref: normalized.health.inspection_ref,
            status: normalized.health.status,
            proposal_hash: normalized.proposal?.proposal_hash ?? null,
            transaction_hash: normalized.snapshot.apply_bundle?.apply_plan.transaction_hash ?? null
          }),
          observed_hash: normalized.health.canonical_hash as SyncSha256
        }
      }]);
    },

    async plan(context: SyncContext, finding_ids: readonly string[]): Promise<readonly SyncActionPlan[]> {
      const prepared = prepare(context, finding_ids);
      return prepared === undefined ? deepFreeze([]) : deepFreeze([prepared.action]);
    },

    async apply(
      action_plan: SyncActionPlan,
      confirmation: SyncApplyConfirmation
    ): Promise<SyncActionReceipt> {
      const prepared = preparedByHash.get(action_plan.invalidation_hash);
      let latest: PreparedAction | undefined;
      try {
        latest = prepared === undefined ? undefined : prepare(prepared.context, [FINDING_ID]);
      } catch {
        latest = undefined;
      }
      const now = clock();
      if (prepared === undefined || action_plan.action_id !== ACTION_ID ||
          instructionHash(action_plan) !== instructionHash(prepared.action) ||
          latest === undefined || instructionHash(latest.action) !== instructionHash(prepared.action) ||
          (prepared.expected_writes.length > 0 && !confirmation.allow_writes) ||
          !strictRfc3339(confirmation.confirmed_at) ||
          now.getTime() >= Date.parse(prepared.proposal.expires_at)) {
        throw new InstructionSyncProviderError("INSTRUCTION_ACTION_STALE");
      }
      const started = now.getTime();
      const request = executionRequest(prepared);
      let rawResult: unknown;
      try {
        rawResult = await input.execution_port.execute(request);
      } catch (error) {
        return compensateRejectedExecution(
          prepared,
          request,
          started,
          error instanceof Error ? error.name : "unknown_error"
        );
      }
      const result = snapshotExecutionResult(rawResult);
      if (result === undefined || !executionValid(prepared, result, request)) {
        return compensateInvalidExecution(prepared, request, rawResult, started);
      }
      const wrote = result.modified_paths.length > 0;
      const receipt: SyncActionReceipt = deepFreeze({
        schema_version: 1,
        action_id: ACTION_ID,
        provider_id: PROVIDER_ID,
        input_hash: action_plan.invalidation_hash,
        output_hash: wrote
          ? prepared.apply_plan.resulting_canonical_hash as SyncSha256
          : action_plan.invalidation_hash,
        evidence_sources: ["instruction_apply_plan_v1", "instruction_apply_receipt_v1"],
        wrote,
        modified_paths: result.modified_paths,
        rollback: wrote
          ? { strategy: "automatic", available: true, rollback_token: result.rollback_token }
          : { strategy: "none", available: false },
        auto_fixed: wrote,
        duration_ms: Math.max(0, clock().getTime() - started),
        completed_at: result.receipt.completed_at
      });
      applied.set(appliedKey(receipt), deepFreeze({
        prepared,
        execution: result,
        sync_receipt: receipt
      }));
      rememberReceiptIdentity(prepared, receipt);
      return receipt;
    },

    async verify(untrustedReceipt: SyncActionReceipt): Promise<SyncVerification> {
      const { receipt, key } = requireReceiptIdentity(untrustedReceipt);
      const cached = verificationCache.get(key);
      if (cached !== undefined) return cached;
      const record = applied.get(key);
      if (record === undefined) {
        throw new InstructionSyncProviderError("INSTRUCTION_EXECUTION_RECEIPT_NOT_FOUND");
      }
      let rawReadback: unknown;
      let readbackErrorName: string | undefined;
      try {
        rawReadback = await input.execution_port.readback(record.execution.receipt.receipt_id);
      } catch (error) {
        readbackErrorName = error instanceof Error ? error.name : "unknown_error";
      }
      const readback = snapshotReadback(rawReadback);
      const valid = readback !== undefined &&
        instructionHash(readback.receipt) === instructionHash(record.execution.receipt) &&
        instructionHash(readback.apply_result) === instructionHash(record.execution.apply_result) &&
        verifyInstructionApplyReceipt(
          readback.receipt,
          record.prepared.proposal,
          record.prepared.apply_plan,
          readback.apply_result
        ).valid;
      let compensated = false;
      if (!valid) {
        compensated = await compensateAppliedRecord(key, record);
        const failure = compensationFailures.get(key);
        if (failure !== undefined) return failure.verification;
      }
      const verification: SyncVerification = deepFreeze({
        schema_version: 1,
        action_id: receipt.action_id,
        provider_id: PROVIDER_ID,
        status: valid ? "verified" : "failed",
        reason_code: valid ? "INSTRUCTION_RECEIPT_VERIFIED" : "INSTRUCTION_RECEIPT_MISMATCH",
        evidence_hash: stableHash({
          receipt,
          readback: readback ?? { invalid_readback: true },
          readback_error_name: readbackErrorName,
          internally_compensated: compensated
        }),
        verified_at: clock().toISOString()
      });
      verificationCache.set(key, verification);
      return verification;
    },

    async rollback(
      untrustedActionPlan: SyncActionPlan,
      untrustedReceipt: SyncActionReceipt
    ): Promise<SyncRollbackReceipt> {
      const { receipt, key } = requireReceiptIdentity(untrustedReceipt, untrustedActionPlan);
      const cached = rollbackCache.get(key);
      if (cached !== undefined) return cached;
      const record = applied.get(key);
      if (record === undefined) {
        throw new InstructionSyncProviderError("INSTRUCTION_EXECUTION_RECEIPT_NOT_FOUND");
      }
      if (!receipt.wrote) {
        const unavailable: SyncRollbackReceipt = deepFreeze({
          schema_version: 1,
          action_id: receipt.action_id,
          provider_id: PROVIDER_ID,
          status: "not_available",
          reason_code: "INSTRUCTION_ROLLBACK_NOT_REQUIRED",
          evidence_hash: stableHash({ receipt, no_changes: true }),
          completed_at: clock().toISOString()
        });
        rollbackCache.set(key, unavailable);
        return unavailable;
      }
      const outcome = await executeRollback(rollbackRequest(record.prepared));
      const rolledBack = outcome.status === "ok" && outcome.result.rolled_back &&
        outcome.result.resulting_canonical_hash === record.prepared.apply_plan.expected_baseline_hash;
      const result: SyncRollbackReceipt = deepFreeze({
        schema_version: 1,
        action_id: receipt.action_id,
        provider_id: PROVIDER_ID,
        status: rolledBack ? "rolled_back" : "failed",
        reason_code: rolledBack ? "INSTRUCTION_ROLLBACK_COMPLETED" : "INSTRUCTION_ROLLBACK_FAILED",
        evidence_hash: stableHash({
          receipt,
          ...(outcome.status === "ok"
            ? { rollback: outcome.result }
            : { rollback_error_name: outcome.error_name })
        }),
        completed_at: clock().toISOString()
      });
      rollbackCache.set(key, result);
      return result;
    }
  });
}

export const instructionSyncProviderInternals = Object.freeze({
  normalizeSnapshot
});
