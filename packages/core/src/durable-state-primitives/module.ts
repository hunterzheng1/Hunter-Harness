import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

import type {
  AggregateIdentity,
  ArtifactBlobRef,
  AuditEnvelopeV1,
  DurableAuditCursor,
  DurableAuditStreamKind,
  DurableCommitInput,
  DurableCommandIdentity,
  DurableSha256,
  HostActorAuthority,
  RecordDescriptor
} from "./types.js";

const SHA = /^sha256:[a-f0-9]{64}$/u;
const EVENT_ID = /^audit_event:sha256:[a-f0-9]{64}$/u;
const MAX_BYTES = 65_536;
const MAX_CURSOR_BYTES = 512;
const MAX_BLOB_BYTES = 512 * 1024 * 1024;
const STREAM_KINDS: readonly DurableAuditStreamKind[] = [
  "instruction_proposal", "plan_classification", "planning_context", "plan_decision",
  "plan_artifact", "plan_quality", "plan_finalization"
];

export class DurableStateBoundaryError extends Error {
  readonly code = "DURABLE_STATE_BOUNDARY_INVALID" as const;
  constructor(message = "durable state boundary is invalid") {
    super(`DURABLE_STATE_BOUNDARY_INVALID: ${message}`);
    this.name = "DurableStateBoundaryError";
  }
}

function compareCodepoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort(compareCodepoint)
      .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]));
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function stableHash(value: unknown): DurableSha256 {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function isPlain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exact(value: Record<string, unknown>, required: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === required.length && required.every((key) => Object.hasOwn(value, key));
}

function exactWithOptional(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[]
): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => required.includes(key) || optional.includes(key)) &&
    required.every((key) => Object.hasOwn(value, key));
}

function snapshot(value: unknown, maxBytes = MAX_BYTES): unknown {
  const seen = new WeakSet<object>();
  let nodes = 0;
  let strings = 0;
  const copy = (input: unknown, depth: number): unknown => {
    if (input === null || typeof input === "boolean" || typeof input === "string") {
      if (typeof input === "string") {
        strings += input.length;
        if (strings > 16_000) throw new DurableStateBoundaryError("text budget exceeded");
      }
      return input;
    }
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new DurableStateBoundaryError("non-finite number");
      return input;
    }
    if (typeof input !== "object" || isProxy(input) || depth > 16 || ++nodes > 2_048 || seen.has(input)) {
      throw new DurableStateBoundaryError("hostile or unbounded input");
    }
    seen.add(input);
    const array = Array.isArray(input);
    const prototype = Object.getPrototypeOf(input);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new DurableStateBoundaryError("non-canonical prototype");
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key === "symbol")) throw new DurableStateBoundaryError("symbol key");
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined ||
          descriptor.set !== undefined || (array && key === "length" ? false : descriptor.enumerable !== true)) {
        throw new DurableStateBoundaryError("accessor or hidden property");
      }
    }
    if (array) {
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > 128 ||
          keys.length !== (length as number) + 1) throw new DurableStateBoundaryError("sparse array");
      const result: unknown[] = [];
      for (let index = 0; index < (length as number); index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !("value" in descriptor)) throw new DurableStateBoundaryError("sparse array");
        result.push(copy(descriptor.value, depth + 1));
      }
      return result;
    }
    const result: Record<string, unknown> = {};
    for (const key of keys as string[]) result[key] = copy((descriptors[key] as PropertyDescriptor).value, depth + 1);
    return result;
  };
  const result = copy(value, 0);
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > maxBytes) throw new DurableStateBoundaryError("record too large");
  return result;
}

function text(value: unknown, max = 160): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value &&
    ![...value].some((char) => { const cp = char.codePointAt(0) ?? 0; return cp <= 0x1f || cp === 0x7f; }) &&
    !([...value].some((char) => char.normalize("NFC") !== char));
}

function sha(value: unknown): value is DurableSha256 {
  return typeof value === "string" && SHA.test(value);
}

export function snapshotAggregateIdentity(value: unknown): AggregateIdentity {
  const copy = snapshot(value);
  if (!isPlain(copy) || !exact(copy, ["schema_version", "project_id", "change_key"]) || copy.schema_version !== 1 ||
      !text(copy.project_id) || !text(copy.change_key)) throw new DurableStateBoundaryError("aggregate identity invalid");
  return deepFreeze(copy as unknown as AggregateIdentity);
}

export function snapshotActorAuthority(value: unknown): HostActorAuthority {
  const copy = snapshot(value);
  if (!isPlain(copy) || !exact(copy, ["schema_version", "actor_id", "authority_kind", "authority_ref"]) ||
      copy.schema_version !== 1 || !text(copy.actor_id) || !["user", "agent", "service"].includes(String(copy.authority_kind)) ||
      !text(copy.authority_ref)) throw new DurableStateBoundaryError("actor authority invalid");
  return deepFreeze(copy as unknown as HostActorAuthority);
}

