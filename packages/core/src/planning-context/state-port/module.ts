import { isProxy } from "node:util/types";

import { planProfileSchema } from "../../plan-classification/schemas.js";
import {
  DurableStateBoundaryError,
  auditCursor,
  auditEventId,
  canonicalCommandHash,
  parseAuditCursor,
  receiptId,
  snapshotAggregateIdentity,
  snapshotAuditEnvelope,
  snapshotDurableCommitInput,
  snapshotRecordDescriptor
} from "../../durable-state-primitives/index.js";
import type {
  AggregateIdentity,
  DurableCommitResult,
  DurableMutationReceipt,
  RecordDescriptor
} from "../../durable-state-primitives/index.js";
import { normalizePlanningContextRecord } from "../compatibility.js";
import { createPlanningContextModule } from "../module.js";
import { planningContextSchema } from "../schemas.js";
import { deepFreeze, stableHash } from "../stable.js";
import type { PlanningContext, PlanningPartition, PlanningPartitionUpdate, PlanningPartitionUpdates } from "../types.js";
import {
  PLANNING_CONTEXT_STATE_RECORD_KIND,
  PLANNING_CONTEXT_STATE_STREAM_KIND,
  type PlanningContextStateAuditEvent,
  type PlanningContextStateAuditPage,
  type PlanningContextStateCommitInput,
  type PlanningContextStateCurrent,
  type PlanningContextEventDeliveryAckInput,
  type PlanningContextEventDeliveryRecord,
  type PlanningContextStateLegacyView,
  type PlanningContextStatePort
} from "./types.js";

const EVENT_KINDS = ["context_created", "context_replaced", "partitions_invalidated"] as const;
const PARTITIONS = ["intent", "knowledge", "evidence", "rules", "map", "profile", "phases"] as const;
const MAX_RECORD_BYTES = 65_536;
const planningContextModule = createPlanningContextModule();

function invalid(detail: string): never {
  throw new DurableStateBoundaryError(`planning context state: ${detail}`);
}

function snapshot(value: unknown): unknown {
  const seen = new WeakSet<object>();
  let nodes = 0;
  let textUnits = 0;
  const copy = (input: unknown, depth: number): unknown => {
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "string") {
      textUnits += input.length;
      if (input.length > 16_384 || textUnits > 32_768) invalid("text budget exceeded");
      return input;
    }
    if (typeof input === "number") {
      if (!Number.isFinite(input)) invalid("non-finite number");
      return input;
    }
    if (typeof input !== "object" || isProxy(input) || depth > 16 || ++nodes > 2_048 || seen.has(input)) {
      invalid("hostile or unbounded input");
    }
    seen.add(input);
    const array = Array.isArray(input);
    const prototype = Object.getPrototypeOf(input);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      invalid("non-canonical prototype");
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) invalid("symbol key");
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined ||
          descriptor.set !== undefined || (array && key === "length" ? false : descriptor.enumerable !== true)) {
        invalid("accessor or hidden property");
      }
    }
    if (array) {
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > 128 ||
          keys.length !== (length as number) + 1) invalid("invalid array");
      const result: unknown[] = [];
      for (let index = 0; index < (length as number); index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !("value" in descriptor)) invalid("sparse array");
        result.push(copy(descriptor.value, depth + 1));
      }
      return result;
    }
    const result: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      result[key] = copy((descriptors[key] as PropertyDescriptor).value, depth + 1);
    }
    return result;
  };
  const result = copy(value, 0);
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_RECORD_BYTES) invalid("record too large");
  return result;
}

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value: unknown, maximum = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value.trim() === value &&
    value.normalize("NFC") === value && ![...value].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point <= 0x1f || point === 0x7f;
    });
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function exactWithOptional(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
}

function sameDescriptor(left: RecordDescriptor | null, right: RecordDescriptor | null): boolean {
  return left === right || left !== null && right !== null && stableHash(left) === stableHash(right);
}

