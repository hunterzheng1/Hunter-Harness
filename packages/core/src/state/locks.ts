import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ensureStateLayout } from "./layout.js";

export type ProtocolOperation = "init" | "push" | "update" | "rollback" | "cleanup";

interface LockRecord {
  operation: ProtocolOperation;
  request_id: string;
  nonce: string;
  pid: number;
  started_at_ms: number;
  heartbeat_at_ms: number;
}

export interface ProtocolLock {
  path: string;
  operation: ProtocolOperation;
  release(): Promise<void>;
}

export interface LockOptions {
  now?: number;
  staleAfterMs?: number;
  requestId?: string;
}

async function readLock(path: string): Promise<LockRecord> {
  return JSON.parse(await readFile(path, "utf8")) as LockRecord;
}

export async function acquireProtocolLock(
  projectRoot: string,
  operation: ProtocolOperation,
  options: LockOptions = {}
): Promise<ProtocolLock> {
  const layout = await ensureStateLayout(projectRoot);
  const lockPath = join(layout.locks, "protocol.lock");
  const now = options.now ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? 15 * 60 * 1000;
  const record: LockRecord = {
    operation,
    request_id: options.requestId ?? randomUUID(),
    nonce: randomUUID(),
    pid: process.pid,
    started_at_ms: now,
    heartbeat_at_ms: now
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(lockPath, JSON.stringify(record, null, 2), { flag: "wx" });
      return {
        path: lockPath,
        operation,
        async release(): Promise<void> {
          try {
            const current = await readLock(lockPath);
            if (current.nonce === record.nonce) {
              await rm(lockPath, { force: true });
            }
          } catch {
            // A replaced or externally removed lock is no longer ours to release.
          }
        }
      };
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }
      const current = await readLock(lockPath);
      if (now - current.heartbeat_at_ms <= staleAfterMs) {
        throw new Error(
          "protocol lock is active for operation " + current.operation,
          { cause: error }
        );
      }
      await rename(lockPath, lockPath + ".stale-" + randomUUID());
    }
  }
  throw new Error("unable to acquire protocol lock");
}
