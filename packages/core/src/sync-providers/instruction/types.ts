import type {
  InstructionInspectionInput,
  InstructionProjectionPlan
} from "../../instruction-governance/index.js";
import type {
  InstructionApplyPlan,
  InstructionApplyReceipt,
  InstructionApplyResult,
  InstructionManifestWriteInput,
  InstructionProposal
} from "../../instruction-proposal/index.js";
import type { SyncContext } from "../../sync-maintenance/index.js";

export interface InstructionApplyBundleSnapshot {
  readonly apply_plan: InstructionApplyPlan;
  readonly projection_plan: InstructionProjectionPlan;
  readonly manifest_write?: InstructionManifestWriteInput | undefined;
}

export type InstructionSyncProviderSnapshotV1 =
  | {
    readonly schema_version: 1;
    readonly configured: false;
  }
  | {
    readonly schema_version: 1;
    readonly configured: true;
    readonly inspection_input: InstructionInspectionInput;
    /** Exact serialized 07B proposal wire. Objects are deliberately not accepted here. */
    readonly proposal_json?: string | undefined;
    /** Exact serialized trusted reconstruction input consumed by the 07B verifier. */
    readonly trusted_json?: string | undefined;
    readonly apply_bundle?: InstructionApplyBundleSnapshot | undefined;
  };

/** A pure projector over already-collected typed snapshots. It must not perform I/O or call a model. */
export type InstructionSyncSnapshotSource =
  | InstructionSyncProviderSnapshotV1
  | ((context: SyncContext) => InstructionSyncProviderSnapshotV1);

export interface InstructionExecutionRequest {
  readonly schema_version: 1;
  readonly action_id: "instruction:apply_proposal";
  readonly operation_id: `instruction_execution:${string}`;
  readonly transaction_hash: string;
  readonly expected_input_fingerprint: string;
  readonly proposal: InstructionProposal;
  readonly apply_plan: InstructionApplyPlan;
  readonly rollback_capability:
    | {
      readonly strategy: "automatic";
      readonly available: true;
      readonly rollback_token: `instruction_rollback:${string}`;
      readonly expected_current_canonical_hash: string;
      readonly expected_previous_canonical_hash: string;
    }
    | {
      readonly strategy: "none";
      readonly available: false;
    };
}

export interface InstructionExecutionResult {
  readonly apply_result: InstructionApplyResult;
  readonly receipt: InstructionApplyReceipt;
  readonly modified_paths: readonly string[];
  readonly rollback_token: string;
}

export interface InstructionExecutionReadback {
  readonly receipt: InstructionApplyReceipt;
  readonly apply_result: InstructionApplyResult;
}

export interface InstructionRollbackRequest {
  readonly schema_version: 1;
  readonly operation_id: `instruction_execution:${string}`;
  readonly transaction_hash: string;
  readonly rollback_token: string;
  readonly expected_current_canonical_hash: string;
  readonly expected_previous_canonical_hash: string;
}

export interface InstructionRollbackResult {
  readonly rolled_back: boolean;
  readonly resulting_canonical_hash: string;
}

/** The only effectful seam. Filesystem transaction, readback, and rollback are supplied later. */
export interface InstructionExecutionPort {
  execute(request: InstructionExecutionRequest): Promise<InstructionExecutionResult>;
  readback(receipt_id: string): Promise<InstructionExecutionReadback>;
  rollback(request: InstructionRollbackRequest): Promise<InstructionRollbackResult>;
}

export interface InstructionSyncProviderInput {
  readonly snapshot: InstructionSyncSnapshotSource;
  readonly execution_port: InstructionExecutionPort;
  readonly clock?: (() => Date) | undefined;
  readonly estimated_duration_ms?: number | undefined;
}

export type InstructionSyncProviderReadResult =
  | {
    readonly ok: true;
    readonly source_schema_version: 1;
    readonly snapshot: InstructionSyncProviderSnapshotV1;
  }
  | {
    readonly ok: true;
    readonly source_schema_version: 0;
    readonly readiness: "legacy_read_only";
    readonly legacy: {
      readonly status: "ADVISORY";
      readonly input_hash: null;
      readonly report_path: null;
      readonly report_sha256: null;
    };
    readonly reason_codes: readonly ["INSTRUCTION_LEGACY_REINSPECTION_REQUIRED"];
  }
  | {
    readonly ok: false;
    readonly reason_code:
      | "INSTRUCTION_SYNC_RECORD_INVALID"
      | "INSTRUCTION_SYNC_RECORD_VERSION_UNSUPPORTED";
  };
