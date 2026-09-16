import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { uninstallHarness } from "../src/index.js";

const INSTALLED_STATE_PATH = ".harness/state/local/installed-harness-bundle.json";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hunter-uninstall-"));
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

const MANAGED_BODY = "managed skill bytes\n";
const MCP_ENTRY = { command: "codegraph", args: ["serve", "--mcp"] };

/** 最小 v1.0 项目 fixture：v5 状态 + 受管 skill + 带受管块的 AGENTS.md。 */
async function seedProject(root: string): Promise<void> {
  await mkdir(join(root, ".agents", "skills", "harness-review"), { recursive: true });
  await mkdir(join(root, ".codebuddy", "skills", "harness-review"), { recursive: true });
  await mkdir(join(root, ".harness", "state", "local"), { recursive: true });
  await writeFile(join(root, ".agents", "skills", "harness-review", "SKILL.md"), MANAGED_BODY);
  await writeFile(join(root, ".codebuddy", "skills", "harness-review", "SKILL.md"), MANAGED_BODY);
  await writeFile(
    join(root, "AGENTS.md"),
    "# My Project\n\nuser words\n\n" +
    "<!-- hunter-harness:start hunter-harness-core -->\ncore block\n<!-- hunter-harness:end -->\n" +
    "<!-- hunter-harness:start hunter-harness-learned-rules -->\nrules block\n<!-- hunter-harness:end -->\n"
  );
  await writeFile(join(root, ".harness", "project.yaml"), "schema_version: 2\nproject:\n  name: t\n");
  // 状态文件 sha256 为裸 hex（与 bundle manifest 及 refresh 校验一致）。
  const hash = createHash("sha256").update(MANAGED_BODY, "utf8").digest("hex");
  const files = [
    ".agents/skills/harness-review/SKILL.md",
    ".codebuddy/skills/harness-review/SKILL.md"
  ].map((target) => ({
    owner: target.startsWith(".agents") ? "codex" : "codebuddy",
    source_path: `harness-review/SKILL.md`,
    target_path: target,
    sha256: hash
  }));
  await writeFile(join(root, INSTALLED_STATE_PATH), JSON.stringify({
    schema_version: 5,
    surfaces: ["codex", "codebuddy"],
    bundle_version: "1.0.0",
    files,
    managed_blocks: []
  }, null, 2) + "\n");
}

