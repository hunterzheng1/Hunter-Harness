import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import type {
  PlanFinalizationEventOutboxDeliveryInput,
  PlanFinalizationEventOutboxEnqueueInput,
  PlanFinalizationEventOutboxPort,
  PlanFinalizationEventOutboxRecord,
  PlanFinalizationTransactionRecord
} from "@hunter-harness/core";

/**
 * Plan finalization 事件 outbox 的生产 FS 适配器（T0-3/T0-5）。
 *
 * 落盘布局（change 目录内，单一权威）：
 * - outbox 记录：`<changeDir>/meta/plan-event-outbox/<outbox_id>.json`
 *   （pending → delivered / ambiguous / failed）；
 * - 事务记录：`<changeDir>/meta/plan-finalization-transactions/<operation_id>.json`；
 * - 事件载荷：deliver 时把 TS PlanEvent 逐行追加到
 *   `<changeDir>/meta/plan-events.ndjson`（event_id 去重）+ fsync。
 *
 * 偏离 T0 提案的记录：TS PlanEvent 不混入 Python `events.ndjson`（两种 schema 不同），
 * 事件上传平台的接线（Python sync 读取本文件并转换）列为后续工作项——
 * 原子性语义不受影响：receipt 先于事件，崩溃重放由 journal/outbox 状态驱动。
 */
export interface FsPlanEventOutboxOptions {
  readonly projectRoot: string;
  readonly now?: () => string;
}

function changeDir(root: string, changeKey: string): string {
  return join(root, ".harness", "changes", changeKey);
}

function outboxPath(root: string, changeKey: string, outboxId: string): string {
  return join(changeDir(root, changeKey), "meta", "plan-event-outbox", `${outboxId}.json`);
}

function transactionPath(root: string, changeKey: string, operationId: string): string {
  return join(changeDir(root, changeKey), "meta", "plan-finalization-transactions", `${operationId}.json`);
}

function eventsPath(root: string, changeKey: string): string {
  return join(changeDir(root, changeKey), "meta", "plan-events.ndjson");
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2));
  await fs.rename(tmp, path);
}

