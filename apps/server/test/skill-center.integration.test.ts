import type { SourceFile } from "@hunter-harness/contracts";
import { uuidV7 } from "@hunter-harness/core";
import AdmZip from "adm-zip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/app.js";
import { MemoryRepository } from "../src/repositories/memory.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";

const token = "skill-center-owner-token";

// 新模型：上传源文件（SKILL.md 含 frontmatter）是 skill 唯一源；canonical Skill IR 已删除。
// frontmatter name 派生 slug；description/kind/triggers/... 由 skillFrontmatterSchema 松校验。
function skillMd(name: string, version = "1.0.0", description = "demo skill"): string {
  return `---
name: ${name}
description: ${description}
kind: governance
triggers: ["run"]
inputs: ["ctx"]
outputs: ["out"]
forbidden_actions: ["automatic_git_write"]
required_context: ["AGENTS.md"]
version: "${version}"
---

# ${name}
demo skill body
`;
}

// cursor entry（.mdc）：cursor agent 的 entry 文件（findEntryFile 对 cursor 找 *.mdc）。
function cursorMdc(name: string, version = "1.0.0"): string {
  return `---
name: ${name}
description: cursor rule for ${name}
version: "${version}"
adapter: cursor
---
cursor rule body
`;
}

// harness-x：单 agent（claude-code）fixture
const filesX: SourceFile[] = [{ path: "SKILL.md", content: skillMd("harness-x") }];
// harness-cursor：多 agent fixture（claude-code 用 SKILL.md，cursor 用 .mdc）
const cursorFiles: SourceFile[] = [
  { path: "SKILL.md", content: skillMd("harness-cursor") },
  { path: "harness-cursor.mdc", content: cursorMdc("harness-cursor") }
];
// harness-proposal：createProposal fixture（cursor/codex 等 installable agent 均需各自 entry 通过 buildArtifacts 闸门）
const proposalFiles: SourceFile[] = [
  { path: "SKILL.md", content: skillMd("harness-proposal") },
  { path: "harness-proposal.mdc", content: cursorMdc("harness-proposal") }
];

