import type { AiJobState, RegistryAgent, SkillCheckResult } from "@hunter-harness/contracts";
import { uuidV7 } from "@hunter-harness/core";

export type AiJobStatus = AiJobState["status"];

// AiJobStore 抽象：多实例共享持久化（PG ai_jobs）+ memory fallback。
// startJob(slug,agent,fn) dedup：同 slug+agent active job 返已有（治 R2 并发限制）。
// recoverOrphans：进程重启后清理卡住的 running/pending（治 R3，PG 实现才需）。
export interface AiJobStore {
  startJob(slug: string, agent: RegistryAgent, fn: () => Promise<SkillCheckResult>): Promise<AiJobState>;
  getJob(jobId: string): Promise<AiJobState | undefined>;
  cleanupExpired(): Promise<void>;
  recoverOrphans(): Promise<void>;
}

// memory 单进程实现（fallback）：Map + TTL 惰性过期。重启丢失（PG 实现才持久化）。
// 适用于无 PG 环境的 MVP / 测试；生产多实例用 PgAiJobStore。
export class MemoryAiJobStore implements AiJobStore {
  private readonly jobs = new Map<string, AiJobState>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = 60 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  // dedup: 同 (slug,agent) 有 active job 返已有；否则新建 jobId + 后台 fn。
  async startJob(slug: string, agent: RegistryAgent, fn: () => Promise<SkillCheckResult>): Promise<AiJobState> {
    const existing = this.findActive(slug, agent);
    if (existing !== undefined) {
      return existing;
    }
    const jobId = `aijob_${uuidV7()}`;
    const now = new Date();
    const job: AiJobState = {
      jobId,
      slug,
      agent,
      status: "running",
      result: null,
      error: null,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString()
    };
    this.jobs.set(jobId, job);
    fn()
      .then((result) => {
        const j = this.jobs.get(jobId);
        if (j !== undefined) {
          j.status = "completed";
          j.result = result;
        }
      })
      .catch((err: unknown) => {
        const j = this.jobs.get(jobId);
        if (j !== undefined) {
          j.status = "failed";
          j.error = err instanceof Error ? err.message : String(err);
        }
      });
    return job;
  }

  // 查 active (running) job by (slug, agent)；过期先惰性删除。
  private findActive(slug: string, agent: RegistryAgent): AiJobState | undefined {
    for (const job of this.jobs.values()) {
      if (job.slug === slug && job.agent === agent && job.status === "running") {
        if (new Date(job.expiresAt).getTime() > Date.now()) {
          return job;
        }
        this.jobs.delete(job.jobId);
      }
    }
    return undefined;
  }

  // 取 job 状态；过期（expiresAt <= now）惰性删除返回 undefined，路由层映射 404 JOB_NOT_FOUND。
  async getJob(jobId: string): Promise<AiJobState | undefined> {
    const job = this.jobs.get(jobId);
    if (job === undefined) return undefined;
    if (new Date(job.expiresAt).getTime() <= Date.now()) {
      this.jobs.delete(jobId);
      return undefined;
    }
    return job;
  }

  async cleanupExpired(): Promise<void> {
    const now = Date.now();
    for (const [jobId, job] of this.jobs) {
      if (new Date(job.expiresAt).getTime() <= now) {
        this.jobs.delete(jobId);
      }
    }
  }

  // memory 无孤儿（进程重启丢失，无持久 running 态）。PG 实现才需启动恢复。
  async recoverOrphans(): Promise<void> {
    // no-op
  }
}
