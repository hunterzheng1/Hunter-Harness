import {
  derivePlanDurablePublicationFilesystemReadbackHash,
  derivePlanDurablePublicationFilesystemBinding
} from "../durable-publication-filesystem-contract/index.js";
import type {
  PlanDurablePublicationFilesystemApplyRequest,
  PlanDurablePublicationFilesystemInspectRequest,
  PlanDurablePublicationFilesystemPortInspection,
  PlanDurablePublicationFilesystemPrepareRequest,
  PlanDurablePublicationFilesystemReadback,
  PlanDurablePublicationFilesystemRollbackRequest,
  PlanDurablePublicationFilesystemTransactionInspection
} from "../durable-publication-filesystem-contract/types.js";
import type {
  InMemoryPlanFinalizationEventOutboxPortOptions,
  InMemoryPlanFinalizationFilesystemPortOptions,
  PlanFinalizationEventOutboxDeliveryInput,
  PlanFinalizationEventOutboxEnqueueInput,
  PlanFinalizationEventOutboxRecord,
  PlanFinalizationTransactionRecord
} from "./types.js";
import type { PlanDurablePublicationFilesystemTransactionPort } from "../durable-publication-filesystem-contract/types.js";

const memoryNow = "2026-08-15T10:00:00.000Z";

interface MemoryFilesystemRecord {
  readonly request: PlanDurablePublicationFilesystemPrepareRequest;
  state: "prepared" | "applying" | "committed" | "recovery_required" | "rolled_back";
}

export class InMemoryPlanFinalizationFilesystemPort implements PlanDurablePublicationFilesystemTransactionPort {
  readonly calls = { prepare: 0, apply: 0, inspect: 0, readback: 0 };
  private readonly records = new Map<string, MemoryFilesystemRecord>();
  private readonly applyOutcome: InMemoryPlanFinalizationFilesystemPortOptions["apply_outcome"];

  constructor(options: InMemoryPlanFinalizationFilesystemPortOptions = {}) {
    this.applyOutcome = options.apply_outcome;
  }

  private view(operationId: string): PlanDurablePublicationFilesystemTransactionInspection {
    const record = this.records.get(operationId);
    if (record === undefined) return { operation_id: operationId, state: "unknown", receipt: null, recovery_token: null, binding: null };
    return { operation_id: operationId, state: record.state, receipt: null, recovery_token: record.request.recovery_token,
      binding: derivePlanDurablePublicationFilesystemBinding(record.request) };
  }

  async prepare(input: PlanDurablePublicationFilesystemPrepareRequest): Promise<PlanDurablePublicationFilesystemPortInspection> {
    this.calls.prepare += 1;
    const existing = this.records.get(input.operation_id);
    if (existing !== undefined) {
      if (existing.request.idempotency_key !== input.idempotency_key || existing.request.project_id !== input.project_id ||
          existing.request.change_key !== input.change_key || existing.request.plan.manifest_hash !== input.plan.manifest_hash ||
          existing.request.recovery_token !== input.recovery_token) throw new Error("memory filesystem identity");
      return this.view(input.operation_id);
    }
    if (input.expected_baseline.state !== "absent") return { operation_id: input.operation_id, state: "unknown", receipt: null, recovery_token: null, binding: null };
    this.records.set(input.operation_id, { request: input, state: "prepared" });
    return this.view(input.operation_id);
  }

  async apply(input: PlanDurablePublicationFilesystemApplyRequest): Promise<PlanDurablePublicationFilesystemTransactionInspection> {
    this.calls.apply += 1;
    const record = this.records.get(input.operation_id);
    if (record === undefined || record.request.recovery_token !== input.recovery_token) throw new Error("memory filesystem identity");
    if (record.state === "committed") return this.view(input.operation_id);
    if (this.applyOutcome === "failed") throw new Error("memory filesystem failure");
    if (this.applyOutcome === "ambiguous") throw new Error("memory filesystem ambiguous");
    record.state = "committed";
    return this.view(input.operation_id);
  }

  async recover(input: PlanDurablePublicationFilesystemApplyRequest): Promise<PlanDurablePublicationFilesystemTransactionInspection> {
    return this.apply(input);
  }

  async inspect(input: PlanDurablePublicationFilesystemInspectRequest): Promise<PlanDurablePublicationFilesystemPortInspection> {
    this.calls.inspect += 1;
    return this.view(input.operation_id);
  }

  async readback(operationId: string): Promise<PlanDurablePublicationFilesystemReadback> {
    this.calls.readback += 1;
    const record = this.records.get(operationId);
    if (record === undefined) return { operation_id: operationId, live_manifest_hash: null, payload_hashes: {}, readback_hash: null, journal_committed: false };
    const plan = record.request.plan;
    const payload_hashes = Object.fromEntries(plan.payloads.map((payload) => [payload.path, payload.serialized_sha256])) as Record<string, `sha256:${string}`>;
    return { operation_id: operationId,
      live_manifest_hash: record.state === "committed" ? plan.manifest_hash as `sha256:${string}` : null,
      payload_hashes,
      readback_hash: record.state === "committed" ? derivePlanDurablePublicationFilesystemReadbackHash({
        manifest_hash: plan.manifest_hash as `sha256:${string}`, payload_hashes, change_key: plan.change_key
      }) : null,
      journal_committed: record.state === "committed" };
  }

  async rollback(input: PlanDurablePublicationFilesystemRollbackRequest): Promise<PlanDurablePublicationFilesystemTransactionInspection> {
    const record = this.records.get(input.operation_id);
    if (record !== undefined) record.state = "rolled_back";
    return this.view(input.operation_id);
  }
}

