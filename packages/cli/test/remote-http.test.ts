import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  remoteContentUploadHttpRecordHash,
  remoteSyncHttpMaxFileBytes,
  remoteSyncHttpMaxOperations,
  remoteSyncHttpMaxTotalBytes
} from "@hunter-harness/contracts";
import { RemoteSyncModule, resumeTransaction, runTransaction } from "@hunter-harness/core";

import { createRemoteSyncHttpPort } from "../src/push-pull-adapter/remote-http.js";

const source = {
  project_id: "prj_alpha",
  branch_name: "main",
  commit_sha: "sha-main",
  client_id: "cli_alpha"
} as const;

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function rule(path: string, content: string) {
  const bytes = new TextEncoder().encode(content);
  return {
    path,
    content_kind: "rule" as const,
    content_hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const,
    size: bytes.byteLength,
    content: bytes
  };
}

function snapshotManifestHash(files: readonly {
  path: string;
  content_hash: string;
  size: number;
  content_kind?: string;
}[]): `sha256:${string}` {
  const canonical = [...files]
    .map((file) => ({
      content_hash: file.content_hash,
      ...(file.content_kind === undefined ? {} : { content_kind: file.content_kind }),
      path: file.path,
      size: file.size
    }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

describe("RemoteSync HTTP CLI port", () => {
  it("binds the authenticated actor into lease acquisition and release", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      if (calls.length === 1) {
        return response({
          outcome: "new",
          lease: {
            schema_version: 1,
            lease_id: "lease_123",
            lease_token: `lease_${"A".repeat(43)}`,
            generation: 1,
            project_id: source.project_id,
            branch_name: source.branch_name,
            actor_id: "actor_alpha",
            expires_at: "2026-08-15T12:10:00.000Z"
          }
        });
      }
      return response({ outcome: "new" });
    });
    const port = createRemoteSyncHttpPort({
      serverUrl: "https://platform.example",
      token: "token",
      actorId: "actor_alpha",
      workspaceRoot: process.cwd(),
      fetch: fetcher
    });

    await expect(port.withProtocolLock(source, async () => "ok")).resolves.toBe("ok");
    expect(calls).toHaveLength(2);
    const acquireBody = JSON.parse(String(calls[0].init.body)) as { source: { actor_id: string } };
    expect(acquireBody.source.actor_id).toBe("actor_alpha");
    expect(new Headers(calls[0].init.headers).get("Authorization")).toBe("Bearer token");
    expect(new Headers(calls[0].init.headers).get("Idempotency-Key"))
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(new Headers(calls[1].init.headers).get("Idempotency-Key"))
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });

  it("surfaces a lease release failure after successful protected work", async () => {
    let calls = 0;
    const port = createRemoteSyncHttpPort({
      serverUrl: "https://platform.example",
      token: "token",
      actorId: "actor_alpha",
      workspaceRoot: process.cwd(),
      fetch: vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          return response({
            outcome: "new",
            lease: {
              schema_version: 1,
              lease_id: "lease_release_error",
              lease_token: `lease_${"R".repeat(43)}`,
              generation: 1,
              project_id: source.project_id,
              branch_name: source.branch_name,
              actor_id: "actor_alpha",
              expires_at: "2026-08-15T12:10:00.000Z"
            }
          });
        }
        return response({ error: { code: "REMOTE_UNAVAILABLE" } }, 503);
      })
    });

    await expect(port.withProtocolLock(source, async () => "work-complete"))
      .rejects.toMatchObject({ code: "REMOTE_UNAVAILABLE" });
    expect(calls).toBe(2);
  });

  it("binds a non-empty file upload and consumes its top-level upload reference", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "hunter-remote-push-durable-"));
    temporaryRoots.push(workspaceRoot);
    const file = rule(".harness/rules/upload.md", "uploaded rule\n");
    const operation = {
      path: file.path,
      content_kind: "rule" as const,
      action: "add" as const,
      local_hash: file.content_hash
    };
    const lease = {
      schema_version: 1 as const,
      lease_id: "lease_123",
      lease_token: `lease_${"A".repeat(43)}`,
      generation: 1,
      project_id: source.project_id,
      branch_name: source.branch_name,
      actor_id: "actor_alpha",
      expires_at: "2026-08-15T12:10:00.000Z"
    };
    const uploadToken = "B".repeat(43);
    const uploadRef = {
      ref_id: `bounded_upload:${uploadToken}`,
      sha256: file.content_hash,
      size_bytes: file.size
    } as const;
    let uploadIdempotencyKey: string | undefined;
    let prepareRequest: Record<string, unknown> | undefined;
    const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/remote-sync/leases")) {
        return response({ outcome: "new", lease });
      }
      if (url.endsWith("/remote-sync/file-upload")) {
        const headers = new Headers(init?.headers);
        uploadIdempotencyKey = headers.get("Idempotency-Key") ?? undefined;
        if (uploadIdempotencyKey === undefined) throw new Error("missing upload idempotency key");
        const recordBody = {
          schema_version: 1 as const,
          upload_id: `remote_content_upload:${uploadToken}`,
          source: {
            project_id: source.project_id,
            branch_name: source.branch_name,
            actor_id: "actor_alpha",
            commit_sha: source.commit_sha,
            client_id: source.client_id
          },
          idempotency_key: uploadIdempotencyKey,
          purpose: "remote_sync_file" as const,
          content_sha256: file.content_hash,
          size_bytes: file.size,
          upload_ref: uploadRef,
          state: "stored" as const,
          created_at: "2026-08-15T12:00:00.000Z",
          expires_at: "2026-08-15T12:10:00.000Z"
        };
        return response({
          outcome: "new",
          upload_ref: uploadRef,
          record: {
            ...recordBody,
            record_hash: remoteContentUploadHttpRecordHash(recordBody)
          }
        }, 201);
      }
      if (url.endsWith("/remote-sync/push:prepare")) {
        prepareRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return response({
          outcome: "new",
          value: {
            schema_version: 1,
            prepare_id: "prepare_1",
            source: prepareRequest.source,
            lease_id: lease.lease_id,
            lease_token: lease.lease_token,
            lease_generation: lease.generation,
            expected_revision: prepareRequest.expected_revision,
            preview_hash: prepareRequest.preview_hash,
            idempotency_key: prepareRequest.idempotency_key,
            payload_hash: prepareRequest.payload_hash,
            state: "prepared",
            expires_at: lease.expires_at
          }
        });
      }
      if (url.endsWith("/remote-sync/push:commit")) {
        if (prepareRequest === undefined) throw new Error("prepare request missing");
        return response({
          outcome: "new",
          value: {
            schema_version: 1,
            prepare_id: "prepare_1",
            source: prepareRequest.source,
            idempotency_key: prepareRequest.idempotency_key,
            payload_hash: prepareRequest.payload_hash,
            preview_hash: prepareRequest.preview_hash,
            project_version: "pv_1",
            artifact_id: "art_1",
            commit_sha: source.commit_sha,
            manifest_hash: snapshotManifestHash([file]),
            no_changes: false,
            applied: [operation],
            skipped: [],
            retryable: []
          }
        });
      }
      if (url.endsWith(":release")) return response({ outcome: "new" });
      throw new Error(`unexpected request ${url}`);
    });
    const port = createRemoteSyncHttpPort({
      serverUrl: "https://platform.example",
      token: "token",
      actorId: "actor_alpha",
      workspaceRoot,
      fetch: fetcher
    });

    const committed = await port.withProtocolLock(source, () => port.commitPush({
      source_ref: source,
      expected_revision: "revision_1",
      preview_hash: `sha256:${"1".repeat(64)}`,
      idempotency_key: `sha256:${"2".repeat(64)}`,
      payload_hash: `sha256:${"3".repeat(64)}`,
      files: [file],
      operations: [operation],
      skipped: []
    }));
    expect(committed).toMatchObject({
      project_version: "pv_1",
      artifact_id: "art_1",
      no_changes: false
    });
    expect(uploadIdempotencyKey).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(prepareRequest).toMatchObject({
      source: {
        project_id: source.project_id,
        branch_name: source.branch_name,
        actor_id: "actor_alpha",
        commit_sha: source.commit_sha,
        client_id: source.client_id
      },
      files: [{
        path: file.path,
        content_hash: file.content_hash,
        size: file.size,
        content_kind: file.content_kind,
        upload_ref: uploadRef
      }]
    });
    const fresh = createRemoteSyncHttpPort({
      serverUrl: "https://platform.example",
      token: "token",
      actorId: "actor_alpha",
      workspaceRoot,
      fetch: vi.fn(async () => { throw new Error("durable status must be local"); })
    });
    await expect(fresh.getSyncStatus(source)).resolves.toMatchObject({ last_push: committed });
  });

  it("rejects upload results whose durable identity drifts from the requested file", async () => {
    const file = rule(".harness/rules/upload-drift.md", "uploaded rule\n");
    const operation = {
      path: file.path,
      content_kind: "rule" as const,
      action: "add" as const,
      local_hash: file.content_hash
    };
    const drifts = [
      { name: "project", project_id: "prj_foreign" },
      { name: "actor", actor_id: "actor_foreign" },
      { name: "hash", content_sha256: `sha256:${"9".repeat(64)}` as const },
      { name: "size", size_bytes: file.size + 1 }
    ] as const;

    for (const drift of drifts) {
      let prepareCalls = 0;
      const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/remote-sync/leases")) {
          return response({
            outcome: "new",
            lease: {
              schema_version: 1,
              lease_id: `lease_${drift.name}`,
              lease_token: `lease_${"A".repeat(43)}`,
              generation: 1,
              project_id: source.project_id,
              branch_name: source.branch_name,
              actor_id: "actor_alpha",
              expires_at: "2026-08-15T12:10:00.000Z"
            }
          });
        }
        if (url.endsWith("/remote-sync/file-upload")) {
          const idempotencyKey = new Headers(init?.headers).get("Idempotency-Key");
          if (idempotencyKey === null) throw new Error("missing upload idempotency key");
          const contentSha256 = "content_sha256" in drift ? drift.content_sha256 : file.content_hash;
          const sizeBytes = "size_bytes" in drift ? drift.size_bytes : file.size;
          const token = "C".repeat(43);
          const uploadRef = {
            ref_id: `bounded_upload:${token}`,
            sha256: contentSha256,
            size_bytes: sizeBytes
          } as const;
          const recordBody = {
            schema_version: 1 as const,
            upload_id: `remote_content_upload:${token}`,
            source: {
              project_id: "project_id" in drift ? drift.project_id : source.project_id,
              branch_name: source.branch_name,
              actor_id: "actor_id" in drift ? drift.actor_id : "actor_alpha",
              commit_sha: source.commit_sha,
              client_id: source.client_id
            },
            idempotency_key: idempotencyKey,
            purpose: "remote_sync_file" as const,
            content_sha256: contentSha256,
            size_bytes: sizeBytes,
            upload_ref: uploadRef,
            state: "stored" as const,
            created_at: "2026-08-15T12:00:00.000Z",
            expires_at: "2026-08-15T12:10:00.000Z"
          };
          return response({
            outcome: "new",
            upload_ref: uploadRef,
            record: { ...recordBody, record_hash: remoteContentUploadHttpRecordHash(recordBody) }
          }, 201);
        }
        if (url.endsWith("/remote-sync/push:prepare")) {
          prepareCalls += 1;
          throw new Error("invalid upload must not reach prepare");
        }
        if (url.endsWith(":release")) return response({ outcome: "new" });
        throw new Error(`unexpected request ${url}`);
      });
      const port = createRemoteSyncHttpPort({
        serverUrl: "https://platform.example",
        token: "token",
        actorId: "actor_alpha",
        workspaceRoot: process.cwd(),
        fetch: fetcher
      });

      await expect(port.withProtocolLock(source, () => port.commitPush({
        source_ref: source,
        expected_revision: "revision_1",
        preview_hash: `sha256:${"1".repeat(64)}`,
        idempotency_key: `sha256:${"2".repeat(64)}`,
        payload_hash: `sha256:${"3".repeat(64)}`,
        files: [file],
        operations: [operation],
        skipped: []
      }))).rejects.toMatchObject({ code: "REMOTE_UNAVAILABLE" });
      expect(prepareCalls, drift.name).toBe(0);
    }
  });

  it("rejects a foreign durable push receipt instead of projecting it locally", async () => {
    const file = rule(".harness/rules/empty.md", "");
    const operation = {
      path: file.path,
      content_kind: "rule" as const,
      action: "add" as const,
      local_hash: file.content_hash
    };
    const lease = {
      schema_version: 1 as const,
      lease_id: "lease_foreign_receipt",
      lease_token: `lease_${"D".repeat(43)}`,
      generation: 2,
      project_id: source.project_id,
      branch_name: source.branch_name,
      actor_id: "actor_alpha",
      expires_at: "2026-08-15T12:10:00.000Z"
    };
    let prepareRequest: Record<string, unknown> | undefined;
    const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/remote-sync/leases")) return response({ outcome: "new", lease });
      if (url.endsWith("/remote-sync/push:prepare")) {
        prepareRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return response({
          outcome: "new",
          value: {
            schema_version: 1,
            prepare_id: "prepare_foreign_receipt",
            source: prepareRequest.source,
            lease_id: lease.lease_id,
            lease_token: lease.lease_token,
            lease_generation: lease.generation,
            expected_revision: prepareRequest.expected_revision,
            preview_hash: prepareRequest.preview_hash,
            idempotency_key: prepareRequest.idempotency_key,
            payload_hash: prepareRequest.payload_hash,
            state: "prepared",
            expires_at: lease.expires_at
          }
        });
      }
      if (url.endsWith("/remote-sync/push:commit")) {
        if (prepareRequest === undefined) throw new Error("prepare request missing");
        return response({
          outcome: "new",
          value: {
            schema_version: 1,
            prepare_id: "prepare_foreign_receipt",
            source: { ...(prepareRequest.source as object), actor_id: "actor_foreign" },
            idempotency_key: prepareRequest.idempotency_key,
            payload_hash: prepareRequest.payload_hash,
            preview_hash: prepareRequest.preview_hash,
            project_version: "pv_foreign",
            artifact_id: "art_foreign",
            commit_sha: source.commit_sha,
            manifest_hash: `sha256:${"e".repeat(64)}`,
            no_changes: false,
            applied: [operation],
            skipped: [],
            retryable: []
          }
        });
      }
      if (url.endsWith(":release")) return response({ outcome: "new" });
      throw new Error(`unexpected request ${url}`);
    });
    const port = createRemoteSyncHttpPort({
      serverUrl: "https://platform.example",
      token: "token",
      actorId: "actor_alpha",
      workspaceRoot: process.cwd(),
      fetch: fetcher
    });

    await expect(port.withProtocolLock(source, () => port.commitPush({
      source_ref: source,
      expected_revision: "revision_1",
      preview_hash: `sha256:${"1".repeat(64)}`,
      idempotency_key: `sha256:${"2".repeat(64)}`,
      payload_hash: `sha256:${"3".repeat(64)}`,
      files: [file],
      operations: [operation],
      skipped: []
    }))).rejects.toMatchObject({ code: "REMOTE_UNAVAILABLE" });
  });

  it("reconciles a lost commit response through durable status and receipt endpoints", async () => {
    const file = rule(".harness/rules/reconcile.md", "");
    const operation = {
      path: file.path,
      content_kind: "rule" as const,
      action: "add" as const,
      local_hash: file.content_hash
    };
    const lease = {
      schema_version: 1 as const,
      lease_id: "lease_reconcile",
      lease_token: `lease_${"E".repeat(43)}`,
      generation: 3,
      project_id: source.project_id,
      branch_name: source.branch_name,
      actor_id: "actor_alpha",
      expires_at: "2026-08-15T12:10:00.000Z"
    };
    let prepareRequest: Record<string, unknown> | undefined;
    let statusCalls = 0;
    let receiptCalls = 0;
    const durableReceipt = () => {
      if (prepareRequest === undefined) throw new Error("prepare request missing");
      return {
        schema_version: 1,
        prepare_id: "prepare_reconcile",
        source: prepareRequest.source,
        idempotency_key: prepareRequest.idempotency_key,
        payload_hash: prepareRequest.payload_hash,
        preview_hash: prepareRequest.preview_hash,
        project_version: "pv_reconcile",
        artifact_id: "art_reconcile",
        commit_sha: source.commit_sha,
        manifest_hash: snapshotManifestHash([file]),
        no_changes: false,
        applied: [operation],
        skipped: [],
        retryable: []
      };
    };
    const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/remote-sync/leases")) return response({ outcome: "new", lease });
      if (url.endsWith("/remote-sync/push:prepare")) {
        prepareRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return response({
          outcome: "new",
          value: {
            schema_version: 1,
            prepare_id: "prepare_reconcile",
            source: prepareRequest.source,
            lease_id: lease.lease_id,
            lease_token: lease.lease_token,
            lease_generation: lease.generation,
            expected_revision: prepareRequest.expected_revision,
            preview_hash: prepareRequest.preview_hash,
            idempotency_key: prepareRequest.idempotency_key,
            payload_hash: prepareRequest.payload_hash,
            state: "prepared",
            expires_at: lease.expires_at
          }
        });
      }
      if (url.endsWith("/remote-sync/push:commit")) throw new Error("response lost after commit");
      if (url.includes("/remote-sync/push/status?")) {
        statusCalls += 1;
        return response({
          source: prepareRequest?.source,
          state: "committed",
          prepare_id: "prepare_reconcile",
          idempotency_key: prepareRequest?.idempotency_key,
          payload_hash: prepareRequest?.payload_hash
        });
      }
      if (url.includes("/remote-sync/push/prepare_reconcile/receipt?")) {
        receiptCalls += 1;
        return response({ outcome: "replay", value: durableReceipt() });
      }
      if (url.endsWith(":release")) return response({ outcome: "new" });
      throw new Error(`unexpected request ${url}`);
    });
    const port = createRemoteSyncHttpPort({
      serverUrl: "https://platform.example",
      token: "token",
      actorId: "actor_alpha",
      workspaceRoot: process.cwd(),
      fetch: fetcher
    });

    await expect(port.withProtocolLock(source, () => port.commitPush({
      source_ref: source,
      expected_revision: "revision_1",
      preview_hash: `sha256:${"1".repeat(64)}`,
      idempotency_key: `sha256:${"2".repeat(64)}`,
      payload_hash: `sha256:${"3".repeat(64)}`,
      files: [file],
      operations: [operation],
      skipped: []
    }))).resolves.toMatchObject({ project_version: "pv_reconcile", artifact_id: "art_reconcile" });
    expect(statusCalls).toBe(1);
    expect(receiptCalls).toBe(1);
  });

  it("recovers a push receipt from the remote durable status before preview", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "hunter-remote-status-replay-"));
    temporaryRoots.push(workspaceRoot);
    const idempotencyKey = `sha256:${"4".repeat(64)}`;
    const payloadHash = `sha256:${"5".repeat(64)}`;
    const projected = {
      preview_hash: `sha256:${"6".repeat(64)}`,
      no_changes: true,
      applied: [],
      skipped: [],
      retryable: []
    } as const;
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      expect(String(input)).toContain("/remote-sync/push/status?");
      return response({
        source: { ...source, actor_id: "actor_alpha" },
        state: "committed",
        prepare_id: "prepare_remote_status_replay",
        idempotency_key: idempotencyKey,
        payload_hash: payloadHash,
        receipt: {
          schema_version: 1,
          prepare_id: "prepare_remote_status_replay",
          source: { ...source, actor_id: "actor_alpha" },
          idempotency_key: idempotencyKey,
          payload_hash: payloadHash,
          preview_hash: projected.preview_hash,
          project_version: null,
          artifact_id: null,
          commit_sha: source.commit_sha,
          manifest_hash: snapshotManifestHash([]),
          no_changes: true,
          applied: [],
          skipped: [],
          retryable: []
        }
      });
    });
    const first = createRemoteSyncHttpPort({
      serverUrl: "https://platform.example",
      token: "token",
      actorId: "actor_alpha",
      workspaceRoot,
      fetch: fetcher
    });
    await expect(first.getIdempotentSyncReceipt(
      source,
      "push",
      idempotencyKey,
      payloadHash
    )).resolves.toEqual(projected);

    const noNetwork = vi.fn(async () => { throw new Error("durable projection must be local"); });
    const fresh = createRemoteSyncHttpPort({
      serverUrl: "https://platform.example",
      token: "token",
      actorId: "actor_alpha",
      workspaceRoot,
      fetch: noNetwork
    });
    await expect(fresh.getIdempotentSyncReceipt(
      source,
      "push",
      idempotencyKey,
      payloadHash
    )).resolves.toEqual(projected);
    await expect(fresh.getSyncStatus(source)).resolves.toMatchObject({ last_push: projected });
    expect(noNetwork).not.toHaveBeenCalled();
  });

  it("keeps durable Push and Pull status independently across one and fresh ports", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "hunter-remote-directional-status-"));
    temporaryRoots.push(workspaceRoot);
    const pushReceipt = {
      preview_hash: `sha256:${"1".repeat(64)}`,
      no_changes: true,
      applied: [],
      skipped: [],
      retryable: []
    } as const;
    const pullReceipt = {
      preview_hash: `sha256:${"2".repeat(64)}`,
      no_changes: true,
      applied: [],
      skipped: [],
      retryable: []
    } as const;
    const factory = () => createRemoteSyncHttpPort({
      serverUrl: "https://platform.example",
      token: "token",
      actorId: "actor_alpha",
      workspaceRoot,
      fetch: vi.fn(async () => { throw new Error("status must be local"); })
    });
    const first = factory();
    await first.storeIdempotentSyncReceipt(
      source,
      "push",
      `sha256:${"3".repeat(64)}`,
      `sha256:${"4".repeat(64)}`,
      pushReceipt
    );
    await first.storeIdempotentSyncReceipt(
      source,
      "pull",
      `sha256:${"5".repeat(64)}`,
      `sha256:${"6".repeat(64)}`,
      pullReceipt
    );

    await expect(first.getSyncStatus(source)).resolves.toEqual({
      source_ref: source,
      last_push: pushReceipt,
      last_pull: pullReceipt
    });
    await expect(factory().getSyncStatus(source)).resolves.toEqual({
      source_ref: source,
      last_push: pushReceipt,
      last_pull: pullReceipt
    });
  });

  it("fails closed when a snapshot response drifts from the requested source", async () => {
    const fetcher = vi.fn(async () => response({
      value: {
        source: {
          project_id: source.project_id,
          branch_name: source.branch_name,
          actor_id: "actor-foreign",
          commit_sha: source.commit_sha,
          client_id: source.client_id
        },
        snapshot_id: "snapshot_1",
        revision: "1",
        project_version: null,
        commit_sha: null,
        artifact_id: null,
        manifest_hash: snapshotManifestHash([]),
        files: []
      }
    }));
    const port = createRemoteSyncHttpPort({
      serverUrl: "https://platform.example",
      token: "token",
      actorId: "actor_alpha",
      workspaceRoot: process.cwd(),
      fetch: fetcher
    });

    await expect(port.readSyncView(source)).rejects.toMatchObject({
      code: "REMOTE_UNAVAILABLE",
      retryable: true
    });
  });

  it("maps transport exceptions to a typed retryable remote error", async () => {
    const port = createRemoteSyncHttpPort({
      serverUrl: "https://platform.example",
      token: "token",
      actorId: "actor_alpha",
      workspaceRoot: process.cwd(),
      fetch: vi.fn(async () => { throw new Error("socket closed"); })
    });

    await expect(port.readSyncView(source)).rejects.toMatchObject({
      code: "REMOTE_UNAVAILABLE",
      retryable: true
    });
  });

  it("maps response stream failures to a typed retryable remote error", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("hostile response stream failure");
      }
    });
    const port = createRemoteSyncHttpPort({
      serverUrl: "https://platform.example",
      token: "token",
      actorId: "actor_alpha",
      workspaceRoot: process.cwd(),
      fetch: vi.fn(async () => new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }))
    });

    await expect(port.readSyncView(source)).rejects.toMatchObject({
      code: "REMOTE_UNAVAILABLE",
      retryable: true
    });
  });

  it("maps binary reader acquisition failures to a typed retryable remote error", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "hunter-remote-reader-open-"));
    temporaryRoots.push(workspaceRoot);
    const file = rule(".harness/rules/empty.md", "");
    const fetcher = vi.fn(async () => {
      if (fetcher.mock.calls.length === 1) {
        return response({
          source: { ...source, actor_id: "actor_alpha" },
          snapshot_id: "snapshot_reader_open",
          revision: "revision_1",
          project_version: null,
          commit_sha: source.commit_sha,
          artifact_id: null,
          manifest_hash: snapshotManifestHash([file]),
          files: [{
            path: file.path,
            content_hash: file.content_hash,
            size: file.size,
            content_kind: file.content_kind
          }]
        });
      }
      return {
        ok: true,
        headers: new Headers({ "Content-Length": "0" }),
        body: {
          getReader() {
            throw new Error("hostile binary reader acquisition");
          }
        }
      } as unknown as Response;
    });
    const port = createRemoteSyncHttpPort({
      serverUrl: "https://platform.example",
      token: "token",
      actorId: "actor_alpha",
      workspaceRoot,
      fetch: fetcher
    });

    await expect(port.readSyncView(source)).rejects.toMatchObject({
      code: "REMOTE_UNAVAILABLE",
      retryable: true
    });
  });

  it("maps binary reader release failures to a typed retryable remote error", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "hunter-remote-reader-release-"));
    temporaryRoots.push(workspaceRoot);
    const file = rule(".harness/rules/empty.md", "");
    const fetcher = vi.fn(async () => {
      if (fetcher.mock.calls.length === 1) {
        return response({
          source: { ...source, actor_id: "actor_alpha" },
          snapshot_id: "snapshot_reader_release",
          revision: "revision_1",
          project_version: null,
          commit_sha: source.commit_sha,
          artifact_id: null,
          manifest_hash: snapshotManifestHash([file]),
          files: [{
            path: file.path,
            content_hash: file.content_hash,
            size: file.size,
            content_kind: file.content_kind
          }]
        });
      }
      return {
        ok: true,
        headers: new Headers({ "Content-Length": "0" }),
        body: {
          getReader() {
            return {
              read: async () => ({ done: true, value: undefined }),
              releaseLock() {
                throw new Error("hostile binary reader release");
              }
            };
          }
        }
      } as unknown as Response;
    });
    const port = createRemoteSyncHttpPort({
      serverUrl: "https://platform.example",
      token: "token",
      actorId: "actor_alpha",
      workspaceRoot,
      fetch: fetcher
    });

    await expect(port.readSyncView(source)).rejects.toMatchObject({
      code: "REMOTE_UNAVAILABLE",
      retryable: true
    });
  });

  it("replays a durable no-change receipt before preview across fresh ports", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "hunter-remote-receipt-replay-"));
    temporaryRoots.push(workspaceRoot);
    const requests: string[] = [];
    const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("/remote-sync/push/status?")) {
        return response({ error: { code: "SYNC_PREPARE_NOT_FOUND" } }, 404);
      }
      if (url.includes("/remote-sync/snapshot?")) {
        return response({
          source: { ...source, actor_id: "actor_alpha" },
          snapshot_id: "snapshot_empty",
          revision: "revision_1",
          project_version: null,
          commit_sha: source.commit_sha,
          artifact_id: null,
          manifest_hash: snapshotManifestHash([]),
          files: []
        });
      }
      if (url.endsWith("/remote-sync/leases")) {
        return response({
          outcome: "new",
          lease: {
            schema_version: 1,
            lease_id: "lease_receipt_replay",
            lease_token: `lease_${"A".repeat(43)}`,
            generation: 1,
            project_id: source.project_id,
            branch_name: source.branch_name,
            actor_id: "actor_alpha",
            expires_at: "2099-08-15T12:10:00.000Z"
          }
        });
      }
      if (url.includes("/remote-sync/leases/") && url.endsWith(":release")) {
        return response({ outcome: "new" });
      }
      throw new Error(`unexpected request ${url} ${init?.method ?? "GET"}`);
    });
    const createPort = (fetchImpl: typeof globalThis.fetch) => createRemoteSyncHttpPort({
      serverUrl: "https://platform.example",
      token: "token",
      actorId: "actor_alpha",
      workspaceRoot,
      fetch: fetchImpl
    });
    const first = new RemoteSyncModule(createPort(fetcher));
    const preview = await first.previewPush(["rules"], source);
    const confirmation = {
      preview_hash: preview.preview_hash,
      idempotency_key: "durable receipt replay",
      conflict_decisions: []
    } as const;
    const receipt = await first.push(["rules"], source, confirmation);
    expect(receipt.no_changes).toBe(true);
    const callsAfterFirst = requests.length;

    const noNetwork = vi.fn(async () => {
      throw new Error("preview must not run for a durable replay");
    });
    const freshPort = createPort(noNetwork);
    await expect(new RemoteSyncModule(freshPort).push(
      ["rules"],
      source,
      confirmation
    )).resolves.toEqual(receipt);
    await expect(freshPort.getSyncStatus(source)).resolves.toMatchObject({
      source_ref: source,
      last_push: receipt
    });
    expect(noNetwork).not.toHaveBeenCalled();
    expect(requests).toHaveLength(callsAfterFirst);
  });

  it("rejects an oversized JSON response before invoking an unbounded parser", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "hunter-remote-json-bound-"));
    temporaryRoots.push(workspaceRoot);
    const json = vi.fn(async () => ({
      source: { ...source, actor_id: "actor_alpha" },
      snapshot_id: "snapshot_1",
      revision: "revision_1",
      project_version: null,
      commit_sha: null,
      artifact_id: null,
      manifest_hash: snapshotManifestHash([]),
      files: []
    }));
    const port = createRemoteSyncHttpPort({
      serverUrl: "https://platform.example",
      token: "token",
      actorId: "actor_alpha",
      workspaceRoot,
      fetch: vi.fn(async () => ({
        ok: true,
        headers: new Headers({ "Content-Length": String(remoteSyncHttpMaxTotalBytes + 1) }),
        json
      }) as unknown as Response)
    });

    await expect(port.readSyncView(source)).rejects.toMatchObject({ code: "REMOTE_UNAVAILABLE" });
    expect(json).not.toHaveBeenCalled();
  });

  it("rejects an oversized local file from metadata before reading its bytes", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "hunter-remote-local-bound-"));
    temporaryRoots.push(workspaceRoot);
    await mkdir(join(workspaceRoot, ".harness", "rules"), { recursive: true });
    await writeFile(join(workspaceRoot, ".harness", "rules", "oversized.md"), "small on disk\n");
    const readWorkspaceFile = vi.fn(async (path: string) => new Uint8Array(await readFile(path)));
    const port = createRemoteSyncHttpPort({
      serverUrl: "https://platform.example",
      token: "token",
      actorId: "actor_alpha",
      workspaceRoot,
      fetch: vi.fn(async () => response({
        source: { ...source, actor_id: "actor_alpha" },
        snapshot_id: "snapshot_1",
        revision: "revision_1",
        project_version: null,
        commit_sha: null,
        artifact_id: null,
        manifest_hash: snapshotManifestHash([]),
        files: []
      })),
      statWorkspaceFile: vi.fn(async () => ({ size: remoteSyncHttpMaxFileBytes + 1 })),
      readWorkspaceFile
    });

    await expect(port.readSyncView(source)).rejects.toMatchObject({ code: "SYNC_STREAM_TOO_LARGE" });
    expect(readWorkspaceFile).not.toHaveBeenCalled();
  });

  it("excludes state, environment, and credential paths before reading their metadata or bytes", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "hunter-remote-secret-scan-"));
    temporaryRoots.push(workspaceRoot);
    await Promise.all([
      mkdir(join(workspaceRoot, ".harness", "rules"), { recursive: true }),
      mkdir(join(workspaceRoot, ".harness", "state", "transactions"), { recursive: true }),
      mkdir(join(workspaceRoot, ".harness", "credentials.local"), { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(workspaceRoot, ".harness", "rules", "safe.md"), "safe\n"),
      writeFile(join(workspaceRoot, ".harness", "state", "transactions", "secret.json"), "STATE_SECRET\n"),
      writeFile(join(workspaceRoot, ".harness", "credentials.local", "token"), "CREDENTIAL_SECRET\n"),
      writeFile(join(workspaceRoot, ".env.production"), "ENV_SECRET\n")
    ]);
    const statCalls: string[] = [];
    const readCalls: string[] = [];
    const port = createRemoteSyncHttpPort({
      serverUrl: "https://platform.example",
      token: "token",
      actorId: "actor_alpha",
      workspaceRoot,
      fetch: vi.fn(async () => response({
        source: { ...source, actor_id: "actor_alpha" },
        snapshot_id: "snapshot_1",
        revision: "revision_1",
        project_version: null,
        commit_sha: null,
        artifact_id: null,
        manifest_hash: snapshotManifestHash([]),
        files: []
      })),
      statWorkspaceFile: async (path) => {
        statCalls.push(path);
        return { size: (await stat(path)).size };
      },
      readWorkspaceFile: async (path) => {
        readCalls.push(path);
        return new Uint8Array(await readFile(path));
      }
    });

    await expect(port.readSyncView(source)).resolves.toMatchObject({
      local_files: [{ path: ".harness/rules/safe.md" }]
    });
    expect(statCalls).toEqual([join(workspaceRoot, ".harness", "rules", "safe.md")]);
    expect(readCalls).toEqual([join(workspaceRoot, ".harness", "rules", "safe.md")]);
  });

  it("rejects a workspace directory replaced by a junction between metadata and content reads", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "hunter-remote-scan-race-"));
    const externalRoot = await mkdtemp(join(tmpdir(), "hunter-remote-scan-secret-"));
    temporaryRoots.push(workspaceRoot, externalRoot);
    const rulesRoot = join(workspaceRoot, ".harness", "rules");
    const savedRulesRoot = join(workspaceRoot, ".harness", "rules-safe");
    const externalRulesRoot = join(externalRoot, "rules");
    await Promise.all([
      mkdir(rulesRoot, { recursive: true }),
      mkdir(externalRulesRoot, { recursive: true })
    ]);
    const safe = "SAFE".padEnd(32, "s");
    const secret = "SECRET".padEnd(32, "x");
    await Promise.all([
      writeFile(join(rulesRoot, "race.md"), safe),
      writeFile(join(externalRulesRoot, "race.md"), secret)
    ]);
    let swapped = false;
    const port = createRemoteSyncHttpPort({
      serverUrl: "https://platform.example",
      token: "token",
      actorId: "actor_alpha",
      workspaceRoot,
      fetch: vi.fn(async () => response({
        source: { ...source, actor_id: "actor_alpha" },
        snapshot_id: "snapshot_1",
        revision: "revision_1",
        project_version: null,
        commit_sha: null,
        artifact_id: null,
        manifest_hash: snapshotManifestHash([]),
        files: []
      })),
      statWorkspaceFile: async (path) => {
        const metadata = await stat(path);
        if (!swapped) {
          swapped = true;
          await rename(rulesRoot, savedRulesRoot);
          await symlink(externalRulesRoot, rulesRoot, process.platform === "win32" ? "junction" : "dir");
        }
        return { size: metadata.size };
      }
    });

    await expect(port.readSyncView(source)).rejects.toMatchObject({
      code: "SYNC_PATH_NOT_ELIGIBLE"
    });
    expect(swapped).toBe(true);
  });

  it("bounds directory iteration without materializing an unbounded entry array", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "hunter-remote-directory-bound-"));
    temporaryRoots.push(workspaceRoot);
    let yielded = 0;
    const options = {
      serverUrl: "https://platform.example",
      token: "token",
      actorId: "actor_alpha",
      workspaceRoot,
      fetch: vi.fn(async () => response({
        source: { ...source, actor_id: "actor_alpha" },
        snapshot_id: "snapshot_1",
        revision: "revision_1",
        project_version: null,
        commit_sha: null,
        artifact_id: null,
        manifest_hash: snapshotManifestHash([]),
        files: []
      })),
      readWorkspaceEntries: async function* () {
        for (let index = 0; index <= remoteSyncHttpMaxOperations; index += 1) {
          yielded += 1;
          yield {
            name: `.env-${index}`,
            isSymbolicLink: () => false,
            isDirectory: () => false,
            isFile: () => true
          };
        }
      }
    } as unknown as Parameters<typeof createRemoteSyncHttpPort>[0];
    const port = createRemoteSyncHttpPort(options);

    await expect(port.readSyncView(source)).rejects.toMatchObject({ code: "SYNC_STREAM_TOO_LARGE" });
    expect(yielded).toBe(remoteSyncHttpMaxOperations + 1);
  });

  it("rejects an oversized remote Content-Length before buffering the body", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "hunter-remote-content-length-"));
    temporaryRoots.push(workspaceRoot);
    const file = rule(".harness/rules/remote.md", "x");
    const arrayBuffer = vi.fn(async () => new Uint8Array([120]).buffer);
    const fetcher = vi.fn(async () => {
      if (fetcher.mock.calls.length === 1) {
        return response({
          source: { ...source, actor_id: "actor_alpha" },
          snapshot_id: "snapshot_1",
          revision: "revision_1",
          project_version: null,
          commit_sha: null,
          artifact_id: null,
          manifest_hash: snapshotManifestHash([file]),
          files: [{
            path: file.path,
            content_hash: file.content_hash,
            size: file.size,
            content_kind: file.content_kind
          }]
        });
      }
      return {
        ok: true,
        headers: new Headers({ "Content-Length": String(remoteSyncHttpMaxFileBytes + 1) }),
        arrayBuffer
      } as unknown as Response;
    });
    const port = createRemoteSyncHttpPort({
      serverUrl: "https://platform.example",
      token: "token",
      actorId: "actor_alpha",
      workspaceRoot,
      fetch: fetcher
    });

    await expect(port.readSyncView(source)).rejects.toMatchObject({ code: "SYNC_STREAM_TOO_LARGE" });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("rejects a malformed remote Content-Length before buffering the body", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "hunter-remote-content-length-invalid-"));
    temporaryRoots.push(workspaceRoot);
    const file = rule(".harness/rules/remote-invalid-length.md", "x");
    const arrayBuffer = vi.fn(async () => new Uint8Array([120]).buffer);
    const fetcher = vi.fn(async () => {
      if (fetcher.mock.calls.length === 1) {
        return response({
          source: { ...source, actor_id: "actor_alpha" },
          snapshot_id: "snapshot_1",
          revision: "revision_1",
          project_version: null,
          commit_sha: null,
          artifact_id: null,
          manifest_hash: snapshotManifestHash([file]),
          files: [{
            path: file.path,
            content_hash: file.content_hash,
            size: file.size,
            content_kind: file.content_kind
          }]
        });
      }
      return {
        ok: true,
        headers: new Headers({ "Content-Length": "1x" }),
        arrayBuffer
      } as unknown as Response;
    });
    const port = createRemoteSyncHttpPort({
      serverUrl: "https://platform.example",
      token: "token",
      actorId: "actor_alpha",
      workspaceRoot,
      fetch: fetcher
    });

    await expect(port.readSyncView(source)).rejects.toMatchObject({ code: "SYNC_STREAM_INVALID" });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("rejects remote snapshot metadata over the aggregate byte limit before content fetches", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "hunter-remote-total-bound-"));
    temporaryRoots.push(workspaceRoot);
    const count = Math.floor(remoteSyncHttpMaxTotalBytes / remoteSyncHttpMaxFileBytes) + 1;
    const remoteFiles = Array.from({ length: count }, (_, index) => ({
      path: `.harness/rules/file-${index}.md`,
      content_hash: `sha256:${"0".repeat(64)}`,
      size: remoteSyncHttpMaxFileBytes,
      content_kind: "rule"
    }));
    const fetcher = vi.fn(async () => {
      if (fetcher.mock.calls.length !== 1) throw new Error("content must not be fetched");
      return response({
        source: { ...source, actor_id: "actor_alpha" },
        snapshot_id: "snapshot_1",
        revision: "revision_1",
        project_version: null,
        commit_sha: null,
        artifact_id: null,
        manifest_hash: snapshotManifestHash(remoteFiles),
        files: remoteFiles
      });
    });
    const port = createRemoteSyncHttpPort({
      serverUrl: "https://platform.example",
      token: "token",
      actorId: "actor_alpha",
      workspaceRoot,
      fetch: fetcher
    });

    await expect(port.readSyncView(source)).rejects.toMatchObject({ code: "SYNC_STREAM_TOO_LARGE" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a remote snapshot whose manifest hash does not describe its files", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "hunter-remote-manifest-"));
    temporaryRoots.push(workspaceRoot);
    const port = createRemoteSyncHttpPort({
      serverUrl: "https://platform.example",
      token: "token",
      actorId: "actor_alpha",
      workspaceRoot,
      fetch: vi.fn(async () => response({
        source: { ...source, actor_id: "actor_alpha" },
        snapshot_id: "snapshot_1",
        revision: "revision_1",
        project_version: null,
        commit_sha: null,
        artifact_id: null,
        manifest_hash: `sha256:${"0".repeat(64)}`,
        files: []
      }))
    });

    await expect(port.readSyncView(source)).rejects.toMatchObject({
      code: "SYNC_PULL_WORKSPACE_FAILED"
    });
  });

  it("applies Pull changes through the durable workspace transaction journal", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "hunter-remote-pull-"));
    temporaryRoots.push(workspaceRoot);
    await mkdir(join(workspaceRoot, ".harness", "rules"), { recursive: true });
    await Promise.all([
      writeFile(join(workspaceRoot, ".harness", "rules", "modify.md"), "old modify\n"),
      writeFile(join(workspaceRoot, ".harness", "rules", "delete.md"), "delete me\n"),
      writeFile(join(workspaceRoot, ".harness", "rules", "old-name.md"), "rename me\n")
    ]);
    const files = [
      rule(".harness/rules/modify.md", "new modify\n"),
      rule(".harness/rules/add.md", "new file\n"),
      rule(".harness/rules/new-name.md", "rename me\n")
    ];
    const port = createRemoteSyncHttpPort({
      serverUrl: "https://platform.example",
      token: "token",
      actorId: "actor_alpha",
      workspaceRoot,
      fetch: vi.fn()
    });

    await expect(port.commitPull({
      source_ref: source,
      expected_revision: "revision_1",
      preview_hash: `sha256:${"1".repeat(64)}`,
      idempotency_key: `sha256:${"2".repeat(64)}`,
      payload_hash: `sha256:${"3".repeat(64)}`,
      files,
      baseline_files: [],
      operations: [
        { path: ".harness/rules/modify.md", content_kind: "rule", action: "modify" },
        { path: ".harness/rules/delete.md", content_kind: "rule", action: "delete" },
        { path: ".harness/rules/add.md", content_kind: "rule", action: "add" },
        { path: ".harness/rules/new-name.md", source_path: ".harness/rules/old-name.md",
          content_kind: "rule", action: "rename" }
      ],
      skipped: []
    })).resolves.toMatchObject({ no_changes: false });

    await expect(readFile(join(workspaceRoot, ".harness", "rules", "modify.md"), "utf8"))
      .resolves.toBe("new modify\n");
    await expect(readFile(join(workspaceRoot, ".harness", "rules", "add.md"), "utf8"))
      .resolves.toBe("new file\n");
    await expect(readFile(join(workspaceRoot, ".harness", "rules", "new-name.md"), "utf8"))
      .resolves.toBe("rename me\n");
    await expect(readFile(join(workspaceRoot, ".harness", "rules", "delete.md"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(workspaceRoot, ".harness", "rules", "old-name.md"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });

    const transactionRoot = join(workspaceRoot, ".harness", "state", "transactions");
    const allTransactionIds = await readdir(transactionRoot);
    const transactionIds = allTransactionIds.filter((name) =>
      /^tx_remote_pull_[a-f0-9]{64}$/u.test(name));
    expect(transactionIds).toHaveLength(1);
    const transactionId = transactionIds[0];
    if (transactionId === undefined) throw new Error("expected Pull transaction journal");
    const journal = JSON.parse(await readFile(join(transactionRoot, transactionId, "journal.json"), "utf8")) as {
      schema_version: number;
      state: string;
      kind: string;
      operations: Array<{ operation: string }>;
    };
    expect(journal).toMatchObject({
      schema_version: 3,
      state: "committed",
      operations: [
        { operation: "modify" },
        { operation: "delete" },
        { operation: "add" },
        { operation: "rename" }
      ]
    });
  });

  it("rejects a Pull when a local file changed after preview", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "hunter-remote-pull-local-drift-"));
    temporaryRoots.push(workspaceRoot);
    const path = ".harness/rules/drift.md";
    const previewLocal = rule(path, "local at preview\n");
    const remote = rule(path, "remote content\n");
    await mkdir(join(workspaceRoot, ".harness", "rules"), { recursive: true });
    await writeFile(join(workspaceRoot, path), "changed after preview\n");
    const runWorkspaceTransaction = vi.fn(async (root, operations, options) =>
      runTransaction(root, operations, options));
    const port = createRemoteSyncHttpPort({
      serverUrl: "https://platform.example",
      token: "token",
      actorId: "actor_alpha",
      workspaceRoot,
      fetch: vi.fn(),
      runWorkspaceTransaction
    });

    await expect(port.commitPull({
      source_ref: source,
      expected_revision: "revision_1",
      preview_hash: `sha256:${"1".repeat(64)}`,
      idempotency_key: `sha256:${"2".repeat(64)}`,
      payload_hash: `sha256:${"3".repeat(64)}`,
      files: [remote],
      baseline_files: [previewLocal],
      operations: [{
        path,
        content_kind: "rule",
        action: "modify",
        local_hash: previewLocal.content_hash,
        remote_hash: remote.content_hash
      }],
      skipped: []
    })).rejects.toMatchObject({ code: "SYNC_PREVIEW_STALE" });
    expect(runWorkspaceTransaction).not.toHaveBeenCalled();
    await expect(readFile(join(workspaceRoot, path), "utf8"))
      .resolves.toBe("changed after preview\n");
  });

  it("resumes an interrupted Pull transaction without replaying completed writes", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "hunter-remote-pull-recovery-"));
    temporaryRoots.push(workspaceRoot);
    await mkdir(join(workspaceRoot, ".harness", "rules"), { recursive: true });
    await writeFile(join(workspaceRoot, ".harness", "rules", "first.md"), "old first\n");
    const files = [
      rule(".harness/rules/first.md", "new first\n"),
      rule(".harness/rules/second.md", "new second\n")
    ];
    const port = createRemoteSyncHttpPort({
      serverUrl: "https://platform.example",
      token: "token",
      actorId: "actor_alpha",
      workspaceRoot,
      fetch: vi.fn(),
      runWorkspaceTransaction: async (root, operations, options) =>
        runTransaction(root, operations, { ...options, interruptAfterApply: 1 })
    });

    await expect(port.commitPull({
      source_ref: source,
      expected_revision: "revision_1",
      preview_hash: `sha256:${"1".repeat(64)}`,
      idempotency_key: `sha256:${"2".repeat(64)}`,
      payload_hash: `sha256:${"3".repeat(64)}`,
      files,
      baseline_files: [],
      operations: [
        { path: ".harness/rules/first.md", content_kind: "rule", action: "modify" },
        { path: ".harness/rules/second.md", content_kind: "rule", action: "add" }
      ],
      skipped: []
    })).rejects.toMatchObject({
      code: "SYNC_PULL_WORKSPACE_FAILED",
      retryable: true
    });

    await expect(readFile(join(workspaceRoot, ".harness", "rules", "first.md"), "utf8"))
      .resolves.toBe("new first\n");
    await expect(readFile(join(workspaceRoot, ".harness", "rules", "second.md"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });

    const transactionRoot = join(workspaceRoot, ".harness", "state", "transactions");
    const transactionIds = (await readdir(transactionRoot)).filter((name) =>
      /^tx_remote_pull_[a-f0-9]{64}$/u.test(name));
    expect(transactionIds).toHaveLength(1);
    const transactionId = transactionIds[0];
    if (transactionId === undefined) throw new Error("expected interrupted Pull transaction journal");
    const interrupted = JSON.parse(await readFile(
      join(transactionRoot, transactionId, "journal.json"),
      "utf8"
    )) as { state: string; applied_count: number; pending_operations: number[] };
    expect(interrupted).toMatchObject({
      state: "interrupted",
      applied_count: 1,
      pending_operations: [1]
    });

    await expect(resumeTransaction(workspaceRoot, transactionId))
      .resolves.toMatchObject({ status: "committed" });
    await expect(readFile(join(workspaceRoot, ".harness", "rules", "first.md"), "utf8"))
      .resolves.toBe("new first\n");
    await expect(readFile(join(workspaceRoot, ".harness", "rules", "second.md"), "utf8"))
      .resolves.toBe("new second\n");
    const committed = JSON.parse(await readFile(
      join(transactionRoot, transactionId, "journal.json"),
      "utf8"
    )) as { state: string; applied_count: number; pending_operations: number[] };
    expect(committed).toMatchObject({
      state: "committed",
      applied_count: 2,
      pending_operations: []
    });
  });

  it("replays a committed Pull without reconstructing a mutable transaction sidecar", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "hunter-remote-pull-replay-"));
    temporaryRoots.push(workspaceRoot);
    await mkdir(join(workspaceRoot, ".harness", "rules"), { recursive: true });
    await writeFile(join(workspaceRoot, ".harness", "rules", "replay.md"), "old\n");
    const file = rule(".harness/rules/replay.md", "new\n");
    const command = {
      source_ref: source,
      expected_revision: "revision_1",
      preview_hash: `sha256:${"1".repeat(64)}`,
      idempotency_key: `sha256:${"2".repeat(64)}`,
      payload_hash: `sha256:${"3".repeat(64)}`,
      files: [file],
      baseline_files: [],
      operations: [{
        path: file.path,
        content_kind: "rule" as const,
        action: "modify" as const,
        remote_hash: file.content_hash
      }],
      skipped: [],
      project_version: "pv_1",
      artifact_id: "art_1"
    } as const;
    let transactionCalls = 0;
    const factory = () => createRemoteSyncHttpPort({
      serverUrl: "https://platform.example",
      token: "token",
      actorId: "actor_alpha",
      workspaceRoot,
      fetch: vi.fn(),
      runWorkspaceTransaction: async (root, operations, options) => {
        transactionCalls += 1;
        return runTransaction(root, operations, options);
      }
    });

    const first = await factory().commitPull(command);
    const transactionRoot = join(workspaceRoot, ".harness", "state", "transactions");
    const allTransactionIds = await readdir(transactionRoot);
    const transactionIds = allTransactionIds.filter((name) =>
      /^tx_remote_pull_[a-f0-9]{64}$/u.test(name));
    expect(transactionIds).toHaveLength(1);
    expect(transactionIds[0]).toMatch(/^tx_remote_pull_[a-f0-9]{64}$/u);
    const transactionId = transactionIds[0];
    if (transactionId === undefined) throw new Error("expected deterministic Pull transaction");
    const receiptPath = join(transactionRoot, transactionId, "remote-sync-pull-receipt.json");
    const receiptTransactionId = allTransactionIds.find((name) =>
      /^tx_remote_receipt_[a-f0-9]{64}$/u.test(name));
    if (receiptTransactionId === undefined) throw new Error("expected durable receipt projection");
    await rm(join(transactionRoot, receiptTransactionId), { recursive: true, force: true });
    await expect(factory().getIdempotentSyncReceipt(
      source,
      "pull",
      command.idempotency_key,
      command.payload_hash
    )).resolves.toEqual(first);
    const replay = await factory().commitPull(command);
    expect(replay).toEqual(first);
    expect(transactionCalls).toBe(1);
    const journal = JSON.parse(await readFile(join(transactionRoot, transactionId, "journal.json"), "utf8")) as {
      project_identity: string;
    };
    expect(JSON.parse(journal.project_identity)).toMatchObject({
      idempotency_key: command.idempotency_key,
      payload_hash: command.payload_hash,
      source_ref: source
    });
    await expect(readFile(receiptPath, "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a forged minimal committed Pull journal before creating a durable receipt", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "hunter-remote-pull-forged-"));
    temporaryRoots.push(workspaceRoot);
    const command = {
      source_ref: source,
      expected_revision: "revision_1",
      preview_hash: `sha256:${"1".repeat(64)}`,
      idempotency_key: `sha256:${"2".repeat(64)}`,
      payload_hash: `sha256:${"3".repeat(64)}`,
      files: [],
      baseline_files: [],
      operations: [],
      skipped: []
    } as const;
    let transactionId = "";
    let projectIdentity = "";
    const discovery = createRemoteSyncHttpPort({
      serverUrl: "https://platform.example",
      token: "token",
      actorId: "actor_alpha",
      workspaceRoot,
      fetch: vi.fn(),
      runWorkspaceTransaction: async (_root, _operations, options) => {
        transactionId = options?.id ?? "";
        projectIdentity = options?.projectIdentity ?? "";
        throw new Error("capture transaction identity");
      }
    });
    await expect(discovery.commitPull(command)).rejects.toMatchObject({
      code: "SYNC_PULL_WORKSPACE_FAILED"
    });
    expect(transactionId).toMatch(/^tx_remote_pull_[a-f0-9]{64}$/u);
    const transactionRoot = join(workspaceRoot, ".harness", "state", "transactions", transactionId);
    const receiptPath = join(transactionRoot, "remote-sync-pull-receipt.json");
    await mkdir(transactionRoot, { recursive: true });
    await writeFile(join(transactionRoot, "journal.json"), JSON.stringify({
      transaction_id: transactionId,
      project_identity: projectIdentity,
      state: "committed"
    }));
    const replay = createRemoteSyncHttpPort({
      serverUrl: "https://platform.example",
      token: "token",
      actorId: "actor_alpha",
      workspaceRoot,
      fetch: vi.fn()
    });

    await expect(replay.commitPull(command)).rejects.toMatchObject({
      code: "SYNC_PULL_WORKSPACE_FAILED"
    });
    await expect(readFile(receiptPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not follow a Pull transaction junction when reconstructing a receipt", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "hunter-remote-pull-junction-"));
    const externalRoot = await mkdtemp(join(tmpdir(), "hunter-remote-pull-external-"));
    temporaryRoots.push(workspaceRoot, externalRoot);
    const command = {
      source_ref: source,
      expected_revision: "revision_1",
      preview_hash: `sha256:${"1".repeat(64)}`,
      idempotency_key: `sha256:${"2".repeat(64)}`,
      payload_hash: `sha256:${"3".repeat(64)}`,
      files: [],
      baseline_files: [],
      operations: [],
      skipped: []
    } as const;
    const factory = () => createRemoteSyncHttpPort({
      serverUrl: "https://platform.example",
      token: "token",
      actorId: "actor_alpha",
      workspaceRoot,
      fetch: vi.fn()
    });
    await expect(factory().commitPull(command)).resolves.toMatchObject({ no_changes: true });
    const transactionsRoot = join(workspaceRoot, ".harness", "state", "transactions");
    const transactionIds = (await readdir(transactionsRoot)).filter((name) =>
      /^tx_remote_pull_[a-f0-9]{64}$/u.test(name));
    expect(transactionIds).toHaveLength(1);
    const transactionId = transactionIds[0];
    if (transactionId === undefined) throw new Error("expected Pull transaction journal");
    const transactionRoot = join(transactionsRoot, transactionId);
    const externalTransactionRoot = join(externalRoot, transactionId);
    await rename(transactionRoot, externalTransactionRoot);
    await symlink(externalTransactionRoot, transactionRoot, process.platform === "win32" ? "junction" : "dir");

    await expect(factory().commitPull(command)).rejects.toMatchObject({
      code: "SYNC_PULL_WORKSPACE_FAILED"
    });
    await expect(readFile(join(externalTransactionRoot, "remote-sync-pull-receipt.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects case-folded Pull path collisions before starting a workspace transaction", async () => {
    const first = rule(".harness/rules/Case.md", "first\n");
    const second = rule(".harness/rules/case.md", "second\n");
    const runWorkspaceTransaction = vi.fn(async (root, operations, options) =>
      runTransaction(root, operations, options));
    const port = createRemoteSyncHttpPort({
      serverUrl: "https://platform.example",
      token: "token",
      actorId: "actor_alpha",
      workspaceRoot: process.cwd(),
      fetch: vi.fn(),
      runWorkspaceTransaction
    });

    await expect(port.commitPull({
      source_ref: source,
      expected_revision: "revision_1",
      preview_hash: `sha256:${"1".repeat(64)}`,
      idempotency_key: `sha256:${"2".repeat(64)}`,
      payload_hash: `sha256:${"3".repeat(64)}`,
      files: [first, second],
      baseline_files: [],
      operations: [
        { path: first.path, content_kind: "rule", action: "add" },
        { path: second.path, content_kind: "rule", action: "add" }
      ],
      skipped: []
    })).rejects.toMatchObject({ code: "SYNC_CONTENT_INVALID" });
    expect(runWorkspaceTransaction).not.toHaveBeenCalled();
  });
});
