import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  describeWorkflowDataFetchFailure,
  latestWorkflowCacheIsStale,
  readCachedNpmPackageVersion,
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

  it("describes pacote missing, network, and 404 failures with real causes", () => {
    const missing = describeWorkflowDataFetchFailure(
      Object.assign(new Error("Cannot find package 'pacote'"), { code: "ERR_MODULE_NOT_FOUND" }),
      "@hunter-harness/workflow-harness"
    );
    expect(missing).toContain("pacote");
    expect(missing).not.toContain("无网络且本地缓存不存在");

    const network = describeWorkflowDataFetchFailure(
      Object.assign(new Error("Client network socket disconnected before secure TLS connection was established"), {
        code: "ECONNRESET"
      }),
      "@hunter-harness/workflow-harness"
    );
    expect(network).toContain("下载失败");
    expect(network).toContain("ECONNRESET");
    expect(network).toContain("ipv4first");
    expect(network).not.toContain("无网络且本地缓存不存在");

    const notFound = describeWorkflowDataFetchFailure(
      Object.assign(new Error("404 Not Found - GET https://registry.npmjs.org/@hunter-harness%2fworkflow-harness"), {
        code: "E404"
      }),
      "@hunter-harness/workflow-harness"
    );
    expect(notFound).toContain("找不到该包");
    expect(notFound).not.toContain("无网络且本地缓存不存在");
  });

  it("readCachedNpmPackageVersion reads package.json version from cache root", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "workflow-data-resolve-"));
    const cacheRoot = join(tempDir, "cache");
    await mkdir(join(cacheRoot, "harness", "manifests"), { recursive: true });
    await writeFile(join(cacheRoot, "package.json"), JSON.stringify({ version: "0.2.0" }) + "\n", "utf8");
    expect(await readCachedNpmPackageVersion(cacheRoot)).toBe("0.2.0");
  });

  it("latestWorkflowCacheIsStale returns true when npm latest version differs from cache", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "workflow-data-resolve-"));
    const cacheRoot = join(tempDir, "cache");
    await mkdir(join(cacheRoot, "harness", "manifests"), { recursive: true });
    await writeFile(join(cacheRoot, "package.json"), JSON.stringify({ version: "0.2.0" }) + "\n", "utf8");
    const stale = await latestWorkflowCacheIsStale(
      cacheRoot,
      "@hunter-harness/workflow-harness",
      async () => ({ version: "0.2.1" })
    );
    expect(stale).toBe(true);
  });

  it("latestWorkflowCacheIsStale returns false when versions match", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "workflow-data-resolve-"));
    const cacheRoot = join(tempDir, "cache");
    await mkdir(join(cacheRoot, "harness", "manifests"), { recursive: true });
    await writeFile(join(cacheRoot, "package.json"), JSON.stringify({ version: "0.2.1" }) + "\n", "utf8");
    const stale = await latestWorkflowCacheIsStale(
      cacheRoot,
      "@hunter-harness/workflow-harness",
      async () => ({ version: "0.2.1" })
    );
    expect(stale).toBe(false);
  });

  it("latestWorkflowCacheIsStale keeps cache when npm manifest lookup fails", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "workflow-data-resolve-"));
    const cacheRoot = join(tempDir, "cache");
    await mkdir(join(cacheRoot, "harness", "manifests"), { recursive: true });
    await writeFile(join(cacheRoot, "package.json"), JSON.stringify({ version: "0.2.0" }) + "\n", "utf8");
    const stale = await latestWorkflowCacheIsStale(
      cacheRoot,
      "@hunter-harness/workflow-harness",
      async () => {
        throw new Error("offline");
      }
    );
    expect(stale).toBe(false);
  });
});
