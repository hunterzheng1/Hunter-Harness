import { createHash, randomBytes } from "node:crypto";
import { isPromise, isProxy } from "node:util/types";

import {
  classifyContentPath,
  contentKindSchema,
  type ContentKind,
  type RemoteSyncLease as ContractLease,
  type RemoteSyncPushState as ContractPushState,
  type SyncAction,
  type SyncScope
} from "@hunter-harness/contracts";

import { sha256Bytes } from "../fs/hash.js";
import { RemoteSyncError } from "./module.js";
import type { SourceRef, SyncOperation } from "./types.js";

/** Maximum bytes yielded by one content-stream chunk. */
export const REMOTE_SYNC_MAX_CHUNK_BYTES = 1024 * 1024;
/** Maximum bytes accepted for one remote-sync file. */
export const REMOTE_SYNC_MAX_FILE_BYTES = 64 * 1024 * 1024;
/** Maximum bytes materialized by one Pull transaction. */
export const REMOTE_SYNC_MAX_PULL_BYTES = 256 * 1024 * 1024;
/** Maximum operation records accepted in one Push or Pull transaction. */
export const REMOTE_SYNC_MAX_OPERATIONS = 100_000;
export const REMOTE_SYNC_V1_SCHEMA_VERSION = 1 as const;
export const REMOTE_SYNC_DEFAULT_LEASE_TTL_MS = 60_000;
export const REMOTE_SYNC_MAX_LEASE_TTL_MS = 10 * 60_000;

export interface RemoteSyncSourceRef {
  project_id: string;
  branch_name: string;
  actor_id: string;
  /** Optional immutable source identity carried through from the existing Core SourceRef. */
  commit_sha?: string;
  client_id?: string;
  change_key?: string;
}

export interface RemoteSyncLease extends ContractLease {
  readonly project_id: string;
  readonly branch_name: string;
  readonly actor_id: string;
}

export interface RemoteSyncLeaseOptions {
  ttl_ms?: number;
}

export interface RemoteSyncWorkspaceFile {
  path: string;
  content: Uint8Array | string;
  content_hash: string;
  size: number;
  content_kind?: ContentKind;
}

export interface RemoteSyncRemoteSnapshot {
  source: RemoteSyncSourceRef;
  snapshot_id: string;
  revision: string;
  project_version: string | null;
  commit_sha: string | null;
  artifact_id: string | null;
  manifest_hash: string;
  files: readonly RemoteSyncRemoteFileMetadata[];
}

export interface RemoteSyncRemoteFileMetadata {
  path: string;
  content_hash: string;
  size: number;
  content_kind?: ContentKind;
}

export interface RemoteSyncContentChunk {
  readonly sequence: number;
  readonly offset: number;
  readonly size: number;
  readonly chunk_hash: string;
  readonly final: boolean;
  readonly bytes: Uint8Array;
}

export interface RemoteSyncContentStreamOptions {
  signal?: AbortSignal;
  chunk_size?: number;
  snapshot_id?: string;
  expected_revision?: string;
}

export interface RemoteSyncPushPrepareCommand {
  source: RemoteSyncSourceRef;
  lease: RemoteSyncLease;
  expected_revision: string;
  preview_hash: string;
  idempotency_key: string;
  payload_hash: string;
  files: readonly RemoteSyncWorkspaceFile[];
  operations: readonly SyncOperation[];
  skipped: readonly SyncOperation[];
}

export interface RemoteSyncPreparedPush {
  schema_version: 1;
  prepare_id: string;
  source: RemoteSyncSourceRef;
  lease_id: string;
  lease_token: string;
  lease_generation: number;
  expected_revision: string;
  preview_hash: string;
  idempotency_key: string;
  payload_hash: string;
  state: "prepared";
  expires_at: string;
}

export interface RemoteSyncPushCommitCommand {
  prepare_id: string;
  lease: RemoteSyncLease;
  idempotency_key: string;
  payload_hash: string;
}

export interface RemoteSyncReceipt {
  schema_version: 1;
  prepare_id: string;
  source: RemoteSyncSourceRef;
  idempotency_key: string;
  payload_hash: string;
  preview_hash: string;
  project_version: string;
  artifact_id: string;
  commit_sha: string | null;
  manifest_hash: string;
  no_changes: boolean;
  applied: readonly SyncOperation[];
  skipped: readonly SyncOperation[];
  retryable: readonly SyncOperation[];
}

export interface RemoteSyncPushStatus {
  source: RemoteSyncSourceRef;
  state: ContractPushState;
  prepare_id: string;
  idempotency_key: string;
  payload_hash: string;
  receipt?: RemoteSyncReceipt;
}

export interface RemoteSyncPushStatusQuery {
  source: RemoteSyncSourceRef;
  idempotency_key: string;
}

export interface RemoteSyncErrorDescriptor {
  code: string;
  retryable: boolean;
}

export type RemoteSyncIdempotencyResult<T> =
  | { outcome: "new"; value: T }
  | { outcome: "replay"; value: T }
  | {
    outcome: "conflict";
    error: RemoteSyncErrorDescriptor & { code: "SYNC_IDEMPOTENCY_CONFLICT" };
  };

export interface RemoteSyncPullRequest {
  source: RemoteSyncSourceRef;
  actor_id: string;
  idempotency_key: string;
  payload_hash?: string;
}

export interface RemoteSyncPullReceipt {
  schema_version: 1;
  source: RemoteSyncSourceRef;
  idempotency_key: string;
  payload_hash: string;
  remote_revision: string;
  commit_sha: string | null;
  artifact_id: string | null;
  manifest_hash: string;
  local_transaction: "committed";
  project_version: string | null;
  no_changes: boolean;
  applied: readonly SyncOperation[];
  skipped: readonly SyncOperation[];
  retryable: readonly SyncOperation[];
}

export interface RemoteSyncLocalPullRequest {
  source: RemoteSyncSourceRef;
  actor_id: string;
  expected_remote_revision: string;
  idempotency_key: string;
}

/** Outcome returned by a local transaction when an adapter can report it. */
export interface RemoteSyncLocalTransactionResult {
  applied: readonly SyncOperation[];
  skipped: readonly SyncOperation[];
  retryable: readonly SyncOperation[];
}

export interface RemoteSyncLocalWorkspaceTransaction {
  /**
   * Adapters may return the staged outcome; `void` remains valid for adapters
   * that only expose success/failure and therefore produce empty receipt lists.
   */
  apply(
    files: readonly RemoteSyncWorkspaceFile[],
    signal?: AbortSignal
  ): Promise<RemoteSyncLocalTransactionResult | undefined>;
  commit(): Promise<RemoteSyncLocalTransactionResult | undefined>;
  rollback(): Promise<void>;
}

export interface RemoteSyncLeasePort {
  acquireLease(
    source: RemoteSyncSourceRef,
    options?: RemoteSyncLeaseOptions
  ): Promise<RemoteSyncLease>;
  renewLease(lease: RemoteSyncLease, options?: RemoteSyncLeaseOptions): Promise<RemoteSyncLease>;
  releaseLease(lease: RemoteSyncLease): Promise<void>;
}

export interface RemoteSyncRemotePort extends RemoteSyncLeasePort {
  readRemoteSnapshot(
    source: RemoteSyncSourceRef,
    signal?: AbortSignal
  ): Promise<RemoteSyncRemoteSnapshot>;
  preparePush(
    command: RemoteSyncPushPrepareCommand
  ): Promise<RemoteSyncIdempotencyResult<RemoteSyncPreparedPush>>;
  commitPush(
    command: RemoteSyncPushCommitCommand
  ): Promise<RemoteSyncIdempotencyResult<RemoteSyncReceipt>>;
  getPushStatus(query: RemoteSyncPushStatusQuery): Promise<RemoteSyncPushStatus | null>;
  openContentStream(
    source: RemoteSyncSourceRef,
    path: string,
    options?: RemoteSyncContentStreamOptions
  ): AsyncIterable<RemoteSyncContentChunk>;
}

export interface RemoteSyncLocalWorkspacePort {
  beginPull(request: RemoteSyncLocalPullRequest): Promise<RemoteSyncLocalWorkspaceTransaction>;
}

type Clock = () => number;

interface BranchState {
  source: RemoteSyncSourceRef;
  revision: number;
  project_version: string | null;
  commit_sha: string | null;
  artifact_id: string | null;
  manifest_hash: string;
  snapshot_id: string;
  version_count: number;
  remote_files: Map<string, RemoteSyncWorkspaceFile>;
  local_files: Map<string, RemoteSyncWorkspaceFile>;
}

interface StoredRemoteSnapshot {
  source_key: string;
  snapshot_id: string;
  revision: string;
  project_version: string | null;
  commit_sha: string | null;
  artifact_id: string | null;
  manifest_hash: string;
  files: Map<string, RemoteSyncWorkspaceFile>;
}

interface LeaseRecord {
  lease: RemoteSyncLease;
}

interface PreparedRecord {
  command: RemoteSyncPushPrepareCommand;
  prepared: RemoteSyncPreparedPush;
  state: ContractPushState;
  receipt?: RemoteSyncReceipt;
}

interface IdempotencyRecord<T> {
  payload_hash: string;
  source_key: string;
  value: T;
}

