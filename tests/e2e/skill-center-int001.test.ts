import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createServer } from "../../apps/server/src/app.js";
import { MemoryRepository } from "../../apps/server/src/repositories/memory.js";
import { MemoryArtifactStorage } from "../../apps/server/src/storage/memory.js";
import { buildUploadFormData, HttpHunterApi } from "../../apps/web/lib/api.js";

// 合法 skill IR（YAML）— findSkillIr 优先识别 skill.yaml（packages/core/src/skill-ir/extract.ts ENTRY_PRIORITY）
const SKILL_YAML = `name: harness-int001-test
kind: tooling
description: INT-001 end-to-end test skill
triggers: [int001]
inputs: [change_ref]
outputs: [result]
forbidden_actions: [automatic_git_write]
required_context: [AGENTS.md]
profiles:
  general: { enabled: true }
adapters:
  claude-code: { enabled: true }
version: 1.0.0
instructions:
  - Run end-to-end verification.
allowed_capabilities: [read, search]
source_provenance: int001 e2e fixture
`;

describe("INT-001 skill center 真实后端端到端", () => {
  it("上传→检查→发布→download 全链路真实 API + SHA-256 校验", async () => {
    // memory fallback（无需 PostgreSQL）— 真实 Fastify 路由 + mutation + idempotency + audit + registry 逻辑
    const repository = new MemoryRepository();
    const storage = new MemoryArtifactStorage();
    const token = "tok_int001_e2e";
    await repository.createActorWithToken({ actorId: "actor_int001", token });
    const app = await createServer({ repository, storage });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    // HttpHunterApi 用 globalThis.fetch（真实 HTTP + multipart FormData 原生支持）
    const api = new HttpHunterApi({
      baseUrl: `http://127.0.0.1:${port}`,
      tokenProvider: () => token
    });

    try {
      // 1. 上传 skill 包（multipart FormData + Idempotency-Key + Bearer token，真实 HTTP）
      const file = new File([SKILL_YAML], "skill.yaml", { type: "text/yaml" });
      const draft = await api.uploadSkillDraft(buildUploadFormData([file]), "claude-code");
      expect(draft.slug).toBe("harness-int001-test");
      expect(draft.draftVersion).toBe("0.1.0");

      // 2. 检查（POST /draft/checks）
      const checks = await api.runSkillDraftChecks(draft.slug, "claude-code");
      expect(checks.summary).toBeDefined();
      expect(Array.isArray(checks.items)).toBe(true);

      // 3. 发布（POST /publish，version 1.0.0 > latest null）
      const published = await api.publishSkillDraft(draft.slug, "claude-code", {
        version: "1.0.0",
        releaseNote: "int001 e2e"
      });
      expect(published.skill_slug).toBe("harness-int001-test");
      expect(published.version).toBe("1.0.0");

      // 4. download artifact（GET /skills/:slug/artifacts/:agent/download）+ SHA-256 校验
      const artifact = await api.downloadSkillArtifact(draft.slug, "claude-code");
      expect(artifact.filename).toContain("harness-int001-test");
      expect(artifact.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
      const bytes = new Uint8Array(await artifact.blob.arrayBuffer());
      const computed = "sha256:" + createHash("sha256").update(bytes).digest("hex");
      expect(computed).toBe(artifact.hash);
    } finally {
      await app.close();
    }
  });
});
