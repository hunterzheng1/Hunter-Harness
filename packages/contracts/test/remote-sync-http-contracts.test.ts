import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import {
  REMOTE_SYNC_HTTP_OPERATIONS,
  remoteSyncContentStreamHttpChunkSchema,
  remoteSyncContentStreamHttpRequestSchema,
  remoteSyncHttpErrorCodeSchema,
  remoteSyncHttpErrorEnvelopeSchema,
  remoteSyncHttpRequestHeadersSchema,
  remoteSyncLeaseAcquireHttpRequestSchema,
  remoteSyncLeaseHttpResponseSchema,
  remoteSyncLeaseReleaseHttpRequestSchema,
  remoteSyncLeaseRenewHttpRequestSchema,
  remoteSyncPullHttpRequestSchema,
  remoteSyncPullHttpResponseSchema,
  remoteSyncPushCommitHttpRequestSchema,
  remoteSyncPushCommitHttpResponseSchema,
  remoteSyncPushPrepareHttpRequestSchema,
  remoteSyncPushPrepareHttpResponseSchema,
  remoteSyncPushReceiptHttpResponseSchema,
  remoteSyncPushStatusHttpRequestSchema,
  remoteSyncPushStatusHttpResponseSchema,
  remoteSyncRemoteSnapshotHttpResponseSchema,
  remoteSyncHttpScopeSchema,
  remoteSyncHttpMaxFileBytes,
} from "../src/index.js";

const hash = "sha256:" + "a".repeat(64);
const source = { project_id: "prj_contract", branch_name: "main", actor_id: "actor_contract" };
const lease = {
  schema_version: 1,
  lease_id: "lease_abc",
  lease_token: "lease_abcdefghijklmnopqrstuvwxyz0123456789_-abcde",
  generation: 3,
  project_id: source.project_id,
  branch_name: source.branch_name,
  actor_id: source.actor_id,
  expires_at: "2026-08-14T00:00:00.000Z"
};

