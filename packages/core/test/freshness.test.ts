import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { initializeProject } from "../src/project/initialize.js";
import {
  collectFreshness,
  refreshProject,
  type AgentFreshness
} from "../src/project/refresh.js";
import { miniResources } from "./mini-resources.js";
import type { ProjectionSurface } from "../src/project/profile-bundle.js";

// mini bundle（见 mini-resources.ts）：freshness 断言涉及 harness-review /
// harness-explorer 及 manifest/adapter 哈希一致性，与 bundle 文件数无关。
let resourcesRoot: string;

beforeAll(async () => {
  resourcesRoot = await miniResources();
});

const INSTALLED_STATE_PATH = ".harness/state/local/installed-harness-bundle.json";
const REVIEW_SKILL_TARGET = ".agents/skills/harness-review/SKILL.md";
const EXPLORER_SKILL_TARGET = ".agents/skills/harness-explorer/SKILL.md";

// 种子安装：固定投影只真实部署一次整套 bundle，后续用例用目录拷贝复用。
// 单用例从 ~30s（initializeProject 全量投影+哈希）降到秒级拷贝。
let installSeed: string | undefined;

async function install(root: string): Promise<void> {
  if (installSeed === undefined) {
    installSeed = await mkdtemp(join(tmpdir(), "hunter-fresh-seed-"));
    await initializeProject({
      projectRoot: installSeed,
      resourcesRoot,
      config: {},
      dryRun: false
    });
  }
  await rm(root, { recursive: true, force: true });
  await cp(installSeed, root, { recursive: true });
}

async function readInstalledState(root: string): Promise<{
  schema_version: number;
  manifests?: Array<Record<string, unknown>>;
  files: Array<Record<string, unknown>>;
}> {
  return JSON.parse(await readFile(join(root, INSTALLED_STATE_PATH), "utf8"));
}

async function writeInstalledState(root: string, value: unknown): Promise<void> {
  await writeFile(join(root, INSTALLED_STATE_PATH), JSON.stringify(value, null, 2) + "\n");
}

function surfaceOf(
  report: { agents: AgentFreshness[] },
  surface: ProjectionSurface
): AgentFreshness {
  const found = report.agents.find((entry) => entry.agent === surface);
  expect(found, `freshness entry for ${surface}`).toBeDefined();
  return found as AgentFreshness;
}

describe("Post-install freshness projection (fixed dual surface)", () => {
  it("UT-017: a clean install is CURRENT on both surfaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-fresh-current-"));
    await install(root);

    const report = await collectFreshness({ projectRoot: root, resourcesRoot });

    for (const surface of ["codex", "codebuddy"] as const) {
      const entry = surfaceOf(report, surface);
      expect(entry.status, `${surface} must be CURRENT`).toBe("CURRENT");
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
    }
  });

  it("UT-018: a single locally modified managed file yields LOCALLY_MODIFIED listing only that file", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-fresh-modified-"));
    await install(root);
    await writeFile(join(root, REVIEW_SKILL_TARGET), "user edited\n");

    const report = await collectFreshness({ projectRoot: root, resourcesRoot });

    const entry = surfaceOf(report, "codex");
    expect(entry.status).toBe("LOCALLY_MODIFIED");
    expect(entry.driftedFiles).toEqual([REVIEW_SKILL_TARGET]);
    expect(entry.missingFiles).toHaveLength(0);
    expect(entry.identity.installedAdapterHash).not.toBe(entry.identity.adapterHash);
    // 另一投影面不受影响。
    expect(surfaceOf(report, "codebuddy").status).toBe("CURRENT");
  });

  it("a missing managed target yields MISSING listing the target", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-fresh-missing-"));
    await install(root);
    await rm(join(root, EXPLORER_SKILL_TARGET), { force: true });

    const report = await collectFreshness({ projectRoot: root, resourcesRoot });

    const entry = surfaceOf(report, "codex");
    expect(entry.status).toBe("MISSING");
    expect(entry.missingFiles).toContain(EXPLORER_SKILL_TARGET);
    expect(entry.driftedFiles).toHaveLength(0);
  });

  it("UT-019: an older installed publication identity yields VERSION_BEHIND", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-fresh-behind-"));
    await install(root);
    const state = await readInstalledState(root);
    for (const manifest of state.manifests ?? []) {
      manifest.bundle_version = "0.0.0-outdated";
      manifest.bundle_manifest_hash = "0".repeat(64);
    }
    await writeInstalledState(root, state);

    const report = await collectFreshness({ projectRoot: root, resourcesRoot });

    for (const surface of ["codex", "codebuddy"] as const) {
      const entry = surfaceOf(report, surface);
      expect(entry.status, `${surface} must be VERSION_BEHIND`).toBe("VERSION_BEHIND");
      expect(entry.identity.installedBundleVersion).toBe("0.0.0-outdated");
      expect(entry.identity.bundleVersion).not.toBe("0.0.0-outdated");
    }
  });

  it("insufficient installed identity yields UNVERIFIABLE", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-fresh-unverifiable-"));

    const report = await collectFreshness({ projectRoot: root, resourcesRoot });

    for (const surface of ["codex", "codebuddy"] as const) {
      const entry = surfaceOf(report, surface);
      expect(entry.status, `${surface} must be UNVERIFIABLE`).toBe("UNVERIFIABLE");
      expect(entry.identity.installedManifestHash).toBeNull();
    }
  });

  it("INT-007: a second refresh is a no-op with zero managed diff", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-fresh-idempotent-"));
    await install(root);
    const options = {
      projectRoot: root,
      resourcesRoot,
      dryRun: false,
      forceManaged: false
    };
    await refreshProject(options);
    const second = await refreshProject(options);

    expect(second.applied).toHaveLength(0);
    expect(second.removed).toHaveLength(0);
    expect(second.conflicts).toHaveLength(0);
    expect(second.unchanged.length).toBeGreaterThan(0);
    const report = await collectFreshness({ projectRoot: root, resourcesRoot });
    expect(surfaceOf(report, "codex").status).toBe("CURRENT");
  });

  it("API-005: refresh never touches .gitignore bytes or mtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-fresh-gitignore-"));
    await install(root);
    const gitignore = join(root, ".gitignore");
    await writeFile(gitignore, ".harness/\nnode_modules/\n");
    const before = await stat(gitignore);
    const bytesBefore = await readFile(gitignore);

    await refreshProject({
      projectRoot: root,
      resourcesRoot,
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
      await install(root);
      const gitignoreContent =
        strategy === "full-ignore"
          ? ".harness/\n"
          : strategy === "partial-ignore"
            ? ".harness/state/\n!.harness/changes/\n"
            : "# everything tracked\n";
      await writeFile(join(root, ".gitignore"), gitignoreContent);

      const report = await collectFreshness({ projectRoot: root, resourcesRoot });
      statuses.push(surfaceOf(report, "codex").status);
    }
    expect(statuses).toEqual(["CURRENT", "CURRENT", "CURRENT"]);
  });
});
