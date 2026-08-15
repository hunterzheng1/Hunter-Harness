import { isProxy } from "node:util/types";

import { CODEBASE_MAP_PUBLICATION_TARGETS } from "../types.js";
import type { MapPublicationPlan, MapPublicationTargetPath } from "../types.js";

export type SuccessfulMapPublicationPlan = Extract<MapPublicationPlan, { readonly ok: true }>;
export type MapPublicationTransactionState = "prepared" | "applying" | "committed" | "rolled_back" |
  "recovery_required";

export type ExpectedMapManifest =
  | { readonly state: "absent" }
  | { readonly state: "sha256"; readonly manifest_hash: string };

export interface MapPublicationCommitRequest {
  readonly schema_version: 1;
  readonly operation_id: string;
  readonly action_id: string;
  readonly idempotency_key: string;
  readonly expected_previous_manifest: ExpectedMapManifest;
  readonly ownership_paths: readonly MapPublicationTargetPath[];
  readonly plan: SuccessfulMapPublicationPlan;
}

export interface MapPublicationVerification {
  readonly manifest_hash_verified: true;
  readonly payloads_verified: true;
  readonly journal_committed: true;
  readonly readback_hash: string;
}

export interface MapPublicationTransactionReceipt {
  readonly schema_version: 1;
  readonly receipt_id: string;
  readonly operation_id: string;
  readonly action_id: string;
  readonly idempotency_key: string;
  readonly plan_hash: string;
  readonly input_hash: string;
  readonly previous_manifest_hash: string | null;
  readonly new_manifest_hash: string;
  readonly modified_paths: readonly MapPublicationTargetPath[];
  readonly preserved_paths: readonly MapPublicationTargetPath[];
  readonly verification: MapPublicationVerification;
  readonly recovery_token: string;
  readonly completed_at: string;
}

export interface MapPublicationTransactionBinding {
  readonly operation_id: string;
  readonly action_id: string;
  readonly idempotency_key: string;
  readonly input_hash: string;
  readonly plan_hash: string;
  readonly expected_previous_manifest: ExpectedMapManifest;
  readonly new_manifest_hash: string;
  readonly ownership_paths: readonly MapPublicationTargetPath[];
  /** Durable target identity used to verify a recovery after the original request is gone. */
  readonly expected_payload_hashes: Readonly<Record<MapPublicationTargetPath, string>>;
  readonly expected_readback_hash: string;
}

export type MapPublicationCommitOutcome =
  | { readonly outcome: "committed" | "replayed"; readonly receipt: MapPublicationTransactionReceipt;
      readonly no_changes: boolean }
  | { readonly outcome: "stale" | "idempotency_conflict" }
  | { readonly outcome: "recovery_required"; readonly operation_id: string; readonly recovery_token: string };

export interface MapPublicationTransactionInspection {
  readonly operation_id: string;
  readonly state: MapPublicationTransactionState | "unknown";
  readonly receipt: MapPublicationTransactionReceipt | null;
  readonly recovery_token: string | null;
  readonly binding: MapPublicationTransactionBinding | null;
}

export interface MapPublicationIdempotencyConflict {
  readonly operation_id: string;
  readonly state: "idempotency_conflict";
  readonly receipt: null;
  readonly recovery_token: null;
  readonly binding: null;
}

export type MapPublicationPortInspection = MapPublicationTransactionInspection | MapPublicationIdempotencyConflict;

export interface MapPublicationRollbackRequest {
  readonly schema_version: 1;
  readonly operation_id: string;
  readonly recovery_token: string;
  readonly expected_published_manifest_hash: string;
}

export type MapPublicationRollbackOutcome =
  | { readonly outcome: "rolled_back"; readonly resulting_manifest_hash: string | null }
  | { readonly outcome: "conflict" | "not_found" };

export interface MapPublicationReadback {
  readonly operation_id: string;
  readonly live_manifest_hash: string | null;
  readonly payload_hashes: Readonly<Record<MapPublicationTargetPath, string>>;
  readonly journal_committed: boolean;
}

