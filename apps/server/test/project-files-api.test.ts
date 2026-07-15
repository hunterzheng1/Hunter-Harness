import { canonicalJson } from "@hunter-harness/contracts";
import { sha256Bytes, uuidV7 } from "@hunter-harness/core";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/app.js";
import { MemoryRepository } from "../src/repositories/memory.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";

describe("project current files API", () => {
  const token = "project-files-token";
  let app: Awaited<ReturnType<typeof createServer>>;
  let repository: MemoryRepository;
  let storage: MemoryArtifactStorage;

  beforeEach(async () => {
    repository = new MemoryRepository();
    storage = new MemoryArtifactStorage();
    await repository.createActorWithToken({ actorId: "actor_owner", token });
    app = await createServer({ repository, storage });
  });

  afterEach(async () => {
    await app.close();
  });

  function headers(): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      "x-request-id": uuidV7(),
      "idempotency-key": uuidV7()
    };
  }

  async function resolveProject(): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects:resolve",
      headers: headers(),
      payload: {
        schema_version: 1,
        local_project_key: uuidV7(),
        display_name: "file snapshot",
        requested_project_id: null,
        client_id: "cli_test"
      }
    });
    expect(response.statusCode).toBe(200);
    return response.json().project_id as string;
  }

  async function uploadAndFinalize(
    projectId: string,
    operations: Array<Record<string, unknown>>,
    contents: Record<string, string>,
    baseProjectVersion: string | null,
    baseArtifactId: string | null
  ): Promise<LightMyRequestResponse> {
    const session = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/proposal-sessions`,
      headers: headers(),
      payload: {
        schema_version: 1,
        request_id: uuidV7(),
        client_id: "cli_test",
        base_project_version: baseProjectVersion,
        base_manifest_hash: sha256Bytes(canonicalJson({ baseProjectVersion })),
        proposal_manifest: { files: operations },
        artifact_manifest: { schema_version: 1, files: operations }
      }
    });
    expect(session.statusCode).toBe(201);
    const sessionId = session.json().session_id as string;
    for (const hash of session.json().missing_blobs as string[]) {
      const content = contents[hash];
      expect(content).toBeDefined();
      const bytes = Buffer.from(content);
      const upload = await app.inject({
        method: "PUT",
        url: `/api/v1/proposal-sessions/${sessionId}/blobs/${encodeURIComponent(hash)}`,
        headers: {
          ...headers(),
          "content-type": "application/octet-stream",
          "content-range": bytes.byteLength === 0
            ? "bytes */0"
            : `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`,
          "x-chunk-sha256": hash
        },
        payload: bytes
      });
      expect(upload.statusCode).toBe(201);
    }
    return app.inject({
      method: "POST",
      url: `/api/v1/proposal-sessions/${sessionId}:finalize`,
      headers: headers(),
      payload: {
        schema_version: 1,
        manifest_sha256: sha256Bytes(canonicalJson(operations)),
        base_artifact_id: baseArtifactId
      }
    });
  }

  it("materializes the current tree and loads file content only when requested", async () => {
    const projectId = await resolveProject();
    const initial = {
      ".claude/rules/a.md": "# A v1\n",
      ".claude/rules/b.md": "# B\n",
      ".claude/rules/c.md": "# C\n",
      ".claude/rules/untouched.md": "# Untouched\n"
    };
    const initialOperations = Object.entries(initial).map(([path, content]) => ({
      operation: "add",
      path,
      file_kind: "user_editable",
      content_sha256: sha256Bytes(content),
      size_bytes: Buffer.byteLength(content)
    }));
    const first = await uploadAndFinalize(
      projectId,
      initialOperations,
      Object.fromEntries(Object.values(initial).map((content) => [sha256Bytes(content), content])),
      null,
      null
    );
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ status: "approved" });

    const firstList = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/files`,
      headers: headers()
    });
    expect(firstList.statusCode).toBe(200);
    expect(firstList.json()).toMatchObject({
      total: 4,
      project_version: expect.stringMatching(/^pv_/),
      items: expect.arrayContaining([
        expect.objectContaining({
          path: ".claude/rules/a.md",
          file_kind: "user_editable",
          content_sha256: sha256Bytes(initial[".claude/rules/a.md"])
        })
      ])
    });
    expect(firstList.body).not.toContain("# A v1");

    const firstProjectVersion = firstList.json().project_version as string;
    const firstArtifactId = first.json().artifact_id as string;
    const updatedA = "# A v2\n";
    const updatedB = initial[".claude/rules/b.md"];
    const operations = [
      {
        operation: "modify",
        path: ".claude/rules/a.md",
        file_kind: "user_editable",
        base_content_sha256: sha256Bytes(initial[".claude/rules/a.md"]),
        content_sha256: sha256Bytes(updatedA),
        size_bytes: Buffer.byteLength(updatedA)
      },
      {
        operation: "rename",
        from_path: ".claude/rules/b.md",
        to_path: ".claude/rules/renamed-b.md",
        file_kind: "user_editable",
        base_content_sha256: sha256Bytes(updatedB),
        content_sha256: sha256Bytes(updatedB),
        size_bytes: Buffer.byteLength(updatedB)
      },
      {
        operation: "delete",
        path: ".claude/rules/c.md",
        file_kind: "user_editable",
        base_content_sha256: sha256Bytes(initial[".claude/rules/c.md"]),
        tombstone: {
          deleted_at: new Date().toISOString(),
          reason: "no longer needed",
          previous_sha256: sha256Bytes(initial[".claude/rules/c.md"])
        }
      }
    ];
    const second = await uploadAndFinalize(
      projectId,
      operations,
      {
        [sha256Bytes(updatedA)]: updatedA,
        [sha256Bytes(updatedB)]: updatedB
      },
      firstProjectVersion,
      firstArtifactId
    );
    expect(second.statusCode).toBe(201);

    const current = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/files`,
      headers: headers()
    });
    expect(current.statusCode).toBe(200);
    expect(current.json().items.map((item: { path: string }) => item.path)).toEqual([
      ".claude/rules/a.md",
      ".claude/rules/renamed-b.md",
      ".claude/rules/untouched.md"
    ]);

    const semanticRules = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/semantic/rules`,
      headers: headers()
    });
    expect(semanticRules.statusCode).toBe(200);
    expect(semanticRules.json().items.map((item: { source_path: string }) => item.source_path)).toEqual([
      ".claude/rules/a.md",
      ".claude/rules/renamed-b.md",
      ".claude/rules/untouched.md"
    ]);

    const content = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/files/content?path=${encodeURIComponent(".claude/rules/a.md")}`,
      headers: headers()
    });
    expect(content.statusCode).toBe(200);
    expect(content.json()).toMatchObject({
      path: ".claude/rules/a.md",
      content: updatedA,
      content_sha256: sha256Bytes(updatedA)
    });

    const removed = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/files/content?path=${encodeURIComponent(".claude/rules/c.md")}`,
      headers: headers()
    });
    expect(removed.statusCode).toBe(404);
    expect(removed.json()).toMatchObject({ error: { code: "PROJECT_FILE_NOT_FOUND" } });

    const otherProjectId = await resolveProject();
    const sharedOperation = [{
      operation: "add",
      path: ".claude/rules/shared.md",
      file_kind: "user_editable",
      content_sha256: sha256Bytes(updatedA),
      size_bytes: Buffer.byteLength(updatedA)
    }];
    const shared = await uploadAndFinalize(
      otherProjectId,
      sharedOperation,
      { [sha256Bytes(updatedA)]: updatedA },
      null,
      null
    );
    expect(shared.statusCode).toBe(201);

    const archived = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}`,
      headers: headers()
    });
    expect(archived.statusCode).toBe(200);
    const purged = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}/purge`,
      headers: headers()
    });
    expect(purged.statusCode).toBe(200);
    expect(await storage.hasBlob(sha256Bytes(updatedA))).toBe(true);
    expect(await storage.hasBlob(sha256Bytes(initial[".claude/rules/untouched.md"]))).toBe(false);
    expect(new TextDecoder().decode(
      await storage.getBlob(sha256Bytes(initial[".claude/rules/untouched.md"]))
    )).toBe(initial[".claude/rules/untouched.md"]);

    await app.close();
    app = await createServer({
      repository,
      storage,
      config: { projectBlobGcGraceMs: 0 }
    });
    expect(await storage.hasBlob(sha256Bytes(updatedA))).toBe(true);
    expect(await storage.hasBlob(sha256Bytes(initial[".claude/rules/untouched.md"]))).toBe(false);

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${otherProjectId}`, headers: headers() });
    await app.inject({ method: "DELETE", url: `/api/v1/projects/${otherProjectId}/purge`, headers: headers() });
    expect(await storage.hasBlob(sha256Bytes(updatedA))).toBe(false);
    expect(new TextDecoder().decode(await storage.getBlob(sha256Bytes(updatedA)))).toBe(updatedA);

    await app.close();
    app = await createServer({
      repository,
      storage,
      config: { projectBlobGcGraceMs: 0 }
    });
    expect(await storage.hasBlob(sha256Bytes(updatedA))).toBe(false);
  });

  it("accepts and serves a zero-byte file", async () => {
    const projectId = await resolveProject();
    const emptyHash = sha256Bytes("");
    const finalized = await uploadAndFinalize(
      projectId,
      [{
        operation: "add",
        path: ".claude/rules/empty.md",
        file_kind: "user_editable",
        content_sha256: emptyHash,
        size_bytes: 0
      }],
      { [emptyHash]: "" },
      null,
      null
    );
    expect(finalized.statusCode).toBe(201);

    const content = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/files/content?path=${encodeURIComponent(".claude/rules/empty.md")}`,
      headers: headers()
    });
    expect(content.statusCode).toBe(200);
    expect(content.json()).toMatchObject({ content: "", size_bytes: 0, content_sha256: emptyHash });
  });

  it("forces a new reference to upload a quarantined blob before it can be swept", async () => {
    const content = "# Shared after quarantine\n";
    const hash = sha256Bytes(content);
    const operation = {
      operation: "add",
      path: ".claude/rules/reused.md",
      file_kind: "user_editable",
      content_sha256: hash,
      size_bytes: Buffer.byteLength(content)
    };
    const sourceProjectId = await resolveProject();
    expect((await uploadAndFinalize(
      sourceProjectId,
      [operation],
      { [hash]: content },
      null,
      null
    )).statusCode).toBe(201);
    await app.inject({ method: "DELETE", url: `/api/v1/projects/${sourceProjectId}`, headers: headers() });
    await app.inject({ method: "DELETE", url: `/api/v1/projects/${sourceProjectId}/purge`, headers: headers() });
    expect(await storage.hasBlob(hash)).toBe(false);

    const targetProjectId = await resolveProject();
    const session = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${targetProjectId}/proposal-sessions`,
      headers: headers(),
      payload: {
        schema_version: 1,
        request_id: uuidV7(),
        client_id: "cli_test",
        base_project_version: null,
        base_manifest_hash: sha256Bytes(canonicalJson({ baseProjectVersion: null })),
        proposal_manifest: { files: [operation] },
        artifact_manifest: { schema_version: 1, files: [operation] }
      }
    });
    expect(session.statusCode).toBe(201);
    expect(session.json().missing_blobs).toEqual([hash]);

    // 模拟 sweep 在引用检查后完成删除；客户端上传仍会重建 active blob。
    await storage.deleteQuarantinedBlob(hash);
    const sessionId = session.json().session_id as string;
    const upload = await app.inject({
      method: "PUT",
      url: `/api/v1/proposal-sessions/${sessionId}/blobs/${encodeURIComponent(hash)}`,
      headers: {
        ...headers(),
        "content-type": "application/octet-stream",
        "content-range": `bytes 0-${Buffer.byteLength(content) - 1}/${Buffer.byteLength(content)}`,
        "x-chunk-sha256": hash
      },
      payload: Buffer.from(content)
    });
    expect(upload.statusCode).toBe(201);
    expect(await storage.hasBlob(hash)).toBe(true);

    const finalized = await app.inject({
      method: "POST",
      url: `/api/v1/proposal-sessions/${sessionId}:finalize`,
      headers: headers(),
      payload: {
        schema_version: 1,
        manifest_sha256: sha256Bytes(canonicalJson([operation])),
        base_artifact_id: null
      }
    });
    expect(finalized.statusCode).toBe(201);
  });
});
