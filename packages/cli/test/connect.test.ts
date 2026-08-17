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
      project_display_name: "示例项目",
      scopes: ["push", "knowledge:read", "files:read"]
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
    ) as { token: string; server_url: string; project_display_name: string; actor_id: string };
    expect(credentials.token).toBe("hh_test_key");
    expect(credentials.server_url).toBe("https://platform.example.test");
    expect(credentials.project_display_name).toBe("示例项目");
    expect(credentials.actor_id).toBe("actor_owner");

    const gitignore = await readFile(join(root, ".gitignore"), "utf8");
    expect(gitignore).toContain(".harness/credentials.local.yaml");

    const result = JSON.parse(stdout.join("")) as Record<string, unknown>;
    expect(result).toMatchObject({
      command: "connect",
      ok: true,
      project_id: "prj_demo",
      summary: { project_display_name: "示例项目" }
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

  it("allows HTTP when connecting to a loopback Hunter Platform", async () => {
    const fetchMock = vi.fn(async () => json({
      kind: "project-key",
      actor_id: "actor_owner",
      project_id: "prj_local",
      scopes: ["push"]
    }));

    const code = await runConnect(
      "http://127.0.0.1:3003",
      { key: "hh_test_key" },
      dependencies(fetchMock as unknown as typeof fetch)
    );

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3003/api/v1/auth/key-info",
      expect.any(Object)
    );
  });

  it("clears a stale cached project name when rebinding and an older server omits it", async () => {
    await mkdir(join(root, ".harness"), { recursive: true });
    await writeFile(
      join(root, ".harness", "credentials.local.yaml"),
      "project_display_name: 旧项目名称\nproject_id: prj_old\nserver_url: https://platform.example.test\ntoken: old-token\n",
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
      { key: "hh_new_key", nonInteractive: true, rebind: true },
      dependencies(fetchMock as unknown as typeof fetch)
    );

    expect(code).toBe(0);
    const credentials = parseYaml(
      await readFile(join(root, ".harness", "credentials.local.yaml"), "utf8")
    ) as Record<string, unknown>;
    expect(credentials.project_id).toBe("prj_new");
    expect(credentials).not.toHaveProperty("project_display_name");
  });

  it("sanitizes remote key information in human-readable output", async () => {
    const fetchMock = vi.fn(async () => json({
      kind: "project-key\n伪造类型",
      actor_id: "actor_owner",
      project_id: "prj_demo",
      project_display_name: "安全名称\u001b[31m\n伪造行",
      scopes: ["push\n伪造权限"]
    }));

    const code = await runConnect(
      "https://platform.example.test",
      { key: "hh_test_key" },
      dependencies(fetchMock as unknown as typeof fetch)
    );

    expect(code).toBe(0);
    const output = stdout.join("");
    expect(output).not.toContain("\u001b");
    expect(output.split("\n")).not.toContain("伪造行");
    expect(output).toContain("安全名称 伪造行");
    expect(output).toContain("project-key 伪造类型");
    expect(output).toContain("push 伪造权限");
  });

  it("requires https for non-loopback hosts", async () => {
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