const LEASE_KEYS = [
  "schema_version", "lease_id", "lease_token", "generation", "project_id",
  "branch_name", "actor_id", "expires_at"
] as const;
const SOURCE_KEYS = [
  "project_id", "branch_name", "actor_id", "commit_sha", "client_id", "change_key"
] as const;
const FILE_KEYS = ["path", "content", "content_hash", "size", "content_kind"] as const;
const PREPARE_KEYS = [
  "source", "lease", "expected_revision", "preview_hash", "idempotency_key",
  "payload_hash", "files", "operations", "skipped"
] as const;
const PUSH_METADATA_KEYS = [
  "source", "expected_revision", "preview_hash", "idempotency_key",
  "payload_hash", "files", "operations", "skipped"
] as const;
const COMMIT_KEYS = ["prepare_id", "lease", "idempotency_key", "payload_hash"] as const;
const SNAPSHOT_KEYS = [
  "source", "snapshot_id", "revision", "project_version", "commit_sha", "artifact_id", "manifest_hash", "files"
] as const;
const SNAPSHOT_FILE_KEYS = ["path", "content_hash", "size", "content_kind"] as const;
const STREAM_OPTIONS_KEYS = [
  "signal", "chunk_size", "snapshot_id", "expected_revision"
] as const;
const PULL_KEYS = ["source", "actor_id", "idempotency_key", "payload_hash"] as const;
const LEASE_OPTION_KEYS = ["ttl_ms"] as const;
const OPERATION_KEYS = [
  "path", "source_path", "content_kind", "action", "local_hash", "remote_hash", "base_hash"
] as const;

function invalid(code: ConstructorParameters<typeof RemoteSyncError>[0], retryable = false): never {
  throw new RemoteSyncError(code, retryable);
}

function compareCodepoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeText(value: string, maximum = 240): boolean {
  if (value.length === 0 || value.length > maximum) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function canonicalKey(...parts: readonly string[]): string {
  return parts.map((part) => {
    if (!safeText(part)) invalid("SYNC_STREAM_INVALID");
    return `${utf8Length(part)}:${part}`;
  }).join("|");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCodepoint(left, right))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

function canonicalJsonValue(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

interface ManifestEntry {
  path: string;
  content_hash: string;
  size: number;
  content_kind?: ContentKind;
}

function manifestHashEntries(entries: readonly ManifestEntry[]): string {
  return sha256Bytes(canonicalJsonValue([...entries]
    .map((entry) => ({
      path: entry.path,
      content_hash: entry.content_hash,
      size: entry.size,
      ...(entry.content_kind === undefined ? {} : { content_kind: entry.content_kind })
    }))
    .sort((left, right) => compareCodepoint(left.path, right.path))));
}

/** Canonical durable manifest identity shared by HTTP and in-process adapters. */
export function remoteSyncSnapshotManifestHash(entries: readonly ManifestEntry[]): string {
  return manifestHashEntries(entries);
}

function manifestHash(files: readonly RemoteSyncWorkspaceFile[]): string {
  return manifestHashEntries(files);
}

/** Read only data descriptors; accessor-bearing and Proxy-hostile values fail closed. */
function plainDataRecord<T extends readonly string[]>(
  input: unknown,
  keys: T,
  code: ConstructorParameters<typeof RemoteSyncError>[0],
  optionalKeys: readonly string[] = []
): Record<T[number], unknown> {
  try {
    if (input !== null && typeof input === "object" && isProxy(input)) invalid(code);
    if (input === null || typeof input !== "object" || Array.isArray(input)) invalid(code);
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) invalid(code);
    const descriptors = Object.getOwnPropertyDescriptors(input) as unknown as PropertyDescriptorMap;
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.length > keys.length || keys.some((key) => {
      const descriptor = descriptors[key];
      return (!optionalKeys.includes(key) && descriptor === undefined) ||
        (descriptor !== undefined && !Object.hasOwn(descriptor, "value"));
    })) invalid(code);
    if (ownKeys.some((key) => typeof key !== "string" || !keys.includes(key as T[number]))) {
      invalid(code);
    }
    return Object.fromEntries(keys.map((key) => [key, descriptors[key]?.value])) as Record<T[number], unknown>;
  } catch (error) {
    if (error instanceof RemoteSyncError) throw error;
    invalid(code);
  }
}

function sourceKey(source: RemoteSyncSourceRef): string {
  return canonicalKey(source.project_id, source.branch_name);
}

function actorSourceKey(source: RemoteSyncSourceRef): string {
  return canonicalKey(source.project_id, source.branch_name, source.actor_id);
}

function operationKey(source: RemoteSyncSourceRef, idempotencyKey: string): string {
  return canonicalKey(source.project_id, source.branch_name, source.actor_id, idempotencyKey);
}

function sameSourceIdentity(left: RemoteSyncSourceRef, right: RemoteSyncSourceRef): boolean {
  return left.project_id === right.project_id && left.branch_name === right.branch_name &&
    left.actor_id === right.actor_id && (left.commit_sha ?? null) === (right.commit_sha ?? null) &&
    (left.client_id ?? null) === (right.client_id ?? null) &&
    (left.change_key ?? null) === (right.change_key ?? null);
}

function cloneBytes(content: Uint8Array | string): Uint8Array | string {
  if (isProxy(content)) invalid("SYNC_STREAM_INVALID");
  return content instanceof Uint8Array ? content.slice() : content;
}

function cloneFile(file: RemoteSyncWorkspaceFile): RemoteSyncWorkspaceFile {
  return {
    path: file.path,
    content: cloneBytes(file.content),
    content_hash: file.content_hash,
    size: file.size,
    ...(file.content_kind === undefined ? {} : { content_kind: file.content_kind })
  };
}

function cloneFiles(files: readonly RemoteSyncWorkspaceFile[]): RemoteSyncWorkspaceFile[] {
  return files.map(cloneFile).sort((left, right) => compareCodepoint(left.path, right.path));
}

function bytesOf(content: Uint8Array | string): Uint8Array {
  if (isProxy(content)) invalid("SYNC_STREAM_INVALID");
  return content instanceof Uint8Array ? content.slice() : new TextEncoder().encode(content);
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  try {
    const value = signal.aborted;
    if (typeof value !== "boolean") invalid("SYNC_STREAM_INVALID");
    return value;
  } catch (error) {
    if (error instanceof RemoteSyncError) throw error;
    invalid("SYNC_STREAM_INVALID");
  }
}

interface ClassifiedSyncPath {
  content_kind: ContentKind;
  sync_scope: SyncScope;
}

function validateSyncPath(path: string, code: ConstructorParameters<typeof RemoteSyncError>[0]): ClassifiedSyncPath {
  if (!safeText(path, 240)) invalid(code);
  const result = classifyContentPath({ schema_version: 1, path });
  if ("reason_code" in result) invalid(code);
  return {
    content_kind: result.content_kind,
    sync_scope: result.sync_scope
  };
}

