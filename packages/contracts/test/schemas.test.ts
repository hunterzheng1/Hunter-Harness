import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

import {
  agentSkillConfigSchema,
  aiConfigStateSchema,
  aiProviderConfigSchema,
  apiErrorEnvelopeSchema,
  artifactManifestSchema,
  canonicalJson,
  checkStatusSchema,
  draftStateSchema,
  filePolicySchema,
  initConfigSchema,
  knowledgeFrontmatterSchema,
  projectConfigSchema,
  publishSkillRequestSchema,
  registryAgentSchema,
  registryArtifactSchema,
  registrySkillDetailSchema,
  registrySkillProposalSchema,
  registrySkillSummarySchema,
  registrySkillVersionSchema,
  registryTagSchema,
  registryWorkflowSchema,
  skillCheckItemSchema,
  skillCheckResultSchema,
  skillDiffFileSchema,
  skillIrSchema,
  skillUsageExampleSchema,
  sourceFileSchema
} from "../src/index.js";

describe("shared contracts", () => {
  it("accepts an offline project configuration", () => {
    const parsed = projectConfigSchema.parse({
      harness: { name: "hunter-harness", schema_version: 1 },
      project: {
        name: "sample",
        root: ".",
        local_project_key: "018f1f2e-7b5a-7cc0-8c2d-2b320cab1234",
        project_id: null,
        profiles: ["java"]
      },
      server: { url: null, token_env: "HUNTER_HARNESS_TOKEN" },
      adapters: { enabled: ["claude-code"] }
    });

    expect(parsed.project.project_id).toBeNull();
  });

  it("uses file_kind and policy fields instead of legacy classes", () => {
    expect(filePolicySchema.parse({
      file_kind: "generated_reviewable",
      edit_policy: "discourage",
      push_policy: "full-diff-proposal",
      update_policy: "skip-if-local-dirty",
      conflict_policy: "skip-and-report"
    })).toMatchObject({ file_kind: "generated_reviewable" });

    expect(filePolicySchema.safeParse({ class: "A" }).success).toBe(false);
  });

  it("requires explicit tombstones and rename paths", () => {
    const common = {
      file_kind: "user_editable",
      content_sha256: "sha256:" + "a".repeat(64),
      size_bytes: 12
    };
    const result = artifactManifestSchema.safeParse({
      schema_version: 1,
      project_id: "prj_1",
      project_version: "pv_1",
      artifact_id: "art_1",
      files: [{ ...common, path: "AGENTS.md", operation: "delete" }],
      manifest_sha256: "sha256:" + "b".repeat(64)
    });

    expect(result.success).toBe(false);
  });

  it("rejects secrets and unknown fields in init config", () => {
    expect(initConfigSchema.safeParse({
      adapter: "claude-code",
      profile: "java",
      token: "secret"
    }).success).toBe(false);
  });

  it("validates Skill IR and Knowledge frontmatter", () => {
    expect(skillIrSchema.parse({
      name: "harness-review",
      kind: "workflow",
      description: "Evidence based review",
      triggers: ["review"],
      inputs: ["change_ref"],
      outputs: ["review_report"],
      forbidden_actions: ["automatic_git_write"],
      required_context: ["AGENTS.md"],
      profiles: { general: { enabled: true } },
      adapters: { "claude-code": { enabled: true } },
      version: "1.0.0"
    }).name).toBe("harness-review");

    expect(knowledgeFrontmatterSchema.parse({
      id: "knowledge.architecture.boundary",
      type: "architecture",
      scope: "project",
      confidence: "verified",
      status: "active",
      domains: ["platform"],
      modules: ["core"],
      related_paths: ["packages/core/**"],
      source: { kind: "review", ref: "prp_1" },
      created_at: "2026-06-20T00:00:00Z",
      updated_at: "2026-06-20T00:00:00Z",
      last_verified_at: "2026-06-20T00:00:00Z",
      expires_at: null,
      supersedes: [],
      superseded_by: []
    }).status).toBe("active");
  });

  it("validates governed registry records and direct workflow metadata", () => {
    expect(registryAgentSchema.parse("claude-code")).toBe("claude-code");
    expect(registryAgentSchema.safeParse("unknown-agent").success).toBe(false);
    const ir = skillIrSchema.parse({
      name: "harness-review",
      kind: "governance",
      description: "Evidence based review",
      triggers: ["review"],
      inputs: ["change_ref"],
      outputs: ["review_report"],
      forbidden_actions: ["automatic_git_write"],
      required_context: ["AGENTS.md"],
      profiles: { general: { enabled: true } },
      adapters: { "claude-code": { enabled: true } },
      version: "1.1.0"
    });
    expect(registrySkillDetailSchema.parse({
      skill_id: "skl_review",
      slug: "harness-review",
      name: "harness-review",
      description: "Evidence based review",
      tags: ["review", "security"],
      status: "published",
      latest_version: "1.1.0",
      defaultAgent: "claude-code",
      agents: [{
        agent: "claude-code",
        enabled: true,
        isDefault: true,
        installTarget: ".claude/skills/harness-review",
        latestVersion: "1.1.0",
        draftVersion: null,
        sourcePackagePath: null
      }],
      ir,
      revision: 3,
      created_at: "2026-06-20T00:00:00Z",
      updated_at: "2026-06-21T00:00:00Z"
    }).tags).toEqual(["review", "security"]);

    expect(registryWorkflowSchema.parse({
      workflow_id: "wf_general",
      key: "general",
      name: "General",
      description: "Default governance workflow",
      profile: "general",
      default_agent: "claude-code",
      enabled: true,
      skill_slugs: ["harness-sync", "harness-review"],
      revision: 2,
      created_at: "2026-06-20T00:00:00Z",
      updated_at: "2026-06-21T00:00:00Z"
    }).revision).toBe(2);

    expect(registryTagSchema.parse({
      tag_id: "tag_security",
      slug: "security",
      label: "Security",
      active: true,
      revision: 1,
      usageCount: 0,
      created_at: "2026-06-20T00:00:00Z",
      updated_at: "2026-06-20T00:00:00Z"
    }).slug).toBe("security");

    expect(registrySkillProposalSchema.parse({
      proposal_id: "skp_review",
      skill_slug: "harness-review",
      proposed_ir: ir,
      status: "pending_review",
      created_by: "actor_owner",
      validation: { schema_valid: true, sensitive_findings: 0, claude_compilable: true },
      created_at: "2026-06-21T00:00:00Z",
      reviewed_at: null
    }).status).toBe("pending_review");
  });

  it("enforces the common API error envelope", () => {
    const parsed = apiErrorEnvelopeSchema.parse({
      error: {
        code: "PROJECT_VERSION_CONFLICT",
        message: "The baseline is stale.",
        request_id: "018f1f2e-7b5a-7cc0-8c2d-2b320cab1234",
        details: {}
      }
    });
    expect(parsed.error.code).toBe("PROJECT_VERSION_CONFLICT");
  });

  it("canonicalizes object keys deterministically", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 } }))
      .toBe('{"a":{"b":3,"y":2},"z":1}');
  });
});

