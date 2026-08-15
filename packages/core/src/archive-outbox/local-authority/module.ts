import { createHash, randomBytes } from "node:crypto";
import { isPromise, isProxy } from "node:util/types";

import type { ArchivePackageReceipt, CoreV2Projection, PublishedArchiveInventory } from "../../archive-package-builder/index.js";
import type { LocalArchiveReceipt } from "../../archive-engine/index.js";
import type { RemoteArchiveV2Receipt } from "../../remote-sync/archive/index.js";
import type { LocalArchiveZipRef } from "../types.js";
import { stableLocalArchiveAuthorityHash } from "./stable.js";
import type {
  LocalArchiveAuthority,
  LocalArchiveAuthorityCapability,
  LocalArchiveAuthorityClaim,
  LocalArchiveAuthorityClaimInput,
  LocalArchiveAuthorityCleanupClaim,
  LocalArchiveAuthorityCommitResult,
  LocalArchiveAuthorityOperationId,
  LocalArchiveAuthorityOperationSnapshot,
  LocalArchiveAuthorityPort,
  LocalArchiveAuthorityPortOperation,
  LocalArchiveAuthorityRecord,
  LocalArchiveAuthorityRegisterInput,
  LocalArchiveAuthoritySha256,
  LocalArchiveAuthorityVerificationInput,
  LocalArchiveAuthorityVerifierBridge
} from "./types.js";
import { normalizeLocalArchiveAuthorityRecord, plainDataRecord } from "./validation.js";

export class LocalArchiveAuthorityError extends Error {
  constructor(readonly code: string) { super(code); this.name = "LocalArchiveAuthorityError"; }
}

