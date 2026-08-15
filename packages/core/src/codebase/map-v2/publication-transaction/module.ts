import { isProxy } from "node:util/types";

import { discriminateTrustedAsyncResult } from "../../../trusted-async-result/index.js";
import type { TrustedAsyncResult } from "../../../trusted-async-result/index.js";
import { CODEBASE_MAP_PUBLICATION_TARGETS, CODEBASE_MAP_V2_DOCUMENTS } from "../types.js";
import type { MapPublicationTargetPath } from "../types.js";
import { projectMapManifest } from "../manifest.js";
import { contentHash, stableHash, stableJson } from "../stable.js";
import type {
  MapPublicationCommitOutcome,
  MapPublicationCommitRequest,
  MapPublicationFilesystemTransactionPort,
  MapPublicationReadback,
  MapPublicationPortInspection,
  MapPublicationRollbackOutcome,
  MapPublicationRollbackRequest,
  MapPublicationTransactionInspection,
  MapPublicationTransactionBinding,
  MapPublicationTransactionModule,
  MapPublicationTransactionReceipt
} from "./types.js";

const sha = /^sha256:[a-f0-9]{64}$/u;
const identity = /^[a-z][a-z0-9_.:-]{0,159}$/u;
const MAX_NODES = 50_000;
const MAX_DEPTH = 48;
const MAX_STRING = 2_000_000;
const MAX_TOTAL_STRING = 12_000_000;

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function snapshot(input: unknown): unknown {
  let nodes = 0;
  let stringUnits = 0;
  function copy(value: unknown, depth: number): unknown {
    if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "string") {
      stringUnits += value.length;
      if (value.length > MAX_STRING || stringUnits > MAX_TOTAL_STRING) throw new Error("bound");
      return value;
    }
    if (typeof value !== "object" || isProxy(value) || depth > MAX_DEPTH || ++nodes > MAX_NODES) throw new Error("unsafe");
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error("prototype");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key === "symbol")) throw new Error("symbol");
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined ||
          (key !== "length" && descriptor.enumerable !== true)) throw new Error("descriptor");
    }
    if (array) {
      const length = descriptors.length?.value as unknown;
      if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > 50_000 ||
          keys.length !== (length as number) + 1) throw new Error("array");
      const result: unknown[] = [];
      for (let index = 0; index < (length as number); index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !("value" in descriptor)) throw new Error("sparse");
        result.push(copy(descriptor.value, depth + 1));
      }
      return result;
    }
    const result: Record<string, unknown> = {};
    for (const key of keys as string[]) result[key] = copy((descriptors[key] as PropertyDescriptor).value, depth + 1);
    return result;
  }
  return copy(input, 0);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}
function same(left: unknown, right: unknown): boolean { return stableHash(left) === stableHash(right); }
function canonicalPartition(left: readonly unknown[], right: readonly unknown[], canonical: readonly string[]): boolean {
  if (left.some((item) => typeof item !== "string") || right.some((item) => typeof item !== "string")) return false;
  const leftSet = new Set(left as readonly string[]);
  const rightSet = new Set(right as readonly string[]);
  return leftSet.size === left.length && rightSet.size === right.length &&
    [...leftSet].every((item) => !rightSet.has(item)) && leftSet.size + rightSet.size === canonical.length &&
    same(left, canonical.filter((item) => leftSet.has(item))) && same(right, canonical.filter((item) => rightSet.has(item)));
}

function bindingFor(request: MapPublicationCommitRequest, inputHash: string,
  newManifestHash: string): MapPublicationTransactionBinding {
  const expectedPayloadHashes = Object.fromEntries(request.ownership_paths.map((path) =>
    [path, contentHash(request.plan.payloads[path])])) as Record<MapPublicationTargetPath, string>;
  return freeze({ operation_id: request.operation_id, action_id: request.action_id,
    idempotency_key: request.idempotency_key, input_hash: inputHash, plan_hash: request.plan.plan_hash,
    expected_previous_manifest: request.expected_previous_manifest, new_manifest_hash: newManifestHash,
    ownership_paths: request.ownership_paths, expected_payload_hashes: expectedPayloadHashes,
    expected_readback_hash: deriveMapPublicationReadbackHash(request) });
}

