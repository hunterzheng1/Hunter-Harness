import { describe, expect, it } from "vitest";

import { sha256Bytes } from "../src/fs/hash.js";
import {
  InMemoryRemoteSyncV1,
  REMOTE_SYNC_MAX_FILE_BYTES,
  RemoteSyncV1Module,
  remoteSyncPushPayloadHash,
  validateRemoteSyncPushMetadata,
  type RemoteSyncPushPrepareCommand,
  type RemoteSyncSourceRef,
  type RemoteSyncWorkspaceFile
} from "../src/remote-sync/index.js";

const source: RemoteSyncSourceRef = {
  project_id: "prj_v1",
  branch_name: "main",
  actor_id: "act_v1"
};

function file(path: string, value: string): RemoteSyncWorkspaceFile {
  const content = new TextEncoder().encode(value);
  return {
    path,
    content,
    content_hash: sha256Bytes(content),
    size: content.byteLength
  };
}

function prepare(
  lease: Awaited<ReturnType<InMemoryRemoteSyncV1["acquireLease"]>>,
  files: readonly RemoteSyncWorkspaceFile[] = [file(".harness/rules/a.md", "a\n")]
): RemoteSyncPushPrepareCommand {
  const first = files[0];
  if (first === undefined) throw new Error("prepare requires a file");
  const command: Omit<RemoteSyncPushPrepareCommand, "payload_hash"> = {
    source,
    lease,
    expected_revision: "0",
    preview_hash: sha256Bytes("preview-a"),
    idempotency_key: "push-key-a",
    files,
    operations: [{
      path: first.path,
      content_kind: "rule",
      action: "add",
      local_hash: first.content_hash
    }],
    skipped: []
  };
  return { ...command, payload_hash: remoteSyncPushPayloadHash(command) };
}