export function planningContextStateDescriptor(value: PlanningContext): RecordDescriptor {
  const context = snapshotContext(value);
  const contentHash = stableHash(context);
  return deepFreeze({
    schema_version: 1,
    record_kind: PLANNING_CONTEXT_STATE_RECORD_KIND,
    record_id: `${PLANNING_CONTEXT_STATE_RECORD_KIND}:${contentHash.slice(7)}`,
    record_schema_version: 1,
    content_hash: contentHash
  });
}

function snapshotContext(value: unknown): PlanningContext {
  const safe = snapshot(value);
  const parsed = planningContextSchema.safeParse(safe);
  if (!parsed.success) invalid("context payload invalid");
  return deepFreeze(parsed.data);
}

export function snapshotPlanningContextStateCommitInput(value: unknown): PlanningContextStateCommitInput {
  const safe = snapshot(value);
  if (!record(safe) || !exactWithOptional(safe, ["expected_revision", "aggregate", "actor", "command", "profile",
    "context", "descriptor", "stream_kind", "event_kind", "previous_descriptor", "occurred_at"], ["run_id", "partition_updates"])) {
    invalid("commit fields invalid");
  }
  const profile = planProfileSchema.safeParse(safe.profile);
  if (!profile.success) invalid("profile invalid");
  const context = snapshotContext(safe.context);
  const aggregate = snapshotAggregateIdentity(safe.aggregate);
  if (aggregate.change_key !== profile.data.change_id) invalid("change_key/profile change_id mapping invalid");
  if (context.plan_profile_ref !== profile.data.profile_id) invalid("context profile reference invalid");
  if (context.partition_hashes.profile !== stableHash(profile.data.classification_hash)) {
    invalid("context profile partition invalid");
  }
  const descriptor = snapshotRecordDescriptor(safe.descriptor);
  const expected = planningContextStateDescriptor(context);
  if (stableHash(descriptor) !== stableHash(expected)) invalid("context descriptor mismatch");
  const durable = snapshotDurableCommitInput({
    expected_revision: safe.expected_revision, aggregate, actor: safe.actor, command: safe.command, descriptor,
    stream_kind: safe.stream_kind, event_kind: safe.event_kind, previous_descriptor: safe.previous_descriptor,
    occurred_at: safe.occurred_at, ...(safe.run_id === undefined ? {} : { run_id: safe.run_id })
  });
  if (durable.stream_kind !== PLANNING_CONTEXT_STATE_STREAM_KIND ||
      !EVENT_KINDS.includes(durable.event_kind as typeof EVENT_KINDS[number]) ||
      (durable.previous_descriptor !== null && durable.previous_descriptor.record_kind !== PLANNING_CONTEXT_STATE_RECORD_KIND)) {
    invalid("record, stream, or event kind invalid");
  }
  return deepFreeze({ ...durable, profile: profile.data, context,
    ...(safe.partition_updates === undefined ? {} : { partition_updates: safe.partition_updates as PlanningPartitionUpdates })
  }) as PlanningContextStateCommitInput;
}

function partitionUpdateHash(update: PlanningPartitionUpdate<unknown>): string | null | undefined {
  if (update.operation === "unchanged") return undefined;
  return update.operation === "remove" ? null : stableHash(update.value);
}

function validatePartitionInvalidation(previous: PlanningContext, input: PlanningContextStateCommitInput): void {
  if (input.event_kind !== "partitions_invalidated") {
    if (input.partition_updates !== undefined) invalid("partition updates require partitions_invalidated");
    return;
  }
  if (input.partition_updates === undefined) invalid("partition updates required");
  let closure: ReturnType<typeof planningContextModule.invalidatePartitions>;
  try { closure = planningContextModule.invalidatePartitions(previous, input.partition_updates); }
  catch { invalid("partition dependency closure invalid"); }
  const direct = {
    intent: input.partition_updates.intent_hash,
    knowledge: input.partition_updates.knowledge_context_ref,
    evidence: input.partition_updates.evidence_map_ref,
    rules: input.partition_updates.rules_manifest_hash,
    map: input.partition_updates.map_manifest_hash,
    profile: input.partition_updates.profile_classification_hash,
    phases: input.partition_updates.phase_set_ref
  } satisfies Record<PlanningPartition, PlanningPartitionUpdate<unknown>>;
  for (const partition of PARTITIONS) {
    const expected = partitionUpdateHash(direct[partition]);
    if (expected !== undefined && input.context.partition_hashes[partition] !== expected) {
      invalid("partition update payload mismatch");
    }
  }
  const actual = PARTITIONS.filter((partition) =>
    previous.partition_hashes[partition] !== input.context.partition_hashes[partition]).sort();
  if (closure.invalidated_partitions.length === 0 || actual.length !== closure.invalidated_partitions.length ||
      actual.some((partition, index) => partition !== closure.invalidated_partitions[index])) {
    invalid("partition dependency closure mismatch");
  }
}

