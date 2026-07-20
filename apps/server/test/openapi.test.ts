import { readFile } from "node:fs/promises";

import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

describe("OpenAPI v1 contract", () => {
  it("covers every implemented public HTTP route with unique operation IDs", async () => {
    const document = parseYaml(await readFile(
      new URL("../openapi/hunter-harness-v1.yaml", import.meta.url),
      "utf8"
    )) as {
      openapi: string;
      paths: Record<string, Record<string, { operationId?: string }>>;
    };
    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(document.paths).sort()).toEqual([
      "/api/v1/artifacts/{artifact_id}/blobs/{content_sha256}",
      "/api/v1/artifacts/{artifact_id}/manifest",
      "/api/v1/dashboard/overview",
      "/api/v1/external-skills",
      "/api/v1/external-skills/{id}",
      "/api/v1/external-skills/{id}/refresh",
      "/mcp",
      "/api/v1/projects",
      "/api/v1/projects/{project_id}",
      "/api/v1/projects/{project_id}/artifacts",
      "/api/v1/projects/{project_id}/workflow-binding",
      "/api/v1/projects/{project_id}/semantic/overview",
      "/api/v1/projects/{project_id}/semantic/knowledge",
      "/api/v1/projects/{project_id}/semantic/rules",
      "/api/v1/projects/{project_id}/semantic/changes",
      "/api/v1/projects/{project_id}/semantic/graph",
      "/api/v1/projects/{project_id}/proposal-sessions",
      "/api/v1/projects/{project_id}/proposals",
      "/api/v1/projects/{project_id}/update-manifest",
      "/api/v1/projects:resolve",
      "/api/v1/proposal-sessions/{session_id}/blobs/{content_sha256}",
      "/api/v1/proposal-sessions/{session_id}/blobs:query",
      "/api/v1/proposal-sessions/{session_id}:finalize",
      "/api/v1/proposals/{proposal_id}",
      "/api/v1/semantic/search",
      "/api/v1/skill-artifacts",
      "/api/v1/skills",
      "/api/v1/skills/draft",
      "/api/v1/skills/{slug}",
      "/api/v1/skills/{slug}/adapter-preview/{agent}",
      "/api/v1/skills/{slug}/artifacts/{agent}/download",
      "/api/v1/skills/{slug}/default-agent",
      "/api/v1/skills/{slug}/draft/{agent}",
      "/api/v1/skills/{slug}/draft/{agent}/ai-checks",
      "/api/v1/skills/{slug}/draft/{agent}/apply-fix",
      "/api/v1/skills/{slug}/draft/{agent}/apply-fix-suggestion",
      "/api/v1/skills/{slug}/draft/{agent}/checks",
      "/api/v1/skills/{slug}/draft/{agent}/diff",
      "/api/v1/skills/{slug}/draft/{agent}/fix-preview",
      "/api/v1/skills/{slug}/draft/{agent}/fix-suggestions",
      "/api/v1/skills/{slug}/draft/{agent}/publish",
      "/api/v1/skills/{slug}/publish",
      "/api/v1/skills/{slug}/npm-release",
      "/api/v1/skills/{slug}/draft/{agent}/release-note:generate",
      "/api/v1/skills/{slug}/tags/{tag_id}",
      "/api/v1/skills/{slug}/versions",
      "/api/v1/tags",
      "/api/v1/tags/{tag_id}",
      "/api/v1/tags/{tag_id}/merge",
      "/api/v1/workflow-families",
      "/api/v1/workflow-families/{slug}",
      "/api/v1/workflow-families/{slug}/draft",
      "/api/v1/workflow-families/{slug}/draft/checks",
      "/api/v1/workflow-families/{slug}/draft/diff",
      "/api/v1/workflow-families/{slug}/draft/profiles/{profile}",
      "/api/v1/workflow-families/{slug}/publish",
      "/api/v1/workflow-families/{slug}/npm-release",
      "/api/v1/workflow-families/{slug}/versions",
      "/api/v1/workflow-families/{slug}/artifacts/{profile}/download",
      "/api/v1/ai-config/providers",
      "/api/v1/ai-config/providers/{provider_id}",
      "/api/v1/ai-config/providers/{provider_id}/test",
      "/api/v1/ai-config/usage",
      "/api/v1/ai-jobs/{jobId}",
      "/health"
    ].sort());
    const operationIds = Object.values(document.paths).flatMap((path) =>
      Object.values(path).map((operation) => operation.operationId).filter(Boolean)
    );
    expect(new Set(operationIds).size).toBe(operationIds.length);
  });

  it("documents unified publish, review errors, and deprecated compatibility routes", async () => {
    const document = parseYaml(await readFile(
      new URL("../openapi/hunter-harness-v1.yaml", import.meta.url),
      "utf8"
    )) as {
      paths: Record<string, Record<string, {
        deprecated?: boolean;
        responses?: Record<string, unknown>;
        requestBody?: { content?: Record<string, { schema?: { $ref?: string } }> };
      }>>;
      components: { schemas: Record<string, { enum?: string[] }> };
    };
    const publish = document.paths["/api/v1/skills/{slug}/publish"]?.post;
    expect(publish?.responses).toHaveProperty("502");
    expect(publish?.responses).toHaveProperty("503");
    expect(publish?.requestBody?.content?.["application/json"]?.schema?.$ref)
      .toBe("#/components/schemas/PublishUnifiedSkillRequest");
    expect(document.paths["/api/v1/skills/{slug}/draft/{agent}/publish"]?.post?.deprecated).toBe(true);
    expect(document.paths["/api/v1/skills/{slug}/npm-release"]?.post?.deprecated).toBe(true);
    expect(document.components.schemas.RegistryAgent?.enum).toContain("codebuddy");
  });

  it("documents STALE_PUSH as a 409 response on finalizeProposal", async () => {
    const document = parseYaml(await readFile(
      new URL("../openapi/hunter-harness-v1.yaml", import.meta.url),
      "utf8"
    )) as {
      paths: Record<string, Record<string, {
        operationId?: string;
        requestBody?: {
          content?: { "application/json"?: { schema?: { $ref?: string } } };
        };
        responses?: Record<string, { description?: string }>;
      }>>;
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
    };
    const finalize = document.paths["/api/v1/proposal-sessions/{session_id}:finalize"]?.post;
    expect(finalize?.operationId).toBe("finalizeProposal");
    expect(finalize?.responses?.["409"]?.description).toContain("STALE_PUSH");
    expect(finalize?.responses?.["422"]?.description).toContain("SENSITIVE_CONTENT_BLOCKED");
    expect(finalize?.requestBody?.content?.["application/json"]?.schema?.$ref)
      .toBe("#/components/schemas/FinalizeProposalRequest");
    expect(document.components.schemas.FinalizeProposalRequest?.properties?.sensitive_scan_skip)
      .toMatchObject({ const: true });
  });

  it("ai-jobs GET 200 response schema includes slug+agent dedup key (Y9)", async () => {
    const document = parseYaml(await readFile(
      new URL("../openapi/hunter-harness-v1.yaml", import.meta.url),
      "utf8"
    )) as {
      paths: Record<string, Record<string, {
        responses: Record<string, {
          content?: { "application/json"?: { schema?: { properties?: Record<string, { enum?: string[] }> } } };
        }>;
      }>>;
    };
    const schema = document.paths["/api/v1/ai-jobs/{jobId}"]?.get?.responses["200"]
      ?.content?.["application/json"]?.schema;
    const props = Object.keys(schema?.properties ?? {});
    expect(props).toEqual(expect.arrayContaining([
      "jobId", "slug", "agent", "status", "result", "error", "createdAt", "expiresAt"
    ]));
    expect(schema?.properties?.agent?.enum).toEqual(["claude-code", "codex", "cursor", "generic", "mcp"]);
  });
});
