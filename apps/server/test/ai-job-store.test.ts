import { describe, expect, it, vi } from "vitest";
import type { SkillCheckResult } from "@hunter-harness/contracts";

import { AiJobStore } from "../src/ai/ai-job-store.js";

const sampleResult: SkillCheckResult = {
  items: [],
  summary: { green: 0, yellow: 0, red: 0 },
  checkedAt: "2026-07-01T00:00:00Z"
};

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("AiJobStore (UT-001~005)", () => {
  it("UT-001 startJob 后 getJob 返回 running", async () => {
    const store = new AiJobStore();
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    store.startJob("job-1", async () => { await pending; return sampleResult; });
    const got = store.getJob("job-1");
    expect(got?.status).toBe("running");
    expect(got?.jobId).toBe("job-1");
    expect(got?.result).toBeNull();
    release?.();
    await flushPromises();
  });

  it("UT-002 job 完成 status=completed + result", async () => {
    const store = new AiJobStore();
    store.startJob("job-2", async () => sampleResult);
    await flushPromises();
    const got = store.getJob("job-2");
    expect(got?.status).toBe("completed");
    expect(got?.result).toEqual(sampleResult);
    expect(got?.error).toBeNull();
  });

  it("UT-003 job 失败 status=failed + error", async () => {
    const store = new AiJobStore();
    store.startJob("job-3", async () => { throw new Error("LLM 调用失败"); });
    await flushPromises();
    const got = store.getJob("job-3");
    expect(got?.status).toBe("failed");
    expect(got?.error).toBe("LLM 调用失败");
    expect(got?.result).toBeNull();
  });

  it("UT-004 TTL 1h 过期 getJob 返回 undefined", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));
    try {
      const store = new AiJobStore(60 * 60 * 1000);
      store.startJob("job-4", async () => sampleResult);
      vi.setSystemTime(new Date("2026-07-01T01:30:00Z"));
      expect(store.getJob("job-4")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("UT-005 getJob 未知 jobId 返回 undefined", () => {
    const store = new AiJobStore();
    expect(store.getJob("unknown")).toBeUndefined();
  });

  it("UT-005b TTL 内 job 仍可取（边界）", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));
    try {
      const store = new AiJobStore(60 * 60 * 1000);
      store.startJob("job-6", async () => sampleResult);
      vi.setSystemTime(new Date("2026-07-01T00:30:00Z"));
      expect(store.getJob("job-6")?.status).toBe("running");
    } finally {
      vi.useRealTimers();
    }
  });
});
