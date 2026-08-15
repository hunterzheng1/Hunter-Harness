import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { ArchivePackageReceipt } from "../src/archive-package-builder/index.js";
import {
  ArchiveOutboxError,
  InMemoryArchiveOutboxPort,
  createArchiveOutbox,
  normalizeArchiveOutboxRecord,
  stableHash as outboxStableHash,
  type ArchiveOutboxRecord
} from "../src/archive-outbox/index.js";

async function packageReceipt(): Promise<ArchivePackageReceipt> {
  return JSON.parse(await readFile(new URL(
    "./fixtures/archive-package-builder-v2-current.json",
    import.meta.url
  ), "utf8")) as ArchivePackageReceipt;
}

function verifiedInput(receipt: ArchivePackageReceipt) {
  return {
    package_receipt: receipt,
    local_zip_ref: {
      ref_id: "local_zip:alpha",
      package_sha256: receipt.package_sha256,
      size_bytes: receipt.package_size_bytes
    }
  };
}

const verifiedAt = "2026-08-13T09:30:00.000Z";
const trustedPackageVerifier = {
  async verify(input: ReturnType<typeof verifiedInput>) {
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
      verified_at: verifiedAt
    };
    const evidence_hash = outboxStableHash(body);
    return { ...body, evidence_hash,
      verification_id: `archive_outbox_package_verification:${evidence_hash.slice("sha256:".length)}` as const };
  }
};

function createTrustedArchiveOutbox(input: Parameters<typeof createArchiveOutbox>[0]) {
  return createArchiveOutbox({ ...input, package_verifier: trustedPackageVerifier });
}

describe("ArchiveOutbox enqueue", () => {
  it("does not trust a caller-supplied package verification assertion", async () => {
    class CountingPort extends InMemoryArchiveOutboxPort {
      put_count = 0;
      override async put(record: ArchiveOutboxRecord) {
        this.put_count += 1;
        return super.put(record);
      }
    }
    const port = new CountingPort();
    await expect(createArchiveOutbox({ port }).enqueue({ ...verifiedInput(await packageReceipt()),
      package_verification: { valid: true, reason_codes: [] } } as never))
      .rejects.toMatchObject({ code: "ARCHIVE_OUTBOX_PACKAGE_UNVERIFIED" });
    expect(port.put_count).toBe(0);
  });

  it("enqueues a verified package once and resumes idempotently through the Port", async () => {
    let now = new Date("2026-08-13T10:00:00.000Z");
    const port = new InMemoryArchiveOutboxPort({
      clock: () => now
    });
    const receipt = await packageReceipt();
    const first = await createTrustedArchiveOutbox({ port }).enqueue(verifiedInput(receipt));
    now = new Date("2026-08-14T10:00:00.000Z");
    const restarted = createTrustedArchiveOutbox({ port });
    const replay = await restarted.enqueue(verifiedInput(receipt));

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      schema_version: 1,
      state: "pending",
      package_operation_id: receipt.package_operation_id,
      package_sha256: receipt.package_sha256,
      receipt_hash: receipt.receipt_hash,
      attempt_count: 0,
      generation: 1,
      lease: null,
      durable_receipt: null
    });
    expect(first.package_verification_evidence).toMatchObject({
      verdict: "verified", package_operation_id: receipt.package_operation_id,
      receipt_hash: receipt.receipt_hash, package_sha256: receipt.package_sha256,
      manifest_sha256: receipt.manifest_sha256,
      local_zip_ref_id: "local_zip:alpha",
      expected_immutable_identity: first.immutable_identity
    });
    expect(port.records()).toHaveLength(1);
  });

  it("rejects unverified input and immutable local ZIP rebinding", async () => {
    const receipt = await packageReceipt();
    class CountingPort extends InMemoryArchiveOutboxPort {
      put_count = 0;
      override async put(record: ArchiveOutboxRecord) {
        this.put_count += 1;
        return super.put(record);
      }
    }
    const rejectedPort = new CountingPort();
    const rejectingVerifier = { async verify() {
      return { schema_version: 1 as const, verdict: "rejected" as const,
        reason_codes: ["ARCHIVE_PACKAGE_VERIFICATION_FAILED"], verified_at: verifiedAt };
    } };
    await expect(createArchiveOutbox({ port: rejectedPort, package_verifier: rejectingVerifier })
      .enqueue(verifiedInput(receipt))).rejects.toMatchObject({ code: "ARCHIVE_OUTBOX_PACKAGE_UNVERIFIED" });
    expect(rejectedPort.put_count).toBe(0);
    let verifier_getters = 0;
    const hostileVerifier = { async verify() {
      return Object.defineProperty({}, "verdict", {
        enumerable: true, get() { verifier_getters += 1; throw new Error("verification getter"); }
      });
    } };
    await expect(createArchiveOutbox({ port: rejectedPort, package_verifier: hostileVerifier as never })
      .enqueue(verifiedInput(receipt))).rejects.toMatchObject({ code: "ARCHIVE_OUTBOX_PACKAGE_UNVERIFIED" });
    expect({ verifier_getters, put_count: rejectedPort.put_count }).toEqual({ verifier_getters: 0, put_count: 0 });

    const port = new InMemoryArchiveOutboxPort();
    const outbox = createTrustedArchiveOutbox({ port });
    await outbox.enqueue(verifiedInput(receipt));
    await expect(outbox.enqueue({
      ...verifiedInput(receipt),
      local_zip_ref: { ...verifiedInput(receipt).local_zip_ref, ref_id: "local_zip:rebound" }
    })).rejects.toBeInstanceOf(ArchiveOutboxError);
    await expect(outbox.enqueue({
      ...verifiedInput(receipt),
      local_zip_ref: { ...verifiedInput(receipt).local_zip_ref, ref_id: "local_zip:rebound" }
    })).rejects.toMatchObject({ code: "ARCHIVE_OUTBOX_IMMUTABLE_CONFLICT" });
  });
});