function validateSource(input: unknown): RemoteSyncSourceRef {
  const values = plainDataRecord(input, SOURCE_KEYS, "SYNC_LEASE_INVALID", [
    "commit_sha", "client_id", "change_key"
  ]);
  if (typeof values.project_id !== "string" || !/^prj_[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/u.test(values.project_id) ||
      !safeText(values.project_id, 160) ||
      typeof values.branch_name !== "string" || !safeText(values.branch_name, 160) ||
      typeof values.actor_id !== "string" || !safeText(values.actor_id, 160) ||
      (values.commit_sha !== undefined &&
        (typeof values.commit_sha !== "string" || !safeText(values.commit_sha, 160))) ||
      (values.client_id !== undefined &&
        (typeof values.client_id !== "string" || !/^cli_[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/u.test(values.client_id) ||
          !safeText(values.client_id, 160))) ||
      (values.change_key !== undefined &&
        (typeof values.change_key !== "string" || !safeText(values.change_key, 160)))) {
    invalid("SYNC_LEASE_INVALID");
  }
  return {
    project_id: values.project_id,
    branch_name: values.branch_name,
    actor_id: values.actor_id,
    ...(values.commit_sha === undefined ? {} : { commit_sha: values.commit_sha as string }),
    ...(values.client_id === undefined ? {} : { client_id: values.client_id as string }),
    ...(values.change_key === undefined ? {} : { change_key: values.change_key as string })
  };
}

function validateLease(input: unknown): RemoteSyncLease {
  const values = plainDataRecord(input, LEASE_KEYS, "SYNC_LEASE_INVALID");
  const generation = values.generation;
  if (values.schema_version !== 1 || typeof values.lease_id !== "string" ||
      !/^lease_[A-Za-z0-9_-]{1,127}$/u.test(values.lease_id) ||
      typeof values.lease_token !== "string" ||
      !/^lease_[A-Za-z0-9_-]{43}$/u.test(values.lease_token) ||
      typeof generation !== "number" || !Number.isSafeInteger(generation) || generation <= 0 ||
      typeof values.project_id !== "string" || values.project_id.length === 0 ||
      typeof values.branch_name !== "string" || values.branch_name.length === 0 ||
      typeof values.actor_id !== "string" || values.actor_id.length === 0 ||
      !safeText(values.lease_id, 127) || !safeText(values.lease_token, 64) ||
      !safeText(values.project_id, 160) || !safeText(values.branch_name, 160) ||
      !safeText(values.actor_id, 160) ||
      typeof values.expires_at !== "string" || !safeText(values.expires_at, 40) ||
      Number.isNaN(Date.parse(values.expires_at))) {
    invalid("SYNC_LEASE_INVALID");
  }
  return {
    schema_version: 1,
    lease_id: values.lease_id,
    lease_token: values.lease_token,
    generation,
    project_id: values.project_id,
    branch_name: values.branch_name,
    actor_id: values.actor_id,
    expires_at: values.expires_at
  };
}

function validateFile(input: unknown): RemoteSyncWorkspaceFile {
  const values = plainDataRecord(input, FILE_KEYS, "SYNC_STREAM_INVALID", ["content_kind"]);
  const size = values.size;
  if (typeof values.path !== "string") invalid("SYNC_PATH_NOT_ELIGIBLE");
  const classified = validateSyncPath(values.path, "SYNC_PATH_NOT_ELIGIBLE");
  if (isProxy(values.content) ||
      !(values.content instanceof Uint8Array || typeof values.content === "string") ||
      typeof values.content_hash !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(values.content_hash) ||
      typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 ||
      size > REMOTE_SYNC_MAX_FILE_BYTES ||
      (values.content_kind !== undefined &&
        (typeof values.content_kind !== "string" ||
          !contentKindSchema.safeParse(values.content_kind).success ||
          values.content_kind !== classified.content_kind))) {
    if (typeof size === "number" && size > REMOTE_SYNC_MAX_FILE_BYTES) {
      invalid("SYNC_STREAM_TOO_LARGE");
    }
    invalid("SYNC_STREAM_INVALID");
  }
  const bytes = bytesOf(values.content);
  if (bytes.byteLength !== size || sha256Bytes(bytes) !== values.content_hash) {
    invalid("SYNC_STREAM_INVALID");
  }
  return {
    path: values.path,
    content: bytes,
    content_hash: values.content_hash,
    size,
    ...(values.content_kind === undefined ? {} : {
      content_kind: values.content_kind as ContentKind
    })
  };
}

function validateRemoteSnapshotFile(input: unknown): RemoteSyncRemoteFileMetadata {
  const values = plainDataRecord(input, SNAPSHOT_FILE_KEYS, "SYNC_STREAM_INVALID", ["content_kind"]);
  if (typeof values.path !== "string") invalid("SYNC_PATH_NOT_ELIGIBLE");
  const classified = validateSyncPath(values.path, "SYNC_PATH_NOT_ELIGIBLE");
  if (typeof values.content_hash !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(values.content_hash) ||
      typeof values.size !== "number" || !Number.isSafeInteger(values.size) ||
      values.size < 0 || values.size > REMOTE_SYNC_MAX_FILE_BYTES ||
      (values.content_kind !== undefined &&
        (typeof values.content_kind !== "string" ||
          !contentKindSchema.safeParse(values.content_kind).success ||
          values.content_kind !== classified.content_kind))) {
    if (typeof values.size === "number" && values.size > REMOTE_SYNC_MAX_FILE_BYTES) {
      invalid("SYNC_STREAM_TOO_LARGE");
    }
    invalid("SYNC_STREAM_INVALID");
  }
  return {
    path: values.path,
    content_hash: values.content_hash,
    size: values.size,
    ...(values.content_kind === undefined ? {} : { content_kind: values.content_kind as ContentKind })
  };
}

function validateRemoteSnapshot(input: unknown): RemoteSyncRemoteSnapshot {
  const values = plainDataRecord(input, SNAPSHOT_KEYS, "SYNC_PULL_WORKSPACE_FAILED");
  const snapshotSource = validateSource(values.source);
  if (typeof values.snapshot_id !== "string" || !safeText(values.snapshot_id, 160) ||
      typeof values.revision !== "string" || !safeText(values.revision, 160) ||
      (values.project_version !== null &&
        (typeof values.project_version !== "string" || !/^pv_[A-Za-z0-9_-]{1,159}$/u.test(values.project_version))) ||
      (values.commit_sha !== null &&
        (typeof values.commit_sha !== "string" || !safeText(values.commit_sha, 160))) ||
      (values.artifact_id !== null &&
        (typeof values.artifact_id !== "string" || !safeText(values.artifact_id, 160))) ||
      typeof values.manifest_hash !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(values.manifest_hash)) {
    invalid("SYNC_PULL_WORKSPACE_FAILED");
  }
  const fileInputs = dataArray(values.files, "SYNC_PULL_WORKSPACE_FAILED");
  if (fileInputs.length > REMOTE_SYNC_MAX_OPERATIONS) invalid("SYNC_STREAM_TOO_LARGE");
  const files = fileInputs.map((item) => validateRemoteSnapshotFile(item));
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const file of files) {
    const folded = file.path.toLocaleLowerCase("en-US");
    if (seen.has(folded)) invalid("SYNC_PULL_WORKSPACE_FAILED");
    seen.add(folded);
    totalBytes += file.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > REMOTE_SYNC_MAX_PULL_BYTES) {
      invalid("SYNC_STREAM_TOO_LARGE");
    }
  }
  if (manifestHashEntries(files) !== values.manifest_hash) invalid("SYNC_PULL_WORKSPACE_FAILED");
  return {
    source: snapshotSource,
    snapshot_id: values.snapshot_id,
    revision: values.revision,
    project_version: values.project_version,
    commit_sha: values.commit_sha,
    artifact_id: values.artifact_id,
    manifest_hash: values.manifest_hash,
    files
  };
}

/** Descriptor-only validation for remote snapshot responses at adapter boundaries. */
export function validateRemoteSyncRemoteSnapshot(input: unknown): RemoteSyncRemoteSnapshot {
  return validateRemoteSnapshot(input);
}

function validateFiles(input: unknown): RemoteSyncWorkspaceFile[] {
  const fileInputs = dataArray(input, "SYNC_STREAM_INVALID");
  if (fileInputs.length > REMOTE_SYNC_MAX_OPERATIONS) invalid("SYNC_STREAM_TOO_LARGE");
  const files = fileInputs.map((item) => validateFile(item));
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const file of files) {
    const folded = file.path.toLocaleLowerCase("en-US");
    if (seen.has(folded)) invalid("SYNC_STREAM_INVALID");
    seen.add(folded);
    totalBytes += file.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > REMOTE_SYNC_MAX_PULL_BYTES) {
      invalid("SYNC_STREAM_TOO_LARGE");
    }
  }
  return files;
}

function dataArray(input: unknown, code: ConstructorParameters<typeof RemoteSyncError>[0]): unknown[] {
  try {
    if (isProxy(input) || !Array.isArray(input)) invalid(code);
    const descriptors = Object.getOwnPropertyDescriptors(input) as unknown as PropertyDescriptorMap;
    const lengthDescriptor = descriptors["length"];
    if (lengthDescriptor === undefined || !Object.hasOwn(lengthDescriptor, "value") ||
        typeof lengthDescriptor.value !== "number" || !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0) invalid(code);
    const length = lengthDescriptor.value;
    if (length > REMOTE_SYNC_MAX_OPERATIONS) invalid("SYNC_STREAM_TOO_LARGE");
    const descriptorKeys = Reflect.ownKeys(descriptors);
    if (descriptorKeys.length !== length + 1) invalid(code);
    const values: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !Object.hasOwn(descriptor, "value") ||
          descriptor.enumerable !== true) invalid(code);
      values.push(descriptor.value);
    }
    if (descriptorKeys.some((key) => {
      if (key === "length") return false;
      if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key)) return true;
      const index = Number(key);
      return !Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== key;
    })) invalid(code);
    return values;
  } catch (error) {
    if (error instanceof RemoteSyncError) throw error;
    invalid(code);
  }
}

function validateOperation(input: unknown): SyncOperation {
  const values = plainDataRecord(input, OPERATION_KEYS, "SYNC_STREAM_INVALID", [
    "source_path", "local_hash", "remote_hash", "base_hash"
  ]);
  const action = values.action;
  const contentKind = values.content_kind;
  const sourcePath = values.source_path;
  if (typeof values.path !== "string") invalid("SYNC_STREAM_INVALID");
  const pathInfo = validateSyncPath(values.path, "SYNC_PATH_NOT_ELIGIBLE");
  if (typeof contentKind !== "string" || !contentKindSchema.safeParse(contentKind).success ||
      contentKind !== pathInfo.content_kind ||
      typeof action !== "string" || ![
    "add", "modify", "delete", "restore", "rename", "no_change"
  ].includes(action) ||
      (action === "rename" && typeof sourcePath !== "string") ||
      (action !== "rename" && sourcePath !== undefined)) {
    invalid("SYNC_CONTENT_INVALID");
  }
  if (action === "rename") {
    const sourceInfo = validateSyncPath(sourcePath as string, "SYNC_PATH_NOT_ELIGIBLE");
    if (sourceInfo.content_kind !== pathInfo.content_kind ||
        sourceInfo.sync_scope !== pathInfo.sync_scope) {
      invalid("SYNC_CONTENT_INVALID");
    }
  }
  const localHash = values.local_hash;
  const remoteHash = values.remote_hash;
  const baseHash = values.base_hash;
  const optionalHashNames = ["local_hash", "remote_hash", "base_hash"] as const;
  for (const name of optionalHashNames) {
    const value = values[name];
    if (value !== undefined) validateHash(value, "SYNC_STREAM_INVALID");
  }
  return {
    path: values.path,
    ...(sourcePath === undefined ? {} : { source_path: sourcePath as string }),
    content_kind: contentKind as ContentKind,
    action: action as SyncAction,
    ...(localHash === undefined ? {} : { local_hash: localHash as string }),
    ...(remoteHash === undefined ? {} : { remote_hash: remoteHash as string }),
    ...(baseHash === undefined ? {} : { base_hash: baseHash as string })
  };
}

function validateOperations(input: unknown): SyncOperation[] {
  const values = dataArray(input, "SYNC_STREAM_INVALID");
  if (values.length > REMOTE_SYNC_MAX_OPERATIONS) invalid("SYNC_STREAM_TOO_LARGE");
  return values.map((item) => validateOperation(item));
}

