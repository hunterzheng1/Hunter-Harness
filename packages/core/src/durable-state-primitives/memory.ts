import {
  auditCursor,
  auditEventId,
  canonicalCommandHash,
  deepFreeze,
  parseAuditCursor,
  receiptId,
  snapshotAggregateIdentity,
  snapshotAuditEnvelope,
  snapshotAuditStreamKind,
  snapshotDurableCommitInput
} from "./module.js";
import type {
  AggregateIdentity,
  AuditEnvelopeV1,
  DurableAuditPage,
  DurableCommitInput,
  DurableCommitResult,
  DurableMutationReceipt,
  RecordDescriptor
} from "./types.js";

interface StoredAggregate {
  revision: number;
  descriptor: RecordDescriptor | null;
  events: AuditEnvelopeV1[];
  commands: Map<string, { hash: string; fingerprint: string; receipt: DurableMutationReceipt }>;
}

function aggregateKey(aggregate: AggregateIdentity): string {
  return `${aggregate.project_id}\u0000${aggregate.change_key}`;
}

export class InMemoryDurableStateStore {
  private readonly records = new Map<string, StoredAggregate>();

  private state(aggregate: AggregateIdentity): StoredAggregate {
    const key = aggregateKey(aggregate);
    let value = this.records.get(key);
    if (value === undefined) {
      value = { revision: 0, descriptor: null, events: [], commands: new Map() };
      this.records.set(key, value);
    }
    return value;
  }

  commit(input: DurableCommitInput): DurableCommitResult {
    const safeInput = snapshotDurableCommitInput(input);
    const aggregate = safeInput.aggregate;
    const actor = safeInput.actor;
    const command = safeInput.command;
    const descriptor = safeInput.descriptor;
    const fingerprint = canonicalCommandHash({ aggregate, actor, idempotency_key: command.idempotency_key,
      descriptor, stream_kind: safeInput.stream_kind, event_kind: safeInput.event_kind,
      previous_descriptor: safeInput.previous_descriptor, expected_revision: safeInput.expected_revision,
      occurred_at: safeInput.occurred_at, ...(safeInput.run_id === undefined ? {} : { run_id: safeInput.run_id }) });
    const state = this.state(aggregate);
    const existing = state.commands.get(command.idempotency_key);
    if (existing !== undefined) {
      if (existing.hash !== command.command_hash || existing.fingerprint !== fingerprint) {
        return deepFreeze({ outcome: "idempotency_conflict", receipt: null, current_revision: state.revision });
      }
      return deepFreeze({ outcome: "replayed", receipt: existing.receipt, current_revision: state.revision });
    }
    if (safeInput.expected_revision !== null && safeInput.expected_revision !== state.revision) {
      return deepFreeze({ outcome: "revision_conflict", receipt: null, current_revision: state.revision });
    }
    const previous = safeInput.previous_descriptor;
    const current = state.descriptor;
    if ((previous === null && current !== null) || (previous !== null &&
        (current === null || stableDescriptorHash(current) !== stableDescriptorHash(previous)))) {
      return deepFreeze({ outcome: "revision_conflict", receipt: null, current_revision: state.revision });
    }
    const revision = state.revision + 1;
    const envelopeBase = {
      schema_version: 1 as const,
      aggregate,
      stream_kind: safeInput.stream_kind,
      stream_revision: revision,
      event_kind: safeInput.event_kind,
      occurred_at: safeInput.occurred_at,
      actor,
      command,
      descriptor,
      previous_descriptor: previous,
      ...(safeInput.run_id === undefined ? {} : { run_id: safeInput.run_id })
    };
    const event = snapshotAuditEnvelope({ ...envelopeBase,
      event_id: auditEventId({ aggregate, stream_kind: safeInput.stream_kind, stream_revision: revision,
        event_kind: safeInput.event_kind, occurred_at: safeInput.occurred_at, actor, command, descriptor,
        previous_descriptor: previous, ...(safeInput.run_id === undefined ? {} : { run_id: safeInput.run_id }) }) });
    const receiptBase = {
      schema_version: 1 as const,
      outcome: "committed" as const,
      aggregate,
      command,
      revision,
      descriptor,
      audit_event_id: event.event_id
    };
    const receipt: DurableMutationReceipt = deepFreeze({ ...receiptBase, receipt_id: receiptId(receiptBase) });
    state.revision = revision;
    state.descriptor = descriptor;
    state.events.push(event);
    state.commands.set(command.idempotency_key, { hash: command.command_hash, fingerprint, receipt });
    return deepFreeze({ outcome: "committed", receipt, current_revision: revision });
  }

  getCurrent(aggregateInput: AggregateIdentity): { revision: number; descriptor: RecordDescriptor | null } {
    const aggregate = snapshotAggregateIdentity(aggregateInput);
    const state = this.state(aggregate);
    return deepFreeze({ revision: state.revision, descriptor: state.descriptor });
  }

  listAudit(aggregateInput: AggregateIdentity, streamKind: AuditEnvelopeV1["stream_kind"], limit: number,
    cursor?: string): DurableAuditPage {
    const aggregate = snapshotAggregateIdentity(aggregateInput);
    const safeStreamKind = snapshotAuditStreamKind(streamKind);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("DURABLE_STATE_LIMIT_INVALID");
    const state = this.state(aggregate);
    const parsedCursor = cursor === undefined ? null : parseAuditCursor(cursor);
    if (parsedCursor !== null) {
      const cursorEvent = state.events.find((event) => event.stream_revision === parsedCursor.stream_revision &&
        event.event_id === parsedCursor.event_id && event.stream_kind === safeStreamKind);
      if (cursorEvent === undefined) throw new Error("DURABLE_STATE_CURSOR_INVALID");
    }
    const start = parsedCursor?.stream_revision ?? 0;
    const events = state.events.filter((event) => event.stream_kind === safeStreamKind && event.stream_revision > start);
    const page = events.slice(0, limit);
    const last = page.at(-1);
    return deepFreeze({ aggregate, stream_kind: safeStreamKind, events: page,
      next_cursor: page.length < events.length && last !== undefined ? auditCursor({
        schema_version: 1, stream_revision: last.stream_revision, event_id: last.event_id
      }) : null });
  }
}

function stableDescriptorHash(value: RecordDescriptor): string {
  return `${value.record_kind}\u0000${value.record_id}\u0000${value.record_schema_version}\u0000${value.content_hash}\u0000${
    value.profile_ref === undefined ? "" : stableDescriptorHash(value.profile_ref)}\u0000${
    value.planned_phase_set_ref === undefined ? "" : stableDescriptorHash(value.planned_phase_set_ref)}`;
}
