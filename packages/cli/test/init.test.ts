import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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

async function filesUnder(directory: string, base = directory): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(full, base));
    if (entry.isFile()) result.push(relative(base, full).replaceAll("\\", "/"));
  }
  return result.sort();
}

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
    const code = await run([
      "--profile", "java",
      "--non-interactive",
      "--dry-run",
      "--json"
    ]);

    expect(code).toBe(0);
    expect(await pathExists(join(root, ".harness"))).toBe(false);
    const output = JSON.parse(stdout.join("")) as { dry_run: boolean; command: string };
    expect(output).toMatchObject({ dry_run: true, command: "configure" });
  });

  it("fails non-interactively when profile is missing", async () => {
    const code = await run(["--non-interactive", "--yes"]);
    expect(code).toBe(3);
    expect(stderr.join(" ")).toMatch(/profile/i);
    expect(await pathExists(join(root, ".harness"))).toBe(false);
  });

  it.each([
    ["", "general"],
    ["1", "general"],
    ["general", "general"],
    ["2", "java"],
    ["java", "java"]
  ])("maps interactive profile input %j to %s", async (answer, expected) => {
    const code = await runCli([], {
      cwd: root,
      resourcesRoot,
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      prompt: async (question) => question.includes("Agent") ? "" : answer
    });
    expect(code).toBe(0);
    const project = parseYaml(
      await readFile(join(root, ".harness", "project.yaml"), "utf8")
    ) as { project: { profiles: string[] }; adapters: { enabled: string[] } };
    expect(project.project.profiles).toEqual([expected]);
    expect(project.adapters.enabled).toEqual(["claude-code"]);
  });

  it("rejects an unknown interactive profile", async () => {
    const code = await runCli([], {
      cwd: root,
      resourcesRoot,
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      prompt: async (question) => question.includes("Agent") ? "" : "python"
    });
    expect(code).toBe(3);
    expect(stderr.join(" ")).toContain("配置类型必须为 general 或 java");
  });

  it("interactive first install asks agents then profile", async () => {
    const answers = ["1,2", ""];
    const questions: string[] = [];
    const code = await runCli([], {
      cwd: root,
      resourcesRoot,
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      prompt: async (q) => {
        questions.push(q);
        return answers.shift() ?? "";
      }
    });
    expect(code).toBe(0);
    expect(questions[0]).toContain("请选择目标 Agent");
    expect(questions[0]).toContain("5. 全部");
    expect(questions[1]).toContain("请选择 Harness 类型");
    const project = parseYaml(
      await readFile(join(root, ".harness", "project.yaml"), "utf8")
    ) as { adapters: { enabled: string[] } };
    expect(project.adapters.enabled).toEqual(["claude-code", "codex"]);
    expect(await pathExists(join(root, ".claude", "skills", "harness-review", "SKILL.md"))).toBe(true);
    expect(await pathExists(join(root, ".agents", "skills", "harness-review", "SKILL.md"))).toBe(true);
  }, 90_000);

  it("interactive first install with all agents option selects four adapters", async () => {
    const answers = ["5", ""];
    const code = await runCli([], {
      cwd: root,
      resourcesRoot,
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      prompt: async (question) => question.includes("Agent") ? (answers.shift() ?? "") : ""
    });
    expect(code).toBe(0);
    const project = parseYaml(
      await readFile(join(root, ".harness", "project.yaml"), "utf8")
    ) as { adapters: { enabled: string[] } };
    expect(project.adapters.enabled).toEqual([
      "claude-code", "codex", "cursor", "codebuddy"
    ]);
  }, 240_000);

  it("existing project refresh menu shows installed labels and all option", async () => {
    expect(await run([
      "--agents", "1,2", "--profile", "general", "--non-interactive", "--yes"
    ])).toBe(0);
    const answers = ["1", "0"];
    const questions: string[] = [];
    const code = await runCli([], {
      cwd: root,
      resourcesRoot,
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      prompt: async (question) => {
        questions.push(question);
        return answers.shift() ?? "";
      }
    });
    expect(code).toBe(2);
    const agentPrompt = questions.find((q) => q.includes("请选择本次要新增或刷新的工具"));
    expect(agentPrompt).toBeDefined();
    expect(agentPrompt).toContain("Hunter Harness 当前配置");
    expect(agentPrompt).toContain("Claude Code（已安装：general）");
    expect(agentPrompt).toContain("Codex（已安装：general）");
    expect(agentPrompt).toContain("5. 全部");
  }, 120_000);

  it("migrates shared rules idempotently and offers CodeGraph MCP when CodeBuddy is selected", async () => {
    await mkdir(join(root, ".claude", "rules"), { recursive: true });
    await mkdir(join(root, ".codegraph"), { recursive: true });
    await writeFile(join(root, ".claude", "rules", "team.md"), "# Team rule\n");
    const answers = ["1,4", "1", "", ""];
    const questions: string[] = [];
    const code = await runCli([], {
      cwd: root,
      resourcesRoot,
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      prompt: async (question) => {
        questions.push(question);
        return answers.shift() ?? "";
      }
    });
    expect(code).toBe(0);
    expect(questions.some((question) => question.includes("Claude 自定义规则"))).toBe(false);
    expect(questions.some((question) => question.includes("CodeGraph MCP"))).toBe(true);
    expect(await readFile(join(root, ".harness", "rules", "team.md"), "utf8"))
      .toContain("Team rule");
    expect(await readFile(join(root, ".codebuddy", ".rules", "team.mdc"), "utf8"))
      .toContain("Team rule");
    const mcp = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(mcp.mcpServers.codegraph).toBeDefined();
  }, 90_000);

  it("non-interactive --agents all projects four agent roots", async () => {
    const code = await run([
      "--agents", "all", "--profile", "general", "--non-interactive", "--yes"
    ]);
    expect(code).toBe(0);
    const project = parseYaml(
      await readFile(join(root, ".harness", "project.yaml"), "utf8")
    ) as { adapters: { enabled: string[] } };
    expect(project.adapters.enabled).toEqual([
      "claude-code", "codex", "cursor", "codebuddy"
    ]);
    expect(await pathExists(join(root, ".claude", "skills", "harness-review", "SKILL.md"))).toBe(true);
    expect(await pathExists(join(root, ".agents", "skills", "harness-review", "SKILL.md"))).toBe(true);
    for (const supportFile of ["SKILL.md", "protocols.md", "reference.md", "checklist.md"]) {
      expect(
        await pathExists(join(root, ".agents", "skills", "harness-run", supportFile)),
        `Codex harness-run must install ${supportFile}`
      ).toBe(true);
    }
    expect(await pathExists(join(root, ".cursor", "skills", "harness-review", "SKILL.md"))).toBe(true);
    expect(await pathExists(join(root, ".codebuddy", "skills", "harness-review", "SKILL.md"))).toBe(true);
    expect(await pathExists(join(root, ".codebuddy", ".rules", "harness-general.mdc"))).toBe(true);
    expect(await pathExists(join(root, ".codebuddy", "rules", "harness-general.md"))).toBe(true);
    expect(await pathExists(join(root, "CODEBUDDY.md"))).toBe(true);
  }, 240_000);

  it("rejects unknown agent without writing files", async () => {
    const code = await run([
      "--agents", "codex,gpt", "--profile", "general", "--non-interactive", "--yes"
    ]);
    expect(code).toBe(3);
    expect(stderr.join(" ")).toContain("AGENT_UNSUPPORTED");
    expect(await pathExists(join(root, ".harness"))).toBe(false);
  });

  it("rejects --codebuddy-surface when codebuddy not selected", async () => {
    const code = await run([
      "--agents", "codex",
      "--codebuddy-surface", "ide",
      "--profile", "general",
      "--non-interactive",
      "--yes"
    ]);
    expect(code).toBe(3);
    expect(stderr.join(" ")).toContain("CODEBUDDY_SURFACE_UNUSED");
  });

  it("initializes offline and compiles real Claude Code skills", async () => {
    const code = await run([
      "--profile", "java",
      "--non-interactive",
      "--yes"
    ]);
    expect(code).toBe(0);

    const project = parseYaml(
      await readFile(join(root, ".harness", "project.yaml"), "utf8")
    ) as {
      project: { local_project_key: string; project_id: null; profiles: string[] };
      server: { url: null; token_env: string };
    };
    expect(project.project.local_project_key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(project.project.project_id).toBeNull();
    expect(project.server).toEqual({
      url: null,
      token_env: "HUNTER_HARNESS_TOKEN"
    });
    expect(await pathExists(join(root, "AGENTS.md"))).toBe(true);
    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toContain("@AGENTS.md");
    expect(await readFile(
      join(root, ".claude", "skills", "harness-review", "SKILL.md"),
      "utf8"
    )).toContain("generated by harness_deploy.py");
    expect(await pathExists(join(root, ".harness", "rules"))).toBe(true);
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
      adapter: "claude-code",
      profile: "java",
      server_url: "https://config.example.com",
      token_env: "CONFIG_TOKEN",
      features: {
        codegraph_check: false,
        superpowers_check: false
      }
    }));

    const code = await run([
      "--config", configPath,
      "--profile", "general",
      "--server-url", "https://flag.example.com",
      "--non-interactive",
      "--yes"
    ]);
    expect(code).toBe(0);

    const project = parseYaml(
      await readFile(join(root, ".harness", "project.yaml"), "utf8")
    ) as {
      project: { profiles: string[] };
      server: { url: string; token_env: string };
    };
    expect(project.project.profiles).toEqual(["java"]);
    expect(project.server).toEqual({
      url: "https://config.example.com",
      token_env: "CONFIG_TOKEN"
    });
  });

  it("preserves user content and is idempotent", async () => {
    await writeFile(join(root, "CLAUDE.md"), "# User Claude\nKeep this.\n");
    await writeFile(join(root, "AGENTS.md"), "# User Agents\nKeep this too.\n");
    const args = [
      "--profile", "java",
      "--non-interactive",
      "--yes"
    ];
    expect(await run(args)).toBe(0);
    const firstClaude = await readFile(join(root, "CLAUDE.md"), "utf8");
    expect(await run(args)).toBe(0);
    const secondClaude = await readFile(join(root, "CLAUDE.md"), "utf8");

    expect(secondClaude).toBe(firstClaude);
    expect(secondClaude).toContain("# User Claude");
    expect(secondClaude.match(/hunter-harness:start/g)).toHaveLength(1);
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toContain("# User Agents");
  });

  it.each(["general", "java"])("installs %s bundle byte-for-byte", async (profile) => {
    expect(await run(["--profile", profile, "--non-interactive", "--yes"])).toBe(0);
    const bundle = join(resourcesRoot, "harness", "bundles", profile, "claude-code");
    for (const rel of await filesUnder(bundle)) {
      const target = /^agents\/[^/]+\.md$/.test(rel)
        ? join(root, ".claude", "agents", rel.slice("agents/".length))
        : join(root, ".claude", "skills", rel);
      expect(await readFile(target)).toEqual(await readFile(join(bundle, rel)));
    }
    // agents 定义不再重复安装到 .claude/skills/agents/。
    expect(await pathExists(join(root, ".claude", "skills", "agents"))).toBe(false);
  });

  it("removes Java-only managed files when switching to general", async () => {
    expect(await run(["--profile", "java", "--non-interactive", "--yes"])).toBe(0);
    expect(await pathExists(join(root, ".claude", "skills", "harness-apidoc", "SKILL.md"))).toBe(true);
    expect(await run(["--profile", "general", "--non-interactive", "--yes"])).toBe(0);
    expect(await pathExists(join(root, ".claude", "skills", "harness-apidoc", "SKILL.md"))).toBe(false);
    expect(await pathExists(join(root, ".claude", "rules", "harness-profile-java.md"))).toBe(false);
  });

  it("does not delete an arbitrary path named by forged local bundle state", async () => {
    expect(await run(["--profile", "general", "--non-interactive", "--yes"])).toBe(0);
    const notePath = join(root, "notes.txt");
    await writeFile(notePath, "keep this user file\n");
    await writeFile(
      join(root, ".harness", "state", "local", "installed-harness-bundle.json"),
      JSON.stringify({ schema_version: 1, profile: "general", files: ["notes.txt"] })
    );

    // 伪造的 v1 state 的 files 列表（含 notes.txt）不得授权删除/覆盖：删除目标只来自 Bundle 投影
    // 或迁移 manifest，绝不来自 state 文件。notes.txt 不在任何投影中，永不被删/被覆盖。
    // 若当前 Bundle hash 无法匹配 0.1.1 migration，刷新可能因 LEGACY_BASELINE_UNKNOWN 返回 exit 5。
    const code = await run(["--profile", "java", "--non-interactive", "--yes"]);
    expect([0, 5]).toContain(code);
    expect(await readFile(notePath, "utf8")).toBe("keep this user file\n");
  });
});
