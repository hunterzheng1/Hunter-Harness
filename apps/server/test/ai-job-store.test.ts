import { describe, expect, it, vi } from "vitest";
import type { RegistryAgent, SkillCheckResult } from "@hunter-harness/contracts";

import { MemoryAiJobStore } from "../src/ai/ai-job-store.js";

const sampleResult: SkillCheckResult = {
  items: [],
  summary: { green: 0, yellow: 0, red: 0 },
  checkedAt: "2026-07-01T00:00:00Z"
};
const agent: RegistryAgent = "claude-code";

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("MemoryAiJobStore (UT-001~005)", () => {
  it("UT-001 startJob(slug,agent,fn) 返回 running + slug/agent", async () => {
    const store = new MemoryAiJobStore();
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const job = await store.startJob("harness-x", agent, async () => { await pending; return sampleResult; });
    expect(job.status).toBe("running");
    expect(job.jobId).toBeTruthy();
    expect(job.slug).toBe("harness-x");
    expect(job.agent).toBe("claude-code");
    const got = await store.getJob(job.jobId);
    expect(got?.status).toBe("running");
    release?.();
    await flushPromises();
  });

  it("UT-002 fn resolve 后 job 转 completed + result", async () => {
    const store = new MemoryAiJobStore();
    const job = await store.startJob("harness-x", agent, async () => sampleResult);
    await flushPromises();
    const got = await store.getJob(job.jobId);
    expect(got?.status).toBe("completed");
    expect(got?.result).toEqual(sampleResult);
    expect(got?.error).toBeNull();
  });

  it("UT-003 fn reject 后 job 转 failed + error", async () => {
    const store = new MemoryAiJobStore();
    const job = await store.startJob("harness-x", agent, async () => { throw new Error("LLM 调用失败"); });
    await flushPromises();
    const got = await store.getJob(job.jobId);
    expect(got?.status).toBe("failed");
    expect(got?.error).toBe("LLM 调用失败");
    expect(got?.result).toBeNull();
  });

  it("UT-004 getJob 过期惰性删除", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));
    try {
      const store = new MemoryAiJobStore(60 * 60 * 1000);
      const job = await store.startJob("harness-x", agent, async () => sampleResult);
      vi.setSystemTime(new Date("2026-07-01T01:30:00Z"));
      expect(await store.getJob(job.jobId)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("UT-005 同 (slug,agent) 重复 startJob 返已有 jobId（dedup）", async () => {
    const store = new MemoryAiJobStore();
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const job1 = await store.startJob("harness-x", agent, async () => { await pending; return sampleResult; });
    const job2 = await store.startJob("harness-x", agent, async () => sampleResult);
    expect(job2.jobId).toBe(job1.jobId);
    release?.();
    await flushPromises();
  });

  it("UT-005b getJob 未知 jobId 返回 undefined", async () => {
    const store = new MemoryAiJobStore();
    expect(await store.getJob("unknown")).toBeUndefined();
  });

  it("UT-005c recoverOrphans memory no-op 不抛错", async () => {
    const store = new MemoryAiJobStore();
    await expect(store.recoverOrphans()).resolves.toBeUndefined();
  });

  it("UT-005d cleanupExpired 删过期", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));
    try {
      const store = new MemoryAiJobStore(60 * 60 * 1000);
      const job = await store.startJob("harness-x", agent, async () => sampleResult);
      vi.setSystemTime(new Date("2026-07-01T02:00:00Z"));
      await store.cleanupExpired();
      expect(await store.getJob(job.jobId)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