function validateOperationConsistency(
  files: readonly Pick<RemoteSyncWorkspaceFile, "path" | "content_kind">[],
  operations: readonly SyncOperation[],
  skipped: readonly SyncOperation[]
): void {
  const fileByPath = new Map(files.map((file) => [file.path, file]));
  const fileByFoldedPath = new Map<string, Pick<RemoteSyncWorkspaceFile, "path" | "content_kind">>();
  for (const file of files) {
    const foldedPath = file.path.toLocaleLowerCase("en-US");
    if (fileByFoldedPath.has(foldedPath)) invalid("SYNC_CONTENT_INVALID");
    fileByFoldedPath.set(foldedPath, file);
  }
  const operationPaths = new Set<string>();
  for (const item of [...operations, ...skipped]) {
    const foldedPath = item.path.toLocaleLowerCase("en-US");
    if (operationPaths.has(foldedPath)) invalid("SYNC_CONTENT_INVALID");
    operationPaths.add(foldedPath);
    const file = fileByPath.get(item.path) ?? fileByFoldedPath.get(foldedPath);
    if (file !== undefined && file.path !== item.path) invalid("SYNC_CONTENT_INVALID");
    if (item.action !== "delete" && item.action !== "no_change" && file === undefined) {
      invalid("SYNC_CONTENT_INVALID");
    }
    if (file?.content_kind !== undefined && file.content_kind !== item.content_kind) {
      invalid("SYNC_CONTENT_INVALID");
    }
  }
}

/**
 * Validate the metadata-only form used by the HTTP prepare boundary.
 *
 * HTTP cannot carry file bytes in a prepare request; the bytes are represented
 * by an already verified project-scoped upload reference.  This helper keeps
 * the path, content-kind, operation and canonical payload invariants in the
 * Core module so an HTTP adapter cannot drift from the in-process producer.
 */
export interface RemoteSyncPushMetadataInput {
  readonly source: RemoteSyncSourceRef;
  readonly expected_revision: string;
  readonly preview_hash: string;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly files: readonly RemoteSyncRemoteFileMetadata[];
  readonly operations: readonly SyncOperation[];
  readonly skipped: readonly SyncOperation[];
}

export function validateRemoteSyncPushMetadata(input: unknown): void {
  const values = plainDataRecord(input, PUSH_METADATA_KEYS, "SYNC_CONTENT_INVALID");
  const source = validateSource(values.source);
  if (typeof values.expected_revision !== "string" ||
      !safeText(values.expected_revision, 160) ||
      typeof values.preview_hash !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(values.preview_hash) ||
      typeof values.idempotency_key !== "string" ||
      !safeText(values.idempotency_key, 240) ||
      typeof values.payload_hash !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(values.payload_hash)) {
    invalid("SYNC_CONTENT_INVALID");
  }
  const files = dataArray(values.files, "SYNC_CONTENT_INVALID")
    .map((file) => validateRemoteSnapshotFile(file));
  let totalBytes = 0;
  for (const file of files) {
    totalBytes += file.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > REMOTE_SYNC_MAX_PULL_BYTES) {
      invalid("SYNC_STREAM_TOO_LARGE");
    }
  }
  const operations = dataArray(values.operations, "SYNC_CONTENT_INVALID")
    .map((operation) => validateOperation(operation));
  const skipped = dataArray(values.skipped, "SYNC_CONTENT_INVALID")
    .map((operation) => validateOperation(operation));
  validateOperationConsistency(files, operations, skipped);
  const canonicalFiles = files.map((file) => ({
    path: file.path,
    content_hash: file.content_hash,
    size: file.size,
    ...(file.content_kind === undefined ? {} : { content_kind: file.content_kind })
  }));
  const canonical = remoteSyncPushPayloadHash({
    source,
    expected_revision: values.expected_revision,
    preview_hash: values.preview_hash,
    idempotency_key: values.idempotency_key,
    files: canonicalFiles.map((file) => ({
      ...file,
      content: new Uint8Array(0)
    })) as RemoteSyncWorkspaceFile[],
    operations,
    skipped
  });
  if (canonical !== values.payload_hash) invalid("SYNC_CONTENT_INVALID");
}

export function remoteSyncPushPayloadHash(
  input: Pick<RemoteSyncPushPrepareCommand,
    "source" | "expected_revision" | "preview_hash" | "idempotency_key" | "files" | "operations" | "skipped">
): string {
  const sortOperations = (operations: readonly SyncOperation[]): SyncOperation[] =>
    [...operations].sort((left, right) =>
      compareCodepoint(left.path, right.path) ||
      compareCodepoint(left.action, right.action) ||
      compareCodepoint(left.source_path ?? "", right.source_path ?? ""));
  return sha256Bytes(canonicalJsonValue({
    source: input.source,
    expected_revision: input.expected_revision,
    preview_hash: input.preview_hash,
    idempotency_key: input.idempotency_key,
    files: [...input.files].map((file) => ({
      path: file.path,
      content_hash: file.content_hash,
      size: file.size,
      ...(file.content_kind === undefined ? {} : { content_kind: file.content_kind })
    })).sort((left, right) => compareCodepoint(left.path, right.path)),
    operations: sortOperations(input.operations),
    skipped: sortOperations(input.skipped)
  }));
}

function validateHash(value: unknown, code: ConstructorParameters<typeof RemoteSyncError>[0]): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) invalid(code);
  return value;
}

function validateStreamOptions(input: unknown): RemoteSyncContentStreamOptions {
  const values = plainDataRecord(input, STREAM_OPTIONS_KEYS, "SYNC_STREAM_INVALID", [
    "signal", "chunk_size", "snapshot_id", "expected_revision"
  ]);
  if (values.signal !== undefined) {
    if (typeof values.signal !== "object" || values.signal === null) {
      invalid("SYNC_STREAM_INVALID");
    }
    signalAborted(values.signal as AbortSignal);
  }
  if (values.chunk_size !== undefined &&
      (typeof values.chunk_size !== "number" || !Number.isSafeInteger(values.chunk_size))) {
    invalid("SYNC_STREAM_TOO_LARGE");
  }
  if (values.snapshot_id !== undefined &&
      (typeof values.snapshot_id !== "string" || !safeText(values.snapshot_id, 160)) ||
      values.expected_revision !== undefined &&
      (typeof values.expected_revision !== "string" || !safeText(values.expected_revision, 160))) {
    invalid("SYNC_STREAM_INVALID");
  }
  return {
    ...(values.signal === undefined ? {} : { signal: values.signal as AbortSignal }),
    ...(values.chunk_size === undefined ? {} : { chunk_size: values.chunk_size as number }),
    ...(values.snapshot_id === undefined ? {} : { snapshot_id: values.snapshot_id as string }),
    ...(values.expected_revision === undefined
      ? {} : { expected_revision: values.expected_revision as string })
  };
}

function validateContentChunk(input: unknown): RemoteSyncContentChunk {
  const values = plainDataRecord(input, [
    "sequence", "offset", "size", "chunk_hash", "final", "bytes"
  ] as const, "SYNC_STREAM_INVALID");
  const bytes = values.bytes;
  if (isProxy(bytes) || !(bytes instanceof Uint8Array) ||
      typeof values.sequence !== "number" || !Number.isSafeInteger(values.sequence) || values.sequence < 0 ||
      typeof values.offset !== "number" || !Number.isSafeInteger(values.offset) || values.offset < 0 ||
      typeof values.size !== "number" || !Number.isSafeInteger(values.size) || values.size < 0 ||
      values.size > REMOTE_SYNC_MAX_CHUNK_BYTES || values.size !== bytes.byteLength ||
      typeof values.chunk_hash !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(values.chunk_hash) ||
      values.chunk_hash !== sha256Bytes(bytes) || typeof values.final !== "boolean") {
    invalid("SYNC_STREAM_INVALID");
  }
  return {
    sequence: values.sequence,
    offset: values.offset,
    size: values.size,
    chunk_hash: values.chunk_hash,
    final: values.final,
    bytes: bytes.slice()
  };
}

function validateIteratorResult(input: unknown): { done: boolean; value?: unknown } {
  const values = plainDataRecord(input, ["done", "value"] as const,
    "SYNC_STREAM_INVALID", ["value"]);
  if (typeof values.done !== "boolean") invalid("SYNC_STREAM_INVALID");
  return {
    done: values.done,
    ...(values.value === undefined ? {} : { value: values.value })
  };
}

async function trustedAwait<T>(value: unknown, code: ConstructorParameters<typeof RemoteSyncError>[0]): Promise<T> {
  if (isProxy(value) || !isPromise(value)) invalid(code);
  try {
    const resolved = await value as unknown;
    if (isProxy(resolved)) invalid(code);
    return resolved as T;
  } catch (error) {
    if (error instanceof RemoteSyncError) throw error;
    throw error;
  }
}

function trustedAsyncIterable(input: unknown): AsyncIterable<RemoteSyncContentChunk> {
  if (input === null || (typeof input !== "object" && typeof input !== "function") || isProxy(input)) {
    invalid("SYNC_STREAM_INVALID");
  }
  try {
    dataMethod(input, Symbol.asyncIterator);
    return input as AsyncIterable<RemoteSyncContentChunk>;
  } catch (error) {
    if (error instanceof RemoteSyncError) throw error;
    invalid("SYNC_STREAM_INVALID");
  }
}

function trustedAsyncIterator(input: AsyncIterable<RemoteSyncContentChunk>): {
  next(): unknown;
} {
  try {
    const method = dataMethod(input, Symbol.asyncIterator);
    const iterator = Reflect.apply(method, input, []);
    if (iterator === null || typeof iterator !== "object" || isProxy(iterator)) {
      invalid("SYNC_STREAM_INVALID");
    }
    const next = dataMethod(iterator, "next");
    return {
      next: () => {
        try {
          return Reflect.apply(next, iterator, []);
        } catch (error) {
          if (error instanceof RemoteSyncError) throw error;
          invalid("SYNC_STREAM_INVALID");
        }
      }
    };
  } catch (error) {
    if (error instanceof RemoteSyncError) throw error;
    invalid("SYNC_STREAM_INVALID");
  }
}

