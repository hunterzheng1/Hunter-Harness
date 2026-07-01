import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import type {
  AuditEvent,
  IdempotencyRecord,
  TransactionRepository
} from "./interfaces.js";

function id(prefix: string): string {
  return prefix + randomUUID().replaceAll("-", "");
}

function timestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

// 事务内 ServerRepository 视图：绑定 PoolClient，所有 SQL 走 client（同一 PG 事务）。
// publish 路由 withTransaction 内的 writeAudit / persist / idempotency 通过此实现。
// 修 R2：原 PostgresRepository 方法走 this.pool，包在 transaction 内也无事务效果；
// 本类把事务内用到的 5 个方法改走 client，确保 publish+persist+writeAudit 原子。
export class PgTransactionRepository implements TransactionRepository {
  constructor(private readonly client: PoolClient) {}

  async appendAudit(event: Omit<AuditEvent, "eventId" | "createdAt">): Promise<AuditEvent> {
    const result = await this.client.query(
      `INSERT INTO audit_events(
        event_id, actor_id, project_id, action, target_id, request_id, details
      ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *`,
      [
        id("evt_"),
        event.actorId,
        event.projectId,
        event.action,
        event.targetId,
        event.requestId,
        JSON.stringify(event.details)
      ]
    );
    const row = result.rows[0] ?? {};
    return {
      eventId: String(row.event_id),
      actorId: String(row.actor_id),
      projectId: row.project_id === null ? null : String(row.project_id),
      action: String(row.action),
      targetId: String(row.target_id),
      requestId: String(row.request_id),
      details: row.details as Record<string, unknown>,
      createdAt: timestamp(row.created_at)
    };
  }

  async saveRegistryState(snapshot: unknown): Promise<void> {
    await this.client.query(
      `INSERT INTO registry_state(state_id, snapshot, updated_at)
       VALUES ('canonical', $1::jsonb, now())
       ON CONFLICT (state_id) DO UPDATE
       SET snapshot = EXCLUDED.snapshot, updated_at = now()`,
      [JSON.stringify(snapshot)]
    );
  }

  async loadRegistryState(): Promise<unknown | null> {
    const result = await this.client.query(
      "SELECT snapshot FROM registry_state WHERE state_id = 'canonical'"
    );
    return result.rowCount === 0 ? null : result.rows[0]?.snapshot ?? null;
  }

  async getIdempotency(input: {
    actorId: string;
    method: string;
    path: string;
    key: string;
  }): Promise<IdempotencyRecord | null> {
    const result = await this.client.query(
      `SELECT * FROM idempotency_records
       WHERE actor_id = $1 AND method = $2 AND canonical_path = $3
         AND idempotency_key = $4`,
      [input.actorId, input.method, input.path, input.key]
    );
    if (result.rowCount === 0) {
      return null;
    }
    const row = result.rows[0] ?? {};
    return {
      ...input,
      bodyHash: String(row.body_hash),
      statusCode: Number(row.status_code),
      response: row.response
    };
  }

  async putIdempotency(record: IdempotencyRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO idempotency_records(
        actor_id, method, canonical_path, idempotency_key,
        body_hash, status_code, response
      ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
      ON CONFLICT DO NOTHING`,
      [
        record.actorId,
        record.method,
        record.path,
        record.key,
        record.bodyHash,
        record.statusCode,
        JSON.stringify(record.response)
      ]
    );
  }
}
