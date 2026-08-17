import { createHash, randomUUID } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { lstat, open, opendir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  canonicalJson,
  classifyContentPath,
  contentKindSchema,
  remoteSyncHttpMaxFileBytes,
  remoteSyncHttpMaxOperations,
  remoteSyncHttpMaxTotalBytes,
  remoteSyncHttpErrorCodeSchema,
  remoteSyncLeaseHttpResponseSchema,
  remoteSyncLeaseReleaseHttpResponseSchema,
  remoteSyncPushCommitHttpResponseSchema,
  remoteSyncPushPrepareHttpResponseSchema,
  remoteSyncPushStatusHttpResponseSchema,
  syncActionSchema,
  validateRemoteContentUploadHttpResult,
  type RemoteSyncPreparedPushHttp,
  type RemoteSyncPushPrepareHttpRequest,
  type RemoteSyncPushReceiptHttp,
  type RemoteSyncSourceRef
} from "@hunter-harness/contracts";
import {
  assertJournalCheckpoint,
  RemoteSyncError,
  remoteSyncPushPayloadHash,
  remoteSyncSnapshotManifestHash,
  resumeTransaction,
  runTransaction,
  transactionJournalPlanHash,
  transactionPlanHash,
  validateRemoteSyncPushMetadata,
  validateRemoteSyncRemoteSnapshot,
  type ArchiveCommit,
  type ArchiveSyncReceipt,
  type BranchSnapshotPage,
  type ContentFile,
  type PullCommit,
  type ProjectRef,
  type PushCommit,
  type RemoteSyncPort,
  type RemoteSyncLease,
  type SnapshotFile,
  type SnapshotFilePage,
  type SnapshotRef,
  type SnapshotVersionPage,
  type SourceRef,
  type SyncReceipt,
  type SyncDirection,
  type SyncStatus,
  type SyncView,
  type TransactionOperation,
  type TransactionOptions,
  type TransactionJournal,
  type TransactionResult
} from "@hunter-harness/core";

export interface RemoteSyncHttpPortOptions {
  readonly serverUrl: string;
  readonly token: string;
  /** Authenticated principal identity bound into every HTTP source descriptor. */
  readonly actorId: string;
  readonly workspaceRoot: string;
  readonly fetch?: typeof globalThis.fetch;
  /** @internal deterministic transaction seam for fault-injection tests. */
  readonly runWorkspaceTransaction?: (
    projectRoot: string,
    operations: readonly TransactionOperation[],
    options?: TransactionOptions
  ) => Promise<TransactionResult>;
  /** @internal deterministic pre-read metadata seam for resource-bound tests. */
  readonly statWorkspaceFile?: (path: string) => Promise<{ readonly size: number }>;
  /** @internal deterministic workspace read seam for resource-bound tests. */
  readonly readWorkspaceFile?: (path: string) => Promise<Uint8Array>;
  /** @internal bounded directory-stream seam for resource-bound tests. */
  readonly readWorkspaceEntries?: (
    path: string
  ) => AsyncIterable<Pick<Dirent, "name" | "isSymbolicLink" | "isDirectory" | "isFile">>;
}

interface StoredReceipt {
  readonly schema_version: 1;
  readonly record_kind: "remote_sync_http_receipt";
  readonly source_ref: SourceRef;
  readonly direction: SyncDirection;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly stored_at: string;
  readonly receipt: SyncReceipt;
}

const RECEIPT_RECORD_KIND = "remote_sync_http_receipt" as const;
const RECEIPT_TRANSACTION_PREFIX = "tx_remote_receipt_";
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const RECEIPT_REASON_CODES = new Set([
  "SYNC_LOCK_UNAVAILABLE",
  "REMOTE_UNAVAILABLE",
  "REMOTE_PUBLISH_FAILED",
  "PULL_TRANSACTION_FAILED",
  "SYNC_CANCELLED"
]);

function pathSegment(value: string): string {
  return encodeURIComponent(value);
}

function sourceKey(source: SourceRef): string {
  return JSON.stringify(source);
}

function sameSource(left: SourceRef, right: SourceRef): boolean {
  return left.project_id === right.project_id &&
    left.branch_name === right.branch_name &&
    left.commit_sha === right.commit_sha &&
    left.client_id === right.client_id &&
    (left.change_key ?? undefined) === (right.change_key ?? undefined);
}

function exactObjectKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key));
}

function validStoredOperation(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) return false;
  const operation = value as Record<string, unknown>;
  if (!exactObjectKeys(
    operation,
    ["path", "content_kind", "action"],
    ["source_path", "local_hash", "remote_hash", "base_hash"]
  ) || typeof operation.path !== "string" || operation.path.length > 1024 ||
      !contentKindSchema.safeParse(operation.content_kind).success ||
      !syncActionSchema.safeParse(operation.action).success ||
      (operation.source_path !== undefined &&
        (typeof operation.source_path !== "string" || operation.source_path.length > 1024)) ||
      [operation.local_hash, operation.remote_hash, operation.base_hash].some((hash) =>
        hash !== undefined && (typeof hash !== "string" || !SHA256.test(hash)))) {
    return false;
  }
  if (operation.action === "rename") {
    if (typeof operation.source_path !== "string") return false;
  } else if (operation.source_path !== undefined) {
    return false;
  }
  const classify = (path: string) => classifyContentPath({
    schema_version: 1,
    path,
    ...(operation.content_kind === "branch_file" ? { source_kind: "branch_file" as const } : {})
  });
  const target = classify(operation.path);
  if (!("content_kind" in target) || target.content_kind !== operation.content_kind) return false;
  if (operation.action === "rename" && typeof operation.source_path === "string") {
    const source = classify(operation.source_path);
    if (!("content_kind" in source) || source.content_kind !== operation.content_kind ||
        source.sync_scope !== target.sync_scope) return false;
  }
  return true;
}

function validatedStoredReceipt(value: unknown): SyncReceipt {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
  }
  const receipt = value as Record<string, unknown>;
  if (!exactObjectKeys(
    receipt,
    ["preview_hash", "no_changes", "applied", "skipped", "retryable"],
    ["project_version", "artifact_id", "reason_code"]
  ) || typeof receipt.preview_hash !== "string" || !SHA256.test(receipt.preview_hash) ||
      typeof receipt.no_changes !== "boolean" ||
      (receipt.project_version !== undefined &&
        (typeof receipt.project_version !== "string" || receipt.project_version.length > 160)) ||
      (receipt.artifact_id !== undefined &&
        (typeof receipt.artifact_id !== "string" || receipt.artifact_id.length > 160)) ||
      ((receipt.project_version === undefined) !== (receipt.artifact_id === undefined)) ||
      (receipt.reason_code !== undefined &&
        (typeof receipt.reason_code !== "string" || !RECEIPT_REASON_CODES.has(receipt.reason_code))) ||
      !Array.isArray(receipt.applied) || !Array.isArray(receipt.skipped) ||
      !Array.isArray(receipt.retryable) ||
      receipt.applied.length + receipt.skipped.length + receipt.retryable.length > MAX_WORKSPACE_FILES ||
      ![...receipt.applied, ...receipt.skipped, ...receipt.retryable].every(validStoredOperation)) {
    throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
  }
  return structuredClone(receipt) as unknown as SyncReceipt;
}

function validatedStoredReceiptRecord(value: unknown): StoredReceipt {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
  }
  const record = value as Record<string, unknown>;
  if (!exactObjectKeys(record, [
    "schema_version", "record_kind", "source_ref", "direction",
    "idempotency_key", "payload_hash", "stored_at", "receipt"
  ]) || record.schema_version !== 1 || record.record_kind !== RECEIPT_RECORD_KIND ||
      (record.direction !== "push" && record.direction !== "pull") ||
      typeof record.idempotency_key !== "string" || !SHA256.test(record.idempotency_key) ||
      typeof record.payload_hash !== "string" || !SHA256.test(record.payload_hash) ||
      typeof record.stored_at !== "string" || record.stored_at.length > 64 ||
      !Number.isFinite(Date.parse(record.stored_at)) ||
      record.source_ref === null || typeof record.source_ref !== "object" ||
      Array.isArray(record.source_ref) || Object.getPrototypeOf(record.source_ref) !== Object.prototype) {
    throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
  }
  const source = record.source_ref as Record<string, unknown>;
  if (!exactObjectKeys(
    source,
    ["project_id", "branch_name", "commit_sha", "client_id"],
    ["change_key"]
  ) || [source.project_id, source.branch_name, source.commit_sha, source.client_id]
    .some((item) => typeof item !== "string" || item.length === 0 || item.length > 160) ||
      (source.change_key !== undefined &&
        (typeof source.change_key !== "string" || source.change_key.length === 0 || source.change_key.length > 160))) {
    throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
  }
  return Object.freeze({
    schema_version: 1,
    record_kind: RECEIPT_RECORD_KIND,
    source_ref: Object.freeze({ ...(source as unknown as SourceRef) }),
    direction: record.direction as SyncDirection,
    idempotency_key: record.idempotency_key,
    payload_hash: record.payload_hash,
    stored_at: record.stored_at,
    receipt: Object.freeze(validatedStoredReceipt(record.receipt))
  });
}

function httpSource(source: SourceRef, actorId: string): RemoteSyncSourceRef {
  return {
    project_id: source.project_id,
    branch_name: source.branch_name,
    actor_id: actorId,
    commit_sha: source.commit_sha,
    client_id: source.client_id,
    ...(source.change_key === undefined ? {} : { change_key: source.change_key })
  };
}

function normalizeHttpSource(source: RemoteSyncSourceRef): RemoteSyncSourceRef {
  return {
    project_id: source.project_id,
    branch_name: source.branch_name,
    actor_id: source.actor_id,
    ...(source.commit_sha === undefined ? {} : { commit_sha: source.commit_sha }),
    ...(source.client_id === undefined ? {} : { client_id: source.client_id }),
    ...(source.change_key === undefined ? {} : { change_key: source.change_key })
  } as RemoteSyncSourceRef;
}

