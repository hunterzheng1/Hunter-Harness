import { sha256Bytes } from "../archive-package-builder/index.js";
import type { ArchiveOutboxClaim } from "../archive-outbox/index.js";
import { ArchiveRemoteAdapterError } from "./errors.js";
import type {
  ArchiveRemoteAdapter,
  ArchiveRemoteAdapterDependencies,
  ArchiveRemotePublishResult
} from "./types.js";
import {
  projectIngestReceipt,
  snapshotCurrentClaim,
  snapshotSource,
  validateAckTransition,
  validateNackTransition,
  validRetention
} from "./validation.js";

function dependencyMethod(value: unknown, name: string): ((...args: unknown[]) => unknown) | undefined {
  if (value === null || typeof value !== "object") return undefined;
  try {
    let owner: object | null = value;
    for (let depth = 0; owner !== null && depth < 8; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, name);
      if (descriptor !== undefined) {
        return "value" in descriptor && typeof descriptor.value === "function"
          ? descriptor.value as (...args: unknown[]) => unknown : undefined;
      }
      owner = Object.getPrototypeOf(owner) as object | null;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function frozen<T>(value: T): Readonly<T> {
  return Object.freeze(value);
}

export function createArchiveRemoteAdapter(
  dependencies: ArchiveRemoteAdapterDependencies
): ArchiveRemoteAdapter {
  const ack = dependencyMethod(dependencies.outbox, "ack");
  const nack = dependencyMethod(dependencies.outbox, "nack");
  const readZip = dependencyMethod(dependencies.zip_reader, "read");
  const publish = dependencyMethod(dependencies.publisher, "publishArchive");
  if (ack === undefined || nack === undefined || readZip === undefined || publish === undefined) {
    throw new ArchiveRemoteAdapterError("ARCHIVE_REMOTE_DEPENDENCY_INVALID");
  }
  const outboxAck = ack;
  const outboxNack = nack;
  const zipRead = readZip;
  const archivePublish = publish;

  async function rejectClaim(
    claim: ArchiveOutboxClaim,
    reasonCode: string,
    retryable: boolean
  ): Promise<ArchiveRemotePublishResult> {
    const rawResult: unknown = await outboxNack.call(dependencies.outbox, claim, reasonCode, retryable);
    const result = validateNackTransition(rawResult, claim, reasonCode, retryable);
    if (result === undefined) {
      throw new ArchiveRemoteAdapterError("ARCHIVE_REMOTE_OUTBOX_TRANSITION_INVALID");
    }
    return frozen({
      outcome: result.retry_at === null ? "dead_letter" as const : "retry_scheduled" as const,
      reason_code: reasonCode,
      nack: result,
      cleanup_intent: null
    });
  }

  return frozen({
    async publishClaim(claimValue, sourceValue, retentionPolicy) {
      const claim = snapshotCurrentClaim(claimValue);
      if (claim === undefined) throw new ArchiveRemoteAdapterError("ARCHIVE_REMOTE_CLAIM_INVALID");
      const source = snapshotSource(sourceValue, claim);
      if (source === undefined || !validRetention(retentionPolicy)) {
        throw new ArchiveRemoteAdapterError("ARCHIVE_REMOTE_SOURCE_INVALID");
      }
      let rawBytes: unknown;
      try {
        rawBytes = await zipRead.call(dependencies.zip_reader, claim.record.local_zip_ref);
      } catch {
        return rejectClaim(claim, "ARCHIVE_ZIP_READ_FAILED", true);
      }
      if (!(rawBytes instanceof Uint8Array)) {
        return rejectClaim(claim, "ARCHIVE_ZIP_INVALID", false);
      }
      const bytes = rawBytes.slice();
      if (bytes.byteLength !== claim.record.local_zip_ref.size_bytes ||
          sha256Bytes(bytes) !== claim.record.package_sha256) {
        return rejectClaim(claim, "ARCHIVE_ZIP_INVALID", false);
      }
      let ingest: unknown;
      try {
        ingest = await archivePublish.call(dependencies.publisher, {
          request_id: claim.record.request_id,
          archive_id: claim.record.archive_id,
          change_key: claim.record.change_identity,
          archive_schema_version: claim.record.archive_schema_version,
          package_sha256: claim.record.package_sha256,
          content: bytes
        }, source, claim.record.package_sha256);
      } catch {
        return rejectClaim(claim, "REMOTE_UNAVAILABLE", true);
      }
      const receipt = projectIngestReceipt(ingest, claim);
      if (receipt === undefined) {
        return rejectClaim(claim, "ARCHIVE_INGEST_RECEIPT_INVALID", false);
      }
      if (receipt.archive_status === "failed") {
        return rejectClaim(claim, receipt.reason_code ?? "ARCHIVE_PUBLISH_FAILED", receipt.retryable);
      }
      const rawAcknowledged: unknown = await outboxAck.call(
        dependencies.outbox, claim, receipt, retentionPolicy
      );
      const acknowledged = validateAckTransition(rawAcknowledged, claim, receipt, retentionPolicy);
      if (acknowledged === undefined) {
        throw new ArchiveRemoteAdapterError("ARCHIVE_REMOTE_OUTBOX_TRANSITION_INVALID");
      }
      return frozen({
        outcome: "stored" as const,
        sync_receipt: receipt,
        ack: acknowledged,
        cleanup_intent: acknowledged.retention
      });
    },

    declineUpload() {
      return frozen({ outcome: "cancelled" as const, local_archive_unchanged: true as const,
        cleanup_intent: null });
    }
  });
}
