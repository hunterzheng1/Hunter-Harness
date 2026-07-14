import { mkdtemp, readdir, rm, stat, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const rootDir = fileURLToPath(root);
const temporary = await mkdtemp(join(tmpdir(), "hunter-pack-smoke-"));
const npmCli = process.env.npm_execpath;
if (npmCli === undefined) {
  throw new Error("npm_execpath is required to run the package smoke test");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? rootDir,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    shell: false,
    timeout: options.timeout ?? 0,
    env: {
      ...process.env,
      npm_config_prefer_offline: "true",
      npm_config_fetch_retries: "2",
      npm_config_fetch_timeout: "60000",
      npm_config_fetch_retry_mintimeout: "10000",
      npm_config_fetch_retry_maxtimeout: "20000",
      ...(options.env ?? {})
    }
  });
  if (result.error !== undefined) {
    throw new Error(
      `${command} ${args.join(" ")} failed to start: ${result.error.message}`
    );
  }
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
  run(process.execPath, [npmCli, "pack", "-w", "packages/workflow-data-harness", "--pack-destination", temporary]);
  const dataArchive = (await readdir(temporary)).find((name) =>
    name.startsWith("hunter-harness-workflow-harness-") && name.endsWith(".tgz")
  );
  if (dataArchive === undefined) throw new Error("npm pack did not create the workflow data archive");

  run(process.execPath, [npmCli, "pack", "-w", "packages/cli", "--pack-destination", temporary]);
  const archive = (await readdir(temporary)).find((name) =>
    name.startsWith("hunter-harness-") && name.endsWith(".tgz") && !name.includes("workflow-harness")
  );
  if (archive === undefined) throw new Error("npm pack did not create the CLI archive");
  // Install both local archives in one dependency resolution. The packaged CLI
  // can then be executed with arbitrary cwd values; isolated projects do not
  // need their own duplicate node_modules trees.
  run(process.execPath, [
    npmCli, "install", "--prefix", temporary, "--ignore-scripts", "--omit=optional",
    join(temporary, dataArchive), join(temporary, archive)
  ], { timeout: 180_000 });

  const packagedRoot = join(temporary, "node_modules", "hunter-harness");
  const workflowDataRoot = join(temporary, "node_modules", "@hunter-harness", "workflow-harness");
  // CLI tarball 不再内嵌 harness 资源树。
  assert(await exists(join(packagedRoot, "resources", "harness")) === false,
    "packaged CLI must not embed resources/harness");
  for (const legacyResource of ["bootstrap-ir", "skills"]) {
    assert(await exists(join(packagedRoot, "resources", legacyResource)) === false,
      `packaged CLI must not contain legacy resource: ${legacyResource}`);
  }
  // 工作流数据包含 2 profile × 4 agent Bundles + 可信迁移 manifest。
  for (const profile of ["general", "java"]) {
    for (const agent of ["claude-code", "codex", "cursor", "codebuddy"]) {
      assert(await exists(join(
        workflowDataRoot, "harness", "bundles", profile, agent
      )), `workflow data package missing ${profile}/${agent} bundle`);
      assert(await exists(join(
        workflowDataRoot, "harness", "manifests", profile, `${agent}.json`
      )), `workflow data package missing ${profile}/${agent} manifest`);
    }
  }
  assert(await exists(join(workflowDataRoot, "harness", "migrations", "0.1.1", "general.json")),
    "workflow data package missing 0.1.1 general migration manifest");
  assert(await exists(join(workflowDataRoot, "harness", "migrations", "0.1.1", "java.json")),
    "workflow data package missing 0.1.1 java migration manifest");

  const bin = join(packagedRoot, "dist", "bin.js");
  const preview = run(process.execPath, [bin, "--agents", "all", "--profile", "java", "--non-interactive", "--dry-run", "--json"],
    { cwd: temporary, capture: true });
  const previewResult = JSON.parse(preview.trim());
  if (previewResult.ok !== true || previewResult.dry_run !== true) {
    throw new Error("packaged CLI dry-run output is invalid");
  }
  assert(await exists(join(temporary, ".harness")) === false, "dry-run wrote project state");

  // 四 Agent general 安装 + 幂等 refresh + 冲突保留 + Agent transition。
  const project = await mkdtemp(join(tmpdir(), "hunter-pack-smoke-"));
  try {
    const projectBin = bin;
    // 用户既有 AGENTS/CLAUDE 内容必须保留。
    await writeFile(join(project, "CLAUDE.md"), "# User Claude\nkeep this.\n");
    await writeFile(join(project, "AGENTS.md"), "# User Agents\nkeep this too.\n");

    run(process.execPath, [projectBin, "--agents", "all", "--profile", "general", "--non-interactive", "--yes"],
      { cwd: project, capture: true });
    await stat(join(project, ".claude", "skills", "harness-review", "SKILL.md"));
    await stat(join(project, ".agents", "skills", "harness-review", "SKILL.md"));
    for (const supportFile of ["SKILL.md", "protocols.md", "reference.md", "checklist.md"]) {
      await stat(join(project, ".agents", "skills", "harness-run", supportFile));
    }
    await stat(join(project, ".cursor", "skills", "harness-review", "SKILL.md"));
    await stat(join(project, ".codebuddy", "skills", "harness-review", "SKILL.md"));
    await stat(join(project, ".codebuddy", "agents", "harness-reviewer.md"));
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
      "must write schema-v3 installed state");
    // 用户 AGENTS/CLAUDE 内容保留。
    const claude = await readFile(join(project, "CLAUDE.md"), "utf8");
    assert(claude.includes("# User Claude") && claude.includes("hunter-harness:start"),
      "CLAUDE.md user content + managed block not preserved");
    const agents = await readFile(join(project, "AGENTS.md"), "utf8");
    assert(agents.includes("# User Agents"), "AGENTS.md user content not preserved");

    // 重跑相同多 Agent 命令必须保持受管文件字节不变。
    const beforeProject = await readFile(join(project, ".harness", "project.yaml"), "utf8");
    const beforeSkills = await Promise.all([
      readFile(join(project, ".claude", "skills", "harness-review", "SKILL.md")),
      readFile(join(project, ".agents", "skills", "harness-review", "SKILL.md")),
      readFile(join(project, ".cursor", "skills", "harness-review", "SKILL.md")),
      readFile(join(project, ".codebuddy", "skills", "harness-review", "SKILL.md"))
    ]);
    run(process.execPath, [projectBin, "--agents", "all", "--non-interactive", "--yes"], { cwd: project, capture: true });
    const afterProject = await readFile(join(project, ".harness", "project.yaml"), "utf8");
    assert(beforeProject === afterProject, "refresh must not reset project identity");
    const afterSkills = await Promise.all([
      readFile(join(project, ".claude", "skills", "harness-review", "SKILL.md")),
      readFile(join(project, ".agents", "skills", "harness-review", "SKILL.md")),
      readFile(join(project, ".cursor", "skills", "harness-review", "SKILL.md")),
      readFile(join(project, ".codebuddy", "skills", "harness-review", "SKILL.md"))
    ]);
    assert(beforeSkills.every((bytes, index) => bytes.equals(afterSkills[index])),
      "identical multi-agent install changed managed skill bytes");

    // 用户修改 Codex Bundle working copy → refresh 保留并 exit 5。
    const reviewer = join(project, ".agents", "skills", "harness-review", "SKILL.md");
    await writeFile(reviewer, "user modified\n");
    const conflictRun = spawnSync(process.execPath,
      [projectBin, "refresh", "--non-interactive", "--yes", "--json"],
      { cwd: project, encoding: "utf8", shell: false });
    assert(conflictRun.status === 5, `modified-managed refresh should exit 5, got ${conflictRun.status}`);
    assert((await readFile(reviewer, "utf8")) === "user modified\n",
      "modified managed file must be preserved");
    // --force-managed 替换。
    run(process.execPath, [projectBin, "refresh", "--non-interactive", "--yes", "--force-managed"],
      { cwd: project, capture: true });
    assert((await readFile(reviewer, "utf8")) !== "user modified\n",
      "--force-managed must replace modified managed file");

    // 只选择 Cursor 并切到 Java：其他 Agent 命名空间必须完全保留。
    const claudeBefore = await readFile(join(project, ".claude", "skills", "harness-review", "SKILL.md"));
    const codexBefore = await readFile(join(project, ".agents", "skills", "harness-review", "SKILL.md"));
    run(process.execPath, [projectBin, "refresh", "--agents", "cursor", "--profile", "java", "--non-interactive", "--yes"],
      { cwd: project, capture: true });
    await stat(join(project, ".cursor", "skills", "harness-review", "SKILL.md"));
    await stat(join(project, ".cursor", "rules", "harness-profile-java.mdc"));
    assert((await readFile(join(project, ".claude", "skills", "harness-review", "SKILL.md"))).equals(claudeBefore),
      "unselected Claude bundle must remain byte-for-byte unchanged");
    assert((await readFile(join(project, ".agents", "skills", "harness-review", "SKILL.md"))).equals(codexBefore),
      "unselected Codex bundle must remain byte-for-byte unchanged");
    await stat(join(project, ".codebuddy", "skills", "harness-review", "SKILL.md"));
    assert((await readFile(join(project, "CLAUDE.md"), "utf8")).includes("# User Claude"),
      "unselected Claude instructions must remain present");
  } finally {
    await rm(project, { recursive: true, force: true });
  }

  // Java 首次安装独立校验（harness-apidoc 存在）。
  const javaProject = await mkdtemp(join(tmpdir(), "hunter-pack-smoke-"));
  try {
    const javaBin = bin;
    run(process.execPath, [javaBin, "--profile", "java", "--non-interactive", "--yes"],
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
  run(process.execPath, [npmCli, "install", "--prefix", temporary, "--ignore-scripts", "--omit=optional", join(temporary, skillArchive)], { timeout: 180_000 });
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