function sameHttpSource(left: RemoteSyncSourceRef, right: RemoteSyncSourceRef): boolean {
  return left.project_id === right.project_id &&
    left.branch_name === right.branch_name &&
    left.actor_id === right.actor_id &&
    (left.commit_sha ?? undefined) === (right.commit_sha ?? undefined) &&
    (left.client_id ?? undefined) === (right.client_id ?? undefined) &&
    (left.change_key ?? undefined) === (right.change_key ?? undefined);
}

function sameLeaseSource(lease: RemoteSyncLease, source: SourceRef, actorId: string): boolean {
  return lease.project_id === source.project_id &&
    lease.branch_name === source.branch_name &&
    lease.actor_id === actorId;
}

function httpPayloadHash(input: Pick<RemoteSyncPushPrepareHttpRequest,
  "source" | "expected_revision" | "preview_hash" | "idempotency_key" | "files" | "operations" | "skipped">): string {
  const files = input.files.map(({ upload_ref, ...file }) => {
    void upload_ref;
    return file;
  });
  return remoteSyncPushPayloadHash({
    ...input,
    source: normalizeHttpSource(input.source) as never,
    files: files.map((file) => ({ ...file, content: new Uint8Array(0) })) as never
  });
}

function contentHash(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function canonicalIdentityHash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function fileUploadIdempotencyKey(
  source: RemoteSyncSourceRef,
  pushIdempotencyKey: string,
  file: Pick<ContentFile, "path" | "content_hash" | "size">
): `sha256:${string}` {
  return canonicalIdentityHash({
    schema_version: 1,
    operation: "remote_sync_file_upload",
    source: normalizeHttpSource(source),
    push_idempotency_key: pushIdempotencyKey,
    path: file.path,
    content_sha256: file.content_hash,
    size_bytes: file.size
  });
}

function safeRelative(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (normalized.length === 0 || normalized.startsWith("/") || normalized.includes("\0") ||
      normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new RemoteSyncError("SYNC_PATH_NOT_ELIGIBLE");
  }
  return normalized;
}

const MAX_WORKSPACE_FILES = remoteSyncHttpMaxOperations;
const MAX_WORKSPACE_BYTES = remoteSyncHttpMaxTotalBytes;
const MAX_WORKSPACE_DEPTH = 32;
const MAX_BINARY_STREAM_CHUNKS = 16_384;
const MAX_JSON_STREAM_CHUNKS = remoteSyncHttpMaxOperations * 2;
const WORKSPACE_EXCLUDED_PATH_REASONS = new Set([
  "CONTENT_PATH_VCS_EXCLUDED",
  "CONTENT_PATH_CREDENTIALS_EXCLUDED",
  "CONTENT_PATH_ENV_EXCLUDED",
  "CONTENT_PATH_STATE_EXCLUDED",
  "CONTENT_PATH_RUNTIME_EXCLUDED",
  "CONTENT_PATH_NON_SCANNABLE_KIND"
]);

function classifyWorkspacePath(path: string) {
  return classifyContentPath({ schema_version: 1, path });
}

function excludedWorkspacePath(path: string): boolean {
  const classified = classifyWorkspacePath(path);
  return "reason_code" in classified && WORKSPACE_EXCLUDED_PATH_REASONS.has(classified.reason_code);
}

function toContentFile(path: string, bytes: Uint8Array): ContentFile | undefined {
  const classified = classifyContentPath({ schema_version: 1, path });
  if (!("content_kind" in classified)) return undefined;
  return {
    path,
    content_kind: classified.content_kind,
    content_hash: contentHash(bytes),
    size: bytes.byteLength,
    content: new Uint8Array(bytes)
  };
}

interface WalkState {
  entries: number;
  files: number;
  bytes: number;
}

interface WorkspaceFileIo {
  entries(path: string): AsyncIterable<Pick<Dirent, "name" | "isSymbolicLink" | "isDirectory" | "isFile">>;
  stat(path: string): Promise<{ readonly size: number }>;
  read(path: string): Promise<Uint8Array>;
}

async function* readWorkspaceEntries(
  path: string
): AsyncIterable<Pick<Dirent, "name" | "isSymbolicLink" | "isDirectory" | "isFile">> {
  const directory = await opendir(path);
  for await (const entry of directory) yield entry;
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs;
}

async function readWorkspaceFileFromContainedHandle(
  root: string,
  path: string
): Promise<Uint8Array> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!(await assertContainedExistingPath(root, path))) {
      throw new RemoteSyncError("SYNC_PATH_NOT_ELIGIBLE");
    }
    handle = await open(path, "r");
    const opened = await handle.stat();
    if (!opened.isFile()) throw new RemoteSyncError("SYNC_PATH_NOT_ELIGIBLE");
    if (!Number.isSafeInteger(opened.size) || opened.size < 0 ||
        opened.size > remoteSyncHttpMaxFileBytes) {
      throw new RemoteSyncError("SYNC_STREAM_TOO_LARGE");
    }
    if (!(await assertContainedExistingPath(root, path))) {
      throw new RemoteSyncError("SYNC_PATH_NOT_ELIGIBLE");
    }
    const target = await stat(await realpath(path));
    if (!sameFileIdentity(opened, target)) throw new RemoteSyncError("SYNC_PATH_NOT_ELIGIBLE");
    const bytes = new Uint8Array(opened.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) throw new RemoteSyncError("SYNC_STREAM_INVALID");
      offset += result.bytesRead;
    }
    const overflow = new Uint8Array(1);
    if ((await handle.read(overflow, 0, 1, offset)).bytesRead !== 0) {
      throw new RemoteSyncError("SYNC_STREAM_INVALID");
    }
    const completed = await handle.stat();
    if (!sameFileIdentity(opened, completed) ||
        !(await assertContainedExistingPath(root, path)) ||
        !sameFileIdentity(completed, await stat(await realpath(path)))) {
      throw new RemoteSyncError("SYNC_PATH_NOT_ELIGIBLE");
    }
    return bytes;
  } catch (error) {
    if (error instanceof RemoteSyncError &&
        (error.code === "SYNC_STREAM_TOO_LARGE" || error.code === "SYNC_STREAM_INVALID" ||
          error.code === "SYNC_PATH_NOT_ELIGIBLE")) {
      throw error;
    }
    throw new RemoteSyncError("SYNC_PATH_NOT_ELIGIBLE");
  } finally {
    await handle?.close();
  }
}

async function walkFiles(
  root: string,
  io: WorkspaceFileIo,
  current = root,
  state: WalkState = { entries: 0, files: 0, bytes: 0 },
  depth = 0
): Promise<ContentFile[]> {
  if (depth > MAX_WORKSPACE_DEPTH) throw new RemoteSyncError("SYNC_STREAM_TOO_LARGE");
  const output: ContentFile[] = [];
  for await (const entry of io.entries(current)) {
    state.entries += 1;
    if (state.entries > MAX_WORKSPACE_FILES) throw new RemoteSyncError("SYNC_STREAM_TOO_LARGE");
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".harness-private-evidence") continue;
    const absolute = join(current, entry.name);
    const path = relative(root, absolute).replaceAll("\\", "/");
    if (excludedWorkspacePath(path)) continue;
    if (entry.isSymbolicLink()) throw new RemoteSyncError("SYNC_PATH_NOT_ELIGIBLE");
    if (entry.isDirectory()) {
      output.push(...await walkFiles(root, io, absolute, state, depth + 1));
      continue;
    }
    if (!entry.isFile()) continue;
    const classified = classifyWorkspacePath(path);
    if (!("content_kind" in classified)) continue;
    const metadata = await io.stat(absolute);
    const nextFiles = state.files + 1;
    const declaredBytes = state.bytes + metadata.size;
    if (!Number.isSafeInteger(metadata.size) || metadata.size < 0 ||
        metadata.size > remoteSyncHttpMaxFileBytes ||
        !Number.isSafeInteger(declaredBytes) || declaredBytes > MAX_WORKSPACE_BYTES ||
        nextFiles > MAX_WORKSPACE_FILES) {
      throw new RemoteSyncError("SYNC_STREAM_TOO_LARGE");
    }
    const bytes = new Uint8Array(await io.read(absolute));
    const actualBytes = state.bytes + bytes.byteLength;
    if (bytes.byteLength > remoteSyncHttpMaxFileBytes ||
        !Number.isSafeInteger(actualBytes) || actualBytes > MAX_WORKSPACE_BYTES) {
      throw new RemoteSyncError("SYNC_STREAM_TOO_LARGE");
    }
    if (bytes.byteLength !== metadata.size) throw new RemoteSyncError("SYNC_STREAM_INVALID");
    state.files = nextFiles;
    state.bytes = actualBytes;
    output.push({
      path,
      content_kind: classified.content_kind,
      content_hash: contentHash(bytes),
      size: bytes.byteLength,
      content: new Uint8Array(bytes)
    });
  }
  return output.sort((left, right) => left.path.localeCompare(right.path));
}

function errorFromResponse(value: unknown, fallback: string): RemoteSyncError {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const error = (value as { error?: unknown }).error;
    if (error !== null && typeof error === "object" && !Array.isArray(error)) {
      const code = (error as { code?: unknown }).code;
      const parsed = remoteSyncHttpErrorCodeSchema.safeParse(code);
      if (parsed.success && (parsed.data === "REMOTE_UNAVAILABLE" ||
          parsed.data.startsWith("SYNC_") || parsed.data.startsWith("ARCHIVE_"))) {
        return new RemoteSyncError(parsed.data as ConstructorParameters<typeof RemoteSyncError>[0]);
      }
      // Surface unrecognized server codes so protocol drift (e.g. VALIDATION_FAILED
      // from an overly strict query schema) is not flattened to an opaque
      // REMOTE_UNAVAILABLE. The fallback code drives retry/exit semantics; the
      // serverCode is diagnostic only.
      if (typeof code === "string" && code.length > 0) {
        return new RemoteSyncError(fallback as never, false, code);
      }
    }
  }
  return new RemoteSyncError(fallback as never);
}

