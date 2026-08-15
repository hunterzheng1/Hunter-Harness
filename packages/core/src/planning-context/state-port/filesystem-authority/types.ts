import type { PlanningContextStateLegacyView, PlanningContextStatePort } from "../types.js";
import type { AggregateIdentity } from "../../../durable-state-primitives/index.js";

export interface PlanningContextFilesystemAuthorityOptions {
  /** Trusted host authority; never serialized into durable wire records. */
  readonly project_root: string;
  readonly project_identity: string;
  /** @internal deterministic race seam for protocol tests. */
  readonly before_pointer_second_read?: (() => void | Promise<void>) | undefined;
  /** @internal deterministic stale-lock seam shared with the Map protocol. */
  readonly before_lock_reclaim?: (() => void | Promise<void>) | undefined;
}

export interface PlanningContextFilesystemStatePort extends PlanningContextStatePort {
  /** Legacy v0 is observable only as a migration input and is never promoted or overwritten. */
  readLegacy(aggregate: AggregateIdentity): Promise<PlanningContextStateLegacyView | null>;
}

export type PlanningContextFilesystemAuthorityErrorCode =
  | "PLANNING_CONTEXT_FILESYSTEM_AUTHORITY_INVALID"
  | "PLANNING_CONTEXT_FILESYSTEM_POINTER_INVALID"
  | "PLANNING_CONTEXT_FILESYSTEM_GENERATION_INVALID"
  | "PLANNING_CONTEXT_FILESYSTEM_LOCKED"
  | "PLANNING_CONTEXT_FILESYSTEM_LEGACY_READ_ONLY";
