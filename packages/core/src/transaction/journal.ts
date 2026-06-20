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

export interface SnapshotRecord {
  path: string;
  existed: boolean;
  snapshot_name: string | null;
}

export interface TransactionJournal {
  schema_version: 1;
  transaction_id: string;
  state: TransactionState;
  created_at: string;
  operations: TransactionOperation[];
  snapshots: SnapshotRecord[];
  applied_count: number;
  failure: string | null;
}