interface StoredRecord {
  readonly context: PlanningContext;
  readonly descriptor: RecordDescriptor;
}

interface StoredCommand {
  readonly hash: string;
  readonly fingerprint: string;
  readonly receipt: DurableMutationReceipt;
}

interface StoredAggregate {
  readonly aggregate: AggregateIdentity;
  revision: number;
  current: StoredRecord | null;
  readonly events: PlanningContextStateAuditEvent[];
  readonly deliveries: PlanningContextEventDeliveryRecord[];
  readonly commands: Map<string, StoredCommand>;
}

export function snapshotPlanningContextEventDeliveryAckInput(value: unknown): PlanningContextEventDeliveryAckInput {
  const safe = snapshot(value);
  if (!record(safe) || !exactWithOptional(safe, ["aggregate", "outbox_id", "audit_event_id",
    "delivery_receipt_id", "acknowledged_at"], []) || !text(safe.outbox_id) ||
      !safe.outbox_id.startsWith("planning_context_event_outbox:") || !text(safe.audit_event_id) ||
      !text(safe.delivery_receipt_id) || !timestamp(safe.acknowledged_at)) {
    invalid("delivery acknowledgement invalid");
  }
  return deepFreeze({ ...safe, aggregate: snapshotAggregateIdentity(safe.aggregate) } as unknown as PlanningContextEventDeliveryAckInput);
}

function aggregateKey(value: AggregateIdentity): string {
  return `${value.project_id}\u0000${value.change_key}`;
}

/** Single authoritative reference store: payload, descriptor, audit, and receipt share one aggregate record. */
export class InMemoryPlanningContextStateStore {
  private readonly records = new Map<string, StoredAggregate>();

  private state(aggregate: AggregateIdentity): StoredAggregate {
    const key = aggregateKey(aggregate);
    let state = this.records.get(key);
    if (state === undefined) {
      state = { aggregate, revision: 0, current: null, events: [], deliveries: [], commands: new Map() };
      this.records.set(key, state);
    }
    return state;
  }

