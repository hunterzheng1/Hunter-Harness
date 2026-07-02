import { describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { aiConfigStateSchema, type AiProviderConfig } from "@hunter-harness/contracts";

import { RegistryStore } from "../src/registry/store.js";
import type { RegistryPersistence } from "../src/registry/persistence.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";
import { loadAiSecret } from "../src/ai/secret-loader.js";
import { createLlmClient } from "../src/ai/llm-factory.js";

class MemoryPersistence implements RegistryPersistence {
  snapshot: unknown = null;
  async load(): Promise<unknown | null> { return this.snapshot; }
  async save(snapshot: unknown): Promise<void> { this.snapshot = snapshot; }
}

function newStore(persistence?: RegistryPersistence): RegistryStore {
  return new RegistryStore(new MemoryArtifactStorage(), persistence);
}

const baseProviderInput = {
  provider_id: "deepseek",
  label: "DeepSeek",
  base_url: "https://api.deepseek.com",
  model: "deepseek-v4-pro",
  enabled: true,
  api_key_env: "secret-file"
};

describe("AI provider config-store (簇 C, 任务 9)", () => {
  it("UT-010 upsertProvider 创建 provider (revision 1) + listProviders + deleteProvider", async () => {
    const store = newStore();
    const p = await store.upsertProvider(baseProviderInput);
    expect(p.provider_id).toBe("deepseek");
    expect(p.revision).toBe(1);
    expect(p.is_default).toBe(false);
    expect(p.created_at).toBe(p.updated_at);

    const listed = store.listProviders();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.provider_id).toBe("deepseek");

    await store.deleteProvider("deepseek");
    expect(store.listProviders()).toHaveLength(0);
  });

  it("UT-010b upsertProvider 已存在则全量更新 revision+1 保留 created_at", async () => {
    const store = newStore();
    const p1 = await store.upsertProvider(baseProviderInput);
    const p2 = await store.upsertProvider({ ...baseProviderInput, label: "DeepSeek v2" });
    expect(p2.revision).toBe(2);
    expect(p2.label).toBe("DeepSeek v2");
    expect(p2.created_at).toBe(p1.created_at);
  });

  it("UT-011 setDefault 切换 default，旧 default 取消", async () => {
    const store = newStore();
    await store.upsertProvider(baseProviderInput);
    await store.upsertProvider({ ...baseProviderInput, provider_id: "openai", label: "OpenAI" });

    await store.setDefault("deepseek");
    expect(store.getDefaultProvider()?.provider_id).toBe("deepseek");
    expect(store.getProvider("openai")?.is_default).toBe(false);

    await store.setDefault("openai");
    expect(store.getDefaultProvider()?.provider_id).toBe("openai");
    expect(store.getProvider("deepseek")?.is_default).toBe(false);
  });

  it("UT-011b upsertProvider 带 is_default=true 自动设为 default", async () => {
    const store = newStore();
    await store.upsertProvider(baseProviderInput);
    await store.upsertProvider({ ...baseProviderInput, provider_id: "openai", is_default: true });
    expect(store.getDefaultProvider()?.provider_id).toBe("openai");
    expect(store.getProvider("deepseek")?.is_default).toBe(false);
  });

  it("UT-011c setDefault 不存在 → 404 PROVIDER_NOT_FOUND", async () => {
    const store = newStore();
    await expect(store.setDefault("nope")).rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND" });
  });

  it("UT-012 updateProvider 旧 revision → 409 REVISION_CONFLICT；正确 revision 更新成功", async () => {
    const store = newStore();
    await store.upsertProvider(baseProviderInput);

    await expect(store.updateProvider("deepseek", 999, { label: "x" }))
      .rejects.toMatchObject({ code: "REVISION_CONFLICT" });

    const updated = await store.updateProvider("deepseek", 1, { label: "DeepSeek Pro", enabled: false });
    expect(updated.revision).toBe(2);
    expect(updated.label).toBe("DeepSeek Pro");
    expect(updated.enabled).toBe(false);
  });

  it("UT-012b updateProvider 不存在 → 404 PROVIDER_NOT_FOUND", async () => {
    const store = newStore();
    await expect(store.updateProvider("nope", 1, { label: "x" }))
      .rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND" });
  });

  it("UT-012c deleteProvider 不存在 → 404 PROVIDER_NOT_FOUND", async () => {
    const store = newStore();
    await expect(store.deleteProvider("nope")).rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND" });
  });

  it("UT-012d deleteProvider default → default 清空", async () => {
    const store = newStore();
    await store.upsertProvider(baseProviderInput);
    await store.setDefault("deepseek");
    await store.deleteProvider("deepseek");
    expect(store.getDefaultProvider()).toBeNull();
  });

  it("getUsage 初始为空数组（per-provider per-day）", () => {
    const store = newStore();
    expect(store.getUsage()).toEqual([]);
  });

  it("COM-002/003 旧 snapshot 无 aiConfig → initialize 默认空不崩", async () => {
    const p = new MemoryPersistence();
    p.snapshot = {
      schemaVersion: 2,
      compilerVersion: "1.0.0",
      skills: [], proposals: [], tags: [], workflows: [], projectBindings: [], drafts: []
    };
    const store = newStore(p);
    await store.initialize();
    expect(store.listProviders()).toHaveLength(0);
    expect(store.getDefaultProvider()).toBeNull();
    expect(store.getUsage()).toEqual([]);
  });

  it("COM-004 新 snapshot 含 aiConfig/aiUsage 往返一致", async () => {
    const p = new MemoryPersistence();
    const store = newStore(p);
    await store.upsertProvider(baseProviderInput);
    await store.setDefault("deepseek");

    const reloaded = newStore(p);
    await reloaded.initialize();
    expect(reloaded.listProviders()).toHaveLength(1);
    expect(reloaded.getDefaultProvider()?.provider_id).toBe("deepseek");
    expect(reloaded.getProvider("deepseek")?.revision).toBe(1);

    // aiConfigStateSchema 校验往返一致
    const state = { defaultProvider: "deepseek", providers: reloaded.listProviders() };
    expect(() => aiConfigStateSchema.parse(state)).not.toThrow();
  });
});

