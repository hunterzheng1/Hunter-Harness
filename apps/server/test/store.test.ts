import { describe, expect, it } from "vitest";
import AdmZip from "adm-zip";

import { sha256Bytes } from "@hunter-harness/core";
import type { SourceFile, RegistryAgent } from "@hunter-harness/contracts";

import { RegistryStore } from "../src/registry/store.js";
import type { RegistryPersistence } from "../src/registry/persistence.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";

const skillMd = `---
name: harness-x
description: demo skill
kind: governance
triggers: ["run"]
inputs: ["ctx"]
outputs: ["out"]
forbidden_actions: ["automatic_git_write"]
required_context: ["AGENTS.md"]
version: "1.0.0"
---

# harness-x
demo skill body
`;

// cursor entry（.mdc），多 agent fixture 用（claude-code 找 SKILL.md，cursor 找 .mdc）
const cursorMdc = `---
name: harness-x
description: demo skill
version: "1.0.0"
adapter: cursor
---
cursor rule body
`;

const files: SourceFile[] = [{ path: "SKILL.md", content: skillMd }];
const filesMulti: SourceFile[] = [{ path: "SKILL.md", content: skillMd }, { path: "harness-x.mdc", content: cursorMdc }];

const CC = "claude-code" as RegistryAgent;
const CURSOR = "cursor" as RegistryAgent;
const CODEX = "codex" as RegistryAgent;

class MemoryPersistence implements RegistryPersistence {
  snapshot: unknown = null;
  async load(): Promise<unknown | null> { return this.snapshot; }
  async save(snapshot: unknown): Promise<void> { this.snapshot = snapshot; }
}

function newStore(persistence?: RegistryPersistence): RegistryStore {
  return new RegistryStore(new MemoryArtifactStorage(), persistence);
}

// 多数 publish 用例的前置：建单 agent 草稿并发布
async function setupPublished(
  store: RegistryStore,
  agent: RegistryAgent = CC,
  version = "1.0.0",
  filesArg: SourceFile[] = files
): Promise<void> {
  await store.upsertDraft({ slug: "harness-x", agent, sourceFiles: filesArg, draftVersion: "0.1.0" });
  await store.publish({ slug: "harness-x", agent, version, actorId: "owner" });
}