describe("Remote Sync HTTP v1 shared contract", () => {
  it("binds every non-empty push file to a bounded upload reference", () => {
    const base = {
      source: { project_id: "prj_contract", branch_name: "main", actor_id: "actor_contract", commit_sha: "a".repeat(40), client_id: "cli_contract" },
      lease: {
        schema_version: 1 as const,
        lease_id: "lease_contract",
        lease_token: `lease_${"A".repeat(43)}`,
        generation: 1,
        project_id: "prj_contract",
        branch_name: "main",
        actor_id: "actor_contract",
        expires_at: "2026-08-15T12:00:00.000Z"
      },
      expected_revision: "revision_0001",
      preview_hash: `sha256:${"1".repeat(64)}`,
      idempotency_key: "push-contract",
      payload_hash: `sha256:${"2".repeat(64)}`,
      operations: [],
      skipped: []
    };
    const file = {
      path: ".harness/rules/a.md",
      content_hash: `sha256:${"3".repeat(64)}`,
      size: 3,
      content_kind: "rule" as const,
      upload_ref: { ref_id: `bounded_upload:${"A".repeat(43)}`, sha256: `sha256:${"3".repeat(64)}`, size_bytes: 3 }
    };
    expect(remoteSyncPushPrepareHttpRequestSchema.safeParse({ ...base, files: [file] }).success).toBe(true);
    expect(remoteSyncPushPrepareHttpRequestSchema.safeParse({ ...base, files: [{ ...file, upload_ref: undefined }] }).success).toBe(false);
    expect(remoteSyncPushPrepareHttpRequestSchema.safeParse({ ...base, files: [{ ...file, upload_ref: { ...file.upload_ref, sha256: `sha256:${"4".repeat(64)}` } }] }).success).toBe(false);
    expect(remoteSyncHttpMaxFileBytes).toBe(10_485_760);
    expect(remoteSyncPushPrepareHttpRequestSchema.safeParse({ ...base, files: [{
      ...file,
      size: remoteSyncHttpMaxFileBytes,
      upload_ref: { ...file.upload_ref, size_bytes: remoteSyncHttpMaxFileBytes },
    }] }).success).toBe(true);
    expect(remoteSyncPushPrepareHttpRequestSchema.safeParse({ ...base, files: [{
      ...file,
      size: remoteSyncHttpMaxFileBytes + 1,
      upload_ref: { ...file.upload_ref, size_bytes: remoteSyncHttpMaxFileBytes + 1 },
    }] }).success).toBe(false);
  });

  it("matches the independently frozen descriptor fixture and advertises request-id/idempotency", async () => {
    const frozen = JSON.parse(await readFile(new URL("./fixtures/remote-sync-http-v1-current.json", import.meta.url), "utf8"));
    expect(REMOTE_SYNC_HTTP_OPERATIONS).toEqual(frozen);
    expect(Object.keys(REMOTE_SYNC_HTTP_OPERATIONS)).toEqual([
      "acquire_lease", "renew_lease", "release_lease", "snapshot", "content_stream",
      "prepare_push", "commit_push", "push_status", "push_receipt", "pull"
    ]);
    for (const operation of Object.values(REMOTE_SYNC_HTTP_OPERATIONS)) {
      expect(operation.request_id_header).toBe("X-Request-Id");
      expect(operation.errors[401]).toEqual(["AUTH_REQUIRED", "TOKEN_INVALID", "SESSION_INVALID"]);
    }
    expect(REMOTE_SYNC_HTTP_OPERATIONS.prepare_push.idempotency_header).toBe("Idempotency-Key");
    expect(REMOTE_SYNC_HTTP_OPERATIONS.snapshot.idempotency_header).toBeUndefined();
  });

  it("keeps auth and project-key scope server-bound", () => {
    expect(remoteSyncHttpScopeSchema.safeParse("files:read").success).toBe(true);
    expect(remoteSyncHttpScopeSchema.safeParse("files:write").success).toBe(true);
    expect(remoteSyncHttpScopeSchema.safeParse("project:admin").success).toBe(false);
    expect(REMOTE_SYNC_HTTP_OPERATIONS.snapshot.auth).toEqual({
      actor_source: "authenticated_principal",
      project_allowlist_source: "server_authority",
      project_key_scope: "files:read"
    });
    expect(remoteSyncLeaseAcquireHttpRequestSchema.safeParse({
      source, ttl_ms: 60_000, actor_id: "spoofed"
    }).success).toBe(false);
  });

  it("validates lease lifecycle bodies and outcome wrappers", () => {
    expect(remoteSyncLeaseAcquireHttpRequestSchema.safeParse({ source }).success).toBe(true);
    expect(remoteSyncLeaseAcquireHttpRequestSchema.safeParse({ source, ttl_ms: 600_001 }).success).toBe(false);
    expect(remoteSyncLeaseRenewHttpRequestSchema.safeParse({ lease }).success).toBe(true);
    expect(remoteSyncLeaseReleaseHttpRequestSchema.safeParse({ lease, source }).success).toBe(false);
    expect(remoteSyncLeaseHttpResponseSchema.safeParse({ lease, outcome: "new" }).success).toBe(true);
    expect(remoteSyncLeaseHttpResponseSchema.safeParse({ lease, outcome: "conflict" }).success).toBe(false);
  });

  it("keeps snapshot metadata-only and binds content streams to a revision", () => {
    const snapshot = {
      source, snapshot_id: "snapshot_1", revision: "4", project_version: "pv_4",
      commit_sha: "commit_4", artifact_id: "art_4", manifest_hash: hash,
      files: [{ path: ".harness/rules/a.md", content_hash: hash, size: 2, content_kind: "rule" }]
    };
    expect(remoteSyncRemoteSnapshotHttpResponseSchema.safeParse(snapshot).success).toBe(true);
    expect(remoteSyncRemoteSnapshotHttpResponseSchema.safeParse({
      ...snapshot, files: [{ ...snapshot.files[0], content: "YQo=" }]
    }).success).toBe(false);
    expect(remoteSyncContentStreamHttpRequestSchema.safeParse({
      source, path: ".harness/rules/a.md", snapshot_id: "snapshot_1", expected_revision: "4"
    }).success).toBe(true);
    expect(remoteSyncContentStreamHttpRequestSchema.safeParse({
      source, path: ".harness/rules/a.md"
    }).success).toBe(false);
    expect(remoteSyncContentStreamHttpChunkSchema.safeParse({
      sequence: 0, offset: 0, size: 1, chunk_hash: hash, final: true
    }).success).toBe(true);
    expect(remoteSyncContentStreamHttpChunkSchema.safeParse({
      sequence: 0, offset: 0, size: 1_048_577, chunk_hash: hash, final: true
    }).success).toBe(false);
  });

  it("accepts explicitly typed branch files outside reserved content paths", () => {
    const branchFile = { path: "src/index.ts", content_hash: hash, size: 2, content_kind: "branch_file" as const };
    expect(remoteSyncRemoteSnapshotHttpResponseSchema.safeParse({
      source, snapshot_id: "snapshot_branch", revision: "4", project_version: "pv_4",
      commit_sha: "commit_4", artifact_id: "art_4", manifest_hash: hash, files: [branchFile]
    }).success).toBe(true);
    expect(remoteSyncPushPrepareHttpRequestSchema.safeParse({
      source, lease, expected_revision: "4", preview_hash: hash, idempotency_key: "push_branch",
      payload_hash: hash, files: [{ ...branchFile, upload_ref: { ref_id: `bounded_upload:${"B".repeat(43)}`, sha256: hash, size_bytes: 2 } }],
      operations: [{ path: "src/index.ts", content_kind: "branch_file", action: "modify", remote_hash: hash }], skipped: []
    }).success).toBe(true);
  });

  it("uses strict push/pull envelopes and preserves idempotency outcomes", () => {
    const prepare = {
      source, lease, expected_revision: "4", preview_hash: hash, idempotency_key: "push_1",
      payload_hash: hash,
      files: [{ path: ".harness/rules/a.md", content_hash: hash, size: 2, content_kind: "rule",
        upload_ref: { ref_id: `bounded_upload:${"A".repeat(43)}`, sha256: hash, size_bytes: 2 } }],
      operations: [{ path: ".harness/rules/a.md", content_kind: "rule", action: "modify", remote_hash: hash }],
      skipped: []
    };
    expect(remoteSyncPushPrepareHttpRequestSchema.safeParse(prepare).success).toBe(true);
    expect(remoteSyncPushPrepareHttpResponseSchema.safeParse({
      outcome: "new",
      value: {
        schema_version: 1, prepare_id: "prepare_1", source,
        lease_id: lease.lease_id, lease_token: lease.lease_token, lease_generation: lease.generation,
        expected_revision: "4", preview_hash: hash, idempotency_key: "push_1", payload_hash: hash,
        state: "prepared", expires_at: lease.expires_at
      }
    }).success).toBe(true);
    expect(remoteSyncPushCommitHttpRequestSchema.safeParse({
      prepare_id: "prepare_1", lease, idempotency_key: "push_1", payload_hash: hash
    }).success).toBe(true);
    expect(remoteSyncPushCommitHttpResponseSchema.safeParse({ outcome: "conflict", value: {} }).success).toBe(false);
    expect(remoteSyncPushStatusHttpRequestSchema.safeParse({ source, idempotency_key: "push_1" }).success).toBe(true);
    expect(remoteSyncPushStatusHttpResponseSchema.safeParse({
      source, state: "unknown", prepare_id: "prepare_1", idempotency_key: "push_1", payload_hash: hash
    }).success).toBe(true);
    expect(remoteSyncPushReceiptHttpResponseSchema.safeParse({
      outcome: "replay", value: {
        schema_version: 1, prepare_id: "prepare_1", source, idempotency_key: "push_1",
        payload_hash: hash, preview_hash: hash, project_version: "pv_4", artifact_id: "art_4",
        commit_sha: "commit_4", manifest_hash: hash, no_changes: true, applied: [], skipped: [], retryable: []
      }
    }).success).toBe(true);
    expect(remoteSyncPullHttpRequestSchema.safeParse({ source, actor_id: source.actor_id, idempotency_key: "pull_1" }).success).toBe(true);
    expect(remoteSyncPullHttpResponseSchema.safeParse({
      outcome: "new", value: {
        schema_version: 1, source, idempotency_key: "pull_1", payload_hash: hash, remote_revision: "4",
        local_transaction: "committed", commit_sha: "commit_4", artifact_id: "art_4", manifest_hash: hash,
        project_version: "pv_4", no_changes: true, applied: [], skipped: [], retryable: []
      }
    }).success).toBe(true);
    expect(remoteSyncPullHttpResponseSchema.safeParse({
      outcome: "new", value: {
        schema_version: 1, source, idempotency_key: "bad key\n", payload_hash: hash, remote_revision: "4",
        local_transaction: "committed", commit_sha: "commit_4", artifact_id: "art_4", manifest_hash: hash,
        project_version: "pv_4", no_changes: true, applied: [], skipped: [], retryable: []
      }
    }).success).toBe(false);
  });

  it("rejects cross-array path ambiguity and closes nullable no-change identities", () => {
    const operation = {
      path: "src/index.ts",
      content_kind: "branch_file" as const,
      action: "modify" as const,
      remote_hash: hash,
    };
    const request = {
      source,
      lease,
      expected_revision: "4",
      preview_hash: hash,
      idempotency_key: "push-unique-paths",
      payload_hash: hash,
      files: [{
        path: operation.path,
        content_hash: hash,
        size: 1,
        content_kind: operation.content_kind,
        upload_ref: { ref_id: `bounded_upload:${"A".repeat(43)}`, sha256: hash, size_bytes: 1 },
      }],
      operations: [operation],
      skipped: [{ ...operation, action: "no_change" as const }],
    };
    expect(remoteSyncPushPrepareHttpRequestSchema.safeParse(request).success).toBe(false);
    expect(remoteSyncPushPrepareHttpRequestSchema.safeParse({
      ...request,
      files: [
        request.files[0],
        {
          ...request.files[0],
          path: "src/INDEX.ts",
          upload_ref: { ...request.files[0].upload_ref, ref_id: `bounded_upload:${"B".repeat(43)}` }
        }
      ],
      skipped: []
    }).success).toBe(false);
    expect(remoteSyncPushPrepareHttpRequestSchema.safeParse({
      ...request,
      skipped: [{ ...operation, path: "SRC/INDEX.ts", action: "no_change" as const }]
    }).success).toBe(false);
    const receipt = {
      schema_version: 1,
      prepare_id: "prepare-no-change",
      source,
      idempotency_key: "push-no-change",
      payload_hash: hash,
      preview_hash: hash,
      project_version: null,
      artifact_id: null,
      commit_sha: null,
      manifest_hash: hash,
      no_changes: true,
      applied: [],
      skipped: [],
      retryable: [],
    };
    expect(remoteSyncPushCommitHttpResponseSchema.safeParse({ outcome: "new", value: receipt }).success).toBe(true);
    expect(remoteSyncPushCommitHttpResponseSchema.safeParse({
      outcome: "new",
      value: { ...receipt, no_changes: false },
    }).success).toBe(false);
  });

  it("publishes exact operation-specific lease and preview error statuses", () => {
    expect(REMOTE_SYNC_HTTP_OPERATIONS.renew_lease.errors).toMatchObject({
      409: ["SYNC_IDEMPOTENCY_CONFLICT", "SYNC_LEASE_FENCED", "SYNC_LEASE_SCOPE_MISMATCH"],
      410: ["SYNC_LEASE_EXPIRED"],
      422: ["SYNC_LEASE_INVALID"],
    });
    expect(REMOTE_SYNC_HTTP_OPERATIONS.prepare_push.errors[409]).toContain("SYNC_PREVIEW_STALE");
    expect(REMOTE_SYNC_HTTP_OPERATIONS.commit_push.errors[409]).toEqual(expect.arrayContaining([
      "SYNC_PREVIEW_STALE", "SYNC_LEASE_SCOPE_MISMATCH",
    ]));
  });

  it("rejects malformed HTTP headers and uses a uniform error envelope", () => {
    expect(remoteSyncHttpRequestHeadersSchema.safeParse({ "X-Request-Id": "018f1f2e-7b5a-7cc0-8c2d-2b320cab1234" }).success).toBe(true);
    expect(remoteSyncHttpRequestHeadersSchema.safeParse({ "X-Request-Id": "bad", "Idempotency-Key": "ok" }).success).toBe(false);
    expect(remoteSyncHttpRequestHeadersSchema.safeParse({ "X-Request-Id": "018f1f2e-7b5a-7cc0-8c2d-2b320cab1234", "Idempotency-Key": "bad key" }).success).toBe(false);
    expect(remoteSyncHttpErrorCodeSchema.safeParse("AUTH_REQUIRED").success).toBe(true);
    expect(remoteSyncHttpErrorCodeSchema.safeParse("HTTP_409").success).toBe(false);
    expect(remoteSyncHttpErrorEnvelopeSchema.safeParse({
      error: { code: "SYNC_IDEMPOTENCY_CONFLICT", message: "same key, different payload", request_id: "018f1f2e-7b5a-7cc0-8c2d-2b320cab1234", outcome: "conflict" }
    }).success).toBe(true);
  });
});
