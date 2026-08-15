import { ArchiveOutboxError } from "./errors.js";
import { clone, compareCodepoint, deepFreeze, stableHash } from "./stable.js";
import type {
  ArchiveOutboxV2Page,
  ArchiveOutboxV2Port,
  ArchiveOutboxV2Record,
  ArchiveOutboxV2RecordReadResult,
  ArchiveOutboxV2TransitionInspection,
  ArchiveOutboxV2TransitionOperation,
  ArchiveOutboxV2TransitionResult
} from "./v2-types.js";
import {
  cloneV2Record,
  isV2EntryId,
  isV2OperationId,
  safeSnapshot,
  validTransitionOperation,
  validV2Record
} from "./v2-validation.js";

interface StoredTransition {
  readonly operation: ArchiveOutboxV2TransitionOperation;
  readonly record: ArchiveOutboxV2Record;
}

/**
 * Reference Port for v2. It deliberately stores only descriptor snapshots and
 * models commit ambiguity after the durable write; it never performs ZIP I/O.
 */
export class InMemoryArchiveOutboxV2Port implements ArchiveOutboxV2Port {
  private readonly store = new Map<string, ArchiveOutboxV2Record>();
  private readonly transitions = new Map<string, StoredTransition>();
  private readonly clockSource: () => Date;
  private failAfterCommitOnce: boolean;

  constructor(input: { readonly clock?: (() => Date) | undefined; readonly fail_after_commit_once?: boolean } = {}) {
    this.clockSource = input.clock ?? (() => new Date());
    this.failAfterCommitOnce = input.fail_after_commit_once === true;
  }

