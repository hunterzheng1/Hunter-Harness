import {
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";
import { beforeEach, describe, expect, it } from "vitest";

import { runCli } from "../src/bin.js";

const resourcesRoot = fileURLToPath(
  new URL("../../workflow-data-harness", import.meta.url)
);

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// v1.0 契约：零选择安装（无 --agents/--profile/--codebuddy-surface），
// 固定 .agents/skills + AGENTS.md 主投影 + .codebuddy/skills 双写。
describe("hunter-harness initialization", () => {
  let root: string;
  let stdout: string[];
  let stderr: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hunter-init-"));
    stdout = [];
    stderr = [];
  });

  async function run(args: string[]): Promise<number> {
    return runCli(args, {
      cwd: root,
      resourcesRoot,
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value)
    });
  }

  it("performs a write-free dry run", async () => {
    const code = await run(["--non-interactive", "--dry-run", "--json"]);

    expect(code).toBe(0);
    expect(await pathExists(join(root, ".harness"))).toBe(false);
    const output = JSON.parse(stdout.join("")) as { dry_run: boolean; command: string };
    expect(output).toMatchObject({ dry_run: true, command: "configure" });
  });

  it("initializes when only generated workflow cache remains", async () => {
    const cacheMarker = join(
      root,
      ".harness",
      "cache",
      "workflow-packages",
      "@hunter-harness+workflow-harness",
      "package.json"
    );
    await mkdir(join(cacheMarker, ".."), { recursive: true });
    await writeFile(cacheMarker, "{\"generated\":true}\n", "utf8");

    const code = await run(["--non-interactive", "--yes", "--json"]);

    expect(code).toBe(0);
    expect(await pathExists(join(root, ".harness", "project.yaml"))).toBe(true);
  });

  it("fails closed when project.yaml is missing but local archive state remains", async () => {
    const archivePath = join(
      root,
      ".harness",
      "archive",
      "existing",
      "reports",
      "final",
      "summary-data.json"
    );
    await mkdir(join(archivePath, ".."), { recursive: true });
    await writeFile(archivePath, "{\"preserve\":true}\n", "utf8");

    const code = await run(["--non-interactive", "--yes", "--json"]);

    expect(code).toBe(6);
    expect(await readFile(archivePath, "utf8")).toBe("{\"preserve\":true}\n");
    expect(await pathExists(join(root, ".harness", "project.yaml"))).toBe(false);
    const output = JSON.parse(stdout.join("")) as {
      errors: Array<{
        code: string;
        reasonCode: string;
        sentinels: string[];
        protectedLocalRoots: Array<{ path: string; files: number; bytes: number }>;
      }>;
    };
    expect(output.errors[0]).toMatchObject({
      code: "PARTIAL_HARNESS_STATE_DETECTED",
      reasonCode: "PARTIAL_HARNESS_STATE_DETECTED"
    });
    expect(output.errors[0]?.sentinels).toContain(".harness/archive");
    expect(output.errors[0]?.protectedLocalRoots).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ".harness/archive", files: 1 })
    ]));
  });

  it("fails closed when project.yaml is missing but an active change remains", async () => {
    const changePath = join(
      root,
      ".harness",
      "changes",
      "unfinished",
      "plans",
      "unfinished-plan.md"
    );
    await mkdir(join(changePath, ".."), { recursive: true });
    await writeFile(changePath, "# 未完成变更\n", "utf8");

    const code = await run(["--non-interactive", "--yes", "--json"]);

    expect(code).toBe(6);
    expect(await readFile(changePath, "utf8")).toBe("# 未完成变更\n");
    expect(await pathExists(join(root, ".harness", "project.yaml"))).toBe(false);
    const output = JSON.parse(stdout.join("")) as {
      errors: Array<{ sentinels: string[] }>;
    };
    expect(output.errors[0]?.sentinels).toContain(".harness/changes");
  });

  it("reinitializes when only local config, codebase map, and generated markers remain", async () => {
    const retainedFiles = new Map([
      [join(root, ".harness", "config", "local.yaml"), "language: zh-CN\n"],
      [join(root, ".harness", "codebase", "map", "summary.md"), "# 代码地图\n"]
    ]);
    for (const [path, content] of retainedFiles) {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, content, "utf8");
    }

    const marker = join(
      root,
      ".agents",
      "skills",
      "harness-run",
      ".harness-build.json"
    );
    await mkdir(join(marker, ".."), { recursive: true });
    await writeFile(marker, "{\"schemaVersion\":1}\n", "utf8");

    const code = await run(["--non-interactive", "--yes", "--json"]);

    expect(code).toBe(0);
    expect(await pathExists(join(root, ".harness", "project.yaml"))).toBe(true);
    for (const [path, content] of retainedFiles) {
      expect(await readFile(path, "utf8")).toBe(content);
    }
  });

  it("prints the version banner on a blank non-interactive install", async () => {
    const code = await run(["--non-interactive", "--yes"]);
    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("")).toMatch(
      /版本：CLI v\d+\.\d+\.\d+ · 工作流包 v\d+\.\d+\.\d+ · Bundle v\d+\.\d+\.\d+/
    );
    const project = parseYaml(
      await readFile(join(root, ".harness", "project.yaml"), "utf8")
    ) as {
      project: { name: string; local_project_key: string; project_id: null };
      server: { url: null; token_env: string };
    };
    expect(project.project.local_project_key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(project.project.project_id).toBeNull();
    expect(project.server).toEqual({ url: null, token_env: "HUNTER_HARNESS_TOKEN" });
  });

  it("creates concise idempotent Git ignore rules", async () => {
    await writeFile(join(root, ".gitignore"), "node_modules/\r\n", "utf8");
    const args = ["--non-interactive", "--yes"];

    expect(await run(args)).toBe(0);
    const first = await readFile(join(root, ".gitignore"), "utf8");
    expect(first).toContain("node_modules/\r\n");
    expect(first).toContain("# Hunter Harness（本地生成，不提交）");
    expect(first).toContain("/.harness/");
    expect(first).toContain("/.worktrees/");
    expect(first).toContain("/.agents/");
    expect(first).toContain("/.codebuddy/");
    expect(first).not.toContain("/skills/harness-*/");

    expect(await run(args)).toBe(0);
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(first);
  }, 240_000);

  it("preserves an explicit Git ignore negation without blocking unrelated rules", async () => {
    await writeFile(join(root, ".gitignore"), "/.harness/\n!/.harness/\n", "utf8");

    expect(await run(["--non-interactive", "--yes"])).toBe(0);
    const gitignore = await readFile(join(root, ".gitignore"), "utf8");
    expect(gitignore).toContain("/.harness/\n!/.harness/\n");
    expect(gitignore.match(/^\/\.harness\/$/gm)).toHaveLength(1);
    expect(gitignore).toContain("/.worktrees/");
    expect(gitignore).toContain("/.agents/");
  });

  it("initializes offline with the canonical .agents + AGENTS.md projection and CodeBuddy double-write", async () => {
    const code = await run(["--non-interactive", "--yes"]);
    expect(code).toBe(0);

    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(agents).toContain("hunter-harness:start");
    // v1.0 不再生成/触碰 CLAUDE.md 与 CODEBUDDY.md。
    expect(await pathExists(join(root, "CLAUDE.md"))).toBe(false);
    expect(await pathExists(join(root, "CODEBUDDY.md"))).toBe(false);
    // 主投影 + 派生双写。
    expect(await readFile(
      join(root, ".agents", "skills", "harness-review", "SKILL.md"),
      "utf8"
    )).toContain("generated by harness_deploy.py");
    expect(await pathExists(
      join(root, ".codebuddy", "skills", "harness-review", "SKILL.md")
    )).toBe(true);
    expect(await pathExists(join(root, ".harness", "state", "local"))).toBe(true);
    // 首次安装不预创建可选 cache/server-artifacts 目录（design §9，由 feature 懒创建）。
    expect(await pathExists(
      join(root, ".harness", "cache", "server-artifacts")
    )).toBe(false);
    expect(await readFile(
      join(root, ".harness", "state", "baseline", "manifest.json"),
      "utf8"
    )).not.toContain("secret");
  });

  it("gives config-file fields precedence over command-line fields", async () => {
    const configPath = join(root, "harness.init.json");
    await writeFile(configPath, JSON.stringify({
      server_url: "https://config.example.com",
      token_env: "CONFIG_TOKEN",
      features: {
        codegraph_check: false,
        superpowers_check: false
      }
    }));

    const code = await run([
      "--config", configPath,
      "--server-url", "https://flag.example.com",
      "--non-interactive",
      "--yes"
    ]);
    expect(code).toBe(0);

    const project = parseYaml(
      await readFile(join(root, ".harness", "project.yaml"), "utf8")
    ) as { server: { url: string; token_env: string } };
    expect(project.server).toEqual({
      url: "https://config.example.com",
      token_env: "CONFIG_TOKEN"
    });
  });

  it("preserves user content and is idempotent", async () => {
    await writeFile(join(root, "CLAUDE.md"), "# User Claude\nKeep this.\n");
    await writeFile(join(root, "AGENTS.md"), "# User Agents\nKeep this too.\n");
    const args = ["--non-interactive", "--yes"];
    expect(await run(args)).toBe(0);
    const firstAgents = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(await run(args)).toBe(0);
    const secondAgents = await readFile(join(root, "AGENTS.md"), "utf8");

    // v1.0 不触碰 CLAUDE.md；用户手写内容保留。
    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe("# User Claude\nKeep this.\n");
    expect(secondAgents).toBe(firstAgents);
    expect(secondAgents).toContain("# User Agents");
    expect(secondAgents).toContain("Keep this too.");
    expect(secondAgents).toContain("hunter-harness:start");
  });

  it("does not delete an arbitrary path named by forged local bundle state", async () => {
    expect(await run(["--non-interactive", "--yes"])).toBe(0);
    const notePath = join(root, "notes.txt");
    await writeFile(notePath, "keep this user file\n");
    await writeFile(
      join(root, ".harness", "state", "local", "installed-harness-bundle.json"),
      JSON.stringify({ schema_version: 1, files: ["notes.txt"] })
    );

    // 伪造的旧格式 state 的 files 列表（含 notes.txt）不得授权删除/覆盖。
    const code = await run(["--non-interactive", "--yes"]);
    expect([0, 5]).toContain(code);
    expect(await readFile(notePath, "utf8")).toBe("keep this user file\n");
  });
});
