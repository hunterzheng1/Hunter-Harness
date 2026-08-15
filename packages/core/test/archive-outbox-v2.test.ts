import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { ArchivePackageReceipt } from "../src/archive-package-builder/index.js";
import {
  InMemoryArchiveOutboxV2Port,
  createArchiveOutboxV2,
  normalizeArchiveOutboxV2Record,
  stableHash as outboxStableHash,
  v2CapabilityHash,
  type ArchiveOutboxV2Claim,
  type ArchiveOutboxV2Record,
  type ArchiveOutboxV2TransitionOperation,
  type ArchiveOutboxV2TransitionResult
} from "../src/archive-outbox/index.js";

async function packageReceipt(): Promise<ArchivePackageReceipt> {
  return JSON.parse(await readFile(new URL("./fixtures/archive-package-builder-v2-current.json", import.meta.url), "utf8")) as ArchivePackageReceipt;
}

function verifiedInput(receipt: ArchivePackageReceipt) {
  return {
    package_receipt: receipt,
    local_zip_ref: { ref_id: "local_zip:alpha", package_sha256: receipt.package_sha256, size_bytes: receipt.package_size_bytes }
  };
}

const verifiedAt = "2026-08-13T09:30:00.000Z";
const trustedVerifier = {
  async verify(input: ReturnType<typeof verifiedInput>) {
    const expected_immutable_identity = outboxStableHash(input);
    const body = {
      schema_version: 1 as const, verdict: "verified" as const,
      package_operation_id: input.package_receipt.package_operation_id,
      receipt_hash: input.package_receipt.receipt_hash,
      package_sha256: input.package_receipt.package_sha256,
      manifest_sha256: input.package_receipt.manifest_sha256,
      local_zip_ref_id: input.local_zip_ref.ref_id,
      local_zip_size_bytes: input.local_zip_ref.size_bytes,
      expected_immutable_identity,
      verified_at: verifiedAt
    };
    const evidence_hash = outboxStableHash(body);
    return { ...body, evidence_hash,
      verification_id: `archive_outbox_package_verification:${evidence_hash.slice("sha256:".length)}` as const };
  }
};

function makeReceipt(record: ArchiveOutboxV2Record) {
  return {
    request_id: record.request_id,
    idempotency_key: record.idempotency_key,
    project_id: record.project_id,
    archive_id: record.archive_id,
    change_key: record.change_identity,
    package_sha256: record.package_sha256,
    archive_status: "stored" as const,
    project_version: record.project_version,
    stored_at: "2026-08-13T10:00:01.000Z",
    retryable: false as const
  };
}

