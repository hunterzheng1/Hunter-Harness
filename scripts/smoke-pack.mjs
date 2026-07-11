import { mkdtemp, readdir, rm, stat, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { URL } from "node:url";

const root = new URL("../", import.meta.url);
const temporary = await mkdtemp(join(tmpdir(), "hunter-pack-smoke-"));
const npmCli = process.env.npm_execpath;
if (npmCli === undefined) {
  throw new Error("npm_execpath is required to run the package smoke test");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    shell: false
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`
    );
  }
  return result.stdout ?? "";
}

function assert(condition, message) {
  if (!condition) throw new Error("smoke assertion failed: " + message);
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

try {
  run(process.execPath, [npmCli, "pack", "-w", "packages/cli", "--pack-destination", temporary]);
  const archive = (await readdir(temporary)).find((name) => name.endsWith(".tgz"));
  if (archive === undefined) throw new Error("npm pack did not create an archive");
  run(process.execPath, [npmCli, "install", "--prefix", temporary, "--ignore-scripts", join(temporary, archive)]);

  const packagedRoot = join(temporary, "node_modules", "hunter-harness");
  // 无 legacy CLI resource 树。
  for (const legacyResource of ["bootstrap-ir", "skills"]) {
    assert(await exists(join(packagedRoot, "resources", legacyResource)) === false,
      `packaged CLI must not contain legacy resource: ${legacyResource}`);
  }
  // tarball 含当前 Bundles + 可信迁移 manifest。
  assert(await exists(join(packagedRoot, "resources", "harness", "manifests", "general.json")),
    "packaged CLI missing general manifest");
  assert(await exists(join(packagedRoot, "resources", "harness", "migrations", "0.1.1", "general.json")),
    "packaged CLI missing 0.1.1 general migration manifest");
  assert(await exists(join(packagedRoot, "resources", "harness", "migrations", "0.1.1", "java.json")),
    "packaged CLI missing 0.1.1 java migration manifest");

  const bin = join(packagedRoot, "dist", "bin.js");
  const preview = run(process.execPath, [bin, "--profile", "java", "--non-interactive", "--dry-run", "--json"],
    { cwd: temporary, capture: true });
  const previewResult = JSON.parse(preview.trim());
  if (previewResult.ok !== true || previewResult.dry_run !== true) {
    throw new Error("packaged CLI dry-run output is invalid");
  }
  assert(await exists(join(temporary, ".harness")) === false, "dry-run wrote project state");

  // 首次 general 安装 + Conservative Refresh + Profile Transition + 冲突保留。
  const project = await mkdtemp(join(tmpdir(), "hunter-pack-smoke-"));
  try {
    // 用户既有 AGENTS/CLAUDE 内容必须保留。
    await writeFile(join(project, "CLAUDE.md"), "# User Claude\nkeep this.\n");
    await writeFile(join(project, "AGENTS.md"), "# User Agents\nkeep this too.\n");

    run(process.execPath, [bin, "--profile", "general", "--non-interactive", "--yes"],
      { cwd: project, capture: true });
    await stat(join(project, ".claude", "skills", "harness-review", "SKILL.md"));
    // agents 仅安装到 .claude/agents，不创建 .claude/skills/agents/。
    assert(await exists(join(project, ".claude", "skills", "agents")) === false,
      "general install must not create .claude/skills/agents");
    assert(await exists(join(project, ".claude", "agents", "harness-reviewer.md")),
      "general install must create .claude/agents/harness-reviewer.md");
    // 最小 .harness 布局：无 cache/reports/.gitkeep/README。
    assert(await exists(join(project, ".harness", "cache")) === false, "must not pre-create cache");
    assert(await exists(join(project, ".harness", "reports")) === false, "must not pre-create reports");
    assert(await exists(join(project, ".harness", "README.md")) === false, "must not generate README");
    assert(await exists(join(project, ".harness", "state", "local", "installed-harness-bundle.json")),
      "must write schema-v2 installed state");
    // 用户 AGENTS/CLAUDE 内容保留。
    const claude = await readFile(join(project, "CLAUDE.md"), "utf8");
    assert(claude.includes("# User Claude") && claude.includes("hunter-harness:start"),
      "CLAUDE.md user content + managed block not preserved");
    const agents = await readFile(join(project, "AGENTS.md"), "utf8");
    assert(agents.includes("# User Agents"), "AGENTS.md user content not preserved");

    // 重跑 bare CLI → Conservative Refresh（不重置）。
    const beforeProject = await readFile(join(project, ".harness", "project.yaml"), "utf8");
    run(process.execPath, [bin, "--non-interactive", "--yes"], { cwd: project, capture: true });
    const afterProject = await readFile(join(project, ".harness", "project.yaml"), "utf8");
    assert(beforeProject === afterProject, "refresh must not reset project identity");

    // 用户修改受管文件 → refresh 保留并 exit 5。
    const reviewer = join(project, ".claude", "agents", "harness-reviewer.md");
    await writeFile(reviewer, "user modified\n");
    const conflictRun = spawnSync(process.execPath,
      [bin, "refresh", "--non-interactive", "--yes", "--json"],
      { cwd: project, encoding: "utf8", shell: false });
    assert(conflictRun.status === 5, `modified-managed refresh should exit 5, got ${conflictRun.status}`);
    assert((await readFile(reviewer, "utf8")) === "user modified\n",
      "modified managed file must be preserved");
    // --force-managed 替换。
    run(process.execPath, [bin, "refresh", "--non-interactive", "--yes", "--force-managed"],
      { cwd: project, capture: true });
    assert((await readFile(reviewer, "utf8")) !== "user modified\n",
      "--force-managed must replace modified managed file");

    // General → Java transition。
    run(process.execPath, [bin, "--profile", "java", "--non-interactive", "--yes"],
      { cwd: project, capture: true });
    await stat(join(project, ".claude", "skills", "harness-apidoc", "SKILL.md"));
    await stat(join(project, ".claude", "rules", "harness-profile-java.md"));
  } finally {
    await rm(project, { recursive: true, force: true });
  }

  // Java 首次安装独立校验（harness-apidoc 存在）。
  const javaProject = await mkdtemp(join(tmpdir(), "hunter-pack-smoke-"));
  try {
    run(process.execPath, [bin, "--profile", "java", "--non-interactive", "--yes"],
      { cwd: javaProject, capture: true });
    await stat(join(javaProject, ".claude", "skills", "harness-apidoc", "SKILL.md"));
    assert(await exists(join(javaProject, ".claude", "skills", "agents")) === false,
      "java install must not create .claude/skills/agents");
  } finally {
    await rm(javaProject, { recursive: true, force: true });
  }

  run(process.execPath, [npmCli, "pack", "-w", "packages/skill-cli", "--pack-destination", temporary]);
  const skillArchive = (await readdir(temporary)).find((name) =>
    name.startsWith("hunter-harness-skill-cli-") && name.endsWith(".tgz")
  );
  if (skillArchive === undefined) throw new Error("npm pack did not create the Skill CLI archive");
  run(process.execPath, [npmCli, "install", "--prefix", temporary, "--ignore-scripts", join(temporary, skillArchive)]);
  const skillBin = join(temporary, "node_modules", "@hunter-harness", "skill-cli", "dist", "bin.js");
  const skillHelp = run(process.execPath, [skillBin, "--help"], { cwd: temporary, capture: true });
  if (!skillHelp.includes("install") || !skillHelp.includes("upload") ||
    /\b(search|download|update|uninstall|publish)\b/.test(skillHelp)) {
    throw new Error("packaged Skill CLI command surface is invalid");
  }
  process.stdout.write("packaged project CLI and Skill CLI smoke tests passed\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