function recoveryTokenFor(binding: MapPublicationTransactionBinding): string {
  return `map_recovery:${stableHash(binding).slice(7)}`;
}

export function deriveMapPublicationReadbackHash(request: MapPublicationCommitRequest): string {
  return stableHash({ plan_hash: request.plan.plan_hash, manifest_hash: contentHash(request.plan.manifest_payload),
    payloads: request.ownership_paths.map((path) => ({ path, content_hash: contentHash(request.plan.payloads[path]) })) });
}

function deriveBindingReadbackHash(value: Record<string, unknown>): string {
  const paths = value.ownership_paths as readonly string[];
  const hashes = value.expected_payload_hashes as Record<string, unknown>;
  return stableHash({ plan_hash: value.plan_hash, manifest_hash: value.new_manifest_hash,
    payloads: paths.map((path) => ({ path, content_hash: hashes[path] })) });
}

function validBinding(value: unknown): value is MapPublicationTransactionBinding {
  return record(value) && exact(value, ["operation_id", "action_id", "idempotency_key", "input_hash", "plan_hash",
    "expected_previous_manifest", "new_manifest_hash", "ownership_paths", "expected_payload_hashes",
    "expected_readback_hash"]) &&
    typeof value.operation_id === "string" && identity.test(value.operation_id) &&
    typeof value.action_id === "string" && identity.test(value.action_id) &&
    typeof value.idempotency_key === "string" && identity.test(value.idempotency_key) &&
    typeof value.input_hash === "string" && sha.test(value.input_hash) && typeof value.plan_hash === "string" &&
    sha.test(value.plan_hash) && typeof value.new_manifest_hash === "string" && sha.test(value.new_manifest_hash) &&
    Array.isArray(value.ownership_paths) && same(value.ownership_paths, CODEBASE_MAP_PUBLICATION_TARGETS) &&
    record(value.expected_payload_hashes) &&
    same(Object.keys(value.expected_payload_hashes), CODEBASE_MAP_PUBLICATION_TARGETS) &&
    Object.values(value.expected_payload_hashes).every((hash) => typeof hash === "string" && sha.test(hash)) &&
    typeof value.expected_readback_hash === "string" && sha.test(value.expected_readback_hash) &&
    deriveBindingReadbackHash(value) === value.expected_readback_hash &&
    record(value.expected_previous_manifest) &&
    ((exact(value.expected_previous_manifest, ["state"]) && value.expected_previous_manifest.state === "absent") ||
      (exact(value.expected_previous_manifest, ["state", "manifest_hash"]) &&
       value.expected_previous_manifest.state === "sha256" &&
       typeof value.expected_previous_manifest.manifest_hash === "string" &&
       sha.test(value.expected_previous_manifest.manifest_hash)));
}