// 从 draft JSON 的 sourceFiles entry frontmatter 提取字段（取代旧 draft.ir.* 断言）
function frontmatterField(draft: { sourceFiles?: Array<{ path: string; content: string }> } | undefined, field: string): string | undefined {
  const entry = draft?.sourceFiles?.find((f) => f.path === "SKILL.md");
  if (entry === undefined) return undefined;
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(entry.content);
  if (m === null) return undefined;
  const fm = m[1] ?? "";
  const line = fm.split("\n").find((l) => l.startsWith(field + ":"));
  return line?.slice((field + ":").length).trim().replace(/^["']|["']$/g, "");
}

function multipart(files: Array<{ path: string; content: string }>): {
  payload: string;
  headers: Record<string, string>;
} {
  const boundary = "----skill-center-test-boundary";
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

// workflow package 上传走单个 ZIP（resolveUploadFiles zip 分支保留 entryName 含目录）；
// 多 file part 模式下 fastify part.filename 会截断目录（skills/foo.md→foo.md），破坏边界判断与共享资源路径。
function multipartZip(entries: Array<{ path: string; content: string }>): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const zip = new AdmZip();
  for (const e of entries) zip.addFile(e.path, Buffer.from(e.content));
  const zipBuffer = zip.toBuffer();
  const boundary = "----wp-zip-boundary";
  const pre = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="package.zip"\r\nContent-Type: application/zip\r\n\r\n`);
  const post = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([pre, zipBuffer, post]), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

describe("skill-center end-to-end (tasks 14-17)", () => {
  let repository: MemoryRepository;
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    repository = new MemoryRepository();
    await repository.createActorWithToken({ actorId: "actor_owner", token });
    app = await createServer({ repository, storage: new MemoryArtifactStorage() });
  });

  afterEach(async () => app.close());

  function headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: "Bearer " + token,
      "x-request-id": uuidV7(),
      "idempotency-key": uuidV7(),
      ...extra
    };
  }

  // per-agent upload：?agent=<agent> 为必填查询参数（API-001）；harness-x 用 claude-code，harness-cursor 用 cursor/claude-code。
  async function uploadDraft(files: Array<{ path: string; content: string }>, agent: string = "claude-code"): Promise<void> {
    const up = multipart(files);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/skills/draft?agent=${agent}`,
      payload: up.payload,
      headers: { ...headers(), ...up.headers }
    });
    expect(res.statusCode).toBe(201);
  }

  it("upload → check → diff → publish → download end-to-end", async () => {
    await uploadDraft(filesX);

    const checksRes = await app.inject({ method: "POST", url: "/api/v1/skills/harness-x/draft/claude-code/checks", payload: {}, headers: headers() });
    expect(checksRes.statusCode).toBe(200);
    expect(checksRes.json().items.length).toBeGreaterThan(0);

    const diffRes = await app.inject({ method: "GET", url: "/api/v1/skills/harness-x/draft/claude-code/diff", headers: headers() });
    expect(diffRes.statusCode).toBe(200);

    const pubRes = await app.inject({ method: "POST", url: "/api/v1/skills/harness-x/draft/claude-code/publish", payload: { version: "1.0.0", releaseNote: "init" }, headers: headers() });
    expect(pubRes.statusCode).toBe(200);
    expect(pubRes.json().version).toBe("1.0.0");

    const skillRes = await app.inject({ method: "GET", url: "/api/v1/skills/harness-x", headers: headers() });
    expect(skillRes.statusCode).toBe(200);
    expect(skillRes.json().latest_version).toBe("1.0.0");
    expect(skillRes.json().defaultAgent).toBe("claude-code");

    const dlRes = await app.inject({ method: "GET", url: "/api/v1/skills/harness-x/artifacts/claude-code/download", headers: headers() });
    expect(dlRes.statusCode).toBe(200);
    expect(dlRes.headers["x-content-sha256"]).toBeDefined();
  });

  it("idempotent publish by Idempotency-Key returns the same result", async () => {
    await uploadDraft(filesX);
    const key = uuidV7();
    const body = { version: "1.0.0" };
    const first = await app.inject({ method: "POST", url: "/api/v1/skills/harness-x/draft/claude-code/publish", payload: body, headers: headers({ "idempotency-key": key }) });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "POST", url: "/api/v1/skills/harness-x/draft/claude-code/publish", payload: body, headers: headers({ "idempotency-key": key }) });
    expect(second.statusCode).toBe(200);
    expect(second.json().version).toBe("1.0.0");
  });

  it("delete skill then GET returns 404", async () => {
    await uploadDraft(filesX);
    await app.inject({ method: "POST", url: "/api/v1/skills/harness-x/draft/claude-code/publish", payload: { version: "1.0.0" }, headers: headers() });
    const delRes = await app.inject({ method: "DELETE", url: "/api/v1/skills/harness-x", headers: headers() });
    expect(delRes.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: "/api/v1/skills/harness-x", headers: headers() });
    expect(after.statusCode).toBe(404);
    expect(after.json().error.code).toBe("SKILL_NOT_FOUND");
  });

  it("upload rejects sensitive high-risk content", async () => {
    const up = multipart([
      { path: "SKILL.md", content: skillMd("harness-x") },
      { path: "secret.md", content: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----" }
    ]);
    const res = await app.inject({ method: "POST", url: "/api/v1/skills/draft?agent=claude-code", payload: up.payload, headers: { ...headers(), ...up.headers } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("SENSITIVE_CONTENT_BLOCKED");
  });

  it("upload rejects missing agent query param (API-006)", async () => {
    const up = multipart(filesX);
    const res = await app.inject({ method: "POST", url: "/api/v1/skills/draft", payload: up.payload, headers: { ...headers(), ...up.headers } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
  });

  it("publish rejects non-forward version", async () => {
    await uploadDraft(filesX);
    await app.inject({ method: "POST", url: "/api/v1/skills/harness-x/draft/claude-code/publish", payload: { version: "1.0.0" }, headers: headers() });
    await uploadDraft(filesX);
    const res = await app.inject({ method: "POST", url: "/api/v1/skills/harness-x/draft/claude-code/publish", payload: { version: "0.9.0" }, headers: headers() });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("SKILL_VERSION_NOT_FORWARD");
  });

  it("upload → check → fix-preview → apply-fix → re-check → publish end-to-end (INT-004)", async () => {
    await uploadDraft(filesX);
    await app.inject({ method: "POST", url: "/api/v1/skills/harness-x/draft/claude-code/publish", payload: { version: "1.0.0" }, headers: headers() });

    // 新 draft：frontmatter version=1.0.0, latest=1.0.0 → VERSION red fixable
    await uploadDraft(filesX);

    const checksRes = await app.inject({ method: "POST", url: "/api/v1/skills/harness-x/draft/claude-code/checks", payload: {}, headers: headers() });
    expect(checksRes.statusCode).toBe(200);
    const versionCheck = checksRes.json().items.find((i: { id: string }) => i.id === "VERSION");
    expect(versionCheck.status).toBe("red");
    expect(versionCheck.fixable).toBe(true);

    // fix-preview：只读，返回 patch 不含 fixedIr，不改 draft
    const previewRes = await app.inject({ method: "POST", url: "/api/v1/skills/harness-x/draft/claude-code/fix-preview", payload: { checkIds: null }, headers: headers() });
    expect(previewRes.statusCode).toBe(200);
    const plan = previewRes.json();
    expect(plan.summary.autoCount).toBeGreaterThan(0);
    expect(plan.mergedFiles.length).toBeGreaterThanOrEqual(1);
    expect(plan).not.toHaveProperty("fixedIr");

    // apply-fix：mutation+audit，更新 frontmatter version，清 checks
    const applyRes = await app.inject({ method: "POST", url: "/api/v1/skills/harness-x/draft/claude-code/apply-fix", payload: { checkIds: null }, headers: headers() });
    expect(applyRes.statusCode).toBe(200);
    const draft = applyRes.json();
    // 新模型：version 写入 SKILL.md frontmatter（非 ir.version）
    expect(frontmatterField(draft, "version")).toBe("1.0.1");
    expect(draft.checks).toBeNull();

    // re-check：VERSION green（frontmatter version=1.0.1 > latest 1.0.0）
    const recheckRes = await app.inject({ method: "POST", url: "/api/v1/skills/harness-x/draft/claude-code/checks", payload: {}, headers: headers() });
    expect(recheckRes.statusCode).toBe(200);
    const reVersion = recheckRes.json().items.find((i: { id: string }) => i.id === "VERSION");
    expect(reVersion.status).toBe("green");

    // publish 1.0.1 成功（版本前进）
    const pubRes = await app.inject({ method: "POST", url: "/api/v1/skills/harness-x/draft/claude-code/publish", payload: { version: "1.0.1" }, headers: headers() });
    expect(pubRes.statusCode).toBe(200);
    expect(pubRes.json().version).toBe("1.0.1");
  });

  it("apply-fix is idempotent by Idempotency-Key (API-009)", async () => {
    await uploadDraft(filesX);
    await app.inject({ method: "POST", url: "/api/v1/skills/harness-x/draft/claude-code/publish", payload: { version: "1.0.0" }, headers: headers() });
    await uploadDraft(filesX);
    await app.inject({ method: "POST", url: "/api/v1/skills/harness-x/draft/claude-code/checks", payload: {}, headers: headers() });
    const key = uuidV7();
    const body = { checkIds: null };
    const first = await app.inject({ method: "POST", url: "/api/v1/skills/harness-x/draft/claude-code/apply-fix", payload: body, headers: headers({ "idempotency-key": key }) });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "POST", url: "/api/v1/skills/harness-x/draft/claude-code/apply-fix", payload: body, headers: headers({ "idempotency-key": key }) });
    expect(second.statusCode).toBe(200);
    expect(second.json().revision).toBe(first.json().revision);
  });

  it("apply-fix rejects without auth (API-012)", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/skills/harness-x/draft/claude-code/apply-fix", payload: { checkIds: null }, headers: { "x-request-id": uuidV7(), "idempotency-key": uuidV7() } });
    expect(res.statusCode).toBe(401);
  });

  it("apply-fix writes audit event skill.draft.fix-applied (API-008)", async () => {
    await uploadDraft(filesX);
    await app.inject({ method: "POST", url: "/api/v1/skills/harness-x/draft/claude-code/publish", payload: { version: "1.0.0" }, headers: headers() });
    await uploadDraft(filesX);
    await app.inject({ method: "POST", url: "/api/v1/skills/harness-x/draft/claude-code/checks", payload: {}, headers: headers() });
    const res = await app.inject({ method: "POST", url: "/api/v1/skills/harness-x/draft/claude-code/apply-fix", payload: { checkIds: null }, headers: headers() });
    expect(res.statusCode).toBe(200);
    const events = await repository.listAuditEvents();
    expect(events.some((e) => e.action === "skill.draft.fix-applied")).toBe(true);
  });

  it("upload → check → publish → download cursor end-to-end + per-agent latestVersion (INT-101 / API-104)", async () => {
    const up = multipart(cursorFiles);
    const uploadRes = await app.inject({
      method: "POST", url: "/api/v1/skills/draft?agent=cursor", payload: up.payload,
      headers: { ...headers(), ...up.headers }
    });
    expect(uploadRes.statusCode).toBe(201);

    const checksRes = await app.inject({ method: "POST", url: "/api/v1/skills/harness-cursor/draft/cursor/checks", payload: {}, headers: headers() });
    expect(checksRes.statusCode).toBe(200);

    const pubRes = await app.inject({ method: "POST", url: "/api/v1/skills/harness-cursor/draft/cursor/publish", payload: { version: "1.0.0", releaseNote: "cursor" }, headers: headers() });
    expect(pubRes.statusCode).toBe(200);
    expect(pubRes.json().version).toBe("1.0.0");

    // per-agent publish：只前进 cursor 的 latestVersion；claude-code（默认 agent，无自有版本，默认不 fallback）保持 null
    const skillRes = await app.inject({ method: "GET", url: "/api/v1/skills/harness-cursor", headers: headers() });
    expect(skillRes.statusCode).toBe(200);
    const skill = skillRes.json();
    const byAgent = new Map(skill.agents.map((a: { agent: string }) => [a.agent, a]));
    expect(byAgent.get("cursor")?.latestVersion).toBe("1.0.0");
    expect(byAgent.get("claude-code")?.latestVersion).toBe(null);
    expect(byAgent.get("cursor")?.installTarget).toBe(".cursor/rules/harness-cursor.mdc");

    // API-104 + INT-101: GET /skills/{slug}/artifacts/cursor/download → 200 + cursor zip + X-Content-SHA256
    const dlRes = await app.inject({ method: "GET", url: "/api/v1/skills/harness-cursor/artifacts/cursor/download", headers: headers() });
    expect(dlRes.statusCode).toBe(200);
    expect(dlRes.headers["content-type"]).toBe("application/zip");
    expect(dlRes.headers["x-content-sha256"]).toBeDefined();
  });

  it("per-agent publish is independent across agents (INT-001)", async () => {
    // 发布 cursor@1.0.0
    await uploadDraft(cursorFiles, "cursor");
    await app.inject({ method: "POST", url: "/api/v1/skills/harness-cursor/draft/cursor/checks", payload: {}, headers: headers() });
    const cursorPub = await app.inject({ method: "POST", url: "/api/v1/skills/harness-cursor/draft/cursor/publish", payload: { version: "1.0.0" }, headers: headers() });
    expect(cursorPub.statusCode).toBe(200);
    expect(cursorPub.json().agent).toBe("cursor");

    let skillRes = await app.inject({ method: "GET", url: "/api/v1/skills/harness-cursor", headers: headers() });
    let byAgent = new Map(skillRes.json().agents.map((a: { agent: string }) => [a.agent, a]));
    expect(byAgent.get("cursor")?.latestVersion).toBe("1.0.0");
    // claude-code 无自有版本；default=claude-code 自身不 fallback → null（未受 cursor publish 影响）
    expect(byAgent.get("claude-code")?.latestVersion).toBe(null);

    // 发布 claude-code@1.0.1 — cursor 必须保持 1.0.0 不变
    await uploadDraft(cursorFiles, "claude-code");
    await app.inject({ method: "POST", url: "/api/v1/skills/harness-cursor/draft/claude-code/checks", payload: {}, headers: headers() });
    const ccPub = await app.inject({ method: "POST", url: "/api/v1/skills/harness-cursor/draft/claude-code/publish", payload: { version: "1.0.1" }, headers: headers() });
    expect(ccPub.statusCode).toBe(200);
    expect(ccPub.json().agent).toBe("claude-code");

    skillRes = await app.inject({ method: "GET", url: "/api/v1/skills/harness-cursor", headers: headers() });
    byAgent = new Map(skillRes.json().agents.map((a: { agent: string }) => [a.agent, a]));
    expect(byAgent.get("claude-code")?.latestVersion).toBe("1.0.1");
    expect(byAgent.get("cursor")?.latestVersion).toBe("1.0.0"); // cursor 不受 claude-code publish 影响
  });

  it("GET /skills/:slug/versions?agent= filters by agent; invalid agent → 422 (API-001)", async () => {
    // 前置：跨 2 agent 发布 3 版本（cursor 1.0.0/1.0.1 + claude-code 1.0.0）
    await uploadDraft(cursorFiles, "cursor");
    expect((await app.inject({ method: "POST", url: "/api/v1/skills/harness-cursor/draft/cursor/publish", payload: { version: "1.0.0" }, headers: headers() })).statusCode).toBe(200);
    await uploadDraft(cursorFiles, "cursor");
    expect((await app.inject({ method: "POST", url: "/api/v1/skills/harness-cursor/draft/cursor/publish", payload: { version: "1.0.1" }, headers: headers() })).statusCode).toBe(200);
    await uploadDraft(cursorFiles, "claude-code");
    expect((await app.inject({ method: "POST", url: "/api/v1/skills/harness-cursor/draft/claude-code/publish", payload: { version: "1.0.0" }, headers: headers() })).statusCode).toBe(200);

    // 无 agent → 全部 3 版本
    const allRes = await app.inject({ method: "GET", url: "/api/v1/skills/harness-cursor/versions", headers: headers() });
    expect(allRes.statusCode).toBe(200);
    expect(allRes.json().items).toHaveLength(3);

    // ?agent=cursor → 仅 cursor 2 版本
    const cursorRes = await app.inject({ method: "GET", url: "/api/v1/skills/harness-cursor/versions?agent=cursor", headers: headers() });
    expect(cursorRes.statusCode).toBe(200);
    const cursorItems = cursorRes.json().items;
    expect(cursorItems).toHaveLength(2);
    expect(cursorItems.every((v: { agent: string }) => v.agent === "cursor")).toBe(true);

    // ?agent=claude-code → 仅 claude-code 1 版本
    const ccRes = await app.inject({ method: "GET", url: "/api/v1/skills/harness-cursor/versions?agent=claude-code", headers: headers() });
    expect(ccRes.statusCode).toBe(200);
    expect(ccRes.json().items).toHaveLength(1);
    expect(ccRes.json().items[0].agent).toBe("claude-code");

    // ?agent=<invalid> → 422 VALIDATION_FAILED
    const badRes = await app.inject({ method: "GET", url: "/api/v1/skills/harness-cursor/versions?agent=not-a-real-agent", headers: headers() });
    expect(badRes.statusCode).toBe(422);
    expect(badRes.json().error.code).toBe("VALIDATION_FAILED");
  });

  it("PATCH /skills/:slug/default-agent switches default agent (API-010 / API-012 / API-013)", async () => {
    // 前置：发布 harness-cursor cursor@1.0.0（default 自动推断为 claude-code）
    await uploadDraft(cursorFiles, "cursor");
    await app.inject({ method: "POST", url: "/api/v1/skills/harness-cursor/draft/cursor/publish", payload: { version: "1.0.0" }, headers: headers() });

    const skillRes = await app.inject({ method: "GET", url: "/api/v1/skills/harness-cursor", headers: headers() });
    const revision = skillRes.json().revision;

    // API-010: 200 — 切换默认 agent 到 cursor
    const ok = await app.inject({
      method: "PATCH",
      url: "/api/v1/skills/harness-cursor/default-agent",
      payload: { defaultAgent: "cursor", revision },
      headers: headers()
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().defaultAgent).toBe("cursor");
    expect(ok.json().agents.find((a: { agent: string }) => a.agent === "cursor")?.isDefault).toBe(true);

    // API-012: 422 AGENT_NOT_ENABLED — 新模型所有 installable agent 均 enabled；仅 mcp（非 installable）触发
    const newRevision = ok.json().revision;
    const notEnabled = await app.inject({
      method: "PATCH",
      url: "/api/v1/skills/harness-cursor/default-agent",
      payload: { defaultAgent: "mcp", revision: newRevision },
      headers: headers()
    });
    expect(notEnabled.statusCode).toBe(422);
    expect(notEnabled.json().error.code).toBe("AGENT_NOT_ENABLED");

    // API-013: 409 REVISION_CONFLICT — 旧 revision
    const stale = await app.inject({
      method: "PATCH",
      url: "/api/v1/skills/harness-cursor/default-agent",
      payload: { defaultAgent: "cursor", revision },
      headers: headers()
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("REVISION_CONFLICT");
  });

  it("PATCH /skills/:slug/default-agent rejects without auth (API-014)", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/skills/harness-cursor/default-agent",
      payload: { defaultAgent: "cursor", revision: 1 },
      headers: { "x-request-id": uuidV7(), "idempotency-key": uuidV7() }
    });
    expect(res.statusCode).toBe(401);
  });

  it("uploads cursor and codex drafts and publishes them directly", async () => {
    const cursorUpload = multipart(proposalFiles);
    const cursorDraft = await app.inject({
      method: "POST", url: "/api/v1/skills/draft?agent=cursor",
      payload: cursorUpload.payload,
      headers: { ...headers(), ...cursorUpload.headers }
    });
    expect(cursorDraft.statusCode).toBe(201);

    const cursorPublish = await app.inject({
      method: "POST", url: "/api/v1/skills/harness-proposal/draft/cursor/publish",
      payload: { version: "1.0.0" },
      headers: headers()
    });
    expect(cursorPublish.statusCode).toBe(200);

    const codexUpload = multipart(proposalFiles);
    const codexDraft = await app.inject({
      method: "POST", url: "/api/v1/skills/draft?agent=codex",
      payload: codexUpload.payload,
      headers: { ...headers(), ...codexUpload.headers }
    });
    expect(codexDraft.statusCode).toBe(201);

    const codexPublish = await app.inject({
      method: "POST", url: "/api/v1/skills/harness-proposal/draft/codex/publish",
      payload: { version: "1.0.0" },
      headers: headers()
    });
    expect(codexPublish.statusCode).toBe(200);
  });
});

