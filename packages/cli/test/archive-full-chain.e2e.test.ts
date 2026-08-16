import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { putArchiveCas } from "../src/archive-production/cas-store.js";
import { createFsArchiveOutboxPort } from "../src/archive-production/fs-outbox-port.js";
import { createArchivePackageVerifier } from "../src/archive-production/production-ports.js";
import { runArchiveOutboxGc } from "../src/commands/archive-outbox-gc.js";

const encoder = new TextEncoder();
const H = (tag: string) => `sha256:${tag.repeat(64).slice(0, 64)}` as const;

describe("archive full chain e2e: build → CAS → enqueue → claim → publish → ack → gc (06B-3 W5)", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "archive-chain-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("completes the durable publish chain with real receipts", async () => {
    const core = await import("@hunter-harness/core");
    const {
      InMemoryArchivePackagePort, createArchivePackageBuilder, createArchiveOutbox,
      createArchiveRemoteAdapter, sha256Bytes, stableJson
    } = core as never as Record<string, never> as {
      InMemoryArchivePackagePort: new () => unknown;
      createArchivePackageBuilder: (deps: unknown) => { buildPackage: (...args: unknown[]) => Promise<{ package_bytes: Uint8Array; receipt: Record<string, unknown> }> };
      createArchiveOutbox: (deps: unknown) => {
        enqueue(input: unknown): Promise<Record<string, unknown>>;
        claim(entryId: string, owner: string, ttl: number): Promise<Record<string, unknown>>;
        ack(claim: unknown, receipt: unknown, policy: unknown): Promise<Record<string, unknown>>;
        nack(claim: unknown, reason: string, retryable: boolean): Promise<unknown>;
      };
      createArchiveRemoteAdapter: (deps: unknown) => {
        publishClaim(claim: unknown, sourceRef: unknown, policy: unknown): Promise<{ outcome: string; sync_receipt?: Record<string, unknown> }>;
      };
      sha256Bytes: (content: Uint8Array) => string;
      stableJson: (value: unknown) => string;
    };

    // 1) 构建确定性包（06B-1 真收据）
    const builder = createArchivePackageBuilder({
      port: new InMemoryArchivePackagePort(),
      clock: () => new Date("2026-08-16T10:00:00.000Z")
    });
    const opId = `archive_operation:${"a".repeat(64)}`;
    const summaryBytes = encoder.encode(`${stableJson({ schema_version: 1, summary: "done" })}\n`);
    const manifest = encoder.encode(`${stableJson({
      schema_version: 1,
      operation_id: opId,
      change_identity: "change-e2e",
      source_snapshot_hash: H("1"),
      files: [{
        path: "summary/change-summary.json",
        content_hash: sha256Bytes(summaryBytes),
        size_bytes: summaryBytes.byteLength
      }]
    })}\n`);
    const localReceipt = {
      schema_version: 1,
      operation_id: opId,
      change_identity: "change-e2e",
      closure_disposition: "completed",
      archive_intent: "record_only",
      source_snapshot_hash: H("1"),
      archive_schema_version: 1,
      archive_path: ".harness/archive/change-e2e",
      archive_manifest_hash: sha256Bytes(manifest),
      completed_at: "2026-08-16T09:00:00.000Z"
    };
    const files = { "archive-manifest.json": manifest, "summary/change-summary.json": summaryBytes };
    const inventory = {
      schema_version: 1,
      operation_id: localReceipt.operation_id,
      change_identity: localReceipt.change_identity,
      closure_disposition: localReceipt.closure_disposition,
      archive_intent: localReceipt.archive_intent,
      source_snapshot_hash: localReceipt.source_snapshot_hash,
      archive_schema_version: localReceipt.archive_schema_version,
      archive_path: localReceipt.archive_path,
      archive_manifest_hash: localReceipt.archive_manifest_hash,
      completed_at: localReceipt.completed_at,
      files: Object.entries(files).map(([path, content]) => ({
        path,
        content_hash: path === "archive-manifest.json" ? localReceipt.archive_manifest_hash : sha256Bytes(content),
        size_bytes: content.byteLength,
        read_content: async () => content.slice()
      }))
    };
    const projectionFiles: Record<string, Uint8Array> = {
      "candidates/knowledge.json": encoder.encode("[]\n"),
      "candidates/project-content.json": encoder.encode("[]\n"),
      "change-context.json": encoder.encode(`${stableJson({ schema_version: 1, change_key: "change-e2e" })}\n`),
      "spec/design.md": encoder.encode("# Design\n")
    };
    const projection = {
      schema_version: 2,
      project_id: "prj_e2e",
      project_version: "pv_e2e",
      archive_id: "arc_e2e",
      files: Object.entries(projectionFiles).map(([path, content]) => ({
        path,
        content_hash: sha256Bytes(content),
        size_bytes: content.byteLength,
        read_content: async () => content.slice()
      }))
    };
    const built = await builder.buildPackage(localReceipt, inventory, projection, 2);

    // 2) 字节入 CAS（mint 受信 ref）
    const ref = await putArchiveCas(root, built.package_bytes, { project_id: "prj_e2e" });
    expect(ref.package_sha256).toBe((built.receipt as { package_sha256: string }).package_sha256);

    // 3) 入队 durable outbox（FS port + 生产 verifier）
    const outbox = createArchiveOutbox({
      port: createFsArchiveOutboxPort({ projectRoot: root }),
      package_verifier: createArchivePackageVerifier({ projectRoot: root })
    });
    const record = await outbox.enqueue({ package_receipt: built.receipt, local_zip_ref: ref });
    expect(record.state).toBe("pending");

    // 4) claim + publish（stub publisher 返回 conforming stored 收据）
    const claim = await outbox.claim(record.entry_id as string, "cli:e2e", 300_000);
    const claimRecord = (claim as { record: Record<string, unknown> }).record;
    const { canonicalJson: canonicalJsonContract } = await import("@hunter-harness/contracts");
    const remoteIdempotency = sha256Bytes(new TextEncoder().encode(canonicalJsonContract({
      project_id: claimRecord.project_id,
      change_key: claimRecord.change_identity,
      archive_schema_version: claimRecord.archive_schema_version,
      package_sha256: claimRecord.package_sha256,
      archive_id: claimRecord.archive_id
    })));
    const storedReceipt = {
      request_id: claimRecord.request_id,
      idempotency_key: remoteIdempotency,
      project_id: "prj_e2e",
      archive_id: "arc_e2e",
      change_key: "change-e2e",
      package_sha256: ref.package_sha256,
      archive_status: "stored",
      project_version: "pv_7",
      stored_at: "2026-08-16T10:01:00.000Z",
      retryable: false
    };
    const adapter = createArchiveRemoteAdapter({
      outbox,
      zip_reader: {
        read: async (zipRef: typeof ref) => {
          const { createLocalArchiveZipResolver } = await import("../src/archive-production/cas-store.js");
          return createLocalArchiveZipResolver({ projectRoot: root }).resolve(zipRef, "prj_e2e");
        }
      },
      publisher: { publishArchive: async () => storedReceipt }
    });
    const sourceRef = {
      project_id: "prj_e2e", branch_name: "main", commit_sha: "c".repeat(40),
      client_id: "cli_e2e", change_key: "change-e2e"
    };
    const result = await adapter.publishClaim(claim, sourceRef, "retain");
    expect(result.outcome).toBe("stored");

    // 5) 终态断言：record acknowledged + 事件/收据绑定
    const after = await createFsArchiveOutboxPort({ projectRoot: root }).read(record.entry_id as string);
    expect((after as { state: string }).state).toBe("acknowledged");

    // 6) gc 回收 CAS（显式 entry）
    const out: string[] = [];
    const gcExit = await runArchiveOutboxGc({ entry: [record.entry_id as string], apply: true }, {
      cwd: root,
      stdout: (chunk: string) => { out.push(chunk); return true; },
      stderr: () => true
    });
    expect(gcExit).toBe(0);
    await expect(fs.access(join(root, ".harness", "state", "local", "archive-cas",
      `${ref.package_sha256.slice(7)}.zip`))).rejects.toThrow();
  });
});
