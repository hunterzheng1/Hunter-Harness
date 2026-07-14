import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { runCli } from "../src/bin.js";

const resourcesRoot = fileURLToPath(new URL("../../workflow-data-harness", import.meta.url));

async function pathExists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

describe("hunter-harness refresh CLI", () => {
  let root: string;
  let stdout: string[];
  let stderr: string[];

  async function run(args: string[]): Promise<number> {
    return runCli(args, {
      cwd: root,
      resourcesRoot,
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value)
    });
  }

  it("refreshes an existing project via the explicit subcommand and emits JSON", async () => {
    root = await mkdtemp(join(tmpdir(), "hunter-refresh-cli-"));
    stdout = []; stderr = [];
    expect(await run(["--profile", "general", "--non-interactive", "--yes"])).toBe(0);
    // 删掉一个 Bundle 目标，refresh 应补回。
    await rm(join(root, ".claude", "agents", "harness-reviewer.md"), { force: true });

    stdout = []; stderr = [];
    const code = await run(["refresh", "--non-interactive", "--yes", "--json"]);
    expect(code).toBe(0);
    const output = JSON.parse(stdout.join("")) as {
      command: string; ok: boolean; exit_code: number;
      summary: { applied: number; conflicts: number };
    };
    expect(output.command).toBe("refresh");
    expect(output.ok).toBe(true);
    expect(output.exit_code).toBe(0);
    expect(output.summary.applied).toBeGreaterThanOrEqual(1);
    expect(await pathExists(join(root, ".claude", "agents", "harness-reviewer.md"))).toBe(true);
  });

  it("reports exit code 5 when a managed file is modified and preserves it", async () => {
    root = await mkdtemp(join(tmpdir(), "hunter-refresh-conflict-cli-"));
    stdout = []; stderr = [];
    expect(await run(["--profile", "general", "--non-interactive", "--yes"])).toBe(0);
    const target = join(root, ".claude", "agents", "harness-reviewer.md");
    await writeFile(target, "user modified\n");

    stdout = []; stderr = [];
    const code = await run(["refresh", "--non-interactive", "--yes", "--json"]);
    expect(code).toBe(5);
    expect(await readFile(target, "utf8")).toBe("user modified\n");
  });

  it("--force-managed replaces a modified managed target via CLI", async () => {
    root = await mkdtemp(join(tmpdir(), "hunter-refresh-force-cli-"));
    stdout = []; stderr = [];
    expect(await run(["--profile", "general", "--non-interactive", "--yes"])).toBe(0);
    const target = join(root, ".claude", "agents", "harness-reviewer.md");
    await writeFile(target, "user modified\n");

    stdout = []; stderr = [];
    const code = await run(["refresh", "--non-interactive", "--yes", "--force-managed", "--json"]);
    expect(code).toBe(0);
    const incoming = await readFile(join(
      resourcesRoot, "harness", "bundles", "general", "claude-code", "agents", "harness-reviewer.md"
    ));
    expect(await readFile(target)).toEqual(incoming);
  });

  it("refuses to refresh an uninitialized project", async () => {
    root = await mkdtemp(join(tmpdir(), "hunter-refresh-absent-"));
    stdout = []; stderr = [];
    const code = await run(["refresh", "--non-interactive", "--yes"]);
    expect(code).toBe(3);
  });

  it("bare command on existing project performs refresh (no reset)", async () => {
    root = await mkdtemp(join(tmpdir(), "hunter-refresh-bare-"));
    stdout = []; stderr = [];
    expect(await run(["--profile", "general", "--non-interactive", "--yes"])).toBe(0);
    const projectBefore = await readFile(join(root, ".harness", "project.yaml"), "utf8");
    stdout = []; stderr = [];
    expect(await run(["--non-interactive", "--yes"])).toBe(0);
    expect(await readFile(join(root, ".harness", "project.yaml"), "utf8")).toBe(projectBefore);
  });

  it("shows a profile-transition plan before asking for confirmation", async () => {
    root = await mkdtemp(join(tmpdir(), "hunter-refresh-preview-"));
    stdout = []; stderr = [];
    expect(await run(["--profile", "general", "--non-interactive", "--yes"])).toBe(0);

    let outputBeforeConfirmation = "";
    const code = await runCli(["refresh", "--profile", "java"], {
      cwd: root,
      resourcesRoot,
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      prompt: async () => {
        outputBeforeConfirmation = stdout.join("");
        return "yes";
      }
    });

    expect(code).toBe(0);
    expect(outputBeforeConfirmation).toContain("配置切换预览");
    expect(outputBeforeConfirmation).toContain("harness-apidoc");
  });

  it("adds or refreshes --agents without disabling unselected agents", async () => {
    root = await mkdtemp(join(tmpdir(), "hunter-refresh-agents-"));
    stdout = []; stderr = [];
    expect(await run([
      "--agents", "claude-code",
      "--profile", "general",
      "--non-interactive",
      "--yes"
    ])).toBe(0);

    const code = await run([
      "refresh",
      "--agents", "codex,cursor",
      "--non-interactive",
      "--yes"
    ]);

    expect(code).toBe(0);
    const project = parseYaml(await readFile(join(root, ".harness", "project.yaml"), "utf8")) as {
      adapters: { enabled: string[] };
    };
    expect(project.adapters.enabled).toEqual(["claude-code", "codex", "cursor"]);
    expect(await pathExists(join(root, ".agents", "skills", "harness-review", "SKILL.md"))).toBe(true);
    expect(await pathExists(join(root, ".cursor", "skills", "harness-review", "SKILL.md"))).toBe(true);
    expect(await pathExists(join(root, ".claude", "skills", "harness-review", "SKILL.md"))).toBe(true);
  }, 120000);

  it("rejects an unknown --agents value without changing the project", async () => {
    root = await mkdtemp(join(tmpdir(), "hunter-refresh-agents-invalid-"));
    stdout = []; stderr = [];
    expect(await run(["--profile", "general", "--non-interactive", "--yes"])).toBe(0);
    const before = await readFile(join(root, ".harness", "project.yaml"), "utf8");

    const code = await run(["refresh", "--agents", "gpt", "--non-interactive", "--yes"]);

    expect(code).toBe(3);
    expect(stderr.join("")).toContain("AGENT_UNSUPPORTED");
    expect(await readFile(join(root, ".harness", "project.yaml"), "utf8")).toBe(before);
  }, 120000);

  it("uses the project agent set when --agents is omitted", async () => {
    root = await mkdtemp(join(tmpdir(), "hunter-refresh-agents-default-"));
    stdout = []; stderr = [];
    expect(await run([
      "--agents", "codex,cursor",
      "--profile", "general",
      "--non-interactive",
      "--yes"
    ])).toBe(0);
    await rm(join(root, ".agents", "skills", "harness-review", "SKILL.md"), { force: true });

    expect(await run(["refresh", "--non-interactive", "--yes"])).toBe(0);
    expect(await pathExists(join(root, ".agents", "skills", "harness-review", "SKILL.md"))).toBe(true);
    expect(await pathExists(join(root, ".claude", "skills", "harness-review", "SKILL.md"))).toBe(false);
  }, 120000);

  it("shows every current Agent/Profile and updates only the interactive selection", async () => {
    root = await mkdtemp(join(tmpdir(), "hunter-refresh-interactive-"));
    stdout = []; stderr = [];
    expect(await run([
      "--agents", "codex,cursor",
      "--profile", "general",
      "--non-interactive",
      "--yes"
    ])).toBe(0);

    const questions: string[] = [];
    const answers = ["1", "3", "2"];
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
    expect(questions[1]).toContain("Codex：general");
    expect(questions[1]).toContain("Cursor：general");
    expect(questions[1]).toContain("未选择的工具保持不变");
    expect(await pathExists(join(root, ".cursor", "skills", "harness-apidoc", "SKILL.md"))).toBe(true);
    expect(await pathExists(join(root, ".agents", "skills", "harness-apidoc", "SKILL.md"))).toBe(false);
    const state = JSON.parse(await readFile(
      join(root, ".harness", "state", "local", "installed-harness-bundle.json"),
      "utf8"
    )) as { profiles: Record<string, string> };
    expect(state.profiles).toEqual({ codex: "general", cursor: "java" });
  }, 120000);
});
