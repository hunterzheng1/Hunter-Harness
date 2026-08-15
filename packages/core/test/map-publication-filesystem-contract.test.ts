import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  CODEBASE_MAP_PUBLICATION_TARGETS,
  InMemoryMapPublicationTransactionPort,
  MAP_PUBLICATION_FILESYSTEM_SAFETY_POLICY,
  readMapPublicationFilesystemJournal,
  type MapPublicationFilesystemTransactionPort
} from "../src/codebase/map-v2/index.js";

describe("Stage05-M3U-FS map publication contract closure", () => {
  it("reads a bounded current journal with root, staging and recovery identities", async () => {
    const raw = JSON.parse(await readFile(new URL("./fixtures/map-publication-filesystem-v1-current.json",
      import.meta.url), "utf8")) as unknown;
    const result = readMapPublicationFilesystemJournal(raw);
    expect(result).toMatchObject({ ok: true, mode: "current" });
    if (!result.ok || result.mode !== "current") throw new Error("fixture did not parse");
    expect(result.value.root_identity).toMatchObject({
      target_root: ".harness/codebase/map",
      ownership_paths: CODEBASE_MAP_PUBLICATION_TARGETS
    });
    expect(result.value.safety_policy).toEqual(MAP_PUBLICATION_FILESYSTEM_SAFETY_POLICY);
    expect(result.value.staging).toMatchObject({ state: "verified" });
    expect(result.value.recovery.recovery_token).toMatch(/^map_recovery:[a-f0-9]{64}$/u);
    expect(result.value.state).toBe("committed");
    expect(result.value.readback).toBe("verified");
    expect(result.value.cleanup).toBe("completed");
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.root_identity)).toBe(true);
    expect("project_root" in (result.value as object)).toBe(false);
    expect("journal_path" in (result.value as object)).toBe(false);
  });

  it("keeps the existing M3U transaction Port assignable without filesystem fields", () => {
    const port: MapPublicationFilesystemTransactionPort = new InMemoryMapPublicationTransactionPort();
    expect(port).toBeDefined();
  });

  it("rejects path-bearing or weaker safety records before any Adapter can write", async () => {
    const raw = JSON.parse(await readFile(new URL("./fixtures/map-publication-filesystem-v1-current.json",
      import.meta.url), "utf8")) as Record<string, unknown>;
    const withPath = structuredClone(raw);
    (withPath as Record<string, unknown>).project_root = "C:\\outside";
    expect(readMapPublicationFilesystemJournal(withPath)).toEqual({ ok: false,
      reason_code: "MAP_PUBLICATION_FILESYSTEM_JOURNAL_INVALID" });

    const weaker = structuredClone(raw) as { safety_policy: Record<string, unknown> };
    weaker.safety_policy.same_volume = "allow_cross_volume";
    expect(readMapPublicationFilesystemJournal(weaker)).toEqual({ ok: false,
      reason_code: "MAP_PUBLICATION_FILESYSTEM_JOURNAL_INVALID" });

    const malformed = structuredClone(raw) as { root_identity: Record<string, unknown> };
    malformed.root_identity.ownership_paths = [".harness/codebase/map/STACK.md"];
    expect(readMapPublicationFilesystemJournal(malformed)).toEqual({ ok: false,
      reason_code: "MAP_PUBLICATION_FILESYSTEM_JOURNAL_INVALID" });

    const mismatched = structuredClone(raw) as { binding: Record<string, unknown> };
    mismatched.binding.operation_id = "map_operation:other";
    expect(readMapPublicationFilesystemJournal(mismatched)).toEqual({ ok: false,
      reason_code: "MAP_PUBLICATION_FILESYSTEM_JOURNAL_INVALID" });
  });

  it("keeps legacy v0 read-only and rejects unknown versions", async () => {
    const legacy = JSON.parse(await readFile(new URL("./fixtures/map-publication-filesystem-v0-legacy.json",
      import.meta.url), "utf8")) as unknown;
    expect(readMapPublicationFilesystemJournal(legacy)).toEqual({
      ok: true, mode: "legacy_read_only", source_schema_version: 0
    });
    expect(readMapPublicationFilesystemJournal({ schema_version: 0, legacy_ref: "old", project_root: "C:\\outside" }))
      .toEqual({ ok: false, reason_code: "MAP_PUBLICATION_FILESYSTEM_JOURNAL_INVALID" });
    expect(readMapPublicationFilesystemJournal({ schema_version: 9 })).toEqual({ ok: false,
      reason_code: "MAP_PUBLICATION_FILESYSTEM_VERSION_UNSUPPORTED" });
  });

  it("rejects contradictory durable journal transition states", async () => {
    const raw = JSON.parse(await readFile(new URL("./fixtures/map-publication-filesystem-v1-current.json",
      import.meta.url), "utf8")) as Record<string, unknown>;
    const contradictions = [
      { state: "prepared", commit_ambiguity: "resolved_committed", readback: "verified", cleanup: "completed" },
      { state: "applying", commit_ambiguity: "resolved_rolled_back", readback: "failed", cleanup: "completed" },
      { state: "unknown", commit_ambiguity: "resolved_committed", readback: "verified", cleanup: "completed" }
    ] as const;
    for (const contradiction of contradictions) {
      expect(readMapPublicationFilesystemJournal({ ...structuredClone(raw), ...contradiction })).toEqual({
        ok: false,
        reason_code: "MAP_PUBLICATION_FILESYSTEM_JOURNAL_INVALID"
      });
    }
  });

  it("rejects impossible or decreasing durable journal timestamps", async () => {
    const raw = JSON.parse(await readFile(new URL("./fixtures/map-publication-filesystem-v1-current.json",
      import.meta.url), "utf8")) as Record<string, unknown>;
    const impossible = structuredClone(raw);
    impossible.created_at = "2026-02-31T25:61:61.999Z";
    expect(readMapPublicationFilesystemJournal(impossible)).toEqual({
      ok: false,
      reason_code: "MAP_PUBLICATION_FILESYSTEM_JOURNAL_INVALID"
    });

    const decreasing = structuredClone(raw);
    decreasing.created_at = "2026-08-14T00:00:00.001Z";
    decreasing.updated_at = "2026-08-14T00:00:00.000Z";
    expect(readMapPublicationFilesystemJournal(decreasing)).toEqual({
      ok: false,
      reason_code: "MAP_PUBLICATION_FILESYSTEM_JOURNAL_INVALID"
    });
  });

  it("does not execute Proxy traps or accessors while rejecting hostile input", () => {
    let traps = 0;
    let getters = 0;
    const proxy = new Proxy({}, { ownKeys() { traps += 1; return []; } });
    expect(readMapPublicationFilesystemJournal(proxy)).toEqual({ ok: false,
      reason_code: "MAP_PUBLICATION_FILESYSTEM_JOURNAL_INVALID" });
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, "schema_version", { enumerable: true, get() {
      getters += 1;
      return 1;
    } });
    expect(readMapPublicationFilesystemJournal(accessor)).toEqual({ ok: false,
      reason_code: "MAP_PUBLICATION_FILESYSTEM_JOURNAL_INVALID" });
    expect({ traps, getters }).toEqual({ traps: 0, getters: 0 });
  });
});
