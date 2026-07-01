import type { AiJobState, RegistryAgent, SkillCheckResult } from "@hunter-harness/contracts";
import { uuidV7 } from "@hunter-harness/core";
import type { Pool } from "pg";

import type { AiJobStore } from "./ai-job-store.js";

function parseAiJob(row: Record<string, unknown>): AiJobState {
  const created = row.created_at;
  const expires = row.expires_at;
  return {
    jobId: String(row.job_id),
    slug: String(row.slug),
    agent: String(row.agent) as RegistryAgent,
    status: String(row.status) as AiJobState["status"],
    result: (row.result ?? null) as SkillCheckResult | null,
    error: row.error === null || row.error === undefined ? null : String(row.error),
    createdAt: created instanceof Date ? created.toISOString() : String(created),
    expiresAt: expires instanceof Date ? expires.toISOString() : String(expires)
  };
}

// PG 持久化 AiJobStore：多实例共享 ai_jobs 表（治 R1）。
// startJob dedup：SELECT active (slug,agent) → 有返已有；无 INSERT（partial unique index 兜底并发，Y3 catch 23505 → SELECT 返已有）。
// fn().then(UPDATE completed).catch(UPDATE failed)（Y4：UPDATE 失败 log 不重试，避免阻塞下一 job）。
// recoverOrphans（R3）：启动时 UPDATE running/pending → failed，释放 partial unique index。
// job 执行仍仅在启动实例内（fn().then 进程内）；实例宕则该 job 卡死，由 recoverOrphans 兜底（design §3.6 语义）。
export class PgAiJobStore implements AiJobStore {
  constructor(
    private readonly pool: Pool,
    private readonly ttlMs: number = 60 * 60 * 1000
  ) {}

  async startJob(slug: string, agent: RegistryAgent, fn: () => Promise<SkillCheckResult>): Promise<AiJobState> {
    // 1. dedup: SELECT active (slug,agent) 未过期
    const existing = await this.findActive(slug, agent);
    if (existing !== null) {
      return existing;
    }
    // 2. INSERT（partial unique index ai_jobs_slug_agent_active 兜底并发）
    const jobId = `aijob_${uuidV7()}`;
    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.ttlMs).toISOString();
    try {
      await this.pool.query(
        `INSERT INTO ai_jobs(job_id, slug, agent, status, result, error, created_at, expires_at)
         VALUES ($1, $2, $3, 'running', NULL, NULL, $4, $5)`,
        [jobId, slug, agent, createdAt, expiresAt]
      );
    } catch (err) {
      // Y3：只 catch 23505 unique_violation（partial index 冲突），其他错误抛出
      if ((err as { code?: string }).code !== "23505") throw err;
      // 并发：另一实例已 INSERT，SELECT 返已有
      const concurrent = await this.findActive(slug, agent);
      if (concurrent !== null) return concurrent;
      throw err;
    }
    // 3. 后台 fn → UPDATE completed/failed（Y4：UPDATE 失败 log 不重试）
    fn()
      .then(async (result) => {
        try {
          await this.pool.query(
            `UPDATE ai_jobs SET status = 'completed', result = $2::jsonb WHERE job_id = $1`,
            [jobId, JSON.stringify(result)]
          );
        } catch (e) {
          console.warn(`[ai-job-store-pg] UPDATE completed failed for ${jobId}`, e);
        }
      })
      .catch(async (err: unknown) => {
        try {
          await this.pool.query(
            `UPDATE ai_jobs SET status = 'failed', error = $2 WHERE job_id = $1`,
            [jobId, err instanceof Error ? err.message : String(err)]
          );
        } catch (e) {
          console.warn(`[ai-job-store-pg] UPDATE failed failed for ${jobId}`, e);
        }
      });
    // 返回内存态 job（DB 已 INSERT running）
    return { jobId, slug, agent, status: "running", result: null, error: null, createdAt, expiresAt };
  }

  // 查 active (pending/running) job by (slug, agent)，未过期。
  private async findActive(slug: string, agent: RegistryAgent): Promise<AiJobState | null> {
    const result = await this.pool.query(
      `SELECT * FROM ai_jobs
       WHERE slug = $1 AND agent = $2 AND status IN ('pending', 'running') AND expires_at > now()
       LIMIT 1`,
      [slug, agent]
    );
    if (result.rowCount === 0) return null;
    return parseAiJob(result.rows[0] ?? {});
  }

  async getJob(jobId: string): Promise<AiJobState | undefined> {
    const result = await this.pool.query(
      `SELECT * FROM ai_jobs WHERE job_id = $1 AND expires_at > now() LIMIT 1`,
      [jobId]
    );
    if (result.rowCount === 0) return undefined;
    return parseAiJob(result.rows[0] ?? {});
  }

  async cleanupExpired(): Promise<void> {
    await this.pool.query(`DELETE FROM ai_jobs WHERE expires_at <= now()`);
  }

  // R3：启动时标孤儿 running/pending → failed，释放 partial unique index。
  async recoverOrphans(): Promise<void> {
    await this.pool.query(
      `UPDATE ai_jobs SET status = 'failed', error = 'orphaned: process restart'
       WHERE status IN ('pending', 'running')`
    );
  }
}
