import { contentHash, stableHash } from "../stable.js";
import { deriveMapPublicationReadbackHash } from "./module.js";
import type {
  MapPublicationCommitRequest,
  MapPublicationFilesystemTransactionPort,
  MapPublicationPortInspection,
  MapPublicationReadback,
  MapPublicationRollbackOutcome,
  MapPublicationRollbackRequest,
  MapPublicationTransactionInspection,
  MapPublicationTransactionBinding,
  MapPublicationTransactionReceipt
} from "./types.js";
import type { MapPublicationTargetPath } from "../types.js";

interface RecordState {
  request: MapPublicationCommitRequest;
  input_hash: string;
  new_hash: string;
  previous_hash: string | null;
  previous_payload_hashes: Readonly<Record<string, string>>;
  binding: MapPublicationTransactionBinding;
  token: string;
  state: "prepared" | "applying" | "committed" | "rolled_back" | "recovery_required";
  receipt: MapPublicationTransactionReceipt | null;
}

export interface InMemoryMapPublicationTransactionPortOptions {
  readonly initial_manifest_hash?: string | null;
  readonly initial_payload_hashes?: Readonly<Record<string, string>>;
  readonly crash_once_at?: "before_commit" | "after_commit";
}

export class InMemoryMapPublicationTransactionPort implements MapPublicationFilesystemTransactionPort {
  readonly calls = { inspect: 0, prepare: 0, apply: 0, recover: 0, rollback: 0, readback: 0 };
  private live: string | null;
  private livePayloadHashes: Readonly<Record<string, string>>;
  private crash: InMemoryMapPublicationTransactionPortOptions["crash_once_at"];
  private readonly records = new Map<string, RecordState>();
  private readonly keys = new Map<string, string>();

  constructor(options: InMemoryMapPublicationTransactionPortOptions = {}) {
    this.live = options.initial_manifest_hash ?? null;
    this.livePayloadHashes = { ...(options.initial_payload_hashes ?? {}) };
    this.crash = options.crash_once_at;
  }

  private view(operationId: string): MapPublicationTransactionInspection {
    const record = this.records.get(operationId);
    return record === undefined ? { operation_id: operationId, state: "unknown", receipt: null, recovery_token: null,
      binding: null } : { operation_id: operationId, state: record.state, receipt: record.receipt,
        recovery_token: record.token, binding: record.binding };
  }

  readonly inspect = async (operationId: string, key?: string): Promise<MapPublicationPortInspection> => {
    this.calls.inspect += 1;
    if (key !== undefined) {
      const owner = this.keys.get(key);
      if (owner !== undefined && owner !== operationId) {
        return { operation_id: operationId, state: "idempotency_conflict", receipt: null, recovery_token: null,
          binding: null };
      }
    }
    return this.view(operationId);
  };

  readonly prepare = async (request: MapPublicationCommitRequest, inputHash: string, newHash: string,
    token: string): Promise<MapPublicationPortInspection> => {
    this.calls.prepare += 1;
    const existing = this.records.get(request.operation_id);
    if (existing !== undefined) {
      return existing.input_hash === inputHash ? this.view(request.operation_id) : {
        operation_id: request.operation_id, state: "idempotency_conflict", receipt: null, recovery_token: null,
        binding: null
      };
    }
    const keyOwner = this.keys.get(request.idempotency_key);
    if (keyOwner !== undefined && keyOwner !== request.operation_id) {
      return { operation_id: request.operation_id, state: "idempotency_conflict", receipt: null,
        recovery_token: null, binding: null };
    }
    const expected = request.expected_previous_manifest.state === "absent" ? null :
      request.expected_previous_manifest.manifest_hash;
    if (this.live !== expected) return { operation_id: request.operation_id, state: "unknown", receipt: null,
      recovery_token: null, binding: null };
    const binding = { operation_id: request.operation_id, action_id: request.action_id,
      idempotency_key: request.idempotency_key, input_hash: inputHash, plan_hash: request.plan.plan_hash,
      expected_previous_manifest: request.expected_previous_manifest, new_manifest_hash: newHash,
      ownership_paths: request.ownership_paths,
      expected_payload_hashes: Object.fromEntries(request.ownership_paths.map((path) =>
        [path, contentHash(request.plan.payloads[path])])) as Record<MapPublicationTargetPath, string>,
      expected_readback_hash: deriveMapPublicationReadbackHash(request) };
    this.keys.set(request.idempotency_key, request.operation_id);
    this.records.set(request.operation_id, { request, input_hash: inputHash, new_hash: newHash,
      previous_hash: this.live, previous_payload_hashes: this.livePayloadHashes, binding,
      token, state: "prepared", receipt: null });
    return this.view(request.operation_id);
  };

