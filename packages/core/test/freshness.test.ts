import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { initializeProject } from "../src/project/initialize.js";
import {
  collectFreshness,
  refreshProject,
  type AgentFreshness
} from "../src/project/refresh.js";
import type { HarnessAgent } from "@hunter-harness/contracts";

const resourcesRoot = fileURLToPath(new URL("../../workflow-data-harness", import.meta.url));

const INSTALLED_STATE_PATH = ".harness/state/local/installed-harness-bundle.json";
const REVIEWER_TARGET = ".claude/agents/harness-reviewer.md";
const REVIEW_SKILL_TARGET = ".claude/skills/harness-review/SKILL.md";

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

async function readInstalledState(root: string): Promise<{
  schema_version: number;
  profile?: string;
  profiles?: Record<string, string>;
  manifests?: Array<Record<string, unknown>>;
  files: Array<Record<string, unknown>>;
}> {
  return JSON.parse(await readFile(join(root, INSTALLED_STATE_PATH), "utf8"));
}

async function writeInstalledState(root: string, value: unknown): Promise<void> {
  await writeFile(join(root, INSTALLED_STATE_PATH), JSON.stringify(value, null, 2) + "\n");
}

function agentOf(report: { agents: AgentFreshness[] }, agent: HarnessAgent): AgentFreshness {
  const found = report.agents.find((entry) => entry.agent === agent);
  expect(found, `freshness entry for ${agent}`).toBeDefined();
  return found as AgentFreshness;
}