  commit(value: unknown): DurableCommitResult {
    const input = snapshotPlanningContextStateCommitInput(value);
    const state = this.state(input.aggregate);
    const fingerprint = canonicalCommandHash({ aggregate: input.aggregate, actor: input.actor,
      idempotency_key: input.command.idempotency_key, profile: input.profile, context: input.context,
      descriptor: input.descriptor, stream_kind: input.stream_kind, event_kind: input.event_kind,
      previous_descriptor: input.previous_descriptor, expected_revision: input.expected_revision,
      occurred_at: input.occurred_at, ...(input.run_id === undefined ? {} : { run_id: input.run_id }),
      ...(input.partition_updates === undefined ? {} : { partition_updates: input.partition_updates }) });
    const existing = state.commands.get(input.command.idempotency_key);
    if (existing !== undefined) {
      if (existing.hash !== input.command.command_hash || existing.fingerprint !== fingerprint) {
        return deepFreeze({ outcome: "idempotency_conflict", receipt: null, current_revision: state.revision });
      }
      return deepFreeze({ outcome: "replayed", receipt: existing.receipt, current_revision: state.revision });
    }
    if (input.expected_revision !== null && input.expected_revision !== state.revision ||
        !sameDescriptor(input.previous_descriptor, state.current?.descriptor ?? null)) {
      return deepFreeze({ outcome: "revision_conflict", receipt: null, current_revision: state.revision });
    }
    const replacing = input.event_kind !== "context_created";
    if ((!replacing && (state.current !== null || input.context.supersedes !== undefined)) ||
        (replacing && (state.current === null || input.context.supersedes !== state.current.context.context_id))) {
      invalid("replacement lineage invalid");
    }
    if (state.current !== null) {
      validatePartitionInvalidation(state.current.context, input);
      const partitionDelta = PARTITIONS.some((partition) =>
        state.current?.context.partition_hashes[partition] !== input.context.partition_hashes[partition]);
      if ((input.event_kind === "context_replaced" && partitionDelta) ||
          (input.event_kind === "partitions_invalidated" && !partitionDelta)) {
        invalid("replacement event semantics invalid");
      }
    }
    const revision = state.revision + 1;
    const envelope = snapshotAuditEnvelope({
      schema_version: 1, event_id: auditEventId({ aggregate: input.aggregate, stream_kind: input.stream_kind,
        stream_revision: revision, event_kind: input.event_kind, occurred_at: input.occurred_at,
        actor: input.actor, command: input.command, descriptor: input.descriptor,
        previous_descriptor: input.previous_descriptor, ...(input.run_id === undefined ? {} : { run_id: input.run_id }) }),
      aggregate: input.aggregate, stream_kind: input.stream_kind, stream_revision: revision,
      event_kind: input.event_kind, occurred_at: input.occurred_at, actor: input.actor, command: input.command,
      descriptor: input.descriptor, previous_descriptor: input.previous_descriptor,
      ...(input.run_id === undefined ? {} : { run_id: input.run_id })
    });
    const event = deepFreeze({ ...envelope, event_kind: input.event_kind, context: input.context });
    const outboxIdentity = stableHash({ aggregate: input.aggregate, audit_event_id: event.event_id });
    const delivery = deepFreeze({ schema_version: 1 as const,
      outbox_id: `planning_context_event_outbox:${outboxIdentity.slice(7)}` as const,
      aggregate: input.aggregate, audit_event_id: event.event_id, event,
      state: "pending" as const, delivery: null });
    const receiptBase = { schema_version: 1 as const, outcome: "committed" as const, aggregate: input.aggregate,
      command: input.command, revision, descriptor: input.descriptor, audit_event_id: event.event_id };
    const receipt = deepFreeze({ ...receiptBase, receipt_id: receiptId(receiptBase) });
    state.revision = revision;
    state.current = { context: input.context, descriptor: input.descriptor };
    state.events.push(event);
    state.deliveries.push(delivery);
    state.commands.set(input.command.idempotency_key, { hash: input.command.command_hash, fingerprint, receipt });
    return deepFreeze({ outcome: "committed", receipt, current_revision: revision });
  }

  current(aggregateInput: unknown): PlanningContextStateCurrent {
    const aggregate = snapshotAggregateIdentity(aggregateInput);
    const state = this.state(aggregate);
    return deepFreeze({ aggregate, revision: state.revision, descriptor: state.current?.descriptor ?? null,
      context: state.current?.context ?? null });
  }

  audit(aggregateInput: unknown, limit: number, cursor?: string): PlanningContextStateAuditPage {
    const aggregate = snapshotAggregateIdentity(aggregateInput);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("DURABLE_STATE_LIMIT_INVALID");
    const state = this.state(aggregate);
    const parsed = cursor === undefined ? null : parseAuditCursor(cursor);
    if (parsed !== null && !state.events.some((event) => event.stream_revision === parsed.stream_revision &&
        event.event_id === parsed.event_id)) throw new Error("DURABLE_STATE_CURSOR_INVALID");
    const remaining = state.events.filter((event) => event.stream_revision > (parsed?.stream_revision ?? 0));
    const events = remaining.slice(0, limit);
    const last = events.at(-1);
    return deepFreeze({ aggregate, stream_kind: PLANNING_CONTEXT_STATE_STREAM_KIND, events,
      next_cursor: events.length < remaining.length && last !== undefined ? auditCursor({ schema_version: 1,
        stream_revision: last.stream_revision, event_id: last.event_id }) : null });
  }

