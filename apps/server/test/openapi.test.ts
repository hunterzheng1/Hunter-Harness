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
      "/api/v1/projects",
      "/api/v1/projects/{project_id}",
      "/api/v1/projects/{project_id}/artifacts",
      "/api/v1/projects/{project_id}/workflow-binding",
      "/api/v1/projects/{project_id}/proposal-sessions",
      "/api/v1/projects/{project_id}/proposals",
      "/api/v1/projects/{project_id}/update-manifest",
      "/api/v1/projects:resolve",
      "/api/v1/proposal-sessions/{session_id}/blobs/{content_sha256}",
      "/api/v1/proposal-sessions/{session_id}/blobs:query",
      "/api/v1/proposal-sessions/{session_id}:finalize",
      "/api/v1/proposals/{proposal_id}",
      "/api/v1/proposals/{proposal_id}/review-decisions",
      "/api/v1/skill-artifacts",
      "/api/v1/skill-proposals",
      "/api/v1/skill-proposals/{proposal_id}",
      "/api/v1/skill-proposals/{proposal_id}/review",
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
      "/api/v1/skills/{slug}/draft/{agent}/release-note:generate",
      "/api/v1/skills/{slug}/tags/{tag_id}",
      "/api/v1/skills/{slug}/versions",
      "/api/v1/tags",
      "/api/v1/tags/{tag_id}",
      "/api/v1/tags/{tag_id}/merge",
      "/api/v1/workflows",
      "/api/v1/workflows/{workflow_id}",
      "/api/v1/ai-config/providers",
      "/api/v1/ai-config/providers/{provider_id}",
      "/api/v1/ai-config/providers/{provider_id}/test",
      "/api/v1/ai-config/usage",
      "/health"
    ].sort());
    const operationIds = Object.values(document.paths).flatMap((path) =>
      Object.values(path).map((operation) => operation.operationId).filter(Boolean)
    );
    expect(new Set(operationIds).size).toBe(operationIds.length);
  });
});
