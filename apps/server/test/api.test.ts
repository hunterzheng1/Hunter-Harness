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

    const forbidden = await app.inject({
      method: "POST",
      url: "/api/v1/projects:resolve",
      headers: headers("other-token"),
      payload: { ...payload, local_project_key: uuidV7(), requested_project_id: first.json().project_id }
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it("uploads verified blobs, finalizes, owner self-approves, and publishes artifacts", async () => {
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

    const finalized = await app.inject({
      method: "POST",
      url: `/api/v1/proposal-sessions/${sessionId}:finalize`,
      headers: headers(),
      payload: { schema_version: 1, manifest_sha256: sha256Bytes(canonicalJson([operation])) }
    });
    expect(finalized.statusCode).toBe(201);
    const proposalId = finalized.json().proposal_id as string;

    const beforeApproval = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/update-manifest?base_manifest_hash=${encodeURIComponent(sha256Bytes(canonicalJson({})))}&adapter=claude-code&profile=java`,
      headers: headers()
    });
    expect(beforeApproval.json()).toMatchObject({ delta_available: false });

    const proposal = await app.inject({
      method: "GET",
      url: `/api/v1/proposals/${proposalId}`,
      headers: headers()
    });
    const itemId = proposal.json().items[0].item_id as string;
    expect(itemId).toMatch(/^item_/);

    const reviewKey = uuidV7();
    const reviewRequest = {
      method: "POST",
      url: `/api/v1/proposals/${proposalId}/review-decisions`,
      headers: headers(token, reviewKey),
      payload: {
        schema_version: 1,
        decision: "approve",
        comment: "owner reviewed",
        target_scope: "project",
        split_groups: []
      }
    } as const;
    const review = await app.inject(reviewRequest);
    expect(review.statusCode).toBe(201);
    expect(review.json()).toMatchObject({ decision: "approve", artifact_id: expect.stringMatching(/^art_/) });
    const artifactId = review.json().artifact_id as string;
    const reviewReplay = await app.inject(reviewRequest);
    expect(reviewReplay.statusCode).toBe(201);
    expect(reviewReplay.json().review_id).toBe(review.json().review_id);

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
      expect.arrayContaining(["project.resolved", "proposal.finalized", "proposal.approved"])
    );
  });

  it("supports reject, split, pagination, and never exposes unapproved artifacts", async () => {
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
    const finalized = await app.inject({
      method: "POST",
      url: `/api/v1/proposal-sessions/${session.json().session_id}:finalize`,
      headers: headers(),
      payload: {
        schema_version: 1,
        manifest_sha256: sha256Bytes(canonicalJson(
          operations.map((item) => item.operation)
        ))
      }
    });
    const proposalId = finalized.json().proposal_id as string;
    const detail = await app.inject({
      method: "GET", url: `/api/v1/proposals/${proposalId}`, headers: headers()
    });
    const itemIds = detail.json().items.map((item: { item_id: string }) => item.item_id);
    const split = await app.inject({
      method: "POST",
      url: `/api/v1/proposals/${proposalId}/review-decisions`,
      headers: headers(),
      payload: {
        schema_version: 1,
        decision: "split",
        comment: "separate review",
        target_scope: "project",
        split_groups: itemIds.map((itemId: string, index: number) => ({
          name: "group-" + index,
          item_ids: [itemId],
          target_scope: "project"
        }))
      }
    });
    expect(split.statusCode).toBe(201);
    expect(split.json().child_proposal_ids).toHaveLength(2);

    const child = split.json().child_proposal_ids[0] as string;
    const rejected = await app.inject({
      method: "POST",
      url: `/api/v1/proposals/${child}/review-decisions`,
      headers: headers(),
      payload: {
        schema_version: 1,
        decision: "reject",
        comment: "not accepted",
        target_scope: "project",
        split_groups: []
      }
    });
    expect(rejected.json()).toMatchObject({ decision: "reject", artifact_id: null });

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
    const finalized = await app.inject({
      method: "POST",
      url: `/api/v1/proposal-sessions/${session.json().session_id}:finalize`,
      headers: headers(),
      payload: { schema_version: 1, manifest_sha256: sha256Bytes(canonicalJson([operation])) }
    });
    expect(finalized.statusCode).toBe(422);
    expect(finalized.json().error).toMatchObject({ code: "SENSITIVE_CONTENT_BLOCKED" });
    expect(finalized.body).not.toContain("PRIVATE KEY");
  });
});