  pending(aggregateInput: unknown, limit: number): readonly PlanningContextEventDeliveryRecord[] {
    const aggregate = snapshotAggregateIdentity(aggregateInput);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("DURABLE_STATE_LIMIT_INVALID");
    return deepFreeze(this.state(aggregate).deliveries.filter((entry) => entry.state === "pending").slice(0, limit));
  }

  delivery(aggregateInput: unknown, outboxId: unknown): PlanningContextEventDeliveryRecord | null {
    const aggregate = snapshotAggregateIdentity(aggregateInput);
    if (!text(outboxId) || !outboxId.startsWith("planning_context_event_outbox:")) {
      invalid("delivery identity invalid");
    }
    return this.state(aggregate).deliveries.find((entry) => entry.outbox_id === outboxId) ?? null;
  }

  acknowledge(value: unknown): PlanningContextEventDeliveryRecord {
    const safe = snapshotPlanningContextEventDeliveryAckInput(value);
    const aggregate = safe.aggregate;
    const state = this.state(aggregate);
    const index = state.deliveries.findIndex((entry) => entry.outbox_id === safe.outbox_id);
    const current = state.deliveries[index];
    if (current === undefined || current.audit_event_id !== safe.audit_event_id) {
      invalid("delivery identity invalid");
    }
    if (current.state === "acknowledged") {
      if (current.delivery?.receipt_id !== safe.delivery_receipt_id ||
          current.delivery.acknowledged_at !== safe.acknowledged_at) {
        invalid("delivery acknowledgement conflict");
      }
      return current;
    }
    const acknowledged = deepFreeze({ ...current, state: "acknowledged" as const, delivery: {
      receipt_id: safe.delivery_receipt_id, acknowledged_at: safe.acknowledged_at
    } }) as PlanningContextEventDeliveryRecord;
    state.deliveries[index] = acknowledged;
    return acknowledged;
  }
}

export class InMemoryPlanningContextStatePort implements PlanningContextStatePort {
  constructor(private readonly store = new InMemoryPlanningContextStateStore()) {}

  async commit(input: PlanningContextStateCommitInput): Promise<DurableCommitResult> {
    return this.store.commit(input);
  }

  async getCurrent(aggregate: AggregateIdentity): Promise<PlanningContextStateCurrent> {
    return this.store.current(aggregate);
  }

  async listAudit(aggregate: AggregateIdentity, limit: number, cursor?: string): Promise<PlanningContextStateAuditPage> {
    return this.store.audit(aggregate, limit, cursor);
  }

  async listPendingDeliveries(
    aggregate: AggregateIdentity,
    limit: number
  ): Promise<readonly PlanningContextEventDeliveryRecord[]> {
    return this.store.pending(aggregate, limit);
  }

  async getDelivery(
    aggregate: AggregateIdentity,
    outboxId: PlanningContextEventDeliveryRecord["outbox_id"]
  ): Promise<PlanningContextEventDeliveryRecord | null> {
    return this.store.delivery(aggregate, outboxId);
  }

  async acknowledgeDelivery(input: PlanningContextEventDeliveryAckInput): Promise<PlanningContextEventDeliveryRecord> {
    return this.store.acknowledge(input);
  }
}

export function createInMemoryPlanningContextStatePort(
  store?: InMemoryPlanningContextStateStore
): PlanningContextStatePort {
  return new InMemoryPlanningContextStatePort(store);
}

export function normalizePlanningContextStateLegacy(input: unknown): PlanningContextStateLegacyView {
  let safe: unknown;
  try { safe = snapshot(input); }
  catch { throw new Error("PLANNING_CONTEXT_LEGACY_INVALID"); }
  const normalized = normalizePlanningContextRecord(safe);
  if (!normalized.ok || normalized.source_schema_version !== 0) {
    throw new Error("PLANNING_CONTEXT_LEGACY_INVALID");
  }
  return normalized;
}
