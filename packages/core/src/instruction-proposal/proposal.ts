import { sha256Bytes } from "../fs/hash.js";
import { canonicalRulePath } from "../instruction-governance/schema.js";
import { deepFreeze, stableHash } from "../instruction-governance/stable.js";
import {
  RULE_TOPICS,
  type InstructionInspectionRef,
  type RuleTopic
} from "../instruction-governance/types.js";
import { scanSensitiveFiles } from "../security/scanner.js";
import { normalizeInstructionEvidence, selectInstructionEvidence } from "./evidence.js";
import { fail, sha256, timestamp, uniqueStrings } from "./shared.js";
import type {
  InstructionEvidenceBundle,
  InstructionProposal,
  InstructionProposalAction,
  InstructionProposalActionDraft,
  InstructionProposalModelPort,
  ProposeInstructionChangesInput,
  CurrentInstructionProposalVerification,
  VerifyCurrentInstructionProposalInput
} from "./types.js";

const OPERATION = new Set(["add", "modify", "move", "deprecate"] as const);
const CONFIDENCE = new Set(["high", "medium", "low"] as const);
const REVIEW_MODE = new Set(["automatic", "confirmation_required", "suggestion_only"] as const);
const TARGET_PATH: Readonly<Record<RuleTopic, string>> = {
  core: ".harness/rules/core.md",
  architecture: ".harness/rules/architecture.md",
  coding: ".harness/rules/coding.md",
  testing: ".harness/rules/testing.md",
  workflow: ".harness/rules/workflow.md",
  security: ".harness/rules/security.md"
};

function validateInspectionRef(value: InstructionInspectionRef, label: string): InstructionInspectionRef {
  if (value === null || typeof value !== "object" || value.schema_version !== 1) {
    fail("INSTRUCTION_REINSPECTION_REQUIRED", `${label} must be inspection ref v1`);
  }
  return {
    schema_version: 1,
    input_fingerprint: sha256(
      value.input_fingerprint,
      `${label}.input_fingerprint`,
      "INSTRUCTION_REINSPECTION_REQUIRED"
    ),
    canonical_hash: sha256(
      value.canonical_hash,
      `${label}.canonical_hash`,
      "INSTRUCTION_REINSPECTION_REQUIRED"
    ),
    result_hash: sha256(value.result_hash, `${label}.result_hash`, "INSTRUCTION_REINSPECTION_REQUIRED")
  };
}

function sameInspection(left: InstructionInspectionRef, right: InstructionInspectionRef): boolean {
  return left.input_fingerprint === right.input_fingerprint &&
    left.canonical_hash === right.canonical_hash &&
    left.result_hash === right.result_hash;
}