async function readBoundedResponseJson(response: Response): Promise<unknown> {
  const debug = process.env.HUNTER_DEBUG_HTTP === "1";
  const fail = (where: string): never => {
    if (debug) console.error(`[hunter-http] readBoundedResponseJson fail @ ${where}`);
    throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
  };
  const lengthHeader = response.headers.get("Content-Length");
  let declaredLength: number | undefined;
  if (lengthHeader !== null) {
    if (!/^(0|[1-9][0-9]*)$/u.test(lengthHeader)) {
      return fail(`content-length format (${lengthHeader})`);
    }
    declaredLength = Number(lengthHeader);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > MAX_WORKSPACE_BYTES) {
      return fail(`content-length range (${declaredLength})`);
    }
  }
  if (response.body === null) {
    if (declaredLength !== undefined && declaredLength !== 0) {
      return fail(`null body with declared ${declaredLength}`);
    }
    return fail("null body");
  }
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    return fail("getReader");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let chunkCount = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) {
        return fail("non-uint8 chunk");
      }
      chunkCount += 1;
      total += next.value.byteLength;
      if (!Number.isSafeInteger(total) || total > MAX_WORKSPACE_BYTES ||
          chunkCount > MAX_JSON_STREAM_CHUNKS) {
        await reader.cancel().catch(() => undefined);
        return fail(`size/cnt (total=${total}, chunks=${chunkCount})`);
      }
      chunks.push(new Uint8Array(next.value));
    }
  } catch (error) {
    if (error instanceof RemoteSyncError) throw error;
    await reader.cancel().catch(() => undefined);
    if (debug) console.error(`[hunter-http] read loop err: ` + (error instanceof Error ? error.message : String(error)));
    throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
  } finally {
    try { reader.releaseLock(); } catch { /* fail closed above; release is best effort */ }
  }
  if (declaredLength !== undefined && declaredLength !== total) {
    // Content-Length is the transferred (possibly compressed) byte count. When
    // the server applies Content-Encoding (e.g. gzip via Caddy), fetch hands us
    // the decoded bytes whose length legitimately differs. Only enforce the
    // equality when no content encoding was applied.
    const contentEncoding = response.headers.get("Content-Encoding");
    const encoded = contentEncoding !== null && contentEncoding.toLowerCase() !== "identity";
    if (!encoded) {
      return fail(`length mismatch declared=${declaredLength} actual=${total}`);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (bytes.byteLength === 0) return fail("empty body");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return fail("json parse");
  }
}

function resultReceipt(value: RemoteSyncPushReceiptHttp): SyncReceipt {
  return {
    preview_hash: value.preview_hash,
    ...(value.project_version === null ? {} : { project_version: value.project_version }),
    ...(value.artifact_id === null ? {} : { artifact_id: value.artifact_id }),
    no_changes: value.no_changes,
    applied: [...value.applied],
    skipped: [...value.skipped],
    retryable: [...value.retryable]
  };
}

function sameOperations(left: readonly unknown[], right: readonly unknown[]): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function preparedPushMatches(
  value: RemoteSyncPreparedPushHttp,
  source: RemoteSyncSourceRef,
  lease: RemoteSyncLease,
  command: PushCommit,
  payloadHash: string
): boolean {
  return sameHttpSource(value.source, source) &&
    value.lease_id === lease.lease_id &&
    value.lease_token === lease.lease_token &&
    value.lease_generation === lease.generation &&
    value.expected_revision === command.expected_revision &&
    value.preview_hash === command.preview_hash &&
    value.idempotency_key === command.idempotency_key &&
    value.payload_hash === payloadHash &&
    value.state === "prepared";
}

function pushReceiptMatches(
  value: RemoteSyncPushReceiptHttp,
  source: RemoteSyncSourceRef,
  prepareId: string,
  command: PushCommit,
  payloadHash: string,
  manifestHash: string
): boolean {
  return value.prepare_id === prepareId &&
    sameHttpSource(value.source, source) &&
    value.idempotency_key === command.idempotency_key &&
    value.payload_hash === payloadHash &&
    value.preview_hash === command.preview_hash &&
    value.manifest_hash === manifestHash &&
    value.commit_sha === (source.commit_sha ?? null) &&
    sameOperations(value.applied, command.operations) &&
    sameOperations(value.skipped, command.skipped) &&
    value.retryable.length === 0;
}

function pullReceipt(command: PullCommit): SyncReceipt {
  return {
    preview_hash: command.preview_hash,
    ...(command.project_version === undefined ? {} : { project_version: command.project_version }),
    ...(command.artifact_id === undefined ? {} : { artifact_id: command.artifact_id }),
    no_changes: command.operations.length === 0,
    applied: [...command.operations],
    skipped: [...command.skipped],
    retryable: []
  };
}

function pullTransactionId(
  source: RemoteSyncSourceRef,
  idempotencyKey: string
): string {
  const transactionKey = canonicalIdentityHash({
    schema_version: 1,
    operation: "remote_sync_pull_workspace",
    source_ref: normalizeHttpSource(source),
    idempotency_key: idempotencyKey
  });
  return `tx_remote_pull_${transactionKey.slice("sha256:".length)}`;
}

function pullIdentity(
  source: RemoteSyncSourceRef,
  command: PullCommit,
  manifestHash: string,
  baselineManifestHash: string
): { readonly transactionId: string; readonly projectIdentity: string; readonly identityHash: string } {
  const identityHash = canonicalIdentityHash({
    schema_version: 1,
    operation: "remote_sync_pull_workspace",
    source_ref: normalizeHttpSource(source),
    expected_revision: command.expected_revision,
    preview_hash: command.preview_hash,
    idempotency_key: command.idempotency_key,
    payload_hash: command.payload_hash,
    manifest_hash: manifestHash,
    baseline_manifest_hash: baselineManifestHash,
    operations: command.operations,
    skipped: command.skipped,
    project_version: command.project_version ?? null,
    artifact_id: command.artifact_id ?? null
  });
  const receipt = pullReceipt(command);
  return {
    transactionId: pullTransactionId(source, command.idempotency_key),
    projectIdentity: canonicalJson({
      schema_version: 2,
      record_kind: "remote_sync_pull_transaction",
      source_ref: normalizeHttpSource(source),
      direction: "pull",
      idempotency_key: command.idempotency_key,
      payload_hash: command.payload_hash,
      identity_hash: identityHash,
      expected_revision: command.expected_revision,
      manifest_hash: manifestHash,
      baseline_manifest_hash: baselineManifestHash,
      receipt
    }),
    identityHash
  };
}

async function readBoundedJson(path: string, maxBytes: number): Promise<unknown | null> {
  let metadata;
  try {
    metadata = await stat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  if (!metadata.isFile() || !Number.isSafeInteger(metadata.size) || metadata.size > maxBytes) {
    throw new RemoteSyncError("SYNC_PULL_WORKSPACE_FAILED");
  }
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new RemoteSyncError("SYNC_PULL_WORKSPACE_FAILED");
  }
}

