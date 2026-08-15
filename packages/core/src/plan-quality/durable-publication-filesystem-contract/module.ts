import { isProxy } from "node:util/types";

import { canonicalJson } from "@hunter-harness/contracts";

import { sha256Bytes } from "../../fs/hash.js";
import type {
  PlanDurablePublicationBaseline,
} from "../durable-publication/types.js";
import {
  PLAN_DURABLE_PUBLICATION_FILESYSTEM_AUTHORITY_KIND,
  PLAN_DURABLE_PUBLICATION_FILESYSTEM_BOUNDS,
  PLAN_DURABLE_PUBLICATION_FILESYSTEM_PAYLOAD_COUNT,
  PLAN_DURABLE_PUBLICATION_FILESYSTEM_RECORD_KIND,
  PLAN_DURABLE_PUBLICATION_FILESYSTEM_SAFETY_POLICY,
  PLAN_DURABLE_PUBLICATION_FILESYSTEM_SCHEMA_VERSION,
  type PlanDurablePublicationFilesystemBinding,
  type PlanDurablePublicationFilesystemHostAuthority,
  type PlanDurablePublicationFilesystemJournal,
  type PlanDurablePublicationFilesystemJournalReadResult,
  type PlanDurablePublicationFilesystemPrepareRequest,
  type PlanDurablePublicationFilesystemSha256
} from "./types.js";

const SHA = /^sha256:[a-f0-9]{64}$/u;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const CHANGE_KEY = /^[a-z][a-z0-9_.-]{0,159}$/u;
const STAGING_ID = /^plan_stage:[a-f0-9]{64}$/u;
const RECOVERY_ID = /^plan_recovery_id:[a-f0-9]{64}$/u;
const RECOVERY_TOKEN = /^plan_recovery:[a-f0-9]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const PATH_PREFIX = /^[^/]+(?:\/[^/]+)*$/u;
// A prepare request carries both the UTF-8 payload and its JSON number array.
// Reserve the worst-case JSON representation (escaped content plus 0..255 bytes)
// while retaining a separate envelope bound for non-payload fields.
const PREPARE_SNAPSHOT_MAX_BYTES = PLAN_DURABLE_PUBLICATION_FILESYSTEM_BOUNDS.max_journal_bytes +
  PLAN_DURABLE_PUBLICATION_FILESYSTEM_BOUNDS.max_total_payload_bytes * 10 + 1_000_000;

