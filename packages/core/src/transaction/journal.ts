import type { ProtectedLocalRootInventory } from "../project/local-state.js";

export type TransactionState =
  | "prepared"
  | "applying"
  | "interrupted"
  | "rolling_back"
  | "rolled_back"
  | "committed"
  | "recovery_required";

export type TransactionOperation =
  | { operation: "add"; path: string; content: string | Uint8Array }
  | { operation: "modify"; path: string; content: string | Uint8Array }
  | { operation: "delete"; path: string }
  | {
      operation: "rename";
      from_path: string;
      to_path: string;
      content: string | Uint8Array;
    };

/**
 * Durable transaction metadata deliberately excludes file payloads. The bytes
 * already live under staged/ while a transaction is active; serializing them
 * into journal.json made every progress update rewrite the complete Bundle.
 */
export type TransactionJournalOperation =
  | {
      operation: "add" | "modify" | "delete";
      path: string;
      content_sha256?: string;
    }
  | {
      operation: "rename";
      from_path: string;
      to_path: string;
      content_sha256: string;
    };

export interface CompletedTargetState {
  operation_index: number;
  targets: Array<{
    path: string;
    exists: boolean;
    hash: string | null;
  }>;
}

export interface SnapshotRecord {
  path: string;
  existed: boolean;
  snapshot_name: string | null;
}

export interface TransactionJournal {
  schema_version: 1 | 2 | 3;
  transaction_id: string;
  recovery_id?: string;
  kind?: "init" | "push-binding" | "update" | "refresh" | "rollback" | "other";
  state: TransactionState;
  created_at: string;
  updated_at?: string;
  operations: TransactionJournalOperation[];
  snapshots: SnapshotRecord[];
  applied_count: number;
  failure: string | null;
  project_identity?: string | null;
  cli_version?: string | null;
  target_bundle_version?: string | null;
  ownership_manifest_hash?: string | null;
  plan_hash?: string;
  snapshot_digest?: string;
  completed_operations?: number[];
  pending_operations?: number[];
  completed_target_states?: CompletedTargetState[];
  verification_outcomes?: Array<{
    name: string;
    status: "passed" | "failed";
    detail?: string;
  }>;
  protected_local_roots?: {
    before: ProtectedLocalRootInventory[];
    after: ProtectedLocalRootInventory[];
    unchanged: boolean;
  };
}