function dataMethod(input: object, key: string | symbol): (...args: never[]) => unknown {
  if (input === null || (typeof input !== "object" && typeof input !== "function") || isProxy(input)) {
    invalid("SYNC_STREAM_INVALID");
  }
  let current: object | null = input;
  while (current !== null) {
    if (isProxy(current)) invalid("SYNC_STREAM_INVALID");
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor !== undefined) {
      if (!Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function" ||
          isProxy(descriptor.value)) {
        invalid("SYNC_STREAM_INVALID");
      }
      return descriptor.value as (...args: never[]) => unknown;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  invalid("SYNC_STREAM_INVALID");
}

/** Resolve a Port method from data descriptors without invoking accessors. */
function trustedPortMethod(
  input: unknown,
  key: string | symbol,
  code: ConstructorParameters<typeof RemoteSyncError>[0]
): (...args: readonly unknown[]) => unknown {
  if (input === null || (typeof input !== "object" && typeof input !== "function") || isProxy(input)) {
    invalid(code);
  }
  try {
    const method = dataMethod(input as object, key);
    return (...args: readonly unknown[]) => Reflect.apply(method, input, args as unknown[]);
  } catch {
    invalid(code);
  }
}

interface TrustedLocalTransaction {
  apply: (...args: readonly unknown[]) => unknown;
  commit: (...args: readonly unknown[]) => unknown;
  rollback: (...args: readonly unknown[]) => unknown;
}

function trustedLocalTransaction(input: unknown): TrustedLocalTransaction {
  return Object.freeze({
    apply: trustedPortMethod(input, "apply", "SYNC_PULL_WORKSPACE_FAILED"),
    commit: trustedPortMethod(input, "commit", "SYNC_PULL_WORKSPACE_FAILED"),
    rollback: trustedPortMethod(input, "rollback", "SYNC_PULL_WORKSPACE_FAILED")
  });
}

function validateLeaseOptions(input: unknown): RemoteSyncLeaseOptions {
  const values = plainDataRecord(input, LEASE_OPTION_KEYS, "SYNC_LEASE_INVALID", ["ttl_ms"]);
  if (values.ttl_ms !== undefined &&
      (typeof values.ttl_ms !== "number" || !Number.isSafeInteger(values.ttl_ms))) {
    invalid("SYNC_LEASE_INVALID");
  }
  return values.ttl_ms === undefined ? {} : { ttl_ms: values.ttl_ms as number };
}

function validatePrepare(input: unknown): RemoteSyncPushPrepareCommand {
  const values = plainDataRecord(input, PREPARE_KEYS, "SYNC_STREAM_INVALID");
  const source = validateSource(values.source);
  const lease = validateLease(values.lease);
  const files = validateFiles(values.files);
  if (typeof values.expected_revision !== "string" || !safeText(values.expected_revision, 160) ||
      typeof values.preview_hash !== "string" ||
      typeof values.idempotency_key !== "string" || !safeText(values.idempotency_key, 240) ||
      typeof values.payload_hash !== "string") invalid("SYNC_STREAM_INVALID");
  validateHash(values.preview_hash, "SYNC_STREAM_INVALID");
  validateHash(values.payload_hash, "SYNC_STREAM_INVALID");
  const operations = validateOperations(values.operations);
  const skipped = validateOperations(values.skipped);
  validateOperationConsistency(files, operations, skipped);
  const command = {
    source,
    lease,
    expected_revision: values.expected_revision,
    preview_hash: values.preview_hash,
    idempotency_key: values.idempotency_key,
    payload_hash: values.payload_hash,
    files,
    operations,
    skipped
  };
  if (values.payload_hash !== remoteSyncPushPayloadHash(command)) {
    invalid("SYNC_CONTENT_INVALID");
  }
  return { ...command, payload_hash: values.payload_hash as string };
}

function validateCommit(input: unknown): RemoteSyncPushCommitCommand {
  const values = plainDataRecord(input, COMMIT_KEYS, "SYNC_LEASE_INVALID");
  if (typeof values.prepare_id !== "string" || !safeText(values.prepare_id, 160) ||
      typeof values.idempotency_key !== "string" || !safeText(values.idempotency_key, 240)) {
    invalid("SYNC_LEASE_INVALID");
  }
  return {
    prepare_id: values.prepare_id,
    lease: validateLease(values.lease),
    idempotency_key: values.idempotency_key,
    payload_hash: validateHash(values.payload_hash, "SYNC_LEASE_INVALID")
  };
}

function iso(now: number): string {
  return new Date(now).toISOString();
}

function token(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function conflict(): RemoteSyncIdempotencyResult<never> {
  return {
    outcome: "conflict",
    error: { code: "SYNC_IDEMPOTENCY_CONFLICT", retryable: false }
  };
}

function cloneReceipt(receipt: RemoteSyncReceipt): RemoteSyncReceipt {
  return structuredClone(receipt);
}

function clonePrepared(prepared: RemoteSyncPreparedPush): RemoteSyncPreparedPush {
  return structuredClone(prepared);
}

function cloneStatus(status: RemoteSyncPushStatus): RemoteSyncPushStatus {
  return structuredClone(status);
}

function emptyLocalTransactionResult(): RemoteSyncLocalTransactionResult {
  return { applied: [], skipped: [], retryable: [] };
}

function cloneLocalTransactionResult(
  result: RemoteSyncLocalTransactionResult
): RemoteSyncLocalTransactionResult {
  return {
    applied: structuredClone(result.applied),
    skipped: structuredClone(result.skipped),
    retryable: structuredClone(result.retryable)
  };
}

function compareOperations(left: SyncOperation, right: SyncOperation): number {
  return compareCodepoint(left.path, right.path) ||
    compareCodepoint(left.action, right.action) ||
    compareCodepoint(left.source_path ?? "", right.source_path ?? "") ||
    compareCodepoint(left.content_kind, right.content_kind);
}

function normalizeOperationList(operations: readonly SyncOperation[]): SyncOperation[] {
  return [...operations].sort(compareOperations);
}

function validateLocalTransactionResultConsistency(
  applied: readonly SyncOperation[],
  skipped: readonly SyncOperation[],
  retryable: readonly SyncOperation[]
): void {
  const seen = new Set<string>();
  for (const operation of [...applied, ...skipped, ...retryable]) {
    const canonicalPath = operation.path.toLocaleLowerCase("en-US");
    if (seen.has(canonicalPath)) invalid("SYNC_PULL_WORKSPACE_FAILED");
    seen.add(canonicalPath);
  }
}

function pullTransactionResult(
  before: readonly RemoteSyncWorkspaceFile[],
  after: readonly RemoteSyncWorkspaceFile[]
): RemoteSyncLocalTransactionResult {
  const beforeByPath = new Map(before.map((file) => [file.path, file]));
  const afterByPath = new Map(after.map((file) => [file.path, file]));
  const applied: SyncOperation[] = [];
  const skipped: SyncOperation[] = [];
  const contentKind = (
    file: RemoteSyncWorkspaceFile,
    fallback?: RemoteSyncWorkspaceFile
  ): ContentKind => file.content_kind ?? fallback?.content_kind ??
    validateSyncPath(file.path, "SYNC_PATH_NOT_ELIGIBLE").content_kind;

  for (const file of after) {
    const prior = beforeByPath.get(file.path);
    if (prior === undefined) {
      applied.push({
        path: file.path,
        content_kind: contentKind(file),
        action: "add",
        remote_hash: file.content_hash
      });
    } else if (prior.content_hash === file.content_hash) {
      skipped.push({
        path: file.path,
        content_kind: contentKind(file, prior),
        action: "no_change",
        local_hash: prior.content_hash,
        remote_hash: file.content_hash
      });
    } else {
      applied.push({
        path: file.path,
        content_kind: contentKind(file, prior),
        action: "modify",
        local_hash: prior.content_hash,
        remote_hash: file.content_hash
      });
    }
  }
  for (const file of before) {
    if (!afterByPath.has(file.path)) {
      applied.push({
        path: file.path,
        content_kind: contentKind(file),
        action: "delete",
        local_hash: file.content_hash
      });
    }
  }
  return { applied, skipped, retryable: [] };
}

function normalizeLocalTransactionResult(input: unknown): RemoteSyncLocalTransactionResult {
  if (input === undefined) return emptyLocalTransactionResult();
  try {
    const values = plainDataRecord(input, ["applied", "skipped", "retryable"] as const,
      "SYNC_PULL_WORKSPACE_FAILED");
    const applied = validateOperations(values.applied);
    const skipped = validateOperations(values.skipped);
    const retryable = validateOperations(values.retryable);
    validateLocalTransactionResultConsistency(applied, skipped, retryable);
    return {
      applied: normalizeOperationList(applied),
      skipped: normalizeOperationList(skipped),
      retryable: normalizeOperationList(retryable)
    };
  } catch (error) {
    if (error instanceof RemoteSyncError && error.code === "SYNC_PULL_WORKSPACE_FAILED") {
      throw error;
    }
    throw new RemoteSyncError("SYNC_PULL_WORKSPACE_FAILED");
  }
}

/**
 * Reference in-memory Remote Sync v1 implementation.  It intentionally
 * exposes a remote port and a local-workspace port from the same object only
 * for tests; production adapters must keep those capabilities separate.
 */
export class InMemoryRemoteSyncV1 implements RemoteSyncRemotePort, RemoteSyncLocalWorkspacePort {
  readonly #clock: Clock;
  readonly #branches = new Map<string, BranchState>();
  readonly #snapshots = new Map<string, StoredRemoteSnapshot>();
  readonly #leases = new Map<string, LeaseRecord>();
  readonly #leaseGenerations = new Map<string, number>();
  readonly #preparesById = new Map<string, PreparedRecord>();
  readonly #preparesByKey = new Map<string, IdempotencyRecord<RemoteSyncPreparedPush>>();
  readonly #commitsByKey = new Map<string, IdempotencyRecord<RemoteSyncReceipt>>();
  readonly #statuses = new Map<string, RemoteSyncPushStatus>();
  #remoteReads = 0;
  #failCommitAfterPublish = false;

  constructor(options: { now?: Clock } = {}) {
    this.#clock = options.now ?? (() => Date.now());
  }

  async acquireLease(
    sourceInput: RemoteSyncSourceRef,
    options: RemoteSyncLeaseOptions = {}
  ): Promise<RemoteSyncLease> {
    const source = validateSource(sourceInput);
    const ttl = this.#leaseTtl(validateLeaseOptions(options).ttl_ms);
    const key = sourceKey(source);
    const active = this.#leases.get(key);
    if (active !== undefined && Date.parse(active.lease.expires_at) > this.#clock()) {
      throw new RemoteSyncError("SYNC_LEASE_BUSY", true);
    }
    const generation = (this.#leaseGenerations.get(key) ?? 0) + 1;
    this.#leaseGenerations.set(key, generation);
    const lease: RemoteSyncLease = {
      schema_version: 1,
      lease_id: token("lease"),
      lease_token: token("lease"),
      generation,
      project_id: source.project_id,
      branch_name: source.branch_name,
      actor_id: source.actor_id,
      expires_at: iso(this.#clock() + ttl)
    };
    this.#leases.set(key, { lease });
    this.#state(source);
    return structuredClone(lease);
  }

  async renewLease(
    leaseInput: RemoteSyncLease,
    options: RemoteSyncLeaseOptions = {}
  ): Promise<RemoteSyncLease> {
    const lease = validateLease(leaseInput);
    this.#assertLease(lease, {
      project_id: lease.project_id,
      branch_name: lease.branch_name,
      actor_id: lease.actor_id
    });
    const renewed: RemoteSyncLease = {
      ...lease,
      expires_at: iso(this.#clock() + this.#leaseTtl(validateLeaseOptions(options).ttl_ms))
    };
    this.#leases.set(sourceKey(lease), { lease: renewed });
    return structuredClone(renewed);
  }

  async releaseLease(leaseInput: RemoteSyncLease): Promise<void> {
    const lease = validateLease(leaseInput);
    this.#assertLease(lease, {
      project_id: lease.project_id,
      branch_name: lease.branch_name,
      actor_id: lease.actor_id
    });
    this.#leases.delete(sourceKey(lease));
  }

  async readRemoteSnapshot(
    sourceInput: RemoteSyncSourceRef,
    signal?: AbortSignal
  ): Promise<RemoteSyncRemoteSnapshot> {
    if (signalAborted(signal)) invalid("SYNC_STREAM_ABORTED", true);
    const source = validateSource(sourceInput);
    this.#remoteReads += 1;
    const state = this.#state(source);
    const snapshot = this.#snapshots.get(state.snapshot_id);
    if (snapshot === undefined) invalid("SYNC_STREAM_INVALID");
    return {
      source: structuredClone(source),
      snapshot_id: state.snapshot_id,
      revision: String(state.revision),
      project_version: state.project_version,
      commit_sha: snapshot.commit_sha,
      artifact_id: snapshot.artifact_id,
      manifest_hash: snapshot.manifest_hash,
      files: [...snapshot.files.values()].map((file) => ({
        path: file.path,
        content_hash: file.content_hash,
        size: file.size,
        ...(file.content_kind === undefined ? {} : { content_kind: file.content_kind })
      }))
    };
  }

  async preparePush(
    input: RemoteSyncPushPrepareCommand
  ): Promise<RemoteSyncIdempotencyResult<RemoteSyncPreparedPush>> {
    const command = validatePrepare(input);
    this.#assertLease(command.lease, command.source);
    const operationId = operationKey(command.source, command.idempotency_key);
    const prior = this.#preparesByKey.get(operationId);
    const actorKey = actorSourceKey(command.source);
    if (prior !== undefined) {
      if (prior.payload_hash !== command.payload_hash || prior.source_key !== actorKey) {
        return conflict();
      }
      return { outcome: "replay", value: clonePrepared(prior.value) };
    }
    const state = this.#state(command.source);
    if (state.revision.toString() !== command.expected_revision) {
      throw new RemoteSyncError("SYNC_PREVIEW_STALE");
    }
    const prepared: RemoteSyncPreparedPush = {
      schema_version: 1,
      prepare_id: token("prepare"),
      source: structuredClone(command.source),
      lease_id: command.lease.lease_id,
      lease_token: command.lease.lease_token,
      lease_generation: command.lease.generation,
      expected_revision: command.expected_revision,
      preview_hash: command.preview_hash,
      idempotency_key: command.idempotency_key,
      payload_hash: command.payload_hash,
      state: "prepared",
      expires_at: command.lease.expires_at
    };
    this.#preparesById.set(prepared.prepare_id, {
      command: {
        ...command,
        source: structuredClone(command.source),
        lease: structuredClone(command.lease),
        files: cloneFiles(command.files),
        operations: structuredClone(command.operations),
        skipped: structuredClone(command.skipped)
      },
      prepared,
      state: "prepared"
    });
    this.#preparesByKey.set(operationId, {
      payload_hash: command.payload_hash,
      source_key: actorKey,
      value: prepared
    });
    this.#statuses.set(operationId, {
      source: structuredClone(command.source),
      state: "prepared",
      prepare_id: prepared.prepare_id,
      idempotency_key: command.idempotency_key,
      payload_hash: command.payload_hash
    });
    return { outcome: "new", value: clonePrepared(prepared) };
  }

  async commitPush(
    input: RemoteSyncPushCommitCommand
  ): Promise<RemoteSyncIdempotencyResult<RemoteSyncReceipt>> {
    const command = validateCommit(input);
    const preparedRecord = this.#preparesById.get(command.prepare_id);
    if (preparedRecord === undefined) throw new RemoteSyncError("SYNC_PREPARE_NOT_FOUND");
    const prepared = preparedRecord.prepared;
    this.#assertLease(command.lease, prepared.source);
    if (prepared.lease_generation !== command.lease.generation ||
        prepared.lease_id !== command.lease.lease_id ||
        prepared.lease_token !== command.lease.lease_token) {
      throw new RemoteSyncError("SYNC_LEASE_FENCED");
    }
    if (prepared.idempotency_key !== command.idempotency_key ||
        prepared.payload_hash !== command.payload_hash) {
      return conflict();
    }
    const operationId = operationKey(prepared.source, command.idempotency_key);
    const prior = this.#commitsByKey.get(operationId);
    if (prior !== undefined) {
      if (prior.payload_hash !== command.payload_hash || prior.source_key !== actorSourceKey(prepared.source)) {
        return conflict();
      }
      const status = this.#statuses.get(operationId);
      if (status?.state === "unknown") throw new RemoteSyncError("SYNC_COMMIT_AMBIGUOUS", true);
      return { outcome: "replay", value: cloneReceipt(prior.value) };
    }
    if (Date.parse(prepared.expires_at) <= this.#clock()) {
      throw new RemoteSyncError("SYNC_PREPARE_EXPIRED");
    }
    const state = this.#state(prepared.source);
    if (state.revision.toString() !== prepared.expected_revision) {
      throw new RemoteSyncError("SYNC_PREVIEW_STALE");
    }
    preparedRecord.state = "committing";
    this.#statuses.set(operationId, {
      source: structuredClone(prepared.source),
      state: "committing",
      prepare_id: prepared.prepare_id,
      idempotency_key: command.idempotency_key,
      payload_hash: command.payload_hash
    });
    const files = cloneFiles(preparedRecord.command.files);
    const noChanges = preparedRecord.command.operations.length === 0;
    const projectVersion = noChanges
      ? (state.project_version ?? "pv_0")
      : `pv_${state.version_count + 1}`;
    const artifactId = noChanges
      ? (state.artifact_id ?? `art_${state.version_count}`)
      : `art_${state.version_count + 1}`;
    const commitSha = prepared.source.commit_sha ?? state.commit_sha;
    const nextManifestHash = noChanges ? state.manifest_hash : manifestHash(files);
    const receipt: RemoteSyncReceipt = {
      schema_version: 1,
      prepare_id: prepared.prepare_id,
      source: structuredClone(prepared.source),
      idempotency_key: command.idempotency_key,
      payload_hash: command.payload_hash,
      preview_hash: prepared.preview_hash,
      project_version: projectVersion,
      artifact_id: artifactId,
      commit_sha: commitSha,
      manifest_hash: nextManifestHash,
      no_changes: noChanges,
      applied: structuredClone(preparedRecord.command.operations),
      skipped: structuredClone(preparedRecord.command.skipped),
      retryable: []
    };
    if (!noChanges) {
      state.remote_files = new Map(files.map((item) => [item.path, cloneFile(item)]));
      state.project_version = `pv_${state.version_count + 1}`;
      state.commit_sha = commitSha;
      state.artifact_id = artifactId;
      state.manifest_hash = nextManifestHash;
      state.version_count += 1;
      state.revision += 1;
      state.snapshot_id = token("snapshot");
      this.#snapshots.set(state.snapshot_id, {
        source_key: sourceKey(prepared.source),
        snapshot_id: state.snapshot_id,
        revision: String(state.revision),
        project_version: state.project_version,
        commit_sha: state.commit_sha,
        artifact_id: state.artifact_id,
        manifest_hash: state.manifest_hash,
        files: new Map(files.map((item) => [item.path, cloneFile(item)]))
      });
    }
    this.#commitsByKey.set(operationId, {
      payload_hash: command.payload_hash,
      source_key: actorSourceKey(prepared.source),
      value: receipt
    });
    preparedRecord.receipt = receipt;
    const ambiguous = !noChanges && this.#failCommitAfterPublish;
    preparedRecord.state = ambiguous ? "unknown" : "committed";
    this.#statuses.set(operationId, {
      source: structuredClone(prepared.source),
      state: preparedRecord.state,
      prepare_id: prepared.prepare_id,
      idempotency_key: command.idempotency_key,
      payload_hash: command.payload_hash,
      receipt: cloneReceipt(receipt)
    });
    if (ambiguous) {
      this.#failCommitAfterPublish = false;
      throw new RemoteSyncError("SYNC_COMMIT_AMBIGUOUS", true);
    }
    return { outcome: "new", value: cloneReceipt(receipt) };
  }

  async getPushStatus(input: RemoteSyncPushStatusQuery): Promise<RemoteSyncPushStatus | null> {
    const values = plainDataRecord(input, ["source", "idempotency_key"] as const,
      "SYNC_STREAM_INVALID");
    const source = validateSource(values.source);
    if (typeof values.idempotency_key !== "string" || !safeText(values.idempotency_key, 240)) {
      invalid("SYNC_STREAM_INVALID");
    }
    const operationId = operationKey(source, values.idempotency_key);
    const status = this.#statuses.get(operationId);
    if (status !== undefined) return cloneStatus(status);
    return null;
  }

  async getPushReceipt(input: RemoteSyncPushStatusQuery): Promise<RemoteSyncReceipt | null> {
    const status = await this.getPushStatus(input);
    return status?.receipt === undefined ? null : cloneReceipt(status.receipt);
  }

  readContentStream(
    source: RemoteSyncSourceRef,
    path: string,
    options: RemoteSyncContentStreamOptions = {}
  ): AsyncIterable<RemoteSyncContentChunk> {
    return this.openContentStream(source, path, options);
  }

  openContentStream(
    sourceInput: RemoteSyncSourceRef,
    path: string,
    options: RemoteSyncContentStreamOptions = {}
  ): AsyncIterable<RemoteSyncContentChunk> {
    const source = validateSource(sourceInput);
    if (typeof path !== "string" || path.length === 0) invalid("SYNC_STREAM_INVALID");
    const streamOptions = validateStreamOptions(options);
    const chunkSize = streamOptions.chunk_size ?? REMOTE_SYNC_MAX_CHUNK_BYTES;
    if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > REMOTE_SYNC_MAX_CHUNK_BYTES) {
      invalid("SYNC_STREAM_TOO_LARGE");
    }
    if (streamOptions.snapshot_id === undefined || streamOptions.expected_revision === undefined) {
      invalid("SYNC_STREAM_INVALID");
    }
    const snapshot = this.#snapshots.get(streamOptions.snapshot_id);
    if (snapshot === undefined || snapshot.source_key !== sourceKey(source) ||
        snapshot.revision !== streamOptions.expected_revision) {
      throw new RemoteSyncError("SYNC_PREVIEW_STALE");
    }
    const file = snapshot.files.get(path);
    if (file === undefined) invalid("SYNC_STREAM_INVALID");
    const expected = cloneFile(file);
    const signal = streamOptions.signal;
    return (async function* stream(): AsyncGenerator<RemoteSyncContentChunk> {
      const bytes = bytesOf(expected.content);
      let offset = 0;
      let sequence = 0;
      while (offset < bytes.byteLength || (bytes.byteLength === 0 && sequence === 0)) {
        if (signalAborted(signal)) invalid("SYNC_STREAM_ABORTED", true);
        const end = Math.min(offset + chunkSize, bytes.byteLength);
        const chunk = bytes.slice(offset, end);
        const isFinal = end >= bytes.byteLength;
        const descriptor: RemoteSyncContentChunk = {
          sequence,
          offset,
          size: chunk.byteLength,
          chunk_hash: sha256Bytes(chunk),
          final: isFinal,
          bytes: chunk
        };
        if (descriptor.size > REMOTE_SYNC_MAX_CHUNK_BYTES) invalid("SYNC_STREAM_TOO_LARGE");
        yield descriptor;
        offset = end;
        sequence += 1;
        if (isFinal) break;
      }
      if (bytes.byteLength !== expected.size || sha256Bytes(bytes) !== expected.content_hash) {
        invalid("SYNC_STREAM_INVALID");
      }
    })();
  }

  async beginPull(
    requestInput: RemoteSyncLocalPullRequest
  ): Promise<RemoteSyncLocalWorkspaceTransaction> {
    const request = validatePullRequest(requestInput);
    const state = this.#state(request.source);
    if (String(state.revision) !== request.expected_remote_revision) {
      throw new RemoteSyncError("SYNC_PREVIEW_STALE");
    }
    const before = cloneFiles([...state.local_files.values()]);
    let staged = before;
    let stagedResult = emptyLocalTransactionResult();
    let closed = false;
    return {
      apply: async (files, signal) => {
        if (closed) invalid("SYNC_PULL_WORKSPACE_FAILED");
        if (signalAborted(signal)) invalid("SYNC_STREAM_ABORTED", true);
        staged = validateFiles(files);
        stagedResult = pullTransactionResult(before, staged);
        if (signalAborted(signal)) invalid("SYNC_STREAM_ABORTED", true);
        return cloneLocalTransactionResult(stagedResult);
      },
      commit: async () => {
        if (closed) invalid("SYNC_PULL_WORKSPACE_FAILED");
        if (String(state.revision) !== request.expected_remote_revision) {
          invalid("SYNC_PREVIEW_STALE");
        }
        state.local_files = new Map(staged.map((item) => [item.path, cloneFile(item)]));
        closed = true;
        return cloneLocalTransactionResult(stagedResult);
      },
      rollback: async () => {
        if (closed) return;
        state.local_files = new Map(before.map((item) => [item.path, cloneFile(item)]));
        closed = true;
      }
    };
  }

  localFiles(sourceInput: RemoteSyncSourceRef): RemoteSyncWorkspaceFile[] {
    const source = validateSource(sourceInput);
    return cloneFiles([...this.#state(source).local_files.values()]);
  }

  versionCount(sourceInput: RemoteSyncSourceRef): number {
    return this.#state(validateSource(sourceInput)).version_count;
  }

  remoteReadCount(): number {
    return this.#remoteReads;
  }

  failNextCommitAfterPublish(): void {
    this.#failCommitAfterPublish = true;
  }

  #state(source: RemoteSyncSourceRef): BranchState {
    const key = sourceKey(source);
    const current = this.#branches.get(key);
    if (current !== undefined) return current;
    const created: BranchState = {
      source: structuredClone(source),
      revision: 0,
      project_version: null,
      commit_sha: source.commit_sha ?? null,
      artifact_id: null,
      manifest_hash: manifestHash([]),
      version_count: 0,
      snapshot_id: token("snapshot"),
      remote_files: new Map(),
      local_files: new Map()
    };
    this.#branches.set(key, created);
    this.#snapshots.set(created.snapshot_id, {
      source_key: key,
      snapshot_id: created.snapshot_id,
      revision: "0",
      project_version: null,
      commit_sha: created.commit_sha,
      artifact_id: created.artifact_id,
      manifest_hash: created.manifest_hash,
      files: new Map()
    });
    return created;
  }

  #leaseTtl(value: number | undefined): number {
    const ttl = value ?? REMOTE_SYNC_DEFAULT_LEASE_TTL_MS;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > REMOTE_SYNC_MAX_LEASE_TTL_MS) {
      invalid("SYNC_LEASE_INVALID");
    }
    return ttl;
  }

  #assertLease(leaseInput: RemoteSyncLease, source: RemoteSyncSourceRef): void {
    const lease = validateLease(leaseInput);
    const target = validateSource(source);
    if (lease.project_id !== target.project_id || lease.branch_name !== target.branch_name ||
        lease.actor_id !== target.actor_id) {
      throw new RemoteSyncError("SYNC_LEASE_SCOPE_MISMATCH");
    }
    if (Date.parse(lease.expires_at) <= this.#clock()) {
      throw new RemoteSyncError("SYNC_LEASE_EXPIRED");
    }
    const current = this.#leases.get(sourceKey(target));
    if (current !== undefined && Date.parse(current.lease.expires_at) <= this.#clock()) {
      throw new RemoteSyncError("SYNC_LEASE_EXPIRED");
    }
    if (current === undefined || current.lease.generation !== lease.generation ||
        current.lease.expires_at !== lease.expires_at ||
        current.lease.lease_token !== lease.lease_token ||
        current.lease.lease_id !== lease.lease_id) {
      throw new RemoteSyncError("SYNC_LEASE_FENCED");
    }
  }
}

