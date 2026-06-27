import { describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { aiConfigStateSchema } from "@hunter-harness/contracts";

import { RegistryStore } from "../src/registry/store.js";
import type { RegistryPersistence } from "../src/registry/persistence.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";
import { loadAiSecret } from "../src/ai/secret-loader.js";

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

  it("getUsage 初始为 0", () => {
    const store = newStore();
    expect(store.getUsage()).toEqual({ requests: 0, tokens: 0 });
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
    expect(store.getUsage()).toEqual({ requests: 0, tokens: 0 });
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