const JOURNAL_TRANSITIONS = {
  prepared: { commit_ambiguity: ["not_ambiguous"], readback: ["pending"], cleanup: ["not_required"] },
  applying: { commit_ambiguity: ["not_ambiguous"], readback: ["pending"], cleanup: ["not_required"] },
  committed: {
    commit_ambiguity: ["resolved_committed"], readback: ["verified"],
    cleanup: ["not_required", "pending", "completed", "best_effort_failed"]
  },
  rolled_back: {
    commit_ambiguity: ["resolved_rolled_back"], readback: ["verified"],
    cleanup: ["not_required", "pending", "completed", "best_effort_failed"]
  },
  recovery_required: {
    commit_ambiguity: ["unknown"], readback: ["pending", "failed"], cleanup: ["not_required", "pending"]
  },
  unknown: {
    commit_ambiguity: ["unknown"], readback: ["pending", "failed"], cleanup: ["not_required", "pending"]
  }
} as const;

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function snapshot(input: unknown, maxBytes: number = PLAN_DURABLE_PUBLICATION_FILESYSTEM_BOUNDS.max_journal_bytes): unknown {
  const seen = new WeakSet<object>();
  let nodes = 0;
  let strings = 0;
  let byteArrayElements = 0;
  const copy = (value: unknown, depth: number, path: readonly (string | number)[]): unknown => {
    if (value === null || value === undefined || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("non-finite");
      return value;
    }
    if (typeof value === "string") {
      strings += value.length;
      if (value.length > 2_000_000 || strings > 12_000_000) throw new Error("string bound");
      return value;
    }
    if (typeof value !== "object" || isProxy(value) || depth > 32 || ++nodes > 50_000 || seen.has(value)) {
      throw new Error("hostile");
    }
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new Error("prototype");
    }
    seen.add(value);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some((key) => typeof key === "symbol")) throw new Error("symbol");
      for (const key of keys as string[]) {
        const descriptor = descriptors[key];
        if (descriptor === undefined || !Object.hasOwn(descriptor, "value") || descriptor.get !== undefined ||
            descriptor.set !== undefined || (key !== "length" && descriptor.enumerable !== true)) {
          throw new Error("descriptor");
        }
      }
      if (array) {
        const length = descriptors.length?.value;
        const maxLength = path[path.length - 1] === "bytes" ?
          PLAN_DURABLE_PUBLICATION_FILESYSTEM_BOUNDS.max_payload_bytes : 4096;
        if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > maxLength ||
            keys.length !== (length as number) + 1) throw new Error("array");
        if (path[path.length - 1] === "bytes") {
          byteArrayElements += length as number;
          if (byteArrayElements > PLAN_DURABLE_PUBLICATION_FILESYSTEM_BOUNDS.max_total_payload_bytes) {
            throw new Error("payload bound");
          }
        }
        const result: unknown[] = [];
        for (let index = 0; index < (length as number); index += 1) {
          const descriptor = descriptors[String(index)];
          if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) throw new Error("sparse");
          result.push(copy(descriptor.value, depth + 1, [...path, index]));
        }
        return result;
      }
      const result: Record<string, unknown> = {};
      for (const key of keys as string[]) result[key] = copy((descriptors[key] as PropertyDescriptor).value, depth + 1,
        [...path, key]);
      return result;
    } finally {
      seen.delete(value);
    }
  };
  const value = copy(input, 0, []);
  if (JSON.stringify(value).length > maxBytes) throw new Error("record bound");
  return value;
}

function sha(value: unknown): value is PlanDurablePublicationFilesystemSha256 {
  return typeof value === "string" && SHA.test(value);
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value &&
    ![...value].some((char) => (char.codePointAt(0) ?? 0) <= 0x1f || (char.codePointAt(0) ?? 0) === 0x7f);
}

function identifier(value: unknown, max: number): value is string {
  return text(value, max) && IDENTITY.test(value);
}

