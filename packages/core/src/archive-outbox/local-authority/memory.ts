import { createHash } from "node:crypto";

import type {
  LocalArchiveAuthorityCommitResult,
  LocalArchiveAuthorityEntryId,
  LocalArchiveAuthorityPort,
  LocalArchiveAuthorityPortOperation,
  LocalArchiveAuthorityRecord,
  LocalArchiveAuthoritySha256
} from "./types.js";
import { normalizeLocalArchiveAuthorityRecord, plainDataRecord } from "./validation.js";

function blobKey(projectId: string, refId: string, hash: string, size: number): string {
  return `${projectId}\u0000${refId}\u0000${hash}\u0000${size}`;
}

function recordSnapshot(value: unknown): LocalArchiveAuthorityRecord {
  const normalized = normalizeLocalArchiveAuthorityRecord(value);
  if (!normalized.ok || normalized.readiness !== "ready") throw new Error("LOCAL_ARCHIVE_AUTHORITY_RECORD_INVALID");
  return normalized.record;
}

function operationSnapshot(value: unknown): LocalArchiveAuthorityPortOperation {
  if (!plainDataRecord(value, ["operation_id", "kind", "intent_hash", "entry_id", "expected_generation"]) ||
      typeof value.operation_id !== "string" || typeof value.kind !== "string" || typeof value.intent_hash !== "string" ||
      typeof value.entry_id !== "string" || !(value.expected_generation === null ||
        typeof value.expected_generation === "number" && Number.isSafeInteger(value.expected_generation))) {
    throw new Error("LOCAL_ARCHIVE_AUTHORITY_OPERATION_INVALID");
  }
  return Object.freeze({ operation_id: value.operation_id, kind: value.kind, intent_hash: value.intent_hash,
    entry_id: value.entry_id, expected_generation: value.expected_generation }) as LocalArchiveAuthorityPortOperation;
}

export class InMemoryLocalArchiveAuthorityPort implements LocalArchiveAuthorityPort {
  readonly #clock: () => Date;
  readonly #records = new Map<LocalArchiveAuthorityEntryId, LocalArchiveAuthorityRecord>();
  readonly #operations = new Map<string, { operation: LocalArchiveAuthorityPortOperation; record: LocalArchiveAuthorityRecord }>();
  readonly #blobs = new Map<string, Uint8Array>();

  constructor(options: { readonly clock?: () => Date } = {}) { this.#clock = options.clock ?? (() => new Date()); }
  clock(): Date { return this.#clock(); }
  async read(entryId: LocalArchiveAuthorityEntryId): Promise<LocalArchiveAuthorityRecord | undefined> { return this.#records.get(entryId); }
  async findBinding(projectId: string, refId: string): Promise<LocalArchiveAuthorityRecord | undefined> {
    return [...this.#records.values()].find((record) => record.project_id === projectId && record.ref_id === refId);
  }
  async inspectOperation(operationId: LocalArchiveAuthorityPortOperation["operation_id"]): Promise<{
    readonly operation: LocalArchiveAuthorityPortOperation;
    readonly record: LocalArchiveAuthorityRecord;
  } | undefined> { return this.#operations.get(operationId); }
  async commit(operation: LocalArchiveAuthorityPortOperation, next: LocalArchiveAuthorityRecord): Promise<LocalArchiveAuthorityCommitResult> {
    const safeOperation = operationSnapshot(operation); const safeNext = recordSnapshot(next);
    const priorOperation = this.#operations.get(safeOperation.operation_id);
    if (priorOperation !== undefined) {
      return priorOperation.operation.intent_hash === safeOperation.intent_hash && priorOperation.operation.kind === safeOperation.kind ?
        { outcome: "replayed", record: priorOperation.record } : { outcome: "conflict", record: priorOperation.record };
    }
    const current = this.#records.get(safeOperation.entry_id);
    const bindingOwner = [...this.#records.values()].find((record) =>
      record.project_id === safeNext.project_id && record.ref_id === safeNext.ref_id);
    if (safeOperation.expected_generation === null && bindingOwner !== undefined && bindingOwner.entry_id !== safeNext.entry_id)
      return { outcome: "conflict", record: bindingOwner };
    if (safeOperation.expected_generation === null ? current !== undefined : current === undefined || current.generation !== safeOperation.expected_generation)
      return { outcome: "conflict", record: current ?? null };
    const durable = Object.freeze({ operation: safeOperation, record: safeNext });
    this.#records.set(safeOperation.entry_id, safeNext);
    this.#operations.set(safeOperation.operation_id, durable);
    return { outcome: "committed", record: safeNext };
  }
  async putBlob(projectId: string, refId: string, hash: LocalArchiveAuthoritySha256, size: number, bytes: Uint8Array): Promise<void> {
    if (bytes.length !== size) throw new Error("LOCAL_ARCHIVE_AUTHORITY_BLOB_SIZE_MISMATCH");
    const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (actual !== hash) throw new Error("LOCAL_ARCHIVE_AUTHORITY_BLOB_HASH_MISMATCH");
    const key = blobKey(projectId, refId, hash, size);
    const existing = this.#blobs.get(key);
    if (existing !== undefined && (existing.length !== bytes.length || existing.some((byte, index) => byte !== bytes[index])))
      throw new Error("LOCAL_ARCHIVE_AUTHORITY_BLOB_CONFLICT");
    this.#blobs.set(key, bytes.slice());
  }
  async readBlob(projectId: string, refId: string, hash: LocalArchiveAuthoritySha256, size: number): Promise<Uint8Array | undefined> {
    return this.#blobs.get(blobKey(projectId, refId, hash, size))?.slice();
  }
  async deleteBlob(projectId: string, refId: string, hash: LocalArchiveAuthoritySha256, size: number): Promise<void> {
    this.#blobs.delete(blobKey(projectId, refId, hash, size));
  }
}