describe("ArchiveOutbox lease", () => {
  it("rejects a descriptor-hostile claim before clock or storage access", async () => {
    let clock_count = 0;
    let read_count = 0;
    let cas_count = 0;
    class CountingPort extends InMemoryArchiveOutboxPort {
      override clock() { clock_count += 1; return new Date("2026-08-13T10:00:00.000Z"); }
      override async read(entry_id: ArchiveOutboxRecord["entry_id"]) {
        read_count += 1;
        return super.read(entry_id);
      }
      override async compareAndSwap(...args: Parameters<InMemoryArchiveOutboxPort["compareAndSwap"]>) {
        cas_count += 1;
        return super.compareAndSwap(...args);
      }
    }
    const port = new CountingPort();
    const outbox = createTrustedArchiveOutbox({ port });
    let getters = 0;
    for (const operation of [
      (claim: never) => outbox.renew(claim, 1_000),
      (claim: never) => outbox.nack(claim, "REMOTE_UNAVAILABLE", true),
      (claim: never) => outbox.ack(claim, {} as never, "retain")
    ]) {
      const hostile = Object.defineProperty({}, "entry_id", {
        enumerable: true, get() { getters += 1; throw new Error("claim getter"); }
      });
      await expect(operation(hostile as never)).rejects.toMatchObject({
        code: "ARCHIVE_OUTBOX_LEASE_STALE"
      });
    }
    expect({ getters, clock_count, read_count, cas_count }).toEqual({
      getters: 0, clock_count: 0, read_count: 0, cas_count: 0
    });
  });

  it("rejects a swapped CAS result that does not return the exact proposed record", async () => {
    class DriftingCasPort extends InMemoryArchiveOutboxPort {
      drift = true;
      override async compareAndSwap(entry_id: ArchiveOutboxRecord["entry_id"], expected_generation: number,
        next: ArchiveOutboxRecord) {
        const prior = await this.read(entry_id);
        if (prior === undefined) throw new Error("missing record");
        const result = await super.compareAndSwap(entry_id, expected_generation, next);
        return this.drift && result.swapped ? { swapped: true, record: prior } : result;
      }
    }
    for (const transition of ["claim", "renew", "nack", "ack", "reap"] as const) {
      let now = new Date("2026-08-13T10:00:00.000Z");
      const port = new DriftingCasPort({ clock: () => now });
      const outbox = createTrustedArchiveOutbox({ port });
      port.drift = transition === "claim";
      const pending = await outbox.enqueue(verifiedInput(await packageReceipt()));
      if (transition === "claim") {
        await expect(outbox.claim(pending.entry_id, "worker_a", 1_000)).rejects.toMatchObject({
          code: "ARCHIVE_OUTBOX_PORT_INVALID"
        });
        continue;
      }
      const claim = await outbox.claim(pending.entry_id, "worker_a", 1_000);
      port.drift = true;
      const action = transition === "renew" ? outbox.renew(claim, 1_000) :
        transition === "nack" ? outbox.nack(claim, "REMOTE_UNAVAILABLE", true) :
          transition === "ack" ? outbox.ack(claim, {
            request_id: pending.request_id, idempotency_key: pending.idempotency_key,
            project_id: pending.project_id, archive_id: pending.archive_id,
            change_key: pending.change_identity, package_sha256: pending.package_sha256,
            archive_status: "stored", project_version: "pv_remote_1", stored_at: now.toISOString(), retryable: false
          }, "retain") : (now = new Date("2026-08-13T10:00:02.000Z"), outbox.reap());
      await expect(action).rejects.toMatchObject({ code: "ARCHIVE_OUTBOX_PORT_INVALID" });
    }
  });

  it("claims with CAS once and renews only the current token, owner and generation", async () => {
    let now = new Date("2026-08-13T10:00:00.000Z");
    const port = new InMemoryArchiveOutboxPort({ clock: () => now });
    const receipt = await packageReceipt();
    const outbox = createTrustedArchiveOutbox({ port });
    const pending = await outbox.enqueue(verifiedInput(receipt));

    const [left, right] = await Promise.allSettled([
      createTrustedArchiveOutbox({ port }).claim(pending.entry_id, "worker_a", 30_000),
      createTrustedArchiveOutbox({ port }).claim(pending.entry_id, "worker_b", 30_000)
    ]);
    expect([left.status, right.status].sort()).toEqual(["fulfilled", "rejected"]);
    const claimed = left.status === "fulfilled" ? left.value : right.status === "fulfilled" ? right.value : undefined;
    if (claimed === undefined) throw new Error("claim missing");
    expect(claimed.record).toMatchObject({ state: "leased", attempt_count: 1, generation: 2 });
    expect(claimed.lease).toMatchObject({ owner_id: claimed.lease.owner_id, generation: 2,
      acquired_at: "2026-08-13T10:00:00.000Z", expires_at: "2026-08-13T10:00:30.000Z" });

    now = new Date("2026-08-13T10:00:05.000Z");
    const renewed = await outbox.renew(claimed, 60_000);
    expect(renewed.record.generation).toBe(3);
    expect(renewed.lease.token).not.toBe(claimed.lease.token);
    expect(renewed.lease).toMatchObject({ owner_id: claimed.lease.owner_id,
      generation: 3, acquired_at: claimed.lease.acquired_at, expires_at: "2026-08-13T10:01:05.000Z" });
    await expect(outbox.renew(claimed, 60_000)).rejects.toMatchObject({
      code: "ARCHIVE_OUTBOX_LEASE_STALE"
    });
    await expect(outbox.renew({ ...renewed,
      lease: { ...renewed.lease, owner_id: "attacker" } }, 60_000)).rejects.toMatchObject({
      code: "ARCHIVE_OUTBOX_LEASE_STALE"
    });
  });
});

