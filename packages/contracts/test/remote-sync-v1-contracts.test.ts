import { describe, expect, it } from "vitest";

import {
  remoteSyncContentChunkSchema,
  remoteSyncErrorCodeSchema,
  remoteSyncIdempotencyOutcomeSchema,
  remoteSyncLeaseSchema,
  remoteSyncOperationSchema,
  remoteSyncPreparedPushSchema,
  remoteSyncPushCommitSchema,
  remoteSyncPushStatusQuerySchema,
  remoteSyncPushStatusSchema,
  remoteSyncRemoteSnapshotSchema
} from "../src/index.js";

describe("Remote Sync v1 shared contract", () => {
  it("freezes HTTP-neutral idempotency outcomes and error codes", () => {
    expect(remoteSyncIdempotencyOutcomeSchema.options).toEqual([
      "new", "replay", "conflict"
    ]);
    expect(remoteSyncErrorCodeSchema.options).toContain("SYNC_PREVIEW_STALE");
    expect(remoteSyncErrorCodeSchema.safeParse("SYNC_LEASE_FENCED").success).toBe(true);
    expect(remoteSyncErrorCodeSchema.safeParse(201).success).toBe(false);
    expect(remoteSyncErrorCodeSchema.safeParse("HTTP_409").success).toBe(false);
  });

  it("requires the complete lease/fencing identity and rejects unknown fields", () => {
    const value = {
      schema_version: 1,
      lease_id: "lease_abcdefghijklmnopqrstuvwxyz0123456789_-",
      lease_token: "lease_abcdefghijklmnopqrstuvwxyz0123456789_-ABCDEFG",
      generation: 3,
      project_id: "prj_contract",
      branch_name: "main",
      actor_id: "actor_contract",
      expires_at: "2026-08-14T00:00:00.000Z"
    };
    expect(remoteSyncLeaseSchema.safeParse(value).success).toBe(false);
    const valid = {
      ...value,
      lease_id: "lease_abc",
      lease_token: "lease_abcdefghijklmnopqrstuvwxyz0123456789_-abcde"
    };
    expect(remoteSyncLeaseSchema.safeParse(valid).success).toBe(true);
    expect(remoteSyncLeaseSchema.safeParse({ ...valid, method: "POST" }).success).toBe(false);
  });

  it("bounds content chunks to one MiB and keeps status machine HTTP-neutral", () => {
    const chunk = {
      sequence: 0,
      offset: 0,
      size: 1024 * 1024,
      chunk_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      final: true
    };
    expect(remoteSyncContentChunkSchema.safeParse(chunk).success).toBe(true);
    expect(remoteSyncContentChunkSchema.safeParse({
      ...chunk,
      size: 1024 * 1024 + 1
    }).success).toBe(false);
    expect(remoteSyncPushStatusSchema.safeParse({
      source: { project_id: "prj_contract", branch_name: "main", actor_id: "actor_contract" },
      state: "unknown",
      prepare_id: "prepare_1",
      idempotency_key: "push_1",
      payload_hash: chunk.chunk_hash
    }).success).toBe(true);
    expect(remoteSyncPushStatusQuerySchema.safeParse({
      source: { project_id: "prj_contract", branch_name: "main", actor_id: "actor_contract" },
      idempotency_key: "push_1"
    }).success).toBe(true);
    expect(remoteSyncPushStatusQuerySchema.safeParse({
      project_id: "prj_contract",
      branch_name: "main",
      actor_id: "actor_contract",
      idempotency_key: "push_1"
    }).success).toBe(false);
  });

  it("binds prepared pushes to source identity, lease generation and hashes", () => {
    const lease = {
      schema_version: 1,
      lease_id: "lease_abc",
      lease_token: "lease_abcdefghijklmnopqrstuvwxyz0123456789_-abcde",
      generation: 3,
      project_id: "prj_contract",
      branch_name: "main",
      actor_id: "actor_contract",
      expires_at: "2026-08-14T00:00:00.000Z"
    };
    const prepared = {
      schema_version: 1,
      prepare_id: "prepare_1",
      source: { project_id: "prj_contract", branch_name: "main", actor_id: "actor_contract" },
      lease_id: lease.lease_id,
      lease_token: lease.lease_token,
      lease_generation: 3,
      expected_revision: "4",
      preview_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      idempotency_key: "push_1",
      payload_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      state: "prepared",
      expires_at: "2026-08-14T00:00:00.000Z"
    };
    expect(remoteSyncPreparedPushSchema.safeParse(prepared).success).toBe(true);
    expect(remoteSyncPushCommitSchema.safeParse({
      prepare_id: prepared.prepare_id,
      lease,
      idempotency_key: prepared.idempotency_key,
      payload_hash: prepared.payload_hash
    }).success).toBe(true);
  });

  it("keeps remote snapshots metadata-only and revision-addressable", () => {
    const snapshot = {
      source: { project_id: "prj_contract", branch_name: "main", actor_id: "actor_contract" },
      snapshot_id: "snapshot_1",
      revision: "4",
      project_version: "pv_4",
      commit_sha: "commit_4",
      artifact_id: "art_4",
      manifest_hash: "sha256:300887d0c256cd87b3e0b4a2d26f425bd02170fab88b034bf1b85830413ac085",
      files: [{
        path: ".harness/rules/a.md",
        content_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        size: 2,
        content_kind: "rule"
      }]
    };
    expect(remoteSyncRemoteSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(remoteSyncRemoteSnapshotSchema.safeParse({
      ...snapshot,
      files: [{ ...snapshot.files[0], content: new Uint8Array([97, 10]) }]
    }).success).toBe(false);
  });

  it("freezes strict operation records for transaction receipts", () => {
    const operation = {
      path: ".harness/rules/a.md",
      content_kind: "rule",
      action: "modify",
      local_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      remote_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    };
    expect(remoteSyncOperationSchema.safeParse(operation).success).toBe(true);
    expect(remoteSyncOperationSchema.safeParse({ ...operation, unexpected: true }).success).toBe(false);
  });
});
