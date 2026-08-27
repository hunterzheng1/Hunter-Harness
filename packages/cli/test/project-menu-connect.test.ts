import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runPlatformConnectionMenu } from "../src/commands/project-menu.js";
import type { CommandDependencies } from "../src/commands/configure.js";
import { readLastServerUrl, writeLastServerUrl } from "../src/config/last-server.js";

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
  project_display_name: "示例项目",
  scopes: ["push"]
};

describe("platform connection menu server url default", () => {
  let root: string;
  let stateRoot: string;
  let stdout: string[];
  let env: Record<string, string>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hunter-menu-"));
    stateRoot = await mkdtemp(join(tmpdir(), "hunter-menu-state-"));
    stdout = [];
    env = { HUNTER_HARNESS_USER_STATE_ROOT: stateRoot };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
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

  it("offers the remembered url as default and empty input accepts it", async () => {
    await writeLastServerUrl("https://harness.hunter-z.com", env);
    const fetchMock = vi.fn(async () => json(KEY_INFO));
    const deps = dependencies(["1", ""], fetchMock as unknown as typeof fetch);

    const code = await runPlatformConnectionMenu({}, deps);
    expect(code).toBe(0);
    expect(deps.questions.some((q) =>
      q.includes("平台地址 [https://harness.hunter-z.com]")
    )).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://harness.hunter-z.com/api/v1/auth/key-info",
      expect.anything()
    );
    await expect(readLastServerUrl(env)).resolves.toBe("https://harness.hunter-z.com");
  });

  it("typed input overrides the remembered default and becomes the new default", async () => {
    await writeLastServerUrl("https://old.example.com", env);
    const fetchMock = vi.fn(async () => json(KEY_INFO));
    const deps = dependencies(["1", "https://new.example.com"], fetchMock as unknown as typeof fetch);

    const code = await runPlatformConnectionMenu({}, deps);
    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://new.example.com/api/v1/auth/key-info",
      expect.anything()
    );
    await expect(readLastServerUrl(env)).resolves.toBe("https://new.example.com");
  });

  it("rebind defaults to the existing credential url over the remembered one", async () => {
    await writeLastServerUrl("https://remembered.example.com", env);
    await mkdir(join(root, ".harness"), { recursive: true });
    await writeFile(
      join(root, ".harness", "credentials.local.yaml"),
      "server_url: https://existing.example.com\ntoken: hh_old_key\n",
      "utf8"
    );
    const fetchMock = vi.fn(async () => json(KEY_INFO));
    // 已绑定状态：1 = 重新绑定 → 地址提示回车取默认（应为现有凭据地址）
    const deps = dependencies(["1", ""], fetchMock as unknown as typeof fetch);

    const code = await runPlatformConnectionMenu({}, deps);
    expect(code).toBe(0);
    expect(deps.questions.some((q) =>
      q.includes("平台地址 [https://existing.example.com]")
    )).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://existing.example.com/api/v1/auth/key-info",
      expect.anything()
    );
  });

  it("keeps cancel-on-empty behavior when no default exists", async () => {
    const fetchMock = vi.fn(async () => json(KEY_INFO));
    const deps = dependencies(["1", ""], fetchMock as unknown as typeof fetch);

    const code = await runPlatformConnectionMenu({}, deps);
    expect(code).toBe(0);
    expect(deps.questions.some((q) => q.includes("平台地址 ["))).toBe(false);
    expect(stdout.join("")).toContain("已取消（未输入地址）");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