describe("ArchiveOutbox retry and recovery", () => {
  it("uses bounded deterministic backoff and dead-letters without losing the ZIP reference", async () => {
    let now = new Date("2026-08-13T10:00:00.000Z");
    const port = new InMemoryArchiveOutboxPort({ clock: () => now });
    const outbox = createTrustedArchiveOutbox({ port, max_attempts: 3,
      base_backoff_ms: 1_000, max_backoff_ms: 2_500 });
    const pending = await outbox.enqueue(verifiedInput(await packageReceipt()));
    const first = await outbox.claim(pending.entry_id, "worker_a", 30_000);
    const firstNack = await outbox.nack(first, "REMOTE_UNAVAILABLE", true);
    expect(firstNack.retry_at).toBe("2026-08-13T10:00:01.000Z");
    expect(firstNack.record).toMatchObject({ state: "retry_wait", attempt_count: 1,
      lease: null, last_reason_code: "REMOTE_UNAVAILABLE",
      local_zip_ref: pending.local_zip_ref, durable_receipt: null });
    await expect(outbox.claim(pending.entry_id, "worker_a", 30_000)).rejects.toMatchObject({
      code: "ARCHIVE_OUTBOX_NOT_CLAIMABLE"
    });

    now = new Date("2026-08-13T10:00:01.000Z");
    const second = await outbox.claim(pending.entry_id, "worker_a", 30_000);
    const secondNack = await outbox.nack(second, "REMOTE_UNAVAILABLE", true);
    expect(secondNack.retry_at).toBe("2026-08-13T10:00:03.000Z");

    now = new Date("2026-08-13T10:00:03.000Z");
    const third = await outbox.claim(pending.entry_id, "worker_a", 30_000);
    const terminal = await outbox.nack(third, "ARCHIVE_PUBLISH_FAILED", true);
    expect(terminal).toMatchObject({ retry_at: null, record: { state: "dead_letter",
      attempt_count: 3, last_reason_code: "ARCHIVE_PUBLISH_FAILED",
      local_zip_ref: pending.local_zip_ref } });
    expect(port.records()).toHaveLength(1);
  });

  it("reaps an expired lease after restart and rejects the stale claim", async () => {
    let now = new Date("2026-08-13T10:00:00.000Z");
    const port = new InMemoryArchiveOutboxPort({ clock: () => now });
    const firstProcess = createTrustedArchiveOutbox({ port, base_backoff_ms: 1_000 });
    const pending = await firstProcess.enqueue(verifiedInput(await packageReceipt()));
    const stale = await firstProcess.claim(pending.entry_id, "worker_a", 1_000);
    now = new Date("2026-08-13T10:00:02.000Z");
    const restarted = createTrustedArchiveOutbox({ port, base_backoff_ms: 1_000 });

    const reaped = await restarted.reap();
    expect(reaped).toEqual({ inspected_count: 1, reaped_entry_ids: [pending.entry_id] });
    await expect(restarted.nack(stale, "REMOTE_UNAVAILABLE", true)).rejects.toMatchObject({
      code: "ARCHIVE_OUTBOX_LEASE_STALE"
    });
    now = new Date("2026-08-13T10:00:03.000Z");
    const recovered = await restarted.claim(pending.entry_id, "worker_b", 10_000);
    expect(recovered.record).toMatchObject({ state: "leased", attempt_count: 2 });
  });
});

