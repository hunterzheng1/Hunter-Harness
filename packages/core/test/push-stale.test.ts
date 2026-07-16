import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "@hunter-harness/contracts";

import { initializeProject } from "../src/project/initialize.js";
import { pushProject, PushWorkflowError } from "../src/push/push.js";
import { readBaseline, writeBaseline } from "../src/state/baseline.js";

const resourcesRoot = fileURLToPath(new URL("../../workflow-data-harness", import.meta.url));

describe("pushProject stale baseline UX", () => {
  async function initRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "hh-push-stale-"));
    await initializeProject({
      projectRoot: root,
      resourcesRoot,
      config: { agents: ["claude-code"], profile: "general" },
      dryRun: false
    });
    return root;
  }

  async function bindProject(
    root: string,
    projectId: string,
    completeProjectVersion: string | null
  ): Promise<void> {
    const projectPath = join(root, ".harness", "project.yaml");
    const project = parseYaml(await readFile(projectPath, "utf8")) as ProjectConfig;
    const next: ProjectConfig = {
      ...project,
      project: { ...project.project, project_id: projectId },
      server: { ...project.server, url: "https://stale.example.test" }
    };
    await writeFile(projectPath, stringifyYaml(next, { sortMapEntries: true }));
    const baseline = await readBaseline(root);
    await writeBaseline(root, {
      ...baseline,
      project_id: projectId,
      complete_project_version: completeProjectVersion
    });
    await writeFile(
      join(root, ".harness", "credentials.local.yaml"),
      "token: stale-token\nserver_url: https://stale.example.test\n"
    );
  }

  function projectGetResponse(
    projectId: string,
    latestProjectVersion: string | null
  ): Response {
    return new Response(JSON.stringify({
      schema_version: 1,
      project_id: projectId,
      display_name: "stale",
      role: "owner",
      latest_project_version: latestProjectVersion,
      latest_artifact_id: latestProjectVersion === null ? null : "art_00000001",
      lifecycle_state: "active",
      current_files_version: latestProjectVersion,
      current_file_count: 0,
      updated_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      request_id: "req_get"
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }

  function apiErrorResponse(status: number, code: string, message: string): Response {
    return new Response(JSON.stringify({
      error: {
        code,
        message,
        request_id: "req_err",
        details: {}
      }
    }), {
      status,
      headers: { "content-type": "application/json" }
    });
  }

  function noDeltaUpdateManifest(projectId: string, observed: string | null): Response {
    return new Response(JSON.stringify({
      schema_version: 1,
      project_id: projectId,
      observed_project_version: observed,
      artifact_id: null,
      artifact_manifest_url: null,
      delta_available: false,
      request_id: "req_update"
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }

  it("API-006 stale guidance must not mention unconditional git pull", async () => {
    const root = await initRoot();
    const projectId = "prj_no_git_pull";
    await bindProject(root, projectId, "pv_00000001");
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/api/v1/projects/" + projectId) {
        return projectGetResponse(projectId, "pv_00000002");
      }
      if (url.pathname.endsWith("/update-manifest")) {
        return noDeltaUpdateManifest(projectId, "pv_00000002");
      }
      throw new Error("unexpected path: " + url.pathname);
    });
    const error = await pushProject({
      projectRoot: root,
      resourcesRoot,
      env: {},
      dryRun: false,
      fetch
    }).then(
      () => null,
      (value: unknown) => value
    );
    expect(error).toBeInstanceOf(PushWorkflowError);
    expect(String((error as PushWorkflowError).message)).not.toMatch(/git pull/i);
    expect(String((error as PushWorkflowError).message)).toMatch(/update/i);
  });

  it("UT-001 passes precheck when local and server versions match", async () => {
    const root = await initRoot();
    const projectId = "prj_stale_match";
    await bindProject(root, projectId, null);
    const paths: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      paths.push(url.pathname);
      if (url.pathname === "/api/v1/projects/" + projectId) {
        return projectGetResponse(projectId, null);
      }
      throw new Error("unexpected path: " + url.pathname);
    });
    const result = await pushProject({
      projectRoot: root,
      resourcesRoot,
      env: {},
      dryRun: false,
      fetch,
      confirmProposal: async () => false
    });
    expect(paths[0]).toBe("/api/v1/projects/" + projectId);
    expect(result).toMatchObject({ cancelled: true });
  });

  it("UT-002 fails before confirm callbacks when local baseline is behind server", async () => {
    const root = await initRoot();
    const projectId = "prj_stale_behind";
    await bindProject(root, projectId, null);
    await writeFile(
      join(root, ".claude", "rules", "unsafe.md"),
      "Authorization: Bearer blocked-secret-token-1234567890\n"
    );
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/api/v1/projects/" + projectId) {
        return projectGetResponse(projectId, "pv_00000001");
      }
      if (url.pathname.endsWith("/update-manifest")) {
        return noDeltaUpdateManifest(projectId, "pv_00000001");
      }
      throw new Error("unexpected path after stale precheck: " + url.pathname);
    });
    await expect(pushProject({
      projectRoot: root,
      resourcesRoot,
      env: {},
      dryRun: false,
      fetch,
      confirmSensitiveScanSkip: async () => {
        throw new Error("confirmSensitiveScanSkip must not run after stale precheck");
      },
      confirmProposal: async () => {
        throw new Error("confirmProposal must not run after stale precheck");
      }
    })).rejects.toMatchObject({
      name: "PushWorkflowError",
      code: "PROJECT_VERSION_CONFLICT",
      exitCode: 5,
      message: expect.stringMatching(/update/i)
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("UT-003 fails when local pv lags a newer server pv", async () => {
    const root = await initRoot();
    const projectId = "prj_stale_pv_lag";
    await bindProject(root, projectId, "pv_00000001");
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/api/v1/projects/" + projectId) {
        return projectGetResponse(projectId, "pv_00000002");
      }
      if (url.pathname.endsWith("/update-manifest")) {
        return noDeltaUpdateManifest(projectId, "pv_00000002");
      }
      throw new Error("unexpected path: " + url.pathname);
    });
    await expect(pushProject({
      projectRoot: root,
      resourcesRoot,
      env: {},
      dryRun: false,
      fetch,
      confirmProposal: async () => {
        throw new Error("confirmProposal must not run");
      }
    })).rejects.toMatchObject({
      code: "PROJECT_VERSION_CONFLICT",
      exitCode: 5
    });
  });

  it("UT-004 maps session PROJECT_VERSION_CONFLICT to friendly update guidance", async () => {
    const root = await initRoot();
    const projectId = "prj_stale_session";
    await bindProject(root, projectId, "pv_00000001");
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.pathname === "/api/v1/projects/" + projectId) {
        return projectGetResponse(projectId, "pv_00000001");
      }
      if (method === "POST" && url.pathname ===
          "/api/v1/projects/" + projectId + "/proposal-sessions") {
        return apiErrorResponse(
          409,
          "PROJECT_VERSION_CONFLICT",
          "base project version is stale"
        );
      }
      throw new Error("unexpected path: " + method + " " + url.pathname);
    });
    await expect(pushProject({
      projectRoot: root,
      resourcesRoot,
      env: {},
      dryRun: false,
      fetch
    })).rejects.toMatchObject({
      code: "PROJECT_VERSION_CONFLICT",
      exitCode: 5,
      message: expect.stringMatching(/hunter-harness update/)
    });
  });

  it("UT-005 maps finalize STALE_PUSH to friendly update guidance", async () => {
    const root = await initRoot();
    const projectId = "prj_stale_finalize";
    await bindProject(root, projectId, "pv_00000001");
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.pathname === "/api/v1/projects/" + projectId) {
        return projectGetResponse(projectId, "pv_00000001");
      }
      if (method === "POST" && url.pathname ===
          "/api/v1/projects/" + projectId + "/proposal-sessions") {
        return new Response(JSON.stringify({
          session_id: "ups_test",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          missing_blobs: [],
          max_chunk_bytes: 1024,
          request_id: "req_session"
        }), {
          status: 201,
          headers: { "content-type": "application/json" }
        });
      }
      if (method === "POST" && url.pathname.endsWith("/blobs:query")) {
        return new Response(JSON.stringify({
          present: [],
          missing: [],
          request_id: "req_query"
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (method === "GET" && url.pathname.endsWith("/update-manifest")) {
        return noDeltaUpdateManifest(projectId, "pv_00000001");
      }
      if (method === "POST" && url.pathname.endsWith(":finalize")) {
        return apiErrorResponse(409, "STALE_PUSH", "base artifact is stale");
      }
      throw new Error("unexpected path: " + method + " " + url.pathname);
    });
    await expect(pushProject({
      projectRoot: root,
      resourcesRoot,
      env: {},
      dryRun: false,
      fetch
    })).rejects.toMatchObject({
      code: "STALE_PUSH",
      exitCode: 5,
      message: expect.stringMatching(/hunter-harness update/)
    });
  });

  it("UT-006 dryRun does not call getProject even when local baseline is behind", async () => {
    const root = await initRoot();
    const projectId = "prj_stale_dry";
    await bindProject(root, projectId, null);
    const fetch = vi.fn(async () => {
      throw new Error("dryRun must not call fetch");
    });
    const result = await pushProject({
      projectRoot: root,
      resourcesRoot,
      env: {},
      dryRun: true,
      fetch,
      sensitiveScanSkip: true
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(result.proposalId).toBeNull();
  });

  it("UT-007 unbound project skips version precheck", async () => {
    const root = await initRoot();
    await writeFile(
      join(root, ".harness", "credentials.local.yaml"),
      "token: stale-token\nserver_url: https://stale.example.test\n"
    );
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && url.pathname === "/api/v1/projects:resolve") {
        return new Response(JSON.stringify({
          schema_version: 1,
          project_id: "prj_new_bind",
          binding_status: "created",
          project_version: null,
          baseline_manifest: {
            schema_version: 1,
            project_id: "prj_new_bind",
            complete_project_version: null,
            artifact_manifest_hash: null,
            files: {}
          },
          request_id: "req_resolve"
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (method === "GET" && url.pathname === "/api/v1/projects/prj_new_bind") {
        throw new Error("unbound first push must not precheck before resolve");
      }
      if (method === "POST" && url.pathname ===
          "/api/v1/projects/prj_new_bind/proposal-sessions") {
        return apiErrorResponse(
          409,
          "PROJECT_VERSION_CONFLICT",
          "base project version is stale"
        );
      }
      throw new Error("unexpected path: " + method + " " + url.pathname);
    });
    const error = await pushProject({
      projectRoot: root,
      resourcesRoot,
      env: {},
      dryRun: false,
      fetch
    }).then(
      () => null,
      (value: unknown) => value
    );
    expect(error).toBeInstanceOf(PushWorkflowError);
    expect(error).toMatchObject({
      code: "PROJECT_VERSION_CONFLICT",
      exitCode: 5,
      message: expect.stringMatching(/update/i)
    });
    const paths = fetch.mock.calls.map((call) => {
      const input = call[0] as string | URL | Request;
      return new URL(input instanceof Request ? input.url : String(input)).pathname;
    });
    expect(paths[0]).toBe("/api/v1/projects:resolve");
    expect(paths).not.toContain("/api/v1/projects/prj_new_bind");
  });
});