function ownAction(value: unknown, index: number): InstructionProposalActionDraft {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("INSTRUCTION_MODEL_OUTPUT_INVALID", `actions[${index}] must be an object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "operation", "target_path", "source_path", "topic", "content", "evidence_refs",
    "rationale_zh", "confidence", "review_mode"
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    fail("INSTRUCTION_MODEL_OUTPUT_INVALID", `actions[${index}] contains unknown fields`);
  }
  if (!OPERATION.has(record.operation as never) || !RULE_TOPICS.includes(record.topic as RuleTopic) ||
      !CONFIDENCE.has(record.confidence as never) || !REVIEW_MODE.has(record.review_mode as never)) {
    fail("INSTRUCTION_MODEL_OUTPUT_INVALID", `actions[${index}] contains an invalid enum`);
  }
  if (typeof record.target_path !== "string" || typeof record.content !== "string" ||
      typeof record.rationale_zh !== "string") {
    fail("INSTRUCTION_MODEL_OUTPUT_INVALID", `actions[${index}] contains an invalid string`);
  }
  const sourcePath = record.source_path;
  if (sourcePath !== undefined && typeof sourcePath !== "string") {
    fail("INSTRUCTION_MODEL_OUTPUT_INVALID", `actions[${index}].source_path is invalid`);
  }
  return {
    operation: record.operation as InstructionProposalActionDraft["operation"],
    target_path: record.target_path,
    ...(sourcePath === undefined ? {} : { source_path: sourcePath }),
    topic: record.topic as RuleTopic,
    content: record.content,
    evidence_refs: uniqueStrings(
      record.evidence_refs,
      `actions[${index}].evidence_refs`,
      "INSTRUCTION_MODEL_OUTPUT_INVALID",
      128
    ),
    rationale_zh: record.rationale_zh,
    confidence: record.confidence as InstructionProposalActionDraft["confidence"],
    review_mode: record.review_mode as InstructionProposalActionDraft["review_mode"]
  };
}

function canonicalPath(value: string, label: string): string {
  try {
    return canonicalRulePath(value, label);
  } catch {
    fail("INSTRUCTION_PROPOSAL_PATH_INVALID", `${label} is not canonical`);
  }
}

function validateAction(
  draftInput: unknown,
  index: number,
  evidence: InstructionEvidenceBundle,
  canonicalFileHashes: Readonly<Record<string, string>>
): InstructionProposalAction {
  const draft = ownAction(draftInput, index);
  const targetPath = canonicalPath(draft.target_path, `actions[${index}].target_path`);
  if (targetPath !== TARGET_PATH[draft.topic]) {
    fail("INSTRUCTION_PROPOSAL_PATH_INVALID", `actions[${index}] topic/path mismatch`);
  }
  let sourcePath: string | undefined;
  if (draft.operation === "move") {
    if (draft.source_path === undefined) {
      fail("INSTRUCTION_MODEL_OUTPUT_INVALID", `actions[${index}].source_path is required for move`);
    }
    sourcePath = canonicalPath(draft.source_path, `actions[${index}].source_path`);
    if (sourcePath === targetPath) {
      fail("INSTRUCTION_MODEL_OUTPUT_INVALID", `actions[${index}] move must change path`);
    }
  } else if (draft.source_path !== undefined) {
    fail("INSTRUCTION_MODEL_OUTPUT_INVALID", `actions[${index}].source_path is move-only`);
  }
  const existingTargetHash = canonicalFileHashes[targetPath] ?? null;
  if (draft.operation === "add" && existingTargetHash !== null) {
    fail("INSTRUCTION_MODEL_OUTPUT_INVALID", `actions[${index}] add target already exists`);
  }
  if (draft.operation !== "add" && draft.operation !== "move" && existingTargetHash === null) {
    fail("INSTRUCTION_MODEL_OUTPUT_INVALID", `actions[${index}] target baseline is missing`);
  }
  if (draft.operation === "move" &&
      (sourcePath === undefined || canonicalFileHashes[sourcePath] === undefined ||
        existingTargetHash !== null)) {
    fail("INSTRUCTION_MODEL_OUTPUT_INVALID", `actions[${index}] move baseline is invalid`);
  }
  if (draft.content.length === 0 || draft.content.length > 32_768 ||
      Buffer.byteLength(draft.content, "utf8") > 65_536) {
    fail("INSTRUCTION_MODEL_OUTPUT_INVALID", `actions[${index}].content is not bounded`);
  }
  if (!/[\u3400-\u9fff]/u.test(draft.rationale_zh) || draft.rationale_zh.length > 2_000) {
    fail("INSTRUCTION_MODEL_OUTPUT_INVALID", `actions[${index}].rationale_zh must be Chinese display text`);
  }
  if (scanSensitiveFiles({ [targetPath]: draft.content }).blocked) {
    fail("INSTRUCTION_PROPOSAL_CONTENT_SENSITIVE", targetPath);
  }
  if (draft.evidence_refs.length === 0) {
    fail("INSTRUCTION_PROPOSAL_EVIDENCE_INVALID", `actions[${index}] has no evidence`);
  }
  const selected = draft.evidence_refs.map((reference) =>
    evidence.items.find((item) => item.reference === reference)
  );
  if (selected.some((item) => item === undefined) || selected.some((item) =>
    item?.eligibility === "display_only" || item?.eligibility === "review_only" ||
    (item?.target_topic !== null && item?.target_topic !== draft.topic)
  )) {
    fail("INSTRUCTION_PROPOSAL_EVIDENCE_INVALID", `actions[${index}] references ineligible evidence`);
  }
  if (draft.review_mode === "automatic" && selected.some((item) => item?.confidence === "low")) {
    fail("INSTRUCTION_PROPOSAL_EVIDENCE_INVALID", `actions[${index}] low confidence needs review`);
  }
  const contentHash = sha256Bytes(draft.content);
  const identity = stableHash({ ...draft, target_path: targetPath, content_hash: contentHash });
  return {
    ...draft,
    target_path: targetPath,
    ...(sourcePath === undefined ? {} : { source_path: sourcePath }),
    action_id: `ia_${identity.slice("sha256:".length, "sha256:".length + 24)}`,
    before_content_hash: draft.operation === "move"
      ? canonicalFileHashes[sourcePath as string] ?? null
      : existingTargetHash,
    content_hash: contentHash
  };
}

export function proposalHashPayload(
  proposal: Omit<InstructionProposal, "proposal_id" | "proposal_hash">
): unknown {
  return proposal;
}

export function recomputeProposalHash(proposal: InstructionProposal): string {
  const { proposal_id: ignoredId, proposal_hash: ignoredHash, ...payload } = proposal;
  void ignoredId;
  void ignoredHash;
  return stableHash(proposalHashPayload(payload));
}

interface NormalizedProposalInput {
  readonly inspection: InstructionInspectionRef;
  readonly baseline: string;
  readonly canonical_file_hashes: Readonly<Record<string, string>>;
  readonly created_at: string;
  readonly expires_at: string;
  readonly prompt_version: string;
  readonly model_identity: string;
}

function normalizeProposalInput(
  input: Omit<ProposeInstructionChangesInput, "evidence">
): NormalizedProposalInput {
  const inspection = validateInspectionRef(input.inspection_ref, "inspection_ref");
  const current = validateInspectionRef(input.current_inspection_ref, "current_inspection_ref");
  const baseline = sha256(
    input.expected_baseline_hash,
    "expected_baseline_hash",
    "INSTRUCTION_REINSPECTION_REQUIRED"
  );
  if (!sameInspection(inspection, current) || baseline !== inspection.canonical_hash) {
    fail("INSTRUCTION_REINSPECTION_REQUIRED", "inspection input or canonical baseline changed");
  }
  if (input.canonical_file_hashes === null || typeof input.canonical_file_hashes !== "object" ||
      Array.isArray(input.canonical_file_hashes) ||
      Object.keys(input.canonical_file_hashes).length > RULE_TOPICS.length) {
    fail("INSTRUCTION_MODEL_OUTPUT_INVALID", "canonical_file_hashes is invalid");
  }
  const canonicalFileHashes: Record<string, string> = {};
  for (const [pathInput, hashInput] of Object.entries(input.canonical_file_hashes)) {
    const path = canonicalPath(pathInput, "canonical_file_hashes.path");
    canonicalFileHashes[path] = sha256(
      hashInput,
      `canonical_file_hashes.${path}`,
      "INSTRUCTION_MODEL_OUTPUT_INVALID"
    );
  }
  const createdAt = timestamp(input.created_at, "created_at", "INSTRUCTION_MODEL_OUTPUT_INVALID");
  const expiresAt = timestamp(input.expires_at, "expires_at", "INSTRUCTION_MODEL_OUTPUT_INVALID");
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
    fail("INSTRUCTION_MODEL_OUTPUT_INVALID", "expires_at must be after created_at");
  }
  if (typeof input.prompt_version !== "string" || input.prompt_version.length === 0 ||
      input.prompt_version.length > 128 || typeof input.model_identity !== "string" ||
      input.model_identity.length === 0 || input.model_identity.length > 256) {
    fail("INSTRUCTION_MODEL_OUTPUT_INVALID", "model identity or prompt version is invalid");
  }
  return {
    inspection,
    baseline,
    canonical_file_hashes: canonicalFileHashes,
    created_at: createdAt,
    expires_at: expiresAt,
    prompt_version: input.prompt_version,
    model_identity: input.model_identity
  };
}

function buildInstructionProposal(
  input: Omit<ProposeInstructionChangesInput, "evidence">,
  evidence: InstructionEvidenceBundle,
  rawActions: unknown
): InstructionProposal {
  const normalized = normalizeProposalInput(input);
  if (!Array.isArray(rawActions) || rawActions.length === 0 || rawActions.length > 32) {
    fail("INSTRUCTION_MODEL_OUTPUT_INVALID", "model actions must be a bounded non-empty array");
  }
  const actions = rawActions.map((action, index) =>
    validateAction(action, index, evidence, normalized.canonical_file_hashes)
  );
  if (new Set(actions.map((action) => action.action_id)).size !== actions.length ||
      new Set(actions.map((action) => action.target_path)).size !== actions.length) {
    fail("INSTRUCTION_MODEL_OUTPUT_INVALID", "model actions collide");
  }
  const withoutIdentity: Omit<InstructionProposal, "proposal_id" | "proposal_hash"> = {
    schema_version: 1,
    inspection_ref: normalized.inspection,
    input_fingerprint: normalized.inspection.input_fingerprint,
    expected_baseline_hash: normalized.baseline,
    evidence_hash: evidence.evidence_hash,
    prompt_version: normalized.prompt_version,
    model_identity: normalized.model_identity,
    actions,
    evidence_refs: [...new Set(actions.flatMap((action) => action.evidence_refs))].sort(),
    status: "ready",
    created_at: normalized.created_at,
    expires_at: normalized.expires_at
  };
  const proposalHash = stableHash(proposalHashPayload(withoutIdentity));
  return deepFreeze({
    ...withoutIdentity,
    proposal_id: `ip_${proposalHash.slice("sha256:".length, "sha256:".length + 24)}`,
    proposal_hash: proposalHash
  });
}

type PlainSnapshot =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false };

const MAX_VERIFICATION_WIRE_BYTES = 1_048_576;

function invalidTrustedWire(detail: string): never {
  throw new Error(`INSTRUCTION_CURRENT_PROPOSAL_INPUT_INVALID: ${detail}`);
}

function snapshotPlainData(
  value: unknown,
  active = new Set<object>(),
  budget = { remaining: 50_000 },
  depth = 0
): PlainSnapshot {
  budget.remaining -= 1;
  if (budget.remaining < 0 || depth > 64) return { ok: false };
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return { ok: true, value };
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? { ok: true, value } : { ok: false };
  }
  if (typeof value !== "object" || active.has(value)) return { ok: false };
  active.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).length !== 0) return { ok: false };
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return { ok: false };
      const lengthDescriptor = descriptors.length;
      if (lengthDescriptor === undefined || !("value" in lengthDescriptor) ||
          typeof lengthDescriptor.value !== "number") return { ok: false };
      const length = lengthDescriptor.value;
      const keys = Object.keys(descriptors).filter((key) => key !== "length");
      if (keys.length !== length || keys.some((key, index) => key !== String(index))) {
        return { ok: false };
      }
      const result: unknown[] = [];
      for (const key of keys) {
        const descriptor = descriptors[key];
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
          return { ok: false };
        }
        const child = snapshotPlainData(descriptor.value, active, budget, depth + 1);
        if (!child.ok) return child;
        result.push(child.value);
      }
      return { ok: true, value: result };
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return { ok: false };
    const result = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor) || !descriptor.enumerable) return { ok: false };
      const child = snapshotPlainData(descriptor.value, active, budget, depth + 1);
      if (!child.ok) return child;
      result[key] = child.value;
    }
    return { ok: true, value: result };
  } catch {
    return { ok: false };
  } finally {
    active.delete(value);
  }
}

function snapshotSerializedData(value: unknown): PlainSnapshot {
  if (typeof value !== "string" || value.length === 0 ||
      Buffer.byteLength(value, "utf8") > MAX_VERIFICATION_WIRE_BYTES) {
    return { ok: false };
  }
  try {
    return snapshotPlainData(JSON.parse(value) as unknown);
  } catch {
    return { ok: false };
  }
}

function exactRecord(
  value: unknown,
  label: string,
  required: readonly string[],
  optional: readonly string[] = []
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidTrustedWire(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(record);
  if (required.some((key) => !Object.hasOwn(record, key)) ||
      keys.some((key) => !allowed.has(key))) {
    invalidTrustedWire(`${label} fields are not exact`);
  }
  return record;
}

function exactArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    invalidTrustedWire(`${label} must be an array`);
  }
  return value;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidTrustedWire(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function validateTrustedVerificationWire(value: unknown): VerifyCurrentInstructionProposalInput {
  const trusted = exactRecord(value, "trusted_input", [
    "schema_version", "map_bundle", "candidates", "selection_scope", "inspection_ref",
    "current_inspection_ref", "expected_baseline_hash", "canonical_file_hashes", "created_at",
    "expires_at", "prompt_version", "model_identity", "raw_model_actions", "verified_at"
  ]);
  for (const label of ["inspection_ref", "current_inspection_ref"] as const) {
    exactRecord(trusted[label], label, [
      "schema_version", "input_fingerprint", "canonical_hash", "result_hash"
    ]);
  }

  const mapBundle = exactRecord(trusted.map_bundle, "map_bundle", [
    "schema_version", "manifest_hash", "requested_topics", "snippets", "used_budget",
    "truncation_reasons"
  ], ["source_commit"]);
  exactArray(mapBundle.requested_topics, "map_bundle.requested_topics");
  for (const [index, snippet] of exactArray(mapBundle.snippets, "map_bundle.snippets").entries()) {
    exactRecord(snippet, `map_bundle.snippets[${index}]`, [
      "topic", "source_path", "content", "confidence", "evidence_source"
    ]);
  }
  exactRecord(mapBundle.used_budget, "map_bundle.used_budget", ["characters", "tokens"]);
  exactArray(mapBundle.truncation_reasons, "map_bundle.truncation_reasons");

  const scope = exactRecord(trusted.selection_scope, "selection_scope", [
    "map_topics", "candidate_rule_topics", "executable_architecture_candidate_ids",
    "max_items", "max_characters", "max_utf8_bytes"
  ]);
  exactArray(scope.map_topics, "selection_scope.map_topics");
  plainRecord(scope.candidate_rule_topics, "selection_scope.candidate_rule_topics");
  exactArray(
    scope.executable_architecture_candidate_ids,
    "selection_scope.executable_architecture_candidate_ids"
  );

  for (const [index, candidate] of exactArray(trusted.candidates, "candidates").entries()) {
    const candidateRecord = exactRecord(candidate, `candidates[${index}]`, [
      "schema_version", "candidate_id", "source_change_key", "candidate_type", "evidence_refs",
      "rationale", "proposed_content", "content_hash", "confidence", "status", "provenance"
    ]);
    exactArray(candidateRecord.evidence_refs, `candidates[${index}].evidence_refs`);
    exactRecord(candidateRecord.provenance, `candidates[${index}].provenance`, [
      "source_kind", "source_ref", "producer", "producer_version", "created_at"
    ]);
  }
  plainRecord(trusted.canonical_file_hashes, "canonical_file_hashes");
  exactArray(trusted.raw_model_actions, "raw_model_actions");
  return trusted as unknown as VerifyCurrentInstructionProposalInput;
}

export function verifyCurrentInstructionProposal(
  proposalWire: string,
  trustedWire: string
): CurrentInstructionProposalVerification {
  const proposalSnapshot = snapshotSerializedData(proposalWire);
  if (!proposalSnapshot.ok || proposalSnapshot.value === null ||
      typeof proposalSnapshot.value !== "object" || Array.isArray(proposalSnapshot.value)) {
    return deepFreeze({ valid: false, reason_code: "INSTRUCTION_CURRENT_PROPOSAL_INVALID" });
  }
  const trustedSnapshot = snapshotSerializedData(trustedWire);
  if (!trustedSnapshot.ok || trustedSnapshot.value === null ||
      typeof trustedSnapshot.value !== "object" || Array.isArray(trustedSnapshot.value)) {
    return deepFreeze({ valid: false, reason_code: "INSTRUCTION_CURRENT_PROPOSAL_INPUT_INVALID" });
  }
  const proposalValue = proposalSnapshot.value as Record<string, unknown>;
  const trustedValue = trustedSnapshot.value as Record<string, unknown>;
  if (proposalValue.schema_version === 0) {
    return deepFreeze({ valid: false, reason_code: "INSTRUCTION_CURRENT_PROPOSAL_LEGACY_READ_ONLY" });
  }
  if (trustedValue.schema_version !== 1) {
    return deepFreeze({ valid: false, reason_code: "INSTRUCTION_CURRENT_PROPOSAL_INPUT_INVALID" });
  }
  let input: VerifyCurrentInstructionProposalInput;
  try {
    input = validateTrustedVerificationWire(trustedValue);
  } catch {
    return deepFreeze({ valid: false, reason_code: "INSTRUCTION_CURRENT_PROPOSAL_INPUT_INVALID" });
  }
  try {
    const evidence = selectInstructionEvidence(
      input.map_bundle,
      input.candidates,
      input.selection_scope
    );
    const expected = buildInstructionProposal({
      inspection_ref: input.inspection_ref,
      current_inspection_ref: input.current_inspection_ref,
      expected_baseline_hash: input.expected_baseline_hash,
      canonical_file_hashes: input.canonical_file_hashes,
      created_at: input.created_at,
      expires_at: input.expires_at,
      prompt_version: input.prompt_version,
      model_identity: input.model_identity
    }, evidence, input.raw_model_actions);
    const verifiedAt = timestamp(
      input.verified_at,
      "verified_at",
      "INSTRUCTION_MODEL_OUTPUT_INVALID"
    );
    const verifiedTime = Date.parse(verifiedAt);
    if (verifiedTime < Date.parse(expected.created_at)) {
      return deepFreeze({ valid: false, reason_code: "INSTRUCTION_CURRENT_PROPOSAL_INVALID" });
    }
    if (verifiedTime >= Date.parse(expected.expires_at)) {
      return deepFreeze({ valid: false, reason_code: "INSTRUCTION_CURRENT_PROPOSAL_EXPIRED" });
    }
    if (stableHash(proposalValue) !== stableHash(expected)) {
      return deepFreeze({ valid: false, reason_code: "INSTRUCTION_CURRENT_PROPOSAL_MISMATCH" });
    }
    return deepFreeze({
      valid: true,
      reason_code: "INSTRUCTION_CURRENT_PROPOSAL_VERIFIED",
      proposal: expected,
      evidence,
      verified_at: verifiedAt
    });
  } catch {
    return deepFreeze({ valid: false, reason_code: "INSTRUCTION_CURRENT_PROPOSAL_INVALID" });
  }
}

export async function proposeInstructionChanges(
  input: ProposeInstructionChangesInput,
  modelPort: InstructionProposalModelPort
): Promise<InstructionProposal> {
  const evidence = normalizeInstructionEvidence(input.evidence);
  const normalized = normalizeProposalInput(input);
  if (modelPort === null || typeof modelPort !== "object" || typeof modelPort.propose !== "function") {
    fail("INSTRUCTION_MODEL_OUTPUT_INVALID", "model port is not available");
  }
  const output = await modelPort.propose(deepFreeze({
    schema_version: 1,
    inspection_ref: normalized.inspection,
    evidence,
    prompt_version: normalized.prompt_version
  }));
  return buildInstructionProposal(input, evidence, output?.actions);
}