describe("ArchiveOutbox durable acknowledgement", () => {
  it("rejects acknowledgement after lease expiry without CAS or cleanup intent", async () => {
    let now = new Date("2026-08-13T10:00:00.000Z");
    let cas_count = 0;
    class CountingPort extends InMemoryArchiveOutboxPort {
      override async compareAndSwap(...args: Parameters<InMemoryArchiveOutboxPort["compareAndSwap"]>) {
        cas_count += 1;
        return super.compareAndSwap(...args);
      }
    }
    const port = new CountingPort({ clock: () => now });
    const outbox = createTrustedArchiveOutbox({ port });
    const pending = await outbox.enqueue(verifiedInput(await packageReceipt()));
    const claimed = await outbox.claim(pending.entry_id, "worker_a", 1_000);
    const count_after_claim = cas_count;
    now = new Date("2026-08-13T10:00:02.000Z");
    await expect(outbox.ack(claimed, {
      request_id: pending.request_id, idempotency_key: pending.idempotency_key,
      project_id: pending.project_id, archive_id: pending.archive_id,
      change_key: pending.change_identity, package_sha256: pending.package_sha256,
      archive_status: "stored", project_version: "pv_remote_1", stored_at: now.toISOString(), retryable: false
    }, "cleanup_after_durable_ack")).rejects.toMatchObject({ code: "ARCHIVE_OUTBOX_LEASE_STALE" });
    expect(cas_count).toBe(count_after_claim);
    expect((await outbox.inspect(pending.entry_id, "cleanup_after_durable_ack")).retention.disposition).toBe("retain");
  });

  it("binds the frozen remote receipt and only emits a policy-authorized cleanup intent", async () => {
    const port = new InMemoryArchiveOutboxPort({
      clock: () => new Date("2026-08-13T10:00:00.000Z")
    });
    const outbox = createTrustedArchiveOutbox({ port });
    const pending = await outbox.enqueue(verifiedInput(await packageReceipt()));
    expect((await outbox.inspect(pending.entry_id, "cleanup_after_durable_ack")).retention)
      .toMatchObject({ disposition: "retain", reason_code: "OUTBOX_NOT_ACKNOWLEDGED" });
    const claimed = await outbox.claim(pending.entry_id, "worker_a", 30_000);
    const storedReceipt = {
      request_id: pending.request_id,
      idempotency_key: pending.idempotency_key,
      project_id: pending.project_id,
      archive_id: pending.archive_id,
      change_key: pending.change_identity,
      package_sha256: pending.package_sha256,
      archive_status: "stored" as const,
      project_version: "pv_remote_1",
      stored_at: "2026-08-13T10:00:00.000Z",
      retryable: false
    };

    await expect(outbox.ack(claimed, { ...storedReceipt, package_sha256: `sha256:${"f".repeat(64)}` },
      "cleanup_after_durable_ack")).rejects.toMatchObject({ code: "ARCHIVE_OUTBOX_ACK_INVALID" });
    const retained = await outbox.ack(claimed, storedReceipt, "retain");
    expect(retained.record).toMatchObject({ state: "acknowledged", lease: null,
      durable_receipt: storedReceipt, local_zip_ref: pending.local_zip_ref });
    expect(retained.retention).toMatchObject({ disposition: "retain",
      reason_code: "OUTBOX_POLICY_RETAINS_ZIP" });
    expect((await outbox.inspect(pending.entry_id, "cleanup_after_durable_ack")).retention)
      .toMatchObject({ disposition: "cleanup_allowed", reason_code: "OUTBOX_DURABLE_ACKNOWLEDGED",
        local_zip_ref: pending.local_zip_ref });
    expect(port.records()).toHaveLength(1);
  });

  it("rejects failed, retryable, malformed and stale acknowledgements", async () => {
    const port = new InMemoryArchiveOutboxPort({
      clock: () => new Date("2026-08-13T10:00:00.000Z")
    });
    const outbox = createTrustedArchiveOutbox({ port });
    const pending = await outbox.enqueue(verifiedInput(await packageReceipt()));
    const claimed = await outbox.claim(pending.entry_id, "worker_a", 30_000);
    const failed = {
      request_id: pending.request_id, idempotency_key: pending.idempotency_key,
      project_id: pending.project_id, archive_id: pending.archive_id,
      change_key: pending.change_identity, package_sha256: pending.package_sha256,
      archive_status: "failed" as const, project_version: "pv_remote_1",
      stored_at: "2026-08-13T10:00:00.000Z", retryable: true,
      reason_code: "REMOTE_UNAVAILABLE" as const
    };
    await expect(outbox.ack(claimed, failed, "retain")).rejects.toMatchObject({
      code: "ARCHIVE_OUTBOX_ACK_INVALID"
    });
    const hostile = Object.defineProperty({ ...failed, archive_status: "stored", retryable: false },
      "stored_at", { enumerable: true, get() { throw new Error("hostile getter"); } });
    await expect(outbox.ack(claimed, hostile, "retain")).rejects.toMatchObject({
      code: "ARCHIVE_OUTBOX_ACK_INVALID"
    });
    const released = await outbox.nack(claimed, "REMOTE_UNAVAILABLE", true);
    expect(released.record.state).toBe("retry_wait");
    await expect(outbox.ack(claimed, failed, "retain")).rejects.toMatchObject({
      code: "ARCHIVE_OUTBOX_LEASE_STALE"
    });
  });
});

