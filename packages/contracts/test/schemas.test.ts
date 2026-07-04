import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

import {
  adapterNameSchema,
  addOperationSchema,
  agentSkillConfigSchema,
  aiConfigStateSchema,
  aiJobStateSchema,
  aiProviderApiFormatSchema,
  aiProviderConfigSchema,
  aiProviderReorderRequestSchema,
  aiProviderWithKeySetSchema,
  aiQuotaUsageSchema,
  providerModelSchema,
  apiErrorEnvelopeSchema,
  artifactManifestSchema,
  canonicalJson,
  checkStatusSchema,
  draftStateSchema,
  fileOperationSchema,
  filePolicySchema,
  fixActionSchema,
  fixPlanItemSchema,
  fixPlanSchema,
  initConfigSchema,
  knowledgeFrontmatterSchema,
  mcpToolContractSchema,
  modifyOperationSchema,
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
  setDefaultAgentRequestSchema,
  skillCheckItemSchema,
  skillCheckResultSchema,
  skillDiffFileSchema,
  skillFrontmatterSchema,
  skillNameSchema,
  skillUsageExampleSchema,
  apiErrorCodeSchema,
  SKILL_NAME_REGEX,
  SKILL_ERROR_CODE,
  sourceFileSchema,
  publishWorkflowPackageRequestSchema,
  workflowPackageDraftStateSchema,
  workflowPackageManifestSchema,
  workflowPackageSchema,
  workflowPackageVersionSchema
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

  it("validates Knowledge frontmatter", () => {
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
      proposed_ir: { name: "harness-review", version: "1.1.0" },
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

describe("skill frontmatter schema (UT-001~004, UT-002b RED#1)", () => {
  it("parses valid frontmatter with required name+description (UT-001)", () => {
    expect(skillFrontmatterSchema.parse({
      name: "harness-x",
      description: "demo skill"
    }).name).toBe("harness-x");
  });

  it("preserves extra undeclared fields via passthrough (UT-002b, RED#1)", () => {
    const parsed = skillFrontmatterSchema.parse({
      name: "harness-x",
      description: "d",
      author: "someone",
      tags: ["a"],
      license: "MIT"
    });
    expect(parsed.author).toBe("someone");
    expect(parsed.tags).toEqual(["a"]);
    expect(parsed.license).toBe("MIT");
  });

  it("rejects name not matching slug regex (UT-003)", () => {
    expect(skillFrontmatterSchema.safeParse({
      name: "Foo Bar",
      description: "d"
    }).success).toBe(false);
  });

  it("accepts missing optional fields (UT-004)", () => {
    const parsed = skillFrontmatterSchema.parse({
      name: "harness-x",
      description: "d"
    });
    expect(parsed.triggers).toBeUndefined();
    expect(parsed.forbidden_actions).toBeUndefined();
    expect(parsed.kind).toBeUndefined();
  });

  it("rejects missing description", () => {
    expect(skillFrontmatterSchema.safeParse({
      name: "harness-x"
    }).success).toBe(false);
  });

  it("rejects missing name", () => {
    expect(skillFrontmatterSchema.safeParse({
      description: "d"
    }).success).toBe(false);
  });

  it("accepts name without harness- prefix (U-02)", () => {
    expect(skillFrontmatterSchema.parse({
      name: "my-skill",
      description: "d"
    }).name).toBe("my-skill");
  });

  it("rejects name starting with hyphen (U-04)", () => {
    expect(skillFrontmatterSchema.safeParse({
      name: "-x",
      description: "d"
    }).success).toBe(false);
  });

  it("rejects name with underscore (U-05)", () => {
    expect(skillFrontmatterSchema.safeParse({
      name: "_x",
      description: "d"
    }).success).toBe(false);
  });

  it("rejects name exceeding 64 chars (U-07)", () => {
    expect(skillFrontmatterSchema.safeParse({
      name: "a".repeat(65),
      description: "d"
    }).success).toBe(false);
  });

  it("accepts name exactly 64 chars (U-07b)", () => {
    expect(skillFrontmatterSchema.parse({
      name: "a".repeat(64),
      description: "d"
    }).name).toBe("a".repeat(64));
  });
});

describe("SKILL_NAME_REGEX (U-01~U-07b standalone)", () => {
  it("matches old harness-xxx format (U-01)", () => {
    expect(SKILL_NAME_REGEX.test("harness-x")).toBe(true);
  });

  it("matches new format without harness- prefix (U-02)", () => {
    expect(SKILL_NAME_REGEX.test("my-skill")).toBe(true);
  });

  it("rejects uppercase/spaces (U-03)", () => {
    expect(SKILL_NAME_REGEX.test("Foo Bar")).toBe(false);
  });

  it("rejects hyphen-start (U-04)", () => {
    expect(SKILL_NAME_REGEX.test("-x")).toBe(false);
  });

  it("rejects underscore (U-05)", () => {
    expect(SKILL_NAME_REGEX.test("_x")).toBe(false);
  });

  it("rejects 65 chars (U-07)", () => {
    expect(SKILL_NAME_REGEX.test("a".repeat(65))).toBe(false);
  });

  it("accepts 64 chars (U-07b)", () => {
    expect(SKILL_NAME_REGEX.test("a".repeat(64))).toBe(true);
  });
});

describe("apiErrorCodeSchema 7 new skill codes (U-08)", () => {
  const newCodes = [
    "SKILL_VALIDATION_FAILED",
    "SKILL_ENTRY_NOT_FOUND",
    "SKILL_NOT_FOUND",
    "DRAFT_NOT_FOUND",
    "REVISION_CONFLICT",
    "ADAPTER_NOT_INSTALLABLE",
    "WORKFLOW_PACKAGE_REDIRECT"
  ] as const;

  for (const code of newCodes) {
    it(`accepts ${code}`, () => {
      expect(apiErrorCodeSchema.safeParse(code).success).toBe(true);
    });
  }
});

describe("SKILL_ERROR_CODE constant", () => {
  it("contains wire codes + non-wire codes", () => {
    expect(SKILL_ERROR_CODE.VALIDATION_FAILED).toBe("SKILL_VALIDATION_FAILED");
    expect(SKILL_ERROR_CODE.ENTRY_NOT_FOUND).toBe("SKILL_ENTRY_NOT_FOUND");
    expect(SKILL_ERROR_CODE.NOT_FOUND).toBe("SKILL_NOT_FOUND");
    expect(SKILL_ERROR_CODE.DRAFT_NOT_FOUND).toBe("DRAFT_NOT_FOUND");
    expect(SKILL_ERROR_CODE.REVISION_CONFLICT).toBe("REVISION_CONFLICT");
    expect(SKILL_ERROR_CODE.ADAPTER_NOT_INSTALLABLE).toBe("ADAPTER_NOT_INSTALLABLE");
    expect(SKILL_ERROR_CODE.WORKFLOW_PACKAGE_REDIRECT).toBe("WORKFLOW_PACKAGE_REDIRECT");
    // non-wire (internal) codes
    expect(SKILL_ERROR_CODE.SLUG_INVALID).toBe("SKILL_SLUG_INVALID");
    expect(SKILL_ERROR_CODE.FRONTMATTER_INVALID).toBe("FRONTMATTER_INVALID");
  });

  it("skillNameSchema uses SKILL_NAME_REGEX", () => {
    expect(skillNameSchema.safeParse("my-skill").success).toBe(true);
    expect(skillNameSchema.safeParse("-x").success).toBe(false);
  });
});

describe("skill-center schemas", () => {
  const agentCfg = {
    agent: "claude-code",
    enabled: true,
    isDefault: true,
    installTarget: ".claude/skills/harness-x",
    latestVersion: "1.0.0",
    draftVersion: null,
    sourcePackagePath: null
  };
  const validProviderCfg = {
    provider_id: "deepseek",
    label: "DeepSeek",
    base_url: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    enabled: true,
    is_default: true,
    api_key_env: "secret-file",
    revision: 1,
    daily_request_limit: 1000,
    daily_token_limit: 500000,
    created_at: "2026-06-28T00:00:00Z",
    updated_at: "2026-06-28T00:00:00Z",
    models: [{
      id: "m1",
      display_model: "deepseek-v4-pro",
      request_model: "deepseek-v4-pro",
      input_cost: 1,
      output_cost: 2,
      cache_hit_cost: 0.1,
      cache_create_cost: 0.5
    }],
    api_format: "openai",
    note: "",
    website: "https://deepseek.com",
    selected_model_id: "m1",
    sort_order: 0
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

  it("draftState defaults examples (ir optional, legacy tolerated COM-001/002)", () => {
    const d = draftStateSchema.parse({
      slug: "harness-x",
      agent: "claude-code",
      sourceFiles: [{ path: "SKILL.md", content: "..." }],
      draftVersion: "0.1.0",
      checks: null,
      releaseNote: null,
      revision: 1,
      created_at: "2026-06-26T00:00:00Z",
      updated_at: "2026-06-26T00:00:00Z"
    });
    expect(d.examples).toEqual([]);
    expect(d.revision).toBe(1);
    const legacy = draftStateSchema.parse({
      slug: "harness-x",
      agent: "claude-code",
      sourceFiles: [{ path: "SKILL.md", content: "..." }],
      ir: { legacy: "ir-shape" },
      draftVersion: "0.1.0",
      checks: null,
      releaseNote: null,
      revision: 1,
      created_at: "2026-06-26T00:00:00Z",
      updated_at: "2026-06-26T00:00:00Z"
    });
    expect(legacy.ir).toEqual({ legacy: "ir-shape" });
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
    expect(parsed.kind).toBeUndefined();
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.defaultAgent).toBe("claude-code");
    expect(() => registrySkillSummarySchema.parse({ ...s, category: "tooling" })).toThrow();
  });

  it("summary kind 反范式化字段（从 frontmatter 派生，供 dashboard 分类）", () => {
    const base = {
      skill_id: "skl_1", slug: "harness-x", name: "harness-x", description: "d",
      tags: [], status: "published", latest_version: "1.0.0",
      defaultAgent: "claude-code", agents: [agentCfg],
      revision: 1, created_at: "2026-06-26T00:00:00Z", updated_at: "2026-06-26T00:00:00Z"
    };
    expect(registrySkillSummarySchema.parse({ ...base, kind: "workflow" }).kind).toBe("workflow");
    expect(registrySkillSummarySchema.parse({ ...base, kind: null }).kind).toBeNull();
    expect(registrySkillSummarySchema.safeParse({ ...base, kind: "invalid" }).success).toBe(false);
  });

  it("detail defaults sourceFiles/examples (ir optional, legacy tolerated)", () => {
    const d = registrySkillDetailSchema.parse({
      skill_id: "skl_1", slug: "harness-x", name: "harness-x", description: "d",
      tags: [], status: "published", latest_version: "1.0.0",
      defaultAgent: "claude-code", agents: [agentCfg],
      revision: 1, created_at: "2026-06-26T00:00:00Z", updated_at: "2026-06-26T00:00:00Z"
    });
    expect(d.sourceFiles).toEqual([]);
    expect(d.examples).toEqual([]);
    const legacy = registrySkillDetailSchema.parse({
      skill_id: "skl_2", slug: "harness-x", name: "harness-x", description: "d",
      tags: [], status: "published", latest_version: "1.0.0",
      defaultAgent: "claude-code", agents: [agentCfg],
      ir: { legacy: "ir-shape", name: "harness-x" },
      revision: 1, created_at: "2026-06-26T00:00:00Z", updated_at: "2026-06-26T00:00:00Z"
    });
    expect(legacy.ir).toEqual({ legacy: "ir-shape", name: "harness-x" });
  });

  it("version has sourceFiles/examples/changeNote and nullable source_proposal_id", () => {
    const v = registrySkillVersionSchema.parse({
      skill_slug: "harness-x", version: "1.0.0", agent: "claude-code", artifacts: [],
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

  it("aiProviderConfig parses valid with quota (no key) and rejects apiKey extra", () => {
    expect(aiProviderConfigSchema.parse(validProviderCfg)).toEqual(validProviderCfg);
    expect(() => aiProviderConfigSchema.parse({ ...validProviderCfg, apiKey: "sk-xxx" })).toThrow();
  });

  it("aiProviderConfig accepts null quota (explicit unlimited)", () => {
    const cfg = { ...validProviderCfg, daily_request_limit: null, daily_token_limit: null };
    const parsed = aiProviderConfigSchema.parse(cfg);
    expect(parsed.daily_request_limit).toBeNull();
    expect(parsed.daily_token_limit).toBeNull();
  });

  it("aiProviderConfig defaults quota to null when missing (legacy migration COM-002)", () => {
    const legacy = {
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
    const parsed = aiProviderConfigSchema.parse(legacy);
    expect(parsed.daily_request_limit).toBeNull();
    expect(parsed.daily_token_limit).toBeNull();
  });

  it("aiProviderConfig rejects negative or non-integer quota", () => {
    expect(() => aiProviderConfigSchema.parse({ ...validProviderCfg, daily_request_limit: -1 })).toThrow();
    expect(() => aiProviderConfigSchema.parse({ ...validProviderCfg, daily_token_limit: 1.5 })).toThrow();
  });

  it("aiQuotaUsageSchema parses provider_id/date/requests/tokens and is strict", () => {
    const u = {
      provider_id: "deepseek",
      date: "2026-07-01",
      requests: 10,
      tokens: 500,
      model: "deepseek-v4-pro",
      input_tokens: 300,
      output_tokens: 200,
      cache_hit_tokens: 0,
      cache_create_tokens: 0,
      cost: 0.0007
    };
    expect(aiQuotaUsageSchema.parse(u)).toEqual(u);
    expect(() => aiQuotaUsageSchema.parse({ ...u, extra: 1 })).toThrow();
    expect(() => aiQuotaUsageSchema.parse({ provider_id: "x", date: "2026-07-01", requests: -1, tokens: 0 })).toThrow();
  });

  it("providerModelSchema parses valid model with costs and defaults missing costs to 0 (U-01)", () => {
    const m = providerModelSchema.parse({
      id: "m1", display_model: "v4", request_model: "v4",
      input_cost: 1, output_cost: 2, cache_hit_cost: 0.1, cache_create_cost: 0.5
    });
    expect(m.input_cost).toBe(1);
    // 缺省成本字段默认 0（迁移生成条目兼容）
    const partial = providerModelSchema.parse({ id: "m2", display_model: "v4-lite", request_model: "v4-lite" });
    expect(partial.input_cost).toBe(0);
    expect(partial.output_cost).toBe(0);
    expect(() => providerModelSchema.parse({ id: "m3", display_model: "x", request_model: "x", extra: 1 })).toThrow();
  });

  it("aiProviderConfig accepts multi-model fields (U-02)", () => {
    const parsed = aiProviderConfigSchema.parse(validProviderCfg);
    expect(parsed.models).toHaveLength(1);
    expect(parsed.models[0]?.id).toBe("m1");
    expect(parsed.api_format).toBe("openai");
    expect(parsed.note).toBe("");
    expect(parsed.website).toBe("https://deepseek.com");
    expect(parsed.selected_model_id).toBe("m1");
    expect(parsed.sort_order).toBe(0);
  });

  it("aiProviderConfig legacy without models defaults to []/openai/null/0 (U-03 contracts)", () => {
    const legacy = {
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
    const parsed = aiProviderConfigSchema.parse(legacy);
    expect(parsed.models).toEqual([]);
    expect(parsed.api_format).toBe("openai");
    expect(parsed.selected_model_id).toBeNull();
    expect(parsed.sort_order).toBe(0);
  });

  it("aiProviderConfig rejects invalid api_format (U-02b)", () => {
    expect(() => aiProviderConfigSchema.parse({ ...validProviderCfg, api_format: "gemini" })).toThrow();
  });

  it("aiQuotaUsage per-model fields parse with defaults (U-04)", () => {
    const parsed = aiQuotaUsageSchema.parse({
      provider_id: "deepseek", date: "2026-07-01", requests: 10, tokens: 500,
      model: "deepseek-v4-pro", input_tokens: 300, output_tokens: 200, cache_hit_tokens: 0, cost: 0.0007
    });
    expect(parsed.model).toBe("deepseek-v4-pro");
    expect(parsed.input_tokens).toBe(300);
    expect(parsed.cache_create_tokens).toBe(0);
    expect(parsed.cost).toBe(0.0007);
    // 旧条目（无 per-model 字段）默认 ""/0
    const legacy = aiQuotaUsageSchema.parse({ provider_id: "x", date: "2026-07-01", requests: 1, tokens: 10 });
    expect(legacy.model).toBe("");
    expect(legacy.input_tokens).toBe(0);
    expect(legacy.cache_create_tokens).toBe(0);
    expect(legacy.cost).toBe(0);
  });

  it("aiProviderReorderRequest requires non-empty provider_ids array (U-reorder)", () => {
    expect(aiProviderReorderRequestSchema.parse({ schema_version: 1, provider_ids: ["a", "b"] }).provider_ids).toEqual(["a", "b"]);
    expect(() => aiProviderReorderRequestSchema.parse({ schema_version: 1, provider_ids: [] })).toThrow();
    expect(() => aiProviderReorderRequestSchema.parse({ schema_version: 1, provider_ids: ["", "b"] })).toThrow();
    expect(() => aiProviderReorderRequestSchema.parse({ schema_version: 1, provider_ids: ["a"], extra: 1 })).toThrow();
  });

  it("aiProviderApiFormatSchema accepts openai/anthropic/custom only", () => {
    expect(aiProviderApiFormatSchema.parse("openai")).toBe("openai");
    expect(aiProviderApiFormatSchema.parse("anthropic")).toBe("anthropic");
    expect(aiProviderApiFormatSchema.parse("custom")).toBe("custom");
    expect(aiProviderApiFormatSchema.safeParse("gemini").success).toBe(false);
  });

  it("aiConfigState has nullable defaultProvider and providers array", () => {
    expect(aiConfigStateSchema.parse({ defaultProvider: null, providers: [] }).defaultProvider).toBeNull();
    expect(aiConfigStateSchema.parse({ defaultProvider: "deepseek", providers: [] }).providers).toEqual([]);
  });

  it("aiConfigState defaults usage to [] and accepts usage array", () => {
    expect(aiConfigStateSchema.parse({ defaultProvider: null, providers: [] }).usage).toEqual([]);
    const state = aiConfigStateSchema.parse({
      defaultProvider: "deepseek",
      providers: [],
      usage: [{ provider_id: "deepseek", date: "2026-07-01", requests: 5, tokens: 100 }]
    });
    expect(state.usage).toHaveLength(1);
    expect(state.usage[0]?.requests).toBe(5);
  });

  it("aiConfigState legacy data without usage migrates to [] (COM-001)", () => {
    const legacy = { defaultProvider: "deepseek", providers: [] };
    expect(aiConfigStateSchema.parse(legacy).usage).toEqual([]);
  });

  it("draftState defaults aiChecks to null (separate from program checks)", () => {
    const d = draftStateSchema.parse({
      slug: "harness-x",
      agent: "claude-code",
      sourceFiles: [{ path: "SKILL.md", content: "..." }],
      draftVersion: "0.1.0",
      checks: null,
      releaseNote: null,
      revision: 1,
      created_at: "2026-06-26T00:00:00Z",
      updated_at: "2026-06-26T00:00:00Z"
    });
    expect(d.aiChecks).toBeNull();
  });

  it("draftState requires agent field (per-agent version)", () => {
    const base = {
      slug: "harness-x",
      sourceFiles: [{ path: "SKILL.md", content: "..." }],
      draftVersion: "0.1.0",
      checks: null,
      releaseNote: null,
      revision: 1,
      created_at: "2026-06-26T00:00:00Z",
      updated_at: "2026-06-26T00:00:00Z"
    };
    expect(draftStateSchema.safeParse(base).success).toBe(false);
    expect(draftStateSchema.safeParse({ ...base, agent: "cursor" }).success).toBe(true);
    expect(draftStateSchema.parse({ ...base, agent: "cursor" }).agent).toBe("cursor");
  });

  it("registrySkillVersion requires agent field (per-agent version)", () => {
    const base = {
      skill_slug: "harness-x", version: "1.0.0", artifacts: [],
      source_proposal_id: null, sourceFiles: [], examples: [], changeNote: null,
      created_at: "2026-06-26T00:00:00Z"
    };
    expect(registrySkillVersionSchema.safeParse(base).success).toBe(false);
    expect(registrySkillVersionSchema.safeParse({ ...base, agent: "claude-code" }).success).toBe(true);
    expect(registrySkillVersionSchema.parse({ ...base, agent: "claude-code" }).agent).toBe("claude-code");
  });

  it("setDefaultAgentRequest requires defaultAgent + positive revision (strict)", () => {
    expect(setDefaultAgentRequestSchema.parse({ defaultAgent: "cursor", revision: 1 }).defaultAgent).toBe("cursor");
    expect(setDefaultAgentRequestSchema.safeParse({ defaultAgent: "cursor", revision: 0 }).success).toBe(false);
    expect(setDefaultAgentRequestSchema.safeParse({ defaultAgent: "invalid", revision: 1 }).success).toBe(false);
    expect(setDefaultAgentRequestSchema.safeParse({ revision: 1 }).success).toBe(false);
    expect(() => setDefaultAgentRequestSchema.parse({ defaultAgent: "cursor", revision: 1, extra: 1 })).toThrow();
  });
});

describe("aiProviderWithKeySet schema (key_set 响应字段)", () => {
  const validWithKeySet = {
    provider_id: "deepseek",
    label: "DeepSeek",
    base_url: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    enabled: true,
    is_default: true,
    api_key_env: "secret-file",
    revision: 1,
    created_at: "2026-06-28T00:00:00Z",
    updated_at: "2026-06-28T00:00:00Z",
    key_set: true
  };

  it("parses valid provider with key_set (U-01)", () => {
    const parsed = aiProviderWithKeySetSchema.parse(validWithKeySet);
    expect(parsed.key_set).toBe(true);
  });

  it("rejects missing key_set (U-02)", () => {
    const { key_set, ...withoutKeySet } = validWithKeySet;
    void key_set;
    expect(aiProviderWithKeySetSchema.safeParse(withoutKeySet).success).toBe(false);
  });

  it("rejects non-boolean key_set (U-03)", () => {
    expect(aiProviderWithKeySetSchema.safeParse({ ...validWithKeySet, key_set: "yes" }).success).toBe(false);
  });
});

describe("aiJobState schema (dedup key: slug+agent)", () => {
  const validAiJob = {
    jobId: "aijob_1",
    slug: "harness-review",
    agent: "claude-code",
    status: "running",
    result: null,
    error: null,
    createdAt: "2026-07-01T00:00:00Z",
    expiresAt: "2026-07-01T01:00:00Z"
  };

  it("parses valid AiJobState with slug+agent", () => {
    const parsed = aiJobStateSchema.parse(validAiJob);
    expect(parsed.slug).toBe("harness-review");
    expect(parsed.agent).toBe("claude-code");
    expect(parsed.status).toBe("running");
  });

  it("rejects missing slug (dedup key required)", () => {
    const { slug, ...withoutSlug } = validAiJob;
    void slug;
    expect(aiJobStateSchema.safeParse(withoutSlug).success).toBe(false);
  });

  it("rejects missing agent (dedup key required)", () => {
    const { agent, ...withoutAgent } = validAiJob;
    void agent;
    expect(aiJobStateSchema.safeParse(withoutAgent).success).toBe(false);
  });

  it("rejects invalid agent (must be registry agent)", () => {
    expect(aiJobStateSchema.safeParse({ ...validAiJob, agent: "unknown-agent" }).success).toBe(false);
  });

  it("rejects unknown fields (strict)", () => {
    expect(() => aiJobStateSchema.parse({ ...validAiJob, extra: 1 })).toThrow();
  });

  it("accepts completed status with SkillCheckResult", () => {
    const completed = {
      ...validAiJob,
      status: "completed",
      result: {
        items: [],
        summary: { green: 0, yellow: 0, red: 0 },
        checkedAt: "2026-07-01T00:00:00Z"
      }
    };
    expect(aiJobStateSchema.parse(completed).status).toBe("completed");
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

describe("fix plan schemas", () => {
  it("accepts a valid fix plan", () => {
    const plan = {
      items: [{
        checkId: "VERSION",
        action: "auto",
        label: "版本前进",
        affectedPaths: ["skill-ir.json"],
        riskDelta: null,
        message: "1.0.0 → 1.0.1"
      }],
      mergedFiles: [{ path: "skill-ir.json", status: "modified", publishedContent: "{}", draftContent: "{}\n" }],
      summary: { autoCount: 1, confirmCount: 0, suggestCount: 0, changedFiles: 1, changedLines: 1 }
    };
    expect(fixPlanSchema.parse(plan).items).toHaveLength(1);
  });

  it("rejects invalid action", () => {
    expect(() => fixActionSchema.parse("auto-magic")).toThrow();
  });

  it("rejects extra fields on fixPlan (strict)", () => {
    const plan = {
      items: [],
      mergedFiles: [],
      summary: { autoCount: 0, confirmCount: 0, suggestCount: 0, changedFiles: 0, changedLines: 0 },
      extra: true
    };
    expect(() => fixPlanSchema.parse(plan)).toThrow();
  });

  it("fixPlanItem accepts optional AI suggestion fields", () => {
    const item = {
      checkId: "AI_USAGE_EXAMPLES",
      action: "suggest",
      label: "使用示例",
      affectedPaths: [],
      riskDelta: null,
      message: "缺少示例",
      suggestedContent: '[{"title":"t","description":"d","request":"r","result":"s"}]',
      explanation: "补充一个使用示例",
      appliesTo: "examples",
      generatedAt: "2026-06-29T00:00:00.000Z"
    };
    expect(fixPlanItemSchema.safeParse(item).success).toBe(true);
  });

  it("fixPlanItem accepts legacy item without AI suggestion fields", () => {
    const legacy = {
      checkId: "VERSION",
      action: "auto",
      label: "版本",
      affectedPaths: ["skill-ir.json"],
      riskDelta: null,
      message: "bump"
    };
    expect(fixPlanItemSchema.safeParse(legacy).success).toBe(true);
  });

  it("fixPlanItem rejects non-whitelist appliesTo", () => {
    const item = {
      checkId: "x",
      action: "suggest",
      label: "l",
      affectedPaths: [],
      riskDelta: null,
      message: "m",
      appliesTo: "ir.secret"
    };
    expect(fixPlanItemSchema.safeParse(item).success).toBe(false);
  });
});

describe("cursor adapter + managed-block block_id (T1)", () => {
  it("cursor is a valid registry agent and adapter name", () => {
    expect(registryAgentSchema.safeParse("cursor").success).toBe(true);
    expect(adapterNameSchema.safeParse("cursor").success).toBe(true);
  });

  it("modify op accepts optional block_id for managed-block install", () => {
    const result = modifyOperationSchema.safeParse({
      operation: "modify",
      path: "AGENTS.md",
      file_kind: "user_editable",
      base_content_sha256: "sha256:" + "a".repeat(64),
      content_sha256: "sha256:" + "b".repeat(64),
      size_bytes: 10,
      block_id: "harness-skill-x"
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.block_id).toBe("harness-skill-x");
    }
  });

  it("modify op without block_id still valid (backward compat)", () => {
    const result = modifyOperationSchema.safeParse({
      operation: "modify",
      path: "AGENTS.md",
      file_kind: "user_editable",
      base_content_sha256: "sha256:" + "a".repeat(64),
      content_sha256: "sha256:" + "b".repeat(64),
      size_bytes: 10
    });
    expect(result.success).toBe(true);
  });

  it("add op accepts optional block_id", () => {
    const result = addOperationSchema.safeParse({
      operation: "add",
      path: "AGENTS.md",
      file_kind: "user_editable",
      content_sha256: "sha256:" + "b".repeat(64),
      size_bytes: 10,
      block_id: "harness-skill-y"
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.block_id).toBe("harness-skill-y");
    }
  });

  it("fileOperation union dispatches modify with block_id", () => {
    const result = fileOperationSchema.safeParse({
      operation: "modify",
      path: "AGENTS.md",
      file_kind: "user_editable",
      base_content_sha256: "sha256:" + "a".repeat(64),
      content_sha256: "sha256:" + "b".repeat(64),
      size_bytes: 10,
      block_id: "harness-skill-z"
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.operation === "modify") {
      expect(result.data.block_id).toBe("harness-skill-z");
    }
  });
});

describe("workflow package schemas", () => {
  const validManifest = {
    key: "release-flow",
    name: "Release Flow",
    description: "End-to-end release workflow",
    profile: "general",
    skills: [{ slug: "harness-sync", ref: "1.0.0" }],
    agents: [{ path: "agents/release.md", ref: "main" }],
    protocols: [{ path: "protocols/review.md", ref: "main" }],
    templates: [{ path: "templates/report.md", ref: "main" }],
    execution_order: ["harness-sync"],
    strategy: "sequential"
  };

  it("manifest parses skills/agents/protocols/templates refs + execution_order + strategy", () => {
    const m = workflowPackageManifestSchema.parse(validManifest);
    expect(m.strategy).toBe("sequential");
    expect(m.execution_order).toEqual(["harness-sync"]);
    expect(m.skills[0].slug).toBe("harness-sync");
    expect(m.agents[0].path).toBe("agents/release.md");
  });

  it("manifest rejects invalid strategy", () => {
    expect(() => workflowPackageManifestSchema.parse({ ...validManifest, strategy: "teleport" })).toThrow();
  });

  it("manifest rejects extra fields (strict)", () => {
    expect(() => workflowPackageManifestSchema.parse({ ...validManifest, extra: 1 })).toThrow();
  });

  it("draftState requires key/manifest/sourceFiles/revision and accepts nullable checks", () => {
    const d = workflowPackageDraftStateSchema.parse({
      key: "release-flow",
      manifest: validManifest,
      sourceFiles: [{ path: "workflow.yaml", content: "key: release-flow" }],
      draftVersion: "0.1.0",
      checks: null,
      releaseNote: null,
      revision: 1,
      created_at: "2026-06-30T00:00:00Z",
      updated_at: "2026-06-30T00:00:00Z"
    });
    expect(d.checks).toBeNull();
    expect(d.revision).toBe(1);
  });

  it("version carries manifest + artifacts + nullable changeNote", () => {
    const v = workflowPackageVersionSchema.parse({
      package_key: "release-flow",
      version: "1.0.0",
      manifest: validManifest,
      artifacts: [{
        artifact_id: "wfa_1",
        package_key: "release-flow",
        version: "1.0.0",
        content_sha256: "sha256:" + "a".repeat(64),
        size_bytes: 10,
        created_at: "2026-06-30T00:00:00Z"
      }],
      sourceFiles: [],
      changeNote: null,
      created_at: "2026-06-30T00:00:00Z"
    });
    expect(v.artifacts).toHaveLength(1);
    expect(v.changeNote).toBeNull();
  });

  it("package has package_id/key/manifest/latestVersion/revision and rejects extras", () => {
    const p = workflowPackageSchema.parse({
      package_id: "wfp_1",
      key: "release-flow",
      manifest: validManifest,
      latestVersion: "1.0.0",
      revision: 1,
      created_at: "2026-06-30T00:00:00Z",
      updated_at: "2026-06-30T00:00:00Z"
    });
    expect(p.latestVersion).toBe("1.0.0");
    expect(() => workflowPackageSchema.parse({ ...p, extra: 1 })).toThrow();
  });

  it("publishWorkflowPackageRequest requires version and accepts optional releaseNote", () => {
    expect(() => publishWorkflowPackageRequestSchema.parse({})).toThrow();
    expect(publishWorkflowPackageRequestSchema.parse({ version: "1.0.0" }).releaseNote).toBeUndefined();
    expect(publishWorkflowPackageRequestSchema.parse({ version: "1.0.0", releaseNote: "init" }).releaseNote).toBe("init");
  });
});

describe("mcp tool contract schema (UT-010~012)", () => {
  const validContract = {
    tool_name: "harness-foo",
    description: "foo tool",
    input_schema: {
      type: "object",
      properties: { doc: { type: "string" } },
      required: ["doc"]
    }
  };

  it("round-trips a valid mcp tool contract (UT-010)", () => {
    const parsed = mcpToolContractSchema.parse(validContract);
    expect(parsed.tool_name).toBe("harness-foo");
    expect(parsed.description).toBe("foo tool");
    expect(parsed.input_schema).toEqual(validContract.input_schema);
  });

  it("rejects contract missing tool_name (UT-011)", () => {
    expect(mcpToolContractSchema.safeParse({
      description: "foo tool",
      input_schema: { type: "object", properties: {}, required: [] }
    }).success).toBe(false);
  });

  it("rejects contract missing input_schema (UT-012)", () => {
    expect(mcpToolContractSchema.safeParse({
      tool_name: "harness-foo",
      description: "foo tool"
    }).success).toBe(false);
  });

  it("rejects unknown fields (strict)", () => {
    expect(mcpToolContractSchema.safeParse({ ...validContract, extra: 1 }).success).toBe(false);
  });
});