function pathWithin(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

async function assertContainedExistingPath(root: string, candidate: string): Promise<boolean> {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (!pathWithin(resolvedRoot, resolvedCandidate)) {
    throw new RemoteSyncError("SYNC_PULL_WORKSPACE_FAILED");
  }
  let rootReal: string;
  try {
    rootReal = await realpath(resolvedRoot);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
  const child = relative(resolvedRoot, resolvedCandidate);
  let cursor = resolvedRoot;
  for (const segment of child === "" ? [] : child.split(sep)) {
    cursor = join(cursor, segment);
    let metadata;
    try {
      metadata = await lstat(cursor);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
    if (metadata.isSymbolicLink()) throw new RemoteSyncError("SYNC_PULL_WORKSPACE_FAILED");
  }
  const candidateReal = await realpath(resolvedCandidate);
  if (!pathWithin(rootReal, candidateReal)) {
    throw new RemoteSyncError("SYNC_PULL_WORKSPACE_FAILED");
  }
  return true;
}

async function readContainedBoundedJson(
  root: string,
  path: string,
  maxBytes: number
): Promise<unknown | null> {
  if (!(await assertContainedExistingPath(root, path))) return null;
  const value = await readBoundedJson(path, maxBytes);
  if (value !== null && !(await assertContainedExistingPath(root, path))) {
    throw new RemoteSyncError("SYNC_PULL_WORKSPACE_FAILED");
  }
  return value;
}

const PULL_RECOVERABLE_STATES = new Set([
  "interrupted",
  "applying",
  "prepared",
  "recovery_required"
]);

function validatedPullJournal(
  value: unknown,
  expected: {
    readonly transactionId: string;
    readonly projectIdentity: string;
    readonly targetBundleVersion: string;
    readonly ownershipManifestHash: string;
    readonly operations: readonly TransactionOperation[];
  }
): TransactionJournal {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RemoteSyncError("SYNC_PULL_WORKSPACE_FAILED");
  }
  const journal = value as TransactionJournal;
  const roots = journal.protected_local_roots;
  if (journal.schema_version !== 3 ||
      journal.transaction_id !== expected.transactionId ||
      journal.recovery_id !== expected.transactionId ||
      journal.project_identity !== expected.projectIdentity ||
      journal.target_bundle_version !== expected.targetBundleVersion ||
      journal.ownership_manifest_hash !== expected.ownershipManifestHash ||
      journal.kind !== undefined || journal.cli_version !== null ||
      typeof journal.created_at !== "string" || journal.created_at.length > 64 ||
      typeof journal.updated_at !== "string" || journal.updated_at.length > 64 ||
      !Array.isArray(journal.operations) || !Array.isArray(journal.snapshots) ||
      !Number.isSafeInteger(journal.applied_count) || journal.applied_count < 0 ||
      (journal.failure !== null && typeof journal.failure !== "string") ||
      typeof journal.plan_hash !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(journal.plan_hash) ||
      typeof journal.snapshot_digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(journal.snapshot_digest) ||
      !Array.isArray(journal.completed_operations) || !Array.isArray(journal.pending_operations) ||
      !Array.isArray(journal.completed_target_states) || !Array.isArray(journal.verification_outcomes) ||
      !journal.verification_outcomes.every((outcome) =>
        outcome !== null && typeof outcome === "object" && !Array.isArray(outcome) &&
        typeof outcome.name === "string" &&
        (outcome.status === "passed" || outcome.status === "failed")) ||
      roots === undefined || roots === null || typeof roots !== "object" ||
      !Array.isArray(roots.before) || !Array.isArray(roots.after) ||
      typeof roots.unchanged !== "boolean" ||
      (journal.state !== "committed" && !PULL_RECOVERABLE_STATES.has(journal.state))) {
    throw new RemoteSyncError("SYNC_PULL_WORKSPACE_FAILED");
  }
  try {
    assertJournalCheckpoint(journal);
    const expectedPlanHash = transactionPlanHash(expected.operations, {
      projectIdentity: expected.projectIdentity,
      targetBundleVersion: expected.targetBundleVersion,
      ownershipManifestHash: expected.ownershipManifestHash
    }, roots.before);
    if (transactionJournalPlanHash(journal) !== journal.plan_hash ||
        expectedPlanHash !== journal.plan_hash) {
      throw new Error("Pull recovery plan does not match the command");
    }
  } catch {
    throw new RemoteSyncError("SYNC_PULL_WORKSPACE_FAILED");
  }
  if (journal.state === "committed" &&
      (journal.failure !== null || journal.applied_count !== journal.operations.length ||
        journal.pending_operations.length !== 0 || journal.completed_operations.length !== journal.operations.length ||
        !roots.unchanged || !journal.verification_outcomes.some((outcome) =>
          outcome.name === "protected-local-roots" && outcome.status === "passed"))) {
    throw new RemoteSyncError("SYNC_PULL_WORKSPACE_FAILED");
  }
  return journal;
}

function receiptTransactionId(idempotencyKey: string): string {
  if (!SHA256.test(idempotencyKey)) {
    throw new RemoteSyncError("SYNC_IDEMPOTENCY_CONFLICT");
  }
  return `${RECEIPT_TRANSACTION_PREFIX}${canonicalIdentityHash({
    schema_version: 1,
    record_kind: RECEIPT_RECORD_KIND,
    idempotency_key: idempotencyKey
  }).slice("sha256:".length)}`;
}

function receiptOwnershipHash(idempotencyKey: string, payloadHash: string): string {
  return canonicalIdentityHash({
    schema_version: 1,
    record_kind: RECEIPT_RECORD_KIND,
    idempotency_key: idempotencyKey,
    payload_hash: payloadHash
  });
}

async function readDurableReceiptTransaction(
  workspaceRoot: string,
  transactionId: string
): Promise<StoredReceipt | null> {
  const journalPath = join(
    workspaceRoot,
    ".harness",
    "state",
    "transactions",
    transactionId,
    "journal.json"
  );
  const raw = await readContainedBoundedJson(workspaceRoot, journalPath, MAX_WORKSPACE_BYTES);
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw) || raw === null ||
      Object.getPrototypeOf(raw) !== Object.prototype) {
    throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
  }
  const projectIdentity = (raw as Record<string, unknown>).project_identity;
  if (typeof projectIdentity !== "string" || projectIdentity.length > MAX_WORKSPACE_BYTES) {
    throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
  }
  let parsedIdentity: unknown;
  try {
    parsedIdentity = JSON.parse(projectIdentity) as unknown;
  } catch {
    throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
  }
  const record = validatedStoredReceiptRecord(parsedIdentity);
  if (receiptTransactionId(record.idempotency_key) !== transactionId) {
    throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
  }
  let journal: TransactionJournal;
  try {
    journal = validatedPullJournal(raw, {
      transactionId,
      projectIdentity: canonicalJson(record),
      targetBundleVersion: record.payload_hash,
      ownershipManifestHash: receiptOwnershipHash(record.idempotency_key, record.payload_hash),
      operations: []
    });
  } catch {
    throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
  }
  if (journal.state !== "committed") return null;
  return record;
}

async function readDurableReceiptRecord(
  workspaceRoot: string,
  source: SourceRef,
  direction: SyncDirection,
  idempotencyKey: string,
  payloadHash: string
): Promise<StoredReceipt | null> {
  const record = await readDurableReceiptTransaction(
    workspaceRoot,
    receiptTransactionId(idempotencyKey)
  );
  if (record === null) return null;
  if (record.idempotency_key !== idempotencyKey) {
    throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
  }
  if (record.payload_hash !== payloadHash) {
    throw new RemoteSyncError("SYNC_IDEMPOTENCY_CONFLICT");
  }
  if (record.direction !== direction || !sameSource(record.source_ref, source)) {
    throw new RemoteSyncError("SYNC_IDEMPOTENCY_CONFLICT");
  }
  return record;
}

async function readDurablePullTransactionReceipt(
  workspaceRoot: string,
  source: RemoteSyncSourceRef,
  idempotencyKey: string,
  payloadHash: string
): Promise<SyncReceipt | null> {
  const transactionId = pullTransactionId(source, idempotencyKey);
  const raw = await readContainedBoundedJson(
    workspaceRoot,
    join(workspaceRoot, ".harness", "state", "transactions", transactionId, "journal.json"),
    MAX_WORKSPACE_BYTES
  );
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) {
    throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
  }
  const journal = raw as TransactionJournal;
  const protectedRoots = journal.protected_local_roots as unknown;
  const verificationOutcomes = journal.verification_outcomes as unknown;
  const protectedRootsUnchanged = protectedRoots !== null && typeof protectedRoots === "object" &&
    !Array.isArray(protectedRoots) &&
    (protectedRoots as { readonly unchanged?: unknown }).unchanged === true;
  const protectedRootsCheckPassed = Array.isArray(verificationOutcomes) &&
    verificationOutcomes.some((outcome) => {
      if (outcome === null || typeof outcome !== "object" || Array.isArray(outcome)) return false;
      const candidate = outcome as { readonly name?: unknown; readonly status?: unknown };
      return candidate.name === "protected-local-roots" && candidate.status === "passed";
    });
  if (journal.transaction_id !== transactionId || journal.recovery_id !== transactionId ||
      journal.state !== "committed" || journal.kind !== undefined || journal.cli_version !== null ||
      journal.failure !== null || typeof journal.project_identity !== "string" ||
      journal.project_identity.length > MAX_WORKSPACE_BYTES || !Array.isArray(journal.operations) ||
      !Array.isArray(journal.pending_operations) || !Array.isArray(journal.completed_operations) ||
      !Array.isArray(journal.verification_outcomes) || journal.pending_operations.length !== 0 ||
      journal.completed_operations.length !== journal.operations.length ||
      journal.applied_count !== journal.operations.length || !protectedRootsUnchanged ||
      !protectedRootsCheckPassed) {
    throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
  }
  let identity: unknown;
  try {
    identity = JSON.parse(journal.project_identity) as unknown;
    assertJournalCheckpoint(journal);
    if (transactionJournalPlanHash(journal) !== journal.plan_hash) throw new Error("plan hash drift");
  } catch {
    throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
  }
  if (identity === null || typeof identity !== "object" || Array.isArray(identity) ||
      Object.getPrototypeOf(identity) !== Object.prototype) {
    throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
  }
  const value = identity as Record<string, unknown>;
  if (!exactObjectKeys(value, [
    "schema_version", "record_kind", "source_ref", "direction", "idempotency_key",
    "payload_hash", "identity_hash", "expected_revision", "manifest_hash",
    "baseline_manifest_hash", "receipt"
  ]) || value.schema_version !== 2 || value.record_kind !== "remote_sync_pull_transaction" ||
      value.direction !== "pull" || value.idempotency_key !== idempotencyKey ||
      typeof value.payload_hash !== "string" || !SHA256.test(value.payload_hash) ||
      typeof value.identity_hash !== "string" || !SHA256.test(value.identity_hash) ||
      typeof value.expected_revision !== "string" || value.expected_revision.length > 160 ||
      typeof value.manifest_hash !== "string" || !SHA256.test(value.manifest_hash) ||
      typeof value.baseline_manifest_hash !== "string" || !SHA256.test(value.baseline_manifest_hash) ||
      value.source_ref === null || typeof value.source_ref !== "object" || Array.isArray(value.source_ref)) {
    throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
  }
  if (value.payload_hash !== payloadHash) throw new RemoteSyncError("SYNC_IDEMPOTENCY_CONFLICT");
  const storedSource = value.source_ref as RemoteSyncSourceRef;
  if (!sameHttpSource(storedSource, source)) throw new RemoteSyncError("SYNC_IDEMPOTENCY_CONFLICT");
  const receipt = validatedStoredReceipt(value.receipt);
  const expectedIdentityHash = canonicalIdentityHash({
    schema_version: 1,
    operation: "remote_sync_pull_workspace",
    source_ref: normalizeHttpSource(source),
    expected_revision: value.expected_revision,
    preview_hash: receipt.preview_hash,
    idempotency_key: idempotencyKey,
    payload_hash: payloadHash,
    manifest_hash: value.manifest_hash,
    baseline_manifest_hash: value.baseline_manifest_hash,
    operations: receipt.applied,
    skipped: receipt.skipped,
    project_version: receipt.project_version ?? null,
    artifact_id: receipt.artifact_id ?? null
  });
  if (value.identity_hash !== expectedIdentityHash ||
      journal.project_identity !== canonicalJson(value) ||
      journal.target_bundle_version !== value.expected_revision ||
      journal.ownership_manifest_hash !== value.manifest_hash) {
    throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
  }
  return receipt;
}