describe("ArchiveOutbox persistent trust boundary", () => {
  it("rejects a self-rehashed state contradiction returned by the Port", async () => {
    class TamperingPort extends InMemoryArchiveOutboxPort {
      tamper = false;
      override async read(entry_id: ArchiveOutboxRecord["entry_id"]) {
        const record = await super.read(entry_id);
        if (!this.tamper || record === undefined) return record;
        const { record_hash: ignored, ...payload } = record;
        void ignored;
        const changed = { ...payload, state: "acknowledged" as const };
        return { ...changed, record_hash: outboxStableHash(changed) };
      }
    }
    const port = new TamperingPort();
    const outbox = createTrustedArchiveOutbox({ port });
    const pending = await outbox.enqueue(verifiedInput(await packageReceipt()));
    port.tamper = true;
    await expect(outbox.inspect(pending.entry_id, "retain")).rejects.toMatchObject({
      code: "ARCHIVE_OUTBOX_PORT_INVALID"
    });
  });

  it("maps hostile Port records to a stable Port error without leaking accessors", async () => {
    class HostilePort extends InMemoryArchiveOutboxPort {
      hostile = false;
      override async read(entry_id: ArchiveOutboxRecord["entry_id"]) {
        if (!this.hostile) return super.read(entry_id);
        return Object.defineProperty({}, "schema_version", {
          enumerable: true,
          get() { throw new Error("hostile Port getter"); }
        }) as ArchiveOutboxRecord;
      }
    }
    const port = new HostilePort();
    const outbox = createTrustedArchiveOutbox({ port });
    const pending = await outbox.enqueue(verifiedInput(await packageReceipt()));
    port.hostile = true;
    await expect(outbox.inspect(pending.entry_id, "retain")).rejects.toMatchObject({
      code: "ARCHIVE_OUTBOX_PORT_INVALID"
    });
  });

  it("normalizes current records and keeps v0 records read-only", async () => {
    const port = new InMemoryArchiveOutboxPort({
      clock: () => new Date("2026-08-13T10:00:00.000Z")
    });
    const record = await createTrustedArchiveOutbox({ port }).enqueue(verifiedInput(await packageReceipt()));
    expect(normalizeArchiveOutboxRecord(record)).toMatchObject({
      ok: true, source_schema_version: 1, readiness: "ready"
    });
    const current = JSON.parse(await readFile(new URL(
      "./fixtures/archive-outbox-v1-current.json", import.meta.url
    ), "utf8")) as unknown;
    expect(normalizeArchiveOutboxRecord(current)).toMatchObject({
      ok: true, source_schema_version: 1, readiness: "ready"
    });
    const legacy = JSON.parse(await readFile(new URL(
      "./fixtures/archive-outbox-v0-legacy.json", import.meta.url
    ), "utf8")) as unknown;
    expect(normalizeArchiveOutboxRecord(legacy)).toEqual({
      ok: true,
      source_schema_version: 0,
      readiness: "legacy_read_only",
      legacy: {
        package_sha256: `sha256:${"a".repeat(64)}`,
        local_zip_ref: "local_zip:legacy"
      },
      reason_codes: ["LEGACY_OUTBOX_LEASE_UNKNOWN", "LEGACY_OUTBOX_DURABLE_ACK_UNKNOWN"]
    });
  });

  it("fails closed without executing hostile current or legacy accessors", () => {
    for (const field of ["schema_version", "schemaVersion"] as const) {
      const hostile = Object.defineProperty({}, field, {
        enumerable: true,
        get() { throw new Error("hostile getter"); }
      });
      expect(() => normalizeArchiveOutboxRecord(hostile)).not.toThrow();
      expect(normalizeArchiveOutboxRecord(hostile)).toEqual({
        ok: false, reason_code: "ARCHIVE_OUTBOX_RECORD_INVALID"
      });
    }
  });

  it.each([
    ["ack without durable receipt", (record: Record<string, unknown>) => {
      record.state = "acknowledged";
    }],
    ["pending with attempts", (record: Record<string, unknown>) => {
      record.attempt_count = 1;
    }],
    ["local ZIP identity drift", (record: Record<string, unknown>) => {
      record.local_zip_ref = { ...(record.local_zip_ref as Record<string, unknown>), ref_id: "local_zip:other" };
    }]
  ] as const)("rejects a self-rehashed current state contradiction: %s", async (_label, mutate) => {
    const record = JSON.parse(await readFile(new URL(
      "./fixtures/archive-outbox-v1-current.json", import.meta.url
    ), "utf8")) as Record<string, unknown>;
    mutate(record);
    const { record_hash: ignored, ...payload } = record;
    void ignored;
    record.record_hash = outboxStableHash(payload);
    expect(normalizeArchiveOutboxRecord(record)).toEqual({
      ok: false, reason_code: "ARCHIVE_OUTBOX_RECORD_INVALID"
    });
  });
});
