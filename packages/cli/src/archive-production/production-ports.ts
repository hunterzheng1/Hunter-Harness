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
  readonly project_id: string;
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
    }): Promise<Record<string, unknown> |
      { readonly schema_version: 1; readonly verdict: "rejected"; readonly reason_codes: readonly string[]; readonly verified_at: string }> {
      const verifiedAt = new Date().toISOString();
      const reasons: string[] = [];
      if (typeof input.package_receipt?.package_sha256 !== "string" ||
          input.package_receipt.package_sha256 !== input.local_zip_ref?.package_sha256) {
        reasons.push("RECEIPT_REF_HASH_MISMATCH");
      }
      let bytes: Uint8Array | null = null;
      try {
        bytes = await resolver.resolve(input.local_zip_ref, input.package_receipt.project_id);
      } catch {
        reasons.push("ZIP_REF_UNTRUSTED");
      }
      if (bytes !== null && `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== input.package_receipt.package_sha256) {
        reasons.push("RECEIPT_BYTES_HASH_MISMATCH");
      }
      if (typeof input.package_receipt.project_id !== "string" || input.package_receipt.project_id === "") {
        reasons.push("RECEIPT_PROJECT_MISSING");
      }
      if (!receiptSealValid(input.package_receipt)) {
        reasons.push("RECEIPT_SEAL_INVALID");
      }
      if (reasons.length > 0) {
        return Object.freeze({ schema_version: 1 as const, verdict: "rejected" as const,
          reason_codes: reasons, verified_at: verifiedAt });
      }
      // 与冻结 evidence 契约一致（validation.ts:144-163）：body → evidence_hash → verification_id 派生
      const body = {
        schema_version: 1 as const,
        verdict: "verified" as const,
        package_operation_id: input.package_receipt.package_operation_id,
        receipt_hash: input.package_receipt.receipt_hash,
        package_sha256: input.package_receipt.package_sha256,
        manifest_sha256: input.package_receipt.manifest_sha256,
        local_zip_ref_id: input.local_zip_ref.ref_id,
        local_zip_size_bytes: input.local_zip_ref.size_bytes,
        expected_immutable_identity: sha256Tagged({
          package_receipt: input.package_receipt,
          local_zip_ref: input.local_zip_ref
        }),
        verified_at: verifiedAt
      };
      const evidenceHash = sha256Tagged(body);
      return Object.freeze({
        ...body,
        verification_id: `archive_outbox_package_verification:${evidenceHash.slice(7)}`,
        evidence_hash: evidenceHash
      });
    }
  });
}