async function readDurableReceiptStatus(
  workspaceRoot: string,
  source: SourceRef
): Promise<SyncStatus> {
  const transactionRoot = join(workspaceRoot, ".harness", "state", "transactions");
  let directory;
  try {
    directory = await opendir(transactionRoot);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { source_ref: source };
    }
    throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
  }
  const records: StoredReceipt[] = [];
  let seen = 0;
  try {
    for await (const entry of directory) {
      seen += 1;
      if (seen > MAX_WORKSPACE_FILES) {
        throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
      }
      if (!entry.isDirectory() || !entry.name.startsWith(RECEIPT_TRANSACTION_PREFIX)) continue;
      const record = await readDurableReceiptTransaction(workspaceRoot, entry.name);
      if (record !== null && sameSource(record.source_ref, source)) records.push(record);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  records.sort((left, right) =>
    right.stored_at.localeCompare(left.stored_at) ||
    right.idempotency_key.localeCompare(left.idempotency_key));
  return {
    source_ref: source,
    ...(records.find((record) => record.direction === "push")?.receipt === undefined ? {} : {
      last_push: structuredClone(records.find((record) => record.direction === "push")?.receipt)
    }),
    ...(records.find((record) => record.direction === "pull")?.receipt === undefined ? {} : {
      last_pull: structuredClone(records.find((record) => record.direction === "pull")?.receipt)
    })
  };
}

async function storeDurableReceiptRecord(
  workspaceRoot: string,
  source: SourceRef,
  direction: SyncDirection,
  idempotencyKey: string,
  payloadHash: string,
  receipt: SyncReceipt
): Promise<void> {
  const prior = await readDurableReceiptRecord(
    workspaceRoot,
    source,
    direction,
    idempotencyKey,
    payloadHash
  );
  if (prior !== null) {
    if (canonicalJson(prior.receipt) !== canonicalJson(receipt)) {
      throw new RemoteSyncError("SYNC_IDEMPOTENCY_CONFLICT");
    }
    return;
  }
  const record = validatedStoredReceiptRecord({
    schema_version: 1,
    record_kind: RECEIPT_RECORD_KIND,
    source_ref: { ...source },
    direction,
    idempotency_key: idempotencyKey,
    payload_hash: payloadHash,
    stored_at: new Date().toISOString(),
    receipt: structuredClone(receipt)
  });
  await runTransaction(workspaceRoot, [], {
    id: receiptTransactionId(idempotencyKey),
    projectIdentity: canonicalJson(record),
    targetBundleVersion: payloadHash,
    ownershipManifestHash: receiptOwnershipHash(idempotencyKey, payloadHash)
  });
  const written = await readDurableReceiptRecord(
    workspaceRoot,
    source,
    direction,
    idempotencyKey,
    payloadHash
  );
  if (written === null || canonicalJson(written.receipt) !== canonicalJson(record.receipt)) {
    throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
  }
}

export function createRemoteSyncHttpPort(options: RemoteSyncHttpPortOptions): RemoteSyncPort {
  const fetcher = options.fetch ?? globalThis.fetch;
  const base = options.serverUrl.replace(/\/$/u, "");
  const leases = new Map<string, RemoteSyncLease>();
  const workspaceFileIo: WorkspaceFileIo = {
    entries: options.readWorkspaceEntries ?? readWorkspaceEntries,
    stat: options.statWorkspaceFile ?? (async (path) => {
      const metadata = await stat(path);
      return { size: metadata.size };
    }),
    read: options.readWorkspaceFile ?? (async (path) =>
      readWorkspaceFileFromContainedHandle(options.workspaceRoot, path))
  };

  async function assertPullLocalHashes(
    operations: readonly PullCommit["operations"][number][]
  ): Promise<void> {
    for (const operation of operations) {
      if (operation.action === "no_change" || operation.local_hash === undefined) continue;
      const operationPath = operation.action === "rename"
        ? operation.source_path
        : operation.path;
      if (operationPath === undefined) throw new RemoteSyncError("SYNC_CONTENT_INVALID");
      const absolute = join(options.workspaceRoot, safeRelative(operationPath));
      let metadata: { readonly size: number };
      try {
        metadata = await workspaceFileIo.stat(absolute);
      } catch {
        throw new RemoteSyncError("SYNC_PREVIEW_STALE");
      }
      if (!Number.isSafeInteger(metadata.size) || metadata.size < 0 ||
          metadata.size > remoteSyncHttpMaxFileBytes) {
        throw new RemoteSyncError("SYNC_PREVIEW_STALE");
      }
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await workspaceFileIo.read(absolute));
      } catch {
        throw new RemoteSyncError("SYNC_PREVIEW_STALE");
      }
      if (bytes.byteLength !== metadata.size || contentHash(bytes) !== operation.local_hash) {
        throw new RemoteSyncError("SYNC_PREVIEW_STALE");
      }
    }
  }

  async function request(path: string, init: RequestInit & { json?: unknown } = {}): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${options.token}`);
    headers.set("Accept", "application/json");
    const { json: _json, body: existingBody, ...requestInit } = init;
    void _json;
    let body = existingBody;
    if (init.json !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(init.json);
    }
    let response: Response;
    try {
      response = await fetcher(base + path, {
        ...requestInit,
        headers,
        ...(body === undefined ? {} : { body })
      });
    } catch (error) {
      if (error instanceof RemoteSyncError) throw error;
      throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
    }
    if (process.env.HUNTER_DEBUG_HTTP === "1") {
      console.error(`[hunter-http] ${init.method ?? "GET"} ${path} → ${response.status}`);
    }
    let value: unknown;
    try {
      value = await readBoundedResponseJson(response);
    } catch (error) {
      if (process.env.HUNTER_DEBUG_HTTP === "1") {
        console.error(`[hunter-http] body read failed for ${path}: ` + (error instanceof Error ? error.message : String(error)));
      }
      throw error;
    }
    if (!response.ok) throw errorFromResponse(value, "REMOTE_UNAVAILABLE");
    return value;
  }

  async function readRemotePushReceipt(
    localSource: SourceRef,
    idempotencyKey: string,
    payloadHash: string
  ): Promise<SyncReceipt | null> {
    const source = httpSource(localSource, options.actorId);
    const query = new URLSearchParams({ idempotency_key: idempotencyKey });
    if (source.commit_sha !== undefined) query.set("commit_sha", source.commit_sha);
    if (source.client_id !== undefined) query.set("client_id", source.client_id);
    if (source.change_key !== undefined) query.set("change_key", source.change_key);
    let raw: unknown;
    try {
      raw = await request(`/api/v1/projects/${pathSegment(source.project_id)}/branches/${pathSegment(source.branch_name)}/remote-sync/push/status?${query.toString()}`);
    } catch (error) {
      if (error instanceof RemoteSyncError && error.code === "SYNC_PREPARE_NOT_FOUND") return null;
      throw error;
    }
    const parsed = remoteSyncPushStatusHttpResponseSchema.safeParse(raw);
    if (!parsed.success || parsed.data.idempotency_key !== idempotencyKey ||
        parsed.data.payload_hash !== payloadHash || !sameHttpSource(parsed.data.source, source)) {
      throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
    }
    if (parsed.data.state !== "committed") return null;
    let receipt = parsed.data.receipt;
    if (receipt === undefined) {
      const receiptQuery = new URLSearchParams();
      if (source.commit_sha !== undefined) receiptQuery.set("commit_sha", source.commit_sha);
      if (source.client_id !== undefined) receiptQuery.set("client_id", source.client_id);
      if (source.change_key !== undefined) receiptQuery.set("change_key", source.change_key);
      const receiptRaw = await request(`/api/v1/projects/${pathSegment(source.project_id)}/branches/${pathSegment(source.branch_name)}/remote-sync/push/${pathSegment(parsed.data.prepare_id)}/receipt?${receiptQuery.toString()}`);
      const receiptResult = remoteSyncPushCommitHttpResponseSchema.safeParse(receiptRaw);
      if (!receiptResult.success || receiptResult.data.outcome === "conflict") {
        throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
      }
      receipt = receiptResult.data.value;
    }
    if (receipt.prepare_id !== parsed.data.prepare_id ||
        receipt.idempotency_key !== idempotencyKey || receipt.payload_hash !== payloadHash ||
        !sameHttpSource(receipt.source, source)) {
      throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
    }
    return resultReceipt(receipt);
  }

  async function binary(path: string, maxBytes: number): Promise<Uint8Array> {
    const headers = new Headers({ Authorization: `Bearer ${options.token}` });
    let response: Response;
    try {
      response = await fetcher(base + path, { headers });
    } catch (error) {
      if (error instanceof RemoteSyncError) throw error;
      throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
    }
    if (!response.ok) {
      const value = await readBoundedResponseJson(response);
      throw errorFromResponse(value, "REMOTE_UNAVAILABLE");
    }
    if (process.env.HUNTER_DEBUG_HTTP === "1") {
      console.error(`[hunter-http] GET(binary) ${path} → ${response.status}`);
    }
    const lengthHeader = response.headers.get("Content-Length");
    let declaredLength: number | undefined;
    if (lengthHeader !== null) {
      if (!/^(0|[1-9][0-9]*)$/u.test(lengthHeader)) {
        throw new RemoteSyncError("SYNC_STREAM_INVALID");
      }
      declaredLength = Number(lengthHeader);
      if (!Number.isSafeInteger(declaredLength) || declaredLength > maxBytes) {
        throw new RemoteSyncError("SYNC_STREAM_TOO_LARGE");
      }
    }
    if (response.body === null) {
      if (declaredLength !== undefined && declaredLength !== 0) {
        throw new RemoteSyncError("SYNC_STREAM_INVALID");
      }
      return new Uint8Array(0);
    }
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      reader = response.body.getReader();
    } catch {
      throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    let chunkCount = 0;
    let streamError: RemoteSyncError | undefined;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        chunkCount += 1;
        if (chunkCount > MAX_BINARY_STREAM_CHUNKS) {
          await reader.cancel().catch(() => undefined);
          throw new RemoteSyncError("SYNC_STREAM_TOO_LARGE");
        }
        const chunk = new Uint8Array(item.value);
        total += chunk.byteLength;
        if (!Number.isSafeInteger(total) || total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new RemoteSyncError("SYNC_STREAM_TOO_LARGE");
        }
        chunks.push(chunk);
      }
    } catch (error) {
      streamError = error instanceof RemoteSyncError
        ? error
        : new RemoteSyncError("REMOTE_UNAVAILABLE", true);
    }
    try {
      reader.releaseLock();
    } catch {
      streamError ??= new RemoteSyncError("REMOTE_UNAVAILABLE", true);
    }
    if (streamError !== undefined) throw streamError;
    if (declaredLength !== undefined && total !== declaredLength) {
      throw new RemoteSyncError("SYNC_STREAM_INVALID");
    }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }

  async function readRemoteFiles(source: SourceRef, snapshot: {
    revision: string;
    snapshot_id: string;
    files: readonly { path: string; content_hash: string; size: number; content_kind?: string | undefined }[];
  }): Promise<ContentFile[]> {
    if (snapshot.files.length > MAX_WORKSPACE_FILES) {
      throw new RemoteSyncError("SYNC_STREAM_TOO_LARGE");
    }
    let declaredTotal = 0;
    const paths = new Set<string>();
    for (const metadata of snapshot.files) {
      const path = safeRelative(metadata.path);
      if (path !== metadata.path || path.split("/").length - 1 > MAX_WORKSPACE_DEPTH || paths.has(path)) {
        throw new RemoteSyncError("SYNC_CONTENT_INVALID");
      }
      paths.add(path);
      declaredTotal += metadata.size;
      if (!Number.isSafeInteger(metadata.size) || metadata.size < 0 ||
          metadata.size > remoteSyncHttpMaxFileBytes ||
          !Number.isSafeInteger(declaredTotal) || declaredTotal > MAX_WORKSPACE_BYTES) {
        throw new RemoteSyncError("SYNC_STREAM_TOO_LARGE");
      }
    }
    const files: ContentFile[] = [];
    let actualTotal = 0;
    for (const metadata of snapshot.files) {
      const bytes = await binary(`/api/v1/projects/${pathSegment(source.project_id)}/branches/${pathSegment(source.branch_name)}/remote-sync/snapshots/${pathSegment(snapshot.snapshot_id)}/content?path=${encodeURIComponent(metadata.path)}&expected_revision=${encodeURIComponent(snapshot.revision)}&chunk_size=1048576`, metadata.size);
      if (bytes.byteLength !== metadata.size || contentHash(bytes) !== metadata.content_hash) {
        throw new RemoteSyncError("SYNC_STREAM_INVALID");
      }
      actualTotal += bytes.byteLength;
      if (!Number.isSafeInteger(actualTotal) || actualTotal > MAX_WORKSPACE_BYTES) {
        throw new RemoteSyncError("SYNC_STREAM_TOO_LARGE");
      }
      const file = toContentFile(metadata.path, bytes);
      if (file === undefined || (metadata.content_kind !== undefined && file.content_kind !== metadata.content_kind)) {
        throw new RemoteSyncError("SYNC_CONTENT_INVALID");
      }
      files.push(file);
    }
    return files;
  }

  async function reconcilePushReceipt(
    source: RemoteSyncSourceRef,
    prepared: RemoteSyncPreparedPushHttp,
    command: PushCommit,
    payloadHash: string,
    manifestHash: string
  ): Promise<RemoteSyncPushReceiptHttp> {
    const statusQuery = new URLSearchParams({ idempotency_key: command.idempotency_key });
    if (source.commit_sha !== undefined) statusQuery.set("commit_sha", source.commit_sha);
    if (source.client_id !== undefined) statusQuery.set("client_id", source.client_id);
    if (source.change_key !== undefined) statusQuery.set("change_key", source.change_key);
    const statusRaw = await request(`/api/v1/projects/${pathSegment(source.project_id)}/branches/${pathSegment(source.branch_name)}/remote-sync/push/status?${statusQuery.toString()}`);
    const statusResult = remoteSyncPushStatusHttpResponseSchema.safeParse(statusRaw);
    if (!statusResult.success || statusResult.data.state !== "committed" ||
        statusResult.data.prepare_id !== prepared.prepare_id ||
        statusResult.data.idempotency_key !== command.idempotency_key ||
        statusResult.data.payload_hash !== payloadHash ||
        !sameHttpSource(statusResult.data.source, source)) {
      throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
    }
    if (statusResult.data.receipt !== undefined) {
      if (!pushReceiptMatches(
        statusResult.data.receipt,
        source,
        prepared.prepare_id,
        command,
        payloadHash,
        manifestHash
      )) {
        throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
      }
      return statusResult.data.receipt;
    }
    const receiptQuery = new URLSearchParams();
    if (source.commit_sha !== undefined) receiptQuery.set("commit_sha", source.commit_sha);
    if (source.client_id !== undefined) receiptQuery.set("client_id", source.client_id);
    if (source.change_key !== undefined) receiptQuery.set("change_key", source.change_key);
    const receiptRaw = await request(`/api/v1/projects/${pathSegment(source.project_id)}/branches/${pathSegment(source.branch_name)}/remote-sync/push/${pathSegment(prepared.prepare_id)}/receipt?${receiptQuery.toString()}`);
    const receiptResult = remoteSyncPushCommitHttpResponseSchema.safeParse(receiptRaw);
    if (!receiptResult.success || receiptResult.data.outcome === "conflict" ||
        !pushReceiptMatches(
          receiptResult.data.value,
          source,
          prepared.prepare_id,
          command,
          payloadHash,
          manifestHash
        )) {
      throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
    }
    return receiptResult.data.value;
  }

  function pullTransactionOperations(command: PullCommit): TransactionOperation[] {
    const files = new Map<string, ContentFile>();
    const foldedFiles = new Set<string>();
    let totalBytes = 0;
    if (command.files.length > MAX_WORKSPACE_FILES || command.baseline_files.length > MAX_WORKSPACE_FILES ||
        command.operations.length + command.skipped.length > MAX_WORKSPACE_FILES) {
      throw new RemoteSyncError("SYNC_STREAM_TOO_LARGE");
    }
    for (const file of command.files) {
      const path = safeRelative(file.path);
      const folded = path.toLocaleLowerCase("en-US");
      if (path !== file.path || files.has(path) || foldedFiles.has(folded) ||
          path.split("/").length - 1 > MAX_WORKSPACE_DEPTH) {
        throw new RemoteSyncError("SYNC_CONTENT_INVALID");
      }
      foldedFiles.add(folded);
      totalBytes += file.size;
      if (!Number.isSafeInteger(file.size) || file.size < 0 ||
          file.size > remoteSyncHttpMaxFileBytes ||
          !Number.isSafeInteger(totalBytes) || totalBytes > MAX_WORKSPACE_BYTES) {
        throw new RemoteSyncError("SYNC_STREAM_TOO_LARGE");
      }
      const bytes = typeof file.content === "string"
        ? new TextEncoder().encode(file.content)
        : new Uint8Array(file.content);
      if (bytes.byteLength !== file.size || contentHash(bytes) !== file.content_hash) {
        throw new RemoteSyncError("SYNC_STREAM_INVALID");
      }
      files.set(path, file);
    }
    const foldedBaseline = new Set<string>();
    let baselineBytes = 0;
    for (const file of command.baseline_files) {
      const path = safeRelative(file.path);
      const folded = path.toLocaleLowerCase("en-US");
      if (path !== file.path || foldedBaseline.has(folded) ||
          path.split("/").length - 1 > MAX_WORKSPACE_DEPTH) {
        throw new RemoteSyncError("SYNC_CONTENT_INVALID");
      }
      foldedBaseline.add(folded);
      baselineBytes += file.size;
      if (!Number.isSafeInteger(file.size) || file.size < 0 ||
          file.size > remoteSyncHttpMaxFileBytes ||
          !Number.isSafeInteger(baselineBytes) || baselineBytes > MAX_WORKSPACE_BYTES) {
        throw new RemoteSyncError("SYNC_STREAM_TOO_LARGE");
      }
    }
    const outcomes = [...command.operations, ...command.skipped];
    const foldedOutcomes = new Set<string>();
    for (const operation of outcomes) {
      const path = safeRelative(operation.path);
      const folded = path.toLocaleLowerCase("en-US");
      if (path !== operation.path || foldedOutcomes.has(folded) ||
          path.split("/").length - 1 > MAX_WORKSPACE_DEPTH) {
        throw new RemoteSyncError("SYNC_CONTENT_INVALID");
      }
      foldedOutcomes.add(folded);
      if (operation.source_path !== undefined) {
        const sourcePath = safeRelative(operation.source_path);
        if (sourcePath !== operation.source_path ||
            sourcePath.split("/").length - 1 > MAX_WORKSPACE_DEPTH) {
          throw new RemoteSyncError("SYNC_CONTENT_INVALID");
        }
      }
    }
    const targets = new Set<string>();
    const transactionOperations: TransactionOperation[] = [];
    for (const operation of command.operations) {
      const path = safeRelative(operation.path);
      const folded = path.toLocaleLowerCase("en-US");
      if (path !== operation.path || targets.has(folded)) {
        throw new RemoteSyncError("SYNC_CONTENT_INVALID");
      }
      targets.add(folded);
      if (operation.action === "no_change") continue;
      if (operation.action === "delete") {
        if (files.has(path)) throw new RemoteSyncError("SYNC_CONTENT_INVALID");
        transactionOperations.push({ operation: "delete", path });
        continue;
      }
      const file = files.get(path);
      if (file === undefined || file.content_kind !== operation.content_kind) {
        throw new RemoteSyncError("SYNC_CONTENT_INVALID");
      }
      const bytes = typeof file.content === "string"
        ? new TextEncoder().encode(file.content)
        : new Uint8Array(file.content);
      if (operation.action === "rename") {
        if (operation.source_path === undefined) {
          throw new RemoteSyncError("SYNC_CONTENT_INVALID");
        }
        const sourcePath = safeRelative(operation.source_path);
        if (sourcePath !== operation.source_path || sourcePath === path || targets.has(sourcePath)) {
          throw new RemoteSyncError("SYNC_CONTENT_INVALID");
        }
        targets.add(sourcePath);
        transactionOperations.push({
          operation: "rename",
          from_path: sourcePath,
          to_path: path,
          content: bytes
        });
        continue;
      }
      transactionOperations.push({
        operation: operation.action === "add" ? "add" : "modify",
        path,
        content: bytes
      });
    }
    return transactionOperations;
  }

  return {
    async withProtocolLock<T>(source: SourceRef, work: () => Promise<T>): Promise<T> {
      const acquireIdempotencyKey = randomUUID();
      const releaseIdempotencyKey = randomUUID();
      const rawBody = await request(`/api/v1/projects/${pathSegment(source.project_id)}/branches/${pathSegment(source.branch_name)}/remote-sync/leases`, {
        method: "POST", headers: { "Idempotency-Key": acquireIdempotencyKey },
        json: { source: httpSource(source, options.actorId), ttl_ms: 600_000 }
      });
      const parsed = remoteSyncLeaseHttpResponseSchema.safeParse(rawBody);
      if (!parsed.success || !sameLeaseSource(parsed.data.lease, source, options.actorId)) {
        throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
      }
      const lease = parsed.data.lease;
      leases.set(sourceKey(source), lease);
      let workResult: T | undefined;
      let workError: unknown;
      let workFailed = false;
      try {
        workResult = await work();
      } catch (error) {
        workFailed = true;
        workError = error;
      }
      let releaseError: unknown;
      let releaseFailed = false;
      try {
        const released = await request(`/api/v1/projects/${pathSegment(source.project_id)}/branches/${pathSegment(source.branch_name)}/remote-sync/leases/${pathSegment(lease.lease_id)}:release`, {
          method: "POST", headers: { "Idempotency-Key": releaseIdempotencyKey }, json: { lease }
        });
        if (!remoteSyncLeaseReleaseHttpResponseSchema.safeParse(released).success) {
          throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
        }
      } catch (error) {
        releaseFailed = true;
        releaseError = error;
      }
      leases.delete(sourceKey(source));
      if (releaseFailed) throw releaseError;
      if (workFailed) throw workError;
      return workResult as T;
    },
    async readSyncView(source) {
      const http = httpSource(source, options.actorId);
      // Snapshot endpoint per OpenAPI only accepts `expected_revision`; actor/scope
      // are derived server-side from the auth principal. Older CLI builds sent
      // actor_id/commit_sha/client_id/change_key and got 400 VALIDATION_FAILED,
      // which was flattened to REMOTE_UNAVAILABLE. Keep the query empty.
      const snapshotResponse = await request(`/api/v1/projects/${pathSegment(source.project_id)}/branches/${pathSegment(source.branch_name)}/remote-sync/snapshot`) as { value?: unknown };
      let snapshot;
      try {
        snapshot = validateRemoteSyncRemoteSnapshot(snapshotResponse?.value ?? snapshotResponse);
      } catch (error) {
        if (error instanceof RemoteSyncError) throw error;
        throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
      }
      // Server returns the latest branch snapshot, not one filtered by the
      // caller's commit/client/change — only project/branch/actor identify the
      // scope, so restrict the equality check accordingly.
      if (snapshot.source.project_id !== http.project_id ||
          snapshot.source.branch_name !== http.branch_name ||
          snapshot.source.actor_id !== http.actor_id) {
        throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
      }
      const remoteFiles = await readRemoteFiles(source, snapshot);
      let localFiles: ContentFile[];
      try {
        localFiles = await walkFiles(options.workspaceRoot, workspaceFileIo);
      } catch (error) {
        if (process.env.HUNTER_DEBUG_HTTP === "1") {
          console.error("[hunter-http] walkFiles failed: " + (error instanceof Error ? error.message : String(error)));
          if (error instanceof RemoteSyncError) console.error("  code: " + error.code);
        }
        if (error instanceof RemoteSyncError) throw error;
        throw new RemoteSyncError("SYNC_PULL_WORKSPACE_FAILED", true);
      }
      return {
        revision: snapshot.revision,
        base_version: snapshot.project_version,
        baseline_files: remoteFiles,
        local_files: localFiles,
        remote_files: remoteFiles
      } satisfies SyncView;
    },
    async getIdempotentSyncReceipt(source, direction, idempotencyKey, payloadHash) {
      const prior = await readDurableReceiptRecord(
        options.workspaceRoot,
        source,
        direction,
        idempotencyKey,
        payloadHash
      );
      if (prior !== null) return structuredClone(prior.receipt);
      const recovered = direction === "pull"
        ? await readDurablePullTransactionReceipt(
            options.workspaceRoot,
            httpSource(source, options.actorId),
            idempotencyKey,
            payloadHash
          )
        : await readRemotePushReceipt(source, idempotencyKey, payloadHash);
      if (recovered === null) return null;
      await storeDurableReceiptRecord(
        options.workspaceRoot,
        source,
        direction,
        idempotencyKey,
        payloadHash,
        recovered
      );
      return structuredClone(recovered);
    },
    async storeIdempotentSyncReceipt(source, direction, idempotencyKey, payloadHash, receipt) {
      await storeDurableReceiptRecord(
        options.workspaceRoot,
        source,
        direction,
        idempotencyKey,
        payloadHash,
        receipt
      );
    },
    async getSyncStatus(source) {
      return readDurableReceiptStatus(options.workspaceRoot, source);
    },
    async commitPush(command: PushCommit) {
      const current = leases.get(sourceKey(command.source_ref));
      if (current === undefined) throw new RemoteSyncError("SYNC_LEASE_FENCED");
      const source = httpSource(command.source_ref, options.actorId);
      const files: RemoteSyncPushPrepareHttpRequest["files"] = [];
      for (const file of command.files) {
        const bytes = typeof file.content === "string" ? new TextEncoder().encode(file.content) : new Uint8Array(file.content);
        if (bytes.byteLength !== file.size || contentHash(bytes) !== file.content_hash) throw new RemoteSyncError("SYNC_STREAM_INVALID");
        if (bytes.byteLength === 0) {
          files.push({ path: file.path, content_hash: file.content_hash, size: 0, content_kind: file.content_kind });
          continue;
        }
        const uploadIdempotencyKey = fileUploadIdempotencyKey(source, command.idempotency_key, file);
        const upload = await request(`/api/v1/projects/${pathSegment(command.source_ref.project_id)}/branches/${pathSegment(command.source_ref.branch_name)}/remote-sync/file-upload`, {
          method: "POST",
          headers: {
            "Idempotency-Key": uploadIdempotencyKey,
            "Content-Type": "application/octet-stream",
            "Content-Length": String(bytes.byteLength),
            "X-Content-SHA256": file.content_hash,
            "X-Upload-Expires-In-Ms": "600000",
            ...(command.source_ref.commit_sha === undefined ? {} : { "X-Commit-SHA": command.source_ref.commit_sha }),
            ...(command.source_ref.client_id === undefined ? {} : { "X-Client-Id": command.source_ref.client_id }),
            ...(command.source_ref.change_key === undefined ? {} : { "X-Change-Key": command.source_ref.change_key })
          },
          body: bytes
        });
        const validatedUpload = validateRemoteContentUploadHttpResult(upload);
        if (!validatedUpload.success ||
            !sameHttpSource(validatedUpload.data.record.source, source) ||
            validatedUpload.data.record.idempotency_key !== uploadIdempotencyKey ||
            validatedUpload.data.record.purpose !== "remote_sync_file" ||
            validatedUpload.data.record.content_sha256 !== file.content_hash ||
            validatedUpload.data.record.size_bytes !== file.size) {
          throw new RemoteSyncError("REMOTE_UNAVAILABLE");
        }
        files.push({ path: file.path, content_hash: file.content_hash, size: file.size, content_kind: file.content_kind, upload_ref: validatedUpload.data.upload_ref });
      }
      const payloadHash = httpPayloadHash({
        source,
        expected_revision: command.expected_revision,
        preview_hash: command.preview_hash,
        idempotency_key: command.idempotency_key,
        files,
        operations: [...command.operations],
        skipped: [...command.skipped]
      });
      validateRemoteSyncPushMetadata({
        source,
        expected_revision: command.expected_revision,
        preview_hash: command.preview_hash,
        idempotency_key: command.idempotency_key,
        payload_hash: payloadHash,
        files: files.map(({ upload_ref, ...file }) => {
          void upload_ref;
          return file;
        }),
        operations: [...command.operations],
        skipped: [...command.skipped]
      });
      const preparedResponse = await request(`/api/v1/projects/${pathSegment(command.source_ref.project_id)}/branches/${pathSegment(command.source_ref.branch_name)}/remote-sync/push:prepare`, {
        method: "POST", headers: { "Idempotency-Key": command.idempotency_key },
        json: { source, lease: current, expected_revision: command.expected_revision, preview_hash: command.preview_hash, idempotency_key: command.idempotency_key, payload_hash: payloadHash, files, operations: [...command.operations], skipped: [...command.skipped] }
      });
      let prepared;
      try {
        prepared = remoteSyncPushPrepareHttpResponseSchema.parse(preparedResponse);
      } catch (error) {
        if (process.env.HUNTER_DEBUG_HTTP === "1") {
          console.error("[hunter-http] prepare response failed schema parse:");
          console.error("  raw: " + JSON.stringify(preparedResponse).slice(0, 800));
          console.error("  zod: " + (error instanceof Error ? error.message : String(error)).slice(0, 500));
        }
        throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
      }
      if (prepared.outcome === "conflict") throw new RemoteSyncError("SYNC_IDEMPOTENCY_CONFLICT");
      if (process.env.HUNTER_DEBUG_HTTP === "1") {
        console.error("[hunter-http] prepare parsed OK, preparedPushMatches=" + preparedPushMatches(prepared.value, source, current, command, payloadHash));
      }
      if (!preparedPushMatches(prepared.value, source, current, command, payloadHash)) {
        if (process.env.HUNTER_DEBUG_HTTP === "1") {
          console.error("[hunter-http] preparedPushMatches mismatch:");
          console.error("  server source: " + JSON.stringify(prepared.value.source));
          console.error("  client source: " + JSON.stringify(source));
          console.error("  server lease: " + JSON.stringify({ id: prepared.value.lease_id, gen: prepared.value.lease_generation }));
          console.error("  client lease: " + JSON.stringify({ id: current.lease_id, gen: current.generation }));
          console.error("  expected_revision match: " + (prepared.value.expected_revision === command.expected_revision));
          console.error("  preview_hash match: " + (prepared.value.preview_hash === command.preview_hash));
          console.error("  idempotency_key match: " + (prepared.value.idempotency_key === command.idempotency_key));
          console.error("  payload_hash match: " + (prepared.value.payload_hash === payloadHash));
          console.error("  state: " + prepared.value.state);
        }
        throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
      }
      const manifestHash = remoteSyncSnapshotManifestHash(command.files);
      if (process.env.HUNTER_DEBUG_HTTP === "1") console.error("[hunter-http] about to POST push:commit");
      let commitResponse: unknown;
      try {
        commitResponse = await request(`/api/v1/projects/${pathSegment(command.source_ref.project_id)}/branches/${pathSegment(command.source_ref.branch_name)}/remote-sync/push:commit`, {
          method: "POST", headers: { "Idempotency-Key": command.idempotency_key },
          json: { prepare_id: prepared.value.prepare_id, lease: current, idempotency_key: command.idempotency_key, payload_hash: payloadHash }
        });
      } catch (error) {
        if (process.env.HUNTER_DEBUG_HTTP === "1") {
          console.error("[hunter-http] commit threw:");
          console.error("  type: " + (error instanceof Error ? error.constructor.name : typeof error));
          console.error("  message: " + (error instanceof Error ? error.message : String(error)));
          if (error instanceof RemoteSyncError) console.error("  code: " + error.code + " serverCode: " + (error.serverCode ?? ""));
        }
        if (!(error instanceof RemoteSyncError) ||
            (error.code !== "REMOTE_UNAVAILABLE" && error.code !== "SYNC_COMMIT_AMBIGUOUS")) {
          throw error;
        }
        const durable = await reconcilePushReceipt(
          source,
          prepared.value,
          command,
          payloadHash,
          manifestHash
        );
        const reconciledReceipt = resultReceipt(durable);
        await storeDurableReceiptRecord(
          options.workspaceRoot,
          command.source_ref,
          "push",
          command.idempotency_key,
          command.payload_hash,
          reconciledReceipt
        );
        return reconciledReceipt;
      }
      const committed = remoteSyncPushCommitHttpResponseSchema.safeParse(commitResponse);
      if (!committed.success) throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
      if (committed.data.outcome === "conflict") throw new RemoteSyncError("SYNC_IDEMPOTENCY_CONFLICT");
      if (!pushReceiptMatches(
        committed.data.value,
        source,
        prepared.value.prepare_id,
        command,
        payloadHash,
        manifestHash
      )) {
        if (process.env.HUNTER_DEBUG_HTTP === "1") {
          const v = committed.data.value;
          console.error("[hunter-http] pushReceiptMatches mismatch:");
          console.error("  prepare_id: " + (v.prepare_id === prepared.value.prepare_id));
          console.error("  sameHttpSource: " + sameHttpSource(v.source, source));
          console.error("    server: " + JSON.stringify(v.source));
          console.error("    client: " + JSON.stringify(source));
          console.error("  idempotency_key: " + (v.idempotency_key === command.idempotency_key));
          console.error("  payload_hash: " + (v.payload_hash === payloadHash));
          console.error("  preview_hash: " + (v.preview_hash === command.preview_hash));
          console.error("  manifest_hash: " + (v.manifest_hash === manifestHash) + ` (server=${v.manifest_hash} client=${manifestHash})`);
          console.error("  commit_sha: server=" + JSON.stringify(v.commit_sha) + " client=" + JSON.stringify(source.commit_sha ?? null));
          console.error("  sameOperations: " + sameOperations(v.applied, command.operations));
        }
        throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
      }
      const receipt = resultReceipt(committed.data.value);
      await storeDurableReceiptRecord(
        options.workspaceRoot,
        command.source_ref,
        "push",
        command.idempotency_key,
        command.payload_hash,
        receipt
      );
      return receipt;
    },
    async commitPull(command: PullCommit) {
      try {
        const operations = pullTransactionOperations(command);
        const manifestHash = remoteSyncSnapshotManifestHash(command.files);
        const baselineManifestHash = remoteSyncSnapshotManifestHash(command.baseline_files);
        const identity = pullIdentity(
          httpSource(command.source_ref, options.actorId),
          command,
          manifestHash,
          baselineManifestHash
        );
        const transactionRoot = join(
          options.workspaceRoot,
          ".harness",
          "state",
          "transactions",
          identity.transactionId
        );
        const journalPath = join(transactionRoot, "journal.json");
        const receipt = pullReceipt(command);
        const existingJournal = await readContainedBoundedJson(
          options.workspaceRoot,
          journalPath,
          MAX_WORKSPACE_BYTES
        );
        if (existingJournal !== null) {
          if (typeof existingJournal === "object" && !Array.isArray(existingJournal) &&
              (existingJournal as Record<string, unknown>).project_identity !== undefined &&
              (existingJournal as Record<string, unknown>).project_identity !== identity.projectIdentity) {
            throw new RemoteSyncError("SYNC_IDEMPOTENCY_CONFLICT");
          }
          let journal: TransactionJournal;
          try {
            journal = validatedPullJournal(existingJournal, {
              transactionId: identity.transactionId,
              projectIdentity: identity.projectIdentity,
              targetBundleVersion: command.expected_revision,
              ownershipManifestHash: manifestHash,
              operations
            });
          } catch {
            throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
          }
          if (journal.state !== "committed") {
            const resumed = await resumeTransaction(options.workspaceRoot, identity.transactionId, {
              projectIdentity: identity.projectIdentity,
              targetBundleVersion: command.expected_revision,
              ownershipManifestHash: manifestHash
            });
            if (resumed.status !== "committed") {
              throw new RemoteSyncError("SYNC_PULL_WORKSPACE_FAILED", true);
            }
          }
          await storeDurableReceiptRecord(
            options.workspaceRoot,
            command.source_ref,
            "pull",
            command.idempotency_key,
            command.payload_hash,
            receipt
          );
          return receipt;
        }
        await assertPullLocalHashes(command.operations);
        const transaction = await (options.runWorkspaceTransaction ?? runTransaction)(
          options.workspaceRoot,
          operations,
          {
            id: identity.transactionId,
            projectIdentity: identity.projectIdentity,
            targetBundleVersion: command.expected_revision,
            ownershipManifestHash: manifestHash
          }
        );
        if (transaction.status !== "committed") {
          throw new RemoteSyncError("SYNC_PULL_WORKSPACE_FAILED", true);
        }
        await storeDurableReceiptRecord(
          options.workspaceRoot,
          command.source_ref,
          "pull",
          command.idempotency_key,
          command.payload_hash,
          receipt
        );
        return receipt;
      } catch (error) {
        if (error instanceof RemoteSyncError) throw error;
        throw new RemoteSyncError("SYNC_PULL_WORKSPACE_FAILED", true);
      }
    },
    async commitArchive(command: ArchiveCommit): Promise<ArchiveSyncReceipt> {
      // 06B-3 W3 生产 seam：POST archives:ingest（canonical 收据）。
      // 路由缺失/不 conform 由 errorFromResponse/模块 validateArchiveReceipt fail closed，
      // 绝不投影 legacy 形状冒充新收据。
      const packageRef = command.package_ref;
      // 传输层 Idempotency-Key（uuid 形状）：从协议 idempotency 确定性派生，
      // 同一 command 的重试复用同一 key（服务端 mutation 去重）。
      const transportIdempotency = [
        command.idempotency_key.slice(7, 15),
        command.idempotency_key.slice(15, 19),
        `4${command.idempotency_key.slice(20, 23)}`,
        `8${command.idempotency_key.slice(24, 27)}`,
        command.idempotency_key.slice(28, 40)
      ].join("-");
      const response = await request(
        `/api/v1/projects/${encodeURIComponent(command.source_ref.project_id)}/archives:ingest`,
        {
          method: "POST",
          headers: {
            "content-type": "application/zip",
            "idempotency-key": transportIdempotency,
            "x-archive-request-id": packageRef.request_id,
            "x-archive-id": packageRef.archive_id,
            "x-archive-change-key": packageRef.change_key,
            "x-archive-schema-version": String(packageRef.archive_schema_version),
            "x-archive-package-sha256": packageRef.package_sha256,
            "x-archive-idempotency-key": command.idempotency_key,
            "x-archive-logical-slot": command.logical_slot
          },
          body: Buffer.from(packageRef.content)
        }
      );
      return response as ArchiveSyncReceipt;
    },
    async listBranchSnapshots(project: ProjectRef, cursor: string | undefined, limit: number): Promise<BranchSnapshotPage> {
      void project; void cursor; void limit;
      throw new RemoteSyncError("REMOTE_UNAVAILABLE");
    },
    async listSnapshotVersions(branch: { project_id: string; branch_name: string }, cursor: string | undefined, limit: number): Promise<SnapshotVersionPage> {
      void branch; void cursor; void limit;
      throw new RemoteSyncError("REMOTE_UNAVAILABLE");
    },
    async listSnapshotFiles(snapshot: SnapshotRef, cursor: string | undefined, limit: number): Promise<SnapshotFilePage> {
      void snapshot; void cursor; void limit;
      throw new RemoteSyncError("REMOTE_UNAVAILABLE");
    },
    async getSnapshotFile(snapshot: SnapshotRef, path: string): Promise<SnapshotFile | null> {
      void snapshot; void path;
      throw new RemoteSyncError("REMOTE_UNAVAILABLE");
    }
  };
}