export function snapshotRecordDescriptor(value: unknown): RecordDescriptor {
  const copy = snapshot(value);
  if (!isPlain(copy) || !exactWithOptional(copy, ["schema_version", "record_kind", "record_id", "record_schema_version", "content_hash"],
    ["profile_ref", "planned_phase_set_ref"]) ||
      copy.schema_version !== 1 || !text(copy.record_kind) || !text(copy.record_id) ||
      !Number.isSafeInteger(copy.record_schema_version) || (copy.record_schema_version as number) < 1 || !sha(copy.content_hash)) {
    throw new DurableStateBoundaryError("record descriptor invalid");
  }
  const profileRef = copy.profile_ref === undefined ? undefined : snapshotRecordDescriptor(copy.profile_ref);
  const phaseSetRef = copy.planned_phase_set_ref === undefined ? undefined : snapshotRecordDescriptor(copy.planned_phase_set_ref);
  return deepFreeze({ ...copy, ...(profileRef === undefined ? {} : { profile_ref: profileRef }),
    ...(phaseSetRef === undefined ? {} : { planned_phase_set_ref: phaseSetRef }) } as RecordDescriptor);
}

export function snapshotArtifactBlobRef(value: unknown): ArtifactBlobRef {
  const copy = snapshot(value);
  if (!isPlain(copy) || !exact(copy, ["schema_version", "content_sha256", "byte_length", "media_type", "encoding", "storage_ref"]) ||
      copy.schema_version !== 1 || !sha(copy.content_sha256) || !Number.isSafeInteger(copy.byte_length) ||
      (copy.byte_length as number) < 0 || (copy.byte_length as number) > MAX_BLOB_BYTES || !text(copy.media_type, 256) ||
      !["identity", "gzip", "br"].includes(String(copy.encoding)) || !text(copy.storage_ref, 512)) {
    throw new DurableStateBoundaryError("artifact blob reference invalid");
  }
  return deepFreeze(copy as unknown as ArtifactBlobRef);
}

export function snapshotCommandIdentity(value: unknown): DurableCommandIdentity {
  const copy = snapshot(value);
  if (!isPlain(copy) || !exact(copy, ["schema_version", "idempotency_key", "command_hash"]) || copy.schema_version !== 1 ||
      !text(copy.idempotency_key) || !sha(copy.command_hash)) throw new DurableStateBoundaryError("command identity invalid");
  return deepFreeze(copy as unknown as DurableCommandIdentity);
}

export function snapshotDurableCommitInput(value: unknown): DurableCommitInput {
  const copy = snapshot(value);
  if (!isPlain(copy) || !exactWithOptional(copy, ["expected_revision", "aggregate", "actor", "command", "descriptor",
    "stream_kind", "event_kind", "previous_descriptor", "occurred_at"], ["run_id"]) ||
      !(copy.expected_revision === null || Number.isSafeInteger(copy.expected_revision) && (copy.expected_revision as number) >= 0) ||
      !STREAM_KINDS.includes(copy.stream_kind as DurableAuditStreamKind) || !text(copy.event_kind) ||
      !text(copy.occurred_at, 64) || !isValidTimestamp(copy.occurred_at) ||
      (copy.run_id !== undefined && !text(copy.run_id, 256))) {
    throw new DurableStateBoundaryError("commit input invalid");
  }
  const aggregate = snapshotAggregateIdentity(copy.aggregate);
  const actor = snapshotActorAuthority(copy.actor);
  const command = snapshotCommandIdentity(copy.command);
  const descriptor = snapshotRecordDescriptor(copy.descriptor);
  const previous_descriptor = copy.previous_descriptor === null ? null : snapshotRecordDescriptor(copy.previous_descriptor);
  return deepFreeze({ ...copy, aggregate, actor, command, descriptor, previous_descriptor } as DurableCommitInput);
}

export function snapshotAuditStreamKind(value: unknown): DurableAuditStreamKind {
  if (typeof value !== "string" || !STREAM_KINDS.includes(value as DurableAuditStreamKind)) {
    throw new DurableStateBoundaryError("audit stream kind invalid");
  }
  return value as DurableAuditStreamKind;
}

export function auditCursor(value: DurableAuditCursor): string {
  const normalized = snapshot(value, MAX_CURSOR_BYTES);
  if (!isPlain(normalized) || !exact(normalized, ["schema_version", "stream_revision", "event_id"]) || normalized.schema_version !== 1 ||
      !Number.isSafeInteger(normalized.stream_revision) || (normalized.stream_revision as number) < 0 ||
      !text(normalized.event_id, 256)) throw new DurableStateBoundaryError("audit cursor invalid");
  return Buffer.from(stableJson(normalized), "utf8").toString("base64url");
}

