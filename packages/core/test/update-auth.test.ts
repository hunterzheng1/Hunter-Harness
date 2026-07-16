import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "@hunter-harness/contracts";

import { initializeProject } from "../src/project/initialize.js";
import { UpdateWorkflowError, updateProject } from "../src/update/update.js";
import { writeLocalCredentials } from "../src/push/credentials.js";

const resourcesRoot = fileURLToPath(new URL("../../workflow-data-harness", import.meta.url));

describe("updateProject auth credentials.local fallback", () => {
  async function initBoundRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "hh-update-auth-"));
    await initializeProject({
      projectRoot: root,
      resourcesRoot,
      config: { agents: ["claude-code"], profile: "general" },
      dryRun: false
    });
    const projectPath = join(root, ".harness", "project.yaml");
    const project = parseYaml(await readFile(projectPath, "utf8")) as ProjectConfig;
    const next: ProjectConfig = {
      ...project,
      project: { ...project.project, project_id: "prj_update_auth" },
      server: {
        url: "https://server.example.test",
        token_env: "TEST_HUNTER_TOKEN"
      }
    };
    await writeFile(projectPath, stringifyYaml(next, { sortMapEntries: true }));
    return root;
  }

  function noDeltaFetch(expectedToken: string) {
    return vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers;
      const auth = headers instanceof Headers
        ? headers.get("authorization")
        : typeof headers === "object" && headers !== null
          ? (headers as Record<string, string>)["Authorization"] ??
            (headers as Record<string, string>)["authorization"]
          : null;
      expect(auth).toBe(`Bearer ${expectedToken}`);
      const url = new URL(
        typeof _input === "string" ? _input : _input instanceof URL ? _input.toString() : _input.url
      );
      if (url.pathname.endsWith("/update-manifest")) {
        return new Response(JSON.stringify({
          schema_version: 1,
          project_id: "prj_update_auth",
          observed_project_version: null,
          artifact_id: null,
          artifact_manifest_url: null,
          delta_available: false,
          request_id: "req"
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      throw new Error("unexpected URL " + url);
    });
  }

  it("prefers env token over credentials.local (UT-101)", async () => {
    const root = await initBoundRoot();
    await writeLocalCredentials(root, {
      token: "local-token",
      server_url: "https://local.example.test"
    });
    const fetch = noDeltaFetch("env-token");
    const result = await updateProject({
      projectRoot: root,
      env: { TEST_HUNTER_TOKEN: "env-token" },
      dryRun: false,
      fetch
    });
    expect(result.artifactId).toBeNull();
    expect(fetch).toHaveBeenCalled();
  });

  it("falls back to credentials.local when env token is unset (UT-102)", async () => {
    const root = await initBoundRoot();
    await writeLocalCredentials(root, {
      token: "local-token",
      server_url: "https://local.example.test"
    });
    const fetch = noDeltaFetch("local-token");
    const result = await updateProject({
      projectRoot: root,
      env: {},
      dryRun: false,
      fetch
    });
    expect(result.artifactId).toBeNull();
    expect(fetch).toHaveBeenCalled();
  });

  it("throws TOKEN_INVALID with guidance when no token is available (UT-103)", async () => {
    const root = await initBoundRoot();
    await expect(updateProject({
      projectRoot: root,
      env: {},
      dryRun: false
    })).rejects.toMatchObject({
      code: "TOKEN_INVALID",
      exitCode: 8,
      message: expect.stringContaining("credentials.local")
    });
  });

  it("falls back to local server_url when project server url is null (UT-104)", async () => {
    const root = await initBoundRoot();
    const projectPath = join(root, ".harness", "project.yaml");
    const project = parseYaml(await readFile(projectPath, "utf8")) as ProjectConfig;
    await writeFile(projectPath, stringifyYaml({
      ...project,
      server: { url: null, token_env: "TEST_HUNTER_TOKEN" }
    }, { sortMapEntries: true }));
    await writeLocalCredentials(root, {
      token: "local-token",
      server_url: "https://local.example.test"
    });
    const fetch = noDeltaFetch("local-token");
    await updateProject({
      projectRoot: root,
      env: {},
      dryRun: false,
      fetch
    });
    expect(fetch).toHaveBeenCalled();
  });

  it("falls back to local token when env token is whitespace (UT-105)", async () => {
    const root = await initBoundRoot();
    await writeLocalCredentials(root, {
      token: "local-token",
      server_url: "https://local.example.test"
    });
    const fetch = noDeltaFetch("local-token");
    await updateProject({
      projectRoot: root,
      env: { TEST_HUNTER_TOKEN: "   " },
      dryRun: false,
      fetch
    });
    expect(fetch).toHaveBeenCalled();
  });

  it("still rejects invalid token_env names (UT-106)", async () => {
    const root = await initBoundRoot();
    await expect(updateProject({
      projectRoot: root,
      tokenEnv: "bad-name",
      env: { "bad-name": "token" },
      dryRun: false
    })).rejects.toBeInstanceOf(UpdateWorkflowError);
    await expect(updateProject({
      projectRoot: root,
      tokenEnv: "bad-name",
      env: { "bad-name": "token" },
      dryRun: false
    })).rejects.toMatchObject({ code: "TOKEN_ENV_INVALID", exitCode: 3 });
  });
});
