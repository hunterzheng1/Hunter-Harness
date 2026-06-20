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
      "/api/v1/projects",
      "/api/v1/projects/{project_id}",
      "/api/v1/projects/{project_id}/artifacts",
      "/api/v1/projects/{project_id}/proposal-sessions",
      "/api/v1/projects/{project_id}/proposals",
      "/api/v1/projects/{project_id}/update-manifest",
      "/api/v1/projects:resolve",
      "/api/v1/proposal-sessions/{session_id}/blobs/{content_sha256}",
      "/api/v1/proposal-sessions/{session_id}/blobs:query",
      "/api/v1/proposal-sessions/{session_id}:finalize",
      "/api/v1/proposals/{proposal_id}",
      "/api/v1/proposals/{proposal_id}/review-decisions",
      "/health"
    ].sort());
    const operationIds = Object.values(document.paths).flatMap((path) =>
      Object.values(path).map((operation) => operation.operationId).filter(Boolean)
    );
    expect(new Set(operationIds).size).toBe(operationIds.length);
  });
});
