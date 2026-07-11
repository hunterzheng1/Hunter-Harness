import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/bin.js";

const resourcesRoot = fileURLToPath(
  new URL("../../../resources", import.meta.url)
);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("hunter-harness push", () => {
  let root: string;
  let stdout: string[];
  let stderr: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hunter-push-"));
    stdout = [];
    stderr = [];
    expect(await runCli([
      "--profile", "java",
      "--server-url", "https://server.example.test",
      "--token-env", "TEST_HUNTER_TOKEN", "--non-interactive", "--yes"
    ], {
      cwd: root,
      resourcesRoot,
      stdout: () => undefined,
      stderr: () => undefined,
      env: {}
    })).toBe(0);
  });

  async function exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  it("previews without network or writes in dry-run mode", async () => {
    const fetch = vi.fn();
    const baselineBefore = await readFile(
      join(root, ".harness", "state", "baseline", "manifest.json"), "utf8"
    );
    const code = await runCli(["push", "--dry-run", "--json", "--non-interactive"], {
      cwd: root,
      resourcesRoot,
      fetch,
      env: {},
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value)
    });
    expect(code).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.join(""))).toMatchObject({ command: "push", dry_run: true });
    expect(await readFile(
      join(root, ".harness", "state", "baseline", "manifest.json"), "utf8"
    )).toBe(baselineBefore);
  });

  it("does not let forged local bundle state skip sensitive scanning", async () => {
    await writeFile(
      join(root, ".claude", "rules", "harness-general.md"),
      "authorization: Bearer secret-test-token\n"
    );
    const installed = JSON.parse(await readFile(
      join(root, ".harness", "state", "local", "installed-harness-bundle.json"), "utf8"
    )) as { files: string[] };
    await writeFile(
      join(root, ".harness", "state", "local", "installed-harness-bundle.json"),
      JSON.stringify({
        schema_version: 1,
        profile: "java",
        files: [...installed.files, ".claude/rules/harness-general.md"]
      })
    );

    const code = await runCli(["push", "--dry-run", "--json", "--non-interactive"], {
      cwd: root,
      resourcesRoot,
      fetch: vi.fn(),
      env: {},
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value)
    });

    expect(code).toBe(6);
    expect(stderr.join(" ")).toMatch(/sensitive/i);
  });

  it("returns auth failure when token_env is unset", async () => {
    const code = await runCli(["push", "--non-interactive", "--yes", "--json"], {
      cwd: root,
      resourcesRoot,
      fetch: vi.fn(),
      env: {},
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value)
    });
    expect(code).toBe(8);
  });

  it("resolves first project, uploads blobs, finalizes, and does not advance files", async () => {
    const requests: string[] = [];
    let requestedHash = "";
    const fetch = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      requests.push(new URL(url).pathname);
      if (url.endsWith("/api/v1/projects:resolve")) {
        return json({
          schema_version: 1,
          project_id: "prj_demo",
          binding_status: "created",
          project_version: null,
          baseline_manifest: {
            schema_version: 1,
            project_id: "prj_demo",
            complete_project_version: null,
            artifact_manifest_hash: null,
            files: {}
          },
          request_id: "req"
        });
      }
      if (url.endsWith("/proposal-sessions")) {
        const body = JSON.parse(String(init?.body)) as {
          proposal_manifest: { files: Array<{ content_sha256?: string }> };
        };
        requestedHash = body.proposal_manifest.files.find(
          (item) => item.content_sha256 !== undefined
        )?.content_sha256 ?? "";
        return json({
          session_id: "ups_demo",
          expires_at: "2026-06-21T00:00:00Z",
          missing_blobs: [requestedHash],
          max_chunk_bytes: 1024 * 1024,
          request_id: "req"
        }, 201);
      }
      if (url.endsWith("/blobs:query")) {
        return json({ present: [], missing: [requestedHash], request_id: "req" });
      }
      if (init?.method === "PUT" && url.includes("/blobs/")) {
        expect(new Headers(init.headers).get("Content-Range")).toMatch(
          /^bytes 0-\d+\/\d+$/
        );
        return json({ verified: true }, 201);
      }
      if (url.endsWith("ups_demo:finalize")) {
        return json({
          proposal_id: "prp_demo",
          status: "pending_review",
          received_files: 1,
          request_id: "req"
        }, 201);
      }
      throw new Error("unexpected request " + url);
    });

    const code = await runCli(["push", "--non-interactive", "--yes", "--json"], {
      cwd: root,
      resourcesRoot,
      fetch,
      env: { TEST_HUNTER_TOKEN: "api-token" },
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value)
    });
    expect(code).toBe(0);
    expect(requests.slice(0, 3)).toEqual([
      "/api/v1/projects:resolve",
      "/api/v1/projects/prj_demo/proposal-sessions",
      "/api/v1/proposal-sessions/ups_demo/blobs:query"
    ]);
    expect(requests.some((path) => path.includes("/blobs/sha256%3A"))).toBe(true);
    expect(requests.at(-1)).toBe("/api/v1/proposal-sessions/ups_demo:finalize");
    const project = parseYaml(
      await readFile(join(root, ".harness", "project.yaml"), "utf8")
    ) as { project: { project_id: string } };
    expect(project.project.project_id).toBe("prj_demo");
    const baseline = JSON.parse(await readFile(
      join(root, ".harness", "state", "baseline", "manifest.json"), "utf8"
    )) as { project_id: string; files: Record<string, unknown> };
    expect(baseline).toMatchObject({ project_id: "prj_demo", files: {} });
    expect(await exists(join(
      root, ".harness", "state", "local", "push-results", "prp_demo.json"
    ))).toBe(true);
  });

  it("returns sensitive-blocked without contacting the server", async () => {
    await writeFile(
      join(root, ".claude", "rules", "unsafe.md"),
      "Authorization: Bearer unsafe-secret-token-1234567890\n"
    );
    const fetch = vi.fn();
    const code = await runCli(["push", "--non-interactive", "--yes", "--json"], {
      cwd: root,
      resourcesRoot,
      fetch,
      env: { TEST_HUNTER_TOKEN: "api-token" },
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value)
    });
    expect(code).toBe(6);
    expect(fetch).not.toHaveBeenCalled();
    expect(stdout.join("")).not.toContain("unsafe-secret-token");
  });

  it("resumes a persisted upload session after interruption", async () => {
    let requestedHash = "";
    const firstFetch = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/v1/projects:resolve")) {
        return json({
          schema_version: 1,
          project_id: "prj_resume",
          binding_status: "created",
          project_version: null,
          baseline_manifest: {},
          request_id: "req"
        });
      }
      if (url.endsWith("/proposal-sessions")) {
        const body = JSON.parse(String(init?.body)) as {
          proposal_manifest: { files: Array<{ content_sha256?: string }> };
        };
        requestedHash = body.proposal_manifest.files.find(
          (item) => item.content_sha256 !== undefined
        )?.content_sha256 ?? "";
        return json({
          session_id: "ups_resume",
          expires_at: "2099-06-21T00:00:00Z",
          missing_blobs: [requestedHash],
          max_chunk_bytes: 1024 * 1024,
          request_id: "req"
        }, 201);
      }
      if (url.endsWith("/blobs:query")) {
        return json({ present: [], missing: [requestedHash], request_id: "req" });
      }
      if (init?.method === "PUT") {
        throw new Error("injected interrupted upload");
      }
      throw new Error("unexpected first request " + url);
    });
    expect(await runCli(["push", "--non-interactive", "--yes"], {
      cwd: root,
      resourcesRoot,
      fetch: firstFetch,
      env: { TEST_HUNTER_TOKEN: "api-token" },
      stdout: () => undefined,
      stderr: () => undefined
    })).toBe(4);

    const secondPaths: string[] = [];
    const secondFetch = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      secondPaths.push(new URL(url).pathname);
      if (url.endsWith("/blobs:query")) {
        return json({ present: [], missing: [requestedHash], request_id: "req" });
      }
      if (init?.method === "PUT") {
        return json({ verified: true }, 201);
      }
      if (url.endsWith("ups_resume:finalize")) {
        return json({
          proposal_id: "prp_resume",
          status: "pending_review",
          received_files: 1,
          request_id: "req"
        }, 201);
      }
      throw new Error("unexpected resumed request " + url);
    });
    expect(await runCli(["push", "--non-interactive", "--yes"], {
      cwd: root,
      resourcesRoot,
      fetch: secondFetch,
      env: { TEST_HUNTER_TOKEN: "api-token" },
      stdout: () => undefined,
      stderr: () => undefined
    })).toBe(0);
    expect(secondPaths).not.toContain(
      "/api/v1/projects/prj_resume/proposal-sessions"
    );
    expect(secondPaths[0]).toBe(
      "/api/v1/proposal-sessions/ups_resume/blobs:query"
    );
    // 全量并行负载下该用例会被拖过 5s 默认超时（单独跑 684ms 通过），给 30s 余量防 flaky
  }, 30000);
});
