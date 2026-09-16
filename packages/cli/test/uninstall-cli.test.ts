import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/bin.js";

const resourcesRoot = fileURLToPath(new URL("../../workflow-data-harness", import.meta.url));
const INSTALLED_STATE_PATH = ".harness/state/local/installed-harness-bundle.json";
const MANAGED_BODY = "managed skill bytes\n";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hunter-uninstall-cli-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  ));
});

/** 目录与文件均判定（readFile 对目录抛 EISDIR，不能当存在性检查用）。 */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 最小 v1.0 安装现场：v5 状态 + 受管 skill + 带受管块的 AGENTS.md。 */
async function seedInstalledProject(root: string): Promise<void> {
  const { createHash } = await import("node:crypto");
  // 状态文件的 sha256 为裸 hex（与 core 精确删除的比对一致），带前缀会被判为本地改动。
  const hash = createHash("sha256").update(MANAGED_BODY).digest("hex");
  await mkdir(join(root, ".agents", "skills", "harness-review"), { recursive: true });
  await mkdir(join(root, ".harness", "state", "local"), { recursive: true });
  await writeFile(join(root, ".agents", "skills", "harness-review", "SKILL.md"), MANAGED_BODY);
  await writeFile(join(root, "AGENTS.md"),
    "# Project\n<!-- hunter-harness:start hunter-harness-core -->\ncore\n<!-- hunter-harness:end -->\n");
  await writeFile(join(root, ".harness", "project.yaml"), "schema_version: 2\nproject:\n  name: t\n");
  await writeFile(join(root, INSTALLED_STATE_PATH), JSON.stringify({
    schema_version: 5,
    surfaces: ["codex", "codebuddy"],
    bundle_version: "1.0.0",
    files: [{
      owner: "codex",
      source_path: "harness-review/SKILL.md",
      target_path: ".agents/skills/harness-review/SKILL.md",
      sha256: hash
    }],
    managed_blocks: []
  }) + "\n");
}

describe("hunter-harness uninstall CLI", () => {
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

  it("defaults to a dry-run preview that changes nothing", async () => {
    root = await makeRoot();
    await seedInstalledProject(root);
    stdout = []; stderr = [];

    const code = await run(["uninstall", "--non-interactive"]);

    expect(code).toBe(0);
    expect(stdout.join("")).toContain("预览");
    expect(await readFile(join(root, ".agents", "skills", "harness-review", "SKILL.md"), "utf8"))
      .toBe(MANAGED_BODY);
    expect(await exists(join(root, INSTALLED_STATE_PATH))).toBe(true);
  });

  it("--yes executes the removal and strips the managed AGENTS.md block", async () => {
    root = await makeRoot();
    await seedInstalledProject(root);
    stdout = []; stderr = [];

    const code = await run(["uninstall", "--non-interactive", "--yes"]);

    expect(code).toBe(0);
    expect(stdout.join("")).toContain("卸载完成");
    expect(await exists(join(root, ".agents"))).toBe(false);
    expect(await exists(join(root, ".harness"))).toBe(false);
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe("# Project\n");
  });

  it("--json emits the report with dry_run=true by default", async () => {
    root = await makeRoot();
    await seedInstalledProject(root);
    stdout = []; stderr = [];

    const code = await run(["uninstall", "--non-interactive", "--json"]);

    expect(code).toBe(0);
    const report = JSON.parse(stdout.join("")) as {
      dry_run: boolean; actions: unknown[]; counts: { deleted: number };
    };
    expect(report.dry_run).toBe(true);
    expect(report.actions.length).toBeGreaterThan(0);
    expect(await exists(join(root, INSTALLED_STATE_PATH))).toBe(true);
  });

  it("--yes --keep-data preserves .harness/state", async () => {
    root = await makeRoot();
    await seedInstalledProject(root);
    stdout = []; stderr = [];

    const code = await run(["uninstall", "--non-interactive", "--yes", "--keep-data"]);

    expect(code).toBe(0);
    expect(await exists(join(root, INSTALLED_STATE_PATH))).toBe(true);
    expect(await exists(join(root, ".harness", "project.yaml"))).toBe(false);
    expect(await exists(join(root, ".agents"))).toBe(false);
  });

  it("reports nothing to do on a clean project", async () => {
    root = await makeRoot();
    stdout = []; stderr = [];

    const code = await run(["uninstall", "--non-interactive"]);

    expect(code).toBe(0);
    expect(stdout.join("")).toContain("无需卸载");
  });
});