function validPlan(value: unknown): value is MapPublicationCommitRequest["plan"] {
  if (!record(value) || !exact(value, ["ok", "plan_hash", "payloads", "documents", "changed_documents",
    "preserved_documents", "manifest", "manifest_payload", "manifest_draft", "operations"]) || value.ok !== true ||
      typeof value.plan_hash !== "string" || !sha.test(value.plan_hash) || !record(value.payloads) ||
      !same(Object.keys(value.payloads), CODEBASE_MAP_PUBLICATION_TARGETS) || !record(value.manifest) ||
      typeof value.manifest_payload !== "string" || value.manifest_payload !== stableJson(value.manifest) ||
      !same(value.manifest, value.manifest_draft) || !Array.isArray(value.operations) ||
      value.operations.length !== CODEBASE_MAP_PUBLICATION_TARGETS.length + 1) return false;
  const projected = projectMapManifest(value.manifest);
  if (!projected.ok || projected.source_schema_version !== 2 || !record(value.documents) ||
      !same(Object.keys(value.documents), CODEBASE_MAP_V2_DOCUMENTS) || !Array.isArray(value.changed_documents) ||
      !Array.isArray(value.preserved_documents)) return false;
  const changed = value.changed_documents;
  const preserved = value.preserved_documents;
  if (!canonicalPartition(changed, preserved, CODEBASE_MAP_V2_DOCUMENTS)) return false;
  for (const name of CODEBASE_MAP_V2_DOCUMENTS) {
    const path = `.harness/codebase/map/${name}`;
    if (typeof value.documents[name] !== "string" || value.documents[name] !== value.payloads[path]) return false;
  }
  const summaryPayload = value.payloads[".harness/codebase/map-summary.md"];
  if (typeof summaryPayload !== "string" || value.manifest.summary_hash !== contentHash(summaryPayload)) return false;
  for (let index = 0; index < CODEBASE_MAP_PUBLICATION_TARGETS.length; index += 1) {
    const path = CODEBASE_MAP_PUBLICATION_TARGETS[index];
    const operation = value.operations[index];
    if (path === undefined || !record(operation) || !exact(operation, ["operation", "path", "content_hash"]) ||
        operation.operation !== "stage_write" || operation.path !== path ||
        typeof value.payloads[path] !== "string" || operation.content_hash !== contentHash(value.payloads[path])) return false;
  }
  const replace = value.operations.at(-1);
  if (!record(replace) || !exact(replace, ["operation", "staged_paths", "target_paths", "rollback_on_failure"],
    ["expected_previous_manifest_hash"]) || replace.operation !== "atomic_replace_set" ||
      replace.rollback_on_failure !== true || !same(replace.target_paths, CODEBASE_MAP_PUBLICATION_TARGETS) ||
      !same(replace.staged_paths, [...CODEBASE_MAP_V2_DOCUMENTS.map((name) => `map/${name}`),
        "map-summary.md", "map-manifest.json"])) return false;
  return value.plan_hash === stableHash({ payloads: value.payloads, identity: {
    project_identity: value.manifest.project_identity, repository_identity: value.manifest.repository_identity,
    input_fingerprint: value.manifest.input_fingerprint } });
}

function parseRequest(input: unknown): MapPublicationCommitRequest {
  const value = snapshot(input);
  if (!record(value) || !exact(value, ["schema_version", "operation_id", "action_id", "idempotency_key",
    "expected_previous_manifest", "ownership_paths", "plan"]) || value.schema_version !== 1 ||
      typeof value.operation_id !== "string" || !identity.test(value.operation_id) || typeof value.action_id !== "string" ||
      !identity.test(value.action_id) || typeof value.idempotency_key !== "string" || !identity.test(value.idempotency_key) ||
      !record(value.expected_previous_manifest) || !Array.isArray(value.ownership_paths) ||
      !same(value.ownership_paths, CODEBASE_MAP_PUBLICATION_TARGETS) || !validPlan(value.plan)) {
    throw new Error("MAP_PUBLICATION_TRANSACTION_INPUT_INVALID");
  }
  const expected = value.expected_previous_manifest;
  if (!(exact(expected, ["state"]) && expected.state === "absent") &&
      !(exact(expected, ["state", "manifest_hash"]) && expected.state === "sha256" &&
        typeof expected.manifest_hash === "string" && sha.test(expected.manifest_hash))) {
    throw new Error("MAP_PUBLICATION_TRANSACTION_INPUT_INVALID");
  }
  const finalOperation = value.plan.operations.at(-1);
  const planPrevious = finalOperation?.operation === "atomic_replace_set"
    ? finalOperation.expected_previous_manifest_hash
    : undefined;
  if ((expected.state === "absent" && planPrevious !== undefined) ||
      (expected.state === "sha256" && planPrevious !== expected.manifest_hash)) {
    throw new Error("MAP_PUBLICATION_TRANSACTION_INPUT_INVALID");
  }
  return freeze(value as unknown as MapPublicationCommitRequest);
}

