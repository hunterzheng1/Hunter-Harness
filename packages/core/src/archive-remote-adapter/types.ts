import type { ArchiveIngestReceipt } from "@hunter-harness/contracts";

import type {
  ArchiveOutbox,
  ArchiveOutboxAck,
  ArchiveOutboxClaim,
  ArchiveOutboxNack,
  ArchiveRetentionDecision,
  ArchiveRetentionPolicy,
  LocalArchiveZipRef
} from "../archive-outbox/index.js";
import type {
  ArchivePackageRef,
  ArchiveSyncReceipt,
  SourceRef
} from "../remote-sync/types.js";

export type { ArchiveIngestReceipt };

export interface ArchiveZipReaderPort {
  read(local_zip_ref: LocalArchiveZipRef): Promise<unknown>;
}

/** Structurally identical to the stage 02 RemoteSyncModule Archive Interface. */
export interface ArchiveRemotePublisherPort {
  publishArchive(
    package_ref: ArchivePackageRef,
    source_ref: SourceRef,
    expected_package_hash: string
  ): Promise<unknown>;
}

export type ArchiveRemotePublishResult =
  | {
    readonly outcome: "stored";
    readonly sync_receipt: ArchiveSyncReceipt;
    readonly ack: ArchiveOutboxAck;
    readonly cleanup_intent: ArchiveRetentionDecision;
  }
  | {
    readonly outcome: "retry_scheduled" | "dead_letter";
    readonly reason_code: string;
    readonly nack: ArchiveOutboxNack;
    readonly cleanup_intent: null;
  };

export interface ArchiveRemoteAdapter {
  publishClaim(
    claim: ArchiveOutboxClaim,
    source_ref: SourceRef,
    retention_policy: ArchiveRetentionPolicy
  ): Promise<ArchiveRemotePublishResult>;
  declineUpload(): Readonly<{
    outcome: "cancelled";
    local_archive_unchanged: true;
    cleanup_intent: null;
  }>;
}

export interface ArchiveRemoteAdapterDependencies {
  readonly outbox: ArchiveOutbox;
  readonly zip_reader: ArchiveZipReaderPort;
  readonly publisher: ArchiveRemotePublisherPort;
}

export type ArchiveRemoteRequestReadResult =
  | {
    readonly ok: true;
    readonly source_schema_version: 1;
    readonly readiness: "ready";
    readonly claim: ArchiveOutboxClaim;
    readonly source_ref: SourceRef;
    readonly retention_policy: ArchiveRetentionPolicy;
  }
  | {
    readonly ok: true;
    readonly source_schema_version: 0;
    readonly readiness: "legacy_read_only";
    readonly legacy: Readonly<{ entry_id: string; local_zip_path: string }>;
    readonly reason_codes: readonly [
      "LEGACY_ARCHIVE_LEASE_UNKNOWN",
      "LEGACY_ARCHIVE_RECEIPT_BINDING_UNKNOWN"
    ];
  }
  | {
    readonly ok: false;
    readonly reason_code:
      | "ARCHIVE_REMOTE_REQUEST_INVALID"
      | "ARCHIVE_REMOTE_REQUEST_VERSION_UNSUPPORTED";
  };
