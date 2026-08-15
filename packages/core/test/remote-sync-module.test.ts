import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { sha256Bytes } from "../src/fs/hash.js";
import {
  InMemoryRemoteSyncPort,
  migrateLegacySyncFixture,
  RemoteSyncError,
  RemoteSyncModule,
  validateSyncOperation,
  type ContentFile,
  type SourceRef
} from "../src/remote-sync/index.js";

const source_ref: SourceRef = {
  project_id: "prj_sync",
  branch_name: "main",
  commit_sha: "abcdef123456",
  client_id: "cli_test"
};

function rule(path: string, content: string): ContentFile {
  return {
    path,
    content_kind: "rule",
    content_hash: sha256Bytes(content),
    size: Buffer.byteLength(content),
    content
  };
}

function branchFile(path: string, content: string): ContentFile {
  return {
    path,
    content_kind: "branch_file",
    content_hash: sha256Bytes(content),
    size: Buffer.byteLength(content),
    content
  };
}

function config(path: string, content: string): ContentFile {
  return {
    path,
    content_kind: "config",
    content_hash: sha256Bytes(content),
    size: Buffer.byteLength(content),
    content
  };
}

function confirmation(preview_hash: string, idempotency_key: string) {
  return { preview_hash, idempotency_key, conflict_decisions: [] };
}