/**
 * Effect seam for a later filesystem Adapter. A conforming durable Adapter must
 * use private same-volume staging, fsync staged files and the parent directory,
 * persist a recovery journal before replacement, atomically publish the owned
 * set, read back every payload and the manifest, and treat cleanup as
 * best-effort only after the committed journal is durable.
 */
export interface MapPublicationFilesystemTransactionPort {
  inspect(operation_id: string, idempotency_key?: string): MapPublicationPortInspection | Promise<MapPublicationPortInspection>;
  prepare(request: MapPublicationCommitRequest, input_hash: string, new_manifest_hash: string,
    recovery_token: string): MapPublicationPortInspection | Promise<MapPublicationPortInspection>;
  apply(operation_id: string, recovery_token: string): MapPublicationTransactionInspection |
    Promise<MapPublicationTransactionInspection>;
  recover(operation_id: string, recovery_token: string): MapPublicationTransactionInspection |
    Promise<MapPublicationTransactionInspection>;
  rollback(request: MapPublicationRollbackRequest): MapPublicationRollbackOutcome | Promise<MapPublicationRollbackOutcome>;
  readback(operation_id: string): MapPublicationReadback | Promise<MapPublicationReadback>;
}

export interface MapPublicationTransactionModule {
  commitPublication(input: MapPublicationCommitRequest): Promise<MapPublicationCommitOutcome>;
  inspect(operation_id: string): Promise<MapPublicationTransactionInspection>;
  recover(operation_id: string): Promise<MapPublicationCommitOutcome>;
  rollback(input: MapPublicationRollbackRequest): Promise<MapPublicationRollbackOutcome>;
  readback(operation_id: string): Promise<MapPublicationReadback>;
  readReceipt(input: unknown): { readonly ok: true; readonly mode: "current";
    readonly value: MapPublicationTransactionReceipt } |
    { readonly ok: true; readonly mode: "legacy_read_only"; readonly source_schema_version: 0 } |
    { readonly ok: false; readonly reason_code: "MAP_PUBLICATION_RECEIPT_INVALID" };
}

/**
 * The filesystem Adapter receives a real project root out-of-band.  Durable
 * records carry only this non-path identity, so a journal can never become an
 * instruction to write an arbitrary absolute path after a restart.
 */
export const MAP_PUBLICATION_TARGET_ROOT = ".harness/codebase/map" as const;
export const MAP_PUBLICATION_FILESYSTEM_RECORD_KIND = "map_publication" as const;
export const MAP_PUBLICATION_FILESYSTEM_SCHEMA_VERSION = 1 as const;

/**
 * A generation pointer is the only authoritative reader boundary for the
 * filesystem adapter.  The nine canonical files remain compatibility
 * projections; readers must resolve this immutable generation and verify the
 * pointer before and after reading its payloads.
 */
export const MAP_PUBLICATION_GENERATION_POINTER_PATH =
  `${MAP_PUBLICATION_TARGET_ROOT}/.generation-pointer.json` as const;
export const MAP_PUBLICATION_GENERATION_POINTER_SCHEMA_VERSION = 1 as const;
export const MAP_PUBLICATION_GENERATION_ROOT = `${MAP_PUBLICATION_TARGET_ROOT}/.generations` as const;
export const MAP_PUBLICATION_GENERATION_POINTER_KIND = "map_publication_generation_pointer" as const;

export type MapPublicationGenerationPointerState = "empty" | "published";

export interface MapPublicationGenerationPointer {
  readonly schema_version: typeof MAP_PUBLICATION_GENERATION_POINTER_SCHEMA_VERSION;
  readonly record_kind: typeof MAP_PUBLICATION_GENERATION_POINTER_KIND;
  readonly state: MapPublicationGenerationPointerState;
  /** Bounded deterministic generation identity; never an arbitrary path. */
  readonly generation_id: string;
  readonly project_identity: string;
  readonly project_root_hash: MapPublicationSha256;
  readonly target_set_hash: MapPublicationSha256;
  readonly manifest_hash: MapPublicationSha256 | null;
  readonly payload_hashes: Partial<Record<MapPublicationTargetPath, MapPublicationSha256>>;
}

