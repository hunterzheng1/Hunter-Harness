-- 003_ai_jobs.sql
-- AI 异步检查 job 持久化表（生产就绪：多实例共享 + 并发 dedup + 孤儿恢复）
-- 人工审查后手动执行，禁止自动运行（参见 .claude/rules/db-safety.md）

CREATE TABLE IF NOT EXISTS ai_jobs (
  job_id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  agent TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  result JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

COMMENT ON TABLE ai_jobs IS
  'AI async check job state. slug+agent partial unique index enforces single active job per (slug,agent) (R2 dedup). recoverOrphans marks stale running/pending as failed on restart (R3).';

-- partial unique index: 同 (slug,agent) 仅允许一个 active job（pending/running），治 R2 并发限制。
-- 23505 unique_violation 由 PgAiJobStore.startJob catch 后 SELECT 返已有 jobId。
CREATE INDEX IF NOT EXISTS ai_jobs_slug_agent_active
  ON ai_jobs (slug, agent)
  WHERE status IN ('pending', 'running');

-- DOWN（回滚策略，人工执行）:
--   DROP TABLE IF EXISTS ai_jobs;
-- 可逆：DROP TABLE 移除表+索引，无外部依赖（ai_jobs 仅由 AiJobStore 读写）。
