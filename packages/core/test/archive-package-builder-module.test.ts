import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  createArchiveEngine,
  InMemoryArchivePort,
  type LocalArchiveReceipt
} from "../src/archive-engine/index.js";
import {
  ArchivePackageBuilderError,
  InMemoryArchivePackagePort,
  createArchivePackageBuilder,
  normalizeArchivePackageRecord,
  sha256Bytes,
  stableHash,
  stableJson,
  type ArchivePackageBuildResult,
  type ArchivePackageEntry,
  type ArchivePackageReceipt,
  type DeterministicZipConfig,
  type CoreV2Projection,
  type PublishedArchiveInventory
} from "../src/archive-package-builder/index.js";

const H = (character: string) => `sha256:${character.repeat(64)}` as const;
const encoder = new TextEncoder();
const operationId = `archive_operation:${"1".repeat(64)}` as const;
const localPayloads: Readonly<Record<string, Uint8Array>> = {
  "summary/change-summary.json": json({ schema_version: 1, summary: "done" }),
  "attestations/verification.json": json({ schema_version: 1, status: "passed" }),
  "archive-meta.json": json({ schema_version: 1, operation_id: operationId })
};
const sourceManifest = canonicalJson({
  schema_version: 1,
  operation_id: operationId,
  change_identity: "change-alpha",
  source_snapshot_hash: H("2"),
  files: Object.entries(localPayloads).map(([path, content]) => ({
    path, content_hash: sha256Bytes(content), size_bytes: content.byteLength
  })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
});

const localReceipt: LocalArchiveReceipt = {
  schema_version: 1,
  operation_id: operationId,
  change_identity: "change-alpha",
  closure_disposition: "completed",
  archive_intent: "record_only",
  source_snapshot_hash: H("2"),
  archive_schema_version: 1,
  archive_path: ".harness/archive/change-alpha",
  archive_manifest_hash: sha256Bytes(sourceManifest),
  completed_at: "2026-08-13T08:00:00.000Z"
};

function json(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value)}\n`);
}

function canonicalJson(value: unknown): Uint8Array {
  return encoder.encode(`${stableJson(value)}\n`);
}

function inventory(
  overrides: Partial<PublishedArchiveInventory> = {},
  extra: Readonly<Record<string, Uint8Array>> = {}
): { value: PublishedArchiveInventory; reads: Map<string, number> } {
  const files: Record<string, Uint8Array> = {
    "archive-manifest.json": sourceManifest,
    ...localPayloads,
    ...extra
  };
  const reads = new Map<string, number>();
  const entries = Object.entries(files).map(([path, content]) => ({
    path,
    content_hash: path === "archive-manifest.json" ? localReceipt.archive_manifest_hash : sha256Bytes(content),
    size_bytes: content.byteLength,
    read_content: async () => {
      reads.set(path, (reads.get(path) ?? 0) + 1);
      return content.slice();
    }
  }));
  return {
    reads,
    value: {
      schema_version: 1,
      operation_id: localReceipt.operation_id,
      change_identity: localReceipt.change_identity,
      closure_disposition: localReceipt.closure_disposition,
      archive_intent: localReceipt.archive_intent,
      source_snapshot_hash: localReceipt.source_snapshot_hash,
      archive_schema_version: localReceipt.archive_schema_version,
      archive_path: localReceipt.archive_path,
      archive_manifest_hash: localReceipt.archive_manifest_hash,
      completed_at: localReceipt.completed_at,
      files: entries,
      ...overrides
    }
  };
}

function projection(extra: Readonly<Record<string, Uint8Array>> = {},
  overrides: Partial<CoreV2Projection> = {}): { value: CoreV2Projection; reads: Map<string, number> } {
  const payloads: Record<string, Uint8Array> = {
    "candidates/knowledge.json": json([]),
    "candidates/project-content.json": json([]),
    "change-context.json": json({ schema_version: 1, change_key: "change-alpha" }),
    "spec/design.md": encoder.encode("# Design\n"),
    "plans/implementation.md": encoder.encode("# Plan\n"),
    ...extra
  };
  const reads = new Map<string, number>();
  return { reads, value: { schema_version: 2, project_id: "prj_alpha", project_version: "pv_alpha",
    archive_id: "arc_alpha", files: Object.entries(payloads).map(([path, content]) => ({ path,
      content_hash: sha256Bytes(content), size_bytes: content.byteLength, read_content: async () => {
        reads.set(path, (reads.get(path) ?? 0) + 1); return content.slice();
      } })), ...overrides } };
}

function expected(source: PublishedArchiveInventory, projected: CoreV2Projection) {
  return { local_receipt: localReceipt, inventory: source, projection: projected };
}

async function selfRepackage(
  port: InMemoryArchivePackagePort,
  built: ArchivePackageBuildResult,
  mutate: (input: {
    entries: ArchivePackageEntry[];
    manifest: Record<string, unknown>;
    zip_config: DeterministicZipConfig;
    receipt: ArchivePackageReceipt;
  }) => void
): Promise<{ package_bytes: Uint8Array; receipt: ArchivePackageReceipt }> {
  const inspected = await port.inspect(built.package_bytes);
  const entries = inspected.entries.map((entry) => ({ ...entry, content: entry.content.slice() }));
  const manifestEntry = entries.find((entry) => entry.path === "archive-manifest.json");
  if (manifestEntry === undefined) throw new Error("manifest missing");
  const manifest = JSON.parse(new TextDecoder().decode(manifestEntry.content)) as Record<string, unknown>;
  const input = { entries, manifest, zip_config: { ...inspected.zip_config }, receipt: built.receipt };
  mutate(input);
  const currentManifest = input.entries.find((entry) => entry.path === "archive-manifest.json");
  if (currentManifest === undefined) throw new Error("manifest renamed");
  currentManifest.content = canonicalJson(input.manifest);
  currentManifest.content_hash = sha256Bytes(currentManifest.content);
  currentManifest.size_bytes = currentManifest.content.byteLength;
  input.entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const package_bytes = await port.build(input.entries, input.zip_config);
  const { receipt_hash: ignored, ...base } = input.receipt;
  void ignored;
  const receiptBody = {
    ...base,
    package_sha256: sha256Bytes(package_bytes),
    manifest_sha256: currentManifest.content_hash,
    package_size_bytes: package_bytes.byteLength,
    entry_count: input.entries.length,
    entry_paths: input.entries.map((entry) => entry.path),
    uncompressed_size_bytes: input.entries.reduce((total, entry) => total + entry.size_bytes, 0),
    zip_config: input.zip_config
  };
  return { package_bytes, receipt: { ...receiptBody, receipt_hash: stableHash(receiptBody) } };
}

describe("ArchivePackageBuilder core-v2", () => {
  it("builds deterministic core-v2 package bytes with one source read and reuses identity", async () => {
    const source = inventory();
    const projected = projection();
    const port = new InMemoryArchivePackagePort();
    const builder = createArchivePackageBuilder({
      port,
      clock: () => new Date("2026-08-13T09:00:00.000Z")
    });

    const first = await builder.buildPackage(localReceipt, source.value, projected.value, 2);
    const second = await builder.buildPackage(localReceipt, source.value, projected.value, 2);

    expect(second).toEqual(first);
    expect(port.build_calls).toBe(1);
    expect([...source.reads.values()]).toEqual(new Array(source.value.files.length).fill(1));
    expect(first.receipt).toMatchObject({
      schema_version: 2,
      package_schema_version: 2,
      archive_schema_version: 1,
      operation_id: localReceipt.operation_id,
      change_identity: localReceipt.change_identity,
      source_manifest_hash: localReceipt.archive_manifest_hash,
      source_read_count: source.value.files.length + projected.value.files.length,
      zip_config: {
        entry_mtime: "1980-01-01T00:00:00.000Z",
        file_mode: 0o100644,
        compression: "deflate",
        compression_level: 9
      }
    });
    expect(first.receipt.package_sha256).toBe(sha256Bytes(first.package_bytes));
    expect(await builder.verifyPackage(first.receipt, first.package_bytes,
      { local_receipt: localReceipt, inventory: source.value, projection: projected.value })).toEqual({
      valid: true,
      reason_codes: []
    });
  });

  it("verifies an immutable package after the builder process restarts", async () => {
    const source = inventory();
    const projected = projection();
    const port = new InMemoryArchivePackagePort();
    const firstProcess = createArchivePackageBuilder({
      port,
      clock: () => new Date("2026-08-13T09:00:00.000Z")
    });
    const built = await firstProcess.buildPackage(localReceipt, source.value, projected.value, 2);
    const restartedProcess = createArchivePackageBuilder({
      port,
      clock: () => new Date("2026-08-14T09:00:00.000Z")
    });

    expect(await restartedProcess.verifyPackage(built.receipt, built.package_bytes,
      expected(source.value, projected.value))).toEqual({ valid: true, reason_codes: [] });
  });

  it.each(["not-a-date", "2026-02-30T09:00:00.000Z"])(
    "fails closed without leaking when persisted completion time is invalid: %s",
    async (completed_at) => {
      const source = inventory();
      const projected = projection();
      class InvalidCompletionPort extends InMemoryArchivePackagePort {
        override async readCompletion(package_operation_id: `archive_package_operation:${string}`) {
          const evidence = await super.readCompletion(package_operation_id);
          return evidence === undefined ? undefined : { ...evidence, completed_at };
        }
      }
      const port = new InvalidCompletionPort();
      const firstProcess = createArchivePackageBuilder({
        port,
        clock: () => new Date("2026-08-13T09:00:00.000Z")
      });
      const built = await firstProcess.buildPackage(localReceipt, source.value, projected.value, 2);
      const restartedProcess = createArchivePackageBuilder({ port });

      await expect(restartedProcess.buildPackage(localReceipt, source.value, projected.value, 2))
        .rejects.toMatchObject({ code: "ARCHIVE_PACKAGE_PORT_INVALID" });
      expect(await restartedProcess.verifyPackage(built.receipt, built.package_bytes,
        expected(source.value, projected.value))).toEqual({
        valid: false,
        reason_codes: ["ARCHIVE_PACKAGE_RECEIPT_INVALID"]
      });
    }
  );

  it("packages a real 06B1 local archive plus an independent core-v2 projection", async () => {
    const archivePort = new InMemoryArchivePort({ changes: [{ change_identity: "project-1/integration",
      files: [{ path: "spec/goal.md", content: "# Goal\n" },
        { path: "plans/implementation.md", content: "# Plan\n" }] }] });
    const archive = createArchiveEngine({ port: archivePort, owner_id: "package-integration",
      lease_ms: 30_000, clock: () => new Date("2026-08-13T08:00:00.000Z") });
    const plan = await archive.prepareArchive({ schema_version: 1, change_identity: "project-1/integration",
      archive_schema_version: 1, archive_path: ".harness/archive/integration" }, {
      schema_version: 1, disposition: "abandoned", archive_intent: "record_only",
      available_evidence: { phase_terminals: [], termination_reason_zh: "本地集成验证" }
    });
    const receipt = await archive.finalizeLocalArchive(plan);
    const published = await archivePort.inspectArchive(receipt.archive_path);
    expect(published).toBeDefined();
    if (published === undefined) throw new Error("06B1 archive missing");
    const local: PublishedArchiveInventory = { ...receipt, files: [...published.files.entries()]
      .map(([path, content]) => ({ path, content_hash: sha256Bytes(content), size_bytes: content.byteLength,
        read_content: async () => content.slice() })) };
    const projected = projection();
    const projectionWithoutLocalCollisions: CoreV2Projection = { ...projected.value,
      files: projected.value.files.filter((file) => !["spec/design.md", "plans/implementation.md"].includes(file.path)) };
    const builder = createArchivePackageBuilder({ port: new InMemoryArchivePackagePort(),
      clock: () => new Date("2026-08-13T09:00:00.000Z") });
    const built = await builder.buildPackage(receipt, local, projectionWithoutLocalCollisions, 2);
    expect(built.receipt.source_receipt_hash).toBe(stableHash(receipt));
    expect(await builder.verifyPackage(built.receipt, built.package_bytes,
      { local_receipt: receipt, inventory: local, projection: projectionWithoutLocalCollisions }))
      .toEqual({ valid: true, reason_codes: [] });
  });
});

describe("ArchivePackageBuilder trust boundary", () => {
  it("rejects source receipt drift without mutating the local receipt", async () => {
    const source = inventory({ change_identity: "change-other" });
    const projected = projection();
    const before = structuredClone(localReceipt);
    const builder = createArchivePackageBuilder({ port: new InMemoryArchivePackagePort() });
    await expect(builder.buildPackage(localReceipt, source.value, projected.value, 2)).rejects.toMatchObject({
      code: "ARCHIVE_PACKAGE_SOURCE_INVALID"
    });
    expect(localReceipt).toEqual(before);
    expect([...source.reads.values()]).toEqual([]);
  });

  it("rejects an invalid completion clock before reading package content", async () => {
    const source = inventory();
    const projected = projection();
    const builder = createArchivePackageBuilder({
      port: new InMemoryArchivePackagePort(),
      clock: () => new Date(Number.NaN)
    });
    await expect(builder.buildPackage(localReceipt, source.value, projected.value, 2)).rejects.toMatchObject({
      code: "ARCHIVE_PACKAGE_INPUT_INVALID"
    });
    expect([...source.reads.values()]).toEqual([]);
  });

  it("excludes non-core and sensitive paths but rejects canonical collisions", async () => {
    for (const badPath of [
      "logs/run.log",
      "reports/test/raw.json",
      "cache/data.json",
      ".harness/runtime/state.json",
      "credentials.local.json"
    ]) {
      const source = inventory();
      const projected = projection({ [badPath]: encoder.encode("forbidden") });
      const builder = createArchivePackageBuilder({ port: new InMemoryArchivePackagePort() });
      const built = await builder.buildPackage(localReceipt, source.value, projected.value, 2);
      expect(built.receipt.entry_paths).not.toContain(badPath);
      expect(projected.reads.get(badPath)).toBeUndefined();
    }
    const source = inventory();
    const collision = projection({
      "spec/Cafe\u0301.md": encoder.encode("collision"),
      "spec/Caf\u00e9.md": encoder.encode("collision")
    });
    await expect(createArchivePackageBuilder({ port: new InMemoryArchivePackagePort() })
      .buildPackage(localReceipt, source.value, collision.value, 2)).rejects.toBeInstanceOf(
        ArchivePackageBuilderError
      );
    expect([...collision.reads.values()]).toEqual([]);
  });

  it("rejects declared hash or size drift and candidate schema violations", async () => {
    const badDeclaration = inventory();
    const projected = projection();
    const driftedFiles = badDeclaration.value.files.map((file, index) =>
      index === 1 ? { ...file, size_bytes: 1 } : file
    );
    await expect(createArchivePackageBuilder({ port: new InMemoryArchivePackagePort() })
      .buildPackage(localReceipt, { ...badDeclaration.value, files: driftedFiles }, projected.value, 2)).rejects.toMatchObject({
        code: "ARCHIVE_PACKAGE_SOURCE_INVALID"
      });

    const badCandidates = projection({
      "candidates/knowledge.json": json([{ invented: true }])
    });
    await expect(createArchivePackageBuilder({ port: new InMemoryArchivePackagePort() })
      .buildPackage(localReceipt, inventory().value, badCandidates.value, 2)).rejects.toMatchObject({
        code: "ARCHIVE_PACKAGE_CANDIDATE_INVALID"
      });
  });

  it("rejects schema-valid candidates whose change, archive or evidence source is unbound", async () => {
    const candidate = {
      schema_version: 1,
      candidate_id: "kc_unbound",
      source_change_key: "change-other",
      content_hash: H("8"),
      confidence: 0.8,
      provenance: {
        source_kind: "archive",
        source_ref: "arc_other",
        producer: "test",
        producer_version: "1",
        created_at: "2026-08-13T08:00:00.000Z"
      },
      source_refs: ["missing.md"],
      summary: "Reusable conclusion",
      reusability_scope: "project",
      status: "pending"
    };
    const source = inventory();
    const projected = projection({ "candidates/knowledge.json": json([candidate]) });
    await expect(createArchivePackageBuilder({ port: new InMemoryArchivePackagePort() })
      .buildPackage(localReceipt, source.value, projected.value, 2)).rejects.toMatchObject({
        code: "ARCHIVE_PACKAGE_CANDIDATE_INVALID"
      });
  });

  it("rejects package byte, manifest and receipt tampering", async () => {
    const source = inventory();
    const projected = projection();
    const builder = createArchivePackageBuilder({ port: new InMemoryArchivePackagePort() });
    const built = await builder.buildPackage(localReceipt, source.value, projected.value, 2);
    const tamperedBytes = built.package_bytes.slice();
    tamperedBytes[tamperedBytes.length - 1] ^= 1;
    expect((await builder.verifyPackage(built.receipt, tamperedBytes,
      expected(source.value, projected.value))).valid).toBe(false);
    expect((await builder.verifyPackage({
      ...built.receipt,
      package_sha256: H("f")
    }, built.package_bytes, expected(source.value, projected.value))).valid).toBe(false);
    const { receipt_hash: ignored, ...payload } = built.receipt;
    void ignored;
    const reboundPayload = {
      ...payload,
      package_operation_id: `archive_package_operation:${"f".repeat(64)}` as const
    };
    const reboundReceipt = {
      ...reboundPayload,
      receipt_hash: stableHash(reboundPayload)
    };
    expect((await builder.verifyPackage(reboundReceipt, built.package_bytes,
      expected(source.value, projected.value))).valid).toBe(false);
  });

  it("keeps cached package bytes immutable and rejects metadata rebinding for the same identity", async () => {
    const source = inventory();
    const projected = projection();
    const builder = createArchivePackageBuilder({ port: new InMemoryArchivePackagePort() });
    const first = await builder.buildPackage(localReceipt, source.value, projected.value, 2);
    const expectedBytes = first.package_bytes.slice();
    first.package_bytes[0] ^= 1;

    const replay = await builder.buildPackage(localReceipt, source.value, projected.value, 2);
    expect(replay.package_bytes).toEqual(expectedBytes);
    expect((await builder.verifyPackage(replay.receipt, replay.package_bytes,
      expected(source.value, projected.value))).valid).toBe(true);

    const rebound = projection({}, { project_id: "prj_other" });
    await expect(builder.buildPackage(localReceipt, source.value, rebound.value, 2)).rejects.toMatchObject({
      code: "ARCHIVE_PACKAGE_IMMUTABLE_CONFLICT"
    });
  });

  it("rejects a source manifest whose exact entries do not close over the local inventory", async () => {
    const source = inventory({}, { "unlisted-local.json": json({ hidden: true }) });
    const projected = projection();
    await expect(createArchivePackageBuilder({ port: new InMemoryArchivePackagePort() })
      .buildPackage(localReceipt, source.value, projected.value, 2)).rejects.toMatchObject({
        code: "ARCHIVE_PACKAGE_SOURCE_INVALID"
      });
  });

  it("rejects eight classes of self-rehashed receipt evidence tampering", async () => {
    const source = inventory();
    const projected = projection();
    const builder = createArchivePackageBuilder({ port: new InMemoryArchivePackagePort() });
    const built = await builder.buildPackage(localReceipt, source.value, projected.value, 2);
    const { receipt_hash: ignored, ...payload } = built.receipt;
    void ignored;
    const changes = [
      { operation_id: `archive_operation:${"9".repeat(64)}` as const },
      { change_identity: "change-other" },
      { source_snapshot_hash: H("9") },
      { local_archive_completed_at: "2026-08-13T08:00:01.000Z" },
      { source_receipt_hash: H("9") },
      { local_inventory_hash: H("9") },
      { projection_hash: H("9") },
      { completed_at: "2026-08-13T09:00:01.000Z" }
    ];
    for (const change of changes) {
      const changed = { ...payload, ...change };
      const verification = await builder.verifyPackage({ ...changed, receipt_hash: stableHash(changed) },
        built.package_bytes, expected(source.value, projected.value));
      expect(verification.reason_codes).toContain("ARCHIVE_PACKAGE_RECEIPT_INVALID");
    }
  });

  it("rejects a self-consistent package that renames an entry outside the canonical path boundary", async () => {
    const source = inventory();
    const projected = projection();
    const port = new InMemoryArchivePackagePort();
    const builder = createArchivePackageBuilder({ port });
    const built = await builder.buildPackage(localReceipt, source.value, projected.value, 2);
    const attack = await selfRepackage(port, built, ({ entries, manifest }) => {
      const target = entries.find((entry) => entry.path === "spec/design.md");
      if (target === undefined) throw new Error("target missing");
      target.path = "../escape.md";
      const files = manifest.files as Array<Record<string, unknown>>;
      const declared = files.find((entry) => entry.path === "spec/design.md");
      if (declared === undefined) throw new Error("declared target missing");
      declared.path = "../escape.md";
      files.sort((left, right) => String(left.path) < String(right.path) ? -1 :
        String(left.path) > String(right.path) ? 1 : 0);
    });
    expect(await builder.verifyPackage(attack.receipt, attack.package_bytes,
      expected(source.value, projected.value))).toEqual({
      valid: false, reason_codes: ["ARCHIVE_PACKAGE_VERIFICATION_FAILED"]
    });
  });

  it("classifies self-rehashed schema and zip configuration drift as receipt invalid", async () => {
    const source = inventory();
    const projected = projection();
    const port = new InMemoryArchivePackagePort();
    const builder = createArchivePackageBuilder({ port });
    const built = await builder.buildPackage(localReceipt, source.value, projected.value, 2);
    const attack = await selfRepackage(port, built, (input) => {
      input.manifest.schema_version = 3;
      input.manifest.package_schema_version = 3;
      input.zip_config = { ...input.zip_config, compression_level: 8 } as DeterministicZipConfig;
      input.receipt = { ...input.receipt, schema_version: 3, package_schema_version: 3,
        zip_config: input.zip_config } as unknown as ArchivePackageReceipt;
    });
    expect(await builder.verifyPackage(attack.receipt, attack.package_bytes,
      expected(source.value, projected.value))).toEqual({
      valid: false, reason_codes: ["ARCHIVE_PACKAGE_RECEIPT_INVALID"]
    });
  });

  it("rejects forged project version and archive identity even when package evidence agrees", async () => {
    const source = inventory();
    const projected = projection();
    const port = new InMemoryArchivePackagePort();
    const builder = createArchivePackageBuilder({ port });
    const built = await builder.buildPackage(localReceipt, source.value, projected.value, 2);
    const attack = await selfRepackage(port, built, (input) => {
      Object.assign(input.manifest, { project_id: "prj_forged", project_version: "pv_forged",
        archive_id: "arc_forged" });
      input.receipt = { ...input.receipt, project_id: "prj_forged", project_version: "pv_forged",
        archive_id: "arc_forged" };
    });
    expect(await builder.verifyPackage(attack.receipt, attack.package_bytes,
      expected(source.value, projected.value))).toEqual({
      valid: false, reason_codes: ["ARCHIVE_PACKAGE_RECEIPT_INVALID"]
    });
  });

  it("rejects cache reuse when the full local receipt changes under the same operation", async () => {
    const source = inventory();
    const projected = projection();
    const builder = createArchivePackageBuilder({ port: new InMemoryArchivePackagePort() });
    await builder.buildPackage(localReceipt, source.value, projected.value, 2);
    const drifted = { ...localReceipt, completed_at: "2026-08-13T08:00:01.000Z" };
    const rebound = inventory({ completed_at: drifted.completed_at });
    await expect(builder.buildPackage(drifted, rebound.value, projected.value, 2)).rejects.toMatchObject({
      code: "ARCHIVE_PACKAGE_IMMUTABLE_CONFLICT"
    });
  });

  it("rejects candidate self and cross-candidate references", async () => {
    const candidate = {
      schema_version: 1,
      candidate_id: "kc_self",
      source_change_key: localReceipt.change_identity,
      content_hash: H("8"),
      confidence: 0.8,
      provenance: {
        source_kind: "archive",
        source_ref: "arc_alpha",
        producer: "test",
        producer_version: "1",
        created_at: localReceipt.completed_at
      },
      source_refs: ["candidates/knowledge.json"],
      summary: "Reusable conclusion",
      reusability_scope: "project",
      status: "pending"
    };
    const source = inventory();
    const projected = projection({ "candidates/knowledge.json": json([candidate]) });
    await expect(createArchivePackageBuilder({ port: new InMemoryArchivePackagePort() })
      .buildPackage(localReceipt, source.value, projected.value, 2)).rejects.toMatchObject({
        code: "ARCHIVE_PACKAGE_CANDIDATE_INVALID"
      });
  });
});

describe("ArchivePackageBuilder compatibility", () => {
  it("normalizes current v2 receipt and leaves core-v1 read-only", async () => {
    const current = JSON.parse(await readFile(new URL(
      "./fixtures/archive-package-builder-v2-current.json", import.meta.url
    ), "utf8")) as unknown;
    const legacy = JSON.parse(await readFile(new URL(
      "./fixtures/archive-package-builder-v1-legacy.json", import.meta.url
    ), "utf8")) as unknown;
    expect(normalizeArchivePackageRecord(current)).toMatchObject({
      ok: true,
      source_package_schema_version: 2,
      readiness: "ready"
    });
    expect(normalizeArchivePackageRecord(legacy)).toEqual({
      ok: true,
      source_package_schema_version: 1,
      readiness: "legacy_read_only",
      legacy: {
        package_sha256: H("a"),
        manifest_sha256: H("b")
      },
      reason_codes: [
        "LEGACY_PACKAGE_OPERATION_ID_UNKNOWN",
        "LEGACY_SOURCE_RECEIPT_BINDING_UNKNOWN",
        "LEGACY_DETERMINISTIC_ZIP_CONFIG_UNKNOWN"
      ]
    });
  });

  it.each([
    ["calendar-invalid completion", (record: Record<string, unknown>) => {
      record.completed_at = "2026-02-30T09:00:00.000Z";
    }],
    ["escaping archive path", (record: Record<string, unknown>) => {
      record.archive_path = ".harness/archive/../escape";
    }],
    ["non-canonical entry path", (record: Record<string, unknown>) => {
      record.entry_paths = ["../escape", ...(record.entry_paths as string[]).slice(1)];
    }]
  ] as const)("rejects self-rehashed hostile current record: %s", async (_label, mutate) => {
    const current = JSON.parse(await readFile(new URL(
      "./fixtures/archive-package-builder-v2-current.json", import.meta.url
    ), "utf8")) as Record<string, unknown>;
    mutate(current);
    const { receipt_hash: ignored, ...payload } = current;
    void ignored;
    current.receipt_hash = stableHash(payload);

    expect(normalizeArchivePackageRecord(current)).toEqual({
      ok: false,
      reason_code: "ARCHIVE_PACKAGE_RECORD_INVALID"
    });
  });

  it("rejects an accessor current record without executing or leaking its getter", async () => {
    const current = JSON.parse(await readFile(new URL(
      "./fixtures/archive-package-builder-v2-current.json", import.meta.url
    ), "utf8")) as Record<string, unknown>;
    Object.defineProperty(current, "schema_version", {
      enumerable: true,
      get() { throw new Error("hostile getter"); }
    });

    expect(() => normalizeArchivePackageRecord(current)).not.toThrow();
    expect(normalizeArchivePackageRecord(current)).toEqual({
      ok: false,
      reason_code: "ARCHIVE_PACKAGE_RECORD_INVALID"
    });
  });

  it.each([
    "closure_disposition",
    "archive_intent",
    "source_snapshot_hash"
  ] as const)("rejects hostile coercion in current field without throwing: %s", async (field) => {
    const current = JSON.parse(await readFile(new URL(
      "./fixtures/archive-package-builder-v2-current.json", import.meta.url
    ), "utf8")) as Record<string, unknown>;
    current[field] = {
      toString() { throw new Error("hostile coercion"); }
    };
    const { receipt_hash: ignored, ...payload } = current;
    void ignored;
    current.receipt_hash = stableHash(payload);

    expect(() => normalizeArchivePackageRecord(current)).not.toThrow();
    expect(normalizeArchivePackageRecord(current)).toEqual({
      ok: false,
      reason_code: "ARCHIVE_PACKAGE_RECORD_INVALID"
    });
  });
});