function validatePullRequest(input: unknown): RemoteSyncLocalPullRequest {
  const values = plainDataRecord(input, [
    "source", "actor_id", "expected_remote_revision", "idempotency_key"
  ] as const, "SYNC_PULL_WORKSPACE_FAILED");
  const source = validateSource(values.source);
  if (typeof values.actor_id !== "string" || values.actor_id !== source.actor_id ||
      typeof values.expected_remote_revision !== "string" || !safeText(values.expected_remote_revision, 160) ||
      typeof values.idempotency_key !== "string" || !safeText(values.idempotency_key, 240)) {
    invalid("SYNC_PULL_WORKSPACE_FAILED");
  }
  return {
    source,
    actor_id: values.actor_id,
    expected_remote_revision: values.expected_remote_revision,
    idempotency_key: values.idempotency_key
  };
}

/** Core orchestration that makes remote reads and local writes separate ports. */
export class RemoteSyncV1Module {
  readonly #remote: RemoteSyncRemotePort;
  readonly #workspace: RemoteSyncLocalWorkspacePort;
  readonly #pulls = new Map<string, { payload_hash: string; receipt: RemoteSyncPullReceipt }>();

  constructor(remote: RemoteSyncRemotePort, workspace: RemoteSyncLocalWorkspacePort) {
    this.#remote = remote;
    this.#workspace = workspace;
  }

