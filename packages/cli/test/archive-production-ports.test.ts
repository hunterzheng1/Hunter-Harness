import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson } from "@hunter-harness/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { putArchiveCas } from "../src/archive-production/cas-store.js";
import { createArchivePackageVerifier, createHttpArchivePublisher } from "../src/archive-production/production-ports.js";

const sha256Tagged = (value: unknown): string =>
  `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;

function receiptFor(packageSha256: string) {
  const body = {
    package_sha256: packageSha256,
    manifest_sha256: `sha256:${"b".repeat(64)}`,
    package_operation_id: "op_x"
  };
  return { ...body, receipt_hash: sha256Tagged(body) };
}

describe("archive package verifier (06B-3 W3 T0-3)", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "archive-verifier-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("verifies triple consistency (bytes + ref + receipt)", async () => {
    const bytes = new TextEncoder().encode("PK-verify");
    const ref = await putArchiveCas(root, bytes, { project_id: "prj_v" });
    const verifier = createArchivePackageVerifier({ projectRoot: root });
    const result = await verifier.verify({
      package_receipt: receiptFor(ref.package_sha256),
      local_zip_ref: ref,
      project_id: "prj_v"
    });
    expect(result.verdict).toBe("verified");
  });

  it("rejects receipt/ref hash mismatch", async () => {
    const ref = await putArchiveCas(root, new TextEncoder().encode("PK-a"), { project_id: "prj_v" });
    const verifier = createArchivePackageVerifier({ projectRoot: root });
    const result = await verifier.verify({
      package_receipt: receiptFor(`sha256:${"9".repeat(64)}`),
      local_zip_ref: ref,
      project_id: "prj_v"
    });
    expect(result.verdict).toBe("rejected");
    expect((result as { reason_codes: string[] }).reason_codes).toContain("RECEIPT_REF_HASH_MISMATCH");
  });

  it("rejects forged receipt seal", async () => {
    const ref = await putArchiveCas(root, new TextEncoder().encode("PK-b"), { project_id: "prj_v" });
    const verifier = createArchivePackageVerifier({ projectRoot: root });
    const bad = { ...receiptFor(ref.package_sha256), receipt_hash: `sha256:${"0".repeat(64)}` };
    const result = await verifier.verify({ package_receipt: bad, local_zip_ref: ref, project_id: "prj_v" });
    expect(result.verdict).toBe("rejected");
    expect((result as { reason_codes: string[] }).reason_codes).toContain("RECEIPT_SEAL_INVALID");
  });

  it("rejects untrusted zip ref (cross-project)", async () => {
    const ref = await putArchiveCas(root, new TextEncoder().encode("PK-c"), { project_id: "prj_v" });
    const verifier = createArchivePackageVerifier({ projectRoot: root });
    const result = await verifier.verify({
      package_receipt: receiptFor(ref.package_sha256),
      local_zip_ref: ref,
      project_id: "prj_other"
    });
    expect(result.verdict).toBe("rejected");
    expect((result as { reason_codes: string[] }).reason_codes).toContain("ZIP_REF_UNTRUSTED");
  });
});

describe("HTTP archive publisher (06B-3 W3 T0-4)", () => {
  const packageRef = {
    request_id: "req_1",
    archive_id: "archive_1",
    change_key: "change-1",
    archive_schema_version: 1,
    package_sha256: `sha256:${"a".repeat(64)}`,
    content: new TextEncoder().encode("PK-http")
  };
  const sourceRef = { project_id: "prj_http", branch_name: "main" };

  it("returns stored receipt on conforming 2xx", async () => {
    const receipt = {
      request_id: "req_1", idempotency_key: "idem_1", project_id: "prj_http",
      archive_id: "archive_1", change_key: "change-1",
      package_sha256: packageRef.package_sha256, archive_status: "stored",
      project_version: "3", stored_at: "2026-08-16T00:00:00.000Z", retryable: false
    };
    const publisher = createHttpArchivePublisher({
      baseUrl: "https://platform.test", token: "t",
      fetchImpl: (async () => new Response(JSON.stringify(receipt), { status: 200 })) as typeof fetch
    });
    const result = await publisher.commitArchive({ package_ref: packageRef, source_ref: sourceRef,
      idempotency_key: "idem_1", logical_slot: "slot" });
    expect(result.archive_status).toBe("stored");
    expect(result.project_version).toBe("3");
  });

  it("404 (new route not deployed) → retryable REMOTE_UNAVAILABLE, never legacy shape", async () => {
    const publisher = createHttpArchivePublisher({
      baseUrl: "https://platform.test", token: "t",
      fetchImpl: (async () => new Response("not found", { status: 404 })) as typeof fetch
    });
    const result = await publisher.commitArchive({ package_ref: packageRef, source_ref: sourceRef,
      idempotency_key: "idem_1", logical_slot: "slot" });
    expect(result.archive_status).toBe("failed");
    expect(result.retryable).toBe(true);
    expect(result.reason_code).toBe("REMOTE_UNAVAILABLE");
  });

  it("non-conforming 2xx body → ARCHIVE_PUBLISH_FAILED (no impersonation)", async () => {
    const publisher = createHttpArchivePublisher({
      baseUrl: "https://platform.test", token: "t",
      fetchImpl: (async () => new Response(JSON.stringify({ legacy: "shape", knowledge_status: "ok" }), { status: 200 })) as typeof fetch
    });
    const result = await publisher.commitArchive({ package_ref: packageRef, source_ref: sourceRef,
      idempotency_key: "idem_1", logical_slot: "slot" });
    expect(result.archive_status).toBe("failed");
    expect(result.reason_code).toBe("ARCHIVE_PUBLISH_FAILED");
  });

  it("network error → retryable REMOTE_UNAVAILABLE", async () => {
    const publisher = createHttpArchivePublisher({
      baseUrl: "https://platform.test", token: "t",
      fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch
    });
    const result = await publisher.commitArchive({ package_ref: packageRef, source_ref: sourceRef,
      idempotency_key: "idem_1", logical_slot: "slot" });
    expect(result.archive_status).toBe("failed");
    expect(result.retryable).toBe(true);
  });

  it("5xx → retryable publish failed; 4xx → non-retryable", async () => {
    const p500 = createHttpArchivePublisher({
      baseUrl: "https://platform.test", token: "t",
      fetchImpl: (async () => new Response("{}", { status: 500 })) as typeof fetch
    });
    expect((await p500.commitArchive({ package_ref: packageRef, source_ref: sourceRef,
      idempotency_key: "idem_1", logical_slot: "slot" })).retryable).toBe(true);
    const p403 = createHttpArchivePublisher({
      baseUrl: "https://platform.test", token: "t",
      fetchImpl: (async () => new Response("{}", { status: 403 })) as typeof fetch
    });
    expect((await p403.commitArchive({ package_ref: packageRef, source_ref: sourceRef,
      idempotency_key: "idem_1", logical_slot: "slot" })).retryable).toBe(false);
  });
});
