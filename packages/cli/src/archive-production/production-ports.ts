import { createHash } from "node:crypto";

import { canonicalJson } from "@hunter-harness/contracts";

import { createLocalArchiveZipResolver, type LocalArchiveZipRef } from "./cas-store.js";

/**
 * 06B-3 W3 生产 port 组（T0-3/T0-4 冻结语义）。
 *
 * - 包验证器：字节级复核（CAS resolver）+ receipt/ref/字节三方哈希一致 + receipt 自签
 * - HTTP publisher：POST archives:ingest（T0-4 新路由）；路由缺失/收据不 conform →
 *   ARCHIVE_PUBLISH_FAILED fail closed，绝不投影 legacy 形状冒充新收据
 */

const SHA = /^sha256:[a-f0-9]{64}$/u;

const sha256Tagged = (value: unknown): string =>
  `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;

interface PackageReceiptLike {
  readonly package_sha256: string;
  readonly manifest_sha256: string;
  readonly receipt_hash: string;
  readonly [key: string]: unknown;
}

function receiptSealValid(receipt: PackageReceiptLike): boolean {
  const body: Record<string, unknown> = { ...receipt };
  delete body.receipt_hash;
  return typeof receipt.receipt_hash === "string" && SHA.test(receipt.receipt_hash) &&
    sha256Tagged(body) === receipt.receipt_hash;
}

export function createArchivePackageVerifier(options: { readonly projectRoot: string }) {
  const resolver = createLocalArchiveZipResolver({ projectRoot: options.projectRoot });
  return Object.freeze({
    async verify(input: {
      readonly package_receipt: PackageReceiptLike;
      readonly local_zip_ref: LocalArchiveZipRef;
      readonly project_id: string;
    }): Promise<{ readonly schema_version: 1; readonly verdict: "verified"; readonly verified_at: string; readonly evidence: Record<string, unknown> } |
      { readonly schema_version: 1; readonly verdict: "rejected"; readonly reason_codes: readonly string[]; readonly verified_at: string }> {
      const verifiedAt = new Date().toISOString();
      const reasons: string[] = [];
      if (typeof input.package_receipt?.package_sha256 !== "string" ||
          input.package_receipt.package_sha256 !== input.local_zip_ref?.package_sha256) {
        reasons.push("RECEIPT_REF_HASH_MISMATCH");
      }
      let bytes: Uint8Array | null = null;
      try {
        bytes = await resolver.resolve(input.local_zip_ref, input.project_id);
      } catch {
        reasons.push("ZIP_REF_UNTRUSTED");
      }
      if (bytes !== null && `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== input.package_receipt.package_sha256) {
        reasons.push("RECEIPT_BYTES_HASH_MISMATCH");
      }
      if (!receiptSealValid(input.package_receipt)) {
        reasons.push("RECEIPT_SEAL_INVALID");
      }
      if (reasons.length > 0) {
        return Object.freeze({ schema_version: 1 as const, verdict: "rejected" as const,
          reason_codes: reasons, verified_at: verifiedAt });
      }
      return Object.freeze({
        schema_version: 1 as const,
        verdict: "verified" as const,
        verified_at: verifiedAt,
        evidence: {
          package_sha256: input.package_receipt.package_sha256,
          manifest_sha256: input.package_receipt.manifest_sha256,
          byte_length: (bytes as Uint8Array).byteLength
        }
      });
    }
  });
}

export interface ArchiveSyncReceiptLike {
  readonly request_id: string;
  readonly idempotency_key: string;
  readonly project_id: string;
  readonly archive_id: string;
  readonly change_key: string;
  readonly package_sha256: string;
  readonly archive_status: "stored" | "failed";
  readonly project_version: string;
  readonly stored_at: string;
  readonly retryable: boolean;
  readonly reason_code?: "REMOTE_UNAVAILABLE" | "ARCHIVE_PUBLISH_FAILED";
}

export interface HttpArchivePublisherOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
}

