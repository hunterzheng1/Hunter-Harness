import type { MapReceipt } from "../../codebase/map-v2/index.js";
import { compareCodepoint, deepFreeze, stableHash } from "../../sync-maintenance/index.js";
import type {
  MapExecutionPort,
  MapExecutionReadback,
  MapExecutionRequest,
  MapExecutionResult,
  MapRollbackRequest,
  MapRollbackResult
} from "./types.js";

export interface InMemoryMapExecutionPortInput {
  readonly clock?: (() => Date) | undefined;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly execute_error?: Error | undefined;
  readonly readback_error?: Error | undefined;
  readonly rollback_error?: Error | undefined;
  readonly verification?: MapReceipt["verification"] | undefined;
  readonly rollback_succeeds?: boolean | undefined;
}

export class InMemoryMapExecutionPort implements MapExecutionPort {
  readonly calls = { execute: 0, readback: 0, rollback: 0 };
  readonly requests: MapExecutionRequest[] = [];
  private readonly input: InMemoryMapExecutionPortInput;
  private readonly readbacks = new Map<string, MapExecutionReadback>();

  constructor(input: InMemoryMapExecutionPortInput = {}) {
    this.input = input;
  }

  async execute(request: MapExecutionRequest): Promise<MapExecutionResult> {
    this.calls.execute += 1;
    this.requests.push(request);
    if (this.input.execute_error !== undefined) throw this.input.execute_error;
    const manifestWrite = request.publication_plan.operations.find((operation) =>
      operation.operation === "stage_write" &&
      operation.path === ".harness/codebase/map-manifest.json"
    );
    if (manifestWrite === undefined || manifestWrite.operation !== "stage_write") {
      throw new Error("map manifest write is missing");
    }
    const operationId = `map:${stableHash({
      action_id: request.action_id,
      plan_hash: request.publication_plan.plan_hash
    }).slice("sha256:".length)}`;
    const verification = this.input.verification ?? {
      seven_documents_valid: true,
      references_valid: true,
      sensitive_scan_passed: true,
      atomic_publication_completed: true
    };
    const receipt: MapReceipt = {
      schema_version: 2,
      operation_id: operationId,
      input_fingerprint: request.expected_input_fingerprint,
      ...(request.expected_previous_manifest_hash === undefined
        ? {}
        : { previous_manifest_hash: request.expected_previous_manifest_hash }),
      manifest_hash: manifestWrite.content_hash,
      changed_documents: [...request.publication_plan.changed_documents].sort(compareCodepoint),
      preserved_documents: [...request.publication_plan.preserved_documents].sort(compareCodepoint),
      execution_policy: request.execution_policy,
      execution: {
        provider: this.input.provider ?? "in_memory",
        model: this.input.model ?? request.execution_policy.model_tier,
        duration_ms: 0,
        input_tokens: 0,
        output_tokens: 0,
        model_attempts: 1,
        escalated: false,
        escalation_reasons: []
      },
      verification,
      completed_at: (this.input.clock ?? (() => new Date()))().toISOString()
    };
    const modifiedPaths = request.publication_plan.operations.flatMap((operation) =>
      operation.operation === "stage_write" ? [operation.path] : []
    ).sort(compareCodepoint);
    const rollbackToken = stableHash({
      operation_id: operationId,
      previous_manifest_hash: request.expected_previous_manifest_hash ?? null
    });
    this.readbacks.set(operationId, deepFreeze({
      operation_id: operationId,
      input_fingerprint: receipt.input_fingerprint,
      manifest_hash: receipt.manifest_hash,
      verification
    }));
    return deepFreeze({ receipt, modified_paths: modifiedPaths, rollback_token: rollbackToken });
  }

  async readback(operation_id: string): Promise<MapExecutionReadback> {
    this.calls.readback += 1;
    if (this.input.readback_error !== undefined) throw this.input.readback_error;
    const result = this.readbacks.get(operation_id);
    if (result === undefined) throw new Error("map execution receipt not found");
    return result;
  }

  async rollback(request: MapRollbackRequest): Promise<MapRollbackResult> {
    this.calls.rollback += 1;
    if (this.input.rollback_error !== undefined) throw this.input.rollback_error;
    const rolledBack = this.input.rollback_succeeds ?? true;
    if (rolledBack) this.readbacks.delete(request.operation_id);
    return deepFreeze({
      rolled_back: rolledBack,
      ...(request.expected_previous_manifest_hash === undefined
        ? {}
        : { resulting_manifest_hash: request.expected_previous_manifest_hash })
    });
  }
}