  clock(): Date {
    const value = this.clockSource();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID");
    }
    return new Date(value.getTime());
  }

  async put(value: ArchiveOutboxV2Record): Promise<ArchiveOutboxV2Record> {
    const record = this.snapshotRecord(value);
    const prior = this.store.get(record.entry_id);
    if (prior !== undefined) {
      if (prior.immutable_identity !== record.immutable_identity) {
        throw new ArchiveOutboxError("ARCHIVE_OUTBOX_IMMUTABLE_CONFLICT");
      }
      return cloneV2Record(prior);
    }
    this.store.set(record.entry_id, cloneV2Record(record));
    return cloneV2Record(record);
  }

  async read(entry_id: ArchiveOutboxV2Record["entry_id"]): Promise<ArchiveOutboxV2Record | undefined> {
    if (!isV2EntryId(entry_id)) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_INPUT_INVALID");
    const record = this.store.get(entry_id);
    return record === undefined ? undefined : cloneV2Record(record);
  }

  async list(cursor: string | undefined, limit: number): Promise<ArchiveOutboxV2Page> {
    if ((cursor !== undefined && !isV2EntryId(cursor)) ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID");
    }
    const records = [...this.store.values()].sort((left, right) => compareCodepoint(left.entry_id, right.entry_id));
    let start = 0;
    if (cursor !== undefined) {
      const found = records.findIndex((record) => record.entry_id === cursor);
      if (found < 0) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID");
      start = found + 1;
    }
    const page = records.slice(start, start + limit).map(cloneV2Record);
    const last = records[start + limit - 1];
    return deepFreeze({
      records: page,
      ...(start + limit < records.length && last !== undefined ? { next_cursor: last.entry_id } : {})
    });
  }

  async commitTransition(
    value: ArchiveOutboxV2TransitionOperation,
    nextValue: ArchiveOutboxV2Record
  ): Promise<ArchiveOutboxV2TransitionResult> {
    const operation = this.snapshotOperation(value);
    const next = this.snapshotRecord(nextValue);
    if (operation.entry_id !== next.entry_id) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID");
    const priorTransition = this.transitions.get(operation.operation_id);
    if (priorTransition !== undefined) {
      if (priorTransition.operation.entry_id !== operation.entry_id ||
          stableHash(priorTransition.operation) !== stableHash(operation)) {
        return deepFreeze({ outcome: "conflict", operation_id: operation.operation_id, record: null });
      }
      return deepFreeze({ outcome: "replayed", operation_id: operation.operation_id,
        record: cloneV2Record(priorTransition.record) });
    }
    const current = this.store.get(operation.entry_id);
    if (current === undefined) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_NOT_FOUND");
    if (current.generation !== operation.expected_generation ||
        next.generation !== operation.expected_generation + 1 || next.last_transition === null ||
        next.last_transition.operation_id !== operation.operation_id ||
        next.last_transition.kind !== operation.kind ||
        next.last_transition.idempotency_key !== operation.idempotency_key ||
        next.last_transition.payload_hash !== operation.payload_hash) {
      return deepFreeze({ outcome: "conflict", operation_id: operation.operation_id, record: null });
    }
    const transition = deepFreeze({ operation: clone(operation), record: cloneV2Record(next) });
    this.store.set(next.entry_id, cloneV2Record(next));
    this.transitions.set(operation.operation_id, transition);
    if (this.failAfterCommitOnce) {
      this.failAfterCommitOnce = false;
      return deepFreeze({ outcome: "ambiguous", operation_id: operation.operation_id, record: null });
    }
    return deepFreeze({ outcome: "new", operation_id: operation.operation_id, record: cloneV2Record(next) });
  }

  async inspectTransition(operation_id: ArchiveOutboxV2TransitionOperation["operation_id"]): Promise<ArchiveOutboxV2TransitionInspection> {
    if (!isV2OperationId(operation_id)) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_INPUT_INVALID");
    const prior = this.transitions.get(operation_id);
    if (prior === undefined) {
      return deepFreeze({ operation_id, state: "unknown", entry_id: null, kind: null, idempotency_key: null,
        payload_hash: null, record: null });
    }
    return deepFreeze({ operation_id, state: "committed", entry_id: prior.operation.entry_id,
      kind: prior.operation.kind, idempotency_key: prior.operation.idempotency_key,
      payload_hash: prior.operation.payload_hash, record: cloneV2Record(prior.record) });
  }

  records(): readonly ArchiveOutboxV2Record[] {
    return deepFreeze([...this.store.values()].sort((left, right) => compareCodepoint(left.entry_id, right.entry_id))
      .map(cloneV2Record));
  }

  private snapshotRecord(value: unknown): ArchiveOutboxV2Record {
    let snapshot: ArchiveOutboxV2Record;
    try { snapshot = safeSnapshot(value, "ARCHIVE_OUTBOX_PORT_INVALID") as ArchiveOutboxV2Record; } catch { throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID"); }
    if (!validV2Record(snapshot)) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID");
    return cloneV2Record(snapshot);
  }

  private snapshotOperation(value: unknown): ArchiveOutboxV2TransitionOperation {
    let snapshot: ArchiveOutboxV2TransitionOperation;
    try { snapshot = safeSnapshot(value, "ARCHIVE_OUTBOX_PORT_INVALID") as ArchiveOutboxV2TransitionOperation; } catch { throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID"); }
    if (!validTransitionOperation(snapshot)) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID");
    return deepFreeze(clone(snapshot));
  }
}

/** A parser used by persistence adapters before promoting records to v2. */
export function parseArchiveOutboxV2PortRecord(value: unknown): ArchiveOutboxV2RecordReadResult {
  try {
    const snapshot = safeSnapshot(value, "ARCHIVE_OUTBOX_RECORD_INVALID");
    return validV2Record(snapshot)
      ? { ok: true, source_schema_version: 2, readiness: "ready", record: cloneV2Record(snapshot) }
      : { ok: false, reason_code: "ARCHIVE_OUTBOX_V2_RECORD_INVALID" };
  } catch {
    return { ok: false, reason_code: "ARCHIVE_OUTBOX_V2_RECORD_INVALID" };
  }
}
