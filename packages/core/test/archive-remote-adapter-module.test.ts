import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  canonicalJson,
  readArchiveIngestReceipt,
  type ArchiveIngestReceipt
} from "@hunter-harness/contracts";

import {
  InMemoryArchiveOutboxPort,
  createArchiveOutbox,
  stableHash as outboxStableHash,
  type ArchiveOutbox,
  type ArchiveOutboxClaim
} from "../src/archive-outbox/index.js";
import {
  sha256Bytes,
  stableHash as packageStableHash,
  type ArchivePackageReceipt
} from "../src/archive-package-builder/index.js";
import {
  createArchiveRemoteAdapter,
  normalizeArchiveRemoteRequest
} from "../src/archive-remote-adapter/index.js";
import { archiveRemoteValidationInternals, snapshotArchiveRemotePublishResult } from
  "../src/archive-remote-adapter/validation.js";
import {
  InMemoryRemoteSyncPort,
  RemoteSyncModule
} from "../src/remote-sync/index.js";
import type { ArchiveSyncReceipt } from "../src/remote-sync/types.js";

const storedAt = "2026-08-13T12:00:00.000Z";

async function packageReceipt(bytes: Uint8Array): Promise<ArchivePackageReceipt> {
  const fixture = JSON.parse(await readFile(new URL(
    "./fixtures/archive-package-builder-v2-current.json",
    import.meta.url
  ), "utf8")) as ArchivePackageReceipt;
  const { receipt_hash: ignored, ...body } = fixture;
  void ignored;
  const current = {
    ...body,
    package_sha256: sha256Bytes(bytes),
    package_size_bytes: bytes.byteLength
  };
  return { ...current, receipt_hash: packageStableHash(current) };
}

async function claimedPackage(bytes = new TextEncoder().encode("immutable archive bytes")): Promise<{
  readonly outbox: ArchiveOutbox;
  readonly claim: ArchiveOutboxClaim;
  readonly bytes: Uint8Array;
}> {
  const receipt = await packageReceipt(bytes);
  const port = new InMemoryArchiveOutboxPort({
    clock: () => new Date("2026-08-13T11:00:00.000Z")
  });
  const package_verifier = {
    async verify(input: { package_receipt: ArchivePackageReceipt; local_zip_ref: {
      ref_id: string; package_sha256: `sha256:${string}`; size_bytes: number;
    } }) {
      const expected_immutable_identity = outboxStableHash(input);
      const body = {
        schema_version: 1 as const,
        verdict: "verified" as const,
        package_operation_id: input.package_receipt.package_operation_id,
        receipt_hash: input.package_receipt.receipt_hash,
        package_sha256: input.package_receipt.package_sha256,
        manifest_sha256: input.package_receipt.manifest_sha256,
        local_zip_ref_id: input.local_zip_ref.ref_id,
        local_zip_size_bytes: input.local_zip_ref.size_bytes,
        expected_immutable_identity,
        verified_at: "2026-08-13T10:30:00.000Z"
      };
      const evidence_hash = outboxStableHash(body);
      return {
        ...body,
        evidence_hash,
        verification_id: `archive_outbox_package_verification:${evidence_hash.slice(7)}` as const
      };
    }
  };
  const outbox = createArchiveOutbox({ port, package_verifier });
  const record = await outbox.enqueue({
    package_receipt: receipt,
    local_zip_ref: {
      ref_id: "local_zip:remote-alpha",
      package_sha256: receipt.package_sha256,
      size_bytes: bytes.byteLength
    }
  });
  return { outbox, claim: await outbox.claim(record.entry_id, "worker-alpha", 60_000), bytes };
}

function ingestReceipt(claim: ArchiveOutboxClaim,
  overrides: Partial<ArchiveSyncReceipt> = {}): ArchiveSyncReceipt {
  const remoteIdempotency = sha256Bytes(new TextEncoder().encode(canonicalJson({
    project_id: claim.record.project_id,
    change_key: claim.record.change_identity,
    archive_schema_version: claim.record.archive_schema_version,
    package_sha256: claim.record.package_sha256,
    archive_id: claim.record.archive_id
  })));
  return {
    request_id: claim.record.request_id,
    idempotency_key: remoteIdempotency,
    project_id: claim.record.project_id,
    change_key: claim.record.change_identity,
    archive_id: claim.record.archive_id,
    package_sha256: claim.record.package_sha256,
    archive_status: "stored",
    project_version: "pv_remote_1",
    stored_at: storedAt,
    retryable: false,
    ...overrides
  };
}

