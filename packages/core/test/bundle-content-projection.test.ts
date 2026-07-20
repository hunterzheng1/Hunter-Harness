import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { initializeProject } from "../src/project/initialize.js";
import { collectFreshness, refreshProject } from "../src/project/refresh.js";
import type { HarnessAgent } from "@hunter-harness/contracts";

const resourcesRoot = fileURLToPath(
  new URL("../../workflow-data-harness", import.meta.url)
);

const CONTEXT_INDEX_PATH = ".harness/context-index.json";
const REVIEW_SKILL_TARGET = ".claude/skills/harness-review/SKILL.md";

interface BundleEntry {
  registry_version: string;
  bundle_hash: string;
  installedContentHash: string;
  verificationStatus: string;
  verifiedAt: string;
  mismatchDetails: Array<{ relpath: string; expected: string; actual: string }>;
}

interface ContextIndex {
  skill_bundles: Record<string, BundleEntry>;
}

async function install(
  root: string,
  agents: HarnessAgent[],
  profile: "general" | "java" = "general"
): Promise<void> {
  await initializeProject({
    projectRoot: root,
    resourcesRoot,
    config: { agents, profile },
    dryRun: false
  });
}

async function readContextIndex(root: string): Promise<ContextIndex> {
  return JSON.parse(await readFile(join(root, CONTEXT_INDEX_PATH), "utf8")) as ContextIndex;
}

describe("bundle content projection (retro §5.1/5.25, C1/T3)", () => {
  it("freshness identity exposes installedContentHash and verificationStatus=verified on a clean install", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-content-clean-"));
    try {
      await install(root, ["claude-code"]);

      const report = await collectFreshness({
        projectRoot: root,
        resourcesRoot,
        agents: ["claude-code"]
      });

      const entry = report.agents[0];
      expect(entry).toBeDefined();
      if (!entry) return;
      expect(entry.identity.installedContentHash).toBeTruthy();
      expect(entry.identity.installedContentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.identity.verificationStatus).toBe("verified");
      expect(entry.identity.mismatchDetails).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("freshness identity reports verificationStatus=degraded and mismatchDetails when an installed trusted-root script drifts", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-content-drift-"));
    try {
      await install(root, ["claude-code"]);
      // Tamper with a managed skill file: registry_version still matches but
      // the per-file content no longer matches the installed manifest.
      await writeFile(join(root, REVIEW_SKILL_TARGET), "tampered content\n");

      const report = await collectFreshness({
        projectRoot: root,
        resourcesRoot,
        agents: ["claude-code"]
      });

      const entry = report.agents[0];
      expect(entry).toBeDefined();
      if (!entry) return;
      // Drift in a managed file is still LOCALLY_MODIFIED, but the new
      // verification fields must surface the per-file mismatch rather than
      // only the aggregate adapter hash.
      expect(entry.identity.verificationStatus).toBe("degraded");
      expect(entry.identity.mismatchDetails.length).toBeGreaterThan(0);
      const drifted = entry.identity.mismatchDetails.find(
        (m) => m.relpath.endsWith("harness-review/SKILL.md")
      );
      expect(drifted, "drifted file must appear in mismatchDetails").toBeDefined();
      if (!drifted) return;
      expect(drifted.expected).toMatch(/^[0-9a-f]{64}$/);
      expect(drifted.actual).toMatch(/^[0-9a-f]{64}$/);
      expect(drifted.expected).not.toBe(drifted.actual);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("context-index skill_bundles entry projects installedContentHash/verifiedAt/verificationStatus", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-content-index-"));
    try {
      await install(root, ["claude-code"]);

      const index = await readContextIndex(root);
      const entry = index.skill_bundles["claude-code"];
      expect(entry, "claude-code bundle entry must exist").toBeDefined();
      if (!entry) return;
      expect(entry.registry_version).toBeTruthy();
      expect(entry.bundle_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(entry.installedContentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.verificationStatus).toBe("verified");
      expect(entry.verifiedAt).toBeTruthy();
      expect(Array.isArray(entry.mismatchDetails)).toBe(true);
      expect(entry.mismatchDetails).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("context-index reflects verificationStatus=degraded after a file drifts", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-content-index-drift-"));
    try {
      await install(root, ["claude-code"]);
      await writeFile(join(root, REVIEW_SKILL_TARGET), "tampered content\n");

      // Re-run refresh so context-index is regenerated with the drift visible.
      await refreshProject({
        projectRoot: root,
        resourcesRoot,
        profile: "general",
        agents: ["claude-code"],
        dryRun: false,
        forceManaged: false
      });

      const index = await readContextIndex(root);
      const entry = index.skill_bundles["claude-code"];
      expect(entry).toBeDefined();
      if (!entry) return;
      expect(entry.verificationStatus).toBe("degraded");
      expect(entry.mismatchDetails.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
