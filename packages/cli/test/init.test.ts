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

function terminalCellWidth(value: string): number {
  const plain = value.replace(new RegExp(String.fromCharCode(27) + "\\[[0-?]*[ -/]*[@-~]", "g"), "");
  let width = 0;
  const graphemes = [...new Intl.Segmenter("zh-CN", { granularity: "grapheme" }).segment(plain)]
    .map((item) => item.segment);
  for (const character of graphemes) {
    if (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(character)) {
      width += 2;
      continue;
    }
    const codePoint = character.codePointAt(0) ?? 0;
    if (/\p{Mark}/u.test(character) || codePoint === 0x200d || codePoint === 0xfe0f) continue;
    width += (
      codePoint >= 0x1100 && (
        codePoint <= 0x115f ||
        codePoint === 0x2329 || codePoint === 0x232a ||
        (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
        (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
        (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
        (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
        (codePoint >= 0xff00 && codePoint <= 0xff60) ||
        (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
        (codePoint >= 0x1f300 && codePoint <= 0x1faff)
      )
    ) ? 2 : 1;
  }
  return width;
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

    const code = await run([
      "--profile", "general",
      "--non-interactive",
      "--yes",
      "--json"
    ]);

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

    const code = await run([
      "--profile", "general",
      "--non-interactive",
      "--yes",
      "--json"
    ]);

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

  it("detects an adapter build marker as partial state without recreating .harness", async () => {
    const marker = join(
      root,
      ".agents",
      "skills",
      "harness-run",
      ".harness-build.json"
    );
    await mkdir(join(marker, ".."), { recursive: true });
    await writeFile(marker, "{\"schemaVersion\":1}\n", "utf8");

    const code = await run([
      "--profile", "general",
      "--non-interactive",
      "--dry-run",
      "--json"
    ]);

    expect(code).toBe(6);
    expect(await pathExists(join(root, ".harness"))).toBe(false);
    const output = JSON.parse(stdout.join("")) as {
      errors: Array<{ sentinels: string[] }>;
    };
    expect(output.errors[0]?.sentinels).toContain(
      ".agents/skills/harness-run/.harness-build.json"
    );
  });

  it("defaults a blank non-interactive install to the general profile", async () => {
    const code = await run(["--non-interactive", "--yes"]);
    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("")).toMatch(
      /版本：CLI v\d+\.\d+\.\d+ · 工作流包 v\d+\.\d+\.\d+ · Bundle v\d+\.\d+\.\d+/
    );
    const project = parseYaml(
      await readFile(join(root, ".harness", "project.yaml"), "utf8")
    ) as { project: { profiles: string[] } };
    expect(project.project.profiles).toEqual(["general"]);
  });

  it("creates concise idempotent Git ignore rules for local Agent directories", async () => {
    await writeFile(join(root, ".gitignore"), "node_modules/\r\n", "utf8");
    const args = ["--agents", "all", "--profile", "general", "--non-interactive", "--yes"];

    expect(await run(args)).toBe(0);
    const first = await readFile(join(root, ".gitignore"), "utf8");
    expect(first).toContain("node_modules/\r\n");
    expect(first).toContain("# Hunter Harness（本地生成，不提交）");
    expect(first).toContain("/.harness/");
    expect(first).toContain("/.worktrees/");
    expect(first).toContain("/.claude/");
    expect(first).toContain("/.agents/");
    expect(first).toContain("/.cursor/");
    expect(first).toContain("/.codebuddy/");
    expect(first).not.toContain("/skills/harness-*/");

    expect(await run(args)).toBe(0);
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(first);
  }, 240_000);

  it("preserves an explicit Git ignore negation without blocking unrelated rules", async () => {
    await writeFile(join(root, ".gitignore"), "/.harness/\n!/.harness/\n", "utf8");

    expect(await run(["--profile", "general", "--non-interactive", "--yes"])).toBe(0);
    const gitignore = await readFile(join(root, ".gitignore"), "utf8");
    expect(gitignore).toContain("/.harness/\n!/.harness/\n");
    expect(gitignore.match(/^\/\.harness\/$/gm)).toHaveLength(1);
    expect(gitignore).toContain("/.worktrees/");
    expect(gitignore).toContain("/.claude/");
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
      prompt: async (question) => {
        if (question.includes("Agent")) return "";
        if (question.includes("Hunter Platform")) return "0";
        return answer;
      }
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
    expect(questions[1]).toContain("请选择 Harness 配置");
    const project = parseYaml(
      await readFile(join(root, ".harness", "project.yaml"), "utf8")
    ) as { adapters: { enabled: string[] } };
    expect(project.adapters.enabled).toEqual(["claude-code", "codex"]);
    expect(await pathExists(join(root, ".claude", "skills", "harness-review", "SKILL.md"))).toBe(true);
    expect(await pathExists(join(root, ".agents", "skills", "harness-review", "SKILL.md"))).toBe(true);
  }, 90_000);

  it("interactive first install offers optional Hunter Platform binding and can skip", async () => {
    const answers = ["1", "", "0"];
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
    expect(questions.some((question) => question.includes("关联 Hunter Platform"))).toBe(true);
    expect(questions.some((question) => question.includes("0. 跳过"))).toBe(true);
    expect(await pathExists(join(root, ".harness", "credentials.local.yaml"))).toBe(false);
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

  it("existing project home menu shows status and manage-tools labels in Chinese", async () => {
    expect(await run([
      "--agents", "1,2", "--profile", "general", "--non-interactive", "--yes"
    ])).toBe(0);
    // 2 = 管理工具 → 1 = 新增/刷新 → 0 = 取消
    const answers = ["2", "1", "0"];
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
    expect(questions[0]).toContain("一键刷新已安装工具");
    expect(questions[0]).toContain("平台连接");
    expect(stdout.join("")).toContain("Claude Code（通用）");
    expect(stdout.join("")).toContain("Codex（通用）");
    const agentPrompt = questions.find((q) => q.includes("请选择本次要新增或刷新的工具"));
    expect(agentPrompt).toBeDefined();
    expect(agentPrompt).toContain("Claude Code（已安装：通用）");
    expect(agentPrompt).toContain("Codex（已安装：通用）");
    expect(agentPrompt).toContain("5. 全部");
  }, 120_000);

  it("bound project menu offers rebind or credential removal", async () => {
    expect(await run([
      "--agents", "1", "--profile", "general", "--non-interactive", "--yes"
    ])).toBe(0);
    await writeFile(
      join(root, ".harness", "credentials.local.yaml"),
      "project_display_name: \"本地部署测试 👩🏽‍💻\\u001b[31m\\n伪造\"\nproject_id: prj_demo\nserver_url: https://platform.example.test/very/long/path\ntoken: test-token\n",
      "utf8"
    );
    const answers = ["3", "0"];
    const questions: string[] = [];

    const code = await runCli([], {
      cwd: root,
      resourcesRoot,
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      terminalColumns: 40,
      env: { COLUMNS: "120" },
      prompt: async (question) => {
        questions.push(question);
        return answers.shift() ?? "";
      }
    });

    expect(code).toBe(0);
    const output = stdout.join("");
    expect(output).toMatch(/Hunter Harness v\d+\.\d+\.\d+/);
    expect(output).toMatch(/工作流包 v\d+\.\d+\.\d+ · Bundle v\d+\.\d+\.\d+/);
    expect(output).toContain("本地部署测试 👩🏽‍💻 伪造");
    expect(output).not.toContain("\u001b");
    expect(output.split("\n").filter((line) => line === "伪造")).toHaveLength(0);
    expect(output).not.toContain("项目 prj_demo");
    const bannerLines = output.split("\n").filter((line) => /^[┌│└]/.test(line));
    expect(bannerLines.length).toBeGreaterThan(2);
    expect(new Set(bannerLines.map(terminalCellWidth)).size).toBe(1);
    expect(Math.max(...bannerLines.map(terminalCellWidth))).toBeLessThanOrEqual(40);
    expect(questions[1]).toContain("重新绑定");
    expect(questions[1]).toContain("清除本地凭据");
  }, 120_000);

  it("ignores only newly generated root instructions after a successful platform binding", async () => {
    await writeFile(join(root, "AGENTS.md"), "# 团队维护的规则\n", "utf8");
    const answers = ["1", "1", "1", "https://platform.example.test"];
    const fetch = async () => new Response(JSON.stringify({
      kind: "project-key",
      actor_id: "actor_owner",
      project_id: "prj_bound",
      project_display_name: "已绑定项目",
      scopes: ["push", "knowledge:read", "progress:write"]
    }), { status: 200, headers: { "content-type": "application/json" } });

    const code = await runCli([], {
      cwd: root,
      resourcesRoot,
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      env: {},
      fetch,
      promptSecret: async () => "hh_test_key",
      prompt: async () => answers.shift() ?? ""
    });

    expect(code).toBe(0);
    const gitignore = await readFile(join(root, ".gitignore"), "utf8");
    expect(gitignore).not.toMatch(/^\/AGENTS\.md$/m);
    expect(gitignore).toMatch(/^\/CLAUDE\.md$/m);
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe("# 团队维护的规则\n");
  }, 120_000);

  it("keeps existing agent rules isolated and offers CodeGraph MCP when CodeBuddy is selected", async () => {
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
    expect(await readFile(join(root, ".claude", "rules", "team.md"), "utf8"))
      .toBe("# Team rule\n");
    expect(await pathExists(join(root, ".harness", "rules", "team.md"))).toBe(false);
    expect(await pathExists(join(root, ".codebuddy", ".rules", "team.mdc"))).toBe(false);
    expect(stdout.join("")).toContain("instructions audit");
    const mcp = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(mcp.mcpServers.codegraph).toBeDefined();
    expect(await readFile(join(root, ".gitignore"), "utf8")).toMatch(/^\/\.mcp\.json$/m);
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
    expect(secondClaude).not.toContain("hunter-harness:start");
    expect(secondClaude).toBe("# User Claude\nKeep this.\n");
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(
      "# User Agents\nKeep this too.\n"
    );
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