export function parseAuditCursor(value: unknown): DurableAuditCursor | null {
  if (typeof value !== "string" || value.length > MAX_CURSOR_BYTES) throw new DurableStateBoundaryError("audit cursor invalid");
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }
  catch { throw new DurableStateBoundaryError("audit cursor invalid"); }
  const normalized = snapshotAggregateLikeCursor(decoded);
  return normalized;
}

function snapshotAggregateLikeCursor(value: unknown): DurableAuditCursor {
  const copy = snapshot(value, MAX_CURSOR_BYTES);
  if (!isPlain(copy) || !exact(copy, ["schema_version", "stream_revision", "event_id"]) || copy.schema_version !== 1 ||
      !Number.isSafeInteger(copy.stream_revision) || (copy.stream_revision as number) < 0 || !text(copy.event_id, 256)) {
    throw new DurableStateBoundaryError("audit cursor invalid");
  }
  return deepFreeze(copy as unknown as DurableAuditCursor);
}

export function canonicalCommandHash(command: unknown): DurableSha256 {
  return stableHash(snapshot(command));
}

export function auditEventId(input: Pick<AuditEnvelopeV1, "aggregate" | "stream_kind" | "stream_revision" |
  "event_kind" | "occurred_at" | "actor" | "command" | "descriptor" | "previous_descriptor"> &
  Pick<AuditEnvelopeV1, "run_id">): string {
  const copy = snapshot(input);
  if (!isPlain(copy) || !exactWithOptional(copy, ["aggregate", "stream_kind", "stream_revision", "event_kind", "occurred_at",
    "actor", "command", "descriptor", "previous_descriptor"], ["run_id"]) ||
      (copy.run_id !== undefined && !text(copy.run_id, 256))) {
    throw new DurableStateBoundaryError("audit identity invalid");
  }
  const aggregate = snapshotAggregateIdentity(copy.aggregate);
  const actor = snapshotActorAuthority(copy.actor);
  const command = snapshotCommandIdentity(copy.command);
  const descriptor = snapshotRecordDescriptor(copy.descriptor);
  const previous = copy.previous_descriptor === null ? null : snapshotRecordDescriptor(copy.previous_descriptor);
  if (!STREAM_KINDS.includes(copy.stream_kind as DurableAuditStreamKind) ||
      !Number.isSafeInteger(copy.stream_revision) || (copy.stream_revision as number) < 1 ||
      !text(copy.event_kind) || !text(copy.occurred_at, 64) || !isValidTimestamp(copy.occurred_at)) {
    throw new DurableStateBoundaryError("audit identity invalid");
  }
  return `audit_event:${stableHash({ aggregate, stream_kind: copy.stream_kind, stream_revision: copy.stream_revision,
    event_kind: copy.event_kind, occurred_at: copy.occurred_at, actor, command, descriptor,
    previous_descriptor: previous, ...(copy.run_id === undefined ? {} : { run_id: copy.run_id }) })}`;
}

export function receiptId(input: unknown): string {
  return `durable_receipt:${stableHash(snapshot(input))}`;
}

export function snapshotAuditEnvelope(value: unknown): AuditEnvelopeV1 {
  const copy = snapshot(value);
  if (!isPlain(copy) || !exactWithOptional(copy, ["schema_version", "event_id", "aggregate", "stream_kind", "stream_revision",
    "event_kind", "occurred_at", "actor", "command", "descriptor", "previous_descriptor"], ["run_id"]) || copy.schema_version !== 1 ||
      typeof copy.event_id !== "string" || !EVENT_ID.test(copy.event_id) || !STREAM_KINDS.includes(copy.stream_kind as DurableAuditStreamKind) ||
      !Number.isSafeInteger(copy.stream_revision) || (copy.stream_revision as number) < 1 || !text(copy.event_kind) ||
      !text(copy.occurred_at, 64) || !isValidTimestamp(copy.occurred_at) ||
      (copy.run_id !== undefined && !text(copy.run_id, 256))) {
    throw new DurableStateBoundaryError("audit envelope invalid");
  }
  const aggregate = snapshotAggregateIdentity(copy.aggregate);
  const actor = snapshotActorAuthority(copy.actor);
  const command = snapshotCommandIdentity(copy.command);
  const descriptor = snapshotRecordDescriptor(copy.descriptor);
  const previous = copy.previous_descriptor === null ? null : snapshotRecordDescriptor(copy.previous_descriptor);
  const expected = auditEventId({ aggregate, stream_kind: copy.stream_kind as DurableAuditStreamKind,
    stream_revision: copy.stream_revision as number, event_kind: copy.event_kind as string,
    occurred_at: copy.occurred_at as string, actor, command, descriptor, previous_descriptor: previous,
    ...(copy.run_id === undefined ? {} : { run_id: copy.run_id as string }) });
  if (copy.event_id !== expected) throw new DurableStateBoundaryError("audit event id mismatch");
  return deepFreeze({ ...copy, aggregate, actor, command, descriptor, previous_descriptor: previous } as AuditEnvelopeV1);
}

function isValidTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