export type MapPublicationSha256 = `sha256:${string}`;

export interface MapPublicationTargetRootIdentity {
  readonly schema_version: 1;
  readonly project_identity: string;
  /** Hash of the canonical, trusted project root; the path itself is never durable. */
  readonly project_root_hash: MapPublicationSha256;
  readonly target_root: typeof MAP_PUBLICATION_TARGET_ROOT;
  readonly ownership_paths: readonly MapPublicationTargetPath[];
}

/** Runtime-only input to a future Adapter. Never serialize `project_root`. */
export interface MapPublicationTrustedProjectRoot {
  readonly project_root: string;
  readonly identity: MapPublicationTargetRootIdentity;
}

export type MapPublicationStagingState =
  | "private"
  | "fsynced"
  | "verified"
  | "orphaned"
  | "cleaned";

/** Staging identity is a bounded name/hash pair, not a filesystem path. */
export interface MapPublicationStagingIdentity {
  readonly staging_id: string;
  readonly staging_root_hash: MapPublicationSha256;
  readonly target_set_hash: MapPublicationSha256;
  readonly state: MapPublicationStagingState;
}

/** Recovery identity is independent from the operation id and survives restart. */
export interface MapPublicationRecoveryIdentity {
  readonly recovery_id: string;
  readonly recovery_token: string;
}

/** These are requirements, not permissions to fall back to a weaker operation. */
export type MapPublicationSameVolumePolicy = "same_volume_required";
export type MapPublicationAtomicReplacePolicy = "atomic_replace_set_required";
export type MapPublicationFsyncPolicy = "file_and_parent_directory_required";
export type MapPublicationSymlinkPolicy = "reject_symlink_and_reparse_point";
export type MapPublicationTargetAllowlistPolicy = "exact_nine_targets";

export interface MapPublicationFilesystemSafetyPolicy {
  readonly same_volume: MapPublicationSameVolumePolicy;
  readonly atomic_replace: MapPublicationAtomicReplacePolicy;
  readonly fsync: MapPublicationFsyncPolicy;
  readonly symlink_policy: MapPublicationSymlinkPolicy;
  readonly target_allowlist: MapPublicationTargetAllowlistPolicy;
}

export const MAP_PUBLICATION_FILESYSTEM_SAFETY_POLICY: MapPublicationFilesystemSafetyPolicy = Object.freeze({
  same_volume: "same_volume_required",
  atomic_replace: "atomic_replace_set_required",
  fsync: "file_and_parent_directory_required",
  symlink_policy: "reject_symlink_and_reparse_point",
  target_allowlist: "exact_nine_targets"
});

export type MapPublicationFilesystemJournalState = MapPublicationTransactionState | "unknown";
export type MapPublicationCommitAmbiguityState =
  | "not_ambiguous"
  | "unknown"
  | "resolved_committed"
  | "resolved_rolled_back";
export type MapPublicationReadbackState = "pending" | "verified" | "failed";
export type MapPublicationCleanupState =
  | "not_required"
  | "pending"
  | "completed"
  | "best_effort_failed";

/**
 * Bounds are part of the contract. They keep restart metadata small and make
 * an Adapter reject an unbounded journal before it touches the filesystem.
 */
export interface MapPublicationFilesystemBounds {
  readonly max_project_identity_length: 160;
  readonly max_operation_id_length: 160;
  readonly max_action_id_length: 160;
  readonly max_idempotency_key_length: 160;
  readonly max_staging_id_length: 192;
  readonly max_recovery_id_length: 192;
  readonly max_recovery_token_length: 80;
  readonly max_timestamp_length: 64;
  readonly max_journal_bytes: 65_536;
  readonly exact_target_count: 9;
}

