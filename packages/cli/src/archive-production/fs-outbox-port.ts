import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import { canonicalJson } from "@hunter-harness/contracts";

/**
 * ArchiveOutboxPort 的 FS 生产实现（06B-3 T0-1 冻结语义）。
 *
 * - 布局：`.harness/state/local/archive-outbox/<entry_id>.json`（文件名 URL 编码）
 * - 写一律 tmp+fsync+原子 rename；record 即唯一真相，重启不做恢复写
 * - corrupt/unparseable record → quarantine 文件 + read=undefined（不自动修复）
 * - CAS 边界与 InMemoryArchiveOutboxPort 逐语义对齐（generation 校验，漂移不合并）
 */

type ArchiveOutboxRecordLike = {
  readonly entry_id: string;
  readonly generation: number;
  readonly record_hash: string;
  readonly [key: string]: unknown;
};

interface ArchiveOutboxCasResultLike {
  readonly swapped: boolean;
  readonly record: ArchiveOutboxRecordLike;
}

interface ArchiveOutboxPageLike {
  readonly records: readonly ArchiveOutboxRecordLike[];
  readonly next_cursor?: string;
}

export interface FsArchiveOutboxPortOptions {
  readonly projectRoot: string;
  readonly clock?: () => Date;
}

const stableHash = (value: unknown): string =>
  `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;

const outboxRoot = (projectRoot: string): string =>
  join(projectRoot, ".harness", "state", "local", "archive-outbox");

const quarantineRoot = (projectRoot: string): string =>
  join(projectRoot, ".harness", "state", "local", "archive-outbox-quarantine");

const recordPath = (projectRoot: string, entryId: string): string =>
  join(outboxRoot(projectRoot), `${encodeURIComponent(entryId)}.json`);

async function writeAtomic(path: string, content: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const handle = await fs.open(tmp, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, path);
}

function sealedValid(record: unknown, entryId?: string): record is ArchiveOutboxRecordLike {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return false;
  const value = record as Record<string, unknown>;
  if (typeof value.entry_id !== "string" || typeof value.record_hash !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(value.record_hash) ||
      !Number.isSafeInteger(value.generation)) return false;
  if (entryId !== undefined && value.entry_id !== entryId) return false;
  const body = { ...value };
  delete body.record_hash;
  return stableHash(body) === value.record_hash;
}

export function createFsArchiveOutboxPort(options: FsArchiveOutboxPortOptions) {
  const root = options.projectRoot;
  const clockSource = options.clock ?? (() => new Date());

  async function quarantine(entryId: string, reason: string): Promise<void> {
    const path = join(quarantineRoot(root), `${encodeURIComponent(entryId)}.json`);
    await writeAtomic(path, JSON.stringify({
      entry_id: entryId, reason, quarantined_at: new Date().toISOString()
    }, null, 2));
  }

  async function readPersisted(entryId: string): Promise<ArchiveOutboxRecordLike | undefined> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(recordPath(root, entryId), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      await quarantine(entryId, "UNREADABLE");
      return undefined;
    }
    if (!sealedValid(parsed, entryId)) {
      await quarantine(entryId, "SEAL_INVALID");
      return undefined;
    }
    return parsed;
  }

  return Object.freeze({
    clock: (): Date => clockSource(),

    async put(record: ArchiveOutboxRecordLike): Promise<ArchiveOutboxRecordLike> {
      const prior = await readPersisted(record.entry_id);
      if (prior !== undefined) return prior;
      if (!sealedValid(record)) throw new Error("ARCHIVE_OUTBOX_RECORD_INVALID");
      await writeAtomic(recordPath(root, record.entry_id), JSON.stringify(record, null, 2));
      return record;
    },

    async read(entryId: string): Promise<ArchiveOutboxRecordLike | undefined> {
      return readPersisted(entryId);
    },

    async compareAndSwap(entryId: string, expectedGeneration: number,
        next: ArchiveOutboxRecordLike): Promise<ArchiveOutboxCasResultLike> {
      if (!sealedValid(next, entryId)) throw new Error("ARCHIVE_OUTBOX_RECORD_INVALID");
      const current = await readPersisted(entryId);
      if (current === undefined) throw new Error("ARCHIVE_OUTBOX_NOT_FOUND");
      if (current.generation !== expectedGeneration) {
        return Object.freeze({ swapped: false, record: current });
      }
      await writeAtomic(recordPath(root, entryId), JSON.stringify(next, null, 2));
      return Object.freeze({ swapped: true, record: next });
    },

    async list(cursor: string | undefined, limit: number): Promise<ArchiveOutboxPageLike> {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("ARCHIVE_OUTBOX_PORT_INVALID");
      let files: string[];
      try {
        files = await fs.readdir(outboxRoot(root));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") files = [];
        else throw error;
      }
      const records: ArchiveOutboxRecordLike[] = [];
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const entryId = decodeURIComponent(file.slice(0, -5));
        const record = await readPersisted(entryId);
        if (record !== undefined) records.push(record);
      }
      records.sort((left, right) => (left.entry_id < right.entry_id ? -1 : left.entry_id > right.entry_id ? 1 : 0));
      const start = cursor === undefined ? 0 : records.findIndex((record) => record.entry_id === cursor) + 1;
      if (start < 0) throw new Error("ARCHIVE_OUTBOX_PORT_INVALID");
      const page = records.slice(start, start + limit);
      const next = records[start + limit - 1];
      return Object.freeze({
        records: page,
        ...(start + limit < records.length && next !== undefined ? { next_cursor: next.entry_id } : {})
      });
    }
  });
}
