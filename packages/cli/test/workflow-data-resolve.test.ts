import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  resolveWorkflowResourcesRoot,
  workflowPackageName
} from "../src/workflow-data/resolve.js";

const monorepoDataPackage = fileURLToPath(new URL("../../workflow-data-harness", import.meta.url));

describe("workflow data resolution", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir !== null) await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("maps harness family slug to workflow-harness package name", () => {
    expect(workflowPackageName("harness", {})).toBe("@hunter-harness/workflow-harness");
    expect(workflowPackageName("enterprise", { HUNTER_HARNESS_NPM_SCOPE: "@acme" })).toBe("@acme/workflow-enterprise");
  });

  it("prefers explicit override and env root before sibling packages", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "workflow-data-resolve-"));
    const override = join(tempDir, "override");
    await mkdir(join(override, "harness", "manifests"), { recursive: true });
    expect(await resolveWorkflowResourcesRoot({
      cwd: tempDir,
      env: { HUNTER_HARNESS_RESOURCES_ROOT: join(tempDir, "ignored") },
      override
    })).toBe(override);
  });

  it("resolves monorepo workflow data package when cwd has no sibling workflow package", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "workflow-data-resolve-"));
    const resolved = await resolveWorkflowResourcesRoot({
      cwd: tempDir,
      env: {}
    });
    expect(resolved.replaceAll("\\", "/")).toBe(monorepoDataPackage.replaceAll("\\", "/"));
  });

  it("resolves sibling workflow-harness package from node_modules", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "workflow-data-resolve-"));
    const packageRoot = join(tempDir, "node_modules", "@hunter-harness", "workflow-harness");
    await mkdir(join(packageRoot, "harness", "manifests", "general"), { recursive: true });
    await writeFile(join(packageRoot, "harness", "manifests", "general", "claude-code.json"), "{}\n", "utf8");
    expect(await resolveWorkflowResourcesRoot({ cwd: tempDir, env: {} })).toBe(packageRoot);
  });
});
