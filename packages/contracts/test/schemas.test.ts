import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

import {
  apiErrorEnvelopeSchema,
  artifactManifestSchema,
  canonicalJson,
  filePolicySchema,
  initConfigSchema,
  knowledgeFrontmatterSchema,
  projectConfigSchema,
  registryAgentSchema,
  registrySkillDetailSchema,
  registrySkillProposalSchema,
  registryTagSchema,
  registryWorkflowSchema,
  skillIrSchema
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
      category: "governance",
      tags: ["review", "security"],
      status: "published",
      latest_version: "1.1.0",
      ir,
      adapters: ["claude-code"],
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
