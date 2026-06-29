import { uuidV7, type LlmClient, type LlmPrompt, type LlmResponse } from "@hunter-harness/core";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/app.js";
import { MemoryRepository } from "../src/repositories/memory.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";

const token = "ai-checks-owner-token";

const skillYaml = `name: harness-ai
kind: governance
description: ai test skill
triggers: ["run"]
inputs: ["ctx"]
outputs: ["out"]
forbidden_actions: ["automatic_git_write"]
required_context: ["AGENTS.md"]
profiles:
  general:
    enabled: true
adapters:
  claude-code:
    enabled: true
version: "1.0.0"
`;

function multipart(files: Array<{ path: string; content: string }>): {
  payload: string;
  headers: Record<string, string>;
} {
  const boundary = "----ai-checks-test-boundary";
  let body = "";
  for (const f of files) {
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="file"; filename="${f.path}"\r\n`;
    body += "Content-Type: application/octet-stream\r\n\r\n";
    body += f.content + "\r\n";
  }
  body += `--${boundary}--\r\n`;
  return { payload: body, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

// Fake LlmClient：行为由测试动态注入（成功/超时/非法 JSON）
class FakeLlmClient implements LlmClient {
  constructor(private readonly fn: (prompt: LlmPrompt) => Promise<LlmResponse>) {}
  analyze(prompt: LlmPrompt): Promise<LlmResponse> { return this.fn(prompt); }
}

const validAiJson = JSON.stringify({
  items: [{ id: "AI_TRIGGER_QUALITY", label: "触发质量", status: "green", message: "ok", filePath: null, fixable: false }],
  summary: { green: 1, yellow: 0, red: 0 },
  checkedAt: new Date().toISOString()
});

const providerPayload = {
  schema_version: 1,
  provider_id: "deepseek",
  label: "DeepSeek",
  base_url: "https://api.deepseek.com",
  model: "deepseek-v4-pro",
  enabled: true,
  api_key_env: "secret-file",
  is_default: true
};

describe("AI config + ai-checks API (簇 D, 任务 11/13)", () => {
  let repository: MemoryRepository;
  let app: Awaited<ReturnType<typeof createServer>>;
  let secretFile: string;
  let llmFn: (p: LlmPrompt) => Promise<LlmResponse>;

  beforeEach(async () => {
    repository = new MemoryRepository();
    await repository.createActorWithToken({ actorId: "actor_ai", token });
    secretFile = path.join(os.tmpdir(), `hh-ai-int-${process.pid}.json`);
    await fs.writeFile(secretFile, JSON.stringify({ deepseek: { apiKey: "sk-test-123" } }), "utf8");
    llmFn = async () => ({ content: validAiJson, usage: { requests: 1, tokens: 50 } });
    app = await createServer({
      repository,
      storage: new MemoryArtifactStorage(),
      config: { aiSecretFile: secretFile },
      aiLlmClientFactory: () => new FakeLlmClient((p) => llmFn(p))
    });
  });

  afterEach(async () => {
    await app.close();
    await fs.rm(secretFile, { force: true });
  });

  function headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: "Bearer " + token,
      "x-request-id": uuidV7(),
      "idempotency-key": uuidV7(),
      ...extra
    };
  }

  async function uploadDraft(): Promise<void> {
    const up = multipart([{ path: "skill.yaml", content: skillYaml }, { path: "SKILL.md", content: "# harness-ai" }]);
    const res = await app.inject({ method: "POST", url: "/api/v1/skills/draft", payload: up.payload, headers: { ...headers(), ...up.headers } });
    expect(res.statusCode).toBe(201);
  }

  async function createDefaultProvider(): Promise<void> {
    const res = await app.inject({ method: "POST", url: "/api/v1/ai-config/providers", payload: providerPayload, headers: headers() });
    expect(res.statusCode).toBe(201);
  }

  async function auditActions(): Promise<string[]> {
    const events = await repository.listAuditEvents({ actorId: "actor_ai", limit: 100 });
    return events.map((e) => e.action);
  }

  it("API-001 GET /ai-config/providers 返回列表，无 key 字段（API-018 无明文 key）", async () => {
    await createDefaultProvider();
    const res = await app.inject({ method: "GET", url: "/api/v1/ai-config/providers", headers: headers() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.default_provider).toBe("deepseek");
    expect(JSON.stringify(body)).not.toContain("apiKey");
    expect(JSON.stringify(body)).not.toContain("sk-");
  });

  it("API-002/020 POST 创建 + audit ai.provider.created + 幂等", async () => {
    const key = uuidV7();
    const first = await app.inject({ method: "POST", url: "/api/v1/ai-config/providers", payload: providerPayload, headers: headers({ "idempotency-key": key }) });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({ method: "POST", url: "/api/v1/ai-config/providers", payload: providerPayload, headers: headers({ "idempotency-key": key }) });
    expect(second.statusCode).toBe(201);
    expect(second.json().revision).toBe(first.json().revision);
    expect(await auditActions()).toContain("ai.provider.created");
  });

  it("API-003 PATCH 更新 + audit ai.provider.updated", async () => {
    await createDefaultProvider();
    const created = (await app.inject({ method: "GET", url: "/api/v1/ai-config/providers", headers: headers() })).json().items[0];
    const res = await app.inject({
      method: "PATCH", url: "/api/v1/ai-config/providers/deepseek",
      payload: { schema_version: 1, revision: created.revision, label: "DeepSeek Pro" },
      headers: headers()
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().label).toBe("DeepSeek Pro");
    expect(res.json().revision).toBe(created.revision + 1);
    expect(await auditActions()).toContain("ai.provider.updated");
  });

  it("API-004 PATCH 旧 revision → 409 REVISION_CONFLICT", async () => {
    await createDefaultProvider();
    const res = await app.inject({
      method: "PATCH", url: "/api/v1/ai-config/providers/deepseek",
      payload: { schema_version: 1, revision: 999, label: "x" },
      headers: headers()
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("REVISION_CONFLICT");
  });

  it("API-005 DELETE + audit ai.provider.deleted", async () => {
    await createDefaultProvider();
    const res = await app.inject({ method: "DELETE", url: "/api/v1/ai-config/providers/deepseek", headers: headers() });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(true);
    expect(await auditActions()).toContain("ai.provider.deleted");
    const list = await app.inject({ method: "GET", url: "/api/v1/ai-config/providers", headers: headers() });
    expect(list.json().items).toHaveLength(0);
  });

  it("API-006 POST /providers/:id/test 连通成功（mock 返回 ok）", async () => {
    await createDefaultProvider();
    const res = await app.inject({ method: "POST", url: "/api/v1/ai-config/providers/deepseek/test", payload: {}, headers: headers() });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().model).toBe("deepseek-v4-pro");
    expect(JSON.stringify(res.json())).not.toContain("sk-");
  });

  it("API-007 POST /test 错误（mock 抛错）返回 ok:false 不含 key", async () => {
    await createDefaultProvider();
    llmFn = async () => { throw new Error("connection refused"); };
    const res = await app.inject({ method: "POST", url: "/api/v1/ai-config/providers/deepseek/test", payload: {}, headers: headers() });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
    expect(res.json().error).toContain("connection refused");
    expect(JSON.stringify(res.json())).not.toContain("sk-");
  });

  it("API-007b POST /test provider 无 secret → 422 AI_NOT_CONFIGURED", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/v1/ai-config/providers",
      payload: { ...providerPayload, provider_id: "openai", is_default: false },
      headers: headers()
    });
    expect(res.statusCode).toBe(201);
    const testRes = await app.inject({ method: "POST", url: "/api/v1/ai-config/providers/openai/test", payload: {}, headers: headers() });
    expect(testRes.statusCode).toBe(422);
    expect(testRes.json().error.code).toBe("AI_NOT_CONFIGURED");
  });

  it("API-008 GET /ai-config/usage 返回统计", async () => {
    await createDefaultProvider();
    await app.inject({ method: "POST", url: "/api/v1/ai-config/providers/deepseek/test", payload: {}, headers: headers() });
    const res = await app.inject({ method: "GET", url: "/api/v1/ai-config/usage", headers: headers() });
    expect(res.statusCode).toBe(200);
    expect(res.json().requests).toBeGreaterThanOrEqual(1);
    expect(res.json().tokens).toBeGreaterThanOrEqual(0);
  });

  it("API-009/017 ai-checks 成功（mock 合法 JSON）+ audit skill.draft.ai-checked", async () => {
    await createDefaultProvider();
    await uploadDraft();
    const res = await app.inject({ method: "POST", url: "/api/v1/skills/harness-ai/draft/ai-checks", payload: {}, headers: headers() });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].id).toBe("AI_TRIGGER_QUALITY");
    expect(res.json().summary.green).toBe(1);
    expect(await auditActions()).toContain("skill.draft.ai-checked");
    // 写入 draft.aiChecks
    const draft = await app.inject({ method: "GET", url: "/api/v1/skills/harness-ai/draft", headers: headers() });
    expect(draft.json().aiChecks).not.toBeNull();
    expect(JSON.stringify(res.json())).not.toContain("sk-");
  });

  it("API-010 ai-checks 同 Idempotency-Key 重复返回相同结果", async () => {
    await createDefaultProvider();
    await uploadDraft();
    const key = uuidV7();
    const first = await app.inject({ method: "POST", url: "/api/v1/skills/harness-ai/draft/ai-checks", payload: {}, headers: headers({ "idempotency-key": key }) });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "POST", url: "/api/v1/skills/harness-ai/draft/ai-checks", payload: {}, headers: headers({ "idempotency-key": key }) });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
  });

  it("API-011 ai-checks 无 Idempotency-Key → 400", async () => {
    await createDefaultProvider();
    await uploadDraft();
    const res = await app.inject({ method: "POST", url: "/api/v1/skills/harness-ai/draft/ai-checks", payload: {}, headers: { authorization: "Bearer " + token, "x-request-id": uuidV7() } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
  });

  it("API-012 ai-checks Idempotency-Key 复用不同 body → 409", async () => {
    const key = uuidV7();
    await app.inject({ method: "POST", url: "/api/v1/ai-config/providers", payload: providerPayload, headers: headers({ "idempotency-key": key }) });
    const res = await app.inject({ method: "POST", url: "/api/v1/ai-config/providers", payload: { ...providerPayload, label: "Other" }, headers: headers({ "idempotency-key": key }) });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("API-013 ai-checks draft 不存在 → 404", async () => {
    await createDefaultProvider();
    const res = await app.inject({ method: "POST", url: "/api/v1/skills/no-such/draft/ai-checks", payload: {}, headers: headers() });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("DRAFT_NOT_FOUND");
  });

  it("API-014 ai-checks 未配置 AI（无 default provider）→ 422", async () => {
    await uploadDraft();
    const res = await app.inject({ method: "POST", url: "/api/v1/skills/harness-ai/draft/ai-checks", payload: {}, headers: headers() });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("AI_NOT_CONFIGURED");
  });

  it("API-015 ai-checks LLM 超时/网络错 → 降级 AI_TIMEOUT yellow（不 500）", async () => {
    await createDefaultProvider();
    await uploadDraft();
    llmFn = async () => { throw new Error("ETIMEDOUT"); };
    const res = await app.inject({ method: "POST", url: "/api/v1/skills/harness-ai/draft/ai-checks", payload: {}, headers: headers() });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].id).toBe("AI_TIMEOUT");
    expect(res.json().summary.yellow).toBe(1);
  });

  it("API-016 ai-checks LLM 非法 JSON → 降级 AI_PARSE_FAILED yellow", async () => {
    await createDefaultProvider();
    await uploadDraft();
    llmFn = async () => ({ content: "not valid json {", usage: { requests: 1, tokens: 5 } });
    const res = await app.inject({ method: "POST", url: "/api/v1/skills/harness-ai/draft/ai-checks", payload: {}, headers: headers() });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].id).toBe("AI_PARSE_FAILED");
    expect(res.json().summary.yellow).toBe(1);
  });

  it("API-019 auth 401（无 token）", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/ai-config/providers", headers: { "x-request-id": uuidV7() } });
    expect(res.statusCode).toBe(401);
  });
});

describe("INT-003 真实 DeepSeek 调用 (HUNTER_HARNESS_AI_INT_REAL=1)", () => {
  it("ai-checks 真实调用返回合法 SkillCheckResult 且无明文 key", async () => {
    if (process.env.HUNTER_HARNESS_AI_INT_REAL !== "1") { return; }
    const repository = new MemoryRepository();
    await repository.createActorWithToken({ actorId: "actor_real", token });
    // 不传 aiLlmClientFactory → 默认 createLlmClient（真实 DeepSeekLlmClient）；不传 config → 默认 secret file
    const realApp = await createServer({ repository, storage: new MemoryArtifactStorage() });
    try {
      const h = (extra: Record<string, string> = {}) => ({ authorization: "Bearer " + token, "x-request-id": uuidV7(), "idempotency-key": uuidV7(), ...extra });
      const pc = await realApp.inject({ method: "POST", url: "/api/v1/ai-config/providers", payload: { schema_version: 1, provider_id: "deepseek", label: "DeepSeek", base_url: "https://api.deepseek.com", model: "deepseek-v4-pro", enabled: true, api_key_env: "secret-file", is_default: true }, headers: h() });
      expect(pc.statusCode).toBe(201);
      const up = multipart([{ path: "skill.yaml", content: skillYaml }, { path: "SKILL.md", content: "# harness-ai" }]);
      const upRes = await realApp.inject({ method: "POST", url: "/api/v1/skills/draft", payload: up.payload, headers: { ...h(), ...up.headers } });
      expect(upRes.statusCode).toBe(201);
      const res = await realApp.inject({ method: "POST", url: "/api/v1/skills/harness-ai/draft/ai-checks", payload: {}, headers: h() });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items.length).toBeGreaterThan(0);
      expect(body.summary).toBeDefined();
      // 加强断言：弱断言（items.length>0）无法区分「真实 green 成功」与「LLM 失败/解析失败降级 yellow」——二者都过。
      // 真实调用成功时不得出现降级项 AI_TIMEOUT / AI_PARSE_FAILED（仅 LLM 抛错/非法 JSON 时才注入）。
      expect(body.items.some((i: { id: string }) => i.id === "AI_TIMEOUT" || i.id === "AI_PARSE_FAILED")).toBe(false);
      expect(JSON.stringify(body)).not.toContain("sk-");
    } finally {
      await realApp.close();
    }
  }, 60000);
});