function relativeRoot(value: unknown): value is string {
  if (!text(value, PLAN_DURABLE_PUBLICATION_FILESYSTEM_BOUNDS.max_root_identity_length) || value.includes("\\") ||
      value.startsWith("/") || /^[A-Za-z]:/u.test(value) || !PATH_PREFIX.test(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== ".." &&
    !segment.endsWith(".") && !segment.endsWith(" "));
}

function canonicalOwnershipPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.trim() !== value ||
      value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/u.test(value) || value.includes("\\") ||
      [...value].some((char) => (char.codePointAt(0) ?? 0) <= 0x1f || (char.codePointAt(0) ?? 0) === 0x7f)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function timestamp(value: unknown): value is string {
  if (!text(value, PLAN_DURABLE_PUBLICATION_FILESYSTEM_BOUNDS.max_timestamp_length) || !TIMESTAMP.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function expectedPaths(changeKey: string): readonly string[] {
  return [
    `plans/${changeKey}-design.md`,
    `plans/${changeKey}-plan.md`,
    `plans/${changeKey}-test-scenarios.md`,
    `plans/${changeKey}-implementation-detail.md`,
    "meta/gate-policy.json",
    "meta/worktree.json",
    "meta/implementation-checkpoints.json",
    "meta/scenario-manifest.json"
  ];
}

function paths(value: unknown, changeKey: string): value is readonly string[] {
  const expected = expectedPaths(changeKey);
  return Array.isArray(value) && value.length === PLAN_DURABLE_PUBLICATION_FILESYSTEM_PAYLOAD_COUNT &&
    value.every((path, index) => path === expected[index]);
}

function hash(value: unknown): PlanDurablePublicationFilesystemSha256 {
  return sha256Bytes(canonicalJson(value)) as PlanDurablePublicationFilesystemSha256;
}

function expectedTargetSetHash(changeKey: string): PlanDurablePublicationFilesystemSha256 {
  return hash(expectedPaths(changeKey));
}

function baseline(value: unknown): value is PlanDurablePublicationBaseline {
  if (!record(value) || !Number.isSafeInteger(value.generation) || (value.generation as number) < 0 ||
      !exact(value, ["state", "manifest_hash", "generation"])) return false;
  if (value.state === "absent") return value.manifest_hash === null && value.generation === 0;
  return value.state === "present" && value.manifest_hash !== null && sha(value.manifest_hash) &&
    (value.generation as number) > 0;
}

function validAuthority(value: unknown): value is PlanDurablePublicationFilesystemHostAuthority {
  if (!record(value) || !exact(value, ["schema_version", "record_kind", "root_identity", "target_identity", "journal_identity"]) ||
      value.schema_version !== PLAN_DURABLE_PUBLICATION_FILESYSTEM_SCHEMA_VERSION ||
      value.record_kind !== PLAN_DURABLE_PUBLICATION_FILESYSTEM_AUTHORITY_KIND) return false;
  const root = value.root_identity;
  if (!record(root) || !exact(root, ["schema_version", "project_identity", "project_root_hash"]) || root.schema_version !== 1 ||
      !identifier(root.project_identity, PLAN_DURABLE_PUBLICATION_FILESYSTEM_BOUNDS.max_project_identity_length) ||
      !sha(root.project_root_hash)) return false;
  const target = value.target_identity;
  if (!record(target) || !exact(target, ["schema_version", "change_key", "target_root", "target_set_hash", "ownership_paths"]) ||
      target.schema_version !== 1 || typeof target.change_key !== "string" || !CHANGE_KEY.test(target.change_key) ||
      !relativeRoot(target.target_root) || !paths(target.ownership_paths, target.change_key as string) ||
      target.target_set_hash !== expectedTargetSetHash(target.change_key as string)) return false;
  const journal = value.journal_identity;
  return record(journal) && exact(journal, ["schema_version", "journal_root", "journal_root_hash"]) && journal.schema_version === 1 &&
    relativeRoot(journal.journal_root) && sha(journal.journal_root_hash);
}

function validPayloadHashes(value: unknown, changeKey: string): value is Readonly<Record<string, string>> {
  if (!record(value) || !exact(value, expectedPaths(changeKey))) return false;
  return Object.values(value).every((item) => sha(item));
}

function validBinding(value: unknown, journal: Record<string, unknown>): value is PlanDurablePublicationFilesystemBinding {
  if (!record(value) || !exact(value, ["operation_id", "idempotency_key", "plan_hash", "expected_baseline",
    "new_manifest_hash", "ownership_paths", "expected_payload_hashes", "expected_readback_hash"])) return false;
  const changeKey = journal.change_key;
  if (typeof changeKey !== "string" || !CHANGE_KEY.test(changeKey) ||
      !identifier(value.operation_id, PLAN_DURABLE_PUBLICATION_FILESYSTEM_BOUNDS.max_operation_id_length) ||
      !identifier(value.idempotency_key, PLAN_DURABLE_PUBLICATION_FILESYSTEM_BOUNDS.max_idempotency_key_length) ||
      !sha(value.plan_hash) || !baseline(value.expected_baseline) || !sha(value.new_manifest_hash) ||
      !paths(value.ownership_paths, changeKey) || !validPayloadHashes(value.expected_payload_hashes, changeKey) ||
      !sha(value.expected_readback_hash)) return false;
  const expected = deriveReadbackHash(value.new_manifest_hash as PlanDurablePublicationFilesystemSha256,
    value.expected_payload_hashes as Record<string, PlanDurablePublicationFilesystemSha256>, changeKey);
  return value.expected_readback_hash === expected;
}

function validStaging(value: unknown, targetSetHash: string): boolean {
  return record(value) && exact(value, ["schema_version", "staging_id", "staging_root_hash", "target_set_hash", "state"]) &&
    value.schema_version === 1 && typeof value.staging_id === "string" && STAGING_ID.test(value.staging_id) &&
    sha(value.staging_root_hash) && value.target_set_hash === targetSetHash &&
    ["private", "fsynced", "verified", "orphaned", "cleaned"].includes(String(value.state));
}

function validRecovery(value: unknown, operationId: string): boolean {
  if (!record(value) || !exact(value, ["schema_version", "recovery_id", "recovery_token"]) || value.schema_version !== 1 ||
      typeof value.recovery_id !== "string" || !RECOVERY_ID.test(value.recovery_id) ||
      typeof value.recovery_token !== "string" || !RECOVERY_TOKEN.test(value.recovery_token)) return false;
  return value.recovery_id === `plan_recovery_id:${hash({ operation_id: operationId, recovery_token: value.recovery_token }).slice(7)}`;
}

function validSafetyPolicy(value: unknown): boolean {
  if (!record(value) || !exact(value, ["same_volume", "atomic_replace", "fsync", "symlink_policy", "target_allowlist"])) return false;
  return value.same_volume === PLAN_DURABLE_PUBLICATION_FILESYSTEM_SAFETY_POLICY.same_volume &&
    value.atomic_replace === PLAN_DURABLE_PUBLICATION_FILESYSTEM_SAFETY_POLICY.atomic_replace &&
    value.fsync === PLAN_DURABLE_PUBLICATION_FILESYSTEM_SAFETY_POLICY.fsync &&
    value.symlink_policy === PLAN_DURABLE_PUBLICATION_FILESYSTEM_SAFETY_POLICY.symlink_policy &&
    value.target_allowlist === PLAN_DURABLE_PUBLICATION_FILESYSTEM_SAFETY_POLICY.target_allowlist;
}

function validTransition(value: Record<string, unknown>): boolean {
  if (typeof value.state !== "string" || !Object.hasOwn(JOURNAL_TRANSITIONS, value.state)) return false;
  const transition = JOURNAL_TRANSITIONS[value.state as keyof typeof JOURNAL_TRANSITIONS];
  return transition.commit_ambiguity.includes(value.commit_ambiguity as never) &&
    transition.readback.includes(value.readback as never) && transition.cleanup.includes(value.cleanup as never);
}

function validJournal(value: unknown): value is PlanDurablePublicationFilesystemJournal {
  if (!record(value) || !exact(value, ["schema_version", "record_kind", "authority", "operation_id", "idempotency_key",
    "project_id", "change_key", "binding", "staging", "recovery", "safety_policy", "state", "commit_ambiguity",
    "readback", "cleanup", "created_at", "updated_at"]) || value.schema_version !== 1 ||
      value.record_kind !== PLAN_DURABLE_PUBLICATION_FILESYSTEM_RECORD_KIND || !validAuthority(value.authority) ||
      !identifier(value.operation_id, PLAN_DURABLE_PUBLICATION_FILESYSTEM_BOUNDS.max_operation_id_length) ||
      !identifier(value.idempotency_key, PLAN_DURABLE_PUBLICATION_FILESYSTEM_BOUNDS.max_idempotency_key_length) ||
      !identifier(value.project_id, PLAN_DURABLE_PUBLICATION_FILESYSTEM_BOUNDS.max_project_id_length) ||
      typeof value.change_key !== "string" || !CHANGE_KEY.test(value.change_key) ||
      !validBinding(value.binding, value) || !validStaging(value.staging, value.authority.target_identity.target_set_hash) ||
      !validRecovery(value.recovery, value.operation_id) || !validSafetyPolicy(value.safety_policy) ||
      !timestamp(value.created_at) || !timestamp(value.updated_at) || value.updated_at < value.created_at ||
      !validTransition(value)) return false;
  const binding = value.binding as PlanDurablePublicationFilesystemBinding;
  const authority = value.authority as PlanDurablePublicationFilesystemHostAuthority;
  const staging = value.staging as { readonly target_set_hash: string };
  return binding.operation_id === value.operation_id && binding.idempotency_key === value.idempotency_key &&
    authority.target_identity.change_key === value.change_key &&
    binding.ownership_paths.every((path, index) => path === authority.target_identity.ownership_paths[index]) &&
    staging.target_set_hash === authority.target_identity.target_set_hash;
}

function validLegacy(value: Record<string, unknown>): boolean {
  return exact(value, ["schema_version", "legacy_ref"]) && value.schema_version === 0 &&
    text(value.legacy_ref, PLAN_DURABLE_PUBLICATION_FILESYSTEM_BOUNDS.max_operation_id_length);
}

function validPlanPayloads(plan: Record<string, unknown>): boolean {
  const ownership = plan.ownership_paths as readonly unknown[];
  if (typeof plan.change_key !== "string" || !CHANGE_KEY.test(plan.change_key) || plan.schema_version !== 1 ||
      !identifier(plan.publication_intent_id, 160) || !sha(plan.manifest_hash) ||
      !text(plan.approval_receipt_ref, 512) || !Array.isArray(plan.artifact_derivation_receipt_refs) ||
      plan.artifact_derivation_receipt_refs.length !== 3 ||
      plan.artifact_derivation_receipt_refs.some((item) => !sha(item)) || !Array.isArray(plan.ownership_paths) ||
      plan.ownership_paths.some((item) => !canonicalOwnershipPath(item)) ||
      ownership.some((item, index) => ownership.indexOf(item) !== index) ||
      ownership.some((item, index) => index > 0 && String(ownership[index - 1]) > String(item)) ||
      !Array.isArray(plan.payloads) || !paths(plan.payloads.map((item) => record(item) ? item.path : undefined), plan.change_key)) return false;
  let total = 0;
  for (const raw of plan.payloads) {
    if (!record(raw) || !exact(raw, ["path", "artifact_type", "format", "classification", "serialized_content", "bytes",
      "byte_length", "serialized_sha256", "semantic_content_hash"]) || typeof raw.serialized_content !== "string" ||
        !Array.isArray(raw.bytes) || !Number.isSafeInteger(raw.byte_length) || raw.byte_length !== raw.bytes.length ||
        !sha(raw.serialized_sha256) ||
        !text(raw.artifact_type, 160) || !sha(raw.semantic_content_hash) || !["markdown", "json"].includes(String(raw.format)) ||
        !["human_truth", "machine_derived", "compatibility_derived"].includes(String(raw.classification))) return false;
    const encoded = Buffer.from(raw.serialized_content as string, "utf8");
    if (raw.byte_length !== encoded.byteLength || raw.byte_length > PLAN_DURABLE_PUBLICATION_FILESYSTEM_BOUNDS.max_payload_bytes ||
        sha256Bytes(raw.serialized_content) !== raw.serialized_sha256) return false;
    for (let index = 0; index < raw.bytes.length; index += 1) {
      const item = raw.bytes[index];
      if (!Number.isSafeInteger(item) || (item as number) < 0 || (item as number) > 255 || item !== encoded[index]) return false;
    }
    total += raw.byte_length as number;
  }
  if (total > PLAN_DURABLE_PUBLICATION_FILESYSTEM_BOUNDS.max_total_payload_bytes || !record(plan.manifest) ||
      !exact(plan.manifest, ["schema_version", "change_key", "approval_receipt_ref", "artifact_derivation_receipt_refs",
        "ownership_paths", "entries"]) || plan.manifest.schema_version !== 1 || plan.manifest.change_key !== plan.change_key ||
      plan.manifest.approval_receipt_ref !== plan.approval_receipt_ref || !Array.isArray(plan.manifest.artifact_derivation_receipt_refs) ||
      plan.manifest.artifact_derivation_receipt_refs.length !== 3 ||
      plan.manifest.artifact_derivation_receipt_refs.some((item) => !sha(item)) ||
      hash(plan.manifest.artifact_derivation_receipt_refs) !== hash(plan.artifact_derivation_receipt_refs) ||
      !Array.isArray(plan.manifest.ownership_paths) || plan.manifest.ownership_paths.some((item) => !canonicalOwnershipPath(item)) ||
      hash(plan.manifest.ownership_paths) !== hash(ownership) || !Array.isArray(plan.manifest.entries) ||
      !paths(plan.manifest.entries.map((item) => record(item) ? item.path : undefined), plan.change_key) ||
      plan.manifest.entries.some((item) => !record(item) || !exact(item, ["path", "artifact_type", "format", "classification",
        "byte_length", "serialized_sha256", "semantic_content_hash"]))) return false;
  const descriptors = plan.payloads.map((item) => Object.fromEntries(Object.entries(item as Record<string, unknown>)
    .filter(([key]) => key !== "serialized_content" && key !== "bytes")));
  return hash(plan.manifest.entries) === hash(descriptors) && hash(plan.manifest) === plan.manifest_hash &&
    plan.publication_intent_id === `plan_publication:${plan.manifest_hash.slice(7)}`;
}

function deriveReadbackHash(manifestHash: PlanDurablePublicationFilesystemSha256,
  payloadHashes: Record<string, PlanDurablePublicationFilesystemSha256>, changeKey: string): PlanDurablePublicationFilesystemSha256 {
  return hash({ manifest_hash: manifestHash, payload_hashes: expectedPaths(changeKey).map((path) => [path, payloadHashes[path]]) });
}

function validatePrepareRequest(value: unknown): PlanDurablePublicationFilesystemPrepareRequest {
  let snapshotValue: unknown;
  try { snapshotValue = snapshot(value, PREPARE_SNAPSHOT_MAX_BYTES); }
  catch { throw new Error("PLAN_DURABLE_PUBLICATION_FILESYSTEM_PREPARE_INVALID"); }
  if (!record(snapshotValue) || !exact(snapshotValue, ["schema_version", "operation_id", "idempotency_key", "project_id",
    "change_key", "expected_baseline", "plan", "authority", "recovery_token"]) || snapshotValue.schema_version !== 1 ||
      !identifier(snapshotValue.operation_id, PLAN_DURABLE_PUBLICATION_FILESYSTEM_BOUNDS.max_operation_id_length) ||
      !identifier(snapshotValue.idempotency_key, PLAN_DURABLE_PUBLICATION_FILESYSTEM_BOUNDS.max_idempotency_key_length) ||
      !identifier(snapshotValue.project_id, PLAN_DURABLE_PUBLICATION_FILESYSTEM_BOUNDS.max_project_id_length) ||
      typeof snapshotValue.change_key !== "string" || !CHANGE_KEY.test(snapshotValue.change_key) ||
      !baseline(snapshotValue.expected_baseline) || !record(snapshotValue.plan) || !validAuthority(snapshotValue.authority) ||
      typeof snapshotValue.recovery_token !== "string" || !RECOVERY_TOKEN.test(snapshotValue.recovery_token) ||
      !validPlanPayloads(snapshotValue.plan) || snapshotValue.plan.change_key !== snapshotValue.change_key ||
      snapshotValue.authority.target_identity.change_key !== snapshotValue.change_key ||
      snapshotValue.authority.target_identity.target_set_hash !== expectedTargetSetHash(snapshotValue.change_key)) {
    throw new Error("PLAN_DURABLE_PUBLICATION_FILESYSTEM_PREPARE_INVALID");
  }
  return freeze(snapshotValue as unknown as PlanDurablePublicationFilesystemPrepareRequest);
}

export function planDurablePublicationTargetPaths(changeKey: string): readonly string[] {
  if (typeof changeKey !== "string" || !CHANGE_KEY.test(changeKey)) {
    throw new Error("PLAN_DURABLE_PUBLICATION_FILESYSTEM_TARGET_INVALID");
  }
  return freeze(expectedPaths(changeKey));
}

export function planDurablePublicationTargetSetHash(changeKey: string): PlanDurablePublicationFilesystemSha256 {
  if (typeof changeKey !== "string" || !CHANGE_KEY.test(changeKey)) {
    throw new Error("PLAN_DURABLE_PUBLICATION_FILESYSTEM_TARGET_INVALID");
  }
  return expectedTargetSetHash(changeKey);
}

export function derivePlanDurablePublicationFilesystemReadbackHash(input: {
  readonly manifest_hash: PlanDurablePublicationFilesystemSha256;
  readonly payload_hashes: Readonly<Record<string, PlanDurablePublicationFilesystemSha256>>;
  readonly change_key: string;
}): PlanDurablePublicationFilesystemSha256 {
  let value: unknown;
  try { value = snapshot(input); } catch { throw new Error("PLAN_DURABLE_PUBLICATION_FILESYSTEM_BINDING_INVALID"); }
  if (!record(value) || !exact(value, ["manifest_hash", "payload_hashes", "change_key"]) ||
      typeof value.change_key !== "string" || !CHANGE_KEY.test(value.change_key) || !sha(value.manifest_hash) ||
      !validPayloadHashes(value.payload_hashes, value.change_key)) {
    throw new Error("PLAN_DURABLE_PUBLICATION_FILESYSTEM_BINDING_INVALID");
  }
  return deriveReadbackHash(value.manifest_hash, value.payload_hashes as Record<string, PlanDurablePublicationFilesystemSha256>, value.change_key);
}

export function snapshotPlanDurablePublicationFilesystemAuthority(input: unknown): PlanDurablePublicationFilesystemHostAuthority {
  let value: unknown;
  try { value = snapshot(input); } catch { throw new Error("PLAN_DURABLE_PUBLICATION_FILESYSTEM_AUTHORITY_INVALID"); }
  if (!validAuthority(value)) throw new Error("PLAN_DURABLE_PUBLICATION_FILESYSTEM_AUTHORITY_INVALID");
  return freeze(value as PlanDurablePublicationFilesystemHostAuthority);
}

export function snapshotPlanDurablePublicationFilesystemPrepareRequest(input: unknown): PlanDurablePublicationFilesystemPrepareRequest {
  return validatePrepareRequest(input);
}

export function derivePlanDurablePublicationFilesystemBinding(
  input: PlanDurablePublicationFilesystemPrepareRequest
): PlanDurablePublicationFilesystemBinding {
  const request = validatePrepareRequest(input);
  const plan = request.plan;
  const targetPaths = expectedPaths(request.change_key);
  const payloadHashes = Object.fromEntries(targetPaths.map((path, index) => [
    path, (plan.payloads[index] as { readonly serialized_sha256: PlanDurablePublicationFilesystemSha256 }).serialized_sha256
  ])) as Record<string, PlanDurablePublicationFilesystemSha256>;
  const binding = {
    operation_id: request.operation_id,
    idempotency_key: request.idempotency_key,
    plan_hash: hash(plan),
    expected_baseline: request.expected_baseline,
    new_manifest_hash: plan.manifest_hash as PlanDurablePublicationFilesystemSha256,
    ownership_paths: targetPaths,
    expected_payload_hashes: payloadHashes,
    expected_readback_hash: deriveReadbackHash(plan.manifest_hash as PlanDurablePublicationFilesystemSha256, payloadHashes, request.change_key)
  } satisfies PlanDurablePublicationFilesystemBinding;
  return freeze(binding);
}

export function readPlanDurablePublicationFilesystemJournal(input: unknown): PlanDurablePublicationFilesystemJournalReadResult {
  let value: unknown;
  try { value = snapshot(input); } catch {
    return { ok: false, reason_code: "PLAN_DURABLE_PUBLICATION_FILESYSTEM_JOURNAL_INVALID" };
  }
  if (!record(value) || typeof value.schema_version !== "number") {
    return { ok: false, reason_code: "PLAN_DURABLE_PUBLICATION_FILESYSTEM_JOURNAL_INVALID" };
  }
  if (value.schema_version === 0) {
    return validLegacy(value) ? { ok: true, mode: "legacy_read_only", source_schema_version: 0 } :
      { ok: false, reason_code: "PLAN_DURABLE_PUBLICATION_FILESYSTEM_JOURNAL_INVALID" };
  }
  if (value.schema_version !== PLAN_DURABLE_PUBLICATION_FILESYSTEM_SCHEMA_VERSION) {
    return { ok: false, reason_code: "PLAN_DURABLE_PUBLICATION_FILESYSTEM_VERSION_UNSUPPORTED" };
  }
  if (!validJournal(value)) return { ok: false, reason_code: "PLAN_DURABLE_PUBLICATION_FILESYSTEM_JOURNAL_INVALID" };
  return { ok: true, mode: "current", value: freeze(value) };
}

export function verifyPlanDurablePublicationFilesystemJournal(input: unknown): boolean {
  const result = readPlanDurablePublicationFilesystemJournal(input);
  return result.ok && result.mode === "current";
}