describe("uninstall engine (v1.0)", () => {
  it("dry-run reports actions without touching the disk", async () => {
    const root = await makeRoot();
    await seedProject(root);
    const stateBefore = await readFile(join(root, INSTALLED_STATE_PATH), "utf8");

    const report = await uninstallHarness({ projectRoot: root, dryRun: true });

    expect(report.dry_run).toBe(true);
    expect(report.counts.deleted).toBeGreaterThan(0);
    expect(await readFile(join(root, ".agents", "skills", "harness-review", "SKILL.md"), "utf8"))
      .toBe(MANAGED_BODY);
    expect(await readFile(join(root, INSTALLED_STATE_PATH), "utf8")).toBe(stateBefore);
  });

  it("removes clean managed files, strips managed blocks, and deletes .harness", async () => {
    const root = await makeRoot();
    await seedProject(root);

    const report = await uninstallHarness({ projectRoot: root, dryRun: false });

    expect(await exists(join(root, ".agents"))).toBe(false);
    expect(await exists(join(root, ".codebuddy"))).toBe(false);
    expect(await exists(join(root, ".harness"))).toBe(false);
    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(agents).toContain("# My Project");
    expect(agents).toContain("user words");
    expect(agents).not.toContain("hunter-harness:start");
    expect(report.counts.stripped).toBeGreaterThan(0);
  });

  it("skips locally modified managed files and protects them from the prefix sweep", async () => {
    const root = await makeRoot();
    await seedProject(root);
    const edited = join(root, ".agents", "skills", "harness-review", "SKILL.md");
    await writeFile(edited, "user edited\n");

    const report = await uninstallHarness({ projectRoot: root, dryRun: false });

    expect(await readFile(edited, "utf8")).toBe("user edited\n");
    expect(report.actions.some((a) =>
      a.kind === "skip" && a.path.includes("harness-review")
    )).toBe(true);
    expect(report.warnings.some((w) => w.includes("本地修改"))).toBe(true);
    // codebuddy 面干净副本仍被删除。
    expect(await exists(join(root, ".codebuddy"))).toBe(false);
  });

  it("sweeps 0.x harness-prefixed residue without touching foreign entries", async () => {
    const root = await makeRoot();
    await seedProject(root);
    await mkdir(join(root, ".claude", "skills", "harness-old"), { recursive: true });
    await writeFile(join(root, ".claude", "skills", "harness-old", "SKILL.md"), "legacy\n");
    await mkdir(join(root, ".claude", "skills", "my-skill"), { recursive: true });
    await writeFile(join(root, ".claude", "skills", "my-skill", "SKILL.md"), "mine\n");
    await writeFile(join(root, "CLAUDE.md"),
      "# User\n<!-- hunter-harness:start hunter-harness-core -->\nold\n<!-- hunter-harness:end -->\n");

    await uninstallHarness({ projectRoot: root, dryRun: false });

    expect(await exists(join(root, ".claude", "skills", "harness-old", "SKILL.md"))).toBe(false);
    expect(await readFile(join(root, ".claude", "skills", "my-skill", "SKILL.md"), "utf8"))
      .toBe("mine\n");
    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe("# User\n");
  });

  it("deletes an instruction file that only contains managed blocks", async () => {
    const root = await makeRoot();
    await seedProject(root);
    await writeFile(join(root, "AGENTS.md"),
      "<!-- hunter-harness:start hunter-harness-core -->\nonly managed\n<!-- hunter-harness:end -->\n");

    await uninstallHarness({ projectRoot: root, dryRun: false });

    expect(await exists(join(root, "AGENTS.md"))).toBe(false);
  });

  it("strips an unmodified harness MCP entry and keeps modified ones", async () => {
    const root = await makeRoot();
    await seedProject(root);
    await writeFile(join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { codegraph: MCP_ENTRY, other: { command: "x" } } }) + "\n");

    await uninstallHarness({ projectRoot: root, dryRun: false });

    const mcp = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.codegraph).toBeUndefined();
    expect(mcp.mcpServers.other).toEqual({ command: "x" });

    const root2 = await makeRoot();
    await seedProject(root2);
    await writeFile(join(root2, ".mcp.json"),
      JSON.stringify({ mcpServers: { codegraph: { command: "codegraph", args: ["edited"] } } }) + "\n");

    const report = await uninstallHarness({ projectRoot: root2, dryRun: false });

    expect(JSON.parse(await readFile(join(root2, ".mcp.json"), "utf8")).mcpServers.codegraph)
      .toEqual({ command: "codegraph", args: ["edited"] });
    expect(report.warnings.some((w) => w.includes(".mcp.json"))).toBe(true);
  });

  it("--keep-data preserves .harness/state but removes project config", async () => {
    const root = await makeRoot();
    await seedProject(root);

    await uninstallHarness({ projectRoot: root, dryRun: false, keepData: true });

    expect(await exists(join(root, INSTALLED_STATE_PATH))).toBe(true);
    expect(await exists(join(root, ".harness", "project.yaml"))).toBe(false);
    expect(await exists(join(root, ".agents"))).toBe(false);
  });

  it("falls back to prefix sweeping with a warning when state is a 0.x format", async () => {
    const root = await makeRoot();
    await mkdir(join(root, ".harness", "state", "local"), { recursive: true });
    await writeFile(join(root, INSTALLED_STATE_PATH), JSON.stringify({ schema_version: 3 }));
    await mkdir(join(root, ".agents", "skills", "harness-legacy"), { recursive: true });
    await writeFile(join(root, ".agents", "skills", "harness-legacy", "SKILL.md"), "old\n");

    const report = await uninstallHarness({ projectRoot: root, dryRun: false });

    expect(report.warnings.some((w) => w.includes("0.x"))).toBe(true);
    expect(await exists(join(root, ".agents"))).toBe(false);
  });

  it("refuses state paths escaping the project root", async () => {
    const root = await makeRoot();
    await seedProject(root);
    const state = JSON.parse(await readFile(join(root, INSTALLED_STATE_PATH), "utf8"));
    state.files.push({
      owner: "codex",
      source_path: "x",
      target_path: "../outside.txt",
      sha256: "whatever"
    });
    await writeFile(join(root, INSTALLED_STATE_PATH), JSON.stringify(state));
    const outside = join(root, "..", "outside.txt");
    await writeFile(outside, "do not touch\n");

    try {
      const report = await uninstallHarness({ projectRoot: root, dryRun: false });

      expect(report.warnings.some((w) => w.includes("越界"))).toBe(true);
      expect(await exists(outside)).toBe(true);
    } finally {
      await rm(outside, { force: true });
    }
  });

  it("parses a 0.x (v4) state and precisely deletes tracked files including bundle extras", async () => {
    const root = await makeRoot();
    // 0.x 现场：多面投影，附属内容不在 skills 名册里但由状态记录（schema 2 无 owner）。
    const tracked: Array<{ target: string; body: string; owner?: string }> = [
      { target: ".pi/skills/harness-review/SKILL.md", body: "pi skill\n", owner: "pi" },
      { target: ".pi/skills/contracts/x.md", body: "contracts\n", owner: "pi" },
      { target: ".pi/skills/.harness-build.json", body: "{\"agent\":\"pi\"}\n" },
      { target: ".codebuddy/skills/scripts/a.py", body: "print(1)\n", owner: "codebuddy" }
    ];
    for (const { target, body } of tracked) {
      const abs = join(root, ...target.split("/"));
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, body);
    }
    // 未记录进状态的历史投影：由前缀清扫兜底删除。
    await mkdir(join(root, ".pi", "skills", "harness-run"), { recursive: true });
    await writeFile(join(root, ".pi", "skills", "harness-run", "SKILL.md"), "untracked\n");
    await mkdir(join(root, ".harness", "state", "local"), { recursive: true });
    await writeFile(join(root, INSTALLED_STATE_PATH), JSON.stringify({
      schema_version: 4,
      adapters: ["pi", "codebuddy"],
      profiles: { pi: "general", codebuddy: "general" },
      installed_at: "2025-01-01T00:00:00.000Z",
      manifests: [],
      files: tracked.map(({ target, body, owner }) => ({
        ...(owner === undefined ? {} : { owner }),
        source_path: target.split("/").slice(1).join("/"),
        target_path: target,
        sha256: createHash("sha256").update(body, "utf8").digest("hex")
      })),
      managed_blocks: []
    }, null, 2) + "\n");

    const report = await uninstallHarness({ projectRoot: root, dryRun: false });

    expect(await exists(join(root, ".pi"))).toBe(false);
    expect(await exists(join(root, ".codebuddy"))).toBe(false);
    expect(report.warnings.some((w) => w.includes("0.x") && w.includes("精确删除"))).toBe(true);
    // 状态已精确删除附属内容，不再需要"附属残留"提示。
    expect(report.warnings.some((w) => w.includes("疑似 bundle 附属内容"))).toBe(false);
  });

  it("warns about bundle extras in every legacy skills root, not just .codebuddy", async () => {
    const root = await makeRoot();
    await mkdir(join(root, ".harness", "state", "local"), { recursive: true });
    // 无 files 记录的 0.x 状态：不可解析，退化为前缀清扫。
    await writeFile(join(root, INSTALLED_STATE_PATH), JSON.stringify({ schema_version: 3 }));
    await mkdir(join(root, ".pi", "skills", "harness-old"), { recursive: true });
    await writeFile(join(root, ".pi", "skills", "harness-old", "SKILL.md"), "old\n");
    await mkdir(join(root, ".pi", "skills", "contracts"), { recursive: true });
    await writeFile(join(root, ".pi", "skills", "contracts", "x.md"), "contracts\n");

    const report = await uninstallHarness({ projectRoot: root, dryRun: false });

    expect(await exists(join(root, ".pi", "skills", "harness-old"))).toBe(false);
    expect(await exists(join(root, ".pi", "skills", "contracts", "x.md"))).toBe(true);
    expect(report.warnings.some((w) => w.includes(".pi/skills") && w.includes("contracts"))).toBe(true);
    expect(report.warnings.some((w) => w.includes("0.x"))).toBe(true);
  });
});
