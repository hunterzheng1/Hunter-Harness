import { isProxy } from "node:util/types";

import { canonicalJson, planEventSchema } from "@hunter-harness/contracts";

import { discriminateTrustedAsyncResult } from "../../trusted-async-result/index.js";
import {
  derivePlanDurablePublicationFilesystemReadbackHash,
  derivePlanDurablePublicationFilesystemBinding,
  PLAN_DURABLE_PUBLICATION_FILESYSTEM_BOUNDS,
  snapshotPlanDurablePublicationFilesystemAuthority,
  snapshotPlanDurablePublicationFilesystemPrepareRequest,
  planDurablePublicationTargetPaths
} from "../durable-publication-filesystem-contract/index.js";
import { sha256Bytes } from "../../fs/hash.js";
import { PlanFinalizationTransactionError } from "./errors.js";
import type {
  PlanFinalizationEventOutboxDeliveryInput,
  PlanFinalizationEventOutboxEnqueueInput,
  PlanFinalizationEventOutboxRecord,
  PlanFinalizationExecutionContext,
  PlanFinalizationEvidence,
  PlanFinalizationFilesystemPort,
  PlanFinalizationTransactionDependencies,
  PlanFinalizationTransactionInput,
  PlanFinalizationTransactionInspection,
  PlanFinalizationTransactionModule,
  PlanFinalizationTransactionResult,
  PlanFinalizationTransactionRecord,
  PlanFinalizationTransactionStatus,
  PlanFinalizationQualityVerificationInput,
  PlanFinalizationQualityVerificationProof,
  PlanFinalizationRendererInput
} from "./types.js";
import type { PlanArtifactPublicationPlan } from "../../plan-artifacts/publication/types.js";
import type { PlanDurablePublicationBaseline, PlanDurablePublicationModule, PlanDurablePublicationReceipt,
  PlanDurablePublicationSha256 } from "../durable-publication/types.js";
import type { PlanDurablePublicationFilesystemBinding, PlanDurablePublicationFilesystemReadback, PlanDurablePublicationFilesystemTransactionInspection } from "../durable-publication-filesystem-contract/types.js";
import type { PlanFinalizationReceipt } from "../types.js";

const SHA = /^sha256:[a-f0-9]{64}$/u;
const ID = /^[a-z][a-z0-9_.:-]{0,159}$/u;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const RECOVERY = /^plan_recovery:[a-f0-9]{64}$/u;

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function hash(value: unknown): PlanDurablePublicationSha256 {
  return sha256Bytes(canonicalJson(value)) as PlanDurablePublicationSha256;
}

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch { return false; }
}

function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return keys.length >= required.length && required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
}

function snapshot(input: unknown): unknown {
  const active = new WeakSet<object>();
  let nodes = 0;
  let strings = 0;
  let byteElements = 0;
  const copy = (value: unknown, depth: number, path: readonly (string | number)[]): unknown => {
    if (value === null || typeof value === "boolean" || typeof value === "number") {
      if (typeof value === "number" && !Number.isFinite(value)) throw new Error("number");
      return value;
    }
    if (typeof value === "string") {
      strings += value.length;
      if (value.length > 2_000_000 || strings > 16_000_000) throw new Error("string");
      return value;
    }
    if (typeof value !== "object" || isProxy(value) || depth > 64 || ++nodes > 60_000 || active.has(value)) {
      throw new Error("hostile");
    }
    const array = Array.isArray(value);
    let prototype: object | null;
    try { prototype = Object.getPrototypeOf(value); } catch { throw new Error("prototype"); }
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new Error("prototype");
    }
    active.add(value);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some((key) => typeof key === "symbol")) throw new Error("symbol");
      for (const key of keys as string[]) {
        const descriptor = descriptors[key];
        if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined ||
            descriptor.set !== undefined || (key !== "length" && descriptor.enumerable !== true)) {
          throw new Error("descriptor");
        }
      }
      if (array) {
        const length = descriptors.length?.value;
        const maximum = path.at(-1) === "bytes" ? PLAN_DURABLE_PUBLICATION_FILESYSTEM_BOUNDS.max_payload_bytes : 4_096;
        if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > maximum ||
            keys.length !== (length as number) + 1) throw new Error("array");
        if (path.at(-1) === "bytes") {
          byteElements += length as number;
          if (byteElements > PLAN_DURABLE_PUBLICATION_FILESYSTEM_BOUNDS.max_total_payload_bytes) throw new Error("bytes");
        }
        const result: unknown[] = [];
        for (let index = 0; index < (length as number); index += 1) {
          const descriptor = descriptors[String(index)];
          if (descriptor === undefined || !("value" in descriptor)) throw new Error("sparse");
          result.push(copy(descriptor.value, depth + 1, [...path, index]));
        }
        return result;
      }
      const result: Record<string, unknown> = {};
      for (const key of keys as string[]) result[key] = copy(descriptors[key]?.value, depth + 1, [...path, key]);
      return result;
    } finally { active.delete(value); }
  };
  return copy(input, 0, []);
}

function text(value: unknown, maximum = 160): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value.trim() === value &&
    ![...value].some((character) => (character.codePointAt(0) ?? 0) <= 0x1f || (character.codePointAt(0) ?? 0) === 0x7f);
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || !TIME.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function safeMethod(port: unknown, name: string): (...args: readonly unknown[]) => unknown {
  if (port === null || (typeof port !== "object" && typeof port !== "function") || isProxy(port)) {
    throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_PORT_INVALID");
  }
  let current: object | null = port as object;
  for (let depth = 0; current !== null && depth < 16; depth += 1) {
    if (isProxy(current)) throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_PORT_INVALID");
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(current, name); } catch {
      throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_PORT_INVALID");
    }
    if (descriptor !== undefined) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function" || isProxy(descriptor.value)) {
        throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_PORT_INVALID");
      }
      return (...args: readonly unknown[]) => Reflect.apply(descriptor.value as (...values: readonly unknown[]) => unknown,
        port, args);
    }
    try { current = Object.getPrototypeOf(current) as object | null; } catch {
      throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_PORT_INVALID");
    }
  }
  throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_PORT_INVALID");
}