export const MAP_PUBLICATION_FILESYSTEM_BOUNDS: MapPublicationFilesystemBounds = Object.freeze({
  max_project_identity_length: 160,
  max_operation_id_length: 160,
  max_action_id_length: 160,
  max_idempotency_key_length: 160,
  max_staging_id_length: 192,
  max_recovery_id_length: 192,
  max_recovery_token_length: 80,
  max_timestamp_length: 64,
  max_journal_bytes: 65_536,
  exact_target_count: 9
});

/**
 * Durable record for a map publication transaction. It contains identities,
 * expected hashes and state only: no payload bytes and no arbitrary write
 * paths. A future filesystem Adapter may map `target_root + ownership_paths`
 * only after re-validating the trusted project root.
 */
export interface MapPublicationFilesystemJournal {
  readonly schema_version: 1;
  readonly record_kind: typeof MAP_PUBLICATION_FILESYSTEM_RECORD_KIND;
  readonly root_identity: MapPublicationTargetRootIdentity;
  readonly operation_id: string;
  readonly action_id: string;
  readonly idempotency_key: string;
  readonly binding: MapPublicationTransactionBinding;
  readonly staging: MapPublicationStagingIdentity;
  readonly recovery: MapPublicationRecoveryIdentity;
  readonly safety_policy: MapPublicationFilesystemSafetyPolicy;
  readonly state: MapPublicationFilesystemJournalState;
  readonly commit_ambiguity: MapPublicationCommitAmbiguityState;
  readonly readback: MapPublicationReadbackState;
  readonly cleanup: MapPublicationCleanupState;
  readonly created_at: string;
  readonly updated_at: string;
}

/** A descriptive alias for callers that call the durable entry a record. */
export type MapPublicationFilesystemRecord = MapPublicationFilesystemJournal;

export type MapPublicationFilesystemJournalReadResult =
  | { readonly ok: true; readonly mode: "current"; readonly value: MapPublicationFilesystemJournal }
  | { readonly ok: true; readonly mode: "legacy_read_only"; readonly source_schema_version: 0 }
  | {
    readonly ok: false;
    readonly reason_code:
      | "MAP_PUBLICATION_FILESYSTEM_JOURNAL_INVALID"
      | "MAP_PUBLICATION_FILESYSTEM_VERSION_UNSUPPORTED";
  };

export type MapPublicationFilesystemRecordReadResult = MapPublicationFilesystemJournalReadResult;

const MAP_PUBLICATION_SHA256 = /^sha256:[a-f0-9]{64}$/u;
const MAP_PUBLICATION_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const MAP_PUBLICATION_STAGING_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
const MAP_PUBLICATION_RECOVERY_TOKEN = /^map_recovery:[a-f0-9]{64}$/u;
const MAP_PUBLICATION_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function mapPublicationFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) mapPublicationFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Snapshot hostile input without invoking accessors, proxy traps or custom
 * prototypes. The current M3U Module has the same trust boundary for request
 * and Port output; this reader applies it to restart metadata as well.
 */
function mapPublicationSnapshot(input: unknown, maxBytes: number): unknown {
  const seen = new WeakSet<object>();
  let nodes = 0;
  let strings = 0;
  const copy = (value: unknown, depth: number): unknown => {
    if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") {
      return value;
    }
    if (typeof value === "string") {
      strings += value.length;
      if (value.length > 2_000_000 || strings > 12_000_000) throw new Error("bound");
      return value;
    }
    if (typeof value !== "object" || isProxy(value) || depth > 32 || ++nodes > 4_096 || seen.has(value)) {
      throw new Error("unsafe");
    }
    seen.add(value);
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new Error("prototype");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key === "symbol")) throw new Error("symbol");
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined ||
          descriptor.set !== undefined || (key !== "length" && descriptor.enumerable !== true)) {
        throw new Error("descriptor");
      }
    }
    if (array) {
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > 128 ||
          keys.length !== (length as number) + 1) throw new Error("array");
      const result: unknown[] = [];
      for (let index = 0; index < (length as number); index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !("value" in descriptor)) throw new Error("sparse");
        result.push(copy(descriptor.value, depth + 1));
      }
      return result;
    }
    const result: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      result[key] = copy((descriptors[key] as PropertyDescriptor).value, depth + 1);
    }
    return result;
  };
  const snapshot = copy(input, 0);
  if (JSON.stringify(snapshot).length > maxBytes) throw new Error("journal bound");
  return snapshot;
}

function mapPublicationRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function mapPublicationExact(value: Record<string, unknown>, required: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === required.length && required.every((key) => Object.hasOwn(value, key));
}

function mapPublicationString(value: unknown, pattern: RegExp, max: number): value is string {
  return typeof value === "string" && value.length <= max && pattern.test(value);
}

function mapPublicationTargetPaths(value: unknown): value is readonly MapPublicationTargetPath[] {
  return Array.isArray(value) && value.length === MAP_PUBLICATION_FILESYSTEM_BOUNDS.exact_target_count &&
    value.every((path, index) => path === CODEBASE_MAP_PUBLICATION_TARGETS[index]);
}

function mapPublicationRootIdentity(value: unknown): value is MapPublicationTargetRootIdentity {
  if (!mapPublicationRecord(value) || !mapPublicationExact(value,
    ["schema_version", "project_identity", "project_root_hash", "target_root", "ownership_paths"])) return false;
  return value.schema_version === 1 && mapPublicationString(value.project_identity, MAP_PUBLICATION_IDENTITY,
    MAP_PUBLICATION_FILESYSTEM_BOUNDS.max_project_identity_length) &&
    mapPublicationString(value.project_root_hash, MAP_PUBLICATION_SHA256, 71) &&
    value.target_root === MAP_PUBLICATION_TARGET_ROOT && mapPublicationTargetPaths(value.ownership_paths);
}

function mapPublicationExpectedManifest(value: unknown): boolean {
  if (!mapPublicationRecord(value)) return false;
  if (mapPublicationExact(value, ["state"]) && value.state === "absent") return true;
  return mapPublicationExact(value, ["state", "manifest_hash"]) && value.state === "sha256" &&
    mapPublicationString(value.manifest_hash, MAP_PUBLICATION_SHA256, 71);
}

function mapPublicationBinding(value: unknown): value is MapPublicationTransactionBinding {
  if (!mapPublicationRecord(value) || !mapPublicationExact(value,
    ["operation_id", "action_id", "idempotency_key", "input_hash", "plan_hash", "expected_previous_manifest",
      "new_manifest_hash", "ownership_paths", "expected_payload_hashes", "expected_readback_hash"])) return false;
  if (!mapPublicationString(value.operation_id, MAP_PUBLICATION_IDENTITY,
    MAP_PUBLICATION_FILESYSTEM_BOUNDS.max_operation_id_length) ||
      !mapPublicationString(value.action_id, MAP_PUBLICATION_IDENTITY,
        MAP_PUBLICATION_FILESYSTEM_BOUNDS.max_action_id_length) ||
      !mapPublicationString(value.idempotency_key, MAP_PUBLICATION_IDENTITY,
        MAP_PUBLICATION_FILESYSTEM_BOUNDS.max_idempotency_key_length) ||
      !mapPublicationString(value.input_hash, MAP_PUBLICATION_SHA256, 71) ||
      !mapPublicationString(value.plan_hash, MAP_PUBLICATION_SHA256, 71) ||
      !mapPublicationExpectedManifest(value.expected_previous_manifest) ||
      !mapPublicationString(value.new_manifest_hash, MAP_PUBLICATION_SHA256, 71) ||
      !mapPublicationTargetPaths(value.ownership_paths) || !mapPublicationRecord(value.expected_payload_hashes) ||
      !mapPublicationExact(value.expected_payload_hashes, CODEBASE_MAP_PUBLICATION_TARGETS) ||
      !Object.values(value.expected_payload_hashes).every((hash) => mapPublicationString(hash,
        MAP_PUBLICATION_SHA256, 71)) || !mapPublicationString(value.expected_readback_hash, MAP_PUBLICATION_SHA256, 71)) {
    return false;
  }
  return true;
}

