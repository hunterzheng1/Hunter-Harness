import type { Pool } from "pg";

export interface RegistryPersistence {
  load(): Promise<unknown | null>;
  save(snapshot: unknown): Promise<void>;
}

export class PostgresRegistryPersistence implements RegistryPersistence {
  constructor(private readonly pool: Pool) {}

  async load(): Promise<unknown | null> {
    const result = await this.pool.query(
      "SELECT snapshot FROM registry_state WHERE state_id = 'canonical'"
    );
    return result.rowCount === 0 ? null : result.rows[0]?.snapshot ?? null;
  }

  async save(snapshot: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO registry_state(state_id, snapshot, updated_at)
       VALUES ('canonical', $1::jsonb, now())
       ON CONFLICT (state_id) DO UPDATE
       SET snapshot = EXCLUDED.snapshot, updated_at = now()`,
      [JSON.stringify(snapshot)]
    );
  }
}