async function callPort(method: (...args: readonly unknown[]) => unknown, input: unknown): Promise<unknown> {
  let raw: unknown;
  try { raw = method(input); } catch { throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_PORT_INVALID"); }
  const trusted = discriminateTrustedAsyncResult(raw);
  if (trusted === undefined) throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_PORT_INVALID");
  let resolved: unknown;
  try { resolved = trusted.kind === "sync" ? trusted.value : await trusted.promise; }
  catch { throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_PORT_INVALID"); }
  if (resolved === undefined) return undefined;
  try { return snapshot(resolved); } catch { throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_PORT_INVALID"); }
}

function validContext(value: unknown): value is PlanFinalizationExecutionContext {
  if (!record(value) || !exact(value, ["schema_version", "project_id", "change_key", "run_id", "branch_name", "attempt", "phase", "root_authority"]) ||
      value.schema_version !== 1 || !text(value.project_id) || !ID.test(value.project_id) || !text(value.change_key) || !ID.test(value.change_key) ||
      !text(value.run_id) || !ID.test(value.run_id) || !text(value.branch_name) || !BRANCH.test(value.branch_name) ||
      !Number.isSafeInteger(value.attempt) || (value.attempt as number) < 1 ||
      !["plan", "run", "test", "review", "package", "apidoc", "submit", "merge", "archive"].includes(String(value.phase))) return false;
  try {
    const authority = snapshotPlanDurablePublicationFilesystemAuthority(value.root_authority);
    return authority.root_identity.project_identity === value.project_id &&
      authority.target_identity.change_key === value.change_key;
  } catch { return false; }
}

function finalizationReceiptValid(value: unknown, context: PlanFinalizationExecutionContext, publicationIntentId?: string): value is PlanFinalizationReceipt {
  if (!record(value) || !exact(value, ["schema_version", "status", "run_id", "change_key", "profile_ref", "artifact_set_hash",
    "layer_receipt_hashes", "publication_intent_id", "finalizer_action", "completed_at", "receipt_hash", "receipt_id"]) ||
      value.schema_version !== 1 || !["succeeded", "blocked"].includes(String(value.status)) ||
      (value.status === "succeeded" && value.finalizer_action !== "publish") || (value.status === "blocked" && value.finalizer_action !== "none") ||
      value.run_id !== context.run_id ||
      value.change_key !== context.change_key || !text(value.profile_ref) || typeof value.artifact_set_hash !== "string" || !SHA.test(value.artifact_set_hash) ||
      !Array.isArray(value.layer_receipt_hashes) || value.layer_receipt_hashes.length !== 3 || value.layer_receipt_hashes.some((item) => typeof item !== "string" || !SHA.test(item)) ||
      !text(value.publication_intent_id) || (publicationIntentId !== undefined && value.publication_intent_id !== publicationIntentId) ||
      !["publish", "none"].includes(String(value.finalizer_action)) || !timestamp(value.completed_at) || typeof value.receipt_hash !== "string" || !SHA.test(value.receipt_hash) ||
      typeof value.receipt_id !== "string" || !/^plan_quality:finalization:[a-f0-9]{64}$/u.test(value.receipt_id)) return false;
  const { receipt_hash: ignoredHash, receipt_id: ignoredId, ...body } = value;
  return ignoredHash === hash(body) && ignoredId === `plan_quality:finalization:${(ignoredHash as string).slice(7)}`;
}

function eventBundle(value: unknown, context: PlanFinalizationExecutionContext, receipt: PlanFinalizationReceipt): PlanDurablePublicationSha256 {
  if (!Array.isArray(value) || value.length < 2 || value.length > 4_096) throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_INPUT_INVALID");
  let previousSeq = 0;
  let artifactCount = 0;
  let phaseStarted = 0;
  let phaseEnded = 0;
  for (const raw of value) {
    const parsed = planEventSchema.safeParse(raw);
    if (!parsed.success) throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_INPUT_INVALID");
    const event = parsed.data;
    if (event.run_id !== context.run_id || event.change_key !== context.change_key || event.phase !== context.phase ||
        event.attempt !== context.attempt || event.producer_seq <= previousSeq) {
      throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_IDENTITY_INVALID");
    }
    previousSeq = event.producer_seq;
    const machine = { lifecycle_kind: event.lifecycle_kind, run_id: event.run_id, change_key: event.change_key,
      phase: event.phase, attempt: event.attempt, type: event.type, producer_seq: event.producer_seq };
    if (event.idempotency_key !== hash(machine) || event.event_id !== `plan_event:${hash({ ...machine, occurred_at: event.occurred_at }).slice(7)}`) {
      throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_INPUT_INVALID");
    }
    if (event.type === "phase_started") phaseStarted += 1;
    if (event.type === "phase_ended") phaseEnded += 1;
    if (event.type === "artifact_published") {
      artifactCount += 1;
      if (event.receipt_ref !== receipt.receipt_id) throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_IDENTITY_INVALID");
    }
  }
  const first = value[0] as { readonly type?: string };
  const last = value.at(-1) as { readonly type?: string };
  if (first.type !== "phase_started" || last.type !== "phase_ended" || phaseStarted !== 1 || phaseEnded !== 1 || artifactCount !== 1) {
    throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_INPUT_INVALID");
  }
  return hash({ schema_version: 1, lifecycle_kind: "change", run_id: context.run_id, change_key: context.change_key, events: value });
}

function validReadback(value: unknown, operationId: string, changeKey: string, manifestHash: string,
  expectedPayloadHashes?: Readonly<Record<string, string>>): value is PlanDurablePublicationFilesystemReadback {
  if (!record(value) || !exact(value, ["operation_id", "live_manifest_hash", "payload_hashes", "readback_hash", "journal_committed"]) ||
      value.operation_id !== operationId || value.live_manifest_hash !== manifestHash || value.journal_committed !== true ||
      typeof value.readback_hash !== "string" || !SHA.test(value.readback_hash) || !record(value.payload_hashes)) return false;
  const paths = planDurablePublicationTargetPaths(changeKey);
  const payloadHashes = value.payload_hashes as Record<string, unknown>;
  if (Object.keys(payloadHashes).length !== paths.length || !paths.every((path) => typeof payloadHashes[path] === "string" && SHA.test(payloadHashes[path] as string) &&
      (expectedPayloadHashes === undefined || payloadHashes[path] === expectedPayloadHashes[path]))) return false;
  return value.readback_hash === derivePlanDurablePublicationFilesystemReadbackHash({
    manifest_hash: manifestHash as PlanDurablePublicationSha256,
    payload_hashes: payloadHashes as Record<string, PlanDurablePublicationSha256>, change_key: changeKey
  });
}

function validFilesystemInspection(value: unknown, operationId: string, recoveryToken?: string,
  expectedBinding?: unknown, expectedIdempotencyKey?: string): value is PlanDurablePublicationFilesystemTransactionInspection {
  if (!record(value) || !exact(value, ["operation_id", "state", "receipt", "recovery_token", "binding"]) ||
      value.operation_id !== operationId || !["prepared", "applying", "committed", "rolled_back", "recovery_required", "unknown"].includes(String(value.state)) ||
      !(value.receipt === null || validReceiptShape(value.receipt)) || !(value.binding === null || record(value.binding)) ||
      !(value.recovery_token === null || typeof value.recovery_token === "string" && RECOVERY.test(value.recovery_token))) return false;
  if (value.state !== "unknown" && value.recovery_token === null) return false;
  if (value.receipt !== null && expectedIdempotencyKey !== undefined &&
      (value.receipt.operation_id !== operationId || value.receipt.idempotency_key !== expectedIdempotencyKey)) return false;
  if (recoveryToken !== undefined && value.recovery_token !== null && value.recovery_token !== recoveryToken) return false;
  if (value.state === "unknown" && (value.receipt !== null || value.recovery_token !== null || value.binding !== null)) return false;
  if (expectedBinding !== undefined && value.state !== "unknown" && (value.binding === null || hash(value.binding) !== hash(expectedBinding))) return false;
  return true;
}

function publicationReceiptValid(value: unknown, input: PlanFinalizationTransactionInput, plan: PlanArtifactPublicationPlan): value is PlanDurablePublicationReceipt {
  if (!record(value) || !exact(value, ["schema_version", "receipt_id", "operation_id", "idempotency_key", "project_id", "change_key",
    "publication_intent_id", "plan_hash", "previous_manifest_hash", "manifest_hash", "previous_generation", "generation", "modified_paths",
    "preserved_paths", "event_id", "committed_at"], ["rollback_of_operation_id"]) || Object.hasOwn(value, "rollback_of_operation_id") || value.schema_version !== 1 ||
      typeof value.receipt_id !== "string" || !/^plan_durable_publication_receipt:[a-f0-9]{64}$/u.test(value.receipt_id) ||
      value.operation_id !== input.operation_id || value.idempotency_key !== input.idempotency_key || value.project_id !== input.context.project_id ||
      value.change_key !== input.context.change_key || value.publication_intent_id !== plan.publication_intent_id || typeof value.plan_hash !== "string" || !SHA.test(value.plan_hash) ||
      value.plan_hash !== hash(plan) || value.previous_manifest_hash !== (input.expected_baseline.state === "absent" ? null : input.expected_baseline.manifest_hash) ||
      value.manifest_hash !== plan.manifest_hash || value.previous_generation !== input.expected_baseline.generation ||
      value.generation !== input.expected_baseline.generation + 1 || !Array.isArray(value.modified_paths) || !Array.isArray(value.preserved_paths) ||
      value.modified_paths.some((path) => typeof path !== "string") || value.preserved_paths.some((path) => typeof path !== "string") ||
      typeof value.event_id !== "string" || !/^plan_event:[a-f0-9]{64}$|^audit_event:sha256:[a-f0-9]{64}$/u.test(value.event_id) || !timestamp(value.committed_at)) return false;
  const paths = planDurablePublicationTargetPaths(input.context.change_key);
  const modified = value.modified_paths as readonly string[]; const preserved = value.preserved_paths as readonly string[];
  if (modified.some((path) => !paths.includes(path)) || preserved.some((path) => !paths.includes(path)) ||
      new Set(modified).size !== modified.length || new Set(preserved).size !== preserved.length || modified.some((path) => preserved.includes(path)) ||
      new Set([...modified, ...preserved]).size !== paths.length) return false;
  const { receipt_id: ignored, ...body } = value;
  return ignored === `plan_durable_publication_receipt:${hash(body).slice(7)}`;
}

function outboxId(input: { readonly operation_id: string; readonly idempotency_key: string; readonly receipt_id: string;
  readonly event_bundle_hash: string; readonly context: PlanFinalizationExecutionContext }): string {
  return `plan_event_outbox:${hash({ operation_id: input.operation_id, idempotency_key: input.idempotency_key,
    receipt_id: input.receipt_id, event_bundle_hash: input.event_bundle_hash, run_id: input.context.run_id,
    change_key: input.context.change_key, branch_name: input.context.branch_name, attempt: input.context.attempt }).slice(7)}`;
}

function validOutbox(value: unknown, input: PlanFinalizationEventOutboxEnqueueInput): value is PlanFinalizationEventOutboxRecord {
  if (!record(value) || !exact(value, ["schema_version", "record_kind", "outbox_id", "operation_id", "idempotency_key", "project_id",
    "change_key", "run_id", "branch_name", "attempt", "publication_receipt_id", "publication_generation", "publication_manifest_hash",
    "event_bundle_hash", "events", "state", "created_at", "updated_at"]) || value.schema_version !== 1 ||
      value.record_kind !== "plan_finalization_event_outbox" || value.outbox_id !== input.outbox_id || value.operation_id !== input.operation_id ||
      value.idempotency_key !== input.idempotency_key || value.project_id !== input.context.project_id || value.change_key !== input.context.change_key ||
      value.run_id !== input.context.run_id || value.branch_name !== input.context.branch_name || value.attempt !== input.context.attempt ||
      value.publication_receipt_id !== input.publication_receipt.receipt_id || value.publication_generation !== input.publication_receipt.generation ||
      value.publication_manifest_hash !== input.publication_receipt.manifest_hash || value.event_bundle_hash !== input.event_bundle_hash ||
      !Array.isArray(value.events) || value.state === undefined || !["pending", "delivered", "ambiguous", "failed"].includes(String(value.state)) ||
      !timestamp(value.created_at) || !timestamp(value.updated_at)) return false;
  const expectedBundleHash = hash({ schema_version: 1, lifecycle_kind: "change", run_id: input.context.run_id,
    change_key: input.context.change_key, events: input.events });
  const returnedBundleHash = hash({ schema_version: 1, lifecycle_kind: "change", run_id: input.context.run_id,
    change_key: input.context.change_key, events: value.events });
  return expectedBundleHash === input.event_bundle_hash && returnedBundleHash === input.event_bundle_hash;
}

function validReceiptShape(value: unknown): value is PlanDurablePublicationReceipt {
  if (!record(value) || !exact(value, ["schema_version", "receipt_id", "operation_id", "idempotency_key", "project_id", "change_key",
    "publication_intent_id", "plan_hash", "previous_manifest_hash", "manifest_hash", "previous_generation", "generation", "modified_paths",
    "preserved_paths", "event_id", "committed_at"], ["rollback_of_operation_id"]) || Object.hasOwn(value, "rollback_of_operation_id") ||
      value.schema_version !== 1 || typeof value.receipt_id !== "string" || !/^plan_durable_publication_receipt:[a-f0-9]{64}$/u.test(value.receipt_id) ||
      !text(value.operation_id) || !text(value.idempotency_key) || !text(value.project_id) || !text(value.change_key) || !ID.test(value.change_key as string) || !text(value.publication_intent_id) ||
      typeof value.plan_hash !== "string" || !SHA.test(value.plan_hash) || !(value.previous_manifest_hash === null || typeof value.previous_manifest_hash === "string" && SHA.test(value.previous_manifest_hash)) ||
      typeof value.manifest_hash !== "string" || !SHA.test(value.manifest_hash) || !Number.isSafeInteger(value.previous_generation) || (value.previous_generation as number) < 0 ||
      !Number.isSafeInteger(value.generation) || (value.generation as number) < 0 || !Array.isArray(value.modified_paths) || !Array.isArray(value.preserved_paths) ||
      value.modified_paths.some((item) => !text(item, 512)) || value.preserved_paths.some((item) => !text(item, 512)) || typeof value.event_id !== "string" ||
      !/^plan_event:[a-f0-9]{64}$|^audit_event:sha256:[a-f0-9]{64}$/u.test(value.event_id) || !timestamp(value.committed_at)) return false;
  let paths: readonly string[];
  try { paths = planDurablePublicationTargetPaths(value.change_key as string); } catch { return false; }
  const modified = value.modified_paths as readonly string[];
  const preserved = value.preserved_paths as readonly string[];
  if (modified.some((path) => !paths.includes(path)) || preserved.some((path) => !paths.includes(path)) ||
      new Set(modified).size !== modified.length || new Set(preserved).size !== preserved.length ||
      modified.some((path) => preserved.includes(path)) || new Set([...modified, ...preserved]).size !== paths.length ||
      !paths.every((path) => modified.includes(path) || preserved.includes(path))) return false;
  const { receipt_id: ignored, ...body } = value;
  return ignored === `plan_durable_publication_receipt:${hash(body).slice(7)}`;
}

function validOutboxShape(value: unknown): value is PlanFinalizationEventOutboxRecord {
  if (!record(value) || !exact(value, ["schema_version", "record_kind", "outbox_id", "operation_id", "idempotency_key", "project_id",
    "change_key", "run_id", "branch_name", "attempt", "publication_receipt_id", "publication_generation", "publication_manifest_hash",
    "event_bundle_hash", "events", "state", "created_at", "updated_at"]) || value.schema_version !== 1 ||
      value.record_kind !== "plan_finalization_event_outbox" || typeof value.outbox_id !== "string" || !/^plan_event_outbox:[a-f0-9]{64}$/u.test(value.outbox_id) ||
      !text(value.operation_id) || !text(value.idempotency_key) || !text(value.project_id) || !text(value.change_key) || !text(value.run_id) || !text(value.branch_name) ||
      !Number.isSafeInteger(value.attempt) || (value.attempt as number) < 1 || typeof value.publication_receipt_id !== "string" ||
      !/^plan_durable_publication_receipt:[a-f0-9]{64}$/u.test(value.publication_receipt_id) || !Number.isSafeInteger(value.publication_generation) || (value.publication_generation as number) < 1 ||
      typeof value.publication_manifest_hash !== "string" || !SHA.test(value.publication_manifest_hash) || typeof value.event_bundle_hash !== "string" || !SHA.test(value.event_bundle_hash) ||
      !Array.isArray(value.events) || value.events.length < 2 || value.events.length > 4_096 || value.events.some((event) => !planEventSchema.safeParse(event).success) ||
      !["pending", "delivered", "ambiguous", "failed"].includes(String(value.state)) || !timestamp(value.created_at) || !timestamp(value.updated_at)) return false;
  const events = value.events as readonly Record<string, unknown>[];
  const expectedId = `plan_event_outbox:${hash({ operation_id: value.operation_id, idempotency_key: value.idempotency_key,
    receipt_id: value.publication_receipt_id, event_bundle_hash: value.event_bundle_hash, run_id: value.run_id,
    change_key: value.change_key, branch_name: value.branch_name, attempt: value.attempt }).slice(7)}`;
  return value.outbox_id === expectedId && events.every((event) => event.run_id === value.run_id && event.change_key === value.change_key && event.attempt === value.attempt) &&
    hash({ schema_version: 1, lifecycle_kind: "change", run_id: value.run_id, change_key: value.change_key, events }) === value.event_bundle_hash;
}

function validOutboxForRecord(value: unknown, transaction: PlanFinalizationTransactionRecord): value is PlanFinalizationEventOutboxRecord {
  if (!validOutboxShape(value) || transaction.event_outbox_id === null || transaction.publication_receipt === null) return false;
  const outbox = value as PlanFinalizationEventOutboxRecord;
  const expectedStatus = outbox.state === "delivered" ? "publication_committed_event_complete" :
    outbox.state === "pending" ? "publication_committed_event_pending" :
      outbox.state === "ambiguous" ? "publication_committed_event_ambiguous" : "publication_committed_event_failed";
  return transaction.status === expectedStatus && outbox.outbox_id === transaction.event_outbox_id && outbox.operation_id === transaction.operation_id &&
    outbox.idempotency_key === transaction.idempotency_key && outbox.project_id === transaction.project_id &&
    outbox.change_key === transaction.change_key && outbox.run_id === transaction.run_id &&
    outbox.branch_name === transaction.branch_name && outbox.attempt === transaction.attempt &&
    outbox.publication_receipt_id === transaction.publication_receipt.receipt_id &&
    outbox.publication_generation === transaction.publication_receipt.generation &&
    outbox.publication_manifest_hash === transaction.publication_receipt.manifest_hash &&
    outbox.event_bundle_hash === transaction.event_bundle_hash;
}

function validBaseline(value: unknown): boolean {
  if (!record(value) || !exact(value, ["state", "manifest_hash", "generation"]) ||
      !Number.isSafeInteger(value.generation) || (value.generation as number) < 0) return false;
  if (value.state === "absent") return value.manifest_hash === null && value.generation === 0;
  return value.state === "present" && typeof value.manifest_hash === "string" && SHA.test(value.manifest_hash) && (value.generation as number) > 0;
}

function transactionRecordBody(value: Omit<PlanFinalizationTransactionRecord, "record_hash">): Record<string, unknown> {
  return { schema_version: value.schema_version, record_kind: value.record_kind, operation_id: value.operation_id,
    idempotency_key: value.idempotency_key, project_id: value.project_id, change_key: value.change_key, run_id: value.run_id,
    branch_name: value.branch_name, attempt: value.attempt, context: value.context, expected_baseline: value.expected_baseline,
    finalization_receipt_hash: value.finalization_receipt_hash, event_bundle_hash: value.event_bundle_hash, plan_hash: value.plan_hash,
    manifest_hash: value.manifest_hash, ownership_paths: value.ownership_paths, filesystem_binding: value.filesystem_binding,
    publication_receipt: value.publication_receipt, event_outbox_id: value.event_outbox_id, status: value.status,
    reason_code: value.reason_code, created_at: value.created_at, updated_at: value.updated_at };
}

function sealTransactionRecord(value: Omit<PlanFinalizationTransactionRecord, "record_hash">): PlanFinalizationTransactionRecord {
  const body = transactionRecordBody(value);
  return freeze({ ...body, record_hash: hash(body) } as PlanFinalizationTransactionRecord);
}

function validTransactionRecord(value: unknown): value is PlanFinalizationTransactionRecord {
  if (!record(value) || !exact(value, ["schema_version", "record_kind", "record_hash", "operation_id", "idempotency_key", "project_id",
    "change_key", "run_id", "branch_name", "attempt", "context", "expected_baseline", "finalization_receipt_hash", "event_bundle_hash",
    "plan_hash", "manifest_hash", "ownership_paths", "filesystem_binding", "publication_receipt", "event_outbox_id", "status", "reason_code",
    "created_at", "updated_at"]) || value.schema_version !== 1 || value.record_kind !== "plan_finalization_transaction" ||
      typeof value.record_hash !== "string" || !SHA.test(value.record_hash) || !text(value.operation_id) || !ID.test(value.operation_id) ||
      !text(value.idempotency_key) || !text(value.project_id) || !text(value.change_key) || !text(value.run_id) || !text(value.branch_name) ||
      !Number.isSafeInteger(value.attempt) || (value.attempt as number) < 1 || !validContext(value.context) || !validBaseline(value.expected_baseline) ||
      typeof value.finalization_receipt_hash !== "string" || !SHA.test(value.finalization_receipt_hash) || typeof value.event_bundle_hash !== "string" ||
      !SHA.test(value.event_bundle_hash) || !(value.plan_hash === null || typeof value.plan_hash === "string" && SHA.test(value.plan_hash)) ||
      !(value.manifest_hash === null || typeof value.manifest_hash === "string" && SHA.test(value.manifest_hash)) || !Array.isArray(value.ownership_paths) ||
      (value.filesystem_binding !== null && !record(value.filesystem_binding)) ||
      !(value.publication_receipt === null || validReceiptShape(value.publication_receipt)) ||
      !(value.event_outbox_id === null || typeof value.event_outbox_id === "string" && /^plan_event_outbox:[a-f0-9]{64}$/u.test(value.event_outbox_id)) ||
      !["publication_committed_event_pending", "publication_committed_event_complete", "publication_committed_event_ambiguous",
        "publication_committed_event_failed", "publication_not_committed", "blocked", "legacy_read_only"].includes(String(value.status)) ||
      !(value.reason_code === null || text(value.reason_code)) || !timestamp(value.created_at) || !timestamp(value.updated_at) || value.updated_at < value.created_at) return false;
  const body = { ...value } as Record<string, unknown>;
  delete body.record_hash;
  if (hash(body) !== value.record_hash) return false;
  const context = value.context as unknown as Record<string, unknown>;
  if (context.project_id !== value.project_id || context.change_key !== value.change_key || context.run_id !== value.run_id ||
      context.branch_name !== value.branch_name || context.attempt !== value.attempt) return false;
  const status = value.status as PlanFinalizationTransactionRecord["status"];
  const hasPublication = value.publication_receipt !== null;
  const baseline = value.expected_baseline as PlanDurablePublicationBaseline;
  if (hasPublication) {
    const receipt = value.publication_receipt as unknown as Record<string, unknown>;
    if (receipt.operation_id !== value.operation_id || receipt.idempotency_key !== value.idempotency_key || receipt.project_id !== value.project_id ||
        receipt.change_key !== value.change_key || receipt.receipt_id === undefined || receipt.plan_hash !== value.plan_hash ||
        receipt.manifest_hash !== value.manifest_hash || receipt.previous_generation !== baseline.generation ||
        receipt.generation !== baseline.generation + 1 ||
        receipt.previous_manifest_hash !== (baseline.state === "absent" ? null : baseline.manifest_hash)) return false;
  }
  const committedState = status === "publication_committed_event_pending" || status === "publication_committed_event_complete" ||
    status === "publication_committed_event_ambiguous" || status === "publication_committed_event_failed";
  if ((status === "publication_committed_event_pending" || status === "publication_committed_event_complete") && !hasPublication) return false;
  if (status === "publication_committed_event_complete" && (value.event_outbox_id === null || !hasPublication)) return false;
  if ((status === "publication_committed_event_ambiguous" || status === "publication_committed_event_failed") &&
      (!hasPublication || value.event_outbox_id === null)) return false;
  if (!committedState && (hasPublication || value.event_outbox_id !== null)) return false;
  if (value.plan_hash === null !== (value.manifest_hash === null) ||
      value.plan_hash === null !== (value.filesystem_binding === null) ||
      value.filesystem_binding !== null && value.ownership_paths.length !== 8 ||
      value.filesystem_binding === null && value.ownership_paths.length !== 0) return false;
  if (value.filesystem_binding !== null) {
    const binding = value.filesystem_binding as Record<string, unknown>;
    let targetPaths: readonly string[];
    try { targetPaths = planDurablePublicationTargetPaths(value.change_key as string); } catch { return false; }
    const expectedHashes = binding.expected_payload_hashes;
    const ownershipPaths = binding.ownership_paths;
    if (!exact(binding, ["operation_id", "idempotency_key", "plan_hash", "expected_baseline", "new_manifest_hash", "ownership_paths", "expected_payload_hashes", "expected_readback_hash"]) ||
        binding.operation_id !== value.operation_id || binding.idempotency_key !== value.idempotency_key || binding.plan_hash !== value.plan_hash ||
        !validBaseline(binding.expected_baseline) || binding.new_manifest_hash !== value.manifest_hash || !Array.isArray(binding.ownership_paths) ||
        binding.ownership_paths.length !== targetPaths.length || binding.ownership_paths.some((path, index) => path !== targetPaths[index]) ||
        !Array.isArray(ownershipPaths) || value.ownership_paths.some((path) => typeof path !== "string") ||
        value.ownership_paths.length !== ownershipPaths.length ||
        !value.ownership_paths.every((path) => ownershipPaths.includes(path)) ||
        hash(binding.expected_baseline) !== hash(value.expected_baseline) ||
        !record(expectedHashes) || Object.keys(expectedHashes).length !== targetPaths.length ||
        targetPaths.some((path) => typeof expectedHashes[path] !== "string" || !SHA.test(expectedHashes[path] as string)) ||
        typeof binding.expected_readback_hash !== "string" || !SHA.test(binding.expected_readback_hash)) return false;
    const expectedReadback = derivePlanDurablePublicationFilesystemReadbackHash({
      manifest_hash: value.manifest_hash as PlanDurablePublicationSha256,
      payload_hashes: expectedHashes as Record<string, PlanDurablePublicationSha256>, change_key: value.change_key as string
    });
    if (binding.expected_readback_hash !== expectedReadback) return false;
  }
  return true;
}

function validQualityProof(value: unknown, input: PlanFinalizationTransactionInput, plan: PlanArtifactPublicationPlan,
  eventBundleHash: PlanDurablePublicationSha256): value is PlanFinalizationQualityVerificationProof {
  if (!record(value) || !exact(value, ["schema_version", "valid", "receipt_hash", "plan_hash", "layer_receipt_hashes", "event_bundle_hash", "proof_hash"]) ||
      value.schema_version !== 1 || value.valid !== true || value.receipt_hash !== input.finalization.receipt.receipt_hash ||
      value.plan_hash !== hash(plan) || value.event_bundle_hash !== eventBundleHash || typeof value.proof_hash !== "string" || !SHA.test(value.proof_hash) ||
      !Array.isArray(value.layer_receipt_hashes) || value.layer_receipt_hashes.length !== 3 ||
      value.layer_receipt_hashes.some((item, index) => item !== input.finalization.receipt.layer_receipt_hashes[index] || typeof item !== "string" || !SHA.test(item))) return false;
  const { proof_hash: ignored, ...body } = value;
  return ignored === hash(body);
}

function validReadbackShape(value: unknown, operationId: string): value is PlanDurablePublicationFilesystemReadback {
  return record(value) && exact(value, ["operation_id", "live_manifest_hash", "payload_hashes", "readback_hash", "journal_committed"]) &&
    value.operation_id === operationId && (value.live_manifest_hash === null || typeof value.live_manifest_hash === "string" && SHA.test(value.live_manifest_hash)) &&
    record(value.payload_hashes) && (value.readback_hash === null || typeof value.readback_hash === "string" && SHA.test(value.readback_hash)) &&
    typeof value.journal_committed === "boolean";
}

function result(input: { readonly operation_id: string; readonly status: PlanFinalizationTransactionResult["status"];
  readonly publication_receipt?: PlanDurablePublicationReceipt | null; readonly event_outbox?: PlanFinalizationEventOutboxRecord | null;
  readonly event_bundle_hash?: PlanDurablePublicationSha256 | null; readonly record?: PlanFinalizationTransactionRecord | null;
  readonly reason_code?: string; readonly ok?: boolean }): PlanFinalizationTransactionResult {
  const reasonCode = input.record === undefined || input.record === null ? input.reason_code : input.record.reason_code ?? undefined;
  return freeze({ ok: input.ok ?? input.status === "publication_committed_event_complete", status: input.status,
    operation_id: input.operation_id, publication_receipt: input.publication_receipt ?? null, event_outbox: input.event_outbox ?? null,
    event_bundle_hash: input.event_bundle_hash ?? null, record: input.record ?? null,
    ...(reasonCode === undefined ? {} : { reason_code: reasonCode }) });
}

export function createPlanFinalizationTransaction(rawDependencies: PlanFinalizationTransactionDependencies): PlanFinalizationTransactionModule {
  let dependencies: Record<string, unknown>;
  try {
    if (rawDependencies === null || typeof rawDependencies !== "object" || isProxy(rawDependencies)) throw new Error("dependency");
    const descriptors = Object.getOwnPropertyDescriptors(rawDependencies) as Record<string, PropertyDescriptor>;
    const keys = Object.keys(descriptors);
    if (!keys.every((key) => ["filesystem", "publication", "event_outbox", "renderer", "quality_verifier", "clock"].includes(key)) ||
        !["filesystem", "publication", "event_outbox", "renderer", "quality_verifier", "clock"].every((key) => Object.hasOwn(descriptors, key)) ||
        Object.getOwnPropertySymbols(rawDependencies).length !== 0 || keys.some((key) => descriptors[key] === undefined ||
          !("value" in (descriptors[key] as PropertyDescriptor)) || (descriptors[key] as PropertyDescriptor).enumerable !== true)) throw new Error("dependency");
    dependencies = Object.fromEntries(keys.map((key) => [key, descriptors[key]?.value]));
  } catch { throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_PORT_INVALID"); }
  if (typeof dependencies.clock !== "function") throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_PORT_INVALID");
  const filesystem = dependencies.filesystem as PlanFinalizationFilesystemPort;
  const prepare = safeMethod(filesystem, "prepare"); const apply = safeMethod(filesystem, "apply"); const recover = safeMethod(filesystem, "recover");
  const inspect = safeMethod(filesystem, "inspect"); const readback = safeMethod(filesystem, "readback");
  const publication = dependencies.publication as PlanDurablePublicationModule;
  const publish = safeMethod(publication, "publish");
  const prepareTransaction = safeMethod(dependencies.event_outbox, "prepareTransaction");
  const updateTransaction = safeMethod(dependencies.event_outbox, "updateTransaction");
  const inspectTransactionRecord = safeMethod(dependencies.event_outbox, "inspectTransaction");
  const enqueue = safeMethod(dependencies.event_outbox, "enqueue"); const deliver = safeMethod(dependencies.event_outbox, "deliver");
  const inspectOutbox = safeMethod(dependencies.event_outbox, "inspect");
  const render = safeMethod(dependencies.renderer, "render");
  const verifyQuality = safeMethod(dependencies.quality_verifier, "verify");

  async function parseInput(raw: unknown): Promise<{ readonly legacy: true } | { readonly legacy: false; readonly input: PlanFinalizationTransactionInput; readonly context: PlanFinalizationExecutionContext; readonly finalization: PlanFinalizationEvidence; readonly event_bundle_hash: PlanDurablePublicationSha256 }> {
    let value: unknown;
    try { value = snapshot(raw); } catch { throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_INPUT_INVALID"); }
    if (record(value) && value.schema_version === 0) return { legacy: true };
    if (!record(value) || !exact(value, ["schema_version", "operation_id", "idempotency_key", "context", "finalization", "expected_baseline", "recovery_token"], ["plan"]) ||
        value.schema_version !== 1 || !text(value.operation_id) || !ID.test(value.operation_id) || !text(value.idempotency_key) ||
        !RECOVERY.test(String(value.recovery_token)) || !validContext(value.context) || !record(value.finalization) ||
        !exact(value.finalization, ["schema_version", "branch_name", "receipt", "events"], ["quality_verification_input", "layer_receipts"]) ||
        value.finalization.schema_version !== 1) {
      throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_INPUT_INVALID");
    }
    if (value.plan !== undefined && (!record(value.plan) || typeof value.plan.publication_intent_id !== "string") ||
        !Array.isArray(value.finalization.events)) throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_INPUT_INVALID");
    const context = value.context as PlanFinalizationExecutionContext;
    const finalization = value.finalization as Record<string, unknown>;
    if (finalization.branch_name !== context.branch_name) throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_IDENTITY_INVALID");
    const receiptValue = finalization.receipt;
    if (record(receiptValue) && (receiptValue.run_id !== context.run_id || receiptValue.change_key !== context.change_key)) {
      throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_IDENTITY_INVALID");
    }
    if (!finalizationReceiptValid(receiptValue, context,
      value.plan === undefined ? undefined : (value.plan as Record<string, unknown>).publication_intent_id as string)) {
      throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_INPUT_INVALID");
    }
    const input = value as unknown as PlanFinalizationTransactionInput;
    if (input.finalization.receipt.status === "blocked") {
      return { legacy: false, input, context: input.context, finalization: input.finalization,
        event_bundle_hash: hash({ schema_version: 1, lifecycle_kind: "change", run_id: input.context.run_id,
          change_key: input.context.change_key, events: input.finalization.events }) };
    }
    if (input.finalization.receipt.finalizer_action !== "publish") throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_QUALITY_INVALID");
    const eventHash = eventBundle(input.finalization.events, input.context, input.finalization.receipt);
    return { legacy: false, input, context: input.context, finalization: input.finalization, event_bundle_hash: eventHash };
  }

  type ParsedCurrent = Extract<Awaited<ReturnType<typeof parseInput>>, { readonly legacy: false }>;
  const clock = dependencies.clock as () => string;

  function currentTime(): string {
    let value: unknown;
    try { value = clock(); } catch { throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_PORT_INVALID"); }
    if (!timestamp(value)) throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_PORT_INVALID");
    return value;
  }

  function makeRecord(parsed: ParsedCurrent, status: PlanFinalizationTransactionStatus, options: {
    readonly plan?: PlanArtifactPublicationPlan | null;
    readonly filesystem_binding?: PlanDurablePublicationFilesystemBinding | null;
    readonly publication_receipt?: PlanDurablePublicationReceipt | null;
    readonly event_outbox_id?: string | null;
    readonly reason_code?: string | null;
    readonly created_at?: string;
    readonly updated_at?: string;
  } = {}, prior?: PlanFinalizationTransactionRecord): PlanFinalizationTransactionRecord {
    const plan = options.plan === undefined ? null : options.plan;
    const planHash = options.plan === undefined ? prior?.plan_hash ?? null : plan === null ? null : hash(plan);
    const manifestHash = options.plan === undefined ? prior?.manifest_hash ?? null : plan === null ? null : plan.manifest_hash as PlanDurablePublicationSha256;
    const ownershipPaths = options.plan === undefined ? prior?.ownership_paths ?? [] : plan === null ? [] : plan.ownership_paths;
    const binding = options.filesystem_binding === undefined ? prior?.filesystem_binding ?? null : options.filesystem_binding;
    const createdAt = options.created_at ?? prior?.created_at ?? currentTime();
    const updatedAt = options.updated_at ?? currentTime();
    const body: Omit<PlanFinalizationTransactionRecord, "record_hash"> = {
      schema_version: 1, record_kind: "plan_finalization_transaction", operation_id: parsed.input.operation_id,
      idempotency_key: parsed.input.idempotency_key, project_id: parsed.context.project_id, change_key: parsed.context.change_key,
      run_id: parsed.context.run_id, branch_name: parsed.context.branch_name, attempt: parsed.context.attempt, context: parsed.context,
      expected_baseline: parsed.input.expected_baseline, finalization_receipt_hash: parsed.finalization.receipt.receipt_hash as PlanDurablePublicationSha256,
      event_bundle_hash: parsed.event_bundle_hash, plan_hash: planHash, manifest_hash: manifestHash,
      ownership_paths: ownershipPaths, filesystem_binding: binding,
      publication_receipt: options.publication_receipt ?? null, event_outbox_id: options.event_outbox_id ?? null, status,
      reason_code: options.reason_code ?? null, created_at: createdAt, updated_at: updatedAt
    };
    return sealTransactionRecord(body);
  }

  async function prepareRecord(parsed: ParsedCurrent): Promise<PlanFinalizationTransactionRecord> {
    const candidate = makeRecord(parsed, "publication_not_committed");
    let persisted: unknown;
    try { persisted = await callPort(prepareTransaction, candidate); } catch { throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_PORT_INVALID"); }
    if (!validTransactionRecord(persisted) || persisted.operation_id !== candidate.operation_id || persisted.idempotency_key !== candidate.idempotency_key) {
      throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_RECORD_INVALID");
    }
    return persisted;
  }

  async function updateRecord(parsed: ParsedCurrent, status: PlanFinalizationTransactionStatus, options: {
    readonly plan?: PlanArtifactPublicationPlan | null;
    readonly filesystem_binding?: PlanDurablePublicationFilesystemBinding | null;
    readonly publication_receipt?: PlanDurablePublicationReceipt | null;
    readonly event_outbox_id?: string | null;
    readonly reason_code?: string | null;
  }, prior: PlanFinalizationTransactionRecord): Promise<PlanFinalizationTransactionRecord> {
    const candidate = makeRecord(parsed, status, { ...options, created_at: prior.created_at }, prior);
    let persisted: unknown;
    try { persisted = await callPort(updateTransaction, candidate); } catch { throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_RECORD_INVALID"); }
    if (!validTransactionRecord(persisted) || persisted.operation_id !== candidate.operation_id || persisted.idempotency_key !== candidate.idempotency_key) {
      throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_RECORD_INVALID");
    }
    return persisted;
  }

  async function finish(parsed: ParsedCurrent, prior: PlanFinalizationTransactionRecord, status: PlanFinalizationTransactionStatus, options: {
    readonly plan?: PlanArtifactPublicationPlan | null;
    readonly filesystem_binding?: PlanDurablePublicationFilesystemBinding | null;
    readonly publication_receipt?: PlanDurablePublicationReceipt | null;
    readonly event_outbox_id?: string | null;
    readonly reason_code?: string | null;
    readonly event_outbox?: PlanFinalizationEventOutboxRecord | null;
    readonly event_bundle_hash?: PlanDurablePublicationSha256 | null;
    readonly ok?: boolean;
  }): Promise<PlanFinalizationTransactionResult> {
    let updated: PlanFinalizationTransactionRecord;
    try { updated = await updateRecord(parsed, status, options, prior); }
    catch { return result({ operation_id: parsed.input.operation_id, status: prior.status, ok: false,
      publication_receipt: options.publication_receipt ?? prior.publication_receipt, event_bundle_hash: options.event_bundle_hash ?? parsed.event_bundle_hash,
      record: prior, reason_code: "PLAN_FINALIZATION_RECORD_INVALID" }); }
    const output: { operation_id: string; status: PlanFinalizationTransactionStatus; publication_receipt: PlanDurablePublicationReceipt | null;
      event_outbox: PlanFinalizationEventOutboxRecord | null; event_bundle_hash: PlanDurablePublicationSha256;
      record: PlanFinalizationTransactionRecord; ok?: boolean; reason_code?: string } = {
      operation_id: parsed.input.operation_id, status, publication_receipt: options.publication_receipt ?? null,
      event_outbox: options.event_outbox ?? null, event_bundle_hash: options.event_bundle_hash ?? parsed.event_bundle_hash, record: updated
    };
    if (options.ok !== undefined) output.ok = options.ok;
    if (options.reason_code !== undefined && options.reason_code !== null) output.reason_code = options.reason_code;
    return result(output);
  }

  async function resumeCurrent(parsed: ParsedCurrent, prior: PlanFinalizationTransactionRecord): Promise<PlanFinalizationTransactionResult> {
    const input = parsed.input;
    if (prior.operation_id !== input.operation_id || prior.idempotency_key !== input.idempotency_key ||
        prior.finalization_receipt_hash !== parsed.finalization.receipt.receipt_hash || prior.event_bundle_hash !== parsed.event_bundle_hash ||
        hash(prior.context) !== hash(parsed.context) || hash(prior.expected_baseline) !== hash(input.expected_baseline)) {
      throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_IDENTITY_INVALID");
    }
    const publicationReceipt = prior.publication_receipt;
    if (publicationReceipt === null) throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_RECORD_INVALID");
    const expectedOutboxId = outboxId({ operation_id: input.operation_id, idempotency_key: input.idempotency_key,
      receipt_id: publicationReceipt.receipt_id, event_bundle_hash: parsed.event_bundle_hash, context: parsed.context });
    if (prior.event_outbox_id !== null && prior.event_outbox_id !== expectedOutboxId) {
      throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_RECORD_INVALID");
    }
    const outboxInput: PlanFinalizationEventOutboxEnqueueInput = freeze({ schema_version: 1, record_kind: "plan_finalization_event_outbox",
      outbox_id: expectedOutboxId, operation_id: input.operation_id, idempotency_key: input.idempotency_key, context: parsed.context,
      publication_receipt: publicationReceipt, event_bundle_hash: parsed.event_bundle_hash, events: parsed.finalization.events });
    let outbox: unknown = null;
    if (prior.event_outbox_id !== null) {
      try { outbox = await callPort(inspectOutbox, { outbox_id: expectedOutboxId, operation_id: input.operation_id, idempotency_key: input.idempotency_key }); }
      catch { outbox = null; }
    }
    if (outbox === null || outbox === undefined) {
      try { outbox = await callPort(enqueue, outboxInput); }
      catch { return result({ operation_id: input.operation_id, status: "publication_committed_event_pending", ok: false,
        publication_receipt: publicationReceipt, event_bundle_hash: parsed.event_bundle_hash, record: prior,
        reason_code: "PLAN_FINALIZATION_OUTBOX_PENDING" }); }
    }
    if (!validOutbox(outbox, outboxInput)) throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_OUTBOX_INVALID");
    let outboxRecord = outbox as PlanFinalizationEventOutboxRecord;
    if (outboxRecord.state !== "delivered") {
      const deliveryInput: PlanFinalizationEventOutboxDeliveryInput = { schema_version: 1, outbox_id: expectedOutboxId,
        operation_id: input.operation_id, idempotency_key: input.idempotency_key, event_bundle_hash: parsed.event_bundle_hash,
        publication_receipt_id: publicationReceipt.receipt_id };
      try { outbox = await callPort(deliver, deliveryInput); }
      catch { return finish(parsed, prior, "publication_committed_event_ambiguous", { publication_receipt: publicationReceipt,
        event_outbox_id: expectedOutboxId, event_outbox: outboxRecord, ok: false, reason_code: "PLAN_FINALIZATION_OUTBOX_AMBIGUOUS" }); }
      if (!validOutbox(outbox, outboxInput)) throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_OUTBOX_INVALID");
      outboxRecord = outbox as PlanFinalizationEventOutboxRecord;
    }
    const status: PlanFinalizationTransactionStatus = outboxRecord.state === "delivered" ? "publication_committed_event_complete" :
      outboxRecord.state === "pending" ? "publication_committed_event_pending" : outboxRecord.state === "ambiguous" ?
        "publication_committed_event_ambiguous" : "publication_committed_event_failed";
    return finish(parsed, prior, status, { publication_receipt: publicationReceipt, event_outbox_id: expectedOutboxId,
      event_outbox: outboxRecord, ok: status === "publication_committed_event_complete",
      reason_code: status === "publication_committed_event_complete" ? null : "PLAN_FINALIZATION_OUTBOX_PENDING" });
  }

  async function finalize(rawInput: unknown): Promise<PlanFinalizationTransactionResult> {
    const parsed = await parseInput(rawInput);
    if (parsed.legacy) return result({ operation_id: "legacy", status: "legacy_read_only", ok: false, reason_code: "PLAN_FINALIZATION_LEGACY_READ_ONLY" });
    const input = parsed.input;
    if (input.finalization.receipt.status === "blocked") return result({ operation_id: input.operation_id, status: "blocked", ok: false,
      event_bundle_hash: parsed.event_bundle_hash, reason_code: "PLAN_FINALIZATION_QUALITY_INVALID" });
    let transactionRecord: PlanFinalizationTransactionRecord | undefined;
    try {
      const existing = await callPort(inspectTransactionRecord, { operation_id: input.operation_id, idempotency_key: input.idempotency_key });
      if (existing !== undefined && !validTransactionRecord(existing)) throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_RECORD_INVALID");
      transactionRecord = existing as PlanFinalizationTransactionRecord | undefined;
    } catch (error) {
      if (error instanceof PlanFinalizationTransactionError) throw error;
      throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_RECORD_INVALID");
    }
    if (transactionRecord !== undefined && (hash(transactionRecord.context) !== hash(parsed.context) ||
        hash(transactionRecord.expected_baseline) !== hash(input.expected_baseline) || transactionRecord.finalization_receipt_hash !== parsed.finalization.receipt.receipt_hash)) {
      throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_IDENTITY_INVALID");
    }
    if (transactionRecord !== undefined && transactionRecord.status !== "publication_not_committed") return resumeCurrent(parsed, transactionRecord);
    if (transactionRecord === undefined) transactionRecord = await prepareRecord(parsed);
    let rendered: unknown;
    try {
      rendered = await callPort(render, { schema_version: 1, context: parsed.context, finalization: parsed.finalization } satisfies PlanFinalizationRendererInput);
    } catch (error) {
      if (error instanceof PlanFinalizationTransactionError) throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_RENDER_INVALID");
      throw error;
    }
    if (input.plan !== undefined && hash(rendered) !== hash(input.plan)) throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_RENDER_INVALID");
    if (input.finalization.quality_verification_input === undefined || !record(rendered)) {
      throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_QUALITY_INVALID");
    }
    const qualityInput: PlanFinalizationQualityVerificationInput = freeze({ schema_version: 1, operation_id: input.operation_id,
      context: parsed.context, finalization: parsed.finalization, plan: rendered as unknown as PlanArtifactPublicationPlan,
      plan_hash: hash(rendered), event_bundle_hash: parsed.event_bundle_hash });
    let qualityProof: unknown;
    try { qualityProof = await callPort(verifyQuality, qualityInput); }
    catch { throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_QUALITY_INVALID"); }
    if (!validQualityProof(qualityProof, input, rendered as unknown as PlanArtifactPublicationPlan, parsed.event_bundle_hash)) {
      throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_QUALITY_INVALID");
    }
    let prepareRequest: ReturnType<typeof snapshotPlanDurablePublicationFilesystemPrepareRequest>;
    try {
      prepareRequest = snapshotPlanDurablePublicationFilesystemPrepareRequest({ schema_version: 1, operation_id: input.operation_id,
        idempotency_key: input.idempotency_key, project_id: parsed.context.project_id, change_key: parsed.context.change_key,
        expected_baseline: input.expected_baseline, plan: rendered, authority: parsed.context.root_authority, recovery_token: input.recovery_token });
    } catch { throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_RENDER_INVALID"); }
    if (prepareRequest.plan.publication_intent_id !== input.finalization.receipt.publication_intent_id) {
      throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_IDENTITY_INVALID");
    }
    let filesystemBinding: PlanDurablePublicationFilesystemBinding;
    try { filesystemBinding = derivePlanDurablePublicationFilesystemBinding(prepareRequest); }
    catch { throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_FILESYSTEM_INVALID"); }
    transactionRecord = await updateRecord(parsed, "publication_not_committed", { plan: prepareRequest.plan, filesystem_binding: filesystemBinding }, transactionRecord);
    let fsState: PlanDurablePublicationFilesystemTransactionInspection;
    try { fsState = await callPort(prepare, prepareRequest) as PlanDurablePublicationFilesystemTransactionInspection; }
    catch { return finish(parsed, transactionRecord, "publication_not_committed", { plan: prepareRequest.plan, filesystem_binding: filesystemBinding,
      event_bundle_hash: parsed.event_bundle_hash, ok: false, reason_code: "PLAN_FINALIZATION_FILESYSTEM_AMBIGUOUS" }); }
    if (!validFilesystemInspection(fsState, input.operation_id, input.recovery_token, filesystemBinding, input.idempotency_key)) throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_FILESYSTEM_INVALID");
    if (fsState.state === "unknown") return finish(parsed, transactionRecord, "publication_not_committed", { plan: prepareRequest.plan,
      filesystem_binding: filesystemBinding, event_bundle_hash: parsed.event_bundle_hash, reason_code: "PLAN_FINALIZATION_FILESYSTEM_BASELINE_CONFLICT" });
    if (fsState.state === "rolled_back") return finish(parsed, transactionRecord, "publication_not_committed", { plan: prepareRequest.plan,
      filesystem_binding: filesystemBinding, event_bundle_hash: parsed.event_bundle_hash, reason_code: "PLAN_FINALIZATION_FILESYSTEM_ROLLED_BACK" });
    if (fsState.state !== "committed") {
      const applyMethod = fsState.state === "recovery_required" ? recover : apply;
      try {
        fsState = await callPort(applyMethod, { operation_id: input.operation_id, recovery_token: input.recovery_token }) as PlanDurablePublicationFilesystemTransactionInspection;
      } catch {
        try { fsState = await callPort(inspect, { operation_id: input.operation_id, idempotency_key: input.idempotency_key }) as PlanDurablePublicationFilesystemTransactionInspection; }
        catch { return finish(parsed, transactionRecord, "publication_not_committed", { plan: prepareRequest.plan,
          filesystem_binding: filesystemBinding, event_bundle_hash: parsed.event_bundle_hash, reason_code: "PLAN_FINALIZATION_FILESYSTEM_AMBIGUOUS", ok: false }); }
        if (validFilesystemInspection(fsState, input.operation_id, input.recovery_token, filesystemBinding, input.idempotency_key) && fsState.state === "recovery_required") {
          try { fsState = await callPort(recover, { operation_id: input.operation_id, recovery_token: input.recovery_token }) as PlanDurablePublicationFilesystemTransactionInspection; }
          catch { return finish(parsed, transactionRecord, "publication_not_committed", { plan: prepareRequest.plan,
            filesystem_binding: filesystemBinding, event_bundle_hash: parsed.event_bundle_hash, reason_code: "PLAN_FINALIZATION_FILESYSTEM_AMBIGUOUS", ok: false }); }
        }
        if (!validFilesystemInspection(fsState, input.operation_id, input.recovery_token, filesystemBinding, input.idempotency_key) || fsState.state !== "committed") {
          return finish(parsed, transactionRecord, "publication_not_committed", { plan: prepareRequest.plan,
            filesystem_binding: filesystemBinding, event_bundle_hash: parsed.event_bundle_hash, reason_code: "PLAN_FINALIZATION_FILESYSTEM_AMBIGUOUS", ok: false });
        }
      }
      if (!validFilesystemInspection(fsState, input.operation_id, input.recovery_token, filesystemBinding, input.idempotency_key)) throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_FILESYSTEM_INVALID");
      if (fsState.state !== "committed") return finish(parsed, transactionRecord, "publication_not_committed", { plan: prepareRequest.plan,
        filesystem_binding: filesystemBinding, event_bundle_hash: parsed.event_bundle_hash, reason_code: "PLAN_FINALIZATION_FILESYSTEM_AMBIGUOUS", ok: false });
    }
    let liveReadback: unknown;
    try { liveReadback = await callPort(readback, input.operation_id); } catch { return finish(parsed, transactionRecord, "publication_not_committed", {
      plan: prepareRequest.plan, filesystem_binding: filesystemBinding, event_bundle_hash: parsed.event_bundle_hash, ok: false,
      reason_code: "PLAN_FINALIZATION_FILESYSTEM_AMBIGUOUS" }); }
    if (!validReadback(liveReadback, input.operation_id, parsed.context.change_key, prepareRequest.plan.manifest_hash,
        filesystemBinding.expected_payload_hashes)) {
      return finish(parsed, transactionRecord, "publication_not_committed", { plan: prepareRequest.plan,
        filesystem_binding: filesystemBinding, event_bundle_hash: parsed.event_bundle_hash, ok: false,
        reason_code: "PLAN_FINALIZATION_FILESYSTEM_READBACK_INVALID" });
    }
    let published: unknown;
    try {
      published = await callPort(publish, { schema_version: 1, operation_id: input.operation_id, idempotency_key: input.idempotency_key,
        project_id: parsed.context.project_id, change_key: parsed.context.change_key, expected_baseline: input.expected_baseline, plan: prepareRequest.plan });
    } catch { return finish(parsed, transactionRecord, "publication_not_committed", { plan: prepareRequest.plan,
      filesystem_binding: filesystemBinding, event_bundle_hash: parsed.event_bundle_hash, ok: false,
      reason_code: "PLAN_FINALIZATION_PUBLICATION_AMBIGUOUS" }); }
    if (!record(published)) throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_PUBLICATION_INVALID");
    if (published.ok !== true) {
      if (exact(published, ["ok", "outcome", "receipt", "operation_id"]) && published.ok === false && published.receipt === null &&
          published.operation_id === input.operation_id && ["unknown", "baseline_conflict", "idempotency_conflict", "legacy_read_only"].includes(String(published.outcome))) {
        return finish(parsed, transactionRecord, "publication_not_committed", { plan: prepareRequest.plan,
          filesystem_binding: filesystemBinding, event_bundle_hash: parsed.event_bundle_hash, ok: false,
          reason_code: "PLAN_FINALIZATION_PUBLICATION_CONFLICT" });
      }
      throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_PUBLICATION_INVALID");
    }
    if (!exact(published, ["ok", "outcome", "event_allowed", "receipt", "event"]) ||
        !["committed", "replayed"].includes(String(published.outcome)) || published.event_allowed !== true || !record(published.receipt) ||
        !publicationReceiptValid(published.receipt, input, prepareRequest.plan) || !record(published.event) ||
        !exact(published.event, ["schema_version", "event_kind", "operation_id", "change_key", "publication_intent_id", "receipt_id", "generation", "occurred_at"]) ||
        published.event.schema_version !== 1 || published.event.event_kind !== "publication_durable" ||
        published.event.operation_id !== input.operation_id || published.event.change_key !== input.context.change_key ||
        published.event.publication_intent_id !== prepareRequest.plan.publication_intent_id ||
        published.event.receipt_id !== published.receipt.receipt_id || published.event.generation !== published.receipt.generation ||
        !timestamp(published.event.occurred_at)) {
      throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_PUBLICATION_INVALID");
    }
    const publicationReceipt = published.receipt as PlanDurablePublicationReceipt;
    const outboxInput: PlanFinalizationEventOutboxEnqueueInput = freeze({ schema_version: 1, record_kind: "plan_finalization_event_outbox",
      outbox_id: outboxId({ operation_id: input.operation_id, idempotency_key: input.idempotency_key, receipt_id: publicationReceipt.receipt_id,
        event_bundle_hash: parsed.event_bundle_hash, context: parsed.context }), operation_id: input.operation_id, idempotency_key: input.idempotency_key,
      context: parsed.context, publication_receipt: publicationReceipt, event_bundle_hash: parsed.event_bundle_hash, events: parsed.finalization.events });
    transactionRecord = await updateRecord(parsed, "publication_committed_event_pending", { plan: prepareRequest.plan,
      filesystem_binding: filesystemBinding, publication_receipt: publicationReceipt, event_outbox_id: null,
      reason_code: "PLAN_FINALIZATION_OUTBOX_PENDING" }, transactionRecord);
    let outbox: unknown;
    try { outbox = await callPort(enqueue, outboxInput); }
    catch { return result({ operation_id: input.operation_id, status: "publication_committed_event_pending", ok: false,
      publication_receipt: publicationReceipt, event_bundle_hash: parsed.event_bundle_hash, record: transactionRecord,
      reason_code: "PLAN_FINALIZATION_OUTBOX_PENDING" }); }
    if (!validOutbox(outbox, outboxInput)) throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_OUTBOX_INVALID");
    let outboxRecord = outbox as PlanFinalizationEventOutboxRecord;
    const outboxStatus = outboxRecord.state === "delivered" ? "publication_committed_event_complete" : outboxRecord.state === "ambiguous" ?
      "publication_committed_event_ambiguous" : outboxRecord.state === "failed" ? "publication_committed_event_failed" : "publication_committed_event_pending";
    transactionRecord = await updateRecord(parsed, outboxStatus, { plan: prepareRequest.plan, filesystem_binding: filesystemBinding,
      publication_receipt: publicationReceipt, event_outbox_id: outboxRecord.outbox_id, reason_code: outboxStatus === "publication_committed_event_complete" ? null : "PLAN_FINALIZATION_OUTBOX_PENDING" }, transactionRecord);
    if (outboxRecord.state === "delivered") return result({ operation_id: input.operation_id, status: "publication_committed_event_complete", publication_receipt: publicationReceipt,
      event_outbox: outboxRecord, event_bundle_hash: parsed.event_bundle_hash, record: transactionRecord });
    if (outboxRecord.state === "ambiguous") return result({ operation_id: input.operation_id, status: "publication_committed_event_ambiguous", ok: false,
      publication_receipt: publicationReceipt, event_outbox: outboxRecord, event_bundle_hash: parsed.event_bundle_hash, record: transactionRecord });
    if (outboxRecord.state === "failed") return result({ operation_id: input.operation_id, status: "publication_committed_event_failed", ok: false,
      publication_receipt: publicationReceipt, event_outbox: outboxRecord, event_bundle_hash: parsed.event_bundle_hash, record: transactionRecord });
    const deliveryInput: PlanFinalizationEventOutboxDeliveryInput = { schema_version: 1, outbox_id: outboxRecord.outbox_id,
      operation_id: input.operation_id, idempotency_key: input.idempotency_key, event_bundle_hash: parsed.event_bundle_hash,
      publication_receipt_id: publicationReceipt.receipt_id };
    try { outbox = await callPort(deliver, deliveryInput); }
    catch { return finish(parsed, transactionRecord, "publication_committed_event_ambiguous", { plan: prepareRequest.plan,
      filesystem_binding: filesystemBinding, publication_receipt: publicationReceipt, event_outbox_id: outboxRecord.outbox_id,
      event_outbox: outboxRecord, event_bundle_hash: parsed.event_bundle_hash, ok: false,
      reason_code: "PLAN_FINALIZATION_OUTBOX_AMBIGUOUS" }); }
    if (!validOutbox(outbox, outboxInput)) throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_OUTBOX_INVALID");
    outboxRecord = outbox as PlanFinalizationEventOutboxRecord;
    const status = outboxRecord.state === "delivered" ? "publication_committed_event_complete" : outboxRecord.state === "pending" ?
      "publication_committed_event_pending" : outboxRecord.state === "ambiguous" ? "publication_committed_event_ambiguous" : "publication_committed_event_failed";
    transactionRecord = await updateRecord(parsed, status, { plan: prepareRequest.plan, filesystem_binding: filesystemBinding,
      publication_receipt: publicationReceipt, event_outbox_id: outboxRecord.outbox_id,
      reason_code: status === "publication_committed_event_complete" ? null : "PLAN_FINALIZATION_OUTBOX_PENDING" }, transactionRecord);
    return result({ operation_id: input.operation_id, status, ok: status === "publication_committed_event_complete", publication_receipt: publicationReceipt,
      event_outbox: outboxRecord, event_bundle_hash: parsed.event_bundle_hash, record: transactionRecord });
  }

  async function inspectTransaction(raw: unknown): Promise<PlanFinalizationTransactionInspection> {
    let input: unknown;
    try { input = snapshot(raw); } catch { throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_INPUT_INVALID"); }
    if (!record(input) || !exact(input, ["schema_version", "operation_id"], ["idempotency_key", "outbox_id"]) || input.schema_version !== 1 ||
        !text(input.operation_id) || !ID.test(input.operation_id) ||
        (input.idempotency_key !== undefined && !text(input.idempotency_key)) ||
        (input.outbox_id !== undefined && (!text(input.outbox_id) || !/^plan_event_outbox:[a-f0-9]{64}$/u.test(input.outbox_id as string)))) {
      throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_INPUT_INVALID");
    }
    let transactionRecord: unknown;
    try { transactionRecord = await callPort(inspectTransactionRecord, { operation_id: input.operation_id,
      ...(input.idempotency_key === undefined ? {} : { idempotency_key: input.idempotency_key }) }); }
    catch { throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_RECORD_INVALID"); }
    if (transactionRecord !== undefined && !validTransactionRecord(transactionRecord)) throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_RECORD_INVALID");
    const durableRecord = transactionRecord as PlanFinalizationTransactionRecord | undefined;
    if (durableRecord === undefined && input.outbox_id !== undefined) throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_IDENTITY_INVALID");
    if (durableRecord !== undefined && input.idempotency_key !== undefined && durableRecord.idempotency_key !== input.idempotency_key) {
      throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_IDENTITY_INVALID");
    }
    const idempotencyKey = durableRecord?.idempotency_key ?? input.idempotency_key;
    if (idempotencyKey === undefined) throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_INPUT_INVALID");
    const expectedOutboxId = durableRecord?.event_outbox_id ?? null;
    if (input.outbox_id !== undefined && input.outbox_id !== expectedOutboxId) throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_IDENTITY_INVALID");
    let filesystemInspection: unknown;
    try { filesystemInspection = await callPort(inspect, { operation_id: input.operation_id, idempotency_key: idempotencyKey }); } catch {
      throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_FILESYSTEM_INVALID");
    }
    if (!validFilesystemInspection(filesystemInspection, input.operation_id, undefined,
        durableRecord?.filesystem_binding ?? undefined, idempotencyKey)) throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_FILESYSTEM_INVALID");
    if (durableRecord !== undefined && (filesystemInspection as PlanDurablePublicationFilesystemTransactionInspection).receipt !== null &&
        (durableRecord.publication_receipt === null || hash((filesystemInspection as PlanDurablePublicationFilesystemTransactionInspection).receipt) !== hash(durableRecord.publication_receipt))) {
      throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_FILESYSTEM_INVALID");
    }
    const rb = await callPort(readback, input.operation_id).catch(() => null);
    if (rb !== null && (!validReadbackShape(rb, input.operation_id) || durableRecord?.filesystem_binding !== null &&
        durableRecord?.filesystem_binding !== undefined && (durableRecord.manifest_hash === null ||
          !validReadback(rb, input.operation_id, durableRecord.change_key, durableRecord.manifest_hash,
            durableRecord.filesystem_binding.expected_payload_hashes) ||
          rb.readback_hash !== durableRecord.filesystem_binding.expected_readback_hash))) {
      throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_FILESYSTEM_INVALID");
    }
    const outbox = expectedOutboxId === null ? null :
      await callPort(inspectOutbox, { outbox_id: expectedOutboxId, operation_id: input.operation_id, idempotency_key: idempotencyKey }).catch(() => null);
    if (expectedOutboxId !== null && (durableRecord === undefined || outbox === null || outbox === undefined || !validOutboxForRecord(outbox, durableRecord))) {
      throw new PlanFinalizationTransactionError("PLAN_FINALIZATION_OUTBOX_INVALID");
    }
    return freeze({ operation_id: input.operation_id, filesystem: filesystemInspection, readback: rb as PlanDurablePublicationFilesystemReadback | null,
      publication_receipt: durableRecord?.publication_receipt ?? (filesystemInspection as PlanDurablePublicationFilesystemTransactionInspection).receipt as PlanDurablePublicationReceipt | null,
      event_outbox: outbox as PlanFinalizationEventOutboxRecord | null, record: durableRecord ?? null });
  }

  function readRecord(raw: unknown): PlanFinalizationTransactionResult | { readonly ok: false; readonly reason_code: "PLAN_FINALIZATION_RECORD_INVALID" } {
    try {
      const value = snapshot(raw);
      if (!record(value)) return { ok: false, reason_code: "PLAN_FINALIZATION_RECORD_INVALID" };
      if (value.schema_version === 0) return result({ operation_id: "legacy", status: "legacy_read_only", ok: false,
        reason_code: "PLAN_FINALIZATION_LEGACY_READ_ONLY" });
      if (!exact(value, ["ok", "status", "operation_id", "publication_receipt", "event_outbox", "event_bundle_hash", "record"], ["reason_code"]) ||
          typeof value.ok !== "boolean" || !["publication_committed_event_pending", "publication_committed_event_complete", "publication_committed_event_ambiguous",
            "publication_committed_event_failed", "publication_not_committed", "blocked", "legacy_read_only"].includes(String(value.status)) ||
          !text(value.operation_id) || !ID.test(value.operation_id) || !(value.publication_receipt === null || validReceiptShape(value.publication_receipt)) ||
          !(value.event_outbox === null || validOutboxShape(value.event_outbox)) || !(value.event_bundle_hash === null || typeof value.event_bundle_hash === "string" && SHA.test(value.event_bundle_hash)) ||
          !(value.record === null || validTransactionRecord(value.record)) ||
          (value.reason_code !== undefined && !text(value.reason_code))) {
        return { ok: false, reason_code: "PLAN_FINALIZATION_RECORD_INVALID" };
      }
      if (value.record !== null) {
        const current = value.record as PlanFinalizationTransactionRecord;
        if (current.operation_id !== value.operation_id || current.status !== value.status ||
            (current.reason_code === null ? value.reason_code !== undefined : value.reason_code !== current.reason_code) ||
            (current.publication_receipt !== null && value.publication_receipt === null) ||
            (value.publication_receipt !== null && current.publication_receipt === null) ||
            (current.publication_receipt !== null && value.publication_receipt !== null && hash(current.publication_receipt) !== hash(value.publication_receipt)) ||
            (current.event_bundle_hash !== value.event_bundle_hash) ||
            (current.event_outbox_id !== null && value.event_outbox === null) ||
            (value.event_outbox !== null && current.event_outbox_id !== (value.event_outbox as PlanFinalizationEventOutboxRecord).outbox_id) ||
            (value.event_outbox !== null && !validOutboxForRecord(value.event_outbox, current))) {
          return { ok: false, reason_code: "PLAN_FINALIZATION_RECORD_INVALID" };
        }
      }
      if (value.record === null || value.ok !== (value.status === "publication_committed_event_complete")) {
        return { ok: false, reason_code: "PLAN_FINALIZATION_RECORD_INVALID" };
      }
      const durable = value.record as PlanFinalizationTransactionRecord;
      if (durable.event_outbox_id === null !== (value.event_outbox === null) ||
          (["publication_committed_event_complete", "publication_committed_event_ambiguous", "publication_committed_event_failed"]
            .includes(String(value.status)) && value.event_outbox === null)) {
        return { ok: false, reason_code: "PLAN_FINALIZATION_RECORD_INVALID" };
      }
      return freeze(value as unknown as PlanFinalizationTransactionResult);
    } catch { return { ok: false, reason_code: "PLAN_FINALIZATION_RECORD_INVALID" }; }
  }

  return freeze({ finalize, resume: finalize, inspect: inspectTransaction, readRecord });
}

export function createPlanFinalizationTransactionModule(dependencies: PlanFinalizationTransactionDependencies): PlanFinalizationTransactionModule {
  return createPlanFinalizationTransaction(dependencies);
}