function validReceipt(value: unknown): value is MapPublicationTransactionReceipt {
  if (!record(value) || !exact(value, ["schema_version", "receipt_id", "operation_id", "action_id", "idempotency_key",
    "plan_hash", "input_hash", "previous_manifest_hash", "new_manifest_hash", "modified_paths", "preserved_paths",
    "verification", "recovery_token", "completed_at"]) || value.schema_version !== 1 ||
      typeof value.receipt_id !== "string" || !/^map_publication_receipt:[a-f0-9]{64}$/u.test(value.receipt_id) ||
      typeof value.plan_hash !== "string" || !sha.test(value.plan_hash) || typeof value.input_hash !== "string" ||
      !sha.test(value.input_hash) || typeof value.new_manifest_hash !== "string" || !sha.test(value.new_manifest_hash) ||
      !(value.previous_manifest_hash === null || typeof value.previous_manifest_hash === "string" && sha.test(value.previous_manifest_hash)) ||
      !record(value.verification) || !exact(value.verification, ["manifest_hash_verified", "payloads_verified",
        "journal_committed", "readback_hash"]) || value.verification.manifest_hash_verified !== true ||
      value.verification.payloads_verified !== true || value.verification.journal_committed !== true ||
      typeof value.verification.readback_hash !== "string" || !sha.test(value.verification.readback_hash) ||
      typeof value.operation_id !== "string" || !identity.test(value.operation_id) ||
      typeof value.action_id !== "string" || !identity.test(value.action_id) ||
      typeof value.idempotency_key !== "string" || !identity.test(value.idempotency_key) ||
      typeof value.recovery_token !== "string" || !/^map_recovery:[a-f0-9]{64}$/u.test(value.recovery_token) ||
      typeof value.completed_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.completed_at) ||
      Number.isNaN(Date.parse(value.completed_at)) || new Date(value.completed_at).toISOString() !== value.completed_at ||
      !Array.isArray(value.modified_paths) || !Array.isArray(value.preserved_paths)) return false;
  if (!canonicalPartition(value.modified_paths, value.preserved_paths, CODEBASE_MAP_PUBLICATION_TARGETS)) {
    return false;
  }
  const { receipt_id, ...body } = value;
  return receipt_id === `map_publication_receipt:${stableHash(body).slice(7)}`;
}

