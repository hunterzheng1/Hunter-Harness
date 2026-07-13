import { canonicalJson } from "@hunter-harness/contracts";
import { sha256Bytes, uuidV7 } from "@hunter-harness/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/app.js";
import { MemoryRepository } from "../src/repositories/memory.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";

describe("/api/v1 governed server", () => {
  let repository: MemoryRepository;
  let storage: MemoryArtifactStorage;
  let app: Awaited<ReturnType<typeof createServer>>;
  const token = "owner-api-token";

  beforeEach(async () => {
    repository = new MemoryRepository();
    storage = new MemoryArtifactStorage();
    await repository.createActorWithToken({ actorId: "actor_owner", token });
    await repository.createActorWithToken({ actorId: "actor_other", token: "other-token" });
    app = await createServer({ repository, storage });
  });

  afterEach(async () => {
    await app.close();
  });

  function headers(
    value = token,
    idempotency = uuidV7()
  ): Record<string, string> {
    return {
      authorization: "Bearer " + value,
      "x-request-id": uuidV7(),
      "idempotency-key": idempotency
    };
  }

  async function resolveProject(localKey = uuidV7()): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects:resolve",
      headers: headers(),
      payload: {
        schema_version: 1,
        local_project_key: localKey,
        display_name: "demo",
        requested_project_id: null,
        client_id: "cli_test"
      }
    });
    expect(response.statusCode).toBe(200);
    return response.json().project_id as string;
  }

  async function finalizeSession(
    sessionId: string,
    operations: object[],
    baseArtifactId: string | null = null,
    options: { sensitive_scan_skip?: true; sensitive_scan_skip_reason?: string } = {}
  ) {
    return app.inject({
      method: "POST",
      url: `/api/v1/proposal-sessions/${sessionId}:finalize`,
      headers: headers(),
      payload: {
        schema_version: 1,
        manifest_sha256: sha256Bytes(canonicalJson(operations)),
        base_artifact_id: baseArtifactId,
        ...options
      }
    });
  }

  it("enforces authentication, ownership, and idempotent project binding", async () => {
    const unauthenticated = await app.inject({
      method: "POST",
      url: "/api/v1/projects:resolve",
      payload: {}
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json()).toMatchObject({
      error: { code: "AUTH_REQUIRED", details: {} }
    });

    const key = uuidV7();
    const idem = uuidV7();
    const payload = {
      schema_version: 1,
      local_project_key: key,
      display_name: "demo",
      requested_project_id: null,
      client_id: "cli_test"
    };
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/projects:resolve",
      headers: headers(token, idem),
      payload
    });
    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/projects:resolve",
      headers: headers(token, idem),
      payload
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().project_id).toBe(first.json().project_id);

    const reused = await app.inject({
      method: "POST",
      url: "/api/v1/projects:resolve",
      headers: headers(token, idem),
      payload: { ...payload, display_name: "different" }
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REUSED" } });

    const projects = await app.inject({
      method: "GET",
      url: "/api/v1/projects?limit=10",
      headers: headers()
    });
    expect(projects.statusCode).toBe(200);
    expect(projects.json().items).toEqual([
      expect.objectContaining({ project_id: first.json().project_id, role: "owner" })
    ]);

    const forbidden = await app.inject({
      method: "POST",
      url: "/api/v1/projects:resolve",
      headers: headers("other-token"),
      payload: { ...payload, local_project_key: uuidV7(), requested_project_id: first.json().project_id }
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it("uploads verified blobs, auto-approves on finalize, and publishes artifacts", async () => {
    const projectId = await resolveProject();
    const content = "# approved rule\n";
    const hash = sha256Bytes(content);
    const operation = {
      operation: "add",
      path: ".claude/rules/approved.md",
      file_kind: "user_editable",
      content_sha256: hash,
      size_bytes: Buffer.byteLength(content)
    };
    const session = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/proposal-sessions`,
      headers: headers(),
      payload: {
        schema_version: 1,
        request_id: uuidV7(),
        client_id: "cli_test",
        base_project_version: null,
        base_manifest_hash: sha256Bytes(canonicalJson({})),
        proposal_manifest: { files: [operation] },
        artifact_manifest: { schema_version: 1, files: [operation] }
      }
    });
    expect(session.statusCode).toBe(201);
    const sessionId = session.json().session_id as string;
    expect(session.json().missing_blobs).toEqual([hash]);

    const query = await app.inject({
      method: "POST",
      url: `/api/v1/proposal-sessions/${sessionId}/blobs:query`,
      headers: headers(),
      payload: { content_sha256: [hash] }
    });
    expect(query.json()).toMatchObject({ missing: [hash] });

    const invalidChunk = await app.inject({
      method: "PUT",
      url: `/api/v1/proposal-sessions/${sessionId}/blobs/${encodeURIComponent(hash)}`,
      headers: {
        ...headers(),
        "content-type": "application/octet-stream",
        "content-range": `bytes 0-${Buffer.byteLength(content) - 1}/${Buffer.byteLength(content)}`,
        "x-chunk-sha256": sha256Bytes("wrong")
      },
      payload: Buffer.from(content)
    });
    expect(invalidChunk.statusCode).toBe(422);

    const uploaded = await app.inject({
      method: "PUT",
      url: `/api/v1/proposal-sessions/${sessionId}/blobs/${encodeURIComponent(hash)}`,
      headers: {
        ...headers(),
        "content-type": "application/octet-stream",
        "content-range": `bytes 0-${Buffer.byteLength(content) - 1}/${Buffer.byteLength(content)}`,
        "x-chunk-sha256": sha256Bytes(content)
      },
      payload: Buffer.from(content)
    });
    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.json()).toMatchObject({ verified: true });

    const finalized = await finalizeSession(sessionId, [operation], null);
    expect(finalized.statusCode).toBe(201);
    expect(finalized.json()).toMatchObject({
      status: "approved",
      artifact_id: expect.stringMatching(/^art_/)
    });
    const proposalId = finalized.json().proposal_id as string;
    const artifactId = finalized.json().artifact_id as string;
    const proposalDetail = await app.inject({
      method: "GET",
      url: `/api/v1/proposals/${proposalId}`,
      headers: headers()
    });
    expect(proposalDetail.statusCode).toBe(200);
    expect(proposalDetail.json().review_history).toEqual([
      expect.objectContaining({ decision: "auto-approved", artifact_id: artifactId })
    ]);

    const update = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/update-manifest?base_manifest_hash=${encodeURIComponent(sha256Bytes(canonicalJson({})))}&adapter=claude-code&profile=java`,
      headers: headers()
    });
    expect(update.json()).toMatchObject({
      delta_available: true,
      artifact_id: artifactId,
      observed_project_version: expect.stringMatching(/^pv_/)
    });
    const manifest = await app.inject({
      method: "GET",
      url: `/api/v1/artifacts/${artifactId}/manifest`,
      headers: headers()
    });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.headers.etag).toBe(manifest.json().manifest_sha256);
    const history = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/artifacts?limit=10`,
      headers: headers()
    });
    expect(history.json().items).toEqual([
      expect.objectContaining({
        artifact_id: artifactId,
        proposal_id: proposalId,
        changed_item_count: 1
      })
    ]);

    const blob = await app.inject({
      method: "GET",
      url: `/api/v1/artifacts/${artifactId}/blobs/${encodeURIComponent(hash)}`,
      headers: headers()
    });
    expect(blob.statusCode).toBe(200);
    expect(blob.body).toBe(content);
    expect(blob.headers["x-content-sha256"]).toBe(hash);
    const caughtUp = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/update-manifest?base_project_version=${encodeURIComponent(manifest.json().project_version)}&base_manifest_hash=${encodeURIComponent(manifest.json().manifest_sha256)}&adapter=claude-code&profile=java`,
      headers: headers()
    });
    expect(caughtUp.json()).toMatchObject({ delta_available: false, artifact_id: null });
    expect((await repository.listAuditEvents()).map((event) => event.action)).toEqual(
      expect.arrayContaining(["project.resolved", "proposal.finalized"])
    );
  });

  it("rejects stale pushes and supports proposal pagination", async () => {
    const projectId = await resolveProject();
    const operations = ["one", "two"].map((name) => {
      const content = `# ${name}\n`;
      return {
        content,
        operation: {
          operation: "add",
          path: `.claude/rules/${name}.md`,
          file_kind: "user_editable",
          content_sha256: sha256Bytes(content),
          size_bytes: Buffer.byteLength(content)
        }
      };
    });
    const session = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/proposal-sessions`,
      headers: headers(),
      payload: {
        schema_version: 1,
        request_id: uuidV7(),
        client_id: "cli_test",
        base_project_version: null,
        base_manifest_hash: sha256Bytes(canonicalJson({})),
        proposal_manifest: { files: operations.map((item) => item.operation) },
        artifact_manifest: { schema_version: 1, files: operations.map((item) => item.operation) }
      }
    });
    for (const item of operations) {
      await storage.putBlob(item.operation.content_sha256, Buffer.from(item.content));
    }
    const finalized = await finalizeSession(
      session.json().session_id,
      operations.map((item) => item.operation),
      null
    );
    expect(finalized.statusCode).toBe(201);
    const artifactId = finalized.json().artifact_id as string;
    const projectDetail = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}`,
      headers: headers()
    });
    const latestVersion = projectDetail.json().latest_project_version as string;

    const staleSession = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/proposal-sessions`,
      headers: headers(),
      payload: {
        schema_version: 1,
        request_id: uuidV7(),
        client_id: "cli_test",
        base_project_version: latestVersion,
        base_manifest_hash: sha256Bytes(canonicalJson({})),
        proposal_manifest: { files: [operations[0].operation] },
        artifact_manifest: { schema_version: 1, files: [operations[0].operation] }
      }
    });
    expect(staleSession.statusCode).toBe(201);
    const staleFinalize = await finalizeSession(
      staleSession.json().session_id,
      [operations[0].operation],
      null
    );
    expect(staleFinalize.statusCode).toBe(409);
    expect(staleFinalize.json()).toMatchObject({ error: { code: "STALE_PUSH" } });

    const freshSession = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/proposal-sessions`,
      headers: headers(),
      payload: {
        schema_version: 1,
        request_id: uuidV7(),
        client_id: "cli_test",
        base_project_version: latestVersion,
        base_manifest_hash: sha256Bytes(canonicalJson({})),
        proposal_manifest: { files: [operations[0].operation] },
        artifact_manifest: { schema_version: 1, files: [operations[0].operation] }
      }
    });
    expect(freshSession.statusCode).toBe(201);
    const freshFinalize = await finalizeSession(
      freshSession.json().session_id,
      [operations[0].operation],
      artifactId
    );
    expect(freshFinalize.statusCode).toBe(201);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/proposals?limit=1`,
      headers: headers()
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
    expect(list.json().page).toMatchObject({ limit: 1 });
  });

  it("enforces policy, size limits, and server-side sensitive scanning", async () => {
    const projectId = await resolveProject();
    const forbidden = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/proposal-sessions`,
      headers: headers(),
      payload: {
        schema_version: 1,
        request_id: uuidV7(),
        client_id: "cli_test",
        base_project_version: null,
        base_manifest_hash: sha256Bytes(canonicalJson({})),
        proposal_manifest: { files: [{
          operation: "add",
          path: ".harness/state/local/secret.json",
          file_kind: "internal_state",
          content_sha256: "sha256:" + "a".repeat(64),
          size_bytes: 1
        }] },
        artifact_manifest: { schema_version: 1, files: [{
          operation: "add",
          path: ".harness/state/local/secret.json",
          file_kind: "internal_state",
          content_sha256: "sha256:" + "a".repeat(64),
          size_bytes: 1
        }] }
      }
    });
    expect(forbidden.statusCode).toBe(422);
    expect(forbidden.json()).toMatchObject({ error: { code: "POLICY_PATH_FORBIDDEN" } });

    const tooLarge = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/proposal-sessions`,
      headers: headers(),
      payload: {
        schema_version: 1,
        request_id: uuidV7(),
        client_id: "cli_test",
        base_project_version: null,
        base_manifest_hash: sha256Bytes(canonicalJson({})),
        proposal_manifest: { files: [{
          operation: "add",
          path: ".claude/rules/too-large.md",
          file_kind: "user_editable",
          content_sha256: "sha256:" + "b".repeat(64),
          size_bytes: 10 * 1024 * 1024 + 1
        }] },
        artifact_manifest: { schema_version: 1, files: [{
          operation: "add",
          path: ".claude/rules/too-large.md",
          file_kind: "user_editable",
          content_sha256: "sha256:" + "b".repeat(64),
          size_bytes: 10 * 1024 * 1024 + 1
        }] }
      }
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json()).toMatchObject({ error: { code: "FILE_TOO_LARGE" } });

    const secret = "-----BEGIN PRIVATE KEY-----\nsecret\n";
    const hash = sha256Bytes(secret);
    const operation = {
      operation: "add",
      path: ".claude/rules/unsafe.md",
      file_kind: "user_editable",
      content_sha256: hash,
      size_bytes: Buffer.byteLength(secret)
    };
    const session = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/proposal-sessions`,
      headers: headers(),
      payload: {
        schema_version: 1,
        request_id: uuidV7(),
        client_id: "cli_test",
        base_project_version: null,
        base_manifest_hash: sha256Bytes(canonicalJson({})),
        proposal_manifest: { files: [operation] },
        artifact_manifest: { schema_version: 1, files: [operation] }
      }
    });
    await storage.putBlob(hash, Buffer.from(secret));
    const finalized = await finalizeSession(session.json().session_id, [operation], null);
    expect(finalized.statusCode).toBe(422);
    expect(finalized.json().error).toMatchObject({
      code: "SENSITIVE_CONTENT_BLOCKED",
      details: {
        finding_count: expect.any(Number),
        findings: expect.arrayContaining([
          expect.objectContaining({ rule_id: "HH_PRIVATE_KEY" })
        ])
      }
    });
    expect(finalized.body).not.toContain("PRIVATE KEY");

    const skipped = await finalizeSession(
      session.json().session_id,
      [operation],
      null,
      { sensitive_scan_skip: true, sensitive_scan_skip_reason: "test fixture" }
    );
    expect(skipped.statusCode).toBe(201);
    expect(skipped.json()).toMatchObject({ status: "approved" });
    const audits = await repository.listAuditEvents({ actorId: "actor_owner", limit: 20 });
    expect(audits.some((item) =>
      item.action === "proposal.finalized" &&
      (item.details as { sensitive_scan_skip?: boolean }).sensitive_scan_skip === true
    )).toBe(true);
  });
});