describe("AI secret-loader (簇 C, 任务 8)", () => {
  async function tmpFile(name: string, content: string): Promise<string> {
    const file = path.join(os.tmpdir(), `hh-ai-${name}-${process.pid}.json`);
    await fs.writeFile(file, content, "utf8");
    return file;
  }

  it("UT-013 读 secret file 返回 apiKey（含可选 baseUrl/model 覆盖）", async () => {
    const file = await tmpFile("secret", JSON.stringify({
      deepseek: { apiKey: "sk-test-123", baseUrl: "https://custom.deepseek.com", model: "deepseek-custom" }
    }));
    try {
      const secret = await loadAiSecret(file, "deepseek");
      expect(secret?.apiKey).toBe("sk-test-123");
      expect(secret?.baseUrl).toBe("https://custom.deepseek.com");
      expect(secret?.model).toBe("deepseek-custom");
    } finally {
      await fs.rm(file, { force: true });
    }
  });

  it("UT-013b key 不写日志（不进 console.log/warn）", async () => {
    const file = await tmpFile("nolog", JSON.stringify({ deepseek: { apiKey: "sk-secret-log-check" } }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const secret = await loadAiSecret(file, "deepseek");
      expect(secret?.apiKey).toBe("sk-secret-log-check");
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      await fs.rm(file, { force: true });
    }
  });

  it("UT-014 文件不存在 → null", async () => {
    const secret = await loadAiSecret(path.join(os.tmpdir(), "hh-no-such-file.json"), "deepseek");
    expect(secret).toBeNull();
  });

  it("UT-014b provider 无 key 条目 → null", async () => {
    const file = await tmpFile("empty", JSON.stringify({ openai: { apiKey: "sk-x" } }));
    try {
      const secret = await loadAiSecret(file, "deepseek");
      expect(secret).toBeNull();
    } finally {
      await fs.rm(file, { force: true });
    }
  });

  it("UT-014c secret file 内容非法 JSON → null（不抛错）", async () => {
    const file = await tmpFile("bad", "{not valid json");
    try {
      const secret = await loadAiSecret(file, "deepseek");
      expect(secret).toBeNull();
    } finally {
      await fs.rm(file, { force: true });
    }
  });
});

describe("AI quota + per-provider per-day usage (簇 B-2)", () => {
  const baseProviderCfg = {
    provider_id: "deepseek" as const,
    label: "DeepSeek",
    base_url: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    enabled: true,
    is_default: false,
    api_key_env: "secret-file",
    revision: 1,
    daily_request_limit: null as number | null,
    daily_token_limit: null as number | null,
    created_at: "2026-06-28T00:00:00Z",
    updated_at: "2026-06-28T00:00:00Z"
  };
  const today = () => new Date().toISOString().slice(0, 10);

  it("QUOTA-001 未超限累加 per-provider per-day (UT-010/020)", async () => {
    const store = newStore();
    await store.upsertProvider({ ...baseProviderInput, daily_request_limit: 100 });
    await store.recordUsage({ provider_id: "deepseek", requests: 50, tokens: 100 });
    await store.recordUsage({ provider_id: "deepseek", requests: 30, tokens: 200 });
    const u = store.getUsage().find((x) => x.provider_id === "deepseek");
    expect(u?.requests).toBe(80);
    expect(u?.tokens).toBe(300);
    expect(u?.date).toBe(today());
  });

  it("QUOTA-002 超 requests 限 → 429 QUOTA_EXCEEDED 不累加 (UT-011)", async () => {
    const store = newStore();
    await store.upsertProvider({ ...baseProviderInput, daily_request_limit: 100 });
    await store.recordUsage({ provider_id: "deepseek", requests: 90, tokens: 0 });
    await expect(store.recordUsage({ provider_id: "deepseek", requests: 20, tokens: 0 }))
      .rejects.toMatchObject({ code: "QUOTA_EXCEEDED", status: 429 });
    const u = store.getUsage().find((x) => x.provider_id === "deepseek");
    expect(u?.requests).toBe(90);
  });

  it("QUOTA-003 超 tokens 限 → 429 (UT-012)", async () => {
    const store = newStore();
    await store.upsertProvider({ ...baseProviderInput, daily_token_limit: 1000 });
    await store.recordUsage({ provider_id: "deepseek", requests: 1, tokens: 900 });
    await expect(store.recordUsage({ provider_id: "deepseek", requests: 1, tokens: 200 }))
      .rejects.toMatchObject({ code: "QUOTA_EXCEEDED", status: 429 });
  });

  it("QUOTA-004 limit=null 不限 (UT-013)", async () => {
    const store = newStore();
    await store.upsertProvider({ ...baseProviderInput, daily_request_limit: null, daily_token_limit: null });
    await store.recordUsage({ provider_id: "deepseek", requests: 99999, tokens: 99999 });
    const u = store.getUsage().find((x) => x.provider_id === "deepseek");
    expect(u?.requests).toBe(99999);
  });

  it("QUOTA-005 不传 quota 默认 null 不限", async () => {
    const store = newStore();
    await store.upsertProvider(baseProviderInput);
    await store.recordUsage({ provider_id: "deepseek", requests: 99999, tokens: 99999 });
    const u = store.getUsage().find((x) => x.provider_id === "deepseek");
    expect(u?.requests).toBe(99999);
  });

  it("QUOTA-006 per-provider 独立 A 超 B 不超 (UT-015/021)", async () => {
    const store = newStore();
    await store.upsertProvider({ ...baseProviderInput, provider_id: "A", daily_request_limit: 100 });
    await store.upsertProvider({ ...baseProviderInput, provider_id: "B", daily_request_limit: 100 });
    await store.recordUsage({ provider_id: "A", requests: 95, tokens: 0 });
    await store.recordUsage({ provider_id: "B", requests: 10, tokens: 0 });
    await expect(store.recordUsage({ provider_id: "A", requests: 10, tokens: 0 }))
      .rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    const uB = store.getUsage().find((x) => x.provider_id === "B");
    expect(uB?.requests).toBe(10);
  });

  it("QUOTA-007 recordUsage 未知 provider → 404 PROVIDER_NOT_FOUND", async () => {
    const store = newStore();
    await expect(store.recordUsage({ provider_id: "nope", requests: 1, tokens: 1 }))
      .rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND", status: 404 });
  });

  it("QUOTA-008 per-day 滚动 新 date 从 0 (UT-014)", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-01T12:00:00Z"));
      const store = newStore();
      await store.upsertProvider({ ...baseProviderInput, daily_request_limit: 100 });
      await store.recordUsage({ provider_id: "deepseek", requests: 90, tokens: 0 });
      vi.setSystemTime(new Date("2026-07-02T12:00:00Z"));
      await store.recordUsage({ provider_id: "deepseek", requests: 50, tokens: 0 });
      const usage = store.getUsage();
      const day1 = usage.find((u) => u.date === "2026-07-01");
      const day2 = usage.find((u) => u.date === "2026-07-02");
      expect(day1?.requests).toBe(90);
      expect(day2?.requests).toBe(50);
    } finally {
      vi.useRealTimers();
    }
  });

  it("COM-001 旧全局 aiUsage 迁移到默认 provider 当日条目 (UT-022)", async () => {
    const p = new MemoryPersistence();
    p.snapshot = {
      schemaVersion: 3, compilerVersion: "1.0.0",
      skills: [], proposals: [], tags: [], workflows: [], projectBindings: [], drafts: [],
      aiConfig: { defaultProvider: "deepseek", providers: [baseProviderCfg], usage: [] },
      aiUsage: { requests: 100, tokens: 500 }
    };
    const store = newStore(p);
    await store.initialize();
    const usage = store.getUsage();
    expect(usage).toHaveLength(1);
    expect(usage[0]?.provider_id).toBe("deepseek");
    expect(usage[0]?.requests).toBe(100);
    expect(usage[0]?.tokens).toBe(500);
    expect(usage[0]?.date).toBe(today());
  });

  it("COM-001b 无默认 provider 不迁移 usage 为空", async () => {
    const p = new MemoryPersistence();
    p.snapshot = {
      schemaVersion: 3, compilerVersion: "1.0.0",
      skills: [], proposals: [], tags: [], workflows: [], projectBindings: [], drafts: [],
      aiConfig: { defaultProvider: null, providers: [], usage: [] },
      aiUsage: { requests: 100, tokens: 500 }
    };
    const store = newStore(p);
    await store.initialize();
    expect(store.getUsage()).toEqual([]);
  });

  it("COM-001c 已有 usage 不重复迁移旧 aiUsage", async () => {
    const p = new MemoryPersistence();
    p.snapshot = {
      schemaVersion: 3, compilerVersion: "1.0.0",
      skills: [], proposals: [], tags: [], workflows: [], projectBindings: [], drafts: [],
      aiConfig: {
        defaultProvider: "deepseek", providers: [baseProviderCfg],
        usage: [{ provider_id: "deepseek", date: today(), requests: 30, tokens: 40 }]
      },
      aiUsage: { requests: 100, tokens: 500 }
    };
    const store = newStore(p);
    await store.initialize();
    const u = store.getUsage().find((x) => x.provider_id === "deepseek");
    expect(u?.requests).toBe(30);
    expect(u?.tokens).toBe(40);
  });
});