  private commit(record: RecordState): void {
    record.state = "applying";
    const targetHashes = Object.fromEntries(record.request.ownership_paths.map((path) =>
      [path, contentHash(record.request.plan.payloads[path])]));
    const modified = record.request.ownership_paths.filter((path) => this.livePayloadHashes[path] !== targetHashes[path] ||
      (path === ".harness/codebase/map-manifest.json" && this.live !== record.new_hash));
    const modifiedSet = new Set(modified);
    const preserved = record.request.ownership_paths.filter((path) => !modifiedSet.has(path));
    this.live = record.new_hash;
    this.livePayloadHashes = targetHashes;
    const verification = { manifest_hash_verified: true as const, payloads_verified: true as const,
      journal_committed: true as const, readback_hash: deriveMapPublicationReadbackHash(record.request) };
    const body = { schema_version: 1 as const, operation_id: record.request.operation_id,
      action_id: record.request.action_id, idempotency_key: record.request.idempotency_key,
      plan_hash: record.request.plan.plan_hash, input_hash: record.input_hash,
      previous_manifest_hash: record.previous_hash, new_manifest_hash: record.new_hash,
      modified_paths: modified, preserved_paths: preserved,
      verification, recovery_token: record.token,
      completed_at: record.request.plan.manifest.published_at };
    record.receipt = { ...body, receipt_id: `map_publication_receipt:${stableHash(body).slice(7)}` };
    record.state = "committed";
  }

  readonly apply = async (operationId: string, token: string): Promise<MapPublicationTransactionInspection> => {
    this.calls.apply += 1;
    const record = this.records.get(operationId);
    if (record === undefined || record.token !== token) throw new Error("unknown operation");
    if (record.state === "committed") return this.view(operationId);
    record.state = "applying";
    if (this.crash === "before_commit") { this.crash = undefined; throw new Error("crash before commit"); }
    this.commit(record);
    if (this.crash === "after_commit") { this.crash = undefined; throw new Error("crash after commit"); }
    return this.view(operationId);
  };

  readonly recover = async (operationId: string, token: string): Promise<MapPublicationTransactionInspection> => {
    this.calls.recover += 1;
    const record = this.records.get(operationId);
    if (record === undefined || record.token !== token) return this.view(operationId);
    if (record.state !== "committed" && record.state !== "rolled_back") this.commit(record);
    return this.view(operationId);
  };

  readonly rollback = async (request: MapPublicationRollbackRequest): Promise<MapPublicationRollbackOutcome> => {
    this.calls.rollback += 1;
    const record = this.records.get(request.operation_id);
    if (record === undefined) return { outcome: "not_found" };
    if (record.state !== "committed" || record.token !== request.recovery_token ||
        record.new_hash !== request.expected_published_manifest_hash || this.live !== record.new_hash) {
      return { outcome: "conflict" };
    }
    this.live = record.previous_hash;
    this.livePayloadHashes = record.previous_payload_hashes;
    record.state = "rolled_back";
    return { outcome: "rolled_back", resulting_manifest_hash: this.live };
  };

  readonly readback = async (operationId: string): Promise<MapPublicationReadback> => {
    this.calls.readback += 1;
    const record = this.records.get(operationId);
    if (record === undefined) return { operation_id: operationId, live_manifest_hash: this.live,
      payload_hashes: this.livePayloadHashes as MapPublicationReadback["payload_hashes"], journal_committed: false };
    return { operation_id: operationId, live_manifest_hash: this.live,
      payload_hashes: this.livePayloadHashes as MapPublicationReadback["payload_hashes"],
      journal_committed: record.state === "committed" };
  };
}