function createClock() {
  let now = new Date("2026-08-13T10:00:00.000Z");
  return { clock: () => now, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

async function setup(options: ConstructorParameters<typeof InMemoryArchiveOutboxV2Port>[0] = {}) {
  const time = createClock();
  const port = new InMemoryArchiveOutboxV2Port({ clock: time.clock, ...options });
  const outbox = createArchiveOutboxV2({ port, package_verifier: trustedVerifier, base_backoff_ms: 10, max_backoff_ms: 100 });
  const receipt = await packageReceipt();
  const record = await outbox.enqueue(verifiedInput(receipt));
  return { time, port, outbox, receipt, record };
}

describe("ArchiveOutbox v2 additive contract", () => {
  it("creates a schema-2 record while leaving v1 data read-only", async () => {
    const { record } = await setup();
    expect(record.schema_version).toBe(2);
    expect(record.lease).toBeNull();
    expect(record.cleanup.status).toBe("not_allowed");
    expect(JSON.stringify(record)).not.toContain("archive_outbox_capability:");
    expect(normalizeArchiveOutboxV2Record(record)).toMatchObject({ ok: true, source_schema_version: 2, readiness: "ready" });
    const legacy = JSON.parse(await readFile(new URL("./fixtures/archive-outbox-v1-current.json", import.meta.url), "utf8"));
    expect(normalizeArchiveOutboxV2Record(legacy)).toMatchObject({ ok: true, source_schema_version: 1, readiness: "legacy_read_only" });
  });

  it("uses a fresh CSPRNG capability and stores only its hash", async () => {
    const { time, outbox } = await setup();
    const first = (await outbox.claimDue({ operation_id: "archive_outbox_transition:claim", owner_id: "worker", lease_ttl_ms: 100 }))
      .claims[0] as ArchiveOutboxV2Claim;
    expect(first.capability).toMatch(/^archive_outbox_capability:[A-Za-z0-9_-]{43}$/u);
    expect(first.record.lease?.capability_hash).toBe(v2CapabilityHash(first.capability));
    await outbox.nack(first, "TEMPORARY_FAILURE", true, "archive_outbox_transition:nack");
    time.advance(11);
    const second = (await outbox.claimDue({ operation_id: "archive_outbox_transition:claim-again", owner_id: "worker", lease_ttl_ms: 100 }))
      .claims[0] as ArchiveOutboxV2Claim;
    expect(second.capability).not.toBe(first.capability);
    expect(JSON.stringify(second.record)).not.toContain(second.capability);
  });

  it("uses storage time for expiry and rejects stale capabilities", async () => {
    const { time, outbox } = await setup();
    const claim = (await outbox.claimDue({ operation_id: "archive_outbox_transition:claim", owner_id: "worker", lease_ttl_ms: 10 })).claims[0] as ArchiveOutboxV2Claim;
    time.advance(11);
    await expect(outbox.nack(claim, "TEMPORARY_FAILURE", true, "archive_outbox_transition:stale"))
      .rejects.toMatchObject({ code: "ARCHIVE_OUTBOX_LEASE_STALE" });
    const reaped = await outbox.reap({ operation_id: "archive_outbox_transition:reap" });
    expect(reaped.reaped_entry_ids).toEqual([claim.entry_id]);
    const replay = await outbox.reap({ operation_id: "archive_outbox_transition:reap" });
    expect(replay.reaped_entry_ids).toEqual([claim.entry_id]);
  });

  it("resolves a commit ambiguity by inspecting the durable transition", async () => {
    const { outbox } = await setup({ fail_after_commit_once: true });
    const result = await outbox.claimDue({ operation_id: "archive_outbox_transition:ambiguous", owner_id: "worker", lease_ttl_ms: 100 });
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]?.record.state).toBe("leased");
  });

  it("fails closed when a replayed claim has no raw capability after restart", async () => {
    const { outbox, port, time } = await setup();
    const first = (await outbox.claimDue({ operation_id: "archive_outbox_transition:restart", owner_id: "worker", lease_ttl_ms: 100 })).claims[0] as ArchiveOutboxV2Claim;
    await outbox.nack(first, "TEMPORARY_FAILURE", true, "archive_outbox_transition:restart-nack");
    time.advance(11);
    const restarted = createArchiveOutboxV2({ port, package_verifier: trustedVerifier, base_backoff_ms: 10, max_backoff_ms: 100 });
    await expect(restarted.claimDue({ operation_id: "archive_outbox_transition:restart", owner_id: "worker", lease_ttl_ms: 100 }))
      .rejects.toMatchObject({ code: "ARCHIVE_OUTBOX_CAPABILITY_UNAVAILABLE" });
  });

  it("fences cleanup after a durable acknowledgement without deleting bytes", async () => {
    const { outbox } = await setup();
    const claim = (await outbox.claimDue({ operation_id: "archive_outbox_transition:claim", owner_id: "worker", lease_ttl_ms: 100 })).claims[0] as ArchiveOutboxV2Claim;
    const acknowledged = await outbox.ack(claim, makeReceipt(claim.record), "cleanup_after_durable_ack", "archive_outbox_transition:ack");
    expect(acknowledged.cleanup.status).toBe("allowed");
    const cleanup = await outbox.claimCleanup({ operation_id: "archive_outbox_transition:cleanup-claim", entry_id: acknowledged.entry_id, expected_generation: acknowledged.generation });
    expect(cleanup.record.cleanup.status).toBe("claimed");
    const completed = await outbox.completeCleanup({ operation_id: "archive_outbox_transition:cleanup-complete", entry_id: acknowledged.entry_id,
      expected_generation: cleanup.record_generation, tombstone: false });
    expect(completed.outcome).toBe("completed");
    expect(completed.record.cleanup.status).toBe("completed");
    expect(completed.record.local_zip_ref).toEqual(acknowledged.local_zip_ref);
  });

  it("rejects Proxy input before invoking the Port", async () => {
    const { outbox } = await setup();
    let calls = 0;
    const hostile = new Proxy({ operation_id: "archive_outbox_transition:x", owner_id: "worker", lease_ttl_ms: 10 }, {
      get() { calls += 1; throw new Error("getter"); }
    });
    await expect(outbox.claimDue(hostile as never)).rejects.toMatchObject({ code: "ARCHIVE_OUTBOX_INPUT_INVALID" });
    expect(calls).toBe(0);
  });

  it("rejects accessor Port and verifier methods before invoking a getter", () => {
    const port = new InMemoryArchiveOutboxV2Port();
    let portGetterCalls = 0;
    Object.defineProperty(port, "read", {
      enumerable: true,
      get() { portGetterCalls += 1; throw new Error("read getter"); }
    });
    expect(() => createArchiveOutboxV2({ port, package_verifier: trustedVerifier })).toThrow("ARCHIVE_OUTBOX_INPUT_INVALID");
    expect(portGetterCalls).toBe(0);

    let verifierGetterCalls = 0;
    const verifier = Object.defineProperty({}, "verify", {
      enumerable: true,
      get() { verifierGetterCalls += 1; throw new Error("verify getter"); }
    });
    expect(() => createArchiveOutboxV2({ port: new InMemoryArchiveOutboxV2Port(), package_verifier: verifier as never }))
      .toThrow("ARCHIVE_OUTBOX_INPUT_INVALID");
    expect(verifierGetterCalls).toBe(0);
  });

  it("rejects a direct Proxy thenable Port result without touching its then trap", async () => {
    let thenCalls = 0;
    const thenable = new Proxy({ then() { thenCalls += 1; } }, {
      get() { thenCalls += 1; throw new Error("then trap"); }
    });
    class ThenablePort extends InMemoryArchiveOutboxV2Port {
      override read(): Promise<ArchiveOutboxV2Record | undefined> {
        return thenable as never;
      }
    }
    const port = new ThenablePort();
    const outbox = createArchiveOutboxV2({ port, package_verifier: trustedVerifier });
    const receipt = await packageReceipt();
    await expect(outbox.enqueue(verifiedInput(receipt))).rejects.toMatchObject({ code: "ARCHIVE_OUTBOX_PORT_INVALID" });
    expect(thenCalls).toBe(0);
  });

  it("requires a commit result to be the exact proposed record, not merely the same entry", async () => {
    class SpoofPort extends InMemoryArchiveOutboxV2Port {
      spoof: ArchiveOutboxV2Record | null = null;

      override async commitTransition(operation: ArchiveOutboxV2TransitionOperation,
        next: ArchiveOutboxV2Record): Promise<ArchiveOutboxV2TransitionResult> {
        const result = await super.commitTransition(operation, next);
        return this.spoof === null ? result : { ...result, record: this.spoof };
      }
    }
    const time = createClock();
    const port = new SpoofPort({ clock: time.clock });
    const outbox = createArchiveOutboxV2({ port, package_verifier: trustedVerifier });
    const record = await outbox.enqueue(verifiedInput(await packageReceipt()));
    port.spoof = record;
    await expect(outbox.claimDue({ operation_id: "archive_outbox_transition:spoof", owner_id: "worker", lease_ttl_ms: 100 }))
      .rejects.toMatchObject({ code: "ARCHIVE_OUTBOX_PORT_INVALID" });
  });

  it("does not resolve an ambiguous commit from an inspection record with the wrong generation", async () => {
    class AmbiguousSpoofPort extends InMemoryArchiveOutboxV2Port {
      spoof: ArchiveOutboxV2Record | null = null;

      override async inspectTransition(operationId: ArchiveOutboxV2TransitionOperation["operation_id"]): Promise<Awaited<ReturnType<InMemoryArchiveOutboxV2Port["inspectTransition"]>>> {
        const result = await super.inspectTransition(operationId);
        return this.spoof === null || result.record === null ? result : { ...result, record: this.spoof };
      }
    }
    const time = createClock();
    const port = new AmbiguousSpoofPort({ clock: time.clock, fail_after_commit_once: true });
    const outbox = createArchiveOutboxV2({ port, package_verifier: trustedVerifier });
    const record = await outbox.enqueue(verifiedInput(await packageReceipt()));
    port.spoof = record;
    await expect(outbox.claimDue({ operation_id: "archive_outbox_transition:ambiguous-spoof", owner_id: "worker", lease_ttl_ms: 100 }))
      .rejects.toMatchObject({ code: "ARCHIVE_OUTBOX_PORT_CONFLICT" });
  });
});
