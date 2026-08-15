import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { REMOTE_SYNC_ARCHIVE_HTTP_ERROR_CODES, REMOTE_SYNC_ARCHIVE_HTTP_OPERATIONS,
  remoteSyncArchiveHttpScopeSchema, validateRemoteSyncArchiveCommitHttpRequest,
  validateRemoteSyncArchiveCommitHttpResponse, validateRemoteSyncArchiveErrorEnvelope,
  validateRemoteSyncArchiveLookupHttpRequest, validateRemoteSyncArchivePrepareHttpRequest,
  validateRemoteSyncArchivePrepareHttpRequestStructure,
  validateRemoteSyncArchivePrepareHttpResponse, validateRemoteSyncArchiveReceiptHttpResponse,
  validateRemoteSyncArchiveStatusHttpResponse } from "../src/index.js";

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort()
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  throw new Error("invalid canonical value");
}
const hash = (value: unknown): `sha256:${string}` => `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
const A = `sha256:${"a".repeat(64)}` as const; const B = `sha256:${"b".repeat(64)}` as const;
const source = { project_id: "project-http", branch_name: "main", actor_id: "actor-http", commit_sha: "commit-http",
  client_id: "client-http", change_key: "change-http" };
const metadata = { schema_version: 2 as const, source, archive_id: "archive-http", identities: { package_sha256: A,
  package_size_bytes: 42, archive_schema_version: 1 as const, trusted_package_receipt_hash: B,
  local_archive_receipt_hash: B, manifest_hash: B, inventory_hash: B, core_v2_projection_hash: B },
upload_ref: { ref_id: "local_archive_zip:http", sha256: A, size_bytes: 42 } };
const payloadHash = hash(metadata); const operationId = "remote_archive_operation:http"; const idempotencyKey = A;
const prepareId = `remote_archive_prepare:${hash({ operation_id: operationId, idempotency_key: idempotencyKey, payload_hash: payloadHash })}`;
const capability = "remote_archive_capability:http";
const lease = { project_id: source.project_id, branch_name: source.branch_name, actor_id: source.actor_id,
  capability_hash: hash(capability), fencing_token: 1, acquired_at: "2026-08-15T10:00:00.000Z", expires_at: "2026-08-15T10:01:00.000Z" };
const withRecordHash = (body: Record<string, unknown>) => ({ ...body, record_hash: hash(body) });
const preparedBody = { schema_version: 2, operation_id: operationId, prepare_id: prepareId, idempotency_key: idempotencyKey,
  payload_hash: payloadHash, source, archive_id: metadata.archive_id, identities: metadata.identities, upload_ref: metadata.upload_ref,
  state: "prepared", generation: 1, lease, receipt: null, failure_code: null, created_at: "2026-08-15T10:00:00.000Z",
  updated_at: "2026-08-15T10:00:00.000Z" };
const prepared = withRecordHash(preparedBody);
const claim = { operation_id: operationId, prepare_id: prepareId, source, generation: 1, fencing_token: 1, capability };
const receiptBody = { schema_version: 2, operation_id: operationId, prepare_id: prepareId, idempotency_key: idempotencyKey,
  payload_hash: payloadHash, source, archive_id: metadata.archive_id, package_sha256: A, package_size_bytes: 42,
  manifest_hash: B, trusted_package_receipt_hash: B, local_archive_receipt_hash: B, inventory_hash: B,
  core_v2_projection_hash: B, stored_at: "2026-08-15T10:00:01.000Z" };
const receiptHash = hash(receiptBody); const receipt = { ...receiptBody, receipt_id: `remote_archive_receipt:${receiptHash}`,
  receipt_hash: receiptHash };
const committedBody = { ...preparedBody, state: "committed", generation: 3, receipt, updated_at: receipt.stored_at };
const committed = withRecordHash(committedBody);
const prepare = { schema_version: 2, operation_id: operationId, idempotency_key: idempotencyKey,
  payload_hash: payloadHash, lease_ttl_ms: 60_000, metadata };
const lookup = { operation_id: operationId, source };
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("remote sync archive HTTP v1 contract", () => {
  it("keeps the shared runtime contract free of static Node builtins", async () => {
    const source = await readFile(new URL("../src/remote-sync-archive-http.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from\s+["']node:/u);
  });

  it("freezes explicit identity bindings without a legacy fallback", () => {
    expect(remoteSyncArchiveHttpScopeSchema.options).toEqual(["archive:read", "archive:write"]);
    expect(REMOTE_SYNC_ARCHIVE_HTTP_ERROR_CODES).toContain("REMOTE_ARCHIVE_COMMIT_AMBIGUOUS");
    expect(REMOTE_SYNC_ARCHIVE_HTTP_OPERATIONS.prepare_archive.identity_bindings).toEqual([
      ["path.project_id", "body.metadata.source.project_id"], ["path.branch_name", "body.metadata.source.branch_name"],
      ["auth.actor_id", "body.metadata.source.actor_id"], ["header.Idempotency-Key", "body.idempotency_key"]]);
    expect(REMOTE_SYNC_ARCHIVE_HTTP_OPERATIONS.archive_status.identity_bindings)
      .toContainEqual(["path.project_id", "query.source.project_id"]);
    expect(REMOTE_SYNC_ARCHIVE_HTTP_OPERATIONS.prepare_archive.errors[409])
      .toContain("REMOTE_ARCHIVE_CAPABILITY_UNAVAILABLE");
    expect(JSON.stringify(REMOTE_SYNC_ARCHIVE_HTTP_OPERATIONS)).not.toContain("archive-package");
  });

  it("accepts the complete Core canonical projection", () => {
    expect(validateRemoteSyncArchivePrepareHttpRequest(prepare)).toEqual({ success: true, data: prepare });
    expect(validateRemoteSyncArchivePrepareHttpResponse(wire({ outcome: "new", claim, record: prepared })).success).toBe(true);
    expect(validateRemoteSyncArchivePrepareHttpResponse(wire({ outcome: "replay", claim: null, record: prepared })).success).toBe(true);
    expect(validateRemoteSyncArchiveCommitHttpRequest({ claim, idempotency_key: idempotencyKey, payload_hash: payloadHash }).success).toBe(true);
    expect(validateRemoteSyncArchiveCommitHttpResponse(wire({ outcome: "new", record: committed, receipt })).success).toBe(true);
    expect(validateRemoteSyncArchiveLookupHttpRequest(lookup).success).toBe(true);
    expect(validateRemoteSyncArchiveStatusHttpResponse({ operation_id: operationId, state: "unknown", record: null }).success).toBe(true);
    expect(validateRemoteSyncArchiveReceiptHttpResponse({ receipt: null }).success).toBe(true);
  });

  it("rejects hash, identity, capability, state, fencing, and time drift", () => {
    expect(validateRemoteSyncArchivePrepareHttpRequest({ ...prepare, payload_hash: B }).success).toBe(false);
    expect(validateRemoteSyncArchivePrepareHttpRequestStructure({ ...prepare, payload_hash: B }))
      .toEqual({ success: true, data: { ...prepare, payload_hash: B } });
    const operationPrefix = "remote_archive_operation:";
    expect(validateRemoteSyncArchiveLookupHttpRequest({ ...lookup,
      operation_id: `${operationPrefix}${"x".repeat(215)}` }).success).toBe(true);
    expect(validateRemoteSyncArchiveLookupHttpRequest({ ...lookup,
      operation_id: `${operationPrefix}${"x".repeat(216)}` }).success).toBe(false);
    const capabilityPrefix = "remote_archive_capability:";
    expect(validateRemoteSyncArchiveCommitHttpRequest({ idempotency_key: idempotencyKey, payload_hash: payloadHash, claim: { ...claim,
      capability: `${capabilityPrefix}${"x".repeat(214)}` } }).success).toBe(true);
    expect(validateRemoteSyncArchiveCommitHttpRequest({ idempotency_key: idempotencyKey, payload_hash: payloadHash, claim: { ...claim,
      capability: `${capabilityPrefix}${"x".repeat(215)}` } }).success).toBe(false);
    expect(validateRemoteSyncArchivePrepareHttpResponse(wire({ outcome: "new", claim,
      record: { ...prepared, prepare_id: `remote_archive_prepare:${A}` } })).success).toBe(false);
    expect(validateRemoteSyncArchivePrepareHttpResponse(wire({ outcome: "new", claim: { ...claim, capability: "remote_archive_capability:wrong" },
      record: prepared })).success).toBe(false);
    expect(validateRemoteSyncArchivePrepareHttpResponse(wire({ outcome: "new", claim: { ...claim, fencing_token: 0 }, record: prepared })).success).toBe(false);
    expect(validateRemoteSyncArchivePrepareHttpResponse(wire({ outcome: "new", claim: null, record: prepared })).success).toBe(false);
    expect(validateRemoteSyncArchivePrepareHttpResponse(wire({ outcome: "replay", claim, record: prepared })).success).toBe(false);
    expect(validateRemoteSyncArchivePrepareHttpResponse(wire({ outcome: "new", claim,
      record: { ...prepared, updated_at: "2026-08-15T09:59:59.000Z" } })).success).toBe(false);
    expect(validateRemoteSyncArchiveCommitHttpResponse(wire({ outcome: "new", record: committed,
      receipt: { ...receipt, manifest_hash: A } })).success).toBe(false);
    expect(validateRemoteSyncArchiveCommitHttpResponse(wire({ outcome: "new", record: { ...committed, generation: 2 }, receipt })).success).toBe(false);
    const longLease = { ...lease, expires_at: "2026-08-15T10:10:00.001Z" };
    expect(validateRemoteSyncArchivePrepareHttpResponse(wire({ outcome: "replay", claim: null,
      record: withRecordHash({ ...preparedBody, lease: longLease }) })).success).toBe(false);
    const failedGenerationOne = withRecordHash({ ...preparedBody, state: "failed", generation: 1, lease: null,
      failure_code: "REMOTE_ARCHIVE_PREPARE_EXPIRED", updated_at: "2026-08-15T10:00:01.000Z" });
    expect(validateRemoteSyncArchiveStatusHttpResponse({ operation_id: operationId,
      state: "failed", record: failedGenerationOne }).success).toBe(false);
  });

  it("executes no hostile proxy, accessor, or thenable trap", async () => {
    let traps = 0;
    const proxy = new Proxy(prepare, { get: () => { traps += 1; throw new Error("trap"); } });
    const accessor = Object.defineProperty({}, "schema_version", { enumerable: true, get: () => { traps += 1; throw new Error("trap"); } });
    const thenable = Object.defineProperty({}, "then", { enumerable: true, get: () => { traps += 1; throw new Error("trap"); } });
    expect(validateRemoteSyncArchivePrepareHttpRequest(proxy).success).toBe(false);
    expect(validateRemoteSyncArchivePrepareHttpRequest(accessor).success).toBe(false);
    expect(validateRemoteSyncArchivePrepareHttpRequest(thenable).success).toBe(false);
    await Promise.resolve(); expect(traps).toBe(0);
  });

  it("bounds public error details", () => {
    const error = { error: { code: "VALIDATION_FAILED", message: "invalid", request_id: randomUUID(),
      details: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`k${index}`, "v"])) } };
    expect(validateRemoteSyncArchiveErrorEnvelope(error).success).toBe(false);
    expect(validateRemoteSyncArchiveErrorEnvelope({ ...error, error: { ...error.error,
      details: { field: "x".repeat(2_001) } } }).success).toBe(false);
  });

  it("parses the stable fixture without ZIP bytes", async () => {
    const serialized = await readFile(new URL("./fixtures/remote-sync-archive-http-v1-current.json", import.meta.url), "utf8");
    const fixture = JSON.parse(serialized) as Record<string, unknown>;
    expect(`${JSON.stringify(fixture)}\n`).toBe(serialized);
    expect(validateRemoteSyncArchivePrepareHttpRequest(fixture.prepare_request).success).toBe(true);
    expect(validateRemoteSyncArchiveCommitHttpRequest(fixture.commit_request).success).toBe(true);
    expect(validateRemoteSyncArchiveLookupHttpRequest(fixture.lookup_request).success).toBe(true);
    expect(validateRemoteSyncArchiveStatusHttpResponse(fixture.unknown_status_response).success).toBe(true);
    expect(validateRemoteSyncArchiveReceiptHttpResponse(fixture.unknown_receipt_response).success).toBe(true);
    expect(serialized).not.toMatch(/archive-package|package_bytes|"bytes"/u);
  });
});
