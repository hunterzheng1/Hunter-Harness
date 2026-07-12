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