async function appendEvents(root: string, changeKey: string, events: readonly { event_id: string }[]): Promise<void> {
  const path = eventsPath(root, changeKey);
  await fs.mkdir(dirname(path), { recursive: true });
  let existing: string;
  try {
    existing = await fs.readFile(path, "utf8");
  } catch {
    existing = "";
  }
  const known = new Set(existing.split("\n").filter((line) => line !== "").map((line) => {
    try {
      return (JSON.parse(line) as { event_id?: string }).event_id;
    } catch {
      return undefined;
    }
  }));
  const fresh = events.filter((event) => !known.has(event.event_id));
  if (fresh.length === 0) return;
  const handle = await fs.open(path, "a");
  try {
    await handle.write(fresh.map((event) => JSON.stringify(event)).join("\n") + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function createFsPlanEventOutboxPort(options: FsPlanEventOutboxOptions): PlanFinalizationEventOutboxPort {
  const now = options.now ?? (() => new Date().toISOString());
  const root = options.projectRoot;

  return Object.freeze({
    async prepareTransaction(input: PlanFinalizationTransactionRecord): Promise<PlanFinalizationTransactionRecord> {
      const path = transactionPath(root, input.change_key, input.operation_id);
      const prior = await readJson<PlanFinalizationTransactionRecord>(path);
      if (prior !== null) {
        if (prior.idempotency_key !== input.idempotency_key || prior.project_id !== input.project_id ||
            prior.change_key !== input.change_key || prior.run_id !== input.run_id ||
            prior.branch_name !== input.branch_name || prior.attempt !== input.attempt ||
            prior.record_hash !== input.record_hash) {
          throw new Error("PLAN_FINALIZATION_TRANSACTION_IDENTITY_MISMATCH");
        }
        return prior;
      }
      await writeJsonAtomic(path, input);
      return input;
    },

    async updateTransaction(input: PlanFinalizationTransactionRecord): Promise<PlanFinalizationTransactionRecord> {
      const path = transactionPath(root, input.change_key, input.operation_id);
      const prior = await readJson<PlanFinalizationTransactionRecord>(path);
      if (prior === null || prior.idempotency_key !== input.idempotency_key || prior.project_id !== input.project_id ||
          prior.change_key !== input.change_key || prior.run_id !== input.run_id ||
          prior.branch_name !== input.branch_name || prior.attempt !== input.attempt) {
        throw new Error("PLAN_FINALIZATION_TRANSACTION_IDENTITY_MISMATCH");
      }
      await writeJsonAtomic(path, input);
      return input;
    },

    async inspectTransaction(input: { readonly operation_id: string; readonly idempotency_key?: string }): Promise<PlanFinalizationTransactionRecord | undefined> {
      const changesRoot = join(root, ".harness", "changes");
      let changeKeys: string[];
      try {
        changeKeys = (await fs.readdir(changesRoot, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        return undefined;
      }
      for (const changeKey of changeKeys) {
        const record = await readJson<PlanFinalizationTransactionRecord>(transactionPath(root, changeKey, input.operation_id));
        if (record !== null) {
          if (input.idempotency_key !== undefined && record.idempotency_key !== input.idempotency_key) {
            throw new Error("PLAN_FINALIZATION_TRANSACTION_IDENTITY_MISMATCH");
          }
          return record;
        }
      }
      return undefined;
    },

    async enqueue(input: PlanFinalizationEventOutboxEnqueueInput): Promise<PlanFinalizationEventOutboxRecord> {
      const path = outboxPath(root, input.context.change_key, input.outbox_id);
      const prior = await readJson<PlanFinalizationEventOutboxRecord>(path);
      if (prior !== null) {
        if (prior.operation_id !== input.operation_id || prior.idempotency_key !== input.idempotency_key ||
            prior.publication_receipt_id !== input.publication_receipt.receipt_id ||
            prior.event_bundle_hash !== input.event_bundle_hash) {
          throw new Error("PLAN_FINALIZATION_EVENT_OUTBOX_IDENTITY_MISMATCH");
        }
        return prior;
      }
      const timestamp = now();
      const record: PlanFinalizationEventOutboxRecord = Object.freeze({
        schema_version: 1,
        record_kind: "plan_finalization_event_outbox",
        outbox_id: input.outbox_id,
        operation_id: input.operation_id,
        idempotency_key: input.idempotency_key,
        project_id: input.context.project_id,
        change_key: input.context.change_key,
        run_id: input.context.run_id,
        branch_name: input.context.branch_name,
        attempt: input.context.attempt,
        publication_receipt_id: input.publication_receipt.receipt_id,
        publication_generation: input.publication_receipt.generation,
        publication_manifest_hash: input.publication_receipt.manifest_hash,
        event_bundle_hash: input.event_bundle_hash,
        events: Object.freeze([...input.events]),
        state: "pending",
        created_at: timestamp,
        updated_at: timestamp
      });
      await writeJsonAtomic(path, record);
      return record;
    },

    async deliver(input: PlanFinalizationEventOutboxDeliveryInput): Promise<PlanFinalizationEventOutboxRecord> {
      // deliver 语义：事件载荷落盘（plan-events.ndjson，event_id 幂等去重）后标记 delivered。
      // 崩溃于两者之间的恢复：ndjson 已有但状态 pending → 重放 deliver 仍幂等（去重命中）。
      const changesRoot = join(root, ".harness", "changes");
      let changeKeys: string[];
      try {
        changeKeys = (await fs.readdir(changesRoot, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        changeKeys = [];
      }
      for (const changeKey of changeKeys) {
        const path = outboxPath(root, changeKey, input.outbox_id);
        const prior = await readJson<PlanFinalizationEventOutboxRecord>(path);
        if (prior === null) continue;
        if (prior.operation_id !== input.operation_id || prior.idempotency_key !== input.idempotency_key ||
            prior.event_bundle_hash !== input.event_bundle_hash || prior.publication_receipt_id !== input.publication_receipt_id) {
          throw new Error("PLAN_FINALIZATION_EVENT_OUTBOX_IDENTITY_MISMATCH");
        }
        if (prior.state === "delivered") return prior;
        await appendEvents(root, changeKey, prior.events);
        const next = Object.freeze({ ...prior, state: "delivered" as const, updated_at: now() });
        await writeJsonAtomic(path, next);
        return next;
      }
      throw new Error("PLAN_FINALIZATION_EVENT_OUTBOX_NOT_FOUND");
    },

    async inspect(input: { readonly outbox_id: string; readonly operation_id: string; readonly idempotency_key: string }): Promise<PlanFinalizationEventOutboxRecord | undefined> {
      const changesRoot = join(root, ".harness", "changes");
      let changeKeys: string[];
      try {
        changeKeys = (await fs.readdir(changesRoot, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        return undefined;
      }
      for (const changeKey of changeKeys) {
        const record = await readJson<PlanFinalizationEventOutboxRecord>(outboxPath(root, changeKey, input.outbox_id));
        if (record !== null) {
          if (record.operation_id !== input.operation_id || record.idempotency_key !== input.idempotency_key) {
            throw new Error("PLAN_FINALIZATION_EVENT_OUTBOX_IDENTITY_MISMATCH");
          }
          return record;
        }
      }
      return undefined;
    }
  });
}