function parseInspection(value: unknown, expectedOperation?: string): MapPublicationPortInspection {
  let snap: unknown;
  try { snap = snapshot(value); } catch { throw new Error("MAP_PUBLICATION_PORT_INVALID"); }
  if (!record(snap) || !exact(snap, ["operation_id", "state", "receipt", "recovery_token", "binding"]) ||
      typeof snap.operation_id !== "string" || !["prepared", "applying", "committed", "rolled_back",
        "recovery_required", "unknown", "idempotency_conflict"].includes(String(snap.state)) ||
      !(snap.receipt === null || validReceipt(snap.receipt)) ||
      !(snap.binding === null || validBinding(snap.binding)) ||
      !(snap.recovery_token === null || typeof snap.recovery_token === "string" &&
        /^map_recovery:[a-f0-9]{64}$/u.test(snap.recovery_token)) ||
      (expectedOperation !== undefined && snap.operation_id !== expectedOperation)) throw new Error("MAP_PUBLICATION_PORT_INVALID");
  const receiptBindingMismatch = snap.receipt !== null && (snap.binding === null ||
    snap.receipt.operation_id !== snap.operation_id || snap.receipt.action_id !== snap.binding.action_id ||
    snap.receipt.idempotency_key !== snap.binding.idempotency_key || snap.receipt.input_hash !== snap.binding.input_hash ||
    snap.receipt.plan_hash !== snap.binding.plan_hash || snap.receipt.new_manifest_hash !== snap.binding.new_manifest_hash ||
    snap.receipt.previous_manifest_hash !== (snap.binding.expected_previous_manifest.state === "absent" ? null :
      snap.binding.expected_previous_manifest.manifest_hash) ||
    snap.receipt.verification.readback_hash !== snap.binding.expected_readback_hash);
  if ((snap.state === "unknown" && (snap.receipt !== null || snap.recovery_token !== null || snap.binding !== null)) ||
      (snap.state === "idempotency_conflict" && (snap.receipt !== null || snap.recovery_token !== null || snap.binding !== null)) ||
      (snap.state === "committed" && (snap.receipt === null || snap.recovery_token !== snap.receipt.recovery_token)) ||
      (snap.state === "rolled_back" && (snap.receipt === null || snap.recovery_token !== snap.receipt.recovery_token)) ||
      (["prepared", "applying", "recovery_required"].includes(String(snap.state)) &&
        (snap.receipt !== null || snap.recovery_token === null)) ||
      (snap.state !== "unknown" && snap.state !== "idempotency_conflict" && snap.binding === null) ||
      (snap.binding !== null && (snap.binding.operation_id !== snap.operation_id ||
        snap.recovery_token !== recoveryTokenFor(snap.binding))) || receiptBindingMismatch) {
    throw new Error("MAP_PUBLICATION_PORT_INVALID");
  }
  return freeze(snap as unknown as MapPublicationPortInspection);
}

type PortMethod = (...args: readonly unknown[]) => unknown;
function ownMethod(port: unknown, name: keyof MapPublicationFilesystemTransactionPort): PortMethod {
  if (port === null || (typeof port !== "object" && typeof port !== "function") || isProxy(port)) {
    throw new Error("MAP_PUBLICATION_PORT_INVALID");
  }
  const descriptor = Object.getOwnPropertyDescriptor(port, name);
  if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "function") {
    throw new Error("MAP_PUBLICATION_PORT_INVALID");
  }
  if (isProxy(descriptor.value)) throw new Error("MAP_PUBLICATION_PORT_INVALID");
  return (...args) => Reflect.apply(descriptor.value as PortMethod, port, args);
}

async function portResult(method: PortMethod, ...args: readonly unknown[]): Promise<unknown> {
  const raw = method(...args);
  const trusted = discriminateTrustedAsyncResult(raw);
  if (trusted === undefined) throw new Error("MAP_PUBLICATION_PORT_INVALID");
  return trusted.kind === "sync" ? trusted.value : await trusted.promise;
}

function beginPortCall(method: PortMethod, ...args: readonly unknown[]):
  { readonly kind: "transport_throw" } | { readonly kind: "trusted"; readonly result: TrustedAsyncResult<unknown> } {
  let raw: unknown;
  try { raw = method(...args); } catch { return { kind: "transport_throw" }; }
  const trusted = discriminateTrustedAsyncResult(raw);
  if (trusted === undefined) throw new Error("MAP_PUBLICATION_PORT_INVALID");
  return { kind: "trusted", result: trusted };
}

function parseRollback(value: unknown): MapPublicationRollbackOutcome {
  let snap: unknown;
  try { snap = snapshot(value); } catch { throw new Error("MAP_PUBLICATION_PORT_INVALID"); }
  if (!record(snap)) throw new Error("MAP_PUBLICATION_PORT_INVALID");
  const rolledBack = snap.outcome === "rolled_back" && exact(snap, ["outcome", "resulting_manifest_hash"]) &&
    (snap.resulting_manifest_hash === null || typeof snap.resulting_manifest_hash === "string" && sha.test(snap.resulting_manifest_hash));
  const terminal = (snap.outcome === "conflict" || snap.outcome === "not_found") && exact(snap, ["outcome"]);
  if (!rolledBack && !terminal) {
    throw new Error("MAP_PUBLICATION_PORT_INVALID");
  }
  return freeze(snap as unknown as MapPublicationRollbackOutcome);
}