describe("AI multi-model + reorder + migration (簇 D, 任务 2-6)", () => {
  const multiModelInput = {
    provider_id: "deepseek",
    label: "DeepSeek",
    base_url: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    enabled: true,
    api_key_env: "secret-file",
    api_format: "openai" as const,
    note: "primary",
    website: "https://deepseek.com",
    selected_model_id: "m1",
    sort_order: 0,
    models: [
      { id: "m1", display_model: "v4-pro", request_model: "deepseek-v4-pro", input_cost: 1, output_cost: 2, cache_hit_cost: 0.1, cache_create_cost: 0.5 },
      { id: "m2", display_model: "v4-lite", request_model: "deepseek-v4-lite", input_cost: 0.5, output_cost: 1, cache_hit_cost: 0.05, cache_create_cost: 0.25 }
    ]
  };

  it("U-05 upsertProvider 接受多模型字段并持久化往返", async () => {
    const mem = new MemoryPersistence();
    const store = newStore(mem);
    const p = await store.upsertProvider(multiModelInput);
    expect(p.models).toHaveLength(2);
    expect(p.models[0]?.id).toBe("m1");
    expect(p.api_format).toBe("openai");
    expect(p.note).toBe("primary");
    expect(p.website).toBe("https://deepseek.com");
    expect(p.selected_model_id).toBe("m1");
    expect(p.sort_order).toBe(0);

    const reloaded = newStore(mem);
    await reloaded.initialize();
    const rp = reloaded.getProvider("deepseek");
    expect(rp?.models).toHaveLength(2);
    expect(rp?.models[0]?.input_cost).toBe(1);
    expect(rp?.selected_model_id).toBe("m1");
    expect(rp?.api_format).toBe("openai");
  });

  it("U-06 listProviders 按 sort_order 升序", async () => {
    const store = newStore();
    await store.upsertProvider({ ...multiModelInput, provider_id: "b", sort_order: 1 });
    await store.upsertProvider({ ...multiModelInput, provider_id: "a", sort_order: 0 });
    await store.upsertProvider({ ...multiModelInput, provider_id: "c", sort_order: 2 });
    const ids = store.listProviders().map((p) => p.provider_id);
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("U-07 recordUsage per-model per-day 累加 + cost 计算", async () => {
    const store = newStore();
    await store.upsertProvider(multiModelInput);
    await store.recordUsage({ provider_id: "deepseek", model: "deepseek-v4-pro", requests: 1, input_tokens: 1000000, output_tokens: 500000, cache_hit_tokens: 0 });
    await store.recordUsage({ provider_id: "deepseek", model: "deepseek-v4-pro", requests: 1, input_tokens: 0, output_tokens: 500000, cache_hit_tokens: 0 });
    const u = store.getUsage().find((x) => x.provider_id === "deepseek" && x.model === "deepseek-v4-pro");
    expect(u?.requests).toBe(2);
    expect(u?.input_tokens).toBe(1000000);
    expect(u?.output_tokens).toBe(1000000);
    expect(u?.tokens).toBe(2000000);
    // cost = 1M/1e6*1 (input) + 1M/1e6*2 (output) + 0 = 3
    expect(u?.cost).toBeCloseTo(3, 6);
  });

  it("U-07b recordUsage per-model 独立累加（不同 model 不同条目）", async () => {
    const store = newStore();
    await store.upsertProvider(multiModelInput);
    await store.recordUsage({ provider_id: "deepseek", model: "deepseek-v4-pro", requests: 1, input_tokens: 100, output_tokens: 0, cache_hit_tokens: 0 });
    await store.recordUsage({ provider_id: "deepseek", model: "deepseek-v4-lite", requests: 1, input_tokens: 100, output_tokens: 0, cache_hit_tokens: 0 });
    const usage = store.getUsage().filter((x) => x.provider_id === "deepseek");
    expect(usage).toHaveLength(2);
    expect(usage.find((x) => x.model === "deepseek-v4-pro")?.cost).toBeCloseTo(0.0001, 9);
    expect(usage.find((x) => x.model === "deepseek-v4-lite")?.cost).toBeCloseTo(0.00005, 9);
  });

  it("U-08 reorderProviders 重排 + sort_order 更新", async () => {
    const store = newStore();
    await store.upsertProvider({ ...multiModelInput, provider_id: "a", sort_order: 0 });
    await store.upsertProvider({ ...multiModelInput, provider_id: "b", sort_order: 1 });
    await store.upsertProvider({ ...multiModelInput, provider_id: "c", sort_order: 2 });
    await store.reorderProviders(["c", "a", "b"]);
    const ids = store.listProviders().map((p) => p.provider_id);
    expect(ids).toEqual(["c", "a", "b"]);
    expect(store.getProvider("c")?.sort_order).toBe(0);
    expect(store.getProvider("b")?.sort_order).toBe(2);
  });

  it("U-09 reorderProviders providerIds 不全/多余 → 422 VALIDATION_FAILED", async () => {
    const store = newStore();
    await store.upsertProvider({ ...multiModelInput, provider_id: "a", sort_order: 0 });
    await store.upsertProvider({ ...multiModelInput, provider_id: "b", sort_order: 1 });
    await expect(store.reorderProviders(["a"])).rejects.toMatchObject({ code: "VALIDATION_FAILED", status: 422 });
    await expect(store.reorderProviders(["a", "b", "c"])).rejects.toMatchObject({ code: "VALIDATION_FAILED", status: 422 });
  });

  it("D-01 schemaVersion 3 旧 snapshot（单 model）反序列化 → models[] + selected_model_id + persist schemaVersion 4", async () => {
    const p = new MemoryPersistence();
    p.snapshot = {
      schemaVersion: 3, compilerVersion: "1.0.0",
      skills: [], proposals: [], tags: [], workflows: [], projectBindings: [], drafts: [],
      aiConfig: {
        defaultProvider: "deepseek",
        providers: [{
          provider_id: "deepseek", label: "DeepSeek", base_url: "https://api.deepseek.com",
          model: "deepseek-v4-pro", enabled: true, is_default: true, api_key_env: "secret-file",
          revision: 1, created_at: "2026-06-28T00:00:00Z", updated_at: "2026-06-28T00:00:00Z"
        }],
        usage: []
      }
    };
    const store = newStore(p);
    await store.initialize();
    const provider = store.getProvider("deepseek");
    expect(provider?.models).toHaveLength(1);
    expect(provider?.models[0]?.request_model).toBe("deepseek-v4-pro");
    expect(provider?.models[0]?.display_model).toBe("deepseek-v4-pro");
    expect(provider?.selected_model_id).toBe("deepseek_m0");
    expect(provider?.api_format).toBe("openai");
    expect(provider?.sort_order).toBe(0);
    // 触发 persist 后 schemaVersion 升 4
    await store.setDefault("deepseek");
    expect((p.snapshot as { schemaVersion: number }).schemaVersion).toBe(4);
  });

  it("D-02 schemaVersion 3 多 provider 迁移", async () => {
    const p = new MemoryPersistence();
    p.snapshot = {
      schemaVersion: 3, compilerVersion: "1.0.0",
      skills: [], proposals: [], tags: [], workflows: [], projectBindings: [], drafts: [],
      aiConfig: {
        defaultProvider: null,
        providers: [
          { provider_id: "a", label: "A", base_url: "https://a", model: "ma", enabled: true, is_default: false, api_key_env: "s", revision: 1, created_at: "2026-06-28T00:00:00Z", updated_at: "2026-06-28T00:00:00Z" },
          { provider_id: "b", label: "B", base_url: "https://b", model: "mb", enabled: true, is_default: false, api_key_env: "s", revision: 1, created_at: "2026-06-28T00:00:00Z", updated_at: "2026-06-28T00:00:00Z" }
        ],
        usage: []
      }
    };
    const store = newStore(p);
    await store.initialize();
    const a = store.getProvider("a");
    const b = store.getProvider("b");
    expect(a?.models).toHaveLength(1);
    expect(a?.models[0]?.request_model).toBe("ma");
    expect(a?.selected_model_id).toBe("a_m0");
    expect(b?.models).toHaveLength(1);
    expect(b?.selected_model_id).toBe("b_m0");
    expect(a?.sort_order).toBe(0);
    expect(b?.sort_order).toBe(1);
  });

  it("D-03 schemaVersion 4 新 snapshot 不重复迁移（保留 custom-id/cost/sort_order/note）", async () => {
    const p = new MemoryPersistence();
    p.snapshot = {
      schemaVersion: 4, compilerVersion: "1.0.0",
      skills: [], proposals: [], tags: [], workflows: [], projectBindings: [], drafts: [],
      aiConfig: {
        defaultProvider: "deepseek",
        providers: [{
          provider_id: "deepseek", label: "DeepSeek", base_url: "https://api.deepseek.com",
          model: "deepseek-v4-pro", enabled: true, is_default: true, api_key_env: "secret-file",
          revision: 1, created_at: "2026-06-28T00:00:00Z", updated_at: "2026-06-28T00:00:00Z",
          models: [{ id: "custom-id", display_model: "v4", request_model: "deepseek-v4-pro", input_cost: 5, output_cost: 6, cache_hit_cost: 0, cache_create_cost: 0 }],
          api_format: "openai", note: "keep", website: "", selected_model_id: "custom-id", sort_order: 3
        }],
        usage: []
      }
    };
    const store = newStore(p);
    await store.initialize();
    const provider = store.getProvider("deepseek");
    expect(provider?.models[0]?.id).toBe("custom-id");
    expect(provider?.models[0]?.input_cost).toBe(5);
    expect(provider?.selected_model_id).toBe("custom-id");
    expect(provider?.sort_order).toBe(3);
    expect(provider?.note).toBe("keep");
  });
});

describe("AI llm-factory selected model + api_format gate (簇 E, 任务 5)", () => {
  const baseLlmProvider: AiProviderConfig = {
    provider_id: "deepseek",
    label: "DeepSeek",
    base_url: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    enabled: true,
    is_default: false,
    api_key_env: "secret-file",
    revision: 1,
    daily_request_limit: null,
    daily_token_limit: null,
    created_at: "2026-06-28T00:00:00Z",
    updated_at: "2026-06-28T00:00:00Z",
    models: [
      { id: "m1", display_model: "v4-pro", request_model: "deepseek-v4-pro", input_cost: 1, output_cost: 2, cache_hit_cost: 0.1, cache_create_cost: 0.5 },
      { id: "m2", display_model: "v4-lite", request_model: "deepseek-v4-lite", input_cost: 0.5, output_cost: 1, cache_hit_cost: 0.05, cache_create_cost: 0.25 }
    ],
    api_format: "openai",
    note: "",
    website: "",
    selected_model_id: "m1",
    sort_order: 0
  };

  function mockFetch(): ReturnType<typeof vi.fn> {
    return vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
    }));
  }

  it("U-10 createLlmClient openai 用 selected model request_model", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = createLlmClient({ ...baseLlmProvider, selected_model_id: "m2" }, "sk-test");
      expect(client).not.toBeNull();
      if (client === null) return;
      await client.analyze({ system: "s", user: "u" });
      const callInit = fetchMock.mock.calls[0]?.[1] as { body?: string } | undefined;
      expect(JSON.parse(callInit?.body ?? "{}").model).toBe("deepseek-v4-lite");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("U-11 createLlmClient api_format=anthropic → null", () => {
    expect(createLlmClient({ ...baseLlmProvider, api_format: "anthropic" }, "sk-test")).toBeNull();
  });

  it("U-11b createLlmClient api_format=custom → null", () => {
    expect(createLlmClient({ ...baseLlmProvider, api_format: "custom" }, "sk-test")).toBeNull();
  });

  it("U-12 createLlmClient selected_model_id 无效 → fallback models[0].request_model", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = createLlmClient({ ...baseLlmProvider, selected_model_id: "nonexistent" }, "sk-test");
      expect(client).not.toBeNull();
      if (client === null) return;
      await client.analyze({ system: "s", user: "u" });
      const callInit = fetchMock.mock.calls[0]?.[1] as { body?: string } | undefined;
      expect(JSON.parse(callInit?.body ?? "{}").model).toBe("deepseek-v4-pro");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("U-12b createLlmClient 无 models → fallback provider.model", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = createLlmClient({ ...baseLlmProvider, models: [], selected_model_id: null }, "sk-test");
      expect(client).not.toBeNull();
      if (client === null) return;
      await client.analyze({ system: "s", user: "u" });
      const callInit = fetchMock.mock.calls[0]?.[1] as { body?: string } | undefined;
      expect(JSON.parse(callInit?.body ?? "{}").model).toBe("deepseek-v4-pro");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
