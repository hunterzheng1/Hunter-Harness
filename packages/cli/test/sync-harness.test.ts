import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { atomicSwapDir } from "../../../scripts/sync-harness.mjs";

// INT-005 (design §3.8 要点1): when a sync is interrupted mid-swap — staging
// build fails, support-file/manifest validation fails, or the staging→release
// rename itself fails — the release tree must stay whole: either the old
// version or the fully-validated new version, never half-written. These tests
// lock the atomicSwapDir contract that underpins that guarantee (the
// per-bundle staging→release swap). The cmd_build internal staging swap is
// covered separately by test_failed_build_preserves_previous_output; this is
// the sync-level (Node) layer.

async function makeDirWithMarker(parent: string, name: string, marker: string): Promise<string> {
  const dir = join(parent, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "marker.txt"), marker, "utf8");
  return dir;
}

async function leftoverSwapBackups(parent: string): Promise<string[]> {
  const entries = await readdir(parent, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.includes(".swap-old-"))
    .map((entry) => entry.name);
}

describe("sync-harness atomicSwapDir — INT-005", () => {
  it("keeps workflow-family and generated bundle versions aligned", async () => {
    const family = JSON.parse(
      await readFile(
        join(process.cwd(), "packages", "workflow-data-harness", "hunter-workflow-family.json"),
        "utf8"
      )
    ) as { bundle_version: string };
    const bundle = JSON.parse(
      await readFile(
        join(
          process.cwd(),
          "packages",
          "workflow-data-harness",
          "harness",
          "manifests",
          "general",
          "codex.json"
        ),
        "utf8"
      )
    ) as { bundle_version: string };

    expect(family.bundle_version).toBe(bundle.bundle_version);
  });

  it("swaps validated staging into the release target on success", async () => {
    const root = await mkdtemp(join(tmpdir(), "sync-atomic-"));
    try {
      const target = await makeDirWithMarker(root, "out", "OLD");
      const stage = await makeDirWithMarker(root, "stage", "NEW");
      await atomicSwapDir(stage, target);
      expect(await readFile(join(target, "marker.txt"), "utf8")).toBe("NEW");
      // staging renamed into place + old backup removed: no leftover artifacts
      expect(await leftoverSwapBackups(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves the release target when the swap fails — no half-written tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "sync-atomic-"));
    try {
      const target = await makeDirWithMarker(root, "out", "OLD");
      // staging does not exist → rename(stage, target) rejects mid-swap
      const missingStage = join(root, "does-not-exist");
      await expect(atomicSwapDir(missingStage, target)).rejects.toThrow();
      // release tree restored from backup, original content intact
      expect(await readFile(join(target, "marker.txt"), "utf8")).toBe("OLD");
      // backup moved back into target — no leftover .swap-old-* artifact
      expect(await leftoverSwapBackups(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates the release target from staging when no prior target exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "sync-atomic-"));
    try {
      const stage = await makeDirWithMarker(root, "stage", "NEW");
      const target = join(root, "out");
      await atomicSwapDir(stage, target);
      expect(await readFile(join(target, "marker.txt"), "utf8")).toBe("NEW");
      expect(await leftoverSwapBackups(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
