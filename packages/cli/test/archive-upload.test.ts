import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Bytes } from "@hunter-harness/core";

import { runCli } from "../src/bin.js";

const resourcesRoot = fileURLToPath(
  new URL("../../workflow-data-harness", import.meta.url)
);

// 注入精简 env 的用例必须带上恢复存储重定向，否则会写进开发者机器的真实
// %LOCALAPPDATA%（tests/setup/global-temp.ts 的重定向只覆盖 process.env）。
const recoveryEnv: Record<string, string> =
  process.env["HUNTER_HARNESS_RECOVERY_ROOT"] === undefined
    ? {}
    : { HUNTER_HARNESS_RECOVERY_ROOT: process.env["HUNTER_HARNESS_RECOVERY_ROOT"] };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("hunter-harness archive upload", () => {
  let root: string;
  let stdout: string[];
  let stderr: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hunter-archive-upload-"));
    stdout = [];
    stderr = [];
    expect(await runCli([
      "--profile", "general", "--non-interactive", "--yes"
    ], {
      cwd: root,
      resourcesRoot,
      stdout: () => undefined,
      stderr: () => undefined,
      env: { ...recoveryEnv }
    })).toBe(0);
    await mkdir(join(root, ".harness", "state", "local", "archive-packages"), {
      recursive: true
    });
    await writeFile(
      join(root, ".harness", "credentials.local.yaml"),
      "server_url: https://platform.example.test\ntoken: archive-token\n",
      "utf8"
    );
  });

  it("resolves the project and sends the package through the dedicated endpoint", async () => {
    const packagePath = join(
      root,
      ".harness",
      "state",
      "local",
      "archive-packages",
      "change-one.zip"
    );
    await writeFile(packagePath, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ path: url.pathname, init });
      if (url.pathname === "/api/v1/projects:resolve") {
        return json({
          schema_version: 1,
          project_id: "prj_archive",
          binding_status: "created",
          project_version: null,
          baseline_manifest: {},
          request_id: "resolve-request"
        });
      }
      if (url.pathname.endsWith("/archive-package")) {
        const requestId = new Headers(init?.headers).get("x-request-id");
        return json({
          schema_version: 1,
          archive_id: "arc_archive",
          project_id: "prj_archive",
          change_key: "change-one",
          package_sha256: sha256Bytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04])),
          manifest_sha256: "sha256:" + "b".repeat(64),
          artifact_id: "art_archive",
          archive_status: "durable",
          knowledge_status: "ready",
          stored_files: 5,
          uploaded_at: "2026-08-08T00:00:00.000Z",
          request_id: requestId
        }, 201);
      }
      return json({ error: { code: "NOT_FOUND", message: "not found" } }, 404);
    });

    const code = await runCli([
      "archive",
      "upload",
      "--file",
      packagePath,
      "--change-key",
      "change-one",
      "--non-interactive",
      "--yes",
      "--json"
    ], {
      cwd: root,
      resourcesRoot,
      fetch: fetch as unknown as typeof globalThis.fetch,
      env: {},
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value)
    });

    expect(code, stderr.join("\n")).toBe(0);
    expect(requests.map((request) => request.path)).toEqual([
      "/api/v1/projects:resolve",
      "/api/v1/projects/prj_archive/changes/change-one/archive-package"
    ]);
    const upload = requests[1]?.init;
    expect(new Headers(upload?.headers).get("Content-Type")).toBe("application/zip");
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      command: "archive upload",
      ok: true,
      project_id: "prj_archive",
      archive_id: "arc_archive",
      knowledge_status: "ready"
    });

    stdout = [];
    stderr = [];
    const mismatchedFetch = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const requestId = new Headers(init?.headers).get("x-request-id");
      if (url.pathname.endsWith("/archive-package")) {
        return json({
          schema_version: 1,
          archive_id: "arc_wrong_project",
          project_id: "prj_other",
          change_key: "change-one",
          package_sha256: sha256Bytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04])),
          manifest_sha256: "sha256:" + "b".repeat(64),
          artifact_id: "art_wrong_project",
          archive_status: "durable",
          knowledge_status: "ready",
          stored_files: 5,
          uploaded_at: "2026-08-08T00:00:00.000Z",
          request_id: requestId
        }, 201);
      }
      return json({ error: { code: "NOT_FOUND", message: "not found" } }, 404);
    });
    const mismatchedCode = await runCli([
      "archive",
      "upload",
      "--file",
      packagePath,
      "--change-key",
      "change-one",
      "--non-interactive",
      "--yes",
      "--json"
    ], {
      cwd: root,
      resourcesRoot,
      fetch: mismatchedFetch as unknown as typeof globalThis.fetch,
      env: {},
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value)
    });
    expect(mismatchedCode).toBe(4);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      ok: false,
      errors: [{ code: "ARCHIVE_RECEIPT_SCOPE_MISMATCH" }]
    });
  });
  it("keeps the server's refusal code instead of a generic upload failure", async () => {
    const packagePath = join(
      root, ".harness", "state", "local", "archive-packages", "change-conflict.zip"
    );
    await writeFile(packagePath, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/projects:resolve") {
        return json({
          schema_version: 1,
          project_id: "prj_archive",
          binding_status: "created",
          project_version: null,
          baseline_manifest: {},
          request_id: "resolve-request"
        });
      }
      if (url.pathname.endsWith("/archive-package")) {
        // One immutable package per change key: a rebuild with different bytes
        // is refused, and that reason must survive to the caller.
        // Verbatim from hunter-platform apps/server/src/archive/package-ingest.ts.
        return json({
          error: {
            code: "ARCHIVE_ALREADY_EXISTS",
            message: "a different package is already stored for this change"
          }
        }, 409);
      }
      return json({ error: { code: "NOT_FOUND", message: "not found" } }, 404);
    });

    const code = await runCli([
      "archive", "upload", "--file", packagePath,
      "--change-key", "change-conflict", "--non-interactive", "--yes", "--json"
    ], {
      cwd: root,
      resourcesRoot,
      fetch: fetch as unknown as typeof globalThis.fetch,
      env: {},
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value)
    });

    expect(code).toBe(1);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      ok: false,
      errors: [{ code: "ARCHIVE_ALREADY_EXISTS", server_status: 409 }]
    });
    expect(stderr.join("")).toContain("不可变归档包");
  });

  it("validates a package read-only through the dedicated validate endpoint", async () => {
    const packagePath = join(
      root, ".harness", "state", "local", "archive-packages", "change-validate.zip"
    );
    await writeFile(packagePath, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    const requests: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requests.push(url.pathname);
      if (url.pathname === "/api/v1/projects:resolve") {
        return json({
          schema_version: 1,
          project_id: "prj_archive",
          binding_status: "created",
          project_version: null,
          baseline_manifest: {},
          request_id: "resolve-request"
        });
      }
      if (url.pathname.endsWith("/archive-package/validate")) {
        return json({
          schema_version: 1,
          ok: true,
          project_id: "prj_archive",
          change_key: "change-validate",
          package_sha256: sha256Bytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04])),
          manifest_sha256: "sha256:" + "c".repeat(64),
          file_count: 3,
          request_id: "validate-request"
        }, 200);
      }
      return json({ error: { code: "NOT_FOUND", message: "not found" } }, 404);
    });

    const code = await runCli([
      "archive", "upload", "--file", packagePath,
      "--change-key", "change-validate", "--validate", "--non-interactive", "--json"
    ], {
      cwd: root,
      resourcesRoot,
      fetch: fetch as unknown as typeof globalThis.fetch,
      env: { ...recoveryEnv },
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value)
    });

    expect(code, stderr.join("\n")).toBe(0);
    // --validate 只打 validate 端点，不碰正式 PUT。
    expect(requests).toEqual([
      "/api/v1/projects:resolve",
      "/api/v1/projects/prj_archive/changes/change-validate/archive-package/validate"
    ]);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      command: "archive upload --validate",
      ok: true,
      project_id: "prj_archive",
      change_key: "change-validate",
      file_count: 3
    });
  });

  it("surfaces field-level issues from a 422 refusal", async () => {
    const packagePath = join(
      root, ".harness", "state", "local", "archive-packages", "change-issues.zip"
    );
    await writeFile(packagePath, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/projects:resolve") {
        return json({
          schema_version: 1,
          project_id: "prj_archive",
          binding_status: "created",
          project_version: null,
          baseline_manifest: {},
          request_id: "resolve-request"
        });
      }
      if (url.pathname.endsWith("/archive-package/validate")) {
        // 服务端 2.3 schema 拒绝缺 run/test 键的 stageStatus，附字段级 issues。
        return json({
          error: {
            code: "ARCHIVE_PACKAGE_INVALID",
            message: "archive summary does not match CLI schema 2.2 or 2.3",
            details: {
              path: "reports/final/summary-data.json",
              issues: [
                { path: "stageStatus.run", code: "invalid_type", message: "Invalid input: expected string, received undefined" },
                { path: "stageStatus.test", code: "invalid_type", message: "Invalid input: expected string, received undefined" }
              ]
            }
          }
        }, 422);
      }
      return json({ error: { code: "NOT_FOUND", message: "not found" } }, 404);
    });

    const code = await runCli([
      "archive", "upload", "--file", packagePath,
      "--change-key", "change-issues", "--validate", "--non-interactive", "--json"
    ], {
      cwd: root,
      resourcesRoot,
      fetch: fetch as unknown as typeof globalThis.fetch,
      env: { ...recoveryEnv },
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value)
    });

    expect(code).toBe(1);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      ok: false,
      errors: [{ code: "ARCHIVE_PACKAGE_INVALID", server_status: 422 }]
    });
    expect(stderr.join("")).toContain("stageStatus.run");
    expect(stderr.join("")).toContain("stageStatus.test");
  });
});