  async pull(
    input: RemoteSyncPullRequest,
    signal?: AbortSignal
  ): Promise<RemoteSyncIdempotencyResult<RemoteSyncPullReceipt>> {
    const values = plainDataRecord(input, PULL_KEYS, "SYNC_PULL_WORKSPACE_FAILED", ["payload_hash"]);
    const source = validateSource(values.source);
    if (typeof values.actor_id !== "string" || values.actor_id !== source.actor_id ||
        typeof values.idempotency_key !== "string" || !safeText(values.idempotency_key, 240)) {
      invalid("SYNC_PULL_WORKSPACE_FAILED");
    }
    const payloadHash = values.payload_hash === undefined
      ? sha256Bytes(canonicalJsonValue({
        source,
        actor_id: values.actor_id,
        idempotency_key: values.idempotency_key
      }))
      : validateHash(values.payload_hash, "SYNC_PULL_WORKSPACE_FAILED");
    const key = operationKey(source, values.idempotency_key);
    const prior = this.#pulls.get(key);
    if (prior !== undefined) {
      if (prior.payload_hash !== payloadHash) return conflict();
      return { outcome: "replay", value: structuredClone(prior.receipt) };
    }
    let snapshot: RemoteSyncRemoteSnapshot;
    try {
      const readRemoteSnapshot = trustedPortMethod(
        this.#remote,
        "readRemoteSnapshot",
        "SYNC_PULL_WORKSPACE_FAILED"
      );
      const remoteSnapshot = readRemoteSnapshot(source, signal);
      snapshot = validateRemoteSnapshot(await trustedAwait(remoteSnapshot, "SYNC_PULL_WORKSPACE_FAILED"));
    } catch (error) {
      if (error instanceof RemoteSyncError) throw error;
      throw new RemoteSyncError("SYNC_PULL_WORKSPACE_FAILED", true);
    }
    if (!sameSourceIdentity(snapshot.source, source) ||
        (source.commit_sha !== undefined && source.commit_sha !== snapshot.commit_sha)) {
      throw new RemoteSyncError("SYNC_PREVIEW_STALE");
    }
    const files: RemoteSyncWorkspaceFile[] = [];
    let totalPulledBytes = 0;
    let transactionResult = emptyLocalTransactionResult();
    try {
      for (const metadata of snapshot.files) {
        totalPulledBytes += metadata.size;
        if (!Number.isSafeInteger(totalPulledBytes) || totalPulledBytes > REMOTE_SYNC_MAX_PULL_BYTES) {
          invalid("SYNC_STREAM_TOO_LARGE");
        }
        let stream: AsyncIterable<RemoteSyncContentChunk>;
        try {
          const openContentStream = trustedPortMethod(
            this.#remote,
            "openContentStream",
            "SYNC_STREAM_INVALID"
          );
          stream = trustedAsyncIterable(openContentStream(source, metadata.path, {
            snapshot_id: snapshot.snapshot_id,
            expected_revision: snapshot.revision,
            ...(signal === undefined ? {} : { signal })
          }));
        } catch (error) {
          if (error instanceof RemoteSyncError) throw error;
          throw new RemoteSyncError("SYNC_STREAM_INVALID");
        }
        const content = new Uint8Array(metadata.size);
        const digest = createHash("sha256");
        let expectedSequence = 0;
        let expectedOffset = 0;
        let ended = false;
        const iterator = trustedAsyncIterator(stream);
        while (true) {
          const next = validateIteratorResult(await trustedAwait<IteratorResult<RemoteSyncContentChunk>>(
            iterator.next(), "SYNC_STREAM_INVALID"
          ));
          if (next.done === true) break;
          const chunk = validateContentChunk(next.value);
          if (signalAborted(signal)) invalid("SYNC_STREAM_ABORTED", true);
          if (chunk.bytes.byteLength > REMOTE_SYNC_MAX_CHUNK_BYTES ||
              chunk.size !== chunk.bytes.byteLength ||
              chunk.sequence !== expectedSequence || chunk.offset !== expectedOffset ||
              chunk.chunk_hash !== sha256Bytes(chunk.bytes) || ended) {
            invalid("SYNC_STREAM_INVALID");
          }
          if (expectedOffset + chunk.bytes.byteLength > metadata.size) invalid("SYNC_STREAM_INVALID");
          content.set(chunk.bytes, expectedOffset);
          digest.update(chunk.bytes);
          expectedSequence += 1;
          expectedOffset += chunk.bytes.byteLength;
          if (chunk.final) ended = true;
        }
        if (!ended || expectedOffset !== metadata.size) invalid("SYNC_STREAM_INVALID");
        const digestHash = `sha256:${digest.digest("hex")}`;
        if (content.byteLength !== metadata.size || digestHash !== metadata.content_hash) {
          invalid("SYNC_STREAM_INVALID");
        }
        files.push({
          path: metadata.path,
          content,
          content_hash: metadata.content_hash,
          size: metadata.size,
          ...(metadata.content_kind === undefined ? {} : { content_kind: metadata.content_kind })
        });
      }
      const beginPull = trustedPortMethod(
        this.#workspace,
        "beginPull",
        "SYNC_PULL_WORKSPACE_FAILED"
      );
      const transactionOutput = await trustedAwait<unknown>(beginPull({
        source,
        actor_id: values.actor_id,
        expected_remote_revision: snapshot.revision,
        idempotency_key: values.idempotency_key
      }), "SYNC_PULL_WORKSPACE_FAILED");
      const transaction = trustedLocalTransaction(transactionOutput);
      try {
        const appliedResult = await trustedAwait<unknown>(
          transaction.apply(files, signal),
          "SYNC_PULL_WORKSPACE_FAILED"
        );
        if (appliedResult !== undefined) {
          transactionResult = normalizeLocalTransactionResult(appliedResult);
        }
        if (signalAborted(signal)) invalid("SYNC_STREAM_ABORTED", true);
        const committedResult = await trustedAwait<unknown>(
          transaction.commit(),
          "SYNC_PULL_WORKSPACE_FAILED"
        );
        if (committedResult !== undefined) {
          transactionResult = normalizeLocalTransactionResult(committedResult);
        }
      } catch (error) {
        await trustedAwait<unknown>(transaction.rollback(), "SYNC_PULL_WORKSPACE_FAILED");
        if (error instanceof RemoteSyncError) throw error;
        throw new RemoteSyncError("SYNC_PULL_WORKSPACE_FAILED", true);
      }
    } catch (error) {
      if (error instanceof RemoteSyncError) throw error;
      throw new RemoteSyncError("SYNC_PULL_WORKSPACE_FAILED", true);
    }
    const receipt: RemoteSyncPullReceipt = {
      schema_version: 1,
      source: structuredClone(source),
      idempotency_key: values.idempotency_key,
      payload_hash: payloadHash,
      remote_revision: snapshot.revision,
      commit_sha: snapshot.commit_sha,
      artifact_id: snapshot.artifact_id,
      manifest_hash: snapshot.manifest_hash,
      local_transaction: "committed",
      project_version: snapshot.project_version,
      no_changes: transactionResult.applied.length === 0 &&
        transactionResult.retryable.length === 0 &&
        (files.length === 0 || transactionResult.skipped.length === files.length),
      applied: structuredClone(transactionResult.applied),
      skipped: structuredClone(transactionResult.skipped),
      retryable: structuredClone(transactionResult.retryable)
    };
    this.#pulls.set(key, { payload_hash: payloadHash, receipt });
    return { outcome: "new", value: structuredClone(receipt) };
  }
}

