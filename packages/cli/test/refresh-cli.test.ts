import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/bin.js";

const resourcesRoot = fileURLToPath(new URL("../../workflow-data-harness", import.meta.url));

async function pathExists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

// v1.0 契约：固定 .agents 主投影 + .codebuddy/skills 双写，无 --profile/--agents。
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
    expect(await run(["--non-interactive", "--yes"])).toBe(0);
    // 删掉一个 Bundle 目标，refresh 应补回。
    await rm(join(root, ".agents", "skills", "harness-review", "SKILL.md"), { force: true });

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
    expect(await pathExists(join(root, ".agents", "skills", "harness-review", "SKILL.md"))).toBe(true);
  });

  it("reports exit code 5 when a managed file is modified and preserves it", async () => {
    root = await mkdtemp(join(tmpdir(), "hunter-refresh-conflict-cli-"));
    stdout = []; stderr = [];
    expect(await run(["--non-interactive", "--yes"])).toBe(0);
    const target = join(root, ".agents", "skills", "harness-review", "SKILL.md");
    await writeFile(target, "user modified\n");

    stdout = []; stderr = [];
    const code = await run(["refresh", "--non-interactive", "--yes", "--json"]);
    expect(code).toBe(5);
    expect(await readFile(target, "utf8")).toBe("user modified\n");
  });

  it("--force-managed replaces a modified managed target via CLI", async () => {
    root = await mkdtemp(join(tmpdir(), "hunter-refresh-force-cli-"));
    stdout = []; stderr = [];
    expect(await run(["--non-interactive", "--yes"])).toBe(0);
    const target = join(root, ".agents", "skills", "harness-review", "SKILL.md");
    await writeFile(target, "user modified\n");

    stdout = []; stderr = [];
    const code = await run(["refresh", "--non-interactive", "--yes", "--force-managed", "--json"]);
    expect(code).toBe(0);
    const incoming = await readFile(join(
      resourcesRoot, "harness", "bundles", "codex", "harness-review", "SKILL.md"
    ));
    expect(await readFile(target)).toEqual(incoming);
  });

  it("--force-managed without --yes is refused (H-17)", async () => {
    root = await mkdtemp(join(tmpdir(), "hunter-refresh-force-no-yes-"));
    stdout = []; stderr = [];
    expect(await run(["--non-interactive", "--yes"])).toBe(0);
    const target = join(root, ".agents", "skills", "harness-review", "SKILL.md");
    await writeFile(target, "user modified\n");

    stdout = []; stderr = [];
    const code = await run(["refresh", "--non-interactive", "--force-managed", "--json"]);
    expect(code).toBe(2);
    expect(stderr.join("")).toMatch(/需要 --yes|FORCE_MANAGED_REQUIRES_CONFIRM/);
    expect(await readFile(target, "utf8")).toBe("user modified\n");
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
    expect(await run(["--non-interactive", "--yes"])).toBe(0);
    const projectBefore = await readFile(join(root, ".harness", "project.yaml"), "utf8");
    stdout = []; stderr = [];
    expect(await run(["--non-interactive", "--yes"])).toBe(0);
    expect(stdout.join("")).toMatch(/工作流包 v\d+\.\d+\.\d+ · Bundle v\d+\.\d+\.\d+/);
    expect(await readFile(join(root, ".harness", "project.yaml"), "utf8")).toBe(projectBefore);
  });

  it("refresh upgrades gitignore rules idempotently", async () => {
    root = await mkdtemp(join(tmpdir(), "hunter-refresh-gitignore-"));
    stdout = []; stderr = [];
    expect(await run(["--non-interactive", "--yes"])).toBe(0);

    stdout = []; stderr = [];
    const code = await run(["refresh", "--non-interactive", "--yes", "--json"]);

    expect(code).toBe(0);
    const gitignore = await readFile(join(root, ".gitignore"), "utf8");
    expect(gitignore).toContain("/.harness/");
    expect(gitignore).toContain("/.agents/");
    expect(gitignore).toContain("/.codebuddy/");
    expect(gitignore).not.toContain("/skills/harness-*/");
  }, 120_000);
});
