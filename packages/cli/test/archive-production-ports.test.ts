import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson } from "@hunter-harness/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { putArchiveCas } from "../src/archive-production/cas-store.js";
import { createArchivePackageVerifier } from "../src/archive-production/production-ports.js";

const sha256Tagged = (value: unknown): string =>
  `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;

function receiptFor(packageSha256: string) {
  const body = {
    package_sha256: packageSha256,
    manifest_sha256: `sha256:${"b".repeat(64)}`,
    package_operation_id: "op_x"
  };
  return { ...body, receipt_hash: sha256Tagged(body) };
}

describe("archive package verifier (06B-3 W3 T0-3)", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "archive-verifier-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("verifies triple consistency (bytes + ref + receipt)", async () => {
    const bytes = new TextEncoder().encode("PK-verify");
    const ref = await putArchiveCas(root, bytes, { project_id: "prj_v" });
    const verifier = createArchivePackageVerifier({ projectRoot: root });
    const result = await verifier.verify({
      package_receipt: receiptFor(ref.package_sha256),
      local_zip_ref: ref,
      project_id: "prj_v"
    });
    expect(result.verdict).toBe("verified");
  });

  it("rejects receipt/ref hash mismatch", async () => {
    const ref = await putArchiveCas(root, new TextEncoder().encode("PK-a"), { project_id: "prj_v" });
    const verifier = createArchivePackageVerifier({ projectRoot: root });
    const result = await verifier.verify({
      package_receipt: receiptFor(`sha256:${"9".repeat(64)}`),
      local_zip_ref: ref,
      project_id: "prj_v"
    });
    expect(result.verdict).toBe("rejected");
    expect((result as { reason_codes: string[] }).reason_codes).toContain("RECEIPT_REF_HASH_MISMATCH");
  });

  it("rejects forged receipt seal", async () => {
    const ref = await putArchiveCas(root, new TextEncoder().encode("PK-b"), { project_id: "prj_v" });
    const verifier = createArchivePackageVerifier({ projectRoot: root });
    const bad = { ...receiptFor(ref.package_sha256), receipt_hash: `sha256:${"0".repeat(64)}` };
    const result = await verifier.verify({ package_receipt: bad, local_zip_ref: ref, project_id: "prj_v" });
    expect(result.verdict).toBe("rejected");
    expect((result as { reason_codes: string[] }).reason_codes).toContain("RECEIPT_SEAL_INVALID");
  });

  it("rejects untrusted zip ref (cross-project)", async () => {
    const ref = await putArchiveCas(root, new TextEncoder().encode("PK-c"), { project_id: "prj_v" });
    const verifier = createArchivePackageVerifier({ projectRoot: root });
    const result = await verifier.verify({
      package_receipt: receiptFor(ref.package_sha256),
      local_zip_ref: ref,
      project_id: "prj_other"
    });
    expect(result.verdict).toBe("rejected");
    expect((result as { reason_codes: string[] }).reason_codes).toContain("ZIP_REF_UNTRUSTED");
  });
});
