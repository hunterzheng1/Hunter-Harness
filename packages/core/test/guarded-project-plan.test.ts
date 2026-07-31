import {
  mkdtemp,
  readFile,
  readdir,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  initializeProject,
  refreshProject,
  stateLayout
} from "../src/index.js";

const resourcesRoot = fileURLToPath(
  new URL("../../workflow-data-harness", import.meta.url)
);
const stablePlan = {
  localProjectKey: "0198d976-e3cd-7e79-bf47-737ca6de1367",
  planTimestamp: "2026-07-31T08:00:00.000Z",
  cliVersion: "0.2.44"
} as const;

describe("guarded project plan binding", () => {
  it("binds initialize apply to the exact dry-run plan hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-init-plan-"));
    const preview = await initializeProject({
      projectRoot: root,
      resourcesRoot,
      config: { agents: ["claude-code"], profile: "general" },
      dryRun: true,
      ...stablePlan
    });

    const applied = await initializeProject({
      projectRoot: root,
      resourcesRoot,
      config: { agents: ["claude-code"], profile: "general" },
      dryRun: false,
      expectedPlanHash: preview.planHash,
      ...stablePlan
    });

    expect(preview.planHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(applied.planHash).toBe(preview.planHash);
    expect(applied.recoveryId).toMatch(/^tx_/);
  });

  it("stops initialize with zero managed writes when the preview plan drifted", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-init-plan-drift-"));
    const preview = await initializeProject({
      projectRoot: root,
      resourcesRoot,
      config: { agents: ["claude-code"], profile: "general" },
      dryRun: true,
      ...stablePlan
    });
    await writeFile(join(root, "AGENTS.md"), "operator edit\n");

    await expect(initializeProject({
      projectRoot: root,
      resourcesRoot,
      config: { agents: ["claude-code"], profile: "general" },
      dryRun: false,
      expectedPlanHash: preview.planHash,
      ...stablePlan
    })).rejects.toMatchObject({ code: "PLAN_CHANGED_AFTER_PREVIEW" });
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe("operator edit\n");
  });

  it("does not create a transaction for an idempotent refresh", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-refresh-noop-"));
    await initializeProject({
      projectRoot: root,
      resourcesRoot,
      config: { agents: ["claude-code"], profile: "general" },
      dryRun: false
    });
    const before = await readdir(stateLayout(root).transactions);

    const result = await refreshProject({
      projectRoot: root,
      resourcesRoot,
      profile: "general",
      agents: ["claude-code"],
      dryRun: false,
      forceManaged: false
    });

    expect(result.recovery_id).toBeNull();
    expect(await readdir(stateLayout(root).transactions)).toEqual(before);
  });

  it("rejects refresh apply when managed state changed after preview", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-refresh-plan-drift-"));
    await initializeProject({
      projectRoot: root,
      resourcesRoot,
      config: { agents: ["claude-code"], profile: "general" },
      dryRun: false
    });
    const preview = await refreshProject({
      projectRoot: root,
      resourcesRoot,
      profile: "java",
      agents: ["claude-code"],
      dryRun: true,
      forceManaged: false,
      cliVersion: "0.2.44",
      planTimestamp: "2026-07-31T08:01:00.000Z"
    });
    await writeFile(join(root, "CLAUDE.md"), "operator changed the source view\n");

    await expect(refreshProject({
      projectRoot: root,
      resourcesRoot,
      profile: "java",
      agents: ["claude-code"],
      dryRun: false,
      forceManaged: false,
      cliVersion: "0.2.44",
      planTimestamp: "2026-07-31T08:01:00.000Z",
      expectedPlanHash: preview.plan_hash
    })).rejects.toMatchObject({ code: "PLAN_CHANGED_AFTER_PREVIEW" });
    expect(await readFile(join(root, "CLAUDE.md"), "utf8"))
      .toBe("operator changed the source view\n");
  });
});
