import { ArchiveOutboxError } from "./errors.js";
import { clone, compareCodepoint, deepFreeze } from "./stable.js";
import type {
  ArchiveOutboxCasResult,
  ArchiveOutboxPage,
  ArchiveOutboxPort,
  ArchiveOutboxRecord
} from "./types.js";

export class InMemoryArchiveOutboxPort implements ArchiveOutboxPort {
  private readonly store = new Map<string, ArchiveOutboxRecord>();
  private readonly clockSource: () => Date;

  constructor(input: { readonly clock?: (() => Date) | undefined } = {}) {
    this.clockSource = input.clock ?? (() => new Date());
  }

  clock(): Date {
    return this.clockSource();
  }

  async put(record: ArchiveOutboxRecord): Promise<ArchiveOutboxRecord> {
    const prior = this.store.get(record.entry_id);
    if (prior !== undefined) return deepFreeze(clone(prior));
    this.store.set(record.entry_id, deepFreeze(clone(record)));
    return deepFreeze(clone(record));
  }

  async read(entry_id: ArchiveOutboxRecord["entry_id"]): Promise<ArchiveOutboxRecord | undefined> {
    const record = this.store.get(entry_id);
    return record === undefined ? undefined : deepFreeze(clone(record));
  }

  async compareAndSwap(entry_id: ArchiveOutboxRecord["entry_id"], expected_generation: number,
    next: ArchiveOutboxRecord): Promise<ArchiveOutboxCasResult> {
    const current = this.store.get(entry_id);
    if (current === undefined) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_NOT_FOUND");
    if (current.generation !== expected_generation) {
      return deepFreeze({ swapped: false, record: clone(current) });
    }
    this.store.set(entry_id, deepFreeze(clone(next)));
    return deepFreeze({ swapped: true, record: clone(next) });
  }

  async list(cursor: string | undefined, limit: number): Promise<ArchiveOutboxPage> {
    const records = [...this.store.values()].sort((left, right) => compareCodepoint(left.entry_id, right.entry_id));
    const start = cursor === undefined ? 0 : records.findIndex((record) => record.entry_id === cursor) + 1;
    if (start < 0 || !Number.isSafeInteger(limit) || limit < 1) {
      throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID");
    }
    const page = records.slice(start, start + limit).map(clone);
    const next = records[start + limit - 1];
    return deepFreeze({ records: page, ...(start + limit < records.length && next !== undefined
      ? { next_cursor: next.entry_id }
      : {}) });
  }

  records(): readonly ArchiveOutboxRecord[] {
    return deepFreeze([...this.store.values()].map(clone));
  }
}
