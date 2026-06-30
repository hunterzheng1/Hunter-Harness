import { describe, expect, it } from "vitest";
import AdmZip from "adm-zip";

import { sha256Bytes } from "@hunter-harness/core";
import type { SkillIr, SourceFile } from "@hunter-harness/contracts";

import { RegistryStore } from "../src/registry/store.js";
import type { RegistryPersistence } from "../src/registry/persistence.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";

const ir: SkillIr = {
  name: "harness-x",
  kind: "governance",
  description: "demo skill",
  triggers: ["run"],
  inputs: ["ctx"],
  outputs: ["out"],
  forbidden_actions: ["automatic_git_write"],
  required_context: ["AGENTS.md"],
  profiles: { general: { enabled: true } },
  adapters: { "claude-code": { enabled: true } },
  version: "1.0.0"
};

// 簇8 多 adapter fixture：enable 4 个 installable adapter，验 buildArtifacts 多制品（API-001）
const irMultiAdapter: SkillIr = {
  ...ir,
  adapters: {
    "claude-code": { enabled: true },
    codex: { enabled: true },
    cursor: { enabled: true },
    generic: { enabled: true }
  }
};

const skillYaml = `name: harness-x
kind: governance
description: demo skill
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

const files: SourceFile[] = [{ path: "skill.yaml", content: skillYaml }];

class MemoryPersistence implements RegistryPersistence {
  snapshot: unknown = null;
  async load(): Promise<unknown | null> { return this.snapshot; }
  async save(snapshot: unknown): Promise<void> { this.snapshot = snapshot; }
}

function newStore(persistence?: RegistryPersistence): RegistryStore {
  return new RegistryStore(new MemoryArtifactStorage(), persistence);
}

describe("RegistryStore skill-center (tasks 8-13)", () => {
  describe("drafts CRUD (task 8)", () => {
    it("upsertDraft creates a draft with revision 1 and persists across reload", async () => {
      const p = new MemoryPersistence();
      const store = newStore(p);
      const draft = await store.upsertDraft({ slug: "harness-x", sourceFiles: files, ir, draftVersion: "0.1.0" });
      expect(draft.revision).toBe(1);
      expect(store.getDraft("harness-x")?.slug).toBe("harness-x");
      const reloaded = newStore(p);
      await reloaded.initialize();
      expect(reloaded.getDraft("harness-x")?.slug).toBe("harness-x");
    });

    it("upsertDraft bumps revision on update", async () => {
      const store = newStore();
      await store.upsertDraft({ slug: "harness-x", sourceFiles: files, ir, draftVersion: "0.1.0" });
      const d2 = await store.upsertDraft({ slug: "harness-x", sourceFiles: files, ir, draftVersion: "0.1.0" });
      expect(d2.revision).toBe(2);
    });

    it("deleteDraft removes the draft", async () => {
      const store = newStore();
      await store.upsertDraft({ slug: "harness-x", sourceFiles: files, ir, draftVersion: "0.1.0" });
      await store.deleteDraft("harness-x", 1);
      expect(store.getDraft("harness-x")).toBeUndefined();
    });

    it("deleteDraft rejects on revision conflict", async () => {
      const store = newStore();
      await store.upsertDraft({ slug: "harness-x", sourceFiles: files, ir, draftVersion: "0.1.0" });
      await expect(store.deleteDraft("harness-x", 999)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    });
  });

  describe("uploadDraft (task 10)", () => {
    it("parses files and creates a draft with derived slug", async () => {
      const store = newStore();
      const draft = await store.uploadDraft({ files, actorId: "owner" });
      expect(draft.slug).toBe("harness-x");
      expect(draft.sourceFiles).toHaveLength(1);
      expect(draft.draftVersion).toBe("0.1.0");
    });

    it("blocks on sensitive high-risk content", async () => {
      const store = newStore();
      const bad = [{ path: "skill.yaml", content: skillYaml }, { path: "secret.md", content: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----" }];
      await expect(store.uploadDraft({ files: bad, actorId: "owner" })).rejects.toMatchObject({ code: "SENSITIVE_CONTENT_BLOCKED" });
    });

    it("blocks on schema-invalid IR", async () => {
      const store = newStore();
      await expect(store.uploadDraft({ files: [{ path: "skill.yaml", content: ":bad" }], actorId: "owner" })).rejects.toMatchObject({ code: "SKILL_VALIDATION_FAILED" });
    });

    it("rejects unsafe file path with SKILL_VALIDATION_FAILED (UT-037)", async () => {
      const store = newStore();
      await expect(store.uploadDraft({
        files: [{ path: "../escape.md", content: "x" }],
        actorId: "owner"
      })).rejects.toMatchObject({ code: "SKILL_VALIDATION_FAILED" });
    });

    it("redirects workflow package to workflow center (UT-020, workflow.yaml + skills/)", async () => {
      const store = newStore();
      await expect(store.uploadDraft({
        files: [
          { path: "workflow.yaml", content: "name: w" },
          { path: "skills/foo.md", content: "x" }
        ],
        actorId: "owner"
      })).rejects.toMatchObject({ code: "WORKFLOW_PACKAGE_REDIRECT", details: { redirect: "workflow-packages" } });
    });

    it("redirects workflow package with agents/ dir (UT-022)", async () => {
      const store = newStore();
      await expect(store.uploadDraft({
        files: [
          { path: "workflow.yaml", content: "name: w" },
          { path: "agents/a.md", content: "x" }
        ],
        actorId: "owner"
      })).rejects.toMatchObject({ code: "WORKFLOW_PACKAGE_REDIRECT" });
    });
  });

  describe("runChecks (task 11)", () => {
    it("writes draft.checks and returns a result", async () => {
      const store = newStore();
      await store.uploadDraft({ files, actorId: "owner" });
      const result = await store.runChecks({ slug: "harness-x", checkedAt: "2026-06-26T00:00:00Z" });
      expect(result.items.length).toBeGreaterThan(0);
      expect(store.getDraft("harness-x")?.checks?.summary).toBeDefined();
    });

    it("throws DRAFT_NOT_FOUND when no draft", async () => {
      const store = newStore();
      await expect(store.runChecks({ slug: "missing", checkedAt: "t" })).rejects.toMatchObject({ code: "DRAFT_NOT_FOUND" });
    });
  });

  describe("publish (task 12)", () => {
    it("promotes draft to a new version, clears draft, updates latest_version and agents", async () => {
      const store = newStore();
      await store.uploadDraft({ files, actorId: "owner" });
      const v = await store.publish({ slug: "harness-x", version: "1.0.0", releaseNote: "init", actorId: "owner" });
      expect(v.version).toBe("1.0.0");
      expect(store.getDraft("harness-x")).toBeUndefined();
      const skill = store.getSkill("harness-x");
      expect(skill.latest_version).toBe("1.0.0");
      expect(skill.agents.find((a) => a.agent === "claude-code")?.latestVersion).toBe("1.0.0");
      expect(skill.defaultAgent).toBe("claude-code");
    });

    it("rejects non-forward version", async () => {
      const store = newStore();
      await store.uploadDraft({ files, actorId: "owner" });
      await store.publish({ slug: "harness-x", version: "1.0.0", actorId: "owner" });
      await store.uploadDraft({ files, actorId: "owner" });
      await expect(store.publish({ slug: "harness-x", version: "0.9.0", actorId: "owner" })).rejects.toMatchObject({ code: "VERSION_NOT_FORWARD" });
    });

    it("artifact content_sha256 matches stored blob bytes", async () => {
      const store = newStore();
      await store.uploadDraft({ files, actorId: "owner" });
      const v = await store.publish({ slug: "harness-x", version: "1.0.0", actorId: "owner" });
      const artifact = v.artifacts[0];
      expect(artifact).toBeDefined();
      const bytes = await store.artifactBytes(artifact);
      expect(sha256Bytes(bytes)).toBe(artifact.content_sha256);
    });
  });

  describe("diffDraft + deleteSkill (task 13)", () => {
    it("diffDraft returns published vs draft differences", async () => {
      const store = newStore();
      await store.uploadDraft({ files: [{ path: "skill.yaml", content: skillYaml }, { path: "SKILL.md", content: "v1" }], actorId: "owner" });
      await store.publish({ slug: "harness-x", version: "1.0.0", actorId: "owner" });
      await store.uploadDraft({ files: [{ path: "skill.yaml", content: skillYaml }, { path: "SKILL.md", content: "v2" }], actorId: "owner" });
      const diff = store.diffDraft("harness-x");
      expect(diff.some((f) => f.status === "modified" && f.path === "SKILL.md")).toBe(true);
    });

    it("deleteSkill removes the skill and draft", async () => {
      const store = newStore();
      await store.uploadDraft({ files, actorId: "owner" });
      await store.publish({ slug: "harness-x", version: "1.0.0", actorId: "owner" });
      await store.uploadDraft({ files, actorId: "owner" });
      await store.deleteSkill({ slug: "harness-x", actorId: "owner" });
      let caught: unknown = null;
      try { store.getSkill("harness-x"); } catch (e) { caught = e; }
      expect(caught).toMatchObject({ code: "SKILL_NOT_FOUND" });
      expect(store.getDraft("harness-x")).toBeUndefined();
    });
  });

  describe("legacy snapshot compatibility + listSkills (task 9)", () => {
    it("migrates old snapshot: derives agents, drops category, defaults tag usageCount", async () => {
      const p = new MemoryPersistence();
      p.snapshot = {
        schemaVersion: 1,
        compilerVersion: "1.0.0",
        skills: [["harness-x", {
          detail: {
            skill_id: "skl_1", slug: "harness-x", name: "harness-x", description: "d",
            category: "governance", tags: ["demo"], status: "published", latest_version: "1.0.0",
            adapters: ["claude-code"], revision: 1, created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z", ir
          },
          versions: [{ skill_slug: "harness-x", version: "1.0.0", ir, artifacts: [], source_proposal_id: null, created_at: "2026-06-20T00:00:00Z" }]
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
      expect(skill.agents).toHaveLength(1);
      expect(skill.agents[0]?.agent).toBe("claude-code");
      expect(skill.defaultAgent).toBe("claude-code");
      const tags = store.listTags();
      expect(tags[0]?.usageCount).toBe(1);
    });

    it("listSkills returns empty without category param", () => {
      const store = newStore();
      expect(store.listSkills()).toEqual([]);
    });

    it("skips corrupt skill with ir:null during migration instead of crashing initialize (YELLOW-2)", async () => {
      const p = new MemoryPersistence();
      p.snapshot = {
        schemaVersion: 1,
        compilerVersion: "1.0.0",
        skills: [["harness-corrupt", {
          detail: {
            skill_id: "skl_1", slug: "harness-corrupt", name: "harness-corrupt", description: "d",
            tags: [], status: "published", latest_version: "1.0.0",
            agents: [{ agent: "claude-code", enabled: true, isDefault: true, installTarget: ".claude/skills/harness-corrupt", latestVersion: "1.0.0", draftVersion: null, sourcePackagePath: null }],
            defaultAgent: "claude-code",
            revision: 1, created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z",
            ir: null
          },
          versions: []
        }]],
        proposals: [],
        tags: [],
        workflows: [],
        projectBindings: []
      };
      const store = newStore(p);
      await store.initialize();
      expect(() => store.getSkill("harness-corrupt")).toThrow();
    });
  });

  describe("listTags usage cache (YELLOW-4)", () => {
    // 最小合法 SkillIr（triggers/outputs 需 ≥1 项，其余可空）
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

    // schemaVersion:2 snapshot 中的 skill 条目；tags 决定该 skill 绑定的 tag slug
    function snapshotSkill(slug: string, tags: string[]): [string, unknown] {
      return [slug, {
        detail: {
          skill_id: "skl_" + slug, slug, name: slug, description: "d",
          tags, status: "published", latest_version: "1.0.0",
          agents: [{ agent: "claude-code", enabled: true, isDefault: true, installTarget: ".claude/skills/" + slug, latestVersion: "1.0.0", draftVersion: null, sourcePackagePath: null }],
          defaultAgent: "claude-code",
          revision: 1, created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z",
          ir: minIr(slug)
        },
        versions: []
      }];
    }

    function tagEntry(tagId: string, slug: string, label: string): [string, unknown] {
      return [tagId, {
        tag_id: tagId, slug, label, active: true,
        revision: 1, usageCount: 0, created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z"
      }];
    }

    it("returns cached usageCount=2 for two skills bound to same tag (UT-005)", async () => {
      const p = new MemoryPersistence();
      p.snapshot = {
        schemaVersion: 2,
        compilerVersion: "1.0.0",
        skills: [snapshotSkill("harness-a", ["red"]), snapshotSkill("harness-b", ["red"])],
        proposals: [],
        tags: [tagEntry("tag_red", "red", "Red")],
        workflows: [],
        projectBindings: []
      };
      const store = newStore(p);
      await store.initialize();
      // 连续两次 listTags 命中同一缓存，usageCount 仍为 2（压测缓存命中分支）
      const first = store.listTags().find((t) => t.slug === "red");
      const second = store.listTags().find((t) => t.slug === "red");
      expect(first?.usageCount).toBe(2);
      expect(second?.usageCount).toBe(2);
    });

    it("invalidates cache on bindTag so new tag usageCount updates (UT-006)", async () => {
      const p = new MemoryPersistence();
      p.snapshot = {
        schemaVersion: 2,
        compilerVersion: "1.0.0",
        skills: [snapshotSkill("harness-a", ["red"])],
        proposals: [],
        tags: [tagEntry("tag_red", "red", "Red"), tagEntry("tag_blue", "blue", "Blue")],
        workflows: [],
        projectBindings: []
      };
      const store = newStore(p);
      await store.initialize();
      // 先填充缓存：blue 的 usageCount=0
      expect(store.listTags().find((t) => t.slug === "blue")?.usageCount).toBe(0);
      // bindTag 后缓存失效，再查 blue 的 usageCount 应更新为 1
      store.bindTag("harness-a", "tag_blue");
      const blue = store.listTags().find((t) => t.slug === "blue");
      expect(blue?.usageCount).toBe(1);
    });

    it("invalidates cache on deleteSkill so tag usageCount drops to 0 (UT-007)", async () => {
      const p = new MemoryPersistence();
      p.snapshot = {
        schemaVersion: 2,
        compilerVersion: "1.0.0",
        skills: [snapshotSkill("harness-a", ["red"])],
        proposals: [],
        tags: [tagEntry("tag_red", "red", "Red")],
        workflows: [],
        projectBindings: []
      };
      const store = newStore(p);
      await store.initialize();
      // 先填充缓存：red 的 usageCount=1
      expect(store.listTags().find((t) => t.slug === "red")?.usageCount).toBe(1);
      // deleteSkill 后缓存失效，再查 red 的 usageCount 应降为 0
      await store.deleteSkill({ slug: "harness-a", actorId: "owner" });
      const red = store.listTags().find((t) => t.slug === "red");
      expect(red?.usageCount).toBe(0);
    });
  });
});

describe("RegistryStore fix (task 7-8)", () => {
  it("buildDraftFix returns patch without persisting", async () => {
    const store = newStore();
    await store.uploadDraft({ files, actorId: "owner" });
    await store.publish({ slug: "harness-x", version: "1.0.0", actorId: "owner" });
    await store.uploadDraft({ files, actorId: "owner" });
    await store.runChecks({ slug: "harness-x", checkedAt: "2026-06-28T00:00:00Z" });
    const before = store.getDraft("harness-x");
    const plan = await store.buildDraftFix("harness-x", null);
    expect(plan.summary.autoCount).toBeGreaterThan(0);
    expect(plan.mergedFiles.length).toBeGreaterThanOrEqual(1);
    expect(store.getDraft("harness-x")).toEqual(before);
  });

  it("applyDraftFix updates ir, bumps revision, clears checks/aiChecks", async () => {
    const store = newStore();
    await store.uploadDraft({ files, actorId: "owner" });
    await store.publish({ slug: "harness-x", version: "1.0.0", actorId: "owner" });
    await store.uploadDraft({ files, actorId: "owner" });
    await store.runChecks({ slug: "harness-x", checkedAt: "2026-06-28T00:00:00Z" });
    const before = store.getDraft("harness-x");
    expect(before?.checks).not.toBeNull();
    const after = await store.applyDraftFix("harness-x", null);
    expect(after.revision).toBe((before?.revision ?? 0) + 1);
    expect(after.checks).toBeNull();
    expect(after.aiChecks).toBeNull();
    expect(after.ir.version).toBe("1.0.1");
  });

  it("applyDraftFix throws DRAFT_NOT_FOUND when no draft", async () => {
    const store = newStore();
    await expect(store.applyDraftFix("missing", null)).rejects.toMatchObject({ code: "DRAFT_NOT_FOUND" });
  });

  it("applyDraftFix blocks on sensitive fixed ir", async () => {
    const store = newStore();
    const secretIr: SkillIr = { ...ir, instructions: ["-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"] };
    await store.upsertDraft({ slug: "harness-x", sourceFiles: files, ir: secretIr, draftVersion: "0.1.0" });
    await store.runChecks({ slug: "harness-x", checkedAt: "2026-06-28T00:00:00Z" });
    await expect(store.applyDraftFix("harness-x", null)).rejects.toMatchObject({ code: "SENSITIVE_CONTENT_BLOCKED" });
  });
});

describe("RegistryStore AI content generation (T7-T8)", () => {
  // 建一个带 aiChecks（含 fixable 项）的 draft，供 applyFixSuggestion 采纳用例复用
  async function setupDraftWithAiChecks(persistence?: RegistryPersistence): Promise<RegistryStore> {
    const store = newStore(persistence);
    await store.uploadDraft({ files, actorId: "owner" });
    await store.setDraftAiChecks({
      slug: "harness-x",
      aiChecks: {
        items: [{ id: "AI_USAGE_EXAMPLES", label: "缺少示例", status: "yellow", message: "建议补充示例", filePath: null, fixable: true }],
        summary: { green: 0, yellow: 1, red: 0 },
        checkedAt: "2026-06-29T00:00:00Z"
      },
      checkedAt: "2026-06-29T00:00:00Z"
    });
    return store;
  }

  it("setDraftReleaseNote writes releaseNote + persists (UT-011)", async () => {
    const p = new MemoryPersistence();
    const store = newStore(p);
    await store.uploadDraft({ files, actorId: "owner" });
    const updated = await store.setDraftReleaseNote({ slug: "harness-x", releaseNote: "AI: 新增 X 功能", generatedAt: "2026-06-29T00:00:00.000Z" });
    expect(updated.releaseNote).toBe("AI: 新增 X 功能");
    expect(updated.updated_at).toBe("2026-06-29T00:00:00.000Z");
    const reloaded = newStore(p);
    await reloaded.initialize();
    expect(reloaded.getDraft("harness-x")?.releaseNote).toBe("AI: 新增 X 功能");
  });

  it("setDraftReleaseNote throws DRAFT_NOT_FOUND (UT-011)", async () => {
    const store = newStore();
    await expect(store.setDraftReleaseNote({ slug: "nope", releaseNote: "x", generatedAt: "t" })).rejects.toMatchObject({ code: "DRAFT_NOT_FOUND" });
  });

  it("applyFixSuggestion appliesTo=description writes ir.description + clears aiChecks + revision+1 (UT-013)", async () => {
    const store = await setupDraftWithAiChecks();
    const before = store.getDraft("harness-x");
    const r = await store.applyFixSuggestion({ slug: "harness-x", checkId: "AI_DESC", suggestedContent: "更清晰的描述", appliesTo: "description", actorId: "owner" });
    expect(r.ir.description).toBe("更清晰的描述");
    expect(r.aiChecks).toBeNull();
    expect(r.revision).toBe((before?.revision ?? 0) + 1);
  });

  it("applyFixSuggestion appliesTo=examples writes draft.examples (SkillUsageExample[]) (UT-012)", async () => {
    const store = await setupDraftWithAiChecks();
    const examples = [{ title: "示例1", description: "演示", request: "做 X", result: "得到 Y" }];
    const r = await store.applyFixSuggestion({ slug: "harness-x", checkId: "AI_USAGE_EXAMPLES", suggestedContent: JSON.stringify(examples), appliesTo: "examples", actorId: "owner" });
    expect(r.examples).toHaveLength(1);
    expect(r.examples[0]?.title).toBe("示例1");
    expect(r.examples[0]?.files).toEqual([]);
  });

  it("applyFixSuggestion appliesTo=instructions writes ir.instructions (UT-014)", async () => {
    const store = await setupDraftWithAiChecks();
    const r = await store.applyFixSuggestion({ slug: "harness-x", checkId: "AI_INSTR", suggestedContent: JSON.stringify(["步骤1", "步骤2"]), appliesTo: "instructions", actorId: "owner" });
    expect(r.ir.instructions).toEqual(["步骤1", "步骤2"]);
  });

  it("applyFixSuggestion appliesTo=allowed_capabilities writes ir.allowed_capabilities (UT-014)", async () => {
    const store = await setupDraftWithAiChecks();
    const r = await store.applyFixSuggestion({ slug: "harness-x", checkId: "AI_CAP", suggestedContent: JSON.stringify(["read-files"]), appliesTo: "allowed_capabilities", actorId: "owner" });
    expect(r.ir.allowed_capabilities).toEqual(["read-files"]);
  });

  it("applyFixSuggestion non-writable appliesTo (tags) → 422 (UT-015)", async () => {
    const store = await setupDraftWithAiChecks();
    await expect(store.applyFixSuggestion({ slug: "harness-x", checkId: "x", suggestedContent: "t", appliesTo: "tags", actorId: "owner" })).rejects.toMatchObject({ code: "SKILL_VALIDATION_FAILED" });
  });

  it("applyFixSuggestion null appliesTo → 422 (UT-015)", async () => {
    const store = await setupDraftWithAiChecks();
    await expect(store.applyFixSuggestion({ slug: "harness-x", checkId: "x", suggestedContent: "t", appliesTo: null, actorId: "owner" })).rejects.toMatchObject({ code: "SKILL_VALIDATION_FAILED" });
  });

  it("applyFixSuggestion invalid appliesTo string → 422 (UT-015)", async () => {
    const store = await setupDraftWithAiChecks();
    await expect(store.applyFixSuggestion({ slug: "harness-x", checkId: "x", suggestedContent: "t", appliesTo: "ir.secret", actorId: "owner" })).rejects.toMatchObject({ code: "SKILL_VALIDATION_FAILED" });
  });

  it("applyFixSuggestion examples bad JSON → 422 (UT-016)", async () => {
    const store = await setupDraftWithAiChecks();
    await expect(store.applyFixSuggestion({ slug: "harness-x", checkId: "x", suggestedContent: "not json", appliesTo: "examples", actorId: "owner" })).rejects.toMatchObject({ code: "SKILL_VALIDATION_FAILED" });
  });

  it("applyFixSuggestion examples wrong shape → 422 (UT-016)", async () => {
    const store = await setupDraftWithAiChecks();
    await expect(store.applyFixSuggestion({ slug: "harness-x", checkId: "x", suggestedContent: JSON.stringify([{ wrong: "shape" }]), appliesTo: "examples", actorId: "owner" })).rejects.toMatchObject({ code: "SKILL_VALIDATION_FAILED" });
  });

  it("applyFixSuggestion instructions non-string item → 422 (UT-016)", async () => {
    const store = await setupDraftWithAiChecks();
    await expect(store.applyFixSuggestion({ slug: "harness-x", checkId: "x", suggestedContent: JSON.stringify([123]), appliesTo: "instructions", actorId: "owner" })).rejects.toMatchObject({ code: "SKILL_VALIDATION_FAILED" });
  });

  it("applyFixSuggestion empty description → 422 (UT-016)", async () => {
    const store = await setupDraftWithAiChecks();
    await expect(store.applyFixSuggestion({ slug: "harness-x", checkId: "x", suggestedContent: "", appliesTo: "description", actorId: "owner" })).rejects.toMatchObject({ code: "SKILL_VALIDATION_FAILED" });
  });

  it("applyFixSuggestion empty examples array → 422 (UT-016)", async () => {
    const store = await setupDraftWithAiChecks();
    await expect(store.applyFixSuggestion({ slug: "harness-x", checkId: "x", suggestedContent: "[]", appliesTo: "examples", actorId: "owner" })).rejects.toMatchObject({ code: "SKILL_VALIDATION_FAILED" });
  });

  it("applyFixSuggestion empty instructions array → 422 (UT-016)", async () => {
    const store = await setupDraftWithAiChecks();
    await expect(store.applyFixSuggestion({ slug: "harness-x", checkId: "x", suggestedContent: "[]", appliesTo: "instructions", actorId: "owner" })).rejects.toMatchObject({ code: "SKILL_VALIDATION_FAILED" });
  });

  it("applyFixSuggestion empty allowed_capabilities array → 422 (UT-016)", async () => {
    const store = await setupDraftWithAiChecks();
    await expect(store.applyFixSuggestion({ slug: "harness-x", checkId: "x", suggestedContent: "[]", appliesTo: "allowed_capabilities", actorId: "owner" })).rejects.toMatchObject({ code: "SKILL_VALIDATION_FAILED" });
  });

  it("applyFixSuggestion sensitive content blocked → 422 SENSITIVE_CONTENT_BLOCKED (UT-017)", async () => {
    const store = await setupDraftWithAiChecks();
    await expect(store.applyFixSuggestion({ slug: "harness-x", checkId: "x", suggestedContent: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----", appliesTo: "description", actorId: "owner" })).rejects.toMatchObject({ code: "SENSITIVE_CONTENT_BLOCKED" });
  });

  it("applyFixSuggestion persists + clears aiChecks + revision+1 (UT-018)", async () => {
    const p = new MemoryPersistence();
    const store = await setupDraftWithAiChecks(p);
    const before = store.getDraft("harness-x");
    const r = await store.applyFixSuggestion({ slug: "harness-x", checkId: "x", suggestedContent: "新描述", appliesTo: "description", actorId: "owner" });
    expect(r.aiChecks).toBeNull();
    expect(r.revision).toBe((before?.revision ?? 0) + 1);
    const reloaded = newStore(p);
    await reloaded.initialize();
    expect(reloaded.getDraft("harness-x")?.aiChecks).toBeNull();
    expect(reloaded.getDraft("harness-x")?.ir.description).toBe("新描述");
  });

  it("applyFixSuggestion DRAFT_NOT_FOUND 404 (UT-018)", async () => {
    const store = newStore();
    await expect(store.applyFixSuggestion({ slug: "nope", checkId: "x", suggestedContent: "d", appliesTo: "description", actorId: "owner" })).rejects.toMatchObject({ code: "DRAFT_NOT_FOUND" });
  });
});

describe("buildArtifacts + publish multi + adapterPreview (T12-14)", () => {
  async function publishMulti(): Promise<RegistryStore> {
    const store = newStore();
    await store.upsertDraft({ slug: "harness-x", sourceFiles: files, ir: irMultiAdapter, draftVersion: "0.1.0" });
    await store.publish({ slug: "harness-x", version: "1.0.0", actorId: "owner" });
    return store;
  }

  it("publish produces 4 artifacts (claude-code/codex/cursor/generic) for multi-adapter IR (API-001)", async () => {
    const store = newStore();
    await store.upsertDraft({ slug: "harness-x", sourceFiles: files, ir: irMultiAdapter, draftVersion: "0.1.0" });
    const v = await store.publish({ slug: "harness-x", version: "1.0.0", actorId: "owner" });
    expect(v.artifacts.map((a) => a.agent)).toEqual(["claude-code", "codex", "cursor", "generic"]);
    // 每个制品的 content_sha256 与存储 blob 一致（独立 zip）
    for (const artifact of v.artifacts) {
      const bytes = await store.artifactBytes(artifact);
      expect(sha256Bytes(bytes)).toBe(artifact.content_sha256);
    }
  });

  it("cursor artifact manifest has target_path .cursor/rules/<slug>.mdc + install_mode file (API-002)", async () => {
    const store = await publishMulti();
    const versions = store.listVersions("harness-x");
    const cursorArt = versions[0]?.artifacts.find((a) => a.agent === "cursor");
    if (cursorArt === undefined) throw new Error("cursor artifact missing");
    const bytes = await store.artifactBytes(cursorArt);
    const zip = new AdmZip(Buffer.from(bytes));
    const manifestEntry = zip.getEntry("hunter-skill.json");
    if (manifestEntry === null) throw new Error("hunter-skill.json missing");
    const manifest = JSON.parse(manifestEntry.getData().toString("utf8"));
    expect(manifest.schema_version).toBe(2);
    expect(manifest.agent).toBe("cursor");
    expect(manifest.target_path).toBe(".cursor/rules/harness-x.mdc");
    expect(manifest.install_mode).toBe("file");
    expect(manifest.block_id).toBeUndefined();
  });

  it("codex artifact manifest has install_mode managed_block + block_id harness-skill-<slug> (UT-015)", async () => {
    const store = await publishMulti();
    const versions = store.listVersions("harness-x");
    const codexArt = versions[0]?.artifacts.find((a) => a.agent === "codex");
    if (codexArt === undefined) throw new Error("codex artifact missing");
    const bytes = await store.artifactBytes(codexArt);
    const zip = new AdmZip(Buffer.from(bytes));
    const manifestEntry = zip.getEntry("hunter-skill.json");
    if (manifestEntry === null) throw new Error("hunter-skill.json missing");
    const manifest = JSON.parse(manifestEntry.getData().toString("utf8"));
    expect(manifest.agent).toBe("codex");
    expect(manifest.target_path).toBe("AGENTS.md");
    expect(manifest.install_mode).toBe("managed_block");
    expect(manifest.block_id).toBe("harness-skill-harness-x");
    // zip 内目标文件名 = AGENTS.md（codex file-target），block 体含 harness 头
    const bodyEntry = zip.getEntry("AGENTS.md");
    if (bodyEntry === null) throw new Error("AGENTS.md missing");
    const body = bodyEntry.getData().toString("utf8");
    expect(body).toContain("<!-- harness: adapter=codex");
  });

  it("adapterPreview codex/cursor/generic returns compiled output (API-005~007)", async () => {
    const store = await publishMulti();
    const codex = store.adapterPreview("harness-x", "codex");
    expect(codex.path).toBe("AGENTS.md");
    expect(codex.content).toContain("<!-- harness: adapter=codex");
    const cursor = store.adapterPreview("harness-x", "cursor");
    expect(cursor.path).toBe(".cursor/rules/harness-x.mdc");
    expect(cursor.content).toContain("adapter: cursor");
    const generic = store.adapterPreview("harness-x", "generic");
    expect(generic.path).toBe(".agent-skills/harness-x.md");
    expect(generic.content).toContain("adapter: generic");
  });

  it("adapterPreview mcp throws 422 ADAPTER_NOT_IMPLEMENTED (API-008)", async () => {
    const store = await publishMulti();
    let caught: unknown = null;
    try { store.adapterPreview("harness-x", "mcp"); } catch (e) { caught = e; }
    expect(caught).toMatchObject({ code: "ADAPTER_NOT_IMPLEMENTED", status: 422 });
  });

  // Y-3：IR 仅 enable mcp（installable=false）→ buildArtifacts 返回空数组。
  // createProposal 已有空检查（store.ts createProposal built.length===0 → SKILL_VALIDATION_FAILED）；
  // publish/publishIr 应一致拒绝，避免静默发布 0 制品 version（不可安装）。
  const irMcpOnly: SkillIr = { ...ir, adapters: { mcp: { enabled: true } } };

  it("publish rejects mcp-only IR with 422 SKILL_VALIDATION_FAILED (Y-3)", async () => {
    const store = newStore();
    await store.upsertDraft({ slug: "harness-x", sourceFiles: files, ir: irMcpOnly, draftVersion: "0.1.0" });
    await expect(store.publish({ slug: "harness-x", version: "1.0.0", actorId: "owner" }))
      .rejects.toMatchObject({ code: "SKILL_VALIDATION_FAILED", status: 422 });
  });

  it("createProposal rejects mcp-only IR (claude-code not enabled) with 422 ADAPTER_NOT_INSTALLABLE (Y-3 语义保留，gate 增强)", () => {
    const store = newStore();
    let caught: unknown = null;
    try { store.createProposal({ ir: irMcpOnly, actorId: "owner", agent: "claude-code" }); } catch (e) { caught = e; }
    expect(caught).toMatchObject({ code: "ADAPTER_NOT_INSTALLABLE", status: 422 });
  });
});

describe("multi-agent publish + createProposal gate (skill-center-multi-agent-publish 簇A)", () => {
  // 实际 ADAPTERS（packages/core/src/skill-ir/adapters/index.ts:34）：claude-code/codex/cursor/generic installable=true，mcp=false。
  // design/test-scenarios 原 UT-103/104 假设 codex/generic installable=false → 422，与实际 ADAPTERS 不符（过时，归档 skill-ir-real-adapters 已升生产），
  // 此处按代码事实修正：codex/generic installable=true → createProposal 通过；mcp installable=false → 422。
  it("publish fills latestVersion for every enabled installable agent + correct installTarget (UT-101)", async () => {
    const store = newStore();
    await store.upsertDraft({ slug: "harness-x", sourceFiles: files, ir: irMultiAdapter, draftVersion: "0.1.0" });
    await store.publish({ slug: "harness-x", version: "1.0.0", actorId: "owner" });
    const skill = store.getSkill("harness-x");
    const byAgent = new Map(skill.agents.map((a) => [a.agent, a]));
    expect(byAgent.get("claude-code")?.latestVersion).toBe("1.0.0");
    expect(byAgent.get("codex")?.latestVersion).toBe("1.0.0");
    expect(byAgent.get("cursor")?.latestVersion).toBe("1.0.0");
    expect(byAgent.get("generic")?.latestVersion).toBe("1.0.0");
    expect(byAgent.get("mcp")).toBeUndefined();
    expect(skill.defaultAgent).toBe("claude-code");
    expect(byAgent.get("cursor")?.installTarget).toBe(".cursor/rules/harness-x.mdc");
    expect(byAgent.get("codex")?.installTarget).toBe("AGENTS.md");
  });

  it("createProposal agent=cursor passes gate (UT-102)", () => {
    const store = newStore();
    const proposal = store.createProposal({ ir: irMultiAdapter, actorId: "owner", agent: "cursor" });
    expect(proposal.requestedAgent).toBe("cursor");
    expect(proposal.status).toBe("pending_review");
  });

  it("createProposal agent=codex passes gate (UT-103, 修正原 422 假设)", () => {
    const store = newStore();
    const proposal = store.createProposal({ ir: irMultiAdapter, actorId: "owner", agent: "codex" });
    expect(proposal.requestedAgent).toBe("codex");
  });

  it("createProposal agent=mcp rejected 422 ADAPTER_NOT_INSTALLABLE (UT-104, installable=false 回归)", () => {
    const store = newStore();
    let caught: unknown = null;
    try { store.createProposal({ ir: irMultiAdapter, actorId: "owner", agent: "mcp" }); } catch (e) { caught = e; }
    expect(caught).toMatchObject({ code: "ADAPTER_NOT_INSTALLABLE", status: 422 });
  });

  it("createProposal agent=claude-code on cursor-only IR rejected 422 (UT-105, enabled 检查 RED)", () => {
    const irCursorOnly: SkillIr = { ...ir, adapters: { cursor: { enabled: true } } };
    const store = newStore();
    let caught: unknown = null;
    try { store.createProposal({ ir: irCursorOnly, actorId: "owner", agent: "claude-code" }); } catch (e) { caught = e; }
    expect(caught).toMatchObject({ code: "ADAPTER_NOT_INSTALLABLE", status: 422 });
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
    const draft = await store.uploadDraft({ files, actorId: "owner" });
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
