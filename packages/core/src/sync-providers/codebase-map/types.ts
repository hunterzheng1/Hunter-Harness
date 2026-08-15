import type {
  MapHealth,
  MapInspectionInput,
  MapPublicationPlan,
  MapPublicationPlanInput,
  MapReceipt,
  MappingExecutionPolicy
} from "../../codebase/map-v2/index.js";
import type { SyncContext } from "../../sync-maintenance/index.js";

export type SuccessfulMapPublicationPlan = Extract<MapPublicationPlan, { readonly ok: true }>;

export interface CodebaseMapSyncProviderFixture {
  readonly schema_version: 0 | 1;
  readonly inspection_input: MapInspectionInput;
}

export type MapInspectionInputSource =
  | MapInspectionInput
  | ((context: SyncContext) => MapInspectionInput);

export type MapPublicationInputSource =
  | MapPublicationPlanInput
  /** Pure projector over already-collected typed Map inputs; it must not perform I/O or call a model. */
  | ((health: MapHealth, context: SyncContext) => MapPublicationPlanInput);

export interface MapExecutionRequest {
  readonly schema_version: 1;
  readonly action_id: string;
  readonly expected_input_fingerprint: string;
  readonly expected_previous_manifest_hash?: string | undefined;
  readonly publication_plan: SuccessfulMapPublicationPlan;
  readonly execution_policy: MappingExecutionPolicy;
}

export interface MapExecutionResult {
  readonly receipt: MapReceipt;
  readonly modified_paths: readonly string[];
  readonly rollback_token: string;
}

export interface MapExecutionReadback {
  readonly operation_id: string;
  readonly input_fingerprint: string;
  readonly manifest_hash: string;
  readonly verification: MapReceipt["verification"];
}

export interface MapRollbackRequest {
  readonly schema_version: 1;
  readonly operation_id: string;
  readonly rollback_token: string;
  readonly expected_manifest_hash: string;
  readonly expected_previous_manifest_hash?: string | undefined;
}

export interface MapRollbackResult {
  readonly rolled_back: boolean;
  readonly resulting_manifest_hash?: string | undefined;
}

/** The only effectful seam. Production filesystem/model execution is supplied later. */
export interface MapExecutionPort {
  execute(request: MapExecutionRequest): Promise<MapExecutionResult>;
  readback(operation_id: string): Promise<MapExecutionReadback>;
  rollback(request: MapRollbackRequest): Promise<MapRollbackResult>;
}

export interface CodebaseMapSyncProviderInput {
  readonly inspection_input: MapInspectionInputSource;
  readonly publication_input: MapPublicationInputSource;
  readonly execution_port: MapExecutionPort;
  readonly clock?: (() => Date) | undefined;
}
