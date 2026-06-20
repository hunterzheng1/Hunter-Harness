import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import type { Pool } from "pg";

export async function runMigrations(pool: Pool, migrationsDirectory: string): Promise<void> {
  const root = resolve(migrationsDirectory);
  const files = (await readdir(root)).filter((name) => name.endsWith(".sql")).sort();
  const client = await pool.connect();
  try {
    await client.query(`SELECT pg_advisory_lock(hashtext('hunter-harness-migrations'))`);
    for (const file of files) {
      await client.query(await readFile(resolve(root, file), "utf8"));
    }
  } finally {
    try {
      await client.query(`SELECT pg_advisory_unlock(hashtext('hunter-harness-migrations'))`);
    } finally {
      client.release();
    }
  }
}