describe("RemoteSyncModule v1", () => {
  it("uses a stable preview hash and emits the clean push conflict matrix", async () => {
    const port = new InMemoryRemoteSyncPort();
    port.seed(source_ref, {
      base_version: "pv_1",
      baseline_files: [
        rule(".harness/rules/delete.md", "delete\n"),
        rule(".harness/rules/local.md", "base local\n"),
        rule(".harness/rules/remote.md", "base remote\n"),
        rule(".harness/rules/conflict.md", "base conflict\n")
      ],
      local_files: [
        rule(".harness/rules/add.md", "add\n"),
        rule(".harness/rules/local.md", "local changed\n"),
        rule(".harness/rules/remote.md", "base remote\n"),
        rule(".harness/rules/conflict.md", "local conflict\n")
      ],
      remote_files: [
        rule(".harness/rules/delete.md", "delete\n"),
        rule(".harness/rules/local.md", "base local\n"),
        rule(".harness/rules/remote.md", "remote changed\n"),
        rule(".harness/rules/conflict.md", "remote conflict\n")
      ]
    });
    const module = new RemoteSyncModule(port);

    const first = await module.previewPush(["rules"], source_ref);
    const second = await module.previewPush(["rules"], source_ref);

    expect(second).toEqual(first);
    expect(first.preview_hash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(first.operations).toEqual([
      expect.objectContaining({ path: ".harness/rules/add.md", action: "add" }),
      expect.objectContaining({ path: ".harness/rules/delete.md", action: "delete" }),
      expect.objectContaining({ path: ".harness/rules/local.md", action: "modify" })
    ]);
    expect(first.conflicts).toEqual([
      expect.objectContaining({
        path: ".harness/rules/conflict.md",
        reason_code: "SYNC_CONTENT_CONFLICT"
      })
    ]);
    expect(first.operations.some((item) => item.path.endsWith("remote.md"))).toBe(false);
  });

  it("keeps an intentional local deletion on ordinary pull and binds explicit restore", async () => {
    const port = new InMemoryRemoteSyncPort();
    const deleted = rule(".harness/rules/deleted.md", "remote value\n");
    port.seed(source_ref, {
      base_version: "pv_1",
      baseline_files: [deleted],
      local_files: [],
      remote_files: [deleted]
    });
    const module = new RemoteSyncModule(port);
    const preview = await module.previewPull(["rules"], source_ref);

    expect(preview.operations).toEqual([
      expect.objectContaining({ path: deleted.path, action: "restore" })
    ]);
    const ordinary = await module.pull(
      ["rules"],
      source_ref,
      confirmation(preview.preview_hash, "pull-ordinary")
    );
    expect(ordinary.applied).toEqual([]);
    expect(ordinary.skipped).toEqual([
      expect.objectContaining({ path: deleted.path, action: "restore" })
    ]);
    expect(port.localFiles(source_ref)).toEqual([]);

    const restored = await module.pull(["rules"], source_ref, {
      ...confirmation(preview.preview_hash, "pull-restore"),
      conflict_decisions: [{
        path: deleted.path,
        resolution: "accept_remote",
        expected_preview_hash: preview.preview_hash,
        source_artifact_id: preview.remote_version?.artifact_id,
        source_project_version: preview.remote_version?.project_version
      }]
    });
    expect(restored.applied).toEqual([
      expect.objectContaining({ path: deleted.path, action: "restore" })
    ]);
    expect(port.localFiles(source_ref)).toEqual([deleted]);
  });

  it("applies the pull three-way matrix without overwriting local-only changes", async () => {
    const remoteAdd = rule(".harness/rules/a-remote-add.md", "remote add\n");
    const remoteDeleteBase = rule(".harness/rules/b-remote-delete.md", "delete base\n");
    const localOnlyBase = rule(".harness/rules/c-local-only.md", "local base\n");
    const remoteOnlyBase = rule(".harness/rules/d-remote-only.md", "remote base\n");
    const sameBase = rule(".harness/rules/e-same.md", "same base\n");
    const conflictBase = rule(".harness/rules/f-conflict.md", "conflict base\n");
    const localOnly = rule(localOnlyBase.path, "local changed\n");
    const remoteOnly = rule(remoteOnlyBase.path, "remote changed\n");
    const localConflict = rule(conflictBase.path, "local conflict\n");
    const remoteConflict = rule(conflictBase.path, "remote conflict\n");
    const port = new InMemoryRemoteSyncPort();
    port.seed(source_ref, {
      base_version: "pv_1",
      baseline_files: [
        remoteDeleteBase, localOnlyBase, remoteOnlyBase, sameBase, conflictBase
      ],
      local_files: [
        remoteDeleteBase, localOnly, remoteOnlyBase, sameBase, localConflict
      ],
      remote_files: [remoteAdd, localOnlyBase, remoteOnly, sameBase, remoteConflict]
    });
    const module = new RemoteSyncModule(port);
    const preview = await module.previewPull(["rules"], source_ref);

    expect(preview.operations).toEqual([
      expect.objectContaining({ path: remoteAdd.path, action: "add" }),
      expect.objectContaining({ path: remoteDeleteBase.path, action: "delete" }),
      expect.objectContaining({ path: remoteOnly.path, action: "modify" })
    ]);
    expect(preview.operations.some((item) => item.path === localOnly.path)).toBe(false);
    expect(preview.operations.some((item) => item.path === sameBase.path)).toBe(false);
    expect(preview.conflicts).toEqual([
      expect.objectContaining({
        path: conflictBase.path,
        reason_code: "SYNC_CONTENT_CONFLICT"
      })
    ]);
    const receipt = await module.pull(["rules"], source_ref, {
      ...confirmation(preview.preview_hash, "pull-matrix"),
      conflict_decisions: [{
        path: conflictBase.path,
        resolution: "keep_local",
        expected_preview_hash: preview.preview_hash
      }]
    });
    expect(receipt.applied).toEqual(preview.operations);
    expect(port.localFiles(source_ref)).toEqual([
      remoteAdd,
      localOnly,
      remoteOnly,
      sameBase,
      localConflict
    ]);
  });

  it("rejects stale confirmation after the locked view changes", async () => {
    const port = new InMemoryRemoteSyncPort();
    port.seed(source_ref, {
      local_files: [rule(".harness/rules/a.md", "local\n")],
      remote_files: []
    });
    const module = new RemoteSyncModule(port);
    const preview = await module.previewPush(["rules"], source_ref);
    port.setRemoteFiles(source_ref, [rule(".harness/rules/a.md", "concurrent\n")]);

    await expect(module.push(
      ["rules"], source_ref, confirmation(preview.preview_hash, "push-stale")
    )).rejects.toMatchObject({ code: "SYNC_PREVIEW_STALE", retryable: false });
    expect(port.versionCount(source_ref)).toBe(0);
  });

  it("does not create an empty version", async () => {
    const file = rule(".harness/rules/same.md", "same\n");
    const port = new InMemoryRemoteSyncPort();
    port.seed(source_ref, {
      base_version: "pv_1",
      baseline_files: [file],
      local_files: [file],
      remote_files: [file]
    });
    const module = new RemoteSyncModule(port);
    const preview = await module.previewPush(["rules"], source_ref);
    const receipt = await module.push(
      ["rules"], source_ref, confirmation(preview.preview_hash, "no-change")
    );

    expect(receipt.no_changes).toBe(true);
    expect(receipt.applied).toEqual([]);
    expect(port.versionCount(source_ref)).toBe(0);
  });

  it("deduplicates blobs across immutable branch snapshot versions", async () => {
    const shared = rule(".harness/rules/shared.md", "shared\n");
    const port = new InMemoryRemoteSyncPort();
    port.seed(source_ref, { local_files: [shared], remote_files: [] });
    const module = new RemoteSyncModule(port);

    const first = await module.previewPush(["rules"], source_ref);
    await module.push(["rules"], source_ref, confirmation(first.preview_hash, "push-1"));
    port.setLocalFiles(source_ref, [
      shared,
      rule(".harness/rules/second.md", "second\n")
    ]);
    const second = await module.previewPush(["rules"], source_ref);
    await module.push(["rules"], source_ref, confirmation(second.preview_hash, "push-2"));

    expect(port.versionCount(source_ref)).toBe(2);
    expect(port.blobCount(source_ref)).toBe(2);
    expect(port.snapshotStoresInlineContent(source_ref)).toBe(false);
  });

  it("returns the same receipt for an identical idempotent push and rejects key reuse", async () => {
    const port = new InMemoryRemoteSyncPort();
    port.seed(source_ref, {
      local_files: [rule(".harness/rules/a.md", "a\n")],
      remote_files: []
    });
    const module = new RemoteSyncModule(port);
    const preview = await module.previewPush(["rules"], source_ref);
    const input = confirmation(preview.preview_hash, "same-key");
    const first = await module.push(["rules"], source_ref, input);
    const repeated = await module.push(["rules"], source_ref, input);
    expect(repeated).toEqual(first);
    expect(await new RemoteSyncModule(port).push(
      ["rules"], source_ref, input
    )).toEqual(first);
    expect(await new RemoteSyncModule(port).getSyncStatus(source_ref)).toMatchObject({
      last_push: first
    });
    expect(port.versionCount(source_ref)).toBe(1);

    port.setLocalFiles(source_ref, [rule(".harness/rules/a.md", "different\n")]);
    const different = await module.previewPush(["rules"], source_ref);
    await expect(module.push(
      ["rules"], source_ref, confirmation(different.preview_hash, "same-key")
    )).rejects.toMatchObject({ code: "SYNC_IDEMPOTENCY_CONFLICT" });
  });

  it("derives an HTTP-safe opaque idempotency key from source identity", async () => {
    const sourceWithSpaces: SourceRef = {
      ...source_ref,
      branch_name: "feature branch"
    };
    const file = rule(".harness/rules/same.md", "same\n");
    const port = new InMemoryRemoteSyncPort();
    port.seed(sourceWithSpaces, {
      base_version: "pv_1",
      baseline_files: [file],
      local_files: [file],
      remote_files: [file]
    });
    const lookup = vi.spyOn(port, "getIdempotentSyncReceipt");
    const store = vi.spyOn(port, "storeIdempotentSyncReceipt");
    const module = new RemoteSyncModule(port);
    const preview = await module.previewPush(["rules"], sourceWithSpaces);

    await module.push(
      ["rules"],
      sourceWithSpaces,
      confirmation(preview.preview_hash, "caller key with spaces")
    );

    const keys = [
      ...lookup.mock.calls.map(([, , key]) => key),
      ...store.mock.calls.map(([, , key]) => key)
    ];
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toEqual(keys.map(() => expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)));
  });

  it("serializes concurrent retries with the same idempotency key to one receipt", async () => {
    const port = new InMemoryRemoteSyncPort();
    port.seed(source_ref, {
      local_files: [rule(".harness/rules/once.md", "once\n")],
      remote_files: []
    });
    const firstClient = new RemoteSyncModule(port);
    const secondClient = new RemoteSyncModule(port);
    const preview = await firstClient.previewPush(["rules"], source_ref);
    const input = confirmation(preview.preview_hash, "concurrent-same-key");

    const [first, second] = await Promise.all([
      firstClient.push(["rules"], source_ref, input),
      secondClient.push(["rules"], source_ref, input)
    ]);
    expect(second).toEqual(first);
    expect(port.versionCount(source_ref)).toBe(1);
  });

  it("publishes immutable archives idempotently and conflicts on a changed package hash", async () => {
    const port = new InMemoryRemoteSyncPort();
    const module = new RemoteSyncModule(port);
    const package_ref = {
      request_id: "550e8400-e29b-41d4-a716-446655440000",
      archive_id: "arc_stable_change_1",
      change_key: "change-1",
      archive_schema_version: 1,
      package_sha256: sha256Bytes("archive one"),
      content: new TextEncoder().encode("archive one")
    };
    const first = await module.publishArchive(
      package_ref, source_ref, package_ref.package_sha256
    );
    const repeated = await new RemoteSyncModule(port).publishArchive(
      package_ref, source_ref, package_ref.package_sha256
    );
    expect(repeated).toEqual(first);
    expect(repeated).not.toBe(first);
    expect(first).toMatchObject({
      archive_id: package_ref.archive_id,
      archive_status: "stored",
      retryable: false,
      change_key: "change-1"
    });
    expect(port.archiveCount(source_ref)).toBe(1);

    const changed = {
      ...package_ref,
      package_sha256: sha256Bytes("archive two"),
      content: new TextEncoder().encode("archive two")
    };
    await expect(new RemoteSyncModule(port).publishArchive(
      changed, source_ref, changed.package_sha256
    )).rejects.toMatchObject({ code: "ARCHIVE_PACKAGE_CONFLICT" });
    const keys = port.lastArchiveRequestKeys();
    expect(keys.request_keys).toHaveLength(3);
    expect(new Set(keys.request_keys).size).toBe(2);
    expect(keys.request_keys[0]).toBe(first.idempotency_key);
    expect(keys.logical_slots).toHaveLength(3);
    expect(new Set(keys.logical_slots).size).toBe(1);
  });

  it("rejects replaying the same immutable package under a different archive id", async () => {
    const port = new InMemoryRemoteSyncPort();
    const module = new RemoteSyncModule(port);
    const package_ref = {
      request_id: "550e8400-e29b-41d4-a716-446655440002",
      archive_id: "arc_stable_original",
      change_key: "change-stable-identity",
      archive_schema_version: 1,
      package_sha256: sha256Bytes("same immutable archive"),
      content: new TextEncoder().encode("same immutable archive")
    };
    await module.publishArchive(package_ref, source_ref, package_ref.package_sha256);

    await expect(new RemoteSyncModule(port).publishArchive(
      { ...package_ref, archive_id: "arc_stable_drifted" },
      source_ref,
      package_ref.package_sha256
    )).rejects.toMatchObject({ code: "ARCHIVE_PACKAGE_CONFLICT" });
    expect(port.archiveCount(source_ref)).toBe(1);
  });

  it.each([
    "request_id",
    "idempotency_key",
    "project_id",
    "archive_id",
    "change_key",
    "package_sha256"
  ] as const)("rejects a stored archive receipt whose %s does not match", async (field) => {
    const port = new InMemoryRemoteSyncPort();
    const package_ref = {
      request_id: "550e8400-e29b-41d4-a716-446655440099",
      archive_id: "arc_stable_mismatch",
      change_key: "change-mismatch",
      archive_schema_version: 1,
      package_sha256: sha256Bytes("archive mismatch"),
      content: new TextEncoder().encode("archive mismatch")
    };
    port.tamperNextArchiveReceipt(field);
    const module = new RemoteSyncModule(port);
    await expect(module.publishArchive(
      package_ref, source_ref, package_ref.package_sha256
    )).rejects.toMatchObject({ code: "ARCHIVE_RECEIPT_MISMATCH" });

    const recovered = await module.publishArchive(
      package_ref, source_ref, package_ref.package_sha256
    );
    expect(recovered).toMatchObject({
      request_id: package_ref.request_id,
      project_id: source_ref.project_id,
      change_key: package_ref.change_key,
      package_sha256: package_ref.package_sha256,
      archive_status: "stored",
      retryable: false
    });
  });

  it("rejects non-plain, accessor, missing, and extra archive package fields", async () => {
    const bytes = new TextEncoder().encode("archive invalid shape");
    const valid = {
      request_id: "550e8400-e29b-41d4-a716-446655440003",
      archive_id: "arc_stable_invalid_shape",
      change_key: "change-invalid-shape",
      archive_schema_version: 1,
      package_sha256: sha256Bytes(bytes),
      content: bytes
    };
    const accessor = { ...valid } as Record<string, unknown>;
    Object.defineProperty(accessor, "archive_id", {
      enumerable: true,
      get: () => { throw new Error("must not invoke archive_id getter"); }
    });
    const missing = { ...valid } as Partial<typeof valid>;
    delete missing.archive_id;
    const invalid = [
      Object.assign(Object.create({}), valid),
      accessor,
      missing,
      { ...valid, unexpected: true },
      { ...valid, [Symbol("unexpected")]: true },
      new Proxy(valid, {
        ownKeys: () => { throw new Error("hostile ownKeys trap"); }
      })
    ];

    for (const packageRef of invalid) {
      await expect(new RemoteSyncModule(new InMemoryRemoteSyncPort()).publishArchive(
        packageRef as never,
        source_ref,
        valid.package_sha256
      )).rejects.toMatchObject({ code: "ARCHIVE_PACKAGE_INVALID" });
    }
  });

  it("keeps archive identity immutable after a retryable failure", async () => {
    const port = new InMemoryRemoteSyncPort();
    port.failNextArchive();
    const package_ref = {
      request_id: "550e8400-e29b-41d4-a716-446655440004",
      archive_id: "arc_stable_failed",
      change_key: "change-failed-identity",
      archive_schema_version: 1,
      package_sha256: sha256Bytes("archive failed identity"),
      content: new TextEncoder().encode("archive failed identity")
    };
    const failed = await new RemoteSyncModule(port).publishArchive(
      package_ref, source_ref, package_ref.package_sha256
    );
    expect(failed).toMatchObject({
      archive_id: package_ref.archive_id,
      archive_status: "failed"
    });
    await expect(new RemoteSyncModule(port).publishArchive(
      { ...package_ref, archive_id: "arc_stable_failed_drift" },
      source_ref,
      package_ref.package_sha256
    )).rejects.toMatchObject({ code: "ARCHIVE_PACKAGE_CONFLICT" });
  });

  it("defends cached sync and archive receipts from caller mutation", async () => {
    const file = rule(".harness/rules/immutable-receipt.md", "immutable\n");
    const port = new InMemoryRemoteSyncPort();
    port.seed(source_ref, { local_files: [file], remote_files: [] });
    const module = new RemoteSyncModule(port);
    const preview = await module.previewPush(["rules"], source_ref);
    const input = confirmation(preview.preview_hash, "immutable-sync-receipt");
    const first = await module.push(["rules"], source_ref, input);
    const firstApplied = first.applied[0];
    const previewOperation = preview.operations[0];
    if (firstApplied === undefined || previewOperation === undefined) {
      throw new Error("expected applied operation");
    }
    firstApplied.path = ".harness/rules/polluted.md";
    firstApplied.source_path = ".harness/rules/polluted-source.md";
    first.skipped.push({ ...previewOperation, path: "polluted-skipped" });
    first.retryable.push({ ...previewOperation, path: "polluted-retryable" });
    const replay = await module.push(["rules"], source_ref, input);
    expect(replay).not.toBe(first);
    expect(replay.applied).toEqual(preview.operations);
    expect(replay.skipped).toEqual([]);
    expect(replay.retryable).toEqual([]);

    const package_ref = {
      request_id: "550e8400-e29b-41d4-a716-446655440098",
      archive_id: "arc_stable_immutable_receipt",
      change_key: "change-immutable-receipt",
      archive_schema_version: 1,
      package_sha256: sha256Bytes("archive immutable"),
      content: new TextEncoder().encode("archive immutable")
    };
    const archive = await module.publishArchive(
      package_ref, source_ref, package_ref.package_sha256
    );
    archive.project_id = "prj_polluted";
    archive.change_key = "polluted";
    const archiveReplay = await new RemoteSyncModule(port).publishArchive(
      package_ref, source_ref, package_ref.package_sha256
    );
    expect(archiveReplay).not.toBe(archive);
    expect(archiveReplay).toMatchObject({
      project_id: source_ref.project_id,
      change_key: package_ref.change_key
    });
  });

  it("rolls back every local file when a pull transaction fails", async () => {
    const first = rule(".harness/rules/a.md", "old a\n");
    const second = rule(".harness/rules/b.md", "old b\n");
    const port = new InMemoryRemoteSyncPort();
    port.seed(source_ref, {
      base_version: "pv_1",
      baseline_files: [first, second],
      local_files: [first, second],
      remote_files: [
        rule(first.path, "new a\n"),
        rule(second.path, "new b\n")
      ]
    });
    port.failPullAfterApply(1);
    const module = new RemoteSyncModule(port);
    const preview = await module.previewPull(["rules"], source_ref);
    const receipt = await module.pull(
      ["rules"], source_ref, confirmation(preview.preview_hash, "pull-fail")
    );

    expect(receipt).toMatchObject({
      no_changes: false,
      applied: [],
      reason_code: "PULL_TRANSACTION_FAILED"
    });
    expect(receipt.retryable).toHaveLength(2);
    expect(port.localFiles(source_ref)).toEqual([first, second]);
  });

  it("detects rename and validates both source and target policy", async () => {
    const content = "renamed\n";
    const port = new InMemoryRemoteSyncPort();
    port.seed(source_ref, {
      base_version: "pv_1",
      baseline_files: [rule(".harness/rules/old.md", content)],
      local_files: [rule(".harness/rules/new.md", content)],
      remote_files: [rule(".harness/rules/old.md", content)]
    });
    const module = new RemoteSyncModule(port);
    const preview = await module.previewPush(["rules"], source_ref);
    expect(preview.operations).toEqual([{
      path: ".harness/rules/new.md",
      source_path: ".harness/rules/old.md",
      content_kind: "rule",
      action: "rename",
      local_hash: sha256Bytes(content),
      remote_hash: undefined,
      base_hash: sha256Bytes(content)
    }]);

    expect(validateSyncOperation({
      ...preview.operations[0], action: "modify"
    })).toMatchObject({ ok: false, reason_code: "SYNC_OPERATION_SOURCE_PATH_FORBIDDEN" });
    expect(validateSyncOperation({
      ...preview.operations[0], source_path: undefined
    })).toMatchObject({ ok: false, reason_code: "SYNC_RENAME_SOURCE_REQUIRED" });
    expect(validateSyncOperation({
      ...preview.operations[0], source_path: ".harness/knowledge/private.md"
    })).toMatchObject({ ok: false, reason_code: "SYNC_PATH_NOT_ELIGIBLE" });
  });

  it("binds a Pull rename local hash to the source file", async () => {
    const content = "renamed remotely\n";
    const oldFile = rule(".harness/rules/old.md", content);
    const port = new InMemoryRemoteSyncPort();
    port.seed(source_ref, {
      base_version: "pv_1",
      baseline_files: [oldFile],
      local_files: [oldFile],
      remote_files: [rule(".harness/rules/new.md", content)]
    });

    const preview = await new RemoteSyncModule(port).previewPull(["rules"], source_ref);

    expect(preview.operations).toEqual([{
      path: ".harness/rules/new.md",
      source_path: ".harness/rules/old.md",
      content_kind: "rule",
      action: "rename",
      local_hash: oldFile.content_hash,
      remote_hash: oldFile.content_hash,
      base_hash: oldFile.content_hash
    }]);
  });

  it("requires branch_file to be an explicit source and never relies on mtime", async () => {
    const port = new InMemoryRemoteSyncPort();
    port.seed(source_ref, {
      local_files: [branchFile("src/feature.txt", "branch\n")],
      remote_files: []
    });
    const module = new RemoteSyncModule(port);
    const preview = await module.previewPush(["branch_files"], source_ref);
    expect(preview.operations).toEqual([
      expect.objectContaining({
        path: "src/feature.txt",
        content_kind: "branch_file",
        action: "add"
      })
    ]);
    expect(JSON.stringify(preview)).not.toMatch(/mtime|modified_at/iu);
  });

  it("skips content scanning only for config while hard-blocking credentials in rules", async () => {
    const secret = "Authorization: Bearer secret-token-value-1234567890";
    const configPort = new InMemoryRemoteSyncPort();
    configPort.seed(source_ref, {
      local_files: [config(".harness/project.yaml", secret)],
      remote_files: []
    });
    const configModule = new RemoteSyncModule(configPort);
    const configPreview = await configModule.previewPush(["config"], source_ref);
    expect(configPreview.security_scan).toMatchObject({
      blocked: false,
      findings: []
    });

    const rulePort = new InMemoryRemoteSyncPort();
    rulePort.seed(source_ref, {
      local_files: [rule(".harness/rules/secret.md", secret)],
      remote_files: []
    });
    const ruleModule = new RemoteSyncModule(rulePort);
    const preview = await ruleModule.previewPush(["rules"], source_ref);
    expect(preview.security_scan).toMatchObject({ blocked: true, hard_blocked: true });
    const finding = preview.security_scan.findings[0];
    if (finding === undefined) throw new Error("expected security finding");
    await expect(ruleModule.push(["rules"], source_ref, {
      ...confirmation(preview.preview_hash, "hard-secret"),
      scan_confirmation: {
        expected_preview_hash: preview.preview_hash,
        overrides: [{
          finding_fingerprint: finding.fingerprint,
          actor: "test",
          reason: "must remain non-overridable"
        }]
      }
    })).rejects.toMatchObject({ code: "SYNC_SENSITIVE_CONTENT_BLOCKED" });
    expect(rulePort.versionCount(source_ref)).toBe(0);
  });

  it("binds an overridable sensitive finding authorization to preview_hash", async () => {
    const port = new InMemoryRemoteSyncPort();
    port.seed(source_ref, {
      local_files: [rule(".harness/rules/review.md", "password=supersecret\n")],
      remote_files: []
    });
    const module = new RemoteSyncModule(port);
    const preview = await module.previewPush(["rules"], source_ref);
    expect(preview.security_scan).toMatchObject({
      blocked: true,
      hard_blocked: false,
      review_required: true
    });
    await expect(module.push(
      ["rules"], source_ref, confirmation(preview.preview_hash, "review-missing")
    )).rejects.toMatchObject({ code: "SYNC_SENSITIVE_CONTENT_BLOCKED" });
    const finding = preview.security_scan.findings[0];
    if (finding === undefined) throw new Error("expected review finding");
    const override = {
      finding_fingerprint: finding.fingerprint,
      actor: "reviewer",
      reason: "fixture credential is synthetic"
    };
    await expect(module.push(["rules"], source_ref, {
      ...confirmation(preview.preview_hash, "review-wrong-hash"),
      scan_confirmation: {
        expected_preview_hash: sha256Bytes("wrong preview"),
        overrides: [override]
      }
    })).rejects.toMatchObject({ code: "SYNC_PREVIEW_HASH_MISMATCH" });

    const receipt = await module.push(["rules"], source_ref, {
      ...confirmation(preview.preview_hash, "review-authorized"),
      scan_confirmation: {
        expected_preview_hash: preview.preview_hash,
        overrides: [override]
      }
    });
    expect(receipt.applied).toEqual(preview.operations);
    expect(port.versionCount(source_ref)).toBe(1);
  });

  it("does not block a credential that a push conflict decision keeps remote", async () => {
    const path = ".harness/rules/not-uploaded.md";
    const port = new InMemoryRemoteSyncPort();
    port.seed(source_ref, {
      base_version: "pv_1",
      baseline_files: [rule(path, "base\n")],
      local_files: [rule(
        path,
        "Authorization: Bearer secret-token-value-1234567890"
      )],
      remote_files: [rule(path, "safe remote change\n")]
    });
    const module = new RemoteSyncModule(port);
    const preview = await module.previewPush(["rules"], source_ref);
    expect(preview.security_scan.hard_blocked).toBe(true);
    const receipt = await module.push(["rules"], source_ref, {
      ...confirmation(preview.preview_hash, "keep-safe-remote"),
      conflict_decisions: [{
        path,
        resolution: "accept_remote",
        expected_preview_hash: preview.preview_hash
      }]
    });
    expect(receipt.applied).toEqual([]);
    expect(receipt.skipped).toEqual([
      expect.objectContaining({ path, action: "modify" })
    ]);
    expect(port.versionCount(source_ref)).toBe(0);
  });

  it("paginates snapshots, versions and immutable files in stable order", async () => {
    const port = new InMemoryRemoteSyncPort();
    const module = new RemoteSyncModule(port);
    port.seed(source_ref, {
      local_files: [rule(".harness/rules/b.md", "b\n"), rule(".harness/rules/a.md", "a\n")],
      remote_files: []
    });
    const first = await module.previewPush(["rules"], source_ref);
    const receipt = await module.push(
      ["rules"], source_ref, confirmation(first.preview_hash, "page-v1")
    );
    const feature = { ...source_ref, branch_name: "feature", commit_sha: "fedcba654321" };
    port.seed(feature, { local_files: [rule(".harness/rules/c.md", "c\n")], remote_files: [] });
    const featurePreview = await module.previewPush(["rules"], feature);
    await module.push(
      ["rules"], feature, confirmation(featurePreview.preview_hash, "page-v2")
    );

    const branches1 = await module.listBranchSnapshots(
      { project_id: source_ref.project_id }, undefined, 1
    );
    const branches2 = await module.listBranchSnapshots(
      { project_id: source_ref.project_id }, branches1.next_cursor, 1
    );
    expect([...branches1.items, ...branches2.items]).toHaveLength(2);
    expect(branches1.next_cursor).not.toContain("main");

    const versions = await module.listSnapshotVersions(
      { project_id: source_ref.project_id, branch_name: "main" }, undefined, 10
    );
    expect(versions.items).toHaveLength(1);
    const artifact_id = receipt.artifact_id;
    if (artifact_id === undefined) throw new Error("artifact id missing from push receipt");
    const files1 = await module.listSnapshotFiles(
      { project_id: source_ref.project_id, artifact_id }, undefined, 1
    );
    const files2 = await module.listSnapshotFiles(
      { project_id: source_ref.project_id, artifact_id }, files1.next_cursor, 1
    );
    expect([...files1.items, ...files2.items].map((file) => file.path)).toEqual([
      ".harness/rules/a.md", ".harness/rules/b.md"
    ]);
    expect(await module.getSnapshotFile(
      { project_id: source_ref.project_id, artifact_id },
      ".harness/rules/a.md"
    )).toMatchObject({ path: ".harness/rules/a.md" });
  });

  it("keeps remote failures retryable without mutating a successful local state", async () => {
    const file = rule(".harness/rules/local.md", "local\n");
    const port = new InMemoryRemoteSyncPort();
    port.seed(source_ref, { local_files: [file], remote_files: [] });
    port.failNextPush(new RemoteSyncError("REMOTE_UNAVAILABLE", true));
    const module = new RemoteSyncModule(port);
    const preview = await module.previewPush(["rules"], source_ref);
    const receipt = await module.push(
      ["rules"], source_ref, confirmation(preview.preview_hash, "push-offline")
    );

    expect(receipt.reason_code).toBe("REMOTE_UNAVAILABLE");
    expect(receipt.retryable).toEqual(preview.operations);
    expect(port.localFiles(source_ref)).toEqual([file]);
    expect(port.versionCount(source_ref)).toBe(0);
  });

  it("rolls back a push snapshot and CAS when atomic receipt storage fails", async () => {
    const port = new InMemoryRemoteSyncPort();
    port.seed(source_ref, {
      local_files: [rule(".harness/rules/atomic.md", "atomic\n")],
      remote_files: []
    });
    port.failPushAfterSnapshot();
    const module = new RemoteSyncModule(port);
    const preview = await module.previewPush(["rules"], source_ref);
    const receipt = await module.push(
      ["rules"], source_ref, confirmation(preview.preview_hash, "push-atomic-fail")
    );

    expect(receipt.reason_code).toBe("REMOTE_PUBLISH_FAILED");
    expect(receipt.retryable).toEqual(preview.operations);
    expect(port.versionCount(source_ref)).toBe(0);
    expect(port.blobCount(source_ref)).toBe(0);
  });

  it("returns a retryable lock failure without mutating local or remote state", async () => {
    const file = rule(".harness/rules/lock.md", "lock\n");
    const port = new InMemoryRemoteSyncPort();
    port.seed(source_ref, { local_files: [file], remote_files: [] });
    const module = new RemoteSyncModule(port);
    const preview = await module.previewPush(["rules"], source_ref);
    port.failNextLock();
    const receipt = await module.push(
      ["rules"], source_ref, confirmation(preview.preview_hash, "lock-fail")
    );

    expect(receipt).toMatchObject({
      reason_code: "SYNC_LOCK_UNAVAILABLE",
      applied: []
    });
    expect(receipt.retryable).toEqual(preview.operations);
    expect(port.localFiles(source_ref)).toEqual([file]);
    expect(port.versionCount(source_ref)).toBe(0);
  });

  it("does not downgrade a port compare-and-swap stale error to remote failure", async () => {
    const port = new InMemoryRemoteSyncPort();
    port.seed(source_ref, {
      local_files: [rule(".harness/rules/cas.md", "cas\n")],
      remote_files: []
    });
    const module = new RemoteSyncModule(port);
    const preview = await module.previewPush(["rules"], source_ref);
    port.failNextPush(new RemoteSyncError("SYNC_PREVIEW_STALE"));
    await expect(module.push(
      ["rules"], source_ref, confirmation(preview.preview_hash, "cas-stale")
    )).rejects.toMatchObject({ code: "SYNC_PREVIEW_STALE" });
    expect(port.versionCount(source_ref)).toBe(0);
  });

  it("returns a retryable archive failure and succeeds on the unchanged retry", async () => {
    const port = new InMemoryRemoteSyncPort();
    port.seed(source_ref, {
      base_version: "pv_7",
      local_files: [],
      remote_files: []
    });
    port.failNextArchive();
    const package_ref = {
      request_id: "550e8400-e29b-41d4-a716-446655440001",
      archive_id: "arc_stable_retry",
      change_key: "change-retry",
      archive_schema_version: 1,
      package_sha256: sha256Bytes("archive retry"),
      content: new TextEncoder().encode("archive retry")
    };
    const module = new RemoteSyncModule(port);
    const failed = await module.publishArchive(
      package_ref, source_ref, package_ref.package_sha256
    );
    expect(failed).toMatchObject({
      archive_status: "failed",
      retryable: true,
      reason_code: "REMOTE_UNAVAILABLE",
      project_version: "pv_7"
    });
    expect(port.archiveCount(source_ref)).toBe(0);

    const succeeded = await module.publishArchive(
      package_ref, source_ref, package_ref.package_sha256
    );
    expect(succeeded).toMatchObject({ archive_status: "stored", retryable: false });
    expect(port.archiveCount(source_ref)).toBe(1);
  });

  it("retries a transient remote failure with the same idempotency identity", async () => {
    const port = new InMemoryRemoteSyncPort();
    port.seed(source_ref, {
      local_files: [rule(".harness/rules/retry.md", "retry\n")],
      remote_files: []
    });
    const module = new RemoteSyncModule(port);
    const preview = await module.previewPush(["rules"], source_ref);
    const input = confirmation(preview.preview_hash, "retry-key");
    port.failNextPush(new RemoteSyncError("REMOTE_UNAVAILABLE", true));

    const failed = await module.push(["rules"], source_ref, input);
    expect(failed.retryable).toEqual(preview.operations);
    const succeeded = await module.push(["rules"], source_ref, input);
    expect(succeeded.retryable).toEqual([]);
    expect(succeeded.applied).toEqual(preview.operations);
    expect(port.versionCount(source_ref)).toBe(1);
  });

  it("serializes two clients and rejects the second confirmation after the first commit", async () => {
    const port = new InMemoryRemoteSyncPort();
    port.seed(source_ref, {
      local_files: [rule(".harness/rules/race.md", "race\n")],
      remote_files: []
    });
    const module = new RemoteSyncModule(port);
    const preview = await module.previewPush(["rules"], source_ref);
    const outcomes = await Promise.allSettled([
      module.push(["rules"], source_ref, confirmation(preview.preview_hash, "race-a")),
      module.push(["rules"], source_ref, confirmation(preview.preview_hash, "race-b"))
    ]);

    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: "SYNC_PREVIEW_STALE" })
      })
    ]);
    expect(port.versionCount(source_ref)).toBe(1);
  });

  it("requires an explicit per-path decision when both sides changed", async () => {
    const base = rule(".harness/rules/conflict.md", "base\n");
    const port = new InMemoryRemoteSyncPort();
    port.seed(source_ref, {
      base_version: "pv_1",
      baseline_files: [base],
      local_files: [rule(base.path, "local\n")],
      remote_files: [rule(base.path, "remote\n")]
    });
    const module = new RemoteSyncModule(port);
    const preview = await module.previewPush(["rules"], source_ref);
    await expect(module.push(
      ["rules"], source_ref, confirmation(preview.preview_hash, "conflict-missing")
    )).rejects.toMatchObject({ code: "SYNC_CONFLICT_DECISION_REQUIRED" });

    const receipt = await module.push(["rules"], source_ref, {
      ...confirmation(preview.preview_hash, "conflict-local"),
      conflict_decisions: [{
        path: base.path,
        resolution: "keep_local",
        expected_preview_hash: preview.preview_hash
      }]
    });
    expect(receipt.applied).toEqual([
      expect.objectContaining({ path: base.path, action: "modify" })
    ]);
  });

  it("rejects duplicate or unrelated conflict decisions", async () => {
    const base = rule(".harness/rules/decision.md", "base\n");
    const port = new InMemoryRemoteSyncPort();
    port.seed(source_ref, {
      base_version: "pv_1",
      baseline_files: [base],
      local_files: [rule(base.path, "local\n")],
      remote_files: [rule(base.path, "remote\n")]
    });
    const module = new RemoteSyncModule(port);
    const preview = await module.previewPush(["rules"], source_ref);
    const decision = {
      path: base.path,
      resolution: "keep_local" as const,
      expected_preview_hash: preview.preview_hash
    };
    await expect(module.push(["rules"], source_ref, {
      ...confirmation(preview.preview_hash, "duplicate-decision"),
      conflict_decisions: [decision, decision]
    })).rejects.toMatchObject({ code: "SYNC_CONFLICT_DECISION_INVALID" });
    await expect(module.push(["rules"], source_ref, {
      ...confirmation(preview.preview_hash, "unrelated-decision"),
      conflict_decisions: [{ ...decision, path: ".harness/rules/other.md" }]
    })).rejects.toMatchObject({ code: "SYNC_CONFLICT_DECISION_INVALID" });
  });

  it("keeps historical file details bound to artifact_id rather than latest", async () => {
    const path = ".harness/rules/history.md";
    const oldFile = rule(path, "old\n");
    const port = new InMemoryRemoteSyncPort();
    port.seed(source_ref, { local_files: [oldFile], remote_files: [] });
    const module = new RemoteSyncModule(port);
    const oldPreview = await module.previewPush(["rules"], source_ref);
    const oldReceipt = await module.push(
      ["rules"], source_ref, confirmation(oldPreview.preview_hash, "history-old")
    );
    const newFile = rule(path, "new\n");
    port.setLocalFiles(source_ref, [newFile]);
    const newPreview = await module.previewPush(["rules"], source_ref);
    const newReceipt = await module.push(
      ["rules"], source_ref, confirmation(newPreview.preview_hash, "history-new")
    );
    if (oldReceipt.artifact_id === undefined || newReceipt.artifact_id === undefined) {
      throw new Error("history receipts require artifact ids");
    }

    expect((await module.getSnapshotFile({
      project_id: source_ref.project_id,
      artifact_id: oldReceipt.artifact_id
    }, path))?.content_hash).toBe(oldFile.content_hash);
    expect((await module.getSnapshotFile({
      project_id: source_ref.project_id,
      artifact_id: newReceipt.artifact_id
    }, path))?.content_hash).toBe(newFile.content_hash);
  });

  it("records a deletion tombstone in the new snapshot and keeps the old version readable", async () => {
    const deleted = rule(".harness/rules/deleted-history.md", "historic\n");
    const port = new InMemoryRemoteSyncPort();
    port.seed(source_ref, { local_files: [deleted], remote_files: [] });
    const module = new RemoteSyncModule(port);
    const firstPreview = await module.previewPush(["rules"], source_ref);
    const first = await module.push(
      ["rules"], source_ref, confirmation(firstPreview.preview_hash, "delete-history-v1")
    );
    port.setLocalFiles(source_ref, []);
    const deletePreview = await module.previewPush(["rules"], source_ref);
    const second = await module.push(
      ["rules"], source_ref, confirmation(deletePreview.preview_hash, "delete-history-v2")
    );
    if (first.artifact_id === undefined || second.artifact_id === undefined) {
      throw new Error("deletion history requires artifact ids");
    }

    expect(await module.getSnapshotFile({
      project_id: source_ref.project_id,
      artifact_id: first.artifact_id
    }, deleted.path)).toMatchObject({
      content_hash: deleted.content_hash,
      action: "add"
    });
    expect(await module.getSnapshotFile({
      project_id: source_ref.project_id,
      artifact_id: second.artifact_id
    }, deleted.path)).toMatchObject({
      content_hash: deleted.content_hash,
      action: "delete"
    });
  });

  it("returns fixed error codes for invalid pagination and snapshot identity", async () => {
    const port = new InMemoryRemoteSyncPort();
    const module = new RemoteSyncModule(port);
    await expect(module.listBranchSnapshots(
      { project_id: source_ref.project_id }, undefined, 0
    )).rejects.toMatchObject({ code: "SYNC_PAGE_LIMIT_INVALID" });
    await expect(module.listSnapshotVersions(
      { project_id: source_ref.project_id, branch_name: "main" }, undefined, 1.5
    )).rejects.toMatchObject({ code: "SYNC_PAGE_LIMIT_INVALID" });
    await expect(module.listSnapshotFiles(
      { project_id: source_ref.project_id, artifact_id: "art_any" },
      undefined,
      Number.MAX_SAFE_INTEGER + 1
    )).rejects.toMatchObject({ code: "SYNC_PAGE_LIMIT_INVALID" });
    expect(port.paginationCallCount()).toBe(0);
    await expect(module.listBranchSnapshots(
      { project_id: source_ref.project_id }, "not-a-cursor", 1
    )).rejects.toMatchObject({ code: "SYNC_CURSOR_INVALID" });
    await expect(module.getSnapshotFile({
      project_id: source_ref.project_id,
      artifact_id: "art_missing"
    }, ".harness/rules/a.md")).rejects.toMatchObject({
      code: "SYNC_SNAPSHOT_NOT_FOUND"
    });
  });

  it("rejects duplicate and case-colliding canonical paths", async () => {
    const duplicate = rule(".harness/rules/a.md", "one\n");
    const port = new InMemoryRemoteSyncPort();
    port.seed(source_ref, {
      local_files: [duplicate, rule(duplicate.path, "two\n")],
      remote_files: []
    });
    await expect(new RemoteSyncModule(port).previewPush(
      ["rules"], source_ref
    )).rejects.toMatchObject({ code: "SYNC_PATH_COLLISION" });

    const casePort = new InMemoryRemoteSyncPort();
    casePort.seed(source_ref, {
      local_files: [
        rule(".harness/rules/A.md", "one\n"),
        rule(".harness/rules/a.md", "two\n")
      ],
      remote_files: []
    });
    await expect(new RemoteSyncModule(casePort).previewPush(
      ["rules"], source_ref
    )).rejects.toMatchObject({ code: "SYNC_PATH_COLLISION" });
  });

  it("preserves the explicit unmarked branch from the current v1 fixture", async () => {
    const fixture = JSON.parse(await readFile(
      new URL("./fixtures/remote-sync-v1-current.json", import.meta.url), "utf8"
    )) as {
      source_ref: SourceRef;
      base_version: string;
      baseline_files: ContentFile[];
      local_files: ContentFile[];
      remote_files: ContentFile[];
    };
    const port = new InMemoryRemoteSyncPort();
    port.seed(fixture.source_ref, fixture);
    const module = new RemoteSyncModule(port);
    const preview = await module.previewPush(["rules"], fixture.source_ref);
    expect(preview.source_ref.branch_name).toBe("unmarked");
    expect(preview.conflicts).toEqual([
      expect.objectContaining({ reason_code: "SYNC_CONTENT_CONFLICT" })
    ]);
  });

  it("migrates a parsed v0 fixture without branch_name to explicit unmarked", async () => {
    const raw: unknown = JSON.parse(await readFile(
      new URL("./fixtures/remote-sync-v0-legacy.json", import.meta.url), "utf8"
    ));
    const migrated = migrateLegacySyncFixture(raw);
    expect(migrated).toMatchObject({
      source_ref: {
        project_id: "prj_legacy",
        branch_name: "unmarked",
        commit_sha: "deadbeef12345678",
        client_id: "cli_legacy"
      },
      base_version: "pv_legacy"
    });
    expect(migrated.source_ref.branch_name).not.toBe("main");
    const port = new InMemoryRemoteSyncPort();
    port.seed(migrated.source_ref, migrated);
    expect((await new RemoteSyncModule(port).previewPush(
      ["rules"], migrated.source_ref
    )).source_ref).toEqual(migrated.source_ref);
    expect(() => migrateLegacySyncFixture({
      schema_version: 0,
      source_ref: { project_id: "prj_legacy", client_id: "cli_legacy" },
      base_version: "pv_legacy",
      baseline_files: [],
      local_files: [],
      remote_files: []
    })).toThrow(expect.objectContaining({ code: "SYNC_LEGACY_FIXTURE_INVALID" }));
  });

  it("publishes the stable archive id from the current archive fixture", async () => {
    const fixture = JSON.parse(await readFile(
      new URL("./fixtures/remote-sync-archive-v1-current.json", import.meta.url), "utf8"
    )) as {
      source_ref: SourceRef;
      package_ref: Omit<Parameters<RemoteSyncModule["publishArchive"]>[0], "content"> & {
        content_utf8: string;
      };
    };
    const { content_utf8, ...identity } = fixture.package_ref;
    const content = new TextEncoder().encode(content_utf8);
    const receipt = await new RemoteSyncModule(new InMemoryRemoteSyncPort()).publishArchive(
      { ...identity, content }, fixture.source_ref, fixture.package_ref.package_sha256
    );
    expect(receipt.archive_id).toBe("arc_fixture_stable");
  });

  it("fails closed for a legacy archive fixture that cannot prove archive id", async () => {
    const fixture = JSON.parse(await readFile(
      new URL("./fixtures/remote-sync-archive-v0-legacy.json", import.meta.url), "utf8"
    )) as {
      source_ref: SourceRef;
      package_ref: Record<string, unknown> & { content_utf8: string; package_sha256: string };
    };
    const { content_utf8, ...legacyIdentity } = fixture.package_ref;
    await expect(new RemoteSyncModule(new InMemoryRemoteSyncPort()).publishArchive(
      { ...legacyIdentity, content: new TextEncoder().encode(content_utf8) } as never,
      fixture.source_ref,
      fixture.package_ref.package_sha256
    )).rejects.toMatchObject({ code: "ARCHIVE_PACKAGE_INVALID" });
  });
});