async function canonicalPlatformReceipt(
  claim: ArchiveOutboxClaim,
  branch: "queued" | "planning_failed"
): Promise<ArchiveIngestReceipt> {
  const fixture = JSON.parse(await readFile(new URL(
    "../../contracts/test/fixtures/content-sync-v1-current.json", import.meta.url
  ), "utf8")) as { archive_ingest_receipts: Record<string, ArchiveIngestReceipt> };
  const canonical = structuredClone(fixture.archive_ingest_receipts[branch]);
  if (canonical === undefined) throw new Error(`canonical fixture missing ${branch}`);
  const receipt = {
    ...canonical,
    request_id: claim.record.request_id,
    idempotency_key: claim.record.idempotency_key,
    project_id: claim.record.project_id,
    change_key: claim.record.change_identity,
    archive_id: claim.record.archive_id,
    package_sha256: claim.record.package_sha256,
    manifest_sha256: claim.record.manifest_sha256,
    project_version: "pv_remote_1",
    stored_at: storedAt,
    archive_status: { status: "stored" as const, updated_at: storedAt, retryable: false as const }
  };
  const parsed = readArchiveIngestReceipt(JSON.stringify(receipt));
  if (!parsed.ok) throw new Error(parsed.reason_code);
  return parsed.value;
}

