import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson } from "@hunter-harness/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFsArchiveOutboxPort } from "../src/archive-production/fs-outbox-port.js";
import { putArchiveCas } from "../src/archive-production/cas-store.js";
import { runArchiveOutboxGc } from "../src/commands/archive-outbox-gc.js";

const stableHash = (value: unknown): string =>
  `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;

function recordFor(entryId: string, generation = 1, overrides: Record<string, unknown> = {}) {
  const body = {
    entry_id: entryId,
    generation,
    state: "queued",
    updated_at: "2026-08-16T00:00:00.000Z",
    ...overrides
  };
  return { ...body, record_hash: stableHash(body) };
}

describe("FS archive outbox port (06B-3 W2)", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "archive-outbox-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("put → read round trip; put existing returns persisted (idempotent)", async () => {
    const port = createFsArchiveOutboxPort({ projectRoot: root });
    const record = recordFor("archive_outbox:" + "a".repeat(64));
    await port.put(record as never);
    const read = await port.read(record.entry_id);
    expect(read?.record_hash).toBe(record.record_hash);
    const again = await port.put({ ...record, state: "changed" } as never);
    expect((again as { state: string }).state).toBe("queued");
  });

  it("compareAndSwap: generation match swaps; mismatch returns current unswapped", async () => {
    const port = createFsArchiveOutboxPort({ projectRoot: root });
    const record = recordFor("archive_outbox:" + "b".repeat(64));
    await port.put(record as never);
    const next = recordFor(record.entry_id, 2, { state: "claimed" });
    const swapped = await port.compareAndSwap(record.entry_id, 1, next as never);
    expect(swapped.swapped).toBe(true);
    const drift = await port.compareAndSwap(record.entry_id, 1, next as never);
    expect(drift.swapped).toBe(false);
    expect((drift.record as { generation: number }).generation).toBe(2);
  });

  it("compareAndSwap on missing entry throws NOT_FOUND", async () => {
    const port = createFsArchiveOutboxPort({ projectRoot: root });
    await expect(port.compareAndSwap("archive_outbox:" + "c".repeat(64), 1, recordFor("archive_outbox:" + "c".repeat(64)) as never))
      .rejects.toThrow("ARCHIVE_OUTBOX_NOT_FOUND");
  });

  it("corrupt record → quarantine + read undefined (no auto repair)", async () => {
    const port = createFsArchiveOutboxPort({ projectRoot: root });
    const entryId = "archive_outbox:" + "d".repeat(64);
    const dir = join(root, ".harness", "state", "local", "archive-outbox");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, `${encodeURIComponent(entryId)}.json`), "{corrupt");
    expect(await port.read(entryId)).toBeUndefined();
    const quarantine = await fs.readFile(
      join(root, ".harness", "state", "local", "archive-outbox-quarantine", `${encodeURIComponent(entryId)}.json`), "utf8");
    expect(quarantine).toContain("UNREADABLE");
  });

  it("rejects record with tampered record_hash", async () => {
    const port = createFsArchiveOutboxPort({ projectRoot: root });
    const bad = { ...recordFor("archive_outbox:" + "e".repeat(64)), record_hash: `sha256:${"0".repeat(64)}` };
    await expect(port.put(bad as never)).rejects.toThrow("ARCHIVE_OUTBOX_RECORD_INVALID");
  });

  it("list paginates by codepoint with cursor", async () => {
    const port = createFsArchiveOutboxPort({ projectRoot: root });
    for (const suffix of ["aa", "ab", "ac"]) {
      await port.put(recordFor(`archive_outbox:${suffix}` + "f".repeat(62)) as never);
    }
    const first = await port.list(undefined, 2);
    expect(first.records).toHaveLength(2);
    expect(first.next_cursor).toBeDefined();
    const second = await port.list(first.next_cursor, 2);
    expect(second.records).toHaveLength(1);
    expect(second.next_cursor).toBeUndefined();
  });
});

describe("archive outbox gc (06B-3 T0-5)", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "archive-gc-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const deps = (outputs: string[]) => ({
    cwd: root,
    stdout: (chunk: string) => { outputs.push(chunk); return true; },
    stderr: () => true
  });

  async function seedRecord(entryId: string, state: string, sha?: string, updatedAt = "2026-01-01T00:00:00.000Z") {
    const port = createFsArchiveOutboxPort({ projectRoot: root });
    const zipRef = sha === undefined ? null : {
      ref_id: `archive_cas:${sha.slice(7, 39)}`,
      package_sha256: sha,
      size_bytes: 12
    };
    await port.put(recordFor(entryId, 1, {
      state, updated_at: updatedAt, local_zip_ref: zipRef
    }) as never);
  }

  it("requires explicit selector (never deletes by default)", async () => {
    const out: string[] = [];
    const code = await runArchiveOutboxGc({}, deps(out));
    expect(code).toBe(1);
    expect(JSON.parse(out.join("")).code).toBe("ARCHIVE_OUTBOX_GC_SELECTOR_REQUIRED");
  });

  it("dry-run previews without deleting; --apply deletes unreferenced CAS", async () => {
    const bytes = new TextEncoder().encode("PK-gc-target");
    const ref = await putArchiveCas(root, bytes, { project_id: "prj_gc" });
    const entryId = "archive_outbox:" + "1".repeat(64);
    await seedRecord(entryId, "acknowledged", ref.package_sha256);

    const dryOut: string[] = [];
    await runArchiveOutboxGc({ entry: [entryId] }, deps(dryOut));
    const dry = JSON.parse(dryOut.join(""));
    expect(dry.dry_run).toBe(true);
    await fs.access(join(root, ".harness", "state", "local", "archive-cas", `${ref.package_sha256.slice(7)}.zip`));

    const applyOut: string[] = [];
    await runArchiveOutboxGc({ entry: [entryId], apply: true }, deps(applyOut));
    const applied = JSON.parse(applyOut.join(""));
    expect(applied.results[0].action).toBe("cleaned");
    await expect(fs.access(join(root, ".harness", "state", "local", "archive-cas", `${ref.package_sha256.slice(7)}.zip`)))
      .rejects.toThrow();
  });

  it("keeps CAS when another record references the same hash", async () => {
    const bytes = new TextEncoder().encode("PK-shared");
    const ref = await putArchiveCas(root, bytes, { project_id: "prj_gc" });
    const entryA = "archive_outbox:" + "2".repeat(64);
    const entryB = "archive_outbox:" + "3".repeat(64);
    await seedRecord(entryA, "acknowledged", ref.package_sha256);
    await seedRecord(entryB, "queued", ref.package_sha256);

    const out: string[] = [];
    await runArchiveOutboxGc({ entry: [entryA], apply: true }, deps(out));
    const result = JSON.parse(out.join(""));
    expect(result.results[0].action).toBe("cleaned");
    expect(result.results[0].detail).toBe("shared_cas_hash");
    await fs.access(join(root, ".harness", "state", "local", "archive-cas", `${ref.package_sha256.slice(7)}.zip`));
  });

  it("non-terminal records are never targeted", async () => {
    const bytes = new TextEncoder().encode("PK-queued");
    const ref = await putArchiveCas(root, bytes, { project_id: "prj_gc" });
    const entryId = "archive_outbox:" + "4".repeat(64);
    await seedRecord(entryId, "claimed", ref.package_sha256);
    const out: string[] = [];
    await runArchiveOutboxGc({ entry: [entryId], apply: true }, deps(out));
    expect(JSON.parse(out.join("")).targets).toBe(0);
    await fs.access(join(root, ".harness", "state", "local", "archive-cas", `${ref.package_sha256.slice(7)}.zip`));
  });

  it("retain-days only collects old terminal records", async () => {
    const bytes = new TextEncoder().encode("PK-old");
    const ref = await putArchiveCas(root, bytes, { project_id: "prj_gc" });
    await seedRecord("archive_outbox:" + "5".repeat(64), "acknowledged", ref.package_sha256, "2026-01-01T00:00:00.000Z");
    await seedRecord("archive_outbox:" + "6".repeat(64), "acknowledged", undefined, new Date().toISOString());
    const out: string[] = [];
    await runArchiveOutboxGc({ retainDays: "30" }, deps(out));
    const result = JSON.parse(out.join(""));
    expect(result.targets).toBe(1);
  });
});