/** Explicit names for adapters that want to advertise the v1 seams. */
export type RemoteSyncV1Port = RemoteSyncRemotePort;
export type RemoteSyncWorkspacePort = RemoteSyncLocalWorkspacePort;
export type RemoteSyncPullTransaction = RemoteSyncLocalWorkspaceTransaction;
export { InMemoryRemoteSyncV1 as InMemoryRemoteSyncReferencePort };

export function createInMemoryRemoteSyncV1(options: { now?: Clock } = {}): InMemoryRemoteSyncV1 {
  return new InMemoryRemoteSyncV1(options);
}

export function isRemoteSyncContentChunk(value: unknown): value is RemoteSyncContentChunk {
  try {
    const record = plainDataRecord(value, [
      "sequence", "offset", "size", "chunk_hash", "final", "bytes"
    ] as const, "SYNC_STREAM_INVALID");
    const sequence = record.sequence;
    const offset = record.offset;
    const size = record.size;
    const bytes = record.bytes;
    return typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence >= 0 &&
      typeof offset === "number" && Number.isSafeInteger(offset) && offset >= 0 &&
      !isProxy(bytes) && bytes instanceof Uint8Array && typeof size === "number" && size === bytes.byteLength &&
      size <= REMOTE_SYNC_MAX_CHUNK_BYTES &&
      typeof record.chunk_hash === "string" && sha256Bytes(bytes) === record.chunk_hash &&
      typeof record.final === "boolean";
  } catch {
    return false;
  }
}

export type RemoteSyncContentKind = ContentKind;
export type RemoteSyncSyncScope = SyncScope;
export type RemoteSyncAction = SyncAction;
export type RemoteSyncSource = SourceRef;