function mapPublicationStaging(value: unknown): value is MapPublicationStagingIdentity {
  if (!mapPublicationRecord(value) || !mapPublicationExact(value,
    ["staging_id", "staging_root_hash", "target_set_hash", "state"])) return false;
  return mapPublicationString(value.staging_id, MAP_PUBLICATION_STAGING_ID,
    MAP_PUBLICATION_FILESYSTEM_BOUNDS.max_staging_id_length) &&
    mapPublicationString(value.staging_root_hash, MAP_PUBLICATION_SHA256, 71) &&
    mapPublicationString(value.target_set_hash, MAP_PUBLICATION_SHA256, 71) &&
    ["private", "fsynced", "verified", "orphaned", "cleaned"].includes(String(value.state));
}

function mapPublicationRecovery(value: unknown): value is MapPublicationRecoveryIdentity {
  if (!mapPublicationRecord(value) || !mapPublicationExact(value, ["recovery_id", "recovery_token"])) return false;
  return mapPublicationString(value.recovery_id, MAP_PUBLICATION_STAGING_ID,
    MAP_PUBLICATION_FILESYSTEM_BOUNDS.max_recovery_id_length) &&
    mapPublicationString(value.recovery_token, MAP_PUBLICATION_RECOVERY_TOKEN,
      MAP_PUBLICATION_FILESYSTEM_BOUNDS.max_recovery_token_length);
}

function mapPublicationSafetyPolicy(value: unknown): value is MapPublicationFilesystemSafetyPolicy {
  if (!mapPublicationRecord(value) || !mapPublicationExact(value,
    ["same_volume", "atomic_replace", "fsync", "symlink_policy", "target_allowlist"])) return false;
  return value.same_volume === "same_volume_required" && value.atomic_replace === "atomic_replace_set_required" &&
    value.fsync === "file_and_parent_directory_required" && value.symlink_policy === "reject_symlink_and_reparse_point" &&
    value.target_allowlist === "exact_nine_targets";
}

function mapPublicationTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAP_PUBLICATION_FILESYSTEM_BOUNDS.max_timestamp_length ||
      !MAP_PUBLICATION_TIMESTAMP.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

const MAP_PUBLICATION_JOURNAL_TRANSITIONS = {
  prepared: {
    commit_ambiguity: ["not_ambiguous"],
    readback: ["pending"],
    cleanup: ["not_required"]
  },
  applying: {
    commit_ambiguity: ["not_ambiguous"],
    readback: ["pending"],
    cleanup: ["not_required"]
  },
  committed: {
    commit_ambiguity: ["resolved_committed"],
    readback: ["verified"],
    cleanup: ["not_required", "pending", "completed", "best_effort_failed"]
  },
  rolled_back: {
    commit_ambiguity: ["resolved_rolled_back"],
    readback: ["verified"],
    cleanup: ["not_required", "pending", "completed", "best_effort_failed"]
  },
  recovery_required: {
    commit_ambiguity: ["unknown"],
    readback: ["pending", "failed"],
    cleanup: ["not_required", "pending"]
  },
  unknown: {
    commit_ambiguity: ["unknown"],
    readback: ["pending", "failed"],
    cleanup: ["not_required", "pending"]
  }
} as const satisfies Record<MapPublicationFilesystemJournalState, {
  readonly commit_ambiguity: readonly MapPublicationCommitAmbiguityState[];
  readonly readback: readonly MapPublicationReadbackState[];
  readonly cleanup: readonly MapPublicationCleanupState[];
}>;

function mapPublicationJournalTransition(value: Record<string, unknown>): boolean {
  if (typeof value.state !== "string" || !Object.hasOwn(MAP_PUBLICATION_JOURNAL_TRANSITIONS, value.state)) {
    return false;
  }
  const transition = MAP_PUBLICATION_JOURNAL_TRANSITIONS[value.state as MapPublicationFilesystemJournalState];
  return transition.commit_ambiguity.some((state) => state === value.commit_ambiguity) &&
    transition.readback.some((state) => state === value.readback) &&
    transition.cleanup.some((state) => state === value.cleanup);
}