export class InMemoryPlanFinalizationEventOutboxPort {
  readonly calls = { prepareTransaction: 0, updateTransaction: 0, inspectTransaction: 0, enqueue: 0, deliver: 0, inspect: 0 };
  readonly delivered: PlanFinalizationEventOutboxRecord[] = [];
  private readonly records = new Map<string, PlanFinalizationEventOutboxRecord>();
  private readonly transactionRecords = new Map<string, PlanFinalizationTransactionRecord>();
  private readonly delivery: InMemoryPlanFinalizationEventOutboxPortOptions["delivery"];

  constructor(options: InMemoryPlanFinalizationEventOutboxPortOptions = {}) {
    this.delivery = options.delivery ?? "complete";
  }

  async prepareTransaction(input: PlanFinalizationTransactionRecord): Promise<PlanFinalizationTransactionRecord> {
    this.calls.prepareTransaction += 1;
    const prior = this.transactionRecords.get(input.operation_id);
    if (prior !== undefined) {
      if (prior.idempotency_key !== input.idempotency_key || prior.project_id !== input.project_id ||
          prior.change_key !== input.change_key || prior.run_id !== input.run_id || prior.branch_name !== input.branch_name ||
          prior.attempt !== input.attempt || prior.record_hash !== input.record_hash) throw new Error("memory transaction identity");
      return prior;
    }
    this.transactionRecords.set(input.operation_id, Object.freeze(input));
    return input;
  }

  async updateTransaction(input: PlanFinalizationTransactionRecord): Promise<PlanFinalizationTransactionRecord> {
    this.calls.updateTransaction += 1;
    const prior = this.transactionRecords.get(input.operation_id);
    if (prior === undefined || prior.idempotency_key !== input.idempotency_key || prior.project_id !== input.project_id ||
        prior.change_key !== input.change_key || prior.run_id !== input.run_id || prior.branch_name !== input.branch_name ||
        prior.attempt !== input.attempt) throw new Error("memory transaction identity");
    this.transactionRecords.set(input.operation_id, Object.freeze(input));
    return input;
  }

  async inspectTransaction(input: { readonly operation_id: string; readonly idempotency_key?: string }): Promise<PlanFinalizationTransactionRecord | undefined> {
    this.calls.inspectTransaction += 1;
    const record = this.transactionRecords.get(input.operation_id);
    if (record !== undefined && input.idempotency_key !== undefined && record.idempotency_key !== input.idempotency_key) throw new Error("memory transaction identity");
    return record;
  }

  async enqueue(input: PlanFinalizationEventOutboxEnqueueInput): Promise<PlanFinalizationEventOutboxRecord> {
    this.calls.enqueue += 1;
    const prior = this.records.get(input.outbox_id);
    if (prior !== undefined) {
      if (prior.operation_id !== input.operation_id || prior.idempotency_key !== input.idempotency_key ||
          prior.project_id !== input.context.project_id || prior.change_key !== input.context.change_key ||
          prior.run_id !== input.context.run_id || prior.branch_name !== input.context.branch_name || prior.attempt !== input.context.attempt ||
          prior.publication_receipt_id !== input.publication_receipt.receipt_id || prior.publication_generation !== input.publication_receipt.generation ||
          prior.publication_manifest_hash !== input.publication_receipt.manifest_hash || prior.event_bundle_hash !== input.event_bundle_hash) {
        throw new Error("memory outbox identity");
      }
      return prior;
    }
    const record: PlanFinalizationEventOutboxRecord = Object.freeze({
      schema_version: 1, record_kind: "plan_finalization_event_outbox", outbox_id: input.outbox_id,
      operation_id: input.operation_id, idempotency_key: input.idempotency_key,
      project_id: input.context.project_id, change_key: input.context.change_key, run_id: input.context.run_id,
      branch_name: input.context.branch_name, attempt: input.context.attempt,
      publication_receipt_id: input.publication_receipt.receipt_id, publication_generation: input.publication_receipt.generation,
      publication_manifest_hash: input.publication_receipt.manifest_hash, event_bundle_hash: input.event_bundle_hash,
      events: Object.freeze([...input.events]), state: "pending", created_at: memoryNow, updated_at: memoryNow
    });
    this.records.set(input.outbox_id, record);
    return record;
  }

  async deliver(input: PlanFinalizationEventOutboxDeliveryInput): Promise<PlanFinalizationEventOutboxRecord> {
    this.calls.deliver += 1;
    const prior = this.records.get(input.outbox_id);
    if (prior === undefined || prior.operation_id !== input.operation_id || prior.idempotency_key !== input.idempotency_key ||
        prior.event_bundle_hash !== input.event_bundle_hash || prior.publication_receipt_id !== input.publication_receipt_id) {
      throw new Error("memory outbox identity");
    }
    if (prior.state === "delivered") return prior;
    const state: PlanFinalizationEventOutboxRecord["state"] = this.delivery === "complete" || this.delivery === undefined
      ? "delivered" : this.delivery;
    const next = Object.freeze({ ...prior, state, updated_at: memoryNow });
    this.records.set(input.outbox_id, next);
    if (state === "delivered" && !this.delivered.some((item) => item.outbox_id === next.outbox_id)) this.delivered.push(next);
    return next;
  }

  async inspect(input: { readonly outbox_id: string; readonly operation_id: string; readonly idempotency_key: string }): Promise<PlanFinalizationEventOutboxRecord | undefined> {
    this.calls.inspect += 1;
    const record = this.records.get(input.outbox_id);
    if (record !== undefined && (record.operation_id !== input.operation_id || record.idempotency_key !== input.idempotency_key)) {
      throw new Error("memory outbox identity");
    }
    return record;
  }
}