function fail(code: string): never { throw new LocalArchiveAuthorityError(code); }
function id(value: unknown, prefix: string): value is string {
  return typeof value === "string" && value.startsWith(prefix) && value.length <= 240 && value.trim() === value;
}
function bounded(value: unknown, max = 240): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value;
}
function method(object: unknown, name: string): ((...args: never[]) => unknown) | undefined {
  if (object === null || typeof object !== "object" || isProxy(object)) return undefined;
  let current: object | null = object;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor !== undefined) return "value" in descriptor && typeof descriptor.value === "function" ? descriptor.value as (...args: never[]) => unknown : undefined;
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}
async function call<T>(object: object, name: string, ...args: unknown[]): Promise<T> {
  const fn = method(object, name);
  if (fn === undefined) fail("LOCAL_ARCHIVE_AUTHORITY_PORT_INVALID");
  let output: unknown;
  try { output = fn.call(object, ...args as never[]); } catch { fail("LOCAL_ARCHIVE_AUTHORITY_PORT_INVALID"); }
  if (isProxy(output) || !isPromise(output)) fail("LOCAL_ARCHIVE_AUTHORITY_PORT_INVALID");
  try { return await output as T; } catch { fail("LOCAL_ARCHIVE_AUTHORITY_PORT_INVALID"); }
}
function now(port: LocalArchiveAuthorityPort): string {
  const fn = method(port, "clock");
  if (fn === undefined) fail("LOCAL_ARCHIVE_AUTHORITY_PORT_INVALID");
  const value = fn.call(port);
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail("LOCAL_ARCHIVE_AUTHORITY_PORT_INVALID");
  return value.toISOString();
}
function capability(): LocalArchiveAuthorityCapability {
  return `local_archive_authority_capability:${randomBytes(32).toString("base64url")}`;
}
function capHash(value: LocalArchiveAuthorityCapability): LocalArchiveAuthoritySha256 { return stableLocalArchiveAuthorityHash(value); }
function exactInput(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!plainDataRecord(value, keys)) fail("LOCAL_ARCHIVE_AUTHORITY_INPUT_INVALID");
}
function snapshotBoundedData(value: unknown): unknown {
  const seen = new WeakSet<object>(); let nodes = 0; let text = 0;
  const copy = (input: unknown, depth: number): unknown => {
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "string") { text += input.length;
      if (input.length > 65_536 || text > 1_048_576) throw new Error(); return input; }
    if (typeof input === "number") { if (!Number.isFinite(input)) throw new Error(); return input; }
    if (typeof input !== "object" || isProxy(input) || depth > 24 || ++nodes > 8_192 || seen.has(input)) throw new Error();
    seen.add(input); const array = Array.isArray(input); const prototype = Object.getPrototypeOf(input);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(input); const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) throw new Error();
    for (const key of keys as string[]) { const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined ||
          (array && key === "length" ? false : descriptor.enumerable !== true)) throw new Error(); }
    if (array) { const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > 4_096 || keys.length !== length + 1) throw new Error();
      return Array.from({ length }, (_, index) => copy((descriptors[String(index)] as PropertyDescriptor).value, depth + 1)); }
    return Object.fromEntries((keys as string[]).map((key) =>
      [key, copy((descriptors[key] as PropertyDescriptor).value, depth + 1)]));
  };
  const result = copy(value, 0);
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 2_097_152) throw new Error();
  const freeze = (input: unknown): void => {
    if (input !== null && typeof input === "object") {
      for (const child of Object.values(input)) freeze(child);
      Object.freeze(input);
    }
  };
  freeze(result);
  return result;
}
const SHA = /^sha256:[a-f0-9]{64}$/u;
const CLEANUP_LEASE_TTL_MS = 600_000;
const typedArrayLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype) as object, "length")?.get;
function snapshotPackageBytes(value: unknown): Uint8Array | undefined {
  if (typeof value !== "object" || value === null || isProxy(value) || !ArrayBuffer.isView(value) ||
      !(value instanceof Uint8Array) || typedArrayLength === undefined) return undefined;
  let length: unknown;
  try { length = typedArrayLength.call(value); } catch { return undefined; }
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > 536_870_912) return undefined;
  const copy = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) copy[index] = value[index] as number;
  return copy;
}
function canonicalInstant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const time = Date.parse(value); return Number.isFinite(time) && new Date(time).toISOString() === value;
}
function snapshotDurableReceipt(value: unknown): RemoteArchiveV2Receipt | undefined {
  let safe: unknown; try { safe = snapshotBoundedData(value); } catch { return undefined; }
  const keys = ["schema_version", "receipt_id", "operation_id", "prepare_id", "idempotency_key", "payload_hash", "source",
    "archive_id", "package_sha256", "package_size_bytes", "manifest_hash", "trusted_package_receipt_hash",
    "local_archive_receipt_hash", "inventory_hash", "core_v2_projection_hash", "stored_at", "receipt_hash"];
  if (!plainDataRecord(safe, keys) || safe.schema_version !== 2 ||
      !id(safe.receipt_id, "remote_archive_receipt:sha256:") || !id(safe.operation_id, "remote_archive_operation:") ||
      !id(safe.prepare_id, "remote_archive_prepare:sha256:") || !SHA.test(String(safe.idempotency_key)) ||
      !SHA.test(String(safe.payload_hash)) || !bounded(safe.archive_id) || !SHA.test(String(safe.package_sha256)) ||
      !Number.isSafeInteger(safe.package_size_bytes) || Number(safe.package_size_bytes) < 1 ||
      Number(safe.package_size_bytes) > 536_870_912 || !SHA.test(String(safe.manifest_hash)) ||
      !SHA.test(String(safe.trusted_package_receipt_hash)) || !SHA.test(String(safe.local_archive_receipt_hash)) ||
      !SHA.test(String(safe.inventory_hash)) || !SHA.test(String(safe.core_v2_projection_hash)) ||
      !canonicalInstant(safe.stored_at) || !SHA.test(String(safe.receipt_hash)) || !plainDataRecord(safe.source)) return undefined;
  const source = safe.source;
  const sourceKeys = Object.keys(source);
  if (sourceKeys.some((key) => !["project_id", "branch_name", "actor_id", "commit_sha", "client_id", "change_key"].includes(key)) ||
      !["project_id", "branch_name", "actor_id"].every((key) => Object.hasOwn(source, key)) ||
      !bounded(source.project_id, 160) || !bounded(source.branch_name, 160) || !bounded(source.actor_id, 160) ||
      [source.commit_sha, source.client_id, source.change_key].some((item) => item !== undefined && !bounded(item, 160))) return undefined;
  const receipt = safe as unknown as RemoteArchiveV2Receipt;
  const { receipt_hash: receiptHash, receipt_id: receiptId, ...body } = receipt;
  const expectedReceiptHash = stableLocalArchiveAuthorityHash(body);
  const prepareHash = stableLocalArchiveAuthorityHash({ operation_id: receipt.operation_id,
    idempotency_key: receipt.idempotency_key, payload_hash: receipt.payload_hash });
  return receiptHash === expectedReceiptHash && receiptId === `remote_archive_receipt:${expectedReceiptHash}` &&
    receipt.prepare_id === `remote_archive_prepare:${prepareHash}` ? receipt : undefined;
}
function recordHash(record: Omit<LocalArchiveAuthorityRecord, "record_hash">): LocalArchiveAuthoritySha256 {
  return stableLocalArchiveAuthorityHash(record);
}
function withHash(record: Omit<LocalArchiveAuthorityRecord, "record_hash">): LocalArchiveAuthorityRecord {
  const body = { ...record } as Omit<LocalArchiveAuthorityRecord, "record_hash"> & { record_hash?: LocalArchiveAuthoritySha256 };
  Reflect.deleteProperty(body, "record_hash");
  return Object.freeze({ ...body, record_hash: recordHash(body) });
}
function operation(operationId: LocalArchiveAuthorityOperationId, kind: LocalArchiveAuthorityOperationSnapshot["kind"],
  intent: unknown, entryId: LocalArchiveAuthorityRecord["entry_id"], expectedGeneration: number | null): LocalArchiveAuthorityPortOperation {
  return { operation_id: operationId, kind, intent_hash: stableLocalArchiveAuthorityHash(intent), entry_id: entryId,
    expected_generation: expectedGeneration };
}
async function commit(port: LocalArchiveAuthorityPort, op: LocalArchiveAuthorityPortOperation,
  next: LocalArchiveAuthorityRecord): Promise<LocalArchiveAuthorityRecord> {
  const result = await call<LocalArchiveAuthorityCommitResult>(port, "commit", op, next);
  if (!plainDataRecord(result) || !["committed", "replayed", "conflict"].includes(String(result.outcome)))
    fail("LOCAL_ARCHIVE_AUTHORITY_PORT_INVALID");
  if (result.outcome === "conflict") fail("LOCAL_ARCHIVE_AUTHORITY_OPERATION_CONFLICT");
  const parsed = normalizeLocalArchiveAuthorityRecord(result.record);
  if (!parsed.ok || parsed.readiness !== "ready") fail("LOCAL_ARCHIVE_AUTHORITY_PORT_INVALID");
  if (result.outcome === "committed" && parsed.record.record_hash !== next.record_hash) fail("LOCAL_ARCHIVE_AUTHORITY_PORT_INVALID");
  return parsed.record;
}
function evidenceBindings(receipt: ArchivePackageReceipt, local: LocalArchiveReceipt, inventory: PublishedArchiveInventory,
  projection: CoreV2Projection, ref: LocalArchiveZipRef, projectId: string): void {
  if (!plainDataRecord(receipt) || !plainDataRecord(local) || !plainDataRecord(inventory) || !plainDataRecord(projection) || !plainDataRecord(ref) ||
      receipt.schema_version !== 2 || local.schema_version !== 1 || inventory.schema_version !== 1 || projection.schema_version !== 2 ||
      receipt.project_id !== projectId || projection.project_id !== projectId || receipt.operation_id !== local.operation_id ||
      inventory.operation_id !== local.operation_id || receipt.change_identity !== local.change_identity ||
      receipt.package_sha256 !== ref.package_sha256 || receipt.package_size_bytes !== ref.size_bytes ||
      receipt.project_version !== projection.project_version || receipt.archive_id !== projection.archive_id) fail("LOCAL_ARCHIVE_AUTHORITY_EVIDENCE_MISMATCH");
}