function validSyncReceipt(value: unknown): value is ArchiveSyncReceiptLike {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return typeof receipt.request_id === "string" && typeof receipt.idempotency_key === "string" &&
    typeof receipt.project_id === "string" && typeof receipt.archive_id === "string" &&
    typeof receipt.change_key === "string" && typeof receipt.package_sha256 === "string" &&
    SHA.test(receipt.package_sha256) &&
    (receipt.archive_status === "stored" || receipt.archive_status === "failed") &&
    typeof receipt.project_version === "string" && typeof receipt.stored_at === "string" &&
    typeof receipt.retryable === "boolean";
}

/**
 * Archive commit 的 HTTP 生产 publisher（T0-4）。
 * 目标路由：`POST /api/v1/projects/<project_id>/archives:ingest`（新 canonical seam）。
 * 路由不存在（404）或响应不 conform → 失败收据（retryable:true / ARCHIVE_PUBLISH_FAILED），
 * 绝不把 legacy `/archive-package` 的形状冒充为新收据。
 */
export function createHttpArchivePublisher(options: HttpArchivePublisherOptions) {
  const fetcher = options.fetchImpl ?? fetch;
  return Object.freeze({
    async commitArchive(input: {
      readonly package_ref: {
        readonly request_id: string;
        readonly archive_id: string;
        readonly change_key: string;
        readonly archive_schema_version: number;
        readonly package_sha256: string;
        readonly content: Uint8Array;
      };
      readonly source_ref: { readonly project_id: string; readonly branch_name: string };
      readonly idempotency_key: string;
      readonly logical_slot: string;
    }): Promise<ArchiveSyncReceiptLike> {
      const url = `${options.baseUrl.replace(/\/+$/u, "")}/api/v1/projects/${encodeURIComponent(input.source_ref.project_id)}/archives:ingest`;
      let response: Response;
      try {
        response = await fetcher(url, {
          method: "POST",
          headers: {
            "authorization": `Bearer ${options.token}`,
            "content-type": "application/octet-stream",
            "x-archive-request-id": input.package_ref.request_id,
            "x-archive-id": input.package_ref.archive_id,
            "x-archive-change-key": input.package_ref.change_key,
            "x-archive-schema-version": String(input.package_ref.archive_schema_version),
            "x-archive-package-sha256": input.package_ref.package_sha256,
            "x-archive-idempotency-key": input.idempotency_key,
            "x-archive-logical-slot": input.logical_slot
          },
          body: Buffer.from(input.package_ref.content)
        });
      } catch {
        return Object.freeze({
          request_id: input.package_ref.request_id,
          idempotency_key: input.idempotency_key,
          project_id: input.source_ref.project_id,
          archive_id: input.package_ref.archive_id,
          change_key: input.package_ref.change_key,
          package_sha256: input.package_ref.package_sha256,
          archive_status: "failed" as const,
          project_version: "0",
          stored_at: new Date().toISOString(),
          retryable: true,
          reason_code: "REMOTE_UNAVAILABLE" as const
        });
      }
      if (response.status === 404) {
        // 新路由未上线：fail closed（可重试），绝不落回 legacy 形状
        return Object.freeze({
          request_id: input.package_ref.request_id,
          idempotency_key: input.idempotency_key,
          project_id: input.source_ref.project_id,
          archive_id: input.package_ref.archive_id,
          change_key: input.package_ref.change_key,
          package_sha256: input.package_ref.package_sha256,
          archive_status: "failed" as const,
          project_version: "0",
          stored_at: new Date().toISOString(),
          retryable: true,
          reason_code: "REMOTE_UNAVAILABLE" as const
        });
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok || !validSyncReceipt(body)) {
        return Object.freeze({
          request_id: input.package_ref.request_id,
          idempotency_key: input.idempotency_key,
          project_id: input.source_ref.project_id,
          archive_id: input.package_ref.archive_id,
          change_key: input.package_ref.change_key,
          package_sha256: input.package_ref.package_sha256,
          archive_status: "failed" as const,
          project_version: "0",
          stored_at: new Date().toISOString(),
          retryable: response.status >= 500,
          reason_code: "ARCHIVE_PUBLISH_FAILED" as const
        });
      }
      return Object.freeze(body);
    }
  });
}
