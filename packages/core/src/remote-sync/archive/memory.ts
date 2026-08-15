import type { RemoteArchiveV2Record, RemoteArchiveV2Sha256 } from "./types.js";
import { remoteArchiveV2StableHash } from "./stable.js";
import { normalizeRemoteArchiveV2Record, remoteArchiveV2Snapshot } from "./validation.js";

export interface InMemoryRemoteArchiveV2StoreOptions {
  readonly clock?: () => Date;
  readonly fail_after_commit_once?: boolean;
  readonly fail_after_committing_once?: boolean;
}

export class RemoteArchiveV2CommitAmbiguity extends Error {}

const IMMUTABLE_RECORD_FIELDS = [
  "schema_version", "operation_id", "prepare_id", "idempotency_key", "payload_hash", "source", "archive_id",
  "identities", "upload_ref", "created_at"
] as const satisfies readonly (keyof RemoteArchiveV2Record)[];

function sameImmutableIdentity(left: RemoteArchiveV2Record, right: RemoteArchiveV2Record): boolean {
  return IMMUTABLE_RECORD_FIELDS.every((key) => remoteArchiveV2StableHash(left[key]) === remoteArchiveV2StableHash(right[key]));
}

function legalTransition(left: RemoteArchiveV2Record, right: RemoteArchiveV2Record): boolean {
  if (left.record_hash === right.record_hash) return true;
  if (right.generation !== left.generation + 1 || Date.parse(right.updated_at) < Date.parse(left.updated_at)) return false;
  if (left.state === "pending" && right.state === "prepared") return left.lease === null && right.lease !== null;
  if (left.state === "prepared" && right.state === "failed") return left.lease !== null && right.lease === null;
  if ((left.state === "prepared" && right.state === "committing") ||
      (left.state === "committing" && right.state === "committed")) {
    return left.lease !== null && right.lease !== null &&
      remoteArchiveV2StableHash(left.lease) === remoteArchiveV2StableHash(right.lease);
  }
  return false;
}

export class InMemoryRemoteArchiveV2Store {
  readonly #clock: () => Date;
  readonly #records = new Map<string, RemoteArchiveV2Record>();
  readonly #keys = new Map<RemoteArchiveV2Sha256, string>();
  #ambiguous: boolean;
  #committingCrash: boolean;

  constructor(options: InMemoryRemoteArchiveV2StoreOptions = {}) {
    this.#clock = options.clock ?? (() => new Date()); this.#ambiguous = options.fail_after_commit_once ?? false;
    this.#committingCrash = options.fail_after_committing_once ?? false;
  }
  now(): Date { return this.#clock(); }
  read(operationId: string): RemoteArchiveV2Record | undefined { return this.#records.get(operationId); }
  keyOwner(key: RemoteArchiveV2Sha256): string | undefined { return this.#keys.get(key); }
  create(record: RemoteArchiveV2Record): void {
    const safe = this.#validated(record);
    if (this.#records.has(safe.operation_id) || this.#keys.has(safe.idempotency_key)) throw new Error("REMOTE_ARCHIVE_RECORD_INVALID");
    this.#keys.set(safe.idempotency_key, safe.operation_id); this.#records.set(safe.operation_id, safe);
  }
  replace(record: RemoteArchiveV2Record): void {
    const safe = this.#validated(record);
    const previous = this.#records.get(safe.operation_id);
    if (previous === undefined || this.#keys.get(previous.idempotency_key) !== previous.operation_id ||
        safe.idempotency_key !== previous.idempotency_key || this.#keys.get(safe.idempotency_key) !== safe.operation_id ||
        !sameImmutableIdentity(previous, safe) || !legalTransition(previous, safe))
      throw new Error("REMOTE_ARCHIVE_RECORD_INVALID");
    this.#records.set(safe.operation_id, safe);
  }
  maybeCrashAfterCommitting(): void {
    if (this.#committingCrash) { this.#committingCrash = false; throw new RemoteArchiveV2CommitAmbiguity(); }
  }
  maybeAmbiguous(): void { if (this.#ambiguous) { this.#ambiguous = false; throw new RemoteArchiveV2CommitAmbiguity(); } }
  #validated(record: RemoteArchiveV2Record): RemoteArchiveV2Record {
    const parsed = normalizeRemoteArchiveV2Record(remoteArchiveV2Snapshot(record));
    if (!parsed.ok || parsed.readiness !== "ready") throw new Error("REMOTE_ARCHIVE_RECORD_INVALID");
    const freeze = (value: unknown): unknown => {
      if (value !== null && typeof value === "object") {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
      }
      return value;
    };
    return freeze(parsed.record) as RemoteArchiveV2Record;
  }
}