// 从 draft.sourceFiles 的 entry frontmatter 提取字段（取代旧 draft.ir.* 断言）
function frontmatterField(draft: { sourceFiles: SourceFile[] } | undefined, field: string): string | undefined {
  const entry = draft?.sourceFiles.find((f) => f.path === "SKILL.md");
  if (entry === undefined) return undefined;
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(entry.content);
  if (m === null) return undefined;
  const fm = m[1] ?? "";
  const line = fm.split("\n").find((l) => l.startsWith(field + ":"));
  return line?.slice((field + ":").length).trim().replace(/^["']|["']$/g, "");
}

describe("RegistryStore per-agent drafts CRUD (UT-001~007)", () => {
  it("uploadDraft 指定 agent 建 draft，draftVersion=0.1.0 (UT-001)", async () => {
    const store = newStore();
    const draft = await store.uploadDraft({ files: filesMulti, actorId: "owner", agent: CURSOR });
    expect(draft.agent).toBe(CURSOR);
    expect(draft.draftVersion).toBe("0.1.0");
    expect(store.getDraft("harness-x", CURSOR)?.agent).toBe(CURSOR);
  });

  it("同一 slug 不同 agent 各建独立 draft，互不影响 (UT-002)", async () => {
    const store = newStore();
    await store.uploadDraft({ files: filesMulti, actorId: "owner", agent: CC });
    await store.uploadDraft({ files: filesMulti, actorId: "owner", agent: CURSOR });
    expect(store.getDraft("harness-x", CC)?.agent).toBe(CC);
    expect(store.getDraft("harness-x", CURSOR)?.agent).toBe(CURSOR);
    // 删 claude-code 不影响 cursor
    await store.deleteDraft("harness-x", CC, 1);
    expect(store.getDraft("harness-x", CC)).toBeUndefined();
    expect(store.getDraft("harness-x", CURSOR)?.agent).toBe(CURSOR);
  });

  // uploadDraft 通用边界（#3 workflow package change 合并保留；适配 #1 per-agent 签名，调用补 agent: CC）
  describe("uploadDraft (task 10)", () => {
    it("parses files and creates a draft with derived slug", async () => {
      const store = newStore();
      const draft = await store.uploadDraft({ files, actorId: "owner", agent: CC });
      expect(draft.slug).toBe("harness-x");
      expect(draft.sourceFiles).toHaveLength(1);
      expect(draft.draftVersion).toBe("0.1.0");
    });

    it("blocks on sensitive high-risk content", async () => {
      const store = newStore();
      const bad = [{ path: "SKILL.md", content: skillMd }, { path: "secret.md", content: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----" }];
      await expect(store.uploadDraft({ files: bad, actorId: "owner", agent: CC })).rejects.toMatchObject({ code: "SENSITIVE_CONTENT_BLOCKED" });
    });

    it("blocks on schema-invalid IR", async () => {
      const store = newStore();
      await expect(store.uploadDraft({ files: [{ path: "SKILL.md", content: ":bad" }], actorId: "owner", agent: CC })).rejects.toMatchObject({ code: "SKILL_VALIDATION_FAILED" });
    });

    it("rejects unsafe file path with SKILL_VALIDATION_FAILED (UT-037)", async () => {
      const store = newStore();
      await expect(store.uploadDraft({
        files: [{ path: "../escape.md", content: "x" }],
        actorId: "owner",
        agent: CC
      })).rejects.toMatchObject({ code: "SKILL_VALIDATION_FAILED" });
    });

    it("redirects workflow package to workflow center (UT-020, workflow.yaml + skills/)", async () => {
      const store = newStore();
      await expect(store.uploadDraft({
        files: [
          { path: "workflow.yaml", content: "name: w" },
          { path: "skills/foo.md", content: "x" }
        ],
        actorId: "owner",
        agent: CC
      })).rejects.toMatchObject({ code: "WORKFLOW_PACKAGE_REDIRECT", details: { redirect: "workflow-packages" } });
    });

    it("redirects workflow package with agents/ dir (UT-022)", async () => {
      const store = newStore();
      await expect(store.uploadDraft({
        files: [
          { path: "workflow.yaml", content: "name: w" },
          { path: "agents/a.md", content: "x" }
        ],
        actorId: "owner",
        agent: CC
      })).rejects.toMatchObject({ code: "WORKFLOW_PACKAGE_REDIRECT" });
    });
  });

  it("getDraft 取指定 agent (UT-003)", async () => {
    const store = newStore();
    await store.upsertDraft({ slug: "harness-x", agent: CC, sourceFiles: files, draftVersion: "0.1.0" });
    await store.upsertDraft({ slug: "harness-x", agent: CURSOR, sourceFiles: files, draftVersion: "0.2.0" });
    expect(store.getDraft("harness-x", CC)?.draftVersion).toBe("0.1.0");
    expect(store.getDraft("harness-x", CURSOR)?.draftVersion).toBe("0.2.0");
  });

  it("getDraft 不存在的 agent 返回 undefined（路由层映射 404 DRAFT_NOT_FOUND）(UT-004)", async () => {
    const store = newStore();
    await store.upsertDraft({ slug: "harness-x", agent: CC, sourceFiles: files, draftVersion: "0.1.0" });
    expect(store.getDraft("harness-x", CODEX)).toBeUndefined();
  });

  it("runChecks 按 agent 写 checks，仅该 agent draft 更新 (UT-005)", async () => {
    const store = newStore();
    await store.upsertDraft({ slug: "harness-x", agent: CC, sourceFiles: files, draftVersion: "0.1.0" });
    await store.upsertDraft({ slug: "harness-x", agent: CURSOR, sourceFiles: files, draftVersion: "0.1.0" });
    await store.runChecks({ slug: "harness-x", agent: CURSOR, checkedAt: "2026-06-30T00:00:00Z" });
    expect(store.getDraft("harness-x", CURSOR)?.checks).not.toBeNull();
    expect(store.getDraft("harness-x", CC)?.checks).toBeNull();
  });

  it("deleteDraft 按 agent 删，仅删该 agent draft (UT-006)", async () => {
    const store = newStore();
    await store.upsertDraft({ slug: "harness-x", agent: CC, sourceFiles: files, draftVersion: "0.1.0" });
    await store.upsertDraft({ slug: "harness-x", agent: CURSOR, sourceFiles: files, draftVersion: "0.1.0" });
    await store.deleteDraft("harness-x", CC, 1);
    expect(store.getDraft("harness-x", CC)).toBeUndefined();
    expect(store.getDraft("harness-x", CURSOR)?.agent).toBe(CURSOR);
  });

  it("deleteDraft DRAFT_NOT_FOUND 404 when (slug,agent) missing (UT-006)", async () => {
    const store = newStore();
    await store.upsertDraft({ slug: "harness-x", agent: CC, sourceFiles: files, draftVersion: "0.1.0" });
    await expect(store.deleteDraft("harness-x", CURSOR, 1)).rejects.toMatchObject({ code: "DRAFT_NOT_FOUND", status: 404 });
  });

  it("deleteDraft REVISION_CONFLICT 409 (UT-006)", async () => {
    const store = newStore();
    await store.upsertDraft({ slug: "harness-x", agent: CC, sourceFiles: files, draftVersion: "0.1.0" });
    await expect(store.deleteDraft("harness-x", CC, 999)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  });

  it("applyDraftFix 按 agent，仅该 agent draft.ir 更新 (UT-007)", async () => {
    const store = newStore();
    // 先发布 CC 建立 latest_version（buildFixPatch 的 ir.version bump 依赖 latestVersion）
    await setupPublished(store, CC, "1.0.0", files);
    await store.upsertDraft({ slug: "harness-x", agent: CC, sourceFiles: files, draftVersion: "0.1.0" });
    await store.upsertDraft({ slug: "harness-x", agent: CURSOR, sourceFiles: files, draftVersion: "0.1.0" });
    await store.runChecks({ slug: "harness-x", agent: CC, checkedAt: "2026-06-30T00:00:00Z" });
    await store.runChecks({ slug: "harness-x", agent: CURSOR, checkedAt: "2026-06-30T00:00:00Z" });
    const beforeCursor = store.getDraft("harness-x", CURSOR);
    await store.applyDraftFix("harness-x", CC, null);
    // claude-code draft ir.version bumped；cursor draft 不变
    expect(frontmatterField(store.getDraft("harness-x", CC), "version")).toBe("1.0.1");
    expect(store.getDraft("harness-x", CC)?.checks).toBeNull();
    expect(frontmatterField(store.getDraft("harness-x", CURSOR), "version")).toBe(frontmatterField(beforeCursor, "version"));
    expect(store.getDraft("harness-x", CURSOR)?.checks).not.toBeNull();
  });

  it("upsertDraft bumps revision per-agent and persists across reload", async () => {
    const p = new MemoryPersistence();
    const store = newStore(p);
    const d1 = await store.upsertDraft({ slug: "harness-x", agent: CC, sourceFiles: files, draftVersion: "0.1.0" });
    expect(d1.revision).toBe(1);
    const d2 = await store.upsertDraft({ slug: "harness-x", agent: CC, sourceFiles: files, draftVersion: "0.1.0" });
    expect(d2.revision).toBe(2);
    // 其他 agent 独立 revision 序列
    const dc = await store.upsertDraft({ slug: "harness-x", agent: CURSOR, sourceFiles: files, draftVersion: "0.1.0" });
    expect(dc.revision).toBe(1);
    const reloaded = newStore(p);
    await reloaded.initialize();
    expect(reloaded.getDraft("harness-x", CC)?.revision).toBe(2);
    expect(reloaded.getDraft("harness-x", CURSOR)?.agent).toBe(CURSOR);
  });
});

describe("RegistryStore per-agent publish (UT-010~014)", () => {
  it("publish 只产当前 agent 的 1 个 artifact，其他 agent latestVersion 不变 (UT-010)", async () => {
    const store = newStore();
    await store.upsertDraft({ slug: "harness-x", agent: CURSOR, sourceFiles: filesMulti, draftVersion: "0.1.0" });
    const v = await store.publish({ slug: "harness-x", agent: CURSOR, version: "1.0.0", actorId: "owner" });
    expect(v.agent).toBe(CURSOR);
    expect(v.artifacts).toHaveLength(1);
    expect(v.artifacts[0]?.agent).toBe(CURSOR);
    const skill = store.getSkill("harness-x");
    const byAgent = new Map(skill.agents.map((a) => [a.agent, a]));
    expect(byAgent.get(CURSOR)?.latestVersion).toBe("1.0.0");
    // claude-code 是默认 agent 但未发布 → latestVersion=null（默认 agent 不回退自身）
    expect(byAgent.get(CC)?.latestVersion).toBeNull();
    expect(skill.latest_version).toBe("1.0.0");
    // 草稿按 agent 清除
    expect(store.getDraft("harness-x", CURSOR)).toBeUndefined();
  });

  it("publish 前进当前 agent latestVersion，其他 agent 不变 (UT-011)", async () => {
    const store = newStore();
    await setupPublished(store, CC, "1.0.0", filesMulti);
    await store.upsertDraft({ slug: "harness-x", agent: CURSOR, sourceFiles: filesMulti, draftVersion: "0.1.0" });
    await store.publish({ slug: "harness-x", agent: CURSOR, version: "1.1.0", actorId: "owner" });
    const skill = store.getSkill("harness-x");
    const byAgent = new Map(skill.agents.map((a) => [a.agent, a]));
    expect(byAgent.get(CURSOR)?.latestVersion).toBe("1.1.0");
    expect(byAgent.get(CC)?.latestVersion).toBe("1.0.0");
  });

  it("publish 版本不前进按 agent 序列 → 409 SKILL_VERSION_NOT_FORWARD (UT-012)", async () => {
    const store = newStore();
    await setupPublished(store, CURSOR, "1.0.0", filesMulti);
    await store.upsertDraft({ slug: "harness-x", agent: CURSOR, sourceFiles: filesMulti, draftVersion: "0.1.0" });
    await expect(store.publish({ slug: "harness-x", agent: CURSOR, version: "0.9.0", actorId: "owner" }))
      .rejects.toMatchObject({ code: "SKILL_VERSION_NOT_FORWARD", status: 409 });
  });

  it("per-agent 版本序列独立：claude-code 1.0.0 不阻塞 cursor 1.0.0 (UT-012 独立性)", async () => {
    const store = newStore();
    await setupPublished(store, CC, "1.0.0", filesMulti);
    await store.upsertDraft({ slug: "harness-x", agent: CURSOR, sourceFiles: filesMulti, draftVersion: "0.1.0" });
    // cursor 无前序版本，1.0.0 应通过（即便 == claude-code 的 1.0.0）
    const v = await store.publish({ slug: "harness-x", agent: CURSOR, version: "1.0.0", actorId: "owner" });
    expect(v.agent).toBe(CURSOR);
  });

  it("agentsFor per-agent 独立 latestVersion：cc@1.0.1 + cursor@1.0.2 (UT-013)", async () => {
    const store = newStore();
    await setupPublished(store, CC, "1.0.1", filesMulti);
    await store.upsertDraft({ slug: "harness-x", agent: CURSOR, sourceFiles: filesMulti, draftVersion: "0.1.0" });
    await store.publish({ slug: "harness-x", agent: CURSOR, version: "1.0.2", actorId: "owner" });
    const skill = store.getSkill("harness-x");
    const byAgent = new Map(skill.agents.map((a) => [a.agent, a]));
    expect(byAgent.get(CC)?.latestVersion).toBe("1.0.1");
    expect(byAgent.get(CURSOR)?.latestVersion).toBe("1.0.2");
    expect(skill.latest_version).toBe("1.0.2");
  });

  it("fallback：agent 无专属版本回退默认 agent，sourcePackagePath 标注 (UT-014)", async () => {
    const store = newStore();
    await setupPublished(store, CC, "1.0.1", filesMulti);
    const skill = store.getSkill("harness-x");
    const byAgent = new Map(skill.agents.map((a) => [a.agent, a]));
    // codex 无专属版本，default=claude-code → fallback 到 1.0.1
    expect(byAgent.get(CODEX)?.latestVersion).toBe("1.0.1");
    expect(byAgent.get(CODEX)?.sourcePackagePath).toBe("fallback:claude-code");
    // 默认 agent 自身不 fallback
    expect(byAgent.get(CC)?.sourcePackagePath).toBeNull();
  });

  it("publish artifact content_sha256 matches stored blob bytes", async () => {
    const store = newStore();
    await store.upsertDraft({ slug: "harness-x", agent: CC, sourceFiles: files, draftVersion: "0.1.0" });
    const v = await store.publish({ slug: "harness-x", agent: CC, version: "1.0.0", actorId: "owner" });
    const artifact = v.artifacts[0];
    if (artifact === undefined) throw new Error("artifact missing");
    const bytes = await store.artifactBytes(artifact);
    expect(sha256Bytes(bytes)).toBe(artifact.content_sha256);
  });

  it("publish rejects non-installable agent (mcp) with 422 SKILL_VALIDATION_FAILED (Y-3)", async () => {
    const store = newStore();
    await store.upsertDraft({ slug: "harness-x", agent: "mcp" as RegistryAgent, sourceFiles: files, draftVersion: "0.1.0" });
    await expect(store.publish({ slug: "harness-x", agent: "mcp" as RegistryAgent, version: "1.0.0", actorId: "owner" }))
      .rejects.toMatchObject({ code: "SKILL_VALIDATION_FAILED", status: 422 });
  });
});

describe("RegistryStore per-agent publish manifest + adapterPreview (T12-14)", () => {
  async function publishAgent(store: RegistryStore, agent: RegistryAgent, version: string): Promise<void> {
    await store.upsertDraft({ slug: "harness-x", agent, sourceFiles: filesMulti, draftVersion: "0.1.0" });
    await store.publish({ slug: "harness-x", agent, version, actorId: "owner" });
  }

  it("cursor artifact manifest target_path .cursor/rules + install_mode file", async () => {
    const store = newStore();
    await publishAgent(store, CURSOR, "1.0.0");
    const versions = store.listVersions("harness-x", CURSOR);
    const cursorArt = versions[0]?.artifacts.find((a) => a.agent === CURSOR);
    if (cursorArt === undefined) throw new Error("cursor artifact missing");
    const bytes = await store.artifactBytes(cursorArt);
    const zip = new AdmZip(Buffer.from(bytes));
    const manifestEntry = zip.getEntry("hunter-skill.json");
    if (manifestEntry === null) throw new Error("hunter-skill.json missing");
    const manifest = JSON.parse(manifestEntry.getData().toString("utf8"));
    expect(manifest.agent).toBe(CURSOR);
    expect(manifest.target_path).toBe(".cursor/rules/harness-x.mdc");
    expect(manifest.install_mode).toBe("file");
  });

  it("codex artifact manifest install_mode managed_block + block_id", async () => {
    const store = newStore();
    await publishAgent(store, CODEX, "1.0.0");
    const versions = store.listVersions("harness-x", CODEX);
    const codexArt = versions[0]?.artifacts.find((a) => a.agent === CODEX);
    if (codexArt === undefined) throw new Error("codex artifact missing");
    const bytes = await store.artifactBytes(codexArt);
    const zip = new AdmZip(Buffer.from(bytes));
    const manifestEntry = zip.getEntry("hunter-skill.json");
    if (manifestEntry === null) throw new Error("hunter-skill.json missing");
    const manifest = JSON.parse(manifestEntry.getData().toString("utf8"));
    expect(manifest.agent).toBe(CODEX);
    expect(manifest.install_mode).toBe("managed_block");
    expect(manifest.block_id).toBe("harness-skill-harness-x");
  });

  it("publish fills installTarget for every enabled installable agent (UT-101 修正)", async () => {
    const store = newStore();
    await publishAgent(store, CURSOR, "1.0.0");
    const skill = store.getSkill("harness-x");
    const byAgent = new Map(skill.agents.map((a) => [a.agent, a]));
    // 4 个 enabled installable agent 都在 agents，mcp 不在
    expect(byAgent.get(CURSOR)?.installTarget).toBe(".cursor/rules/harness-x.mdc");
    expect(byAgent.get(CODEX)?.installTarget).toBe("AGENTS.md");
    expect(byAgent.get("generic")?.installTarget).toBe(".agent-skills/harness-x.md");
    expect(byAgent.get(CC)?.installTarget).toBe(".claude/skills/harness-x/");
    expect(byAgent.get("mcp")).toBeUndefined();
    expect(skill.defaultAgent).toBe(CC);
  });

  it("adapterPreview returns sourceFiles + installTarget per agent (API-005~007)", async () => {
    const store = newStore();
    await publishAgent(store, CC, "1.0.0");
    await publishAgent(store, CURSOR, "1.0.0");
    await publishAgent(store, CODEX, "1.0.0");
    const cc = store.adapterPreview("harness-x", CC);
    expect(cc.installTarget).toBe(".claude/skills/harness-x/");
    expect(cc.sourceFiles.some((f) => f.path === "SKILL.md")).toBe(true);
    const cursor = store.adapterPreview("harness-x", CURSOR);
    expect(cursor.installTarget).toBe(".cursor/rules/harness-x.mdc");
    const codex = store.adapterPreview("harness-x", CODEX);
    expect(codex.installTarget).toBe("AGENTS.md");
  });

  it("adapterPreview mcp throws 422 ADAPTER_NOT_IMPLEMENTED (API-008)", async () => {
    const store = newStore();
    await publishAgent(store, CC, "1.0.0");
    let caught: unknown = null;
    try { store.adapterPreview("harness-x", "mcp"); } catch (e) { caught = e; }
    expect(caught).toMatchObject({ code: "ADAPTER_NOT_IMPLEMENTED", status: 422 });
  });
});

describe("RegistryStore setDefaultAgent (UT-015~017)", () => {
  async function setupMulti(store: RegistryStore): Promise<void> {
    await setupPublished(store, CC, "1.0.0", filesMulti);
  }

  it("setDefaultAgent 切换默认 agent (UT-015)", async () => {
    const store = newStore();
    await setupMulti(store);
    const before = store.getSkill("harness-x");
    const updated = await store.setDefaultAgent("harness-x", CURSOR, before.revision);
    expect(updated.defaultAgent).toBe(CURSOR);
    expect(updated.revision).toBe(before.revision + 1);
    const byAgent = new Map(updated.agents.map((a) => [a.agent, a]));
    expect(byAgent.get(CURSOR)?.isDefault).toBe(true);
    expect(byAgent.get(CC)?.isDefault).toBe(false);
  });

  it("setDefaultAgent agent 未 enabled → 422 AGENT_NOT_ENABLED (UT-016)", async () => {
    const store = newStore();
    await setupMulti(store);
    const before = store.getSkill("harness-x");
    // mcp 非 installable，不在 agents
    await expect(store.setDefaultAgent("harness-x", "mcp" as RegistryAgent, before.revision))
      .rejects.toMatchObject({ code: "AGENT_NOT_ENABLED", status: 422 });
  });

  it("setDefaultAgent revision 冲突 → 409 REVISION_CONFLICT (UT-017)", async () => {
    const store = newStore();
    await setupMulti(store);
    await expect(store.setDefaultAgent("harness-x", CURSOR, 999))
      .rejects.toMatchObject({ code: "REVISION_CONFLICT", status: 409 });
  });

  it("setDefaultAgent 后 fallback 来源切换为新默认 (UT-015 回退语义)", async () => {
    const store = newStore();
    // 只发布 cursor，默认仍是 claude-code（inferred）
    await setupPublished(store, CURSOR, "1.0.0", filesMulti);
    const before = store.getSkill("harness-x");
    // 切默认为 cursor（cursor 有版本）
    await store.setDefaultAgent("harness-x", CURSOR, before.revision);
    const skill = store.getSkill("harness-x");
    const byAgent = new Map(skill.agents.map((a) => [a.agent, a]));
    expect(byAgent.get(CC)?.latestVersion).toBe("1.0.0");
    expect(byAgent.get(CC)?.sourcePackagePath).toBe("fallback:cursor");
  });
});

describe("RegistryStore listVersions agent filter (UT-018)", () => {
  it("listVersions 按 agent 过滤", async () => {
    const store = newStore();
    await setupPublished(store, CC, "1.0.0", filesMulti);
    await store.upsertDraft({ slug: "harness-x", agent: CURSOR, sourceFiles: filesMulti, draftVersion: "0.1.0" });
    await store.publish({ slug: "harness-x", agent: CURSOR, version: "1.0.1", actorId: "owner" });

    const ccOnly = store.listVersions("harness-x", CC);
    expect(ccOnly).toHaveLength(1);
    expect(ccOnly[0]?.agent).toBe(CC);
    const cursorOnly = store.listVersions("harness-x", CURSOR);
    expect(cursorOnly).toHaveLength(1);
    expect(cursorOnly[0]?.agent).toBe(CURSOR);
    expect(cursorOnly[0]?.version).toBe("1.0.1");
    const all = store.listVersions("harness-x");
    expect(all).toHaveLength(2);
  });
});

describe("RegistryStore migration v2→v3 (UT-020~022)", () => {
  it("schemaVersion=2 snapshot 旧 drafts slug-only → 迁到 v3 嵌套，draft 落默认 agent (UT-020)", async () => {
    const p = new MemoryPersistence();
    // 旧 drafts 格式：[[slug, DraftState-without-agent]]
    const oldDraft = {
      slug: "harness-x",
      sourceFiles: files,
      draftVersion: "0.1.0",
      checks: null,
      releaseNote: null,
      revision: 1,
      created_at: "2026-06-20T00:00:00Z",
      updated_at: "2026-06-20T00:00:00Z"
    };
    p.snapshot = {
      schemaVersion: 2,
      compilerVersion: "1.0.0",
      skills: [],
      proposals: [],
      tags: [],
      workflows: [],
      projectBindings: [],
      drafts: [["harness-x", oldDraft]]
    };
    const store = newStore(p);
    await store.initialize();
    // 旧 draft 迁到默认 agent claude-code
    expect(store.getDraft("harness-x", CC)?.agent).toBe(CC);
    expect(store.getDraft("harness-x", CC)?.draftVersion).toBe("0.1.0");
    // persist 后为嵌套格式
    await store.persist();
    const snap = p.snapshot as { drafts: Array<[string, unknown]> };
    const inner = snap.drafts[0]?.[1];
    expect(Array.isArray(inner)).toBe(true);
  });

  it("旧 version 无 agent 字段迁移补默认 agent (UT-021)", async () => {
    const p = new MemoryPersistence();
    p.snapshot = {
      schemaVersion: 2,
      compilerVersion: "1.0.0",
      skills: [["harness-x", {
        detail: {
          skill_id: "skl_1", slug: "harness-x", name: "harness-x", description: "d",
          tags: [], status: "published", latest_version: "1.0.0",
          agents: [{ agent: CC, enabled: true, isDefault: true, installTarget: ".claude/skills/harness-x/", latestVersion: "1.0.0", draftVersion: null, sourcePackagePath: null }],
          defaultAgent: CC,
          revision: 1, created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z"
        },
        versions: [{ skill_slug: "harness-x", version: "1.0.0", artifacts: [], source_proposal_id: null, created_at: "2026-06-20T00:00:00Z" }]
      }]],
      proposals: [], tags: [], workflows: [], projectBindings: [], drafts: []
    };
    const store = newStore(p);
    await store.initialize();
    const versions = store.listVersions("harness-x");
    expect(versions[0]?.agent).toBe(CC);
  });

  it("draft 无 agent 迁默认 agent claude-code (UT-022)", async () => {
    const p = new MemoryPersistence();
    const oldDraft = {
      slug: "harness-x",
      sourceFiles: files,
      draftVersion: "0.1.0",
      checks: null,
      releaseNote: null,
      revision: 1,
      created_at: "2026-06-20T00:00:00Z",
      updated_at: "2026-06-20T00:00:00Z"
    };
    p.snapshot = {
      schemaVersion: 2,
      compilerVersion: "1.0.0",
      skills: [], proposals: [], tags: [], workflows: [], projectBindings: [],
      drafts: [["harness-x", oldDraft]]
    };
    const store = newStore(p);
    await store.initialize();
    // mcp 非 draft agent（迁默认 CC）；mcp draft 不存在
    expect(store.getDraft("harness-x", CC)?.agent).toBe(CC);
    expect(store.getDraft("harness-x", "mcp" as RegistryAgent)).toBeUndefined();
  });
});

describe("RegistryStore persist nested drafts (UT-031)", () => {
  it("persist 序列化嵌套 drafts [[slug,[[agent,DraftState]]]]", async () => {
    const p = new MemoryPersistence();
    const store = newStore(p);
    await store.upsertDraft({ slug: "harness-x", agent: CC, sourceFiles: files, draftVersion: "0.1.0" });
    await store.upsertDraft({ slug: "harness-x", agent: CURSOR, sourceFiles: files, draftVersion: "0.2.0" });
    await store.persist();
    const snap = p.snapshot as { schemaVersion: number; drafts: Array<[string, Array<[string, unknown]>]> };
    expect(snap.schemaVersion).toBe(4);
    const entry = snap.drafts.find(([s]) => s === "harness-x");
    expect(entry).toBeDefined();
    const inner = entry?.[1] ?? [];
    expect(inner.map(([a]) => a).sort()).toEqual([CC, CURSOR].sort());
    // round-trip
    const reloaded = newStore(p);
    await reloaded.initialize();
    expect(reloaded.getDraft("harness-x", CC)?.draftVersion).toBe("0.1.0");
    expect(reloaded.getDraft("harness-x", CURSOR)?.draftVersion).toBe("0.2.0");
  });
});

describe("RegistryStore uploadDraft validation", () => {
  it("parses files and creates a draft with derived slug", async () => {
    const store = newStore();
    const draft = await store.uploadDraft({ files, actorId: "owner", agent: CC });
    expect(draft.slug).toBe("harness-x");
    expect(draft.agent).toBe(CC);
    expect(draft.draftVersion).toBe("0.1.0");
  });

  it("blocks on sensitive high-risk content", async () => {
    const store = newStore();
    const bad = [{ path: "SKILL.md", content: skillMd }, { path: "secret.md", content: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----" }];
    await expect(store.uploadDraft({ files: bad, actorId: "owner", agent: CC })).rejects.toMatchObject({ code: "SENSITIVE_CONTENT_BLOCKED" });
  });

  it("blocks on schema-invalid IR", async () => {
    const store = newStore();
    await expect(store.uploadDraft({ files: [{ path: "SKILL.md", content: ":bad" }], actorId: "owner", agent: CC })).rejects.toMatchObject({ code: "SKILL_VALIDATION_FAILED" });
  });

  it("rejects unsafe file path with SKILL_VALIDATION_FAILED", async () => {
    const store = newStore();
    await expect(store.uploadDraft({
      files: [{ path: "../escape.md", content: "x" }],
      actorId: "owner", agent: CC
    })).rejects.toMatchObject({ code: "SKILL_VALIDATION_FAILED" });
  });

  it("rejects workflow package with WORKFLOW_PACKAGE_REDIRECT (UT-038)", async () => {
    const store = newStore();
    await expect(store.uploadDraft({
      files: [
        { path: "workflow.yaml", content: "name: w" },
        { path: "skills/foo.md", content: "x" }
      ],
      actorId: "owner", agent: CC
    })).rejects.toMatchObject({ code: "WORKFLOW_PACKAGE_REDIRECT", details: { redirect: "workflow-packages" } });
  });

  it("uploadDraft derives draftVersion from that agent's latestVersion", async () => {
    const store = newStore();
    await setupPublished(store, CC, "1.0.0", files);
    const draft = await store.uploadDraft({ files, actorId: "owner", agent: CC });
    expect(draft.draftVersion).toBe("1.0.1");
  });
});

describe("RegistryStore runChecks", () => {
  it("writes draft.checks and returns a result", async () => {
    const store = newStore();
    await store.uploadDraft({ files, actorId: "owner", agent: CC });
    const result = await store.runChecks({ slug: "harness-x", agent: CC, checkedAt: "2026-06-26T00:00:00Z" });
    expect(result.items.length).toBeGreaterThan(0);
    expect(store.getDraft("harness-x", CC)?.checks?.summary).toBeDefined();
  });

  it("throws DRAFT_NOT_FOUND when no draft for agent", async () => {
    const store = newStore();
    await expect(store.runChecks({ slug: "harness-x", agent: CC, checkedAt: "t" })).rejects.toMatchObject({ code: "DRAFT_NOT_FOUND" });
  });
});

describe("RegistryStore publish single-agent", () => {
  it("promotes draft to a new version, clears draft, updates latest_version and agents", async () => {
    const store = newStore();
    await store.uploadDraft({ files, actorId: "owner", agent: CC });
    const v = await store.publish({ slug: "harness-x", agent: CC, version: "1.0.0", releaseNote: "init", actorId: "owner" });
    expect(v.version).toBe("1.0.0");
    expect(v.agent).toBe(CC);
    expect(store.getDraft("harness-x", CC)).toBeUndefined();
    const skill = store.getSkill("harness-x");
    expect(skill.latest_version).toBe("1.0.0");
    expect(skill.agents.find((a) => a.agent === CC)?.latestVersion).toBe("1.0.0");
    expect(skill.defaultAgent).toBe(CC);
  });

  it("rejects non-forward version with 409 SKILL_VERSION_NOT_FORWARD", async () => {
    const store = newStore();
    await store.uploadDraft({ files, actorId: "owner", agent: CC });
    await store.publish({ slug: "harness-x", agent: CC, version: "1.0.0", actorId: "owner" });
    await store.uploadDraft({ files, actorId: "owner", agent: CC });
    await expect(store.publish({ slug: "harness-x", agent: CC, version: "0.9.0", actorId: "owner" }))
      .rejects.toMatchObject({ code: "SKILL_VERSION_NOT_FORWARD", status: 409 });
  });
});

describe("RegistryStore diffDraft + deleteSkill", () => {
  it("diffDraft returns published vs draft differences (per-agent)", async () => {
    const store = newStore();
    const v1Files: SourceFile[] = [{ path: "SKILL.md", content: skillMd }];
    const v2Files: SourceFile[] = [{ path: "SKILL.md", content: skillMd + "\nextra\n" }];
    await store.uploadDraft({ files: v1Files, actorId: "owner", agent: CC });
    await store.publish({ slug: "harness-x", agent: CC, version: "1.0.0", actorId: "owner" });
    await store.uploadDraft({ files: v2Files, actorId: "owner", agent: CC });
    const diff = store.diffDraft("harness-x", CC);
    expect(diff.some((f) => f.status === "modified" && f.path === "SKILL.md")).toBe(true);
  });

  it("diffDraft DRAFT_NOT_FOUND when no draft for agent", () => {
    const store = newStore();
    let caught: unknown = null;
    try { store.diffDraft("harness-x", CC); } catch (e) { caught = e; }
    expect(caught).toMatchObject({ code: "DRAFT_NOT_FOUND" });
  });

  it("deleteSkill removes the skill and all drafts", async () => {
    const store = newStore();
    await store.uploadDraft({ files, actorId: "owner", agent: CC });
    await store.publish({ slug: "harness-x", agent: CC, version: "1.0.0", actorId: "owner" });
    await store.uploadDraft({ files, actorId: "owner", agent: CC });
    await store.deleteSkill({ slug: "harness-x", actorId: "owner" });
    let caught: unknown = null;
    try { store.getSkill("harness-x"); } catch (e) { caught = e; }
    expect(caught).toMatchObject({ code: "SKILL_NOT_FOUND" });
    expect(store.getDraft("harness-x", CC)).toBeUndefined();
  });
});

describe("RegistryStore legacy snapshot compatibility + listSkills", () => {
  it("migrates old snapshot: derives agents, drops category, defaults tag usageCount", async () => {
    const p = new MemoryPersistence();
    p.snapshot = {
      schemaVersion: 1,
      compilerVersion: "1.0.0",
      skills: [["harness-x", {
        detail: {
          skill_id: "skl_1", slug: "harness-x", name: "harness-x", description: "d",
          category: "governance", tags: ["demo"], status: "published", latest_version: "1.0.0",
          adapters: ["claude-code"], revision: 1, created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z"
        },
        versions: [{ skill_slug: "harness-x", version: "1.0.0", artifacts: [], source_proposal_id: null, created_at: "2026-06-20T00:00:00Z" }]
      }]],
      proposals: [],
      tags: [["tag_1", { tag_id: "tag_1", slug: "demo", label: "Demo", active: true, revision: 1, created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z" }]],
      workflows: [],
      projectBindings: []
    };
    const store = newStore(p);
    await store.initialize();
    const skill = store.getSkill("harness-x");
    expect(skill).not.toHaveProperty("category");
    expect(skill.agents).toHaveLength(4); // 新模型：所有 installable agent（fallback default）
    expect(skill.agents.some((a) => a.agent === CC && a.isDefault)).toBe(true);
    expect(skill.defaultAgent).toBe(CC);
    expect(skill.agents[0]?.latestVersion).toBe("1.0.0");
    const tags = store.listTags();
    expect(tags[0]?.usageCount).toBe(1);
  });

  it("listSkills returns empty without category param", () => {
    const store = newStore();
    expect(store.listSkills()).toEqual([]);
  });

  it("skips corrupt skill with invalid version during migration", async () => {
    const p = new MemoryPersistence();
    p.snapshot = {
      schemaVersion: 1,
      compilerVersion: "1.0.0",
      skills: [["harness-corrupt", {
        detail: {
          skill_id: "skl_1", slug: "harness-corrupt", name: "harness-corrupt", description: "d",
          tags: [], status: "published", latest_version: "1.0.0",
          agents: [{ agent: CC, enabled: true, isDefault: true, installTarget: ".claude/skills/harness-corrupt/", latestVersion: "1.0.0", draftVersion: null, sourcePackagePath: null }],
          defaultAgent: CC,
          revision: 1, created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z"
        },
        versions: [{ skill_slug: "harness-corrupt", version: "NOT_SEMVER", agent: CC, artifacts: [], source_proposal_id: null, created_at: "2026-06-20T00:00:00Z" }]
      }]],
      proposals: [], tags: [], workflows: [], projectBindings: []
    };
    const store = newStore(p);
    await store.initialize();
    expect(() => store.getSkill("harness-corrupt")).toThrow();
  });
});

describe("RegistryStore listTags usage cache", () => {
  function minIr(name: string): SkillIr {
    return {
      name, kind: "tooling", description: "d",
      triggers: ["run"], inputs: [], outputs: ["out"],
      forbidden_actions: [], required_context: [],
      profiles: { general: { enabled: true } },
      adapters: { "claude-code": { enabled: true } },
      version: "1.0.0"
    };
  }

  function snapshotSkill(slug: string, tags: string[]): [string, unknown] {
    return [slug, {
      detail: {
        skill_id: "skl_" + slug, slug, name: slug, description: "d",
        tags, status: "published", latest_version: "1.0.0",
        agents: [{ agent: CC, enabled: true, isDefault: true, installTarget: ".claude/skills/" + slug + "/", latestVersion: "1.0.0", draftVersion: null, sourcePackagePath: null }],
        defaultAgent: CC,
        revision: 1, created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z",
        ir: minIr(slug)
      },
      versions: [{ skill_slug: slug, version: "1.0.0", agent: CC, ir: minIr(slug), artifacts: [], source_proposal_id: null, created_at: "2026-06-20T00:00:00Z" }]
    }];
  }

  function tagEntry(tagId: string, slug: string, label: string): [string, unknown] {
    return [tagId, {
      tag_id: tagId, slug, label, active: true,
      revision: 1, usageCount: 0, created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z"
    }];
  }

  it("returns cached usageCount=2 for two skills bound to same tag", async () => {
    const p = new MemoryPersistence();
    p.snapshot = {
      schemaVersion: 2, compilerVersion: "1.0.0",
      skills: [snapshotSkill("harness-a", ["red"]), snapshotSkill("harness-b", ["red"])],
      proposals: [], tags: [tagEntry("tag_red", "red", "Red")], workflows: [], projectBindings: []
    };
    const store = newStore(p);
    await store.initialize();
    const first = store.listTags().find((t) => t.slug === "red");
    const second = store.listTags().find((t) => t.slug === "red");
    expect(first?.usageCount).toBe(2);
    expect(second?.usageCount).toBe(2);
  });

  it("invalidates cache on bindTag so new tag usageCount updates", async () => {
    const p = new MemoryPersistence();
    p.snapshot = {
      schemaVersion: 2, compilerVersion: "1.0.0",
      skills: [snapshotSkill("harness-a", ["red"])],
      proposals: [], tags: [tagEntry("tag_red", "red", "Red"), tagEntry("tag_blue", "blue", "Blue")], workflows: [], projectBindings: []
    };
    const store = newStore(p);
    await store.initialize();
    expect(store.listTags().find((t) => t.slug === "blue")?.usageCount).toBe(0);
    store.bindTag("harness-a", "tag_blue");
    expect(store.listTags().find((t) => t.slug === "blue")?.usageCount).toBe(1);
  });

  it("invalidates cache on deleteSkill so tag usageCount drops to 0", async () => {
    const p = new MemoryPersistence();
    p.snapshot = {
      schemaVersion: 2, compilerVersion: "1.0.0",
      skills: [snapshotSkill("harness-a", ["red"])],
      proposals: [], tags: [tagEntry("tag_red", "red", "Red")], workflows: [], projectBindings: []
    };
    const store = newStore(p);
    await store.initialize();
    expect(store.listTags().find((t) => t.slug === "red")?.usageCount).toBe(1);
    await store.deleteSkill({ slug: "harness-a", actorId: "owner" });
    expect(store.listTags().find((t) => t.slug === "red")?.usageCount).toBe(0);
  });
});

describe("RegistryStore fix", () => {
  it("buildDraftFix returns patch without persisting", async () => {
    const store = newStore();
    await store.uploadDraft({ files, actorId: "owner", agent: CC });
    await store.publish({ slug: "harness-x", agent: CC, version: "1.0.0", actorId: "owner" });
    await store.uploadDraft({ files, actorId: "owner", agent: CC });
    await store.runChecks({ slug: "harness-x", agent: CC, checkedAt: "2026-06-28T00:00:00Z" });
    const before = store.getDraft("harness-x", CC);
    const plan = await store.buildDraftFix("harness-x", CC, null);
    expect(plan.summary.autoCount).toBeGreaterThan(0);
    expect(store.getDraft("harness-x", CC)).toEqual(before);
  });

  it("applyDraftFix updates ir, bumps revision, clears checks/aiChecks", async () => {
    const store = newStore();
    await store.uploadDraft({ files, actorId: "owner", agent: CC });
    await store.publish({ slug: "harness-x", agent: CC, version: "1.0.0", actorId: "owner" });
    await store.uploadDraft({ files, actorId: "owner", agent: CC });
    await store.runChecks({ slug: "harness-x", agent: CC, checkedAt: "2026-06-28T00:00:00Z" });
    const before = store.getDraft("harness-x", CC);
    expect(before?.checks).not.toBeNull();
    const after = await store.applyDraftFix("harness-x", CC, null);
    expect(after.revision).toBe((before?.revision ?? 0) + 1);
    expect(after.checks).toBeNull();
    expect(after.aiChecks).toBeNull();
    expect(frontmatterField(after, "version")).toBe("1.0.1");
  });

  it("applyDraftFix throws DRAFT_NOT_FOUND when no draft", async () => {
    const store = newStore();
    await expect(store.applyDraftFix("harness-x", CC, null)).rejects.toMatchObject({ code: "DRAFT_NOT_FOUND" });
  });

  it("applyDraftFix blocks on sensitive fixed source", async () => {
    const store = newStore();
    const secretFiles: SourceFile[] = [{ path: "SKILL.md", content: skillMd.replace("demo skill body", "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----") }];
    await store.upsertDraft({ slug: "harness-x", agent: CC, sourceFiles: secretFiles, draftVersion: "0.1.0" });
    await store.runChecks({ slug: "harness-x", agent: CC, checkedAt: "2026-06-28T00:00:00Z" });
    await expect(store.applyDraftFix("harness-x", CC, null)).rejects.toMatchObject({ code: "SENSITIVE_CONTENT_BLOCKED" });
  });
});

describe("RegistryStore AI content generation", () => {
  async function setupDraftWithAiChecks(persistence?: RegistryPersistence): Promise<RegistryStore> {
    const store = newStore(persistence);
    await store.uploadDraft({ files, actorId: "owner", agent: CC });
    await store.setDraftAiChecks({
      slug: "harness-x", agent: CC,
      aiChecks: {
        items: [{ id: "AI_USAGE_EXAMPLES", label: "缺少示例", status: "yellow", message: "建议补充示例", filePath: null, fixable: true }],
        summary: { green: 0, yellow: 1, red: 0 },
        checkedAt: "2026-06-29T00:00:00Z"
      },
      checkedAt: "2026-06-29T00:00:00Z"
    });
    return store;
  }

  it("setDraftReleaseNote writes releaseNote + persists", async () => {
    const p = new MemoryPersistence();
    const store = newStore(p);
    await store.uploadDraft({ files, actorId: "owner", agent: CC });
    const updated = await store.setDraftReleaseNote({ slug: "harness-x", agent: CC, releaseNote: "AI: 新增 X 功能", generatedAt: "2026-06-29T00:00:00.000Z" });
    expect(updated.releaseNote).toBe("AI: 新增 X 功能");
    const reloaded = newStore(p);
    await reloaded.initialize();
    expect(reloaded.getDraft("harness-x", CC)?.releaseNote).toBe("AI: 新增 X 功能");
  });

  it("setDraftReleaseNote throws DRAFT_NOT_FOUND", async () => {
    const store = newStore();
    await expect(store.setDraftReleaseNote({ slug: "nope", agent: CC, releaseNote: "x", generatedAt: "t" })).rejects.toMatchObject({ code: "DRAFT_NOT_FOUND" });
  });

  it("applyFixSuggestion appliesTo=description writes ir.description + clears aiChecks + revision+1", async () => {
    const store = await setupDraftWithAiChecks();
    const before = store.getDraft("harness-x", CC);
    const r = await store.applyFixSuggestion({ slug: "harness-x", agent: CC, checkId: "AI_DESC", suggestedContent: "更清晰的描述", appliesTo: "description", actorId: "owner" });
    expect(frontmatterField(r, "description")).toBe("更清晰的描述");
    expect(r.aiChecks).toBeNull();
    expect(r.revision).toBe((before?.revision ?? 0) + 1);
  });

  it("applyFixSuggestion appliesTo=examples writes draft.examples", async () => {
    const store = await setupDraftWithAiChecks();
    const examples = [{ title: "示例1", description: "演示", request: "做 X", result: "得到 Y" }];
    const r = await store.applyFixSuggestion({ slug: "harness-x", agent: CC, checkId: "AI_USAGE_EXAMPLES", suggestedContent: JSON.stringify(examples), appliesTo: "examples", actorId: "owner" });
    expect(r.examples).toHaveLength(1);
    expect(r.examples[0]?.title).toBe("示例1");
    expect(r.examples[0]?.files).toEqual([]);
  });

  it("applyFixSuggestion appliesTo=instructions writes ir.instructions", async () => {
    const store = await setupDraftWithAiChecks();
    const r = await store.applyFixSuggestion({ slug: "harness-x", agent: CC, checkId: "AI_INSTR", suggestedContent: JSON.stringify(["步骤1", "步骤2"]), appliesTo: "instructions", actorId: "owner" });
    const entry = r.sourceFiles.find((f) => f.path === "SKILL.md")?.content ?? "";
    expect(entry).toContain("步骤1");
    expect(entry).toContain("步骤2");
  });

  it("applyFixSuggestion appliesTo=allowed_capabilities → 422 (新模型不再支持)", async () => {
    const store = await setupDraftWithAiChecks();
    await expect(store.applyFixSuggestion({ slug: "harness-x", agent: CC, checkId: "AI_CAP", suggestedContent: JSON.stringify(["read-files"]), appliesTo: "allowed_capabilities", actorId: "owner" })).rejects.toMatchObject({ code: "SKILL_VALIDATION_FAILED" });
  });

  it("applyFixSuggestion non-writable appliesTo (tags) → 422", async () => {
    const store = await setupDraftWithAiChecks();
    await expect(store.applyFixSuggestion({ slug: "harness-x", agent: CC, checkId: "x", suggestedContent: "t", appliesTo: "tags", actorId: "owner" })).rejects.toMatchObject({ code: "SKILL_VALIDATION_FAILED" });
  });

  it("applyFixSuggestion null appliesTo → 422", async () => {
    const store = await setupDraftWithAiChecks();
    await expect(store.applyFixSuggestion({ slug: "harness-x", agent: CC, checkId: "x", suggestedContent: "t", appliesTo: null, actorId: "owner" })).rejects.toMatchObject({ code: "SKILL_VALIDATION_FAILED" });
  });

  it("applyFixSuggestion invalid appliesTo string → 422", async () => {
    const store = await setupDraftWithAiChecks();
    await expect(store.applyFixSuggestion({ slug: "harness-x", agent: CC, checkId: "x", suggestedContent: "t", appliesTo: "ir.secret", actorId: "owner" })).rejects.toMatchObject({ code: "SKILL_VALIDATION_FAILED" });
  });

  it("applyFixSuggestion examples bad JSON → 422", async () => {
    const store = await setupDraftWithAiChecks();
    await expect(store.applyFixSuggestion({ slug: "harness-x", agent: CC, checkId: "x", suggestedContent: "not json", appliesTo: "examples", actorId: "owner" })).rejects.toMatchObject({ code: "SKILL_VALIDATION_FAILED" });
  });

  it("applyFixSuggestion examples wrong shape → 422", async () => {
    const store = await setupDraftWithAiChecks();
    await expect(store.applyFixSuggestion({ slug: "harness-x", agent: CC, checkId: "x", suggestedContent: JSON.stringify([{ wrong: "shape" }]), appliesTo: "examples", actorId: "owner" })).rejects.toMatchObject({ code: "SKILL_VALIDATION_FAILED" });
  });

  it("applyFixSuggestion instructions non-string item → 422", async () => {
    const store = await setupDraftWithAiChecks();
    await expect(store.applyFixSuggestion({ slug: "harness-x", agent: CC, checkId: "x", suggestedContent: JSON.stringify([123]), appliesTo: "instructions", actorId: "owner" })).rejects.toMatchObject({ code: "SKILL_VALIDATION_FAILED" });
  });

  it("applyFixSuggestion empty description → 422", async () => {
    const store = await setupDraftWithAiChecks();
    await expect(store.applyFixSuggestion({ slug: "harness-x", agent: CC, checkId: "x", suggestedContent: "", appliesTo: "description", actorId: "owner" })).rejects.toMatchObject({ code: "SKILL_VALIDATION_FAILED" });
  });

  it("applyFixSuggestion empty arrays → 422", async () => {
    const store = await setupDraftWithAiChecks();
    for (const target of ["examples", "instructions", "allowed_capabilities"] as const) {
      await expect(store.applyFixSuggestion({ slug: "harness-x", agent: CC, checkId: "x", suggestedContent: "[]", appliesTo: target, actorId: "owner" })).rejects.toMatchObject({ code: "SKILL_VALIDATION_FAILED" });
    }
  });

  it("applyFixSuggestion sensitive content blocked → 422 SENSITIVE_CONTENT_BLOCKED", async () => {
    const store = await setupDraftWithAiChecks();
    await expect(store.applyFixSuggestion({ slug: "harness-x", agent: CC, checkId: "x", suggestedContent: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----", appliesTo: "description", actorId: "owner" })).rejects.toMatchObject({ code: "SENSITIVE_CONTENT_BLOCKED" });
  });

  it("applyFixSuggestion persists + clears aiChecks + revision+1", async () => {
    const p = new MemoryPersistence();
    const store = await setupDraftWithAiChecks(p);
    const before = store.getDraft("harness-x", CC);
    const r = await store.applyFixSuggestion({ slug: "harness-x", agent: CC, checkId: "x", suggestedContent: "新描述", appliesTo: "description", actorId: "owner" });
    expect(r.aiChecks).toBeNull();
    expect(r.revision).toBe((before?.revision ?? 0) + 1);
    const reloaded = newStore(p);
    await reloaded.initialize();
    expect(reloaded.getDraft("harness-x", CC)?.aiChecks).toBeNull();
    expect(frontmatterField(reloaded.getDraft("harness-x", CC), "description")).toBe("新描述");
  });

  it("applyFixSuggestion DRAFT_NOT_FOUND 404", async () => {
    const store = newStore();
    await expect(store.applyFixSuggestion({ slug: "nope", agent: CC, checkId: "x", suggestedContent: "d", appliesTo: "description", actorId: "owner" })).rejects.toMatchObject({ code: "DRAFT_NOT_FOUND" });
  });
});

describe("createProposal + reviewProposal gate (per-agent)", () => {
  it("createProposal agent=cursor passes gate + records requestedAgent", () => {
    const store = newStore();
    const proposal = store.createProposal({ sourceFiles: filesMulti, slug: "harness-x", version: "1.0.0", actorId: "owner", agent: CURSOR });
    expect(proposal.requestedAgent).toBe(CURSOR);
    expect(proposal.status).toBe("pending_review");
  });

  it("createProposal agent=mcp rejected 422 ADAPTER_NOT_INSTALLABLE", () => {
    const store = newStore();
    let caught: unknown = null;
    try { store.createProposal({ sourceFiles: filesMulti, slug: "harness-x", version: "1.0.0", actorId: "owner", agent: "mcp" as RegistryAgent }); } catch (e) { caught = e; }
    expect(caught).toMatchObject({ code: "ADAPTER_NOT_INSTALLABLE", status: 422 });
  });

  it("createProposal agent=cursor without .mdc entry rejected 422 SKILL_ENTRY_NOT_FOUND", () => {
    const store = newStore();
    let caught: unknown = null;
    try { store.createProposal({ sourceFiles: files, slug: "harness-x", version: "1.0.0", actorId: "owner", agent: CURSOR }); } catch (e) { caught = e; }
    expect(caught).toMatchObject({ code: "SKILL_ENTRY_NOT_FOUND", status: 422 });
  });

  it("reviewProposal approve publishes only requestedAgent artifact (per-agent)", async () => {
    const store = newStore();
    const proposal = store.createProposal({ sourceFiles: filesMulti, slug: "harness-x", version: "1.0.0", actorId: "owner", agent: CURSOR });
    const review = await store.reviewProposal({ proposalId: proposal.proposal_id, actorId: "reviewer", decision: "approve", comment: null });
    expect(review.status).toBe("approved");
    expect(review.publishedArtifacts).toHaveLength(1);
    expect(review.publishedArtifacts[0]?.agent).toBe(CURSOR);
    const skill = store.getSkill("harness-x");
    const byAgent = new Map(skill.agents.map((a) => [a.agent, a]));
    expect(byAgent.get(CURSOR)?.latestVersion).toBe("1.0.0");
    expect(byAgent.get(CC)?.latestVersion).toBeNull();
  });

  it("reviewProposal reject produces no artifacts", async () => {
    const store = newStore();
    const proposal = store.createProposal({ sourceFiles: filesMulti, slug: "harness-x", version: "1.0.0", actorId: "owner", agent: CURSOR });
    const review = await store.reviewProposal({ proposalId: proposal.proposal_id, actorId: "reviewer", decision: "reject", comment: "no" });
    expect(review.status).toBe("rejected");
    expect(review.publishedArtifacts).toEqual([]);
  });
});

describe("RegistryStore workflow package boundary + persistence (UT-021, UT-030~031)", () => {
  const wpYaml = `key: release-flow
name: Release Flow
description: End-to-end release workflow
profile: general
skills:
  - slug: harness-sync
    ref: "1.0.0"
agents:
  - path: agents/release.md
    ref: main
protocols: []
templates: []
execution_order:
  - harness-sync
strategy: sequential
`;
  const wpFiles: SourceFile[] = [
    { path: "workflow.yaml", content: wpYaml },
    { path: "agents/release.md", content: "# Release agent" }
  ];

  it("uploadDraft single skill goes to skill draft, not redirect (UT-021)", async () => {
    const store = newStore();
    const draft = await store.uploadDraft({ files, actorId: "owner", agent: CC });
    expect(draft.slug).toBe("harness-x");
  });

  it("old snapshot without workflowPackages migrates to empty (UT-030)", async () => {
    const p = new MemoryPersistence();
    p.snapshot = {
      compilerVersion: "1.0.0",
      skills: [], proposals: [], tags: [], workflows: [], drafts: []
    };
    const store = newStore(p);
    await store.initialize();
    expect(store.listWorkflowPackages()).toEqual([]);
  });

  it("persist serializes workflowPackages + drafts (UT-031)", async () => {
    const p = new MemoryPersistence();
    const store = newStore(p);
    await store.uploadWorkflowPackage({ files: wpFiles, actorId: "owner" });
    await store.publishWorkflowPackage("release-flow", { version: "1.0.0", actorId: "owner" });
    const snap = p.snapshot as { workflowPackages: unknown[]; workflowPackageDrafts: unknown[] };
    expect(Array.isArray(snap.workflowPackages)).toBe(true);
    expect(snap.workflowPackages.length).toBe(1);
  });

  it("workflow package survives reload round-trip", async () => {
    const p = new MemoryPersistence();
    let store = newStore(p);
    await store.uploadWorkflowPackage({ files: wpFiles, actorId: "owner" });
    await store.publishWorkflowPackage("release-flow", { version: "1.0.0", actorId: "owner" });
    store = newStore(p);
    await store.initialize();
    const pkg = store.getWorkflowPackage("release-flow");
    expect(pkg?.latestVersion).toBe("1.0.0");
    expect(store.listWorkflowPackageVersions("release-flow").map((v) => v.version)).toEqual(["1.0.0"]);
  });
});