describe("RemoteSync v1 contract reference", () => {
  it("issues CSPRNG-looking leases bound to actor, project, branch and generation", async () => {
    let now = 1_000;
    const remote = new InMemoryRemoteSyncV1({ now: () => now });
    const first = await remote.acquireLease(source);
    now += 61_000;
    const second = await remote.acquireLease({ ...source, actor_id: "act_other" });

    expect(first).toMatchObject({
      schema_version: 1,
      project_id: source.project_id,
      branch_name: source.branch_name,
      actor_id: source.actor_id,
      generation: 1
    });
    expect(first.lease_token).toMatch(/^lease_[A-Za-z0-9_-]{43}$/u);
    expect(second.generation).toBe(2);
    expect(second.lease_token).not.toBe(first.lease_token);
  });

  it("reuses Core push metadata invariants for HTTP prepare callers", async () => {
    const remote = new InMemoryRemoteSyncV1({ now: () => 1_000 });
    const lease = await remote.acquireLease(source);
    const command = prepare(lease);
    const metadata = command.files.map(({ path, content_hash, size }) => ({
      path, content_hash, size
    }));
    expect(() => validateRemoteSyncPushMetadata({
      source: command.source,
      expected_revision: command.expected_revision,
      preview_hash: command.preview_hash,
      idempotency_key: command.idempotency_key,
      payload_hash: command.payload_hash,
      files: metadata,
      operations: command.operations,
      skipped: command.skipped
    })).not.toThrow();
    expect(() => validateRemoteSyncPushMetadata({
      source: command.source,
      expected_revision: command.expected_revision,
      preview_hash: command.preview_hash,
      idempotency_key: command.idempotency_key,
      payload_hash: "sha256:" + "0".repeat(64),
      files: [...metadata, { ...metadata[0], path: ".harness/rules/A.md" }],
      operations: command.operations,
      skipped: command.skipped
    })).toThrowError(/SYNC_CONTENT_INVALID/u);
  });

  it("rejects Push metadata whose files exceed the 256 MiB aggregate limit", () => {
    const files = Array.from({ length: 5 }, (_, index) => ({
      path: `.harness/rules/aggregate-${index}.md`,
      content_hash: `sha256:${String(index).repeat(64)}`,
      size: REMOTE_SYNC_MAX_FILE_BYTES,
      content_kind: "rule" as const
    }));
    const operations = files.map((item) => ({
      path: item.path,
      content_kind: "rule" as const,
      action: "add" as const,
      local_hash: item.content_hash
    }));
    const payload = {
      source,
      expected_revision: "revision_aggregate",
      preview_hash: `sha256:${"a".repeat(64)}`,
      idempotency_key: "push-aggregate-limit",
      files: files.map((item) => ({ ...item, content: new Uint8Array(0) })),
      operations,
      skipped: []
    };

    expect(() => validateRemoteSyncPushMetadata({
      ...payload,
      files,
      payload_hash: remoteSyncPushPayloadHash(payload)
    })).toThrow(expect.objectContaining({ code: "SYNC_STREAM_TOO_LARGE" }));
  });

  it("rejects accessor-bearing HTTP metadata before reading the accessor", async () => {
    const remote = new InMemoryRemoteSyncV1({ now: () => 1_500 });
    const lease = await remote.acquireLease(source);
    const command = prepare(lease);
    const metadata = command.files.map(({ path, content_hash, size }) => ({
      path, content_hash, size
    }));
    let reads = 0;
    const hostile = {
      source: command.source,
      expected_revision: command.expected_revision,
      preview_hash: command.preview_hash,
      idempotency_key: command.idempotency_key,
      payload_hash: command.payload_hash,
      files: metadata,
      operations: command.operations,
      skipped: command.skipped
    } as Record<string, unknown>;
    Object.defineProperty(hostile, "files", {
      enumerable: true,
      get: () => { reads += 1; throw new Error("metadata getter must not run"); }
    });
    expect(() => validateRemoteSyncPushMetadata(hostile)).toThrowError(/SYNC_CONTENT_INVALID/u);
    expect(reads).toBe(0);
  });

  it("rejects stale and expired fencing capabilities before mutating", async () => {
    let now = 1_000;
    const remote = new InMemoryRemoteSyncV1({ now: () => now });
    const oldLease = await remote.acquireLease(source, { ttl_ms: 10 });
    now = 1_011;
    await expect(remote.preparePush(prepare(oldLease))).rejects.toMatchObject({
      code: "SYNC_LEASE_EXPIRED"
    });

    now = 2_000;
    const leaseA = await remote.acquireLease(source);
    await remote.releaseLease(leaseA);
    const leaseB = await remote.acquireLease(source);
    await expect(remote.preparePush(prepare(leaseA))).rejects.toMatchObject({
      code: "SYNC_LEASE_FENCED"
    });
    expect(leaseB.generation).toBeGreaterThan(leaseA.generation);
  });

  it("uses HTTP-neutral new/replay/conflict outcomes across prepare and commit", async () => {
    const remote = new InMemoryRemoteSyncV1({ now: () => 10_000 });
    const lease = await remote.acquireLease(source);
    const command = prepare(lease);
    const first = await remote.preparePush(command);
    expect(first.outcome).toBe("new");
    if (first.outcome !== "new") throw new Error("prepare did not create");

    const replay = await remote.preparePush(command);
    expect(replay).toEqual({ outcome: "replay", value: first.value });

    const changedFiles = [file(".harness/rules/a.md", "different\n")];
    const changedCommand = { ...command, files: changedFiles };
    const conflict = await remote.preparePush({
      ...changedCommand,
      payload_hash: remoteSyncPushPayloadHash(changedCommand)
    });
    expect(conflict).toMatchObject({
      outcome: "conflict",
      error: { code: "SYNC_IDEMPOTENCY_CONFLICT" }
    });

    const committed = await remote.commitPush({
      prepare_id: first.value.prepare_id,
      lease,
      idempotency_key: command.idempotency_key,
      payload_hash: command.payload_hash
    });
    expect(committed.outcome).toBe("new");
    const committedReplay = await remote.commitPush({
      prepare_id: first.value.prepare_id,
      lease,
      idempotency_key: command.idempotency_key,
      payload_hash: command.payload_hash
    });
    expect(committedReplay).toEqual({ outcome: "replay", value: expect.anything() });
  });

  it("keeps pull remote-read-only and commits local workspace as one transaction", async () => {
    const remote = new InMemoryRemoteSyncV1({ now: () => 20_000 });
    const lease = await remote.acquireLease(source);
    const command = prepare(lease);
    const prepared = await remote.preparePush(command);
    if (prepared.outcome !== "new") throw new Error("prepare did not create");
    await remote.commitPush({
      prepare_id: prepared.value.prepare_id,
      lease,
      idempotency_key: command.idempotency_key,
      payload_hash: command.payload_hash
    });

    const module = new RemoteSyncV1Module(remote, remote);
    const receipt = await module.pull({
      source,
      actor_id: source.actor_id,
      idempotency_key: "pull-key-a"
    });
    expect(receipt.outcome).toBe("new");
    if (receipt.outcome !== "new") throw new Error("pull did not create");
    expect(receipt.value.local_transaction).toBe("committed");
    expect(receipt.value.applied).toMatchObject([{
      path: ".harness/rules/a.md",
      action: "add"
    }]);
    expect(remote.localFiles(source)).toEqual([file(".harness/rules/a.md", "a\n")]);
    const noChange = await module.pull({
      source,
      actor_id: source.actor_id,
      idempotency_key: "pull-key-b"
    });
    expect(noChange).toMatchObject({
      outcome: "new",
      value: { no_changes: true, applied: [], skipped: [{ action: "no_change" }] }
    });
    expect(remote.remoteReadCount()).toBeGreaterThan(0);
  });

  it("emits <=1 MiB binary chunks with offsets, hashes and abort support", async () => {
    const remote = new InMemoryRemoteSyncV1({ now: () => 30_000 });
    const lease = await remote.acquireLease(source);
    const content = new Uint8Array(1024 * 1024 + 3);
    content.fill(65);
    const command = prepare(lease, [{
      path: ".harness/rules/large.md",
      content,
      content_hash: sha256Bytes(content),
      size: content.byteLength
    }]);
    const prepared = await remote.preparePush(command);
    if (prepared.outcome !== "new") throw new Error("prepare did not create");
    await remote.commitPush({
      prepare_id: prepared.value.prepare_id,
      lease,
      idempotency_key: command.idempotency_key,
      payload_hash: command.payload_hash
    });
    const snapshot = await remote.readRemoteSnapshot(source);
    const stream = remote.openContentStream(source, ".harness/rules/large.md", {
      snapshot_id: snapshot.snapshot_id,
      expected_revision: snapshot.revision
    });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(chunks.map((chunk) => chunk.bytes.byteLength)).toEqual([1024 * 1024, 3]);
    expect(chunks[0]?.chunk_hash).toBe(sha256Bytes(content.subarray(0, 1024 * 1024)));
    expect(chunks.at(-1)?.offset).toBe(1024 * 1024);

    const controller = new AbortController();
    controller.abort();
    await expect(async () => {
      for await (const chunk of remote.openContentStream(
        source,
        ".harness/rules/large.md",
        {
          signal: controller.signal,
          snapshot_id: snapshot.snapshot_id,
          expected_revision: snapshot.revision
        }
      )) { void chunk; }
    }).rejects.toMatchObject({ code: "SYNC_STREAM_ABORTED" });
  });

  it("fails closed for accessor-bearing lease and command objects", async () => {
    const remote = new InMemoryRemoteSyncV1({ now: () => 40_000 });
    const lease = await remote.acquireLease(source);
    const hostile = new Proxy(lease, {
      ownKeys() { throw new Error("proxy reflection must fail closed"); }
    });
    await expect(remote.preparePush(prepare(hostile))).rejects.toMatchObject({
      code: "SYNC_LEASE_INVALID"
    });
    const accessor = { ...lease };
    Object.defineProperty(accessor, "lease_token", {
      enumerable: true,
      get: () => { throw new Error("getter must not run"); }
    });
    await expect(remote.preparePush(prepare(accessor))).rejects.toMatchObject({
      code: "SYNC_LEASE_INVALID"
    });
    const operation = {
      path: ".harness/rules/a.md",
      content_kind: "rule" as const,
      action: "add" as const
    };
    Object.defineProperty(operation, "path", {
      enumerable: true,
      get: () => { throw new Error("operation getter must not run"); }
    });
    await expect(remote.preparePush({
      ...prepare(lease),
      idempotency_key: "push-hostile-operation",
      operations: [operation]
    })).rejects.toMatchObject({ code: "SYNC_STREAM_INVALID" });
  });

  it("surfaces commit ambiguity through status without replaying a second snapshot", async () => {
    const remote = new InMemoryRemoteSyncV1({ now: () => 50_000 });
    const lease = await remote.acquireLease(source);
    const command = prepare(lease);
    const prepared = await remote.preparePush(command);
    if (prepared.outcome !== "new") throw new Error("prepare did not create");
    remote.failNextCommitAfterPublish();

    await expect(remote.commitPush({
      prepare_id: prepared.value.prepare_id,
      lease,
      idempotency_key: command.idempotency_key,
      payload_hash: command.payload_hash
    })).rejects.toMatchObject({ code: "SYNC_COMMIT_AMBIGUOUS" });
    expect(await remote.getPushStatus({
      source,
      idempotency_key: command.idempotency_key
    })).toMatchObject({
      state: "unknown",
      receipt: expect.objectContaining({ project_version: expect.any(String) })
    });
    expect(remote.versionCount(source)).toBe(1);
  });

  it("does not create an empty remote version for an empty operation set", async () => {
    const remote = new InMemoryRemoteSyncV1({ now: () => 60_000 });
    const lease = await remote.acquireLease(source);
    const commandBase = {
      ...prepare(lease),
      idempotency_key: "push-empty",
      operations: []
    };
    const command = {
      ...commandBase,
      payload_hash: remoteSyncPushPayloadHash(commandBase)
    };
    const prepared = await remote.preparePush(command);
    if (prepared.outcome !== "new") throw new Error("prepare did not create");
    const result = await remote.commitPush({
      prepare_id: prepared.value.prepare_id,
      lease,
      idempotency_key: command.idempotency_key,
      payload_hash: command.payload_hash
    });
    expect(result).toMatchObject({ outcome: "new", value: { no_changes: true } });
    expect(remote.versionCount(source)).toBe(0);
  });

  it("fences forged lease expiry, prepared generation drift and active lease takeover", async () => {
    let now = 70_000;
    const remote = new InMemoryRemoteSyncV1({ now: () => now });
    const leaseA = await remote.acquireLease(source, { ttl_ms: 10 });
    await expect(remote.acquireLease({ ...source, actor_id: "act_other" })).rejects.toMatchObject({
      code: "SYNC_LEASE_BUSY"
    });
    await expect(remote.preparePush(prepare({
      ...leaseA,
      expires_at: new Date(now + 60_000).toISOString()
    }))).rejects.toMatchObject({ code: "SYNC_LEASE_FENCED" });

    const prepared = await remote.preparePush(prepare(leaseA));
    if (prepared.outcome !== "new") throw new Error("prepare did not create");
    now += 11;
    const leaseB = await remote.acquireLease(source);
    await expect(remote.commitPush({
      prepare_id: prepared.value.prepare_id,
      lease: leaseB,
      idempotency_key: "push-key-a",
      payload_hash: prepare(leaseA).payload_hash
    })).rejects.toMatchObject({ code: "SYNC_LEASE_FENCED" });
  });

  it("returns metadata-only snapshots and binds content streams to snapshot revision", async () => {
    const remote = new InMemoryRemoteSyncV1({ now: () => 80_000 });
    const lease = await remote.acquireLease(source);
    const command = prepare(lease);
    const prepared = await remote.preparePush(command);
    if (prepared.outcome !== "new") throw new Error("prepare did not create");
    await remote.commitPush({
      prepare_id: prepared.value.prepare_id,
      lease,
      idempotency_key: command.idempotency_key,
      payload_hash: command.payload_hash
    });
    const snapshot = await remote.readRemoteSnapshot(source);
    expect(snapshot.snapshot_id).toMatch(/^snapshot_/u);
    expect(snapshot.files[0]).not.toHaveProperty("content");
    await expect(async () => {
      for await (const chunk of remote.openContentStream(source, ".harness/rules/a.md", {
        snapshot_id: snapshot.snapshot_id,
        expected_revision: "999"
      })) { void chunk; }
    }).rejects.toMatchObject({ code: "SYNC_PREVIEW_STALE" });
    const chunks = [];
    for await (const chunk of remote.openContentStream(source, ".harness/rules/a.md", {
      snapshot_id: snapshot.snapshot_id,
      expected_revision: snapshot.revision
    })) chunks.push(chunk);
    expect(chunks).toHaveLength(1);
  });

  it("scopes status lookup by source and rejects inconsistent push payload hashes", async () => {
    const remote = new InMemoryRemoteSyncV1({ now: () => 90_000 });
    const lease = await remote.acquireLease(source);
    const command = prepare(lease);
    await expect(remote.preparePush({ ...command, payload_hash: sha256Bytes("not-the-body") }))
      .rejects.toMatchObject({ code: "SYNC_CONTENT_INVALID" });
    const prepared = await remote.preparePush(command);
    if (prepared.outcome !== "new") throw new Error("prepare did not create");
    expect(await remote.getPushStatus({
      source: { ...source, actor_id: "act_other" },
      idempotency_key: command.idempotency_key
    })).toBeNull();
    expect(await remote.getPushStatus({
      source,
      idempotency_key: command.idempotency_key
    })).toMatchObject({ prepare_id: prepared.value.prepare_id });
    expect(await remote.getPushStatus({
      source,
      idempotency_key: prepared.value.prepare_id
    })).toBeNull();
  });

  it("rolls back an applied local transaction when AbortSignal fires before commit", async () => {
    const remote = new InMemoryRemoteSyncV1({ now: () => 100_000 });
    const lease = await remote.acquireLease(source);
    const command = prepare(lease);
    const prepared = await remote.preparePush(command);
    if (prepared.outcome !== "new") throw new Error("prepare did not create");
    await remote.commitPush({
      prepare_id: prepared.value.prepare_id,
      lease,
      idempotency_key: command.idempotency_key,
      payload_hash: command.payload_hash
    });
    const controller = new AbortController();
    let committed = false;
    let rolledBack = false;
    const workspace = {
      beginPull: async () => ({
        apply: async () => { controller.abort(); return undefined; },
        commit: async () => { committed = true; return undefined; },
        rollback: async () => { rolledBack = true; }
      })
    };
    const module = new RemoteSyncV1Module(remote, workspace);
    await expect(module.pull({
      source,
      actor_id: source.actor_id,
      idempotency_key: "pull-abort"
    }, controller.signal)).rejects.toMatchObject({ code: "SYNC_STREAM_ABORTED" });
    expect(committed).toBe(false);
    expect(rolledBack).toBe(true);
  });

  it("enforces canonical content paths, text bounds and collision-safe idempotency keys", async () => {
    let now = 110_000;
    const remote = new InMemoryRemoteSyncV1({ now: () => now });
    const lease = await remote.acquireLease(source);
    const disallowed = file("notes.md", "not in the sync allowlist\n");
    await expect(remote.preparePush(prepare(lease, [disallowed]))).rejects.toMatchObject({
      code: "SYNC_PATH_NOT_ELIGIBLE"
    });

    const oversized: RemoteSyncWorkspaceFile = {
      path: ".harness/rules/large.md",
      content: new Uint8Array([65]),
      content_hash: sha256Bytes(new Uint8Array([65])),
      size: 64 * 1024 * 1024 + 1
    };
    await expect(remote.preparePush(prepare(lease, [oversized]))).rejects.toMatchObject({
      code: "SYNC_STREAM_TOO_LARGE"
    });

    const controlCommand = {
      ...prepare(lease),
      idempotency_key: "push\u0000key"
    };
    controlCommand.payload_hash = remoteSyncPushPayloadHash(controlCommand);
    await expect(remote.preparePush(controlCommand)).rejects.toMatchObject({
      code: "SYNC_STREAM_INVALID"
    });
    await expect(remote.acquireLease({ ...source, branch_name: "main\uD800" })).rejects.toMatchObject({
      code: "SYNC_LEASE_INVALID"
    });
    now += 1;
  });

  it("rejects hostile remote snapshots and stream iterators before consuming them", async () => {
    const remote = new InMemoryRemoteSyncV1({ now: () => 120_000 });
    const hostileSnapshot = new Proxy({}, {
      ownKeys() { throw new Error("snapshot ownKeys trap"); }
    });
    const hostileRemote = {
      readRemoteSnapshot: async () => hostileSnapshot,
      openContentStream: () => {
        throw new Error("stream must not be opened");
      },
      beginPull: remote.beginPull.bind(remote)
    } as never;
    const module = new RemoteSyncV1Module(hostileRemote, remote);
    await expect(module.pull({
      source,
      actor_id: source.actor_id,
      idempotency_key: "pull-hostile-snapshot"
    })).rejects.toMatchObject({ code: "SYNC_PULL_WORKSPACE_FAILED" });
  });

  it("rejects async-iterator accessors and Proxy streams without invoking traps", async () => {
    const remote = new InMemoryRemoteSyncV1({ now: () => 125_000 });
    const lease = await remote.acquireLease(source);
    const command = prepare(lease);
    const prepared = await remote.preparePush(command);
    if (prepared.outcome !== "new") throw new Error("prepare did not create");
    await remote.commitPush({
      prepare_id: prepared.value.prepare_id,
      lease,
      idempotency_key: command.idempotency_key,
      payload_hash: command.payload_hash
    });
    const getterStream = {};
    Object.defineProperty(getterStream, Symbol.asyncIterator, {
      enumerable: true,
      get: () => { throw new Error("async iterator getter"); }
    });
    const hostileRemote = {
      readRemoteSnapshot: remote.readRemoteSnapshot.bind(remote),
      openContentStream: () => getterStream
    } as never;
    const module = new RemoteSyncV1Module(hostileRemote, remote);
    await expect(module.pull({
      source,
      actor_id: source.actor_id,
      idempotency_key: "pull-hostile-stream"
    })).rejects.toMatchObject({ code: "SYNC_STREAM_INVALID" });
  });

  it("does not invoke remote or workspace port method accessors", async () => {
    const remote = new InMemoryRemoteSyncV1({ now: () => 126_000 });
    const lease = await remote.acquireLease(source);
    const command = prepare(lease);
    const prepared = await remote.preparePush(command);
    if (prepared.outcome !== "new") throw new Error("prepare did not create");
    await remote.commitPush({
      prepare_id: prepared.value.prepare_id,
      lease,
      idempotency_key: command.idempotency_key,
      payload_hash: command.payload_hash
    });

    let readGetterRuns = 0;
    const hostileReadRemote = {} as Record<string, unknown>;
    Object.defineProperty(hostileReadRemote, "readRemoteSnapshot", {
      enumerable: true,
      get: () => { readGetterRuns += 1; throw new Error("read getter must not run"); }
    });
    const moduleWithHostileRead = new RemoteSyncV1Module(
      hostileReadRemote as never,
      remote
    );
    await expect(moduleWithHostileRead.pull({
      source,
      actor_id: source.actor_id,
      idempotency_key: "pull-hostile-read-method"
    })).rejects.toMatchObject({ code: "SYNC_PULL_WORKSPACE_FAILED" });
    expect(readGetterRuns).toBe(0);

    let streamGetterRuns = 0;
    const hostileStreamRemote = {
      readRemoteSnapshot: remote.readRemoteSnapshot.bind(remote)
    } as Record<string, unknown>;
    Object.defineProperty(hostileStreamRemote, "openContentStream", {
      enumerable: true,
      get: () => { streamGetterRuns += 1; throw new Error("stream getter must not run"); }
    });
    const moduleWithHostileStream = new RemoteSyncV1Module(
      hostileStreamRemote as never,
      remote
    );
    await expect(moduleWithHostileStream.pull({
      source,
      actor_id: source.actor_id,
      idempotency_key: "pull-hostile-stream-method"
    })).rejects.toMatchObject({ code: "SYNC_STREAM_INVALID" });
    expect(streamGetterRuns).toBe(0);

    let beginGetterRuns = 0;
    const hostileWorkspace = {} as Record<string, unknown>;
    Object.defineProperty(hostileWorkspace, "beginPull", {
      enumerable: true,
      get: () => { beginGetterRuns += 1; throw new Error("begin getter must not run"); }
    });
    const moduleWithHostileWorkspace = new RemoteSyncV1Module(remote, hostileWorkspace as never);
    await expect(moduleWithHostileWorkspace.pull({
      source,
      actor_id: source.actor_id,
      idempotency_key: "pull-hostile-begin-method"
    })).rejects.toMatchObject({ code: "SYNC_PULL_WORKSPACE_FAILED" });
    expect(beginGetterRuns).toBe(0);

    let applyGetterRuns = 0;
    const hostileApplyWorkspace = {
      beginPull: async () => {
        const transaction = {
          commit: async () => undefined,
          rollback: async () => undefined
        } as Record<string, unknown>;
        Object.defineProperty(transaction, "apply", {
          enumerable: true,
          get: () => { applyGetterRuns += 1; throw new Error("apply getter must not run"); }
        });
        return transaction;
      }
    };
    await expect(new RemoteSyncV1Module(remote, hostileApplyWorkspace as never).pull({
      source,
      actor_id: source.actor_id,
      idempotency_key: "pull-hostile-apply-method"
    })).rejects.toMatchObject({ code: "SYNC_PULL_WORKSPACE_FAILED" });
    expect(applyGetterRuns).toBe(0);

    let commitGetterRuns = 0;
    const hostileCommitWorkspace = {
      beginPull: async () => {
        const transaction = {
          apply: async () => undefined,
          rollback: async () => undefined
        } as Record<string, unknown>;
        Object.defineProperty(transaction, "commit", {
          enumerable: true,
          get: () => { commitGetterRuns += 1; throw new Error("commit getter must not run"); }
        });
        return transaction;
      }
    };
    await expect(new RemoteSyncV1Module(remote, hostileCommitWorkspace as never).pull({
      source,
      actor_id: source.actor_id,
      idempotency_key: "pull-hostile-commit-method"
    })).rejects.toMatchObject({ code: "SYNC_PULL_WORKSPACE_FAILED" });
    expect(commitGetterRuns).toBe(0);

    let rollbackGetterRuns = 0;
    const hostileRollbackWorkspace = {
      beginPull: async () => {
        const transaction = {
          apply: async () => undefined,
          commit: async () => undefined
        } as Record<string, unknown>;
        Object.defineProperty(transaction, "rollback", {
          enumerable: true,
          get: () => { rollbackGetterRuns += 1; throw new Error("rollback getter must not run"); }
        });
        return transaction;
      }
    };
    await expect(new RemoteSyncV1Module(remote, hostileRollbackWorkspace as never).pull({
      source,
      actor_id: source.actor_id,
      idempotency_key: "pull-hostile-rollback-method"
    })).rejects.toMatchObject({ code: "SYNC_PULL_WORKSPACE_FAILED" });
    expect(rollbackGetterRuns).toBe(0);
  });

  it("does not execute Proxy Uint8Array traps before rejecting a stream chunk", async () => {
    const remote = new InMemoryRemoteSyncV1({ now: () => 127_000 });
    const lease = await remote.acquireLease(source);
    const command = prepare(lease);
    const prepared = await remote.preparePush(command);
    if (prepared.outcome !== "new") throw new Error("prepare did not create");
    await remote.commitPush({
      prepare_id: prepared.value.prepare_id,
      lease,
      idempotency_key: command.idempotency_key,
      payload_hash: command.payload_hash
    });
    const snapshot = await remote.readRemoteSnapshot(source);
    const plainBytes = new TextEncoder().encode("a\n");
    let prototypeTrapRuns = 0;
    const hostileBytes = new Proxy(plainBytes, {
      getPrototypeOf() { prototypeTrapRuns += 1; throw new Error("prototype trap must not run"); }
    });
    const hostileStreamRemote = {
      readRemoteSnapshot: remote.readRemoteSnapshot.bind(remote),
      openContentStream: () => ({
        [Symbol.asyncIterator]() {
          let done = false;
          return {
            next: async () => {
              if (done) return { done: true as const };
              done = true;
              return {
                done: false as const,
                value: {
                  sequence: 0,
                  offset: 0,
                  size: plainBytes.byteLength,
                  chunk_hash: sha256Bytes(plainBytes),
                  final: true,
                  bytes: hostileBytes
                }
              };
            }
          };
        }
      })
    } as never;
    const module = new RemoteSyncV1Module(hostileStreamRemote, remote);
    await expect(module.pull({
      source,
      actor_id: source.actor_id,
      idempotency_key: "pull-hostile-bytes"
    })).rejects.toMatchObject({ code: "SYNC_STREAM_INVALID" });
    expect(prototypeTrapRuns).toBe(0);
    void snapshot;
  });

  it("requires requested commit identity to match the snapshot identity", async () => {
    const remote = new InMemoryRemoteSyncV1({ now: () => 128_000 });
    const sourceWithCommit = { ...source, commit_sha: "commit_128" };
    const lease = await remote.acquireLease(sourceWithCommit);
    const command = prepare(lease);
    const prepared = await remote.preparePush(command);
    if (prepared.outcome !== "new") throw new Error("prepare did not create");
    await remote.commitPush({
      prepare_id: prepared.value.prepare_id,
      lease,
      idempotency_key: command.idempotency_key,
      payload_hash: command.payload_hash
    });
    const snapshot = await remote.readRemoteSnapshot(sourceWithCommit);
    const hostileRemote = {
      readRemoteSnapshot: async () => ({ ...snapshot, commit_sha: null }),
      openContentStream: remote.openContentStream.bind(remote)
    } as never;
    await expect(new RemoteSyncV1Module(hostileRemote, remote).pull({
      source: sourceWithCommit,
      actor_id: sourceWithCommit.actor_id,
      idempotency_key: "pull-null-commit"
    })).rejects.toMatchObject({ code: "SYNC_PREVIEW_STALE" });
  });

  it("rejects non-canonical numeric array keys", async () => {
    const remote = new InMemoryRemoteSyncV1({ now: () => 129_000 });
    const lease = await remote.acquireLease(source);
    const command = prepare(lease);
    Object.defineProperty(command.files, "01", { enumerable: true, value: command.files[0] });
    await expect(remote.preparePush(command)).rejects.toMatchObject({ code: "SYNC_STREAM_INVALID" });
  });

  it("rejects local transaction outcomes that overlap a path", async () => {
    const remote = new InMemoryRemoteSyncV1({ now: () => 129_500 });
    const lease = await remote.acquireLease(source);
    const command = prepare(lease);
    const prepared = await remote.preparePush(command);
    if (prepared.outcome !== "new") throw new Error("prepare did not create");
    await remote.commitPush({
      prepare_id: prepared.value.prepare_id,
      lease,
      idempotency_key: command.idempotency_key,
      payload_hash: command.payload_hash
    });
    const operation = {
      path: ".harness/rules/a.md",
      content_kind: "rule" as const,
      action: "add" as const
    };
    let rolledBack = false;
    const workspace = {
      beginPull: async () => ({
        apply: async () => ({ applied: [operation], skipped: [operation], retryable: [] }),
        commit: async () => undefined,
        rollback: async () => { rolledBack = true; }
      })
    };
    await expect(new RemoteSyncV1Module(remote, workspace).pull({
      source,
      actor_id: source.actor_id,
      idempotency_key: "pull-overlapping-outcome"
    })).rejects.toMatchObject({ code: "SYNC_PULL_WORKSPACE_FAILED" });
    expect(rolledBack).toBe(true);
  });

  it("includes immutable remote version identity in snapshots and pull receipts", async () => {
    const remote = new InMemoryRemoteSyncV1({ now: () => 130_000 });
    const lease = await remote.acquireLease({ ...source, commit_sha: "commit_130" });
    const command = prepare(lease);
    const prepared = await remote.preparePush(command);
    if (prepared.outcome !== "new") throw new Error("prepare did not create");
    await remote.commitPush({
      prepare_id: prepared.value.prepare_id,
      lease,
      idempotency_key: command.idempotency_key,
      payload_hash: command.payload_hash
    });
    const snapshot = await remote.readRemoteSnapshot({ ...source, commit_sha: "commit_130" });
    expect(snapshot).toMatchObject({
      commit_sha: "commit_130",
      artifact_id: expect.any(String),
      manifest_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)
    });
    const receipt = await new RemoteSyncV1Module(remote, remote).pull({
      source: { ...source, commit_sha: "commit_130" },
      actor_id: source.actor_id,
      idempotency_key: "pull-identity"
    });
    expect(receipt).toMatchObject({
      outcome: "new",
      value: {
        remote_revision: snapshot.revision,
        commit_sha: snapshot.commit_sha,
        artifact_id: snapshot.artifact_id,
        manifest_hash: snapshot.manifest_hash
      }
    });
  });
});
