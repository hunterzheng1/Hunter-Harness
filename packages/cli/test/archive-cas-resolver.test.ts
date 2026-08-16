import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLocalArchiveZipResolver, putArchiveCas } from "../src/archive-production/cas-store.js";

describe("archive CAS store + trusted resolver (06B-3 W1)", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "archive-cas-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const zipBytes = (tag: string) => new TextEncoder().encode(`PK-fake-zip-${tag}`);

  it("put → resolve round trip with project binding", async () => {
    const ref = await putArchiveCas(root, zipBytes("a"), { project_id: "prj_a" });
    expect(ref.ref_id.startsWith("archive_cas:")).toBe(true);
    const resolver = createLocalArchiveZipResolver({ projectRoot: root });
    const bytes = await resolver.resolve(ref, "prj_a");
    expect(new TextDecoder().decode(bytes)).toBe("PK-fake-zip-a");
  });

  it("idempotent put merges project list", async () => {
    const ref1 = await putArchiveCas(root, zipBytes("same"), { project_id: "prj_a" });
    const ref2 = await putArchiveCas(root, zipBytes("same"), { project_id: "prj_b" });
    expect(ref1.package_sha256).toBe(ref2.package_sha256);
    const resolver = createLocalArchiveZipResolver({ projectRoot: root });
    await expect(resolver.resolve(ref1, "prj_a")).resolves.toBeTruthy();
    await expect(resolver.resolve(ref2, "prj_b")).resolves.toBeTruthy();
  });

  it("rejects cross-project read", async () => {
    const ref = await putArchiveCas(root, zipBytes("b"), { project_id: "prj_a" });
    const resolver = createLocalArchiveZipResolver({ projectRoot: root });
    await expect(resolver.resolve(ref, "prj_other")).rejects.toThrow("ARCHIVE_ZIP_REF_UNTRUSTED");
  });

  it("rejects forged ref_id (identity must derive from hash)", async () => {
    const ref = await putArchiveCas(root, zipBytes("c"), { project_id: "prj_a" });
    const resolver = createLocalArchiveZipResolver({ projectRoot: root });
    await expect(resolver.resolve({ ...ref, ref_id: `archive_cas:${"0".repeat(32)}` }, "prj_a"))
      .rejects.toThrow("ARCHIVE_ZIP_REF_UNTRUSTED");
  });

  it("rejects tampered zip bytes (hash mismatch)", async () => {
    const ref = await putArchiveCas(root, zipBytes("d"), { project_id: "prj_a" });
    const path = join(root, ".harness", "state", "local", "archive-cas", `${ref.package_sha256.slice(7)}.zip`);
    await fs.writeFile(path, zipBytes("tampered"));
    const resolver = createLocalArchiveZipResolver({ projectRoot: root });
    await expect(resolver.resolve(ref, "prj_a")).rejects.toThrow("ARCHIVE_ZIP_REF_UNTRUSTED");
  });

  it("rejects corrupt binding file", async () => {
    const ref = await putArchiveCas(root, zipBytes("e"), { project_id: "prj_a" });
    const path = join(root, ".harness", "state", "local", "archive-cas", `${ref.package_sha256.slice(7)}.binding.json`);
    await fs.writeFile(path, "{not-json");
    const resolver = createLocalArchiveZipResolver({ projectRoot: root });
    await expect(resolver.resolve(ref, "prj_a")).rejects.toThrow("ARCHIVE_ZIP_REF_UNTRUSTED");
  });

  it("rejects binding record_hash drift (self-seal check)", async () => {
    const ref = await putArchiveCas(root, zipBytes("f"), { project_id: "prj_a" });
    const path = join(root, ".harness", "state", "local", "archive-cas", `${ref.package_sha256.slice(7)}.binding.json`);
    const binding = JSON.parse(await fs.readFile(path, "utf8"));
    binding.project_ids = ["prj_evil"];
    await fs.writeFile(path, JSON.stringify(binding));
    const resolver = createLocalArchiveZipResolver({ projectRoot: root });
    await expect(resolver.resolve(ref, "prj_evil")).rejects.toThrow("ARCHIVE_ZIP_REF_UNTRUSTED");
  });

  it("rejects missing zip (record never written)", async () => {
    const resolver = createLocalArchiveZipResolver({ projectRoot: root });
    const fake = {
      ref_id: `archive_cas:${"a".repeat(32)}` as const,
      package_sha256: `sha256:${"a".repeat(64)}` as const,
      size_bytes: 12
    };
    await expect(resolver.resolve(fake, "prj_a")).rejects.toThrow("ARCHIVE_ZIP_REF_UNTRUSTED");
  });
});
