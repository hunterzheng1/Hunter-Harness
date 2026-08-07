import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runConnect } from "../src/commands/connect.js";
import type { CommandDependencies } from "../src/commands/configure.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("hunter-harness connect", () => {
  let root: string;
  let stdout: string[];
  let stderr: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hunter-connect-"));
    stdout = [];
    stderr = [];
  });

  function dependencies(fetchImpl: typeof fetch, secret = "hh_test_key"): CommandDependencies {
    return {
      cwd: root,
      resourcesRoot: "",
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      prompt: async () => secret,
      promptSecret: async () => secret,
      fetch: fetchImpl,
      env: {}
    };
  }

  it("verifies the key and writes credentials.local.yaml plus gitignore", async () => {
    const fetchMock = vi.fn(async () => json({
      kind: "project-key",
      actor_id: "actor_owner",
      project_id: "prj_demo",
      scopes: ["push", "files:read"]
    }));

    const code = await runConnect(
      "https://platform.example.test",
      { json: true },
      dependencies(fetchMock as unknown as typeof fetch)
    );
    expect(code).toBe(0);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://platform.example.test/api/v1/auth/key-info",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer hh_test_key" })
      })
    );

    const credentials = parseYaml(
      await readFile(join(root, ".harness", "credentials.local.yaml"), "utf8")
    ) as { token: string; server_url: string };
    expect(credentials.token).toBe("hh_test_key");
    expect(credentials.server_url).toBe("https://platform.example.test");

    const gitignore = await readFile(join(root, ".gitignore"), "utf8");
    expect(gitignore).toContain(".harness/credentials.local.yaml");

    const result = JSON.parse(stdout.join("")) as Record<string, unknown>;
    expect(result).toMatchObject({
      command: "connect",
      ok: true,
      project_id: "prj_demo"
    });
  });

  it("rejects an invalid key without writing credentials", async () => {
    const fetchMock = vi.fn(async () => json({ error: { code: "TOKEN_INVALID" } }, 401));
    const code = await runConnect(
      "https://platform.example.test",
      {},
      dependencies(fetchMock as unknown as typeof fetch)
    );
    expect(code).toBe(3);
    expect(stderr.join("")).toContain("KEY_INVALID");
    await expect(
      readFile(join(root, ".harness", "credentials.local.yaml"), "utf8")
    ).rejects.toThrow();
  });

  it("requires https", async () => {
    const code = await runConnect(
      "http://plain.example.test",
      {},
      dependencies(vi.fn() as unknown as typeof fetch)
    );
    expect(code).toBe(2);
    expect(stderr.join("")).toContain("SERVER_URL_INVALID");
  });

  it("requires --key in non-interactive mode", async () => {
    const code = await runConnect(
      "https://platform.example.test",
      { nonInteractive: true },
      dependencies(vi.fn() as unknown as typeof fetch)
    );
    expect(code).toBe(2);
    expect(stderr.join("")).toContain("KEY_REQUIRED");
  });

  it("rejects silent project_id rebind without --rebind", async () => {
    await mkdir(join(root, ".harness"), { recursive: true });
    await writeFile(
      join(root, ".harness", "project.yaml"),
      [
        "harness:",
        "  name: hunter-harness",
        "  schema_version: 1",
        "project:",
        "  name: demo",
        "  root: \".\"",
        "  project_id: prj_old",
        ""
      ].join("\n"),
      "utf8"
    );
    const fetchMock = vi.fn(async () => json({
      kind: "project-key",
      actor_id: "actor_owner",
      project_id: "prj_new",
      scopes: ["push"]
    }));
    const code = await runConnect(
      "https://platform.example.test",
      { key: "hh_test_key", nonInteractive: true, yes: true },
      dependencies(fetchMock as unknown as typeof fetch)
    );
    expect(code).toBe(2);
    expect(stderr.join("")).toContain("PROJECT_REBIND_REQUIRED");
    const yaml = await readFile(join(root, ".harness", "project.yaml"), "utf8");
    expect(yaml).toContain("project_id: prj_old");
  });

  it("allows rebind when --rebind is set", async () => {
    await mkdir(join(root, ".harness"), { recursive: true });
    await writeFile(
      join(root, ".harness", "project.yaml"),
      [
        "harness:",
        "  name: hunter-harness",
        "  schema_version: 1",
        "project:",
        "  name: demo",
        "  root: \".\"",
        "  project_id: prj_old",
        ""
      ].join("\n"),
      "utf8"
    );
    const fetchMock = vi.fn(async () => json({
      kind: "project-key",
      actor_id: "actor_owner",
      project_id: "prj_new",
      scopes: ["push"]
    }));
    const code = await runConnect(
      "https://platform.example.test",
      { key: "hh_test_key", nonInteractive: true, rebind: true },
      dependencies(fetchMock as unknown as typeof fetch)
    );
    expect(code).toBe(0);
    const yaml = await readFile(join(root, ".harness", "project.yaml"), "utf8");
    expect(yaml).toContain("project_id: prj_new");
    expect(yaml).not.toContain("project_id: prj_old");
  });
});
