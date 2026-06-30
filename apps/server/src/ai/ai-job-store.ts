import type { SkillCheckResult } from "@hunter-harness/contracts";

// 异步 AI 检查 job 状态。MVP 单进程内存队列，不依赖外部 job store（Redis 等 deferred）。
export type AiJobStatus = "pending" | "running" | "completed" | "failed";

export interface AiJobState {
  jobId: string;
  status: AiJobStatus;
  result: SkillCheckResult | null;
  error: string | null;
  createdAt: string;
  expiresAt: string;
}

// 内存 job 队列：Map<jobId, AiJobState> + TTL（惰性过期：getJob 检查 expiresAt，过期则删除并返回 undefined）。
// 单进程非持久——重启丢失。适用于 MVP 同步 30s 超时改异步的过渡方案。
export class AiJobStore {
  private readonly jobs = new Map<string, AiJobState>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = 60 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  // 启动后台 job：立即设 running 并返回，fn 异步执行完成设 completed/failed。
  startJob(jobId: string, fn: () => Promise<SkillCheckResult>): AiJobState {
    const now = new Date();
    const job: AiJobState = {
      jobId,
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

  // 取 job 状态；过期（expiresAt <= now）惰性删除返回 undefined，路由层映射 404 JOB_NOT_FOUND。
  getJob(jobId: string): AiJobState | undefined {
    const job = this.jobs.get(jobId);
    if (job === undefined) return undefined;
    if (new Date(job.expiresAt).getTime() <= Date.now()) {
      this.jobs.delete(jobId);
      return undefined;
    }
    return job;
  }
}