describe("skill-center schemas", () => {
  const validIr = {
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
  const agentCfg = {
    agent: "claude-code",
    enabled: true,
    isDefault: true,
    installTarget: ".claude/skills/harness-x",
    latestVersion: "1.0.0",
    draftVersion: null,
    sourcePackagePath: null
  };

  it("checkStatus accepts green/yellow/red and rejects others", () => {
    expect(checkStatusSchema.parse("green")).toBe("green");
    expect(checkStatusSchema.parse("yellow")).toBe("yellow");
    expect(checkStatusSchema.parse("red")).toBe("red");
    expect(checkStatusSchema.safeParse("blue").success).toBe(false);
  });

  it("sourceFile requires path+content", () => {
    expect(() => sourceFileSchema.parse({ path: "a.md" })).toThrow();
    expect(sourceFileSchema.parse({ path: "a.md", content: "x" })).toEqual({ path: "a.md", content: "x" });
  });

  it("skillUsageExample defaults files to []", () => {
    expect(skillUsageExampleSchema.parse({
      title: "t", description: "d", request: "r", result: "s"
    }).files).toEqual([]);
  });

  it("agentSkillConfig parses valid and rejects extras", () => {
    expect(agentSkillConfigSchema.parse(agentCfg)).toEqual(agentCfg);
    expect(() => agentSkillConfigSchema.parse({ ...agentCfg, extra: 1 })).toThrow();
  });

  it("skillCheckItem and skillCheckResult parse", () => {
    const item = { id: "SENSITIVE", label: "敏感信息", status: "red", message: "token", filePath: "SKILL.md", fixable: false };
    expect(skillCheckItemSchema.parse(item)).toEqual(item);
    const r = skillCheckResultSchema.parse({
      items: [item],
      summary: { green: 0, yellow: 0, red: 1 },
      checkedAt: "2026-06-26T00:00:00Z"
    });
    expect(r.summary.red).toBe(1);
  });

  it("draftState requires ir/sourceFiles/revision and defaults examples", () => {
    const d = draftStateSchema.parse({
      slug: "harness-x",
      sourceFiles: [{ path: "SKILL.md", content: "..." }],
      ir: validIr,
      draftVersion: "0.1.0",
      checks: null,
      releaseNote: null,
      revision: 1,
      created_at: "2026-06-26T00:00:00Z",
      updated_at: "2026-06-26T00:00:00Z"
    });
    expect(d.examples).toEqual([]);
    expect(d.revision).toBe(1);
  });

  it("publishSkillRequest requires version and accepts optional releaseNote", () => {
    expect(() => publishSkillRequestSchema.parse({})).toThrow();
    expect(publishSkillRequestSchema.parse({ version: "1.0.0" }).releaseNote).toBeUndefined();
    expect(publishSkillRequestSchema.parse({ version: "1.0.0", releaseNote: "init" }).releaseNote).toBe("init");
  });

  it("skillDiffFile only allows modified/added/removed", () => {
    expect(skillDiffFileSchema.parse({ path: "a", status: "modified", publishedContent: "1", draftContent: "2" }).status).toBe("modified");
    expect(() => skillDiffFileSchema.parse({ path: "a", status: "deleted", publishedContent: null, draftContent: null })).toThrow();
  });

  it("summary has no category, has agents+defaultAgent, rejects category", () => {
    const s = {
      skill_id: "skl_1", slug: "harness-x", name: "harness-x", description: "d",
      tags: [], status: "published", latest_version: "1.0.0",
      defaultAgent: "claude-code", agents: [agentCfg],
      revision: 1, created_at: "2026-06-26T00:00:00Z", updated_at: "2026-06-26T00:00:00Z"
    };
    const parsed = registrySkillSummarySchema.parse(s);
    expect(parsed).not.toHaveProperty("category");
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.defaultAgent).toBe("claude-code");
    expect(() => registrySkillSummarySchema.parse({ ...s, category: "tooling" })).toThrow();
  });

  it("detail extends summary with ir and defaults sourceFiles/examples", () => {
    const d = registrySkillDetailSchema.parse({
      skill_id: "skl_1", slug: "harness-x", name: "harness-x", description: "d",
      tags: [], status: "published", latest_version: "1.0.0",
      defaultAgent: "claude-code", agents: [agentCfg],
      ir: validIr,
      revision: 1, created_at: "2026-06-26T00:00:00Z", updated_at: "2026-06-26T00:00:00Z"
    });
    expect(d.sourceFiles).toEqual([]);
    expect(d.examples).toEqual([]);
    expect(d.ir).toEqual(validIr);
  });

  it("version has sourceFiles/examples/changeNote and nullable source_proposal_id", () => {
    const v = registrySkillVersionSchema.parse({
      skill_slug: "harness-x", version: "1.0.0", ir: validIr, artifacts: [],
      source_proposal_id: null, sourceFiles: [], examples: [], changeNote: null,
      created_at: "2026-06-26T00:00:00Z"
    });
    expect(v.changeNote).toBeNull();
    expect(v.sourceFiles).toEqual([]);
  });

  it("artifact allows null source_proposal_id for draft-published artifacts", () => {
    const a = registryArtifactSchema.parse({
      artifact_id: "ska_1", skill_slug: "harness-x", version: "1.0.0", agent: "claude-code",
      content_sha256: "sha256:" + "a".repeat(64), size_bytes: 10, source_proposal_id: null,
      created_at: "2026-06-26T00:00:00Z"
    });
    expect(a.source_proposal_id).toBeNull();
  });

  it("tag has nonnegative usageCount", () => {
    const t = registryTagSchema.parse({
      tag_id: "tag_1", slug: "x", label: "X", active: true, revision: 1,
      created_at: "2026-06-26T00:00:00Z", updated_at: "2026-06-26T00:00:00Z", usageCount: 0
    });
    expect(t.usageCount).toBe(0);
    expect(() => registryTagSchema.parse({ ...t, usageCount: -1 })).toThrow();
  });

  it("aiProviderConfig parses valid (no key) and rejects apiKey extra", () => {
    const cfg = {
      provider_id: "deepseek",
      label: "DeepSeek",
      base_url: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
      enabled: true,
      is_default: true,
      api_key_env: "secret-file",
      revision: 1,
      created_at: "2026-06-28T00:00:00Z",
      updated_at: "2026-06-28T00:00:00Z"
    };
    expect(aiProviderConfigSchema.parse(cfg)).toEqual(cfg);
    expect(() => aiProviderConfigSchema.parse({ ...cfg, apiKey: "sk-xxx" })).toThrow();
  });

  it("aiConfigState has nullable defaultProvider and providers array", () => {
    expect(aiConfigStateSchema.parse({ defaultProvider: null, providers: [] }).defaultProvider).toBeNull();
    expect(aiConfigStateSchema.parse({ defaultProvider: "deepseek", providers: [] }).providers).toEqual([]);
  });

  it("draftState defaults aiChecks to null (separate from program checks)", () => {
    const d = draftStateSchema.parse({
      slug: "harness-x",
      sourceFiles: [{ path: "SKILL.md", content: "..." }],
      ir: validIr,
      draftVersion: "0.1.0",
      checks: null,
      releaseNote: null,
      revision: 1,
      created_at: "2026-06-26T00:00:00Z",
      updated_at: "2026-06-26T00:00:00Z"
    });
    expect(d.aiChecks).toBeNull();
  });
});

describe("OpenAPI v1", () => {
  it("covers every required client/server route", async () => {
    const path = fileURLToPath(
      new URL("../../../apps/server/openapi/hunter-harness-v1.yaml", import.meta.url)
    );
    const document = parseYaml(await readFile(path, "utf8")) as {
      openapi: string;
      paths: Record<string, unknown>;
    };

    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(document.paths)).toEqual(expect.arrayContaining([
      "/api/v1/projects:resolve",
      "/api/v1/projects/{project_id}/proposal-sessions",
      "/api/v1/proposal-sessions/{session_id}/blobs:query",
      "/api/v1/proposal-sessions/{session_id}/blobs/{content_sha256}",
      "/api/v1/proposal-sessions/{session_id}:finalize",
      "/api/v1/proposals/{proposal_id}/review-decisions",
      "/api/v1/projects/{project_id}/update-manifest",
      "/api/v1/artifacts/{artifact_id}/manifest",
      "/api/v1/artifacts/{artifact_id}/blobs/{content_sha256}"
    ]));
  });
});