describe("workflow family end-to-end (API-001~008, INT-001~002, INT-004)", () => {
  let repository: MemoryRepository;
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    repository = new MemoryRepository();
    await repository.createActorWithToken({ actorId: "actor_owner", token });
    app = await createServer({ repository, storage: new MemoryArtifactStorage() });
    const family = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families",
      headers: headers(),
      payload: {
        schema_version: 1,
        slug: "harness",
        displayName: "Harness",
        description: "Default harness workflow family",
        tags: [],
        required_profiles: ["general"]
      }
    });
    expect(family.statusCode).toBe(201);
  });
  afterEach(async () => app.close());

  function headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: "Bearer " + token, "x-request-id": uuidV7(), "idempotency-key": uuidV7(), ...extra };
  }

  const bundleFiles = [
    { path: ".harness-build.json", content: '{"profile":"general"}\n' },
    { path: "manifests/claude-code.json", content: '{"schema_version":1}\n' }
  ];

  async function uploadProfile(files: Array<{ path: string; content: string }>): Promise<number> {
    const up = multipartZip(files);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/harness/draft/profiles/general",
      payload: up.payload,
      headers: { ...headers(), ...up.headers }
    });
    return res.statusCode;
  }

  it("upload → draft → checks → diff → publish → list → versions (API-001~006, INT-001)", async () => {
    expect(await uploadProfile(bundleFiles)).toBe(201);

    const draftRes = await app.inject({ method: "GET", url: "/api/v1/workflow-families/harness/draft", headers: headers() });
    expect(draftRes.statusCode).toBe(200);

    const checksRes = await app.inject({ method: "POST", url: "/api/v1/workflow-families/harness/draft/checks", payload: {}, headers: headers() });
    expect(checksRes.statusCode).toBe(200);

    const diffRes = await app.inject({ method: "GET", url: "/api/v1/workflow-families/harness/draft/diff?profile=general", headers: headers() });
    expect(diffRes.statusCode).toBe(200);

    const pubRes = await app.inject({ method: "POST", url: "/api/v1/workflow-families/harness/publish", payload: { version: "1.0.0", releaseNote: "init" }, headers: headers() });
    expect(pubRes.statusCode).toBe(200);
    expect(pubRes.json().version).toBe("1.0.0");

    const listRes = await app.inject({ method: "GET", url: "/api/v1/workflow-families", headers: headers() });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().items).toHaveLength(1);

    const verRes = await app.inject({ method: "GET", url: "/api/v1/workflow-families/harness/versions", headers: headers() });
    expect(verRes.statusCode).toBe(200);
    expect(verRes.json().items.map((v: { version: string }) => v.version)).toEqual(["1.0.0"]);
  });

  it("version sequence after re-publish (INT-004)", async () => {
    await uploadProfile(bundleFiles);
    await app.inject({ method: "POST", url: "/api/v1/workflow-families/harness/publish", payload: { version: "1.0.0" }, headers: headers() });
    await uploadProfile([
      { path: ".harness-build.json", content: '{"profile":"general","rev":2}\n' },
      bundleFiles[1] ?? { path: "manifests/claude-code.json", content: '{"schema_version":1}\n' }
    ]);
    await app.inject({ method: "POST", url: "/api/v1/workflow-families/harness/publish", payload: { version: "1.0.1" }, headers: headers() });
    const verRes = await app.inject({ method: "GET", url: "/api/v1/workflow-families/harness/versions", headers: headers() });
    expect(verRes.json().items.map((v: { version: string }) => v.version)).toEqual(["1.0.1", "1.0.0"]);
  });

  it("upload empty bundle → 422 WORKFLOW_BUNDLE_EMPTY (API-007)", async () => {
    const up = multipartZip([]);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/harness/draft/profiles/general",
      payload: up.payload,
      headers: { ...headers(), ...up.headers }
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("WORKFLOW_BUNDLE_EMPTY");
  });

  it("upload without token → 401 (API-008)", async () => {
    const up = multipart(bundleFiles);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/harness/draft/profiles/general",
      payload: up.payload,
      headers: up.headers
    });
    expect(res.statusCode).toBe(401);
  });

  it("uploadDraft boundary redirects workflow bundle zip (INT-002)", async () => {
    const up = multipartZip([{ path: "workflow.yaml", content: "name: w" }, { path: "skills/foo.md", content: "x" }]);
    const res = await app.inject({ method: "POST", url: "/api/v1/skills/draft?agent=claude-code", payload: up.payload, headers: { ...headers(), ...up.headers } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("WORKFLOW_PACKAGE_REDIRECT");
    expect(res.json().error.details.redirect).toBe("workflow-families");
  });
});
