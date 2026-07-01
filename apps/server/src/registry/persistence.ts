import type { Pool } from "pg";

import type { TransactionRepository } from "../repositories/interfaces.js";

export interface RegistryPersistence {
  load(tx?: TransactionRepository): Promise<unknown | null>;
  save(snapshot: unknown, tx?: TransactionRepository): Promise<void>;
}

export class PostgresRegistryPersistence implements RegistryPersistence {
  constructor(private readonly pool: Pool) {}

  async load(tx?: TransactionRepository): Promise<unknown | null> {
    // 事务内走 tx（同一 PoolClient）；否则走 pool（initialize bootstrap 等非事务路径）。
    if (tx) {
      return tx.loadRegistryState();
    }
    const result = await this.pool.query(
      "SELECT snapshot FROM registry_state WHERE state_id = 'canonical'"
    );
    return result.rowCount === 0 ? null : result.rows[0]?.snapshot ?? null;
  }

  async save(snapshot: unknown, tx?: TransactionRepository): Promise<void> {
    if (tx) {
      await tx.saveRegistryState(snapshot);
      return;
    }
    await this.pool.query(
      `INSERT INTO registry_state(state_id, snapshot, updated_at)
       VALUES ('canonical', $1::jsonb, now())
       ON CONFLICT (state_id) DO UPDATE
       SET snapshot = EXCLUDED.snapshot, updated_at = now()`,
      [JSON.stringify(snapshot)]
    );
  }
}