describe("Post-adaptation freshness projection (变更簇 D / task 12)", () => {
  it("UT-017: adapted install whose raw build bytes differ is CURRENT", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-fresh-current-"));
    await install(root, ["claude-code"]);

    const report = await collectFreshness({
      projectRoot: root,
      resourcesRoot,
      agents: ["claude-code"]
    });

    const entry = agentOf(report, "claude-code");
    expect(entry.status).toBe("CURRENT");
    expect(entry.driftedFiles).toHaveLength(0);
    expect(entry.missingFiles).toHaveLength(0);
    expect(entry.identity.bundleVersion).toBeTruthy();
    expect(entry.identity.manifestHash).toBeTruthy();
    expect(entry.identity.installedManifestHash).toBe(entry.identity.manifestHash);
    // review fixback #1：coreHash/installedCoreHash 必须填充真实 marker 值。
    expect(entry.identity.coreHash).toBeTruthy();
    expect(entry.identity.installedCoreHash).toBe(entry.identity.coreHash);
    expect(entry.identity.adapterHash).toBeTruthy();
    expect(entry.identity.installedAdapterHash).toBe(entry.identity.adapterHash);
    expect(entry.profile).toBe("general");
  });

  it("COM-003: all four agents from one publication are CURRENT with their own projections", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-fresh-four-"));
    const agents: HarnessAgent[] = ["claude-code", "codex", "cursor", "codebuddy"];
    await install(root, agents);

    const report = await collectFreshness({ projectRoot: root, resourcesRoot, agents });

    for (const agent of agents) {
      const entry = agentOf(report, agent);
      expect(entry.status, `${agent} must be CURRENT`).toBe("CURRENT");
      expect(entry.identity.manifestHash).toBeTruthy();
    }
  }, 120000);

  it("UT-018: a single locally modified managed file yields LOCALLY_MODIFIED listing only that file", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-fresh-modified-"));
    await install(root, ["claude-code"]);
    await writeFile(join(root, REVIEW_SKILL_TARGET), "user edited\n");

    const report = await collectFreshness({
      projectRoot: root,
      resourcesRoot,
      agents: ["claude-code"]
    });

    const entry = agentOf(report, "claude-code");
    expect(entry.status).toBe("LOCALLY_MODIFIED");
    expect(entry.driftedFiles).toEqual([REVIEW_SKILL_TARGET]);
    expect(entry.missingFiles).toHaveLength(0);
    expect(entry.identity.installedAdapterHash).not.toBe(entry.identity.adapterHash);
  });

  it("a missing managed target yields MISSING listing the target", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-fresh-missing-"));
    await install(root, ["claude-code"]);
    await rm(join(root, REVIEWER_TARGET), { force: true });

    const report = await collectFreshness({
      projectRoot: root,
      resourcesRoot,
      agents: ["claude-code"]
    });

    const entry = agentOf(report, "claude-code");
    expect(entry.status).toBe("MISSING");
    expect(entry.missingFiles).toContain(REVIEWER_TARGET);
    expect(entry.driftedFiles).toHaveLength(0);
  });

  it("UT-019: an older installed publication identity yields VERSION_BEHIND", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-fresh-behind-"));
    await install(root, ["claude-code"]);
    const state = await readInstalledState(root);
    for (const manifest of state.manifests ?? []) {
      manifest.bundle_version = "0.0.0-outdated";
      manifest.bundle_manifest_hash = "0".repeat(64);
    }
    await writeInstalledState(root, state);

    const report = await collectFreshness({
      projectRoot: root,
      resourcesRoot,
      agents: ["claude-code"]
    });

    const entry = agentOf(report, "claude-code");
    expect(entry.status).toBe("VERSION_BEHIND");
    expect(entry.identity.installedBundleVersion).toBe("0.0.0-outdated");
    expect(entry.identity.bundleVersion).not.toBe("0.0.0-outdated");
  });

  it("a requested profile differing from the installed profile yields PROFILE_MISMATCH", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-fresh-profile-"));
    await install(root, ["claude-code"], "general");

    const report = await collectFreshness({
      projectRoot: root,
      resourcesRoot,
      agents: ["claude-code"],
      profile: "java"
    });

    expect(agentOf(report, "claude-code").status).toBe("PROFILE_MISMATCH");
  });

  it("insufficient installed identity yields UNVERIFIABLE", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-fresh-unverifiable-"));

    const report = await collectFreshness({
      projectRoot: root,
      resourcesRoot,
      agents: ["claude-code"]
    });

    const entry = agentOf(report, "claude-code");
    expect(entry.status).toBe("UNVERIFIABLE");
    expect(entry.identity.installedManifestHash).toBeNull();
  });

  it("INT-007: a second refresh is a no-op with zero managed diff", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-fresh-idempotent-"));
    await install(root, ["claude-code"]);
    const options = {
      projectRoot: root,
      resourcesRoot,
      profile: "general" as const,
      agents: ["claude-code" as HarnessAgent],
      dryRun: false,
      forceManaged: false
    };
    await refreshProject(options);
    const second = await refreshProject(options);

    expect(second.applied).toHaveLength(0);
    expect(second.removed).toHaveLength(0);
    expect(second.conflicts).toHaveLength(0);
    expect(second.unchanged.length).toBeGreaterThan(0);
    const report = await collectFreshness({
      projectRoot: root,
      resourcesRoot,
      agents: ["claude-code"]
    });
    expect(agentOf(report, "claude-code").status).toBe("CURRENT");
  });

  it("API-005: refresh never touches .gitignore bytes or mtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-fresh-gitignore-"));
    await install(root, ["claude-code"]);
    const gitignore = join(root, ".gitignore");
    await writeFile(gitignore, ".harness/\nnode_modules/\n");
    const before = await stat(gitignore);
    const bytesBefore = await readFile(gitignore);

    await refreshProject({
      projectRoot: root,
      resourcesRoot,
      profile: "general",
      agents: ["claude-code"],
      dryRun: false,
      forceManaged: false
    });

    const after = await stat(gitignore);
    expect(await readFile(gitignore)).toEqual(bytesBefore);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("COM-004: freshness conclusion is identical across .gitignore strategies", async () => {
    const strategies = ["full-ignore", "partial-ignore", "full-track"] as const;
    const statuses: string[] = [];
    for (const strategy of strategies) {
      const root = await mkdtemp(join(tmpdir(), `hunter-fresh-${strategy}-`));
      await install(root, ["claude-code"]);
      const gitignoreContent =
        strategy === "full-ignore"
          ? ".harness/\n"
          : strategy === "partial-ignore"
            ? ".harness/state/\n!.harness/changes/\n"
            : "# everything tracked\n";
      await writeFile(join(root, ".gitignore"), gitignoreContent);

      const report = await collectFreshness({
        projectRoot: root,
        resourcesRoot,
        agents: ["claude-code"]
      });
      statuses.push(agentOf(report, "claude-code").status);
    }
    expect(statuses).toEqual(["CURRENT", "CURRENT", "CURRENT"]);
  });
});