function verificationBinding(input: {
  readonly trusted_package_receipt: ArchivePackageReceipt;
  readonly local_archive_receipt: LocalArchiveReceipt;
  readonly local_zip_ref: LocalArchiveZipRef;
}): Record<string, unknown> {
  return { project_id: input.trusted_package_receipt.project_id, archive_id: input.trusted_package_receipt.archive_id,
    trusted_package_receipt_hash: input.trusted_package_receipt.receipt_hash,
    local_archive_receipt_hash: input.trusted_package_receipt.source_receipt_hash,
    manifest_hash: input.trusted_package_receipt.manifest_sha256,
    inventory_hash: input.trusted_package_receipt.local_inventory_hash,
    core_v2_projection_hash: input.trusted_package_receipt.projection_hash,
    ref_id: input.local_zip_ref.ref_id, package_sha256: input.local_zip_ref.package_sha256,
    size_bytes: input.local_zip_ref.size_bytes };
}

function durableMatches(record: LocalArchiveAuthorityRecord, durable: RemoteArchiveV2Receipt): boolean {
  return durable.source.project_id === record.project_id && durable.archive_id === record.archive_id &&
    durable.package_sha256 === record.package_sha256 && durable.package_size_bytes === record.size_bytes &&
    durable.trusted_package_receipt_hash === record.trusted_package_receipt_hash &&
    durable.local_archive_receipt_hash === record.local_archive_receipt_hash && durable.manifest_hash === record.manifest_hash &&
    durable.inventory_hash === record.inventory_hash && durable.core_v2_projection_hash === record.core_v2_projection_hash &&
    Date.parse(durable.stored_at) >= Date.parse(record.created_at);
}