function mapPublicationJournal(value: unknown): value is MapPublicationFilesystemJournal {
  if (!mapPublicationRecord(value) || !mapPublicationExact(value, [
    "schema_version", "record_kind", "root_identity", "operation_id", "action_id", "idempotency_key", "binding",
    "staging", "recovery", "safety_policy", "state", "commit_ambiguity", "readback", "cleanup", "created_at",
    "updated_at"
  ])) return false;
  if (value.schema_version !== MAP_PUBLICATION_FILESYSTEM_SCHEMA_VERSION ||
      value.record_kind !== MAP_PUBLICATION_FILESYSTEM_RECORD_KIND || !mapPublicationRootIdentity(value.root_identity) ||
      !mapPublicationString(value.operation_id, MAP_PUBLICATION_IDENTITY,
        MAP_PUBLICATION_FILESYSTEM_BOUNDS.max_operation_id_length) ||
      !mapPublicationString(value.action_id, MAP_PUBLICATION_IDENTITY,
        MAP_PUBLICATION_FILESYSTEM_BOUNDS.max_action_id_length) ||
      !mapPublicationString(value.idempotency_key, MAP_PUBLICATION_IDENTITY,
        MAP_PUBLICATION_FILESYSTEM_BOUNDS.max_idempotency_key_length) || !mapPublicationBinding(value.binding) ||
      !mapPublicationStaging(value.staging) || !mapPublicationRecovery(value.recovery) ||
      !mapPublicationSafetyPolicy(value.safety_policy) || !mapPublicationTimestamp(value.created_at) ||
      !mapPublicationTimestamp(value.updated_at) || value.updated_at < value.created_at) return false;
  const binding = value.binding as MapPublicationTransactionBinding;
  const root = value.root_identity as MapPublicationTargetRootIdentity;
  if (binding.operation_id !== value.operation_id || binding.action_id !== value.action_id ||
      binding.idempotency_key !== value.idempotency_key || !mapPublicationTargetPaths(binding.ownership_paths) ||
      !mapPublicationTargetPaths(root.ownership_paths) ||
      binding.ownership_paths.some((path, index) => path !== root.ownership_paths[index])) return false;
  return mapPublicationJournalTransition(value);
}

/** Strict, fail-closed reader for the new journal descriptor and legacy v0. */
export function readMapPublicationFilesystemJournal(input: unknown): MapPublicationFilesystemJournalReadResult {
  let value: unknown;
  try {
    value = mapPublicationSnapshot(input, MAP_PUBLICATION_FILESYSTEM_BOUNDS.max_journal_bytes);
  } catch {
    return { ok: false, reason_code: "MAP_PUBLICATION_FILESYSTEM_JOURNAL_INVALID" };
  }
  if (!mapPublicationRecord(value) || typeof value.schema_version !== "number") {
    return { ok: false, reason_code: "MAP_PUBLICATION_FILESYSTEM_JOURNAL_INVALID" };
  }
  if (value.schema_version === 0) {
    return mapPublicationExact(value, ["schema_version", "legacy_ref"]) &&
      typeof value.legacy_ref === "string" && value.legacy_ref.length <= 160
      ? { ok: true, mode: "legacy_read_only", source_schema_version: 0 }
      : { ok: false, reason_code: "MAP_PUBLICATION_FILESYSTEM_JOURNAL_INVALID" };
  }
  if (value.schema_version !== MAP_PUBLICATION_FILESYSTEM_SCHEMA_VERSION) {
    return { ok: false, reason_code: "MAP_PUBLICATION_FILESYSTEM_VERSION_UNSUPPORTED" };
  }
  if (!mapPublicationJournal(value)) return { ok: false, reason_code: "MAP_PUBLICATION_FILESYSTEM_JOURNAL_INVALID" };
  return { ok: true, mode: "current", value: mapPublicationFreeze(value) };
}

/** Alias for callers that use “record” rather than “journal” terminology. */
export const readMapPublicationFilesystemRecord = readMapPublicationFilesystemJournal;
