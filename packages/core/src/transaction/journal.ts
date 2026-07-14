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
  | { operation: "add" | "modify" | "delete"; path: string }
  | { operation: "rename"; from_path: string; to_path: string };

export interface SnapshotRecord {
  path: string;
  existed: boolean;
  snapshot_name: string | null;
}

export interface TransactionJournal {
  schema_version: 1 | 2;
  transaction_id: string;
  kind?: "init" | "push-binding" | "update" | "refresh" | "rollback" | "other";
  state: TransactionState;
  created_at: string;
  operations: TransactionJournalOperation[];
  snapshots: SnapshotRecord[];
  applied_count: number;
  failure: string | null;
}
