import { isProxy } from "node:util/types";

import {
  DurableStateBoundaryError,
  InMemoryDurableStateStore,
  snapshotAggregateIdentity,
  snapshotDurableCommitInput,
  snapshotRecordDescriptor
} from "../../durable-state-primitives/index.js";
import type { RecordDescriptor } from "../../durable-state-primitives/index.js";
import { stableHash } from "../stable.js";
import {
  PLAN_CLASSIFICATION_STATE_RECORD_KIND,
  PLAN_CLASSIFICATION_STATE_STREAM_KIND,
  PLAN_PROFILE_RECORD_KIND,
  PLANNED_PHASE_SET_RECORD_KIND,
  type PlanClassificationChangeIdentity,
  type PlanClassificationStateAuditPage,
  type PlanClassificationStateCommitInput,
  type PlanClassificationStateCurrent,
  type PlanClassificationStatePort
} from "./types.js";

const EVENT_KINDS: readonly string[] = [
  "classification_created", "classification_reclassified", "phase_set_configured",
  "classification_state_committed"
];
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const REF_ID = /^(?:plan_profile|planned_phase_set):[a-f0-9]{64}$/u;

function invalid(detail: string): never {
  throw new DurableStateBoundaryError(`plan classification state: ${detail}`);
}

function root(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)) invalid("hostile root");
  const object = value as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(object);
  if (prototype !== Object.prototype && prototype !== null) invalid("non-canonical root");
  const descriptors = Object.getOwnPropertyDescriptors(object);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) invalid("symbol root key");
  const stringKeys = keys as string[];
  if (stringKeys.some((key) => !required.includes(key) && !optional.includes(key)) ||
      required.some((key) => !Object.hasOwn(descriptors, key))) invalid("root fields invalid");
  const result: Record<string, unknown> = {};
  for (const key of stringKeys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined ||
        descriptor.set !== undefined || descriptor.enumerable !== true) invalid("accessor root field");
    result[key] = descriptor.value;
  }
  return result;
}

function text(value: unknown, max = 160): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    value.trim() === value && ![...value].some((char) => (char.codePointAt(0) ?? 0) <= 0x1f ||
      (char.codePointAt(0) ?? 0) === 0x7f);
}

function snapshotIdentity(value: unknown): PlanClassificationChangeIdentity {
  const copy = root(value, ["schema_version", "project_id", "change_id", "change_key"]);
  if (copy.schema_version !== 1 || !text(copy.change_id) || !ID.test(copy.change_id) ||
      copy.change_id !== copy.change_key) invalid("change_id/change_key mapping invalid");
  const aggregate = snapshotAggregateIdentity({
    schema_version: 1, project_id: copy.project_id, change_key: copy.change_key
  });
  return Object.freeze({ ...aggregate, change_id: copy.change_id }) as PlanClassificationChangeIdentity;
}

function snapshotRef(value: unknown, kind: string): RecordDescriptor {
  const descriptor = snapshotRecordDescriptor(value);
  if (descriptor.record_kind !== kind || !REF_ID.test(descriptor.record_id) ||
      !descriptor.record_id.startsWith(`${kind}:`)) invalid(`${kind} reference invalid`);
  return descriptor;
}

function validateStateDescriptor(value: unknown): RecordDescriptor {
  const descriptor = snapshotRecordDescriptor(value);
  if (descriptor.record_kind !== PLAN_CLASSIFICATION_STATE_RECORD_KIND ||
      descriptor.profile_ref === undefined || descriptor.planned_phase_set_ref === undefined) {
    invalid("compound state descriptor is incomplete");
  }
  const profileRef = snapshotRef(descriptor.profile_ref, PLAN_PROFILE_RECORD_KIND);
  const phaseSetRef = snapshotRef(descriptor.planned_phase_set_ref, PLANNED_PHASE_SET_RECORD_KIND);
  const expected = planClassificationStateDescriptor(profileRef, phaseSetRef);
  if (stableHash(descriptor) !== stableHash(expected)) invalid("compound state descriptor integrity invalid");
  return descriptor;
}

export function planClassificationStateDescriptor(
  profileRefInput: RecordDescriptor,
  phaseSetRefInput: RecordDescriptor
): RecordDescriptor {
  const profileRef = snapshotRef(profileRefInput, PLAN_PROFILE_RECORD_KIND);
  const phaseSetRef = snapshotRef(phaseSetRefInput, PLANNED_PHASE_SET_RECORD_KIND);
  const contentHash = stableHash({ profile_ref: profileRef, planned_phase_set_ref: phaseSetRef });
  return Object.freeze({
    schema_version: 1 as const,
    record_kind: PLAN_CLASSIFICATION_STATE_RECORD_KIND,
    record_id: `${PLAN_CLASSIFICATION_STATE_RECORD_KIND}:${contentHash.slice(7)}`,
    record_schema_version: 1,
    content_hash: contentHash,
    profile_ref: profileRef,
    planned_phase_set_ref: phaseSetRef
  });
}