function parseReadback(value: unknown, operationId: string): MapPublicationReadback {
  let snap: unknown;
  try { snap = snapshot(value); } catch { throw new Error("MAP_PUBLICATION_PORT_INVALID"); }
  if (!record(snap) || !exact(snap, ["operation_id", "live_manifest_hash", "payload_hashes", "journal_committed"]) ||
      snap.operation_id !== operationId || !(snap.live_manifest_hash === null || typeof snap.live_manifest_hash === "string" &&
      sha.test(snap.live_manifest_hash)) || !record(snap.payload_hashes) || typeof snap.journal_committed !== "boolean") {
    throw new Error("MAP_PUBLICATION_PORT_INVALID");
  }
  const keys = Object.keys(snap.payload_hashes);
  if (!(keys.length === 0 && snap.journal_committed === false) && !same(keys, CODEBASE_MAP_PUBLICATION_TARGETS)) {
    throw new Error("MAP_PUBLICATION_PORT_INVALID");
  }
  if (Object.values(snap.payload_hashes).some((hash) => typeof hash !== "string" || !sha.test(hash))) {
    throw new Error("MAP_PUBLICATION_PORT_INVALID");
  }
  return freeze(snap as unknown as MapPublicationReadback);
}

function committed(inspection: MapPublicationTransactionInspection, replay: boolean): MapPublicationCommitOutcome {
  if (inspection.state !== "committed" || inspection.receipt === null) throw new Error("MAP_PUBLICATION_PORT_INVALID");
  return freeze({ outcome: replay ? "replayed" as const : "committed" as const, receipt: inspection.receipt,
    no_changes: replay || inspection.receipt.modified_paths.length === 0 });
}

function receiptMatchesRequest(inspection: MapPublicationTransactionInspection, request: MapPublicationCommitRequest,
  inputHash: string, newHash: string, expectedModified?: readonly string[], expectedPreserved?: readonly string[]): boolean {
  const receipt = inspection.receipt;
  const previous = request.expected_previous_manifest.state === "absent" ? null :
    request.expected_previous_manifest.manifest_hash;
  return receipt !== null && receipt.operation_id === request.operation_id && receipt.action_id === request.action_id &&
    receipt.idempotency_key === request.idempotency_key && receipt.plan_hash === request.plan.plan_hash &&
    receipt.input_hash === inputHash && receipt.previous_manifest_hash === previous && receipt.new_manifest_hash === newHash &&
    receipt.verification.readback_hash === deriveMapPublicationReadbackHash(request) &&
    (expectedModified === undefined || same(receipt.modified_paths, expectedModified)) &&
    (expectedPreserved === undefined || same(receipt.preserved_paths, expectedPreserved));
}