describe("ArchiveRemoteAdapter", () => {
  it("publishes a claimed package and acknowledges only a strictly bound durable ingest receipt", async () => {
    const setup = await claimedPackage();
    const calls: unknown[][] = [];
    const adapter = createArchiveRemoteAdapter({
      outbox: setup.outbox,
      zip_reader: { async read() { return setup.bytes.slice(); } },
      publisher: { async publishArchive(...args: unknown[]) {
        calls.push(args);
        return JSON.stringify(await canonicalPlatformReceipt(setup.claim, "queued"));
      } }
    });

    const result = await adapter.publishClaim(setup.claim, {
      project_id: setup.claim.record.project_id,
      branch_name: "main",
      commit_sha: "abc123",
      client_id: "cli_alpha",
      change_key: setup.claim.record.change_identity
    }, "cleanup_after_durable_ack");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([{
      request_id: setup.claim.record.request_id,
      archive_id: setup.claim.record.archive_id,
      change_key: setup.claim.record.change_identity,
      archive_schema_version: 1,
      package_sha256: setup.claim.record.package_sha256,
      content: setup.bytes
    }, {
      project_id: setup.claim.record.project_id,
      branch_name: "main",
      commit_sha: "abc123",
      client_id: "cli_alpha",
      change_key: setup.claim.record.change_identity
    }, setup.claim.record.package_sha256]);
    expect(result).toMatchObject({
      outcome: "stored",
      sync_receipt: {
        request_id: setup.claim.record.request_id,
        archive_status: "stored",
        retryable: false
      },
      cleanup_intent: { disposition: "cleanup_allowed" }
    });
    expect(Object.keys(result.sync_receipt).sort()).toEqual([
      "archive_id", "archive_status", "change_key", "idempotency_key", "package_sha256",
      "project_id", "project_version", "request_id", "retryable", "stored_at"
    ]);
    expect((await setup.outbox.inspect(setup.claim.entry_id, "retain")).record.state)
      .toBe("acknowledged");
  });

  it("uses the real RemoteSyncModule success path, preserves archive_id, then acknowledges cleanup", async () => {
    const setup = await claimedPackage();
    const port = new InMemoryRemoteSyncPort();
    const source_ref = {
      project_id: setup.claim.record.project_id,
      branch_name: "main",
      commit_sha: "abc123",
      client_id: "cli_alpha",
      change_key: setup.claim.record.change_identity
    };
    port.seed(source_ref, { local_files: [], remote_files: [], baseline_files: [] });
    const adapter = createArchiveRemoteAdapter({
      outbox: setup.outbox,
      zip_reader: { async read() { return setup.bytes; } },
      publisher: new RemoteSyncModule(port)
    });

    await expect(adapter.publishClaim(setup.claim, source_ref, "retain"))
      .resolves.toMatchObject({ outcome: "stored", sync_receipt: {
        archive_id: setup.claim.record.archive_id, archive_status: "stored"
      }, ack: { record: { state: "acknowledged", archive_id: setup.claim.record.archive_id } },
      cleanup_intent: { disposition: "retain", local_zip_ref: setup.claim.record.local_zip_ref } });
    expect(port.archiveCount(source_ref)).toBe(1);
  });

  it("nacks retryable Platform failures and never emits cleanup intent", async () => {
    const setup = await claimedPackage();
    const adapter = createArchiveRemoteAdapter({
      outbox: setup.outbox,
      zip_reader: { async read() { return setup.bytes; } },
      publisher: { async publishArchive() {
        return ingestReceipt(setup.claim, {
          archive_status: "failed",
          retryable: true,
          reason_code: "REMOTE_UNAVAILABLE"
        });
      } }
    });
    const result = await adapter.publishClaim(setup.claim, {
      project_id: setup.claim.record.project_id, branch_name: "main", commit_sha: "abc123",
      client_id: "cli_alpha", change_key: setup.claim.record.change_identity
    }, "cleanup_after_durable_ack");

    expect(result).toMatchObject({ outcome: "retry_scheduled", reason_code: "REMOTE_UNAVAILABLE",
      cleanup_intent: null, nack: { record: { state: "retry_wait" } } });
    expect((await setup.outbox.inspect(setup.claim.entry_id, "cleanup_after_durable_ack")))
      .toMatchObject({ retention: { disposition: "retain" }, record: { durable_receipt: null } });
  });

  it("maps thrown publication failures to retryable nack while preserving the local package", async () => {
    const setup = await claimedPackage();
    let reads = 0;
    const adapter = createArchiveRemoteAdapter({
      outbox: setup.outbox,
      zip_reader: { async read() { reads += 1; return setup.bytes; } },
      publisher: { async publishArchive() { throw new Error("offline"); } }
    });
    const result = await adapter.publishClaim(setup.claim, {
      project_id: setup.claim.record.project_id, branch_name: "main", commit_sha: "abc123",
      client_id: "cli_alpha", change_key: setup.claim.record.change_identity
    }, "cleanup_after_durable_ack");
    expect({ reads, result }).toMatchObject({ reads: 1, result: {
      outcome: "retry_scheduled", reason_code: "REMOTE_UNAVAILABLE", cleanup_intent: null
    } });
  });

  it("fails closed on tampered ZIP bytes before publication", async () => {
    const setup = await claimedPackage();
    let publishes = 0;
    const adapter = createArchiveRemoteAdapter({
      outbox: setup.outbox,
      zip_reader: { async read() { return new TextEncoder().encode("tampered"); } },
      publisher: { async publishArchive() { publishes += 1; return ingestReceipt(setup.claim); } }
    });
    const result = await adapter.publishClaim(setup.claim, {
      project_id: setup.claim.record.project_id, branch_name: "main", commit_sha: "abc123",
      client_id: "cli_alpha", change_key: setup.claim.record.change_identity
    }, "cleanup_after_durable_ack");
    expect({ publishes, result }).toMatchObject({ publishes: 0, result: {
      outcome: "dead_letter", reason_code: "ARCHIVE_ZIP_INVALID", cleanup_intent: null
    } });
  });

  it("does not execute receipt getters and rejects identity drift without cleanup", async () => {
    for (const receiptFactory of [
      (claim: ArchiveOutboxClaim) => ({ ...ingestReceipt(claim), project_id: "prj_other" }),
      () => {
        let value = 0;
        return Object.defineProperty({ getterCount: () => value }, "schema_version", {
          enumerable: true, get() { value += 1; throw new Error("getter"); }
        });
      }
    ]) {
      const setup = await claimedPackage();
      const raw = receiptFactory(setup.claim);
      const adapter = createArchiveRemoteAdapter({
        outbox: setup.outbox,
        zip_reader: { async read() { return setup.bytes; } },
        publisher: { async publishArchive() { return raw; } }
      });
      const result = await adapter.publishClaim(setup.claim, {
        project_id: setup.claim.record.project_id, branch_name: "main", commit_sha: "abc123",
        client_id: "cli_alpha", change_key: setup.claim.record.change_identity
      }, "cleanup_after_durable_ack");
      expect(result).toMatchObject({ outcome: "dead_letter",
        reason_code: "ARCHIVE_INGEST_RECEIPT_INVALID", cleanup_intent: null });
      if ("getterCount" in raw) expect(raw.getterCount()).toBe(0);
    }
  });

  it("keeps cancellation side-effect free and legacy requests read-only", async () => {
    const setup = await claimedPackage();
    let reads = 0;
    let publishes = 0;
    const adapter = createArchiveRemoteAdapter({ outbox: setup.outbox,
      zip_reader: { async read() { reads += 1; return setup.bytes; } },
      publisher: { async publishArchive() { publishes += 1; return ingestReceipt(setup.claim); } } });
    expect(adapter.declineUpload()).toEqual({ outcome: "cancelled", local_archive_unchanged: true,
      cleanup_intent: null });
    expect({ reads, publishes }).toEqual({ reads: 0, publishes: 0 });
    const legacy = JSON.parse(await readFile(new URL(
      "./fixtures/archive-remote-adapter-v0-legacy.json", import.meta.url
    ), "utf8")) as unknown;
    expect(normalizeArchiveRemoteRequest(legacy)).toMatchObject({ ok: true,
      source_schema_version: 0, readiness: "legacy_read_only" });
    expect(normalizeArchiveRemoteRequest({ schema_version: 2 })).toEqual({ ok: false,
      reason_code: "ARCHIVE_REMOTE_REQUEST_VERSION_UNSUPPORTED" });
  });

  it("accepts ordinary branch and commit source identities while preserving exact Change binding", async () => {
    const setup = await claimedPackage();
    const source_ref = { project_id: setup.claim.record.project_id,
      branch_name: "feature/archive-upload", commit_sha: "refs/heads/feature/archive-upload@abc123",
      client_id: "cli_alpha", change_key: setup.claim.record.change_identity };
    const result = normalizeArchiveRemoteRequest({ schema_version: 1, claim: setup.claim,
      source_ref, retention_policy: "retain" });
    expect(result).toMatchObject({ ok: true, source_schema_version: 1, readiness: "ready",
      source_ref });
  });

  it("rejects descriptor-hostile claims before ZIP, publication, clock, or storage access", async () => {
    const setup = await claimedPackage();
    let getters = 0;
    let reads = 0;
    let publishes = 0;
    const adapter = createArchiveRemoteAdapter({ outbox: setup.outbox,
      zip_reader: { async read() { reads += 1; return setup.bytes; } },
      publisher: { async publishArchive() { publishes += 1; return ingestReceipt(setup.claim); } } });
    const hostile = Object.defineProperty({}, "entry_id", { enumerable: true,
      get() { getters += 1; throw new Error("claim getter"); } });
    await expect(adapter.publishClaim(hostile as never, {
      project_id: setup.claim.record.project_id, branch_name: "main", commit_sha: "abc123",
      client_id: "cli_alpha", change_key: setup.claim.record.change_identity
    }, "retain")).rejects.toMatchObject({ code: "ARCHIVE_REMOTE_CLAIM_INVALID" });
    expect({ getters, reads, publishes }).toEqual({ getters: 0, reads: 0, publishes: 0 });
    expect((await setup.outbox.inspect(setup.claim.entry_id, "retain")).record.state).toBe("leased");
  });

  it("acknowledges durable storage when canonical Platform background planning failed", async () => {
    const setup = await claimedPackage();
    const adapter = createArchiveRemoteAdapter({ outbox: setup.outbox,
      zip_reader: { async read() { return setup.bytes; } },
      publisher: { async publishArchive() {
        return JSON.stringify(await canonicalPlatformReceipt(setup.claim, "planning_failed"));
      } } });
    await expect(adapter.publishClaim(setup.claim, {
      project_id: setup.claim.record.project_id, branch_name: "main", commit_sha: "abc123",
      client_id: "cli_alpha", change_key: setup.claim.record.change_identity
    }, "cleanup_after_durable_ack")).resolves.toMatchObject({ outcome: "stored",
      cleanup_intent: { disposition: "cleanup_allowed" } });
  });

  it("accepts Gregorian RFC3339 offsets without comparing the literal date to UTC", async () => {
    const setup = await claimedPackage();
    const adapter = createArchiveRemoteAdapter({ outbox: setup.outbox,
      zip_reader: { async read() { return setup.bytes; } },
      publisher: { async publishArchive() { return ingestReceipt(setup.claim, {
        stored_at: "2026-08-13T00:30:00+08:00"
      }); } } });
    await expect(adapter.publishClaim(setup.claim, {
      project_id: setup.claim.record.project_id, branch_name: "main", commit_sha: "abc123",
      client_id: "cli_alpha", change_key: setup.claim.record.change_identity
    }, "retain")).resolves.toMatchObject({ outcome: "stored",
      sync_receipt: { stored_at: "2026-08-13T00:30:00+08:00" } });
  });

  it("replays the same durable receipt after a crash between publication and outbox ack", async () => {
    const setup = await claimedPackage();
    const receipt = ingestReceipt(setup.claim);
    let publishes = 0;
    const publisher = { async publishArchive() { publishes += 1; return receipt; } };
    const crashingOutbox = { ...setup.outbox,
      async ack() { throw new Error("process crashed before local ack"); } };
    const firstProcess = createArchiveRemoteAdapter({ outbox: crashingOutbox,
      zip_reader: { async read() { return setup.bytes; } }, publisher });
    const source_ref = { project_id: setup.claim.record.project_id, branch_name: "main",
      commit_sha: "abc123", client_id: "cli_alpha", change_key: setup.claim.record.change_identity };
    await expect(firstProcess.publishClaim(setup.claim, source_ref, "cleanup_after_durable_ack"))
      .rejects.toThrow("process crashed before local ack");

    const restarted = createArchiveRemoteAdapter({ outbox: setup.outbox,
      zip_reader: { async read() { return setup.bytes; } }, publisher });
    await expect(restarted.publishClaim(setup.claim, source_ref, "cleanup_after_durable_ack"))
      .resolves.toMatchObject({ outcome: "stored", cleanup_intent: { disposition: "cleanup_allowed" } });
    expect(publishes).toBe(2);
  });

  it("rejects an ack Port result that forges the acknowledged record and cleanup authority", async () => {
    const setup = await claimedPackage();
    const forgedOutbox = { ...setup.outbox, async ack() {
      return {
        record: { ...setup.claim.record, state: "leased", generation: 999 },
        retention: {
          schema_version: 1,
          entry_id: setup.claim.entry_id,
          record_generation: 999,
          disposition: "cleanup_allowed",
          reason_code: "OUTBOX_DURABLE_ACKNOWLEDGED",
          local_zip_ref: { ref_id: "local_zip:attacker", package_sha256: setup.claim.record.package_sha256,
            size_bytes: setup.bytes.byteLength },
          evaluated_at: storedAt
        }
      };
    } };
    const adapter = createArchiveRemoteAdapter({ outbox: forgedOutbox,
      zip_reader: { async read() { return setup.bytes; } },
      publisher: { async publishArchive() { return ingestReceipt(setup.claim); } } });
    await expect(adapter.publishClaim(setup.claim, {
      project_id: setup.claim.record.project_id, branch_name: "main", commit_sha: "abc123",
      client_id: "cli_alpha", change_key: setup.claim.record.change_identity
    }, "cleanup_after_durable_ack")).rejects.toMatchObject({
      code: "ARCHIVE_REMOTE_OUTBOX_TRANSITION_INVALID"
    });
  });

  it("maps a real Stage02 failed ArchiveSyncReceipt to retryable nack", async () => {
    const setup = await claimedPackage();
    const source_ref = { project_id: setup.claim.record.project_id, branch_name: "main",
      commit_sha: "abc123", client_id: "cli_alpha", change_key: setup.claim.record.change_identity };
    const port = new InMemoryRemoteSyncPort();
    port.seed(source_ref, { local_files: [], remote_files: [], baseline_files: [] });
    port.failNextArchive();
    const adapter = createArchiveRemoteAdapter({ outbox: setup.outbox,
      zip_reader: { async read() { return setup.bytes; } }, publisher: new RemoteSyncModule(port) });
    await expect(adapter.publishClaim(setup.claim, source_ref, "cleanup_after_durable_ack"))
      .resolves.toMatchObject({ outcome: "retry_scheduled", reason_code: "REMOTE_UNAVAILABLE",
        cleanup_intent: null, nack: { record: { state: "retry_wait" } } });
  });

  it("rejects a nack Port result that forges dead-letter state and generation", async () => {
    const setup = await claimedPackage();
    const forgedOutbox = { ...setup.outbox, async nack() {
      return { record: { ...setup.claim.record, state: "dead_letter", generation: 999 }, retry_at: null };
    } };
    const adapter = createArchiveRemoteAdapter({ outbox: forgedOutbox,
      zip_reader: { async read() { return setup.bytes; } },
      publisher: { async publishArchive() { throw new Error("offline"); } } });
    await expect(adapter.publishClaim(setup.claim, {
      project_id: setup.claim.record.project_id, branch_name: "main", commit_sha: "abc123",
      client_id: "cli_alpha", change_key: setup.claim.record.change_identity
    }, "cleanup_after_durable_ack")).rejects.toMatchObject({
      code: "ARCHIVE_REMOTE_OUTBOX_TRANSITION_INVALID"
    });
  });

  it("does not execute nested transition record getters from ack or nack Ports", async () => {
    for (const operation of ["ack", "nack"] as const) {
      const setup = await claimedPackage();
      let getters = 0;
      const record = structuredClone(setup.claim.record) as Record<string, unknown>;
      Object.defineProperty(record, "state", { enumerable: true,
        get() { getters += 1; throw new Error("transition getter"); } });
      const outbox = operation === "ack"
        ? { ...setup.outbox, async ack() { return { record, retention: {} }; } }
        : { ...setup.outbox, async nack() { return { record, retry_at: null }; } };
      const adapter = createArchiveRemoteAdapter({ outbox,
        zip_reader: { async read() { return setup.bytes; } },
        publisher: { async publishArchive() {
          if (operation === "nack") throw new Error("offline");
          return ingestReceipt(setup.claim);
        } } });
      await expect(adapter.publishClaim(setup.claim, {
        project_id: setup.claim.record.project_id, branch_name: "main", commit_sha: "abc123",
        client_id: "cli_alpha", change_key: setup.claim.record.change_identity
      }, "cleanup_after_durable_ack")).rejects.toMatchObject({
        code: "ARCHIVE_REMOTE_OUTBOX_TRANSITION_INVALID"
      });
      expect(getters).toBe(0);
    }
  });

  it("accepts a strict Stage02 stored receipt without inventing 06A job fields", async () => {
    const setup = await claimedPackage();
    const stage02 = ingestReceipt(setup.claim);
    const adapter = createArchiveRemoteAdapter({ outbox: setup.outbox,
      zip_reader: { async read() { return setup.bytes; } },
      publisher: { async publishArchive() { return stage02; } } });
    await expect(adapter.publishClaim(setup.claim, {
      project_id: setup.claim.record.project_id, branch_name: "main", commit_sha: "abc123",
      client_id: "cli_alpha", change_key: setup.claim.record.change_identity
    }, "retain")).resolves.toMatchObject({ outcome: "stored",
      sync_receipt: { archive_status: "stored" } });
  });

  it("propagates ack and nack failures without emitting a forged result", async () => {
    for (const operation of ["ack", "nack"] as const) {
      const setup = await claimedPackage();
      const outbox = operation === "ack"
        ? { ...setup.outbox, async ack() { throw new Error("ack port failed"); } }
        : { ...setup.outbox, async nack() { throw new Error("nack port failed"); } };
      const adapter = createArchiveRemoteAdapter({ outbox,
        zip_reader: { async read() { return setup.bytes; } },
        publisher: { async publishArchive() {
          if (operation === "nack") throw new Error("offline");
          return ingestReceipt(setup.claim);
        } } });
      await expect(adapter.publishClaim(setup.claim, {
        project_id: setup.claim.record.project_id, branch_name: "main", commit_sha: "abc123",
        client_id: "cli_alpha", change_key: setup.claim.record.change_identity
      }, "retain")).rejects.toThrow(`${operation} port failed`);
    }
  });

  it("rejects attacker retention even when the ack record itself is genuine", async () => {
    const setup = await claimedPackage();
    const forgedOutbox = { ...setup.outbox, async ack(...args: Parameters<ArchiveOutbox["ack"]>) {
      const genuine = await setup.outbox.ack(...args);
      return { ...genuine, retention: { ...genuine.retention,
        local_zip_ref: { ...genuine.retention.local_zip_ref, ref_id: "local_zip:attacker" } } };
    } };
    const adapter = createArchiveRemoteAdapter({ outbox: forgedOutbox,
      zip_reader: { async read() { return setup.bytes; } },
      publisher: { async publishArchive() { return ingestReceipt(setup.claim); } } });
    await expect(adapter.publishClaim(setup.claim, {
      project_id: setup.claim.record.project_id, branch_name: "main", commit_sha: "abc123",
      client_id: "cli_alpha", change_key: setup.claim.record.change_identity
    }, "cleanup_after_durable_ack")).rejects.toMatchObject({
      code: "ARCHIVE_REMOTE_OUTBOX_TRANSITION_INVALID"
    });
  });

  it("detaches validated ack output from a mutable Port return alias", async () => {
    const setup = await claimedPackage();
    let raw: Awaited<ReturnType<ArchiveOutbox["ack"]>> | undefined;
    const aliasingOutbox = { ...setup.outbox, async ack(...args: Parameters<ArchiveOutbox["ack"]>) {
      raw = structuredClone(await setup.outbox.ack(...args));
      return raw;
    } };
    const adapter = createArchiveRemoteAdapter({ outbox: aliasingOutbox,
      zip_reader: { async read() { return setup.bytes; } },
      publisher: { async publishArchive() { return ingestReceipt(setup.claim); } } });
    const result = await adapter.publishClaim(setup.claim, {
      project_id: setup.claim.record.project_id, branch_name: "main", commit_sha: "abc123",
      client_id: "cli_alpha", change_key: setup.claim.record.change_identity
    }, "cleanup_after_durable_ack");
    if (raw === undefined || result.outcome !== "stored") throw new Error("expected stored alias result");
    (raw.record as { project_id: string }).project_id = "prj_attacker";
    (raw.retention.local_zip_ref as { ref_id: string }).ref_id = "local_zip:attacker";
    expect(result).toMatchObject({ ack: { record: { project_id: setup.claim.record.project_id },
      retention: { local_zip_ref: { ref_id: setup.claim.record.local_zip_ref.ref_id } } },
    cleanup_intent: { local_zip_ref: { ref_id: setup.claim.record.local_zip_ref.ref_id } } });
  });

  it.each(["queued", "planning_failed"] as const)(
    "acks canonical Platform %s receipt because archive storage is already durable",
    async (branch) => {
      const setup = await claimedPackage();
      const canonical = await canonicalPlatformReceipt(setup.claim, branch);
      const adapter = createArchiveRemoteAdapter({ outbox: setup.outbox,
        zip_reader: { async read() { return setup.bytes; } },
        publisher: { async publishArchive() { return JSON.stringify(canonical); } } });
      await expect(adapter.publishClaim(setup.claim, {
        project_id: setup.claim.record.project_id, branch_name: "main", commit_sha: "abc123",
        client_id: "cli_alpha", change_key: setup.claim.record.change_identity
      }, "cleanup_after_durable_ack")).resolves.toMatchObject({ outcome: "stored",
        sync_receipt: { archive_id: setup.claim.record.archive_id, archive_status: "stored",
          retryable: false }, ack: { record: { state: "acknowledged" } },
        cleanup_intent: { disposition: "cleanup_allowed" } });
    }
  );

  it("rejects a Stage02 failed receipt with a foreign archive identity", async () => {
    const setup = await claimedPackage();
    const source_ref = { project_id: setup.claim.record.project_id, branch_name: "main",
      commit_sha: "abc123", client_id: "cli_alpha", change_key: setup.claim.record.change_identity };
    const remoteIdempotency = sha256Bytes(new TextEncoder().encode(canonicalJson({
      project_id: setup.claim.record.project_id,
      change_key: setup.claim.record.change_identity,
      archive_schema_version: setup.claim.record.archive_schema_version,
      package_sha256: setup.claim.record.package_sha256,
      archive_id: setup.claim.record.archive_id
    })));
    const adapter = createArchiveRemoteAdapter({ outbox: setup.outbox,
      zip_reader: { async read() { return setup.bytes; } }, publisher: { async publishArchive() {
        return { request_id: setup.claim.record.request_id, idempotency_key: remoteIdempotency,
          project_id: setup.claim.record.project_id, archive_id: "arc_foreign",
          change_key: setup.claim.record.change_identity, package_sha256: setup.claim.record.package_sha256,
          archive_status: "failed" as const, project_version: "pv_remote_1", stored_at: storedAt,
          retryable: true, reason_code: "REMOTE_UNAVAILABLE" as const };
      } } });
    await expect(adapter.publishClaim(setup.claim, source_ref, "cleanup_after_durable_ack"))
      .resolves.toMatchObject({ outcome: "dead_letter",
        reason_code: "ARCHIVE_INGEST_RECEIPT_INVALID", cleanup_intent: null });
  });

  it("rejects a canonical Platform receipt that does not echo the claimed idempotency key", async () => {
    const setup = await claimedPackage();
    const canonical = await canonicalPlatformReceipt(setup.claim, "queued");
    const adapter = createArchiveRemoteAdapter({ outbox: setup.outbox,
      zip_reader: { async read() { return setup.bytes; } }, publisher: { async publishArchive() {
        return JSON.stringify({ ...canonical,
          idempotency_key: `sha256:${"f".repeat(64)}` });
      } } });
    await expect(adapter.publishClaim(setup.claim, {
      project_id: setup.claim.record.project_id, branch_name: "main", commit_sha: "abc123",
      client_id: "cli_alpha", change_key: setup.claim.record.change_identity
    }, "cleanup_after_durable_ack")).resolves.toMatchObject({ outcome: "dead_letter",
      reason_code: "ARCHIVE_INGEST_RECEIPT_INVALID", cleanup_intent: null });
  });

  it("rejects nested hostile publish results without invoking Proxy traps or getters", async () => {
    const setup = await claimedPackage();
    const nack = await setup.outbox.nack(setup.claim, "REMOTE_UNAVAILABLE", true);
    const getter = vi.fn(() => nack.record);
    const hostileNack = Object.defineProperty({ retry_at: nack.retry_at }, "record",
      { enumerable: true, get: getter });
    expect(snapshotArchiveRemotePublishResult({
      outcome: "retry_scheduled",
      reason_code: "REMOTE_UNAVAILABLE",
      nack: hostileNack,
      cleanup_intent: null
    }, setup.claim, "retain")).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();

    let traps = 0;
    const hostileCleanup = new Proxy(nack, {
      ownKeys() { traps += 1; return Reflect.ownKeys(nack); }
    });
    expect(snapshotArchiveRemotePublishResult({
      outcome: "retry_scheduled",
      reason_code: "REMOTE_UNAVAILABLE",
      nack: hostileCleanup,
      cleanup_intent: null
    }, setup.claim, "retain")).toBeUndefined();
    expect(traps).toBe(0);
  });

  it("deep-snapshots stored receipt, ack, and cleanup before any semantic comparison", async () => {
    const setup = await claimedPackage();
    const adapter = createArchiveRemoteAdapter({
      outbox: setup.outbox,
      zip_reader: { async read() { return setup.bytes; } },
      publisher: { async publishArchive() { return ingestReceipt(setup.claim); } }
    });
    const stored = await adapter.publishClaim(setup.claim, {
      project_id: setup.claim.record.project_id, branch_name: "main", commit_sha: "abc123",
      client_id: "cli_alpha", change_key: setup.claim.record.change_identity
    }, "cleanup_after_durable_ack");
    if (stored.outcome !== "stored") throw new Error("stored fixture expected");
    const receiptGetter = vi.fn(() => setup.claim.record.project_id);
    const hostileReceipt = structuredClone(stored);
    Object.defineProperty(hostileReceipt.sync_receipt, "project_id",
      { enumerable: true, get: receiptGetter });
    expect(snapshotArchiveRemotePublishResult(hostileReceipt, setup.claim,
      "cleanup_after_durable_ack")).toBeUndefined();
    expect(receiptGetter).not.toHaveBeenCalled();

    const cleanupGetter = vi.fn(() => stored.cleanup_intent.local_zip_ref);
    const hostileCleanup = structuredClone(stored);
    Object.defineProperty(hostileCleanup.cleanup_intent, "local_zip_ref",
      { enumerable: true, get: cleanupGetter });
    expect(snapshotArchiveRemotePublishResult(hostileCleanup, setup.claim,
      "cleanup_after_durable_ack")).toBeUndefined();
    expect(cleanupGetter).not.toHaveBeenCalled();
  });

  it("rejects oversized snapshot containers before traversing later accessors", async () => {
    const setup = await claimedPackage();
    const getter = vi.fn(() => setup.claim.record);
    const oversized = Object.create(null) as Record<string, unknown>;
    oversized.values = Array.from({ length: 16_385 }, () => null);
    Object.defineProperty(oversized, "record", { enumerable: true, get: getter });
    expect(snapshotArchiveRemotePublishResult({
      outcome: "retry_scheduled",
      reason_code: "REMOTE_UNAVAILABLE",
      nack: oversized,
      cleanup_intent: null
    }, setup.claim, "retain")).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
  });

  it("counts primitive array elements against one global snapshot budget", async () => {
    const setup = await claimedPackage();
    const getter = vi.fn(() => setup.claim.record);
    const oversized = Object.create(null) as Record<string, unknown>;
    for (let index = 0; index < 7; index += 1) {
      oversized[`values_${index}`] = Array.from({ length: 16_000 }, () => index);
    }
    Object.defineProperty(oversized, "record", { enumerable: true, get: getter });
    expect(snapshotArchiveRemotePublishResult({
      outcome: "retry_scheduled",
      reason_code: "REMOTE_UNAVAILABLE",
      nack: oversized,
      cleanup_intent: null
    }, setup.claim, "retain")).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
  });

  it("accepts a snapshot containing exactly the global node budget", () => {
    const value = [
      ...Array.from({ length: 6 }, () => Array.from({ length: 16_384 }, () => null)),
      Array.from({ length: 1_688 }, () => null)
    ];

    expect(archiveRemoteValidationInternals.trySafeSnapshot(value).ok).toBe(true);
  });

  it("rejects node 100,001 without invoking a later getter", () => {
    const valueAtLimit = [
      ...Array.from({ length: 6 }, () => Array.from({ length: 16_384 }, () => null)),
      Array.from({ length: 1_688 }, () => null)
    ];
    expect(archiveRemoteValidationInternals.trySafeSnapshot({ nodes: valueAtLimit }))
      .toEqual({ ok: false });

    const getter = vi.fn(() => "not reached");
    const value = { nodes: valueAtLimit } as Record<string, unknown>;
    Object.defineProperty(value, "after_budget", { enumerable: true, get: getter });

    expect(archiveRemoteValidationInternals.trySafeSnapshot(value)).toEqual({ ok: false });
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects oversized strings and key sets before later accessors", async () => {
    const setup = await claimedPackage();
    for (const hostile of [
      Object.assign(Object.create(null), { text: "界".repeat(400_000) }),
      Object.fromEntries(Array.from({ length: 4_097 }, (_, index) => [`key_${index}`, null]))
    ] as Record<string, unknown>[]) {
      const getter = vi.fn(() => setup.claim.record);
      Object.defineProperty(hostile, "record", { enumerable: true, get: getter });
      expect(snapshotArchiveRemotePublishResult({
        outcome: "retry_scheduled", reason_code: "REMOTE_UNAVAILABLE",
        nack: hostile, cleanup_intent: null
      }, setup.claim, "retain")).toBeUndefined();
      expect(getter).not.toHaveBeenCalled();
    }
  });

  it("accepts the current maximum bounded reason code", async () => {
    const setup = await claimedPackage();
    const reason = "R" + "_".repeat(127);
    const nack = await setup.outbox.nack(setup.claim, reason, true);
    expect(snapshotArchiveRemotePublishResult({
      outcome: "retry_scheduled", reason_code: reason, nack, cleanup_intent: null
    }, setup.claim, "retain")).toMatchObject({ outcome: "retry_scheduled", reason_code: reason });
  });

  it("enforces cumulative string budgets across individually legal values", () => {
    const values = Array.from({ length: 10 }, (_, index) =>
      String(index).padEnd(900_000, "x"));
    const getter = vi.fn(() => "not reached");
    const input = { values } as Record<string, unknown>;
    Object.defineProperty(input, "after_budget", { enumerable: true, get: getter });
    expect(archiveRemoteValidationInternals.trySafeSnapshot(input)).toEqual({ ok: false });
    expect(getter).not.toHaveBeenCalled();
  });

  it("counts repeated references to one legal string against the CPU budget", () => {
    const repeated = "x".repeat(1_048_576);
    expect(archiveRemoteValidationInternals.trySafeSnapshot(
      Array.from({ length: 9 }, () => repeated)
    )).toEqual({ ok: false });
  });

  it("enforces the cumulative UTF-8 byte budget independently of code units", () => {
    const multibyte = "界".repeat(349_525);
    const getter = vi.fn(() => "not reached");
    const input = { values: Array.from({ length: 9 }, () => multibyte) } as Record<string, unknown>;
    Object.defineProperty(input, "after_budget", { enumerable: true, get: getter });
    expect(archiveRemoteValidationInternals.trySafeSnapshot(input)).toEqual({ ok: false });
    expect(getter).not.toHaveBeenCalled();
  });

  it("accepts the exact cumulative string budget", () => {
    const repeated = "x".repeat(1_048_576);
    const result = archiveRemoteValidationInternals.trySafeSnapshot(
      Array.from({ length: 8 }, () => repeated)
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(Array.from({ length: 8 }, () => repeated));
  });
});