function snapshotCommit(value: unknown): {
  input: PlanClassificationStateCommitInput;
  profileRef: RecordDescriptor;
  phaseSetRef: RecordDescriptor;
} {
  const copy = root(value, ["expected_revision", "aggregate", "actor", "command", "descriptor", "stream_kind",
    "event_kind", "previous_descriptor", "occurred_at", "change_id", "profile_ref", "planned_phase_set_ref"], ["run_id"]);
  const aggregate = snapshotAggregateIdentity(copy.aggregate);
  if (!text(copy.change_id) || !ID.test(copy.change_id) || copy.change_id !== aggregate.change_key) {
    invalid("change_id/change_key mapping invalid");
  }
  const profileRef = snapshotRef(copy.profile_ref, PLAN_PROFILE_RECORD_KIND);
  const phaseSetRef = snapshotRef(copy.planned_phase_set_ref, PLANNED_PHASE_SET_RECORD_KIND);
  const descriptor = snapshotRecordDescriptor(copy.descriptor);
  const expectedDescriptor = planClassificationStateDescriptor(profileRef, phaseSetRef);
  if (stableHash(descriptor) !== stableHash(expectedDescriptor)) invalid("state descriptor mismatch");
  if (descriptor.record_kind !== PLAN_CLASSIFICATION_STATE_RECORD_KIND ||
      (copy.previous_descriptor !== null &&
        snapshotRecordDescriptor(copy.previous_descriptor).record_kind !== PLAN_CLASSIFICATION_STATE_RECORD_KIND)) {
    invalid("state record kind invalid");
  }
  const durable = snapshotDurableCommitInput({
    expected_revision: copy.expected_revision, aggregate, actor: copy.actor, command: copy.command, descriptor,
    stream_kind: copy.stream_kind, event_kind: copy.event_kind, previous_descriptor: copy.previous_descriptor,
    occurred_at: copy.occurred_at, ...(copy.run_id === undefined ? {} : { run_id: copy.run_id })
  });
  if (durable.stream_kind !== PLAN_CLASSIFICATION_STATE_STREAM_KIND || !EVENT_KINDS.includes(durable.event_kind)) {
    invalid("stream or event kind invalid");
  }
  return {
    input: Object.freeze({ ...durable, change_id: copy.change_id, profile_ref: profileRef,
      planned_phase_set_ref: phaseSetRef }) as PlanClassificationStateCommitInput,
    profileRef,
    phaseSetRef
  };
}

function identityAggregate(identity: PlanClassificationChangeIdentity) {
  const safe = snapshotIdentity(identity);
  return { identity: safe, aggregate: { schema_version: 1 as const, project_id: safe.project_id, change_key: safe.change_key } };
}

export class InMemoryPlanClassificationStatePort implements PlanClassificationStatePort {
  constructor(private readonly store = new InMemoryDurableStateStore()) {}

  async commit(value: PlanClassificationStateCommitInput) {
    const { input } = snapshotCommit(value);
    const result = this.store.commit({
      expected_revision: input.expected_revision,
      aggregate: input.aggregate,
      actor: input.actor,
      command: input.command,
      descriptor: input.descriptor,
      stream_kind: input.stream_kind,
      event_kind: input.event_kind,
      previous_descriptor: input.previous_descriptor,
      occurred_at: input.occurred_at,
      ...(input.run_id === undefined ? {} : { run_id: input.run_id })
    });
    return result;
  }

  async getCurrent(value: PlanClassificationChangeIdentity): Promise<PlanClassificationStateCurrent> {
    const { identity, aggregate } = identityAggregate(value);
    const current = this.store.getCurrent(aggregate);
    const descriptor = current.descriptor === null ? null : validateStateDescriptor(current.descriptor);
    const refs = descriptor?.profile_ref !== undefined && descriptor.planned_phase_set_ref !== undefined
      ? { profileRef: descriptor.profile_ref, phaseSetRef: descriptor.planned_phase_set_ref }
      : undefined;
    return Object.freeze({ aggregate, change_id: identity.change_id, revision: current.revision,
      descriptor, profile_ref: refs?.profileRef ?? null,
      planned_phase_set_ref: refs?.phaseSetRef ?? null });
  }

  async listAudit(value: PlanClassificationChangeIdentity, limit: number, cursor?: string):
    Promise<PlanClassificationStateAuditPage> {
    const { aggregate } = identityAggregate(value);
    const page = this.store.listAudit(aggregate, PLAN_CLASSIFICATION_STATE_STREAM_KIND, limit, cursor);
    const events = page.events.map((event) => {
      if (!EVENT_KINDS.includes(event.event_kind) || event.stream_kind !== PLAN_CLASSIFICATION_STATE_STREAM_KIND ||
          stableHash(event.aggregate) !== stableHash(aggregate)) invalid("stored audit identity invalid");
      const descriptor = validateStateDescriptor(event.descriptor);
      const previous = event.previous_descriptor === null ? null : validateStateDescriptor(event.previous_descriptor);
      return Object.freeze({ ...event, descriptor, previous_descriptor: previous });
    });
    return Object.freeze({ ...page, aggregate, events }) as PlanClassificationStateAuditPage;
  }
}

export function createInMemoryPlanClassificationStatePort(
  store?: InMemoryDurableStateStore
): PlanClassificationStatePort {
  return new InMemoryPlanClassificationStatePort(store);
}