export function createMapPublicationTransaction(port: MapPublicationFilesystemTransactionPort): MapPublicationTransactionModule {
  const inspectPort = ownMethod(port, "inspect");
  const preparePort = ownMethod(port, "prepare");
  const applyPort = ownMethod(port, "apply");
  const recoverPort = ownMethod(port, "recover");
  const rollbackPort = ownMethod(port, "rollback");
  const readbackPort = ownMethod(port, "readback");
  async function verifyPublished(inspection: MapPublicationTransactionInspection): Promise<void> {
    if (inspection.state !== "committed" || inspection.receipt === null || inspection.binding === null) {
      throw new Error("MAP_PUBLICATION_PORT_INVALID");
    }
    const binding = inspection.binding;
    const receipt = inspection.receipt;
    const readback = parseReadback(await portResult(readbackPort, inspection.operation_id), inspection.operation_id);
    const hash = stableHash({ plan_hash: binding.plan_hash,
      manifest_hash: binding.new_manifest_hash,
      payloads: binding.ownership_paths.map((path) => ({ path, content_hash: binding.expected_payload_hashes[path] })) });
    const payloadsMatch = binding.ownership_paths.every((path) =>
      readback.payload_hashes[path] === binding.expected_payload_hashes[path]);
    if (readback.live_manifest_hash !== binding.new_manifest_hash || readback.journal_committed !== true ||
        Object.keys(readback.payload_hashes).length !== binding.ownership_paths.length ||
        !payloadsMatch || hash !== binding.expected_readback_hash || hash !== receipt.verification.readback_hash) {
      throw new Error("MAP_PUBLICATION_PORT_INVALID");
    }
  }
  async function inspect(operationId: string): Promise<MapPublicationTransactionInspection> {
    if (!identity.test(operationId)) throw new Error("MAP_PUBLICATION_TRANSACTION_INPUT_INVALID");
    const result = parseInspection(await portResult(inspectPort, operationId), operationId);
    if (result.state === "idempotency_conflict") throw new Error("MAP_PUBLICATION_PORT_INVALID");
    return result;
  }
  return freeze({
    async commitPublication(input) {
      let request: MapPublicationCommitRequest;
      try { request = parseRequest(input); }
      catch { throw new Error("MAP_PUBLICATION_TRANSACTION_INPUT_INVALID"); }
      const inputHash = stableHash(request);
      const newHash = contentHash(request.plan.manifest_payload);
      const expectedBinding = bindingFor(request, inputHash, newHash);
      const token = recoveryTokenFor(expectedBinding);
      const existing = parseInspection(await portResult(inspectPort, request.operation_id, request.idempotency_key),
        request.operation_id);
      if (existing.state === "committed") {
        if (!receiptMatchesRequest(existing, request, inputHash, newHash)) {
          return freeze({ outcome: "idempotency_conflict" });
        }
        await verifyPublished(existing);
        return committed(existing, true);
      }
      if (existing.state === "idempotency_conflict") return freeze({ outcome: "idempotency_conflict" });
      if (existing.state !== "unknown") {
        if (!same(existing.binding, expectedBinding)) return freeze({ outcome: "idempotency_conflict" });
        if (existing.recovery_token === null) throw new Error("MAP_PUBLICATION_PORT_INVALID");
        return freeze({ outcome: "recovery_required", operation_id: request.operation_id,
          recovery_token: existing.recovery_token });
      }
      const baseline = parseReadback(await portResult(readbackPort, request.operation_id), request.operation_id);
      const manifestPath = ".harness/codebase/map-manifest.json";
      const expectedModified = request.ownership_paths.filter((path) =>
        baseline.payload_hashes[path] !== contentHash(request.plan.payloads[path]) ||
        (path === manifestPath && baseline.live_manifest_hash !== newHash));
      const modifiedSet = new Set(expectedModified);
      const expectedPreserved = request.ownership_paths.filter((path) => !modifiedSet.has(path));
      const prepared = parseInspection(await portResult(preparePort, request, inputHash, newHash, token), request.operation_id);
      if (prepared.state === "idempotency_conflict") return freeze({ outcome: "idempotency_conflict" });
      if (prepared.state !== "unknown" && !same(prepared.binding, expectedBinding)) {
        throw new Error("MAP_PUBLICATION_PORT_INVALID");
      }
      if (prepared.state === "committed") {
        if (!receiptMatchesRequest(prepared, request, inputHash, newHash, expectedModified, expectedPreserved)) {
          throw new Error("MAP_PUBLICATION_PORT_INVALID");
        }
        await verifyPublished(prepared);
        return committed(prepared, false);
      }
      if (prepared.state === "unknown") return freeze({ outcome: "stale" });
      if (prepared.state === "recovery_required") return freeze({ outcome: "recovery_required",
        operation_id: request.operation_id, recovery_token: token });
      const invocation = beginPortCall(applyPort, request.operation_id, token);
      if (invocation.kind === "transport_throw") {
        return freeze({ outcome: "recovery_required", operation_id: request.operation_id, recovery_token: token });
      }
      let rawApplied: unknown;
      if (invocation.result.kind === "sync") rawApplied = invocation.result.value;
      else {
        try { rawApplied = await invocation.result.promise; }
        catch { return freeze({ outcome: "recovery_required", operation_id: request.operation_id,
          recovery_token: token }); }
      }
      const applied = parseInspection(rawApplied, request.operation_id);
      if (applied.state !== "unknown" && applied.state !== "idempotency_conflict" &&
          !same(applied.binding, expectedBinding)) throw new Error("MAP_PUBLICATION_PORT_INVALID");
      if (applied.state === "committed" &&
          !receiptMatchesRequest(applied, request, inputHash, newHash, expectedModified, expectedPreserved)) {
        throw new Error("MAP_PUBLICATION_PORT_INVALID");
      }
      if (applied.state === "committed") await verifyPublished(applied);
      return applied.state === "committed" ? committed(applied, false) : freeze({ outcome: "recovery_required",
        operation_id: request.operation_id, recovery_token: token });
    },
    inspect,
    async recover(operationId) {
      const current = await inspect(operationId);
      if (current.state === "committed") {
        await verifyPublished(current);
        return committed(current, true);
      }
      if (current.recovery_token === null || current.state === "unknown" || current.state === "rolled_back") {
        throw new Error("MAP_PUBLICATION_RECOVERY_NOT_FOUND");
      }
      const recovered = parseInspection(await portResult(recoverPort, operationId, current.recovery_token), operationId);
      if (recovered.state !== "unknown" && recovered.state !== "idempotency_conflict" &&
          !same(recovered.binding, current.binding)) throw new Error("MAP_PUBLICATION_PORT_INVALID");
      if (recovered.state === "committed") await verifyPublished(recovered);
      return recovered.state === "committed" ? committed(recovered, false) : freeze({ outcome: "recovery_required",
        operation_id: operationId, recovery_token: current.recovery_token });
    },
    async rollback(input) {
      let value: unknown;
      try { value = snapshot(input); } catch { throw new Error("MAP_PUBLICATION_TRANSACTION_INPUT_INVALID"); }
      if (!record(value) || !exact(value, ["schema_version", "operation_id", "recovery_token",
        "expected_published_manifest_hash"]) || value.schema_version !== 1 || typeof value.operation_id !== "string" ||
        !identity.test(value.operation_id) || typeof value.recovery_token !== "string" ||
        !/^map_recovery:[a-f0-9]{64}$/u.test(value.recovery_token) ||
        typeof value.expected_published_manifest_hash !== "string" || !sha.test(value.expected_published_manifest_hash)) {
        throw new Error("MAP_PUBLICATION_TRANSACTION_INPUT_INVALID");
      }
      return parseRollback(await portResult(rollbackPort, value as unknown as MapPublicationRollbackRequest));
    },
    async readback(operationId) {
      if (!identity.test(operationId)) throw new Error("MAP_PUBLICATION_TRANSACTION_INPUT_INVALID");
      return parseReadback(await portResult(readbackPort, operationId), operationId);
    },
    readReceipt(input) {
      try {
        const value = snapshot(input);
        if (record(value) && value.schema_version === 0 && exact(value, ["schema_version", "legacy_ref"]) &&
            typeof value.legacy_ref === "string") return freeze({ ok: true as const, mode: "legacy_read_only" as const,
          source_schema_version: 0 as const });
        return validReceipt(value) ? freeze({ ok: true as const, mode: "current" as const, value }) :
          freeze({ ok: false as const, reason_code: "MAP_PUBLICATION_RECEIPT_INVALID" as const });
      } catch { return freeze({ ok: false as const, reason_code: "MAP_PUBLICATION_RECEIPT_INVALID" as const }); }
    }
  });
}
