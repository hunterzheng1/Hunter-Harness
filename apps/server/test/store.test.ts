import { describe, expect, it } from "vitest";

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
  });
});
