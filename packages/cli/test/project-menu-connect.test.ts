import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runPlatformConnectionMenu } from "../src/commands/project-menu.js";
import type { CommandDependencies } from "../src/commands/configure.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

const KEY_INFO = {
  kind: "project-key",
  actor_id: "actor_owner",
  project_id: "prj_demo",
  project_display_name: "示例项目"
};

const DEFAULT_PLATFORM_URL = "https://harness.hunter-z.com";

describe("platform connection menu server url default", () => {
  let root: string;
  let stdout: string[];
  let env: Record<string, string>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hunter-menu-"));
    stdout = [];
    env = {};
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function dependencies(
    answers: readonly string[],
    fetchImpl: typeof fetch
  ): CommandDependencies & { questions: string[] } {
    const questions: string[] = [];
    const queue = [...answers];
    const deps: CommandDependencies & { questions: string[] } = {
      cwd: root,
      resourcesRoot: "",
      stdout: (value) => stdout.push(value),
      stderr: () => true,
      prompt: async (question) => {
        questions.push(question);
        return queue.shift() ?? "";
      },
      promptSecret: async () => "hh_test_key",
      fetch: fetchImpl,
      env,
      questions
    };
    return deps;
  }

  it("offers the fixed production url as default and empty input accepts it", async () => {
    const fetchMock = vi.fn(async () => json(KEY_INFO));
    const deps = dependencies(["1", ""], fetchMock as unknown as typeof fetch);

    const code = await runPlatformConnectionMenu({}, deps);
    expect(code).toBe(0);
    expect(deps.questions.some((q) =>
      q.includes(`平台地址 [${DEFAULT_PLATFORM_URL}]`)
    )).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      `${DEFAULT_PLATFORM_URL}/api/v1/auth/key-info`,
      expect.anything()
    );
  });

  it("typed input overrides the default url", async () => {
    const fetchMock = vi.fn(async () => json(KEY_INFO));
    const deps = dependencies(["1", "https://new.example.com"], fetchMock as unknown as typeof fetch);

    const code = await runPlatformConnectionMenu({}, deps);
    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://new.example.com/api/v1/auth/key-info",
      expect.anything()
    );
  });

  it("rebind uses the same fixed default instead of the existing credential url", async () => {
    await mkdir(join(root, ".harness"), { recursive: true });
    await writeFile(
      join(root, ".harness", "credentials.local.yaml"),
      "server_url: https://existing.example.com\ntoken: hh_old_key\n",
      "utf8"
    );
    const fetchMock = vi.fn(async () => json(KEY_INFO));
    // 已绑定状态：1 = 重新绑定 → 地址提示回车取固定默认值（不读现有凭据地址）
    const deps = dependencies(["1", ""], fetchMock as unknown as typeof fetch);

    const code = await runPlatformConnectionMenu({}, deps);
    expect(code).toBe(0);
    expect(deps.questions.some((q) =>
      q.includes(`平台地址 [${DEFAULT_PLATFORM_URL}]`)
    )).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      `${DEFAULT_PLATFORM_URL}/api/v1/auth/key-info`,
      expect.anything()
    );
  });

  it("rebind default also ignores a credential file written with CRLF endings", async () => {
    await mkdir(join(root, ".harness"), { recursive: true });
    await writeFile(
      join(root, ".harness", "credentials.local.yaml"),
      "server_url: https://existing.example.com\r\ntoken: hh_old_key\r\n",
      "utf8"
    );
    const fetchMock = vi.fn(async () => json(KEY_INFO));
    const deps = dependencies(["1", ""], fetchMock as unknown as typeof fetch);

    const code = await runPlatformConnectionMenu({}, deps);
    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      `${DEFAULT_PLATFORM_URL}/api/v1/auth/key-info`,
      expect.anything()
    );
  });
});