export function createLocalArchiveAuthority(options: {
  readonly port: LocalArchiveAuthorityPort;
  readonly verifier_bridge: LocalArchiveAuthorityVerifierBridge;
}): LocalArchiveAuthority {
  if (!plainDataRecord(options, ["port", "verifier_bridge"]) || method(options.port, "read") === undefined ||
      method(options.port, "findBinding") === undefined || method(options.port, "inspectOperation") === undefined ||
      method(options.port, "commit") === undefined || method(options.port, "putBlob") === undefined ||
      method(options.port, "readBlob") === undefined || method(options.port, "deleteBlob") === undefined ||
      method(options.port, "clock") === undefined || method(options.verifier_bridge, "verify") === undefined)
    fail("LOCAL_ARCHIVE_AUTHORITY_INPUT_INVALID");
  const { port, verifier_bridge: bridge } = options;

  async function replay(operationId: LocalArchiveAuthorityOperationId,
    kind: LocalArchiveAuthorityOperationSnapshot["kind"], intentHash: LocalArchiveAuthoritySha256): Promise<LocalArchiveAuthorityRecord | undefined> {
    const inspected = await call<unknown>(port, "inspectOperation", operationId);
    if (inspected === undefined) return undefined;
    if (!plainDataRecord(inspected, ["operation", "record"]) || !plainDataRecord(inspected.operation) ||
        inspected.operation.kind !== kind || inspected.operation.intent_hash !== intentHash)
      fail("LOCAL_ARCHIVE_AUTHORITY_OPERATION_CONFLICT");
    const parsed = normalizeLocalArchiveAuthorityRecord(inspected.record);
    if (!parsed.ok || parsed.readiness !== "ready") fail("LOCAL_ARCHIVE_AUTHORITY_PORT_INVALID");
    return parsed.record;
  }

  async function register(input: LocalArchiveAuthorityRegisterInput): Promise<LocalArchiveAuthorityRecord> {
    exactInput(input, ["operation_id", "authority_id", "project_id", "trusted_package_receipt", "local_archive_receipt", "inventory",
      "core_v2_projection", "local_zip_ref", "package_bytes"]);
    if (!id(input.operation_id, "local_archive_authority_operation:") || !id(input.authority_id, "local_archive_authority:") ||
        !bounded(input.project_id))
      fail("LOCAL_ARCHIVE_AUTHORITY_INPUT_INVALID");
    const packageBytes = snapshotPackageBytes(input.package_bytes);
    if (packageBytes === undefined) fail("LOCAL_ARCHIVE_AUTHORITY_INPUT_INVALID");
    let verificationInput: LocalArchiveAuthorityVerificationInput;
    try { verificationInput = snapshotBoundedData({ trusted_package_receipt: input.trusted_package_receipt,
      local_archive_receipt: input.local_archive_receipt, inventory: input.inventory,
      core_v2_projection: input.core_v2_projection, local_zip_ref: input.local_zip_ref }) as LocalArchiveAuthorityVerificationInput; }
    catch { fail("LOCAL_ARCHIVE_AUTHORITY_INPUT_INVALID"); }
    const actualPackageHash = `sha256:${createHash("sha256").update(packageBytes).digest("hex")}`;
    if (verificationInput.local_zip_ref.size_bytes !== packageBytes.byteLength ||
        verificationInput.local_zip_ref.package_sha256 !== actualPackageHash) fail("LOCAL_ARCHIVE_AUTHORITY_INPUT_INVALID");
    evidenceBindings(verificationInput.trusted_package_receipt, verificationInput.local_archive_receipt,
      verificationInput.inventory, verificationInput.core_v2_projection, verificationInput.local_zip_ref, input.project_id);
    const expectedVerificationHash = stableLocalArchiveAuthorityHash(verificationBinding(verificationInput));
    const binding = { authority_id: input.authority_id, project_id: input.project_id, ref_id: verificationInput.local_zip_ref.ref_id,
      package_sha256: verificationInput.local_zip_ref.package_sha256, size_bytes: verificationInput.local_zip_ref.size_bytes,
      verification_hash: expectedVerificationHash };
    const bindingHash = stableLocalArchiveAuthorityHash(binding);
    const entryId = `local_archive_authority_entry:${bindingHash.slice(7)}` as const;
    const intent = stableLocalArchiveAuthorityHash({ ...binding,
      package_receipt_hash: verificationInput.trusted_package_receipt.receipt_hash });
    const op = operation(input.operation_id, "register", intent, entryId, null);
    const replayed = await replay(input.operation_id, "register", op.intent_hash);
    if (replayed !== undefined) return replayed;
    const existing = await call<unknown>(port, "findBinding", input.project_id, verificationInput.local_zip_ref.ref_id);
    if (existing !== undefined) fail("LOCAL_ARCHIVE_AUTHORITY_OPERATION_CONFLICT");
    const evidence = await call<unknown>(bridge, "verify", verificationInput);
    if (!plainDataRecord(evidence, ["schema_version", "verdict", "verification_hash"]) || evidence.schema_version !== 1 ||
        evidence.verdict !== "verified" || evidence.verification_hash !== expectedVerificationHash)
      fail("LOCAL_ARCHIVE_AUTHORITY_VERIFICATION_FAILED");
    const timestamp = now(port);
    const body = { schema_version: 2 as const, entry_id: entryId, authority_id: input.authority_id, project_id: input.project_id,
      ref_id: verificationInput.local_zip_ref.ref_id, package_sha256: verificationInput.local_zip_ref.package_sha256,
      size_bytes: verificationInput.local_zip_ref.size_bytes, archive_id: verificationInput.trusted_package_receipt.archive_id,
      trusted_package_receipt_hash: verificationInput.trusted_package_receipt.receipt_hash,
      local_archive_receipt_hash: verificationInput.trusted_package_receipt.source_receipt_hash,
      manifest_hash: verificationInput.trusted_package_receipt.manifest_sha256,
      inventory_hash: verificationInput.trusted_package_receipt.local_inventory_hash,
      core_v2_projection_hash: verificationInput.trusted_package_receipt.projection_hash,
      verification_hash: expectedVerificationHash,
      storage_kind: "project_state_cas" as const, binding_hash: bindingHash, state: "available" as const, generation: 0,
      lease: null, durable_receipt_hash: null, cleanup: { state: "not_allowed" as const, generation: 0, lease: null },
      last_operation: { operation_id: input.operation_id, kind: "register" as const, intent_hash: op.intent_hash },
      created_at: timestamp, updated_at: timestamp };
    await call<undefined>(port, "putBlob", input.project_id, verificationInput.local_zip_ref.ref_id,
      verificationInput.local_zip_ref.package_sha256, verificationInput.local_zip_ref.size_bytes, packageBytes);
    return commit(port, op, withHash(body));
  }

  async function readRequired(entryId: LocalArchiveAuthorityRecord["entry_id"]): Promise<LocalArchiveAuthorityRecord> {
    const value = await call<unknown>(port, "read", entryId);
    const parsed = normalizeLocalArchiveAuthorityRecord(value);
    if (!parsed.ok || parsed.readiness !== "ready") fail("LOCAL_ARCHIVE_AUTHORITY_PORT_INVALID");
    return parsed.record;
  }

  async function claim(input: LocalArchiveAuthorityClaimInput): Promise<LocalArchiveAuthorityClaim> {
    exactInput(input, ["operation_id", "entry_id", "expected_generation", "owner_id", "lease_ttl_ms"]);
    if (!id(input.operation_id, "local_archive_authority_operation:") || !id(input.entry_id, "local_archive_authority_entry:") ||
        !Number.isSafeInteger(input.expected_generation) || !bounded(input.owner_id, 160) ||
        !Number.isSafeInteger(input.lease_ttl_ms) || input.lease_ttl_ms <= 0 || input.lease_ttl_ms > 86_400_000)
      fail("LOCAL_ARCHIVE_AUTHORITY_INPUT_INVALID");
    const intent = { entry_id: input.entry_id, expected_generation: input.expected_generation, owner_id: input.owner_id,
      lease_ttl_ms: input.lease_ttl_ms };
    const op = operation(input.operation_id, "claim", intent, input.entry_id, input.expected_generation);
    const replayed = await replay(input.operation_id, "claim", op.intent_hash);
    if (replayed !== undefined) {
      if (replayed.lease === null) fail("LOCAL_ARCHIVE_AUTHORITY_PORT_INVALID");
      return { outcome: "replay", entry_id: replayed.entry_id, generation: replayed.generation, capability: null,
        fencing_token: replayed.lease.fencing_token, record: replayed };
    }
    const current = await readRequired(input.entry_id);
    if (current.generation !== input.expected_generation || current.state !== "available") fail("LOCAL_ARCHIVE_AUTHORITY_FENCE_STALE");
    const raw = capability();
    const acquired = now(port);
    const expires = new Date(Date.parse(acquired) + input.lease_ttl_ms).toISOString();
    const fencing = current.generation + 1;
    const next = withHash({ ...current, state: "leased", generation: fencing,
      lease: { owner_id: input.owner_id, capability_hash: capHash(raw), fencing_token: fencing, acquired_at: acquired, expires_at: expires },
      last_operation: { operation_id: input.operation_id, kind: "claim", intent_hash: op.intent_hash }, updated_at: acquired });
    const committed = await commit(port, op, next);
    if (committed.record_hash !== next.record_hash) fail("LOCAL_ARCHIVE_AUTHORITY_CAPABILITY_UNAVAILABLE");
    return { outcome: "new", entry_id: committed.entry_id, generation: committed.generation,
      capability: raw, fencing_token: fencing, record: committed };
  }

  async function acknowledge(input: { readonly operation_id: LocalArchiveAuthorityOperationId; readonly claim: LocalArchiveAuthorityClaim;
    readonly durable_receipt: RemoteArchiveV2Receipt }): Promise<LocalArchiveAuthorityRecord> {
    exactInput(input, ["operation_id", "claim", "durable_receipt"]);
    if (!id(input.operation_id, "local_archive_authority_operation:") || !plainDataRecord(input.durable_receipt) ||
        !plainDataRecord(input.claim, ["outcome", "entry_id", "generation", "capability", "fencing_token", "record"]) ||
        !["new", "replay"].includes(String(input.claim.outcome))) fail("LOCAL_ARCHIVE_AUTHORITY_INPUT_INVALID");
    const durable = snapshotDurableReceipt(input.durable_receipt);
    if (durable === undefined) fail("LOCAL_ARCHIVE_AUTHORITY_INPUT_INVALID");
    const op = operation(input.operation_id, "acknowledge", { entry_id: input.claim.entry_id, generation: input.claim.generation,
      durable_receipt_hash: durable.receipt_hash }, input.claim.entry_id, input.claim.generation);
    const replayed = await replay(input.operation_id, "acknowledge", op.intent_hash);
    if (replayed !== undefined) {
      if (!durableMatches(replayed, durable)) fail("LOCAL_ARCHIVE_AUTHORITY_INPUT_INVALID");
      return replayed;
    }
    const current = await readRequired(input.claim.entry_id as LocalArchiveAuthorityRecord["entry_id"]);
    if (input.claim.outcome !== "new" || input.claim.capability === null || current.state !== "leased" ||
        current.generation !== input.claim.generation || current.lease === null ||
        current.lease.fencing_token !== input.claim.fencing_token || current.lease.capability_hash !== capHash(input.claim.capability as LocalArchiveAuthorityCapability))
      fail("LOCAL_ARCHIVE_AUTHORITY_FENCE_STALE");
    if (!durableMatches(current, durable)) fail("LOCAL_ARCHIVE_AUTHORITY_INPUT_INVALID");
    const timestamp = now(port);
    const next = withHash({ ...current, state: "acknowledged", generation: current.generation + 1, lease: null,
      durable_receipt_hash: durable.receipt_hash, cleanup: { state: "allowed", generation: 0, lease: null },
      last_operation: { operation_id: input.operation_id, kind: "acknowledge", intent_hash: op.intent_hash }, updated_at: timestamp });
    return commit(port, op, next);
  }

  async function claimCleanup(input: Omit<LocalArchiveAuthorityClaimInput, "lease_ttl_ms">): Promise<LocalArchiveAuthorityCleanupClaim> {
    exactInput(input, ["operation_id", "entry_id", "expected_generation", "owner_id"]);
    if (!id(input.operation_id, "local_archive_authority_operation:") || !id(input.entry_id, "local_archive_authority_entry:") ||
        !Number.isSafeInteger(input.expected_generation) || !bounded(input.owner_id, 160)) fail("LOCAL_ARCHIVE_AUTHORITY_INPUT_INVALID");
    const intent = { entry_id: input.entry_id, generation: input.expected_generation, owner_id: input.owner_id };
    const op = operation(input.operation_id, "cleanup_claim", intent, input.entry_id, input.expected_generation);
    const replayed = await replay(input.operation_id, "cleanup_claim", op.intent_hash);
    if (replayed !== undefined) {
      if (replayed.cleanup.lease === null) fail("LOCAL_ARCHIVE_AUTHORITY_PORT_INVALID");
      return { outcome: "replay", entry_id: replayed.entry_id, generation: replayed.generation, capability: null,
        fencing_token: replayed.cleanup.lease.fencing_token, record: replayed };
    }
    const current = await readRequired(input.entry_id);
    if (current.state !== "acknowledged" || current.durable_receipt_hash === null ||
        !["allowed", "pending_retry"].includes(current.cleanup.state))
      fail("LOCAL_ARCHIVE_AUTHORITY_CLEANUP_NOT_ALLOWED");
    if (current.generation !== input.expected_generation) fail("LOCAL_ARCHIVE_AUTHORITY_FENCE_STALE");
    const timestamp = now(port);
    if (current.cleanup.state === "pending_retry" && (current.cleanup.lease === null ||
        Date.parse(current.cleanup.lease.expires_at) > Date.parse(timestamp))) fail("LOCAL_ARCHIVE_AUTHORITY_CLEANUP_NOT_ALLOWED");
    const raw = capability(); const fence = current.cleanup.generation + 1;
    const expires = new Date(Date.parse(timestamp) + CLEANUP_LEASE_TTL_MS).toISOString();
    const next = withHash({ ...current, generation: current.generation + 1,
      cleanup: { state: "claimed", generation: fence, lease: { owner_id: input.owner_id, capability_hash: capHash(raw),
        fencing_token: fence, acquired_at: timestamp, expires_at: expires } },
      last_operation: { operation_id: input.operation_id, kind: "cleanup_claim", intent_hash: op.intent_hash }, updated_at: timestamp });
    const committed = await commit(port, op, next);
    return { outcome: "new", entry_id: committed.entry_id, generation: committed.generation,
      capability: raw, fencing_token: fence, record: committed };
  }

  async function completeCleanup(input: { readonly operation_id: LocalArchiveAuthorityOperationId;
    readonly claim: LocalArchiveAuthorityCleanupClaim }): Promise<LocalArchiveAuthorityRecord> {
    exactInput(input, ["operation_id", "claim"]);
    if (!id(input.operation_id, "local_archive_authority_operation:") || input.claim.outcome !== "new" || input.claim.capability === null ||
        !plainDataRecord(input.claim, ["outcome", "entry_id", "generation", "capability", "fencing_token", "record"]) ||
        !id(input.claim.entry_id, "local_archive_authority_entry:") || !Number.isSafeInteger(input.claim.generation) ||
        !Number.isSafeInteger(input.claim.fencing_token) || !id(input.claim.capability, "local_archive_authority_capability:"))
      fail("LOCAL_ARCHIVE_AUTHORITY_INPUT_INVALID");
    const intent = { entry_id: input.claim.entry_id, generation: input.claim.generation,
      cleanup_generation: input.claim.fencing_token };
    const op = operation(input.operation_id, "cleanup_complete", intent, input.claim.entry_id, input.claim.generation);
    const replayed = await replay(input.operation_id, "cleanup_complete", op.intent_hash);
    if (replayed !== undefined) return replayed;
    const current = await readRequired(input.claim.entry_id as LocalArchiveAuthorityRecord["entry_id"]);
    const timestamp = now(port);
    if (!["claimed", "pending_retry"].includes(current.cleanup.state) || current.cleanup.lease === null ||
        (current.cleanup.state === "claimed" && current.generation !== input.claim.generation) ||
        current.cleanup.generation !== input.claim.fencing_token ||
        current.cleanup.lease.fencing_token !== input.claim.fencing_token ||
        current.cleanup.lease.capability_hash !== capHash(input.claim.capability as LocalArchiveAuthorityCapability) ||
        Date.parse(current.cleanup.lease.expires_at) <= Date.parse(timestamp))
      fail("LOCAL_ARCHIVE_AUTHORITY_FENCE_STALE");
    const pendingOperationId = `${input.operation_id}:pending` as LocalArchiveAuthorityOperationId;
    const pendingOp = operation(pendingOperationId, "cleanup_complete", intent, current.entry_id,
      current.cleanup.state === "claimed" ? current.generation : current.generation - 1);
    let pending = current;
    if (current.cleanup.state === "claimed") {
      pending = await commit(port, pendingOp, withHash({ ...current, generation: current.generation + 1,
        cleanup: { ...current.cleanup, state: "pending_retry" },
        last_operation: { operation_id: pendingOperationId, kind: "cleanup_complete", intent_hash: pendingOp.intent_hash },
        updated_at: timestamp }));
    }
    await call<undefined>(port, "deleteBlob", pending.project_id, pending.ref_id, pending.package_sha256, pending.size_bytes);
    const finalOp = { ...op, expected_generation: pending.generation };
    return commit(port, finalOp, withHash({ ...pending, generation: pending.generation + 1,
      cleanup: { state: "completed", generation: pending.cleanup.generation + 1, lease: null },
      last_operation: { operation_id: input.operation_id, kind: "cleanup_complete", intent_hash: op.intent_hash }, updated_at: now(port) }));
  }

  async function recoverExpired(input: { readonly operation_id: LocalArchiveAuthorityOperationId;
    readonly entry_id: LocalArchiveAuthorityRecord["entry_id"]; readonly expected_generation: number }): Promise<LocalArchiveAuthorityRecord> {
    exactInput(input, ["operation_id", "entry_id", "expected_generation"]);
    if (!id(input.operation_id, "local_archive_authority_operation:") || !id(input.entry_id, "local_archive_authority_entry:") ||
        !Number.isSafeInteger(input.expected_generation)) fail("LOCAL_ARCHIVE_AUTHORITY_INPUT_INVALID");
    const op = operation(input.operation_id, "recover", { entry_id: input.entry_id, generation: input.expected_generation },
      input.entry_id, input.expected_generation);
    const replayed = await replay(input.operation_id, "recover", op.intent_hash);
    if (replayed !== undefined) return replayed;
    const current = await readRequired(input.entry_id);
    if (current.generation !== input.expected_generation || current.state !== "leased" || current.lease === null ||
        Date.parse(current.lease.expires_at) > Date.parse(now(port))) fail("LOCAL_ARCHIVE_AUTHORITY_FENCE_STALE");
    const timestamp = now(port);
    return commit(port, op, withHash({ ...current, state: "available", generation: current.generation + 1, lease: null,
      last_operation: { operation_id: input.operation_id, kind: "recover", intent_hash: op.intent_hash }, updated_at: timestamp }));
  }

  async function resolve(projectId: string, refId: string): Promise<Uint8Array | undefined> {
    if (!bounded(projectId) || !bounded(refId)) fail("LOCAL_ARCHIVE_AUTHORITY_INPUT_INVALID");
    // The opaque ref is scoped by project identity and resolved by the controlled authority Port; it is never parsed as a path.
    const value = await call<unknown>(port, "findBinding", projectId, refId);
    if (value === undefined) return undefined;
    const parsed = normalizeLocalArchiveAuthorityRecord(value);
    if (!parsed.ok || parsed.readiness !== "ready") fail("LOCAL_ARCHIVE_AUTHORITY_PORT_INVALID");
    const record = parsed.record;
    if (record.cleanup.state === "completed") return undefined;
    const bytes = await call<unknown>(port, "readBlob", projectId, refId, record.package_sha256, record.size_bytes);
    if (bytes === undefined) return undefined;
    if (!(bytes instanceof Uint8Array) || isProxy(bytes) || bytes.length !== record.size_bytes ||
        `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== record.package_sha256)
      fail("LOCAL_ARCHIVE_AUTHORITY_PORT_INVALID");
    return bytes.slice();
  }

  return {
    register, claim, acknowledge, claimCleanup, completeCleanup, recoverExpired, resolve
  };
}
