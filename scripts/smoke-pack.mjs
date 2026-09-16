import { Buffer } from "node:buffer";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

import { extractHunterHarnessCommands } from "./skill-command-contract.mjs";

const root = new URL("../", import.meta.url);
const rootDir = fileURLToPath(root);
const tsc = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
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
      // Never contend with or depend on the user's global npm cache. A
      // repository-local cache avoids cross-project EPERM/lock failures while
      // retaining downloaded dependencies for faster later smoke runs.
      npm_config_cache: join(rootDir, ".cache", "npm-smoke"),
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

async function markdownFiles(rootPath) {
  const files = [];
  for (const entry of await readdir(rootPath, { withFileTypes: true })) {
    const path = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await markdownFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path);
    }
  }
  return files;
}

try {
  // npm pack runs each workspace prepack script in isolation. Build the
  // internal type dependencies first so this smoke test also works from a
  // clean checkout where contracts/core dist directories do not exist yet.
  run(process.execPath, [tsc, "-b", "packages/contracts", "packages/core"]);

  const workflowFamilyManifestPath = join(
    rootDir,
    "packages",
    "workflow-data-harness",
    "hunter-workflow-family.json"
  );
  const workflowFamilyBeforePack = await readFile(
    workflowFamilyManifestPath,
    "utf8"
  );
  run(process.execPath, [npmCli, "pack", "-w", "packages/workflow-data-harness", "--pack-destination", temporary]);
  const workflowFamilyAfterPack = await readFile(
    workflowFamilyManifestPath,
    "utf8"
  );
  assert(
    workflowFamilyAfterPack === workflowFamilyBeforePack,
    "workflow prepack changed the tracked family manifest; run `npm run sync:harness` and commit the generated manifest before packing"
  );
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
  // v1.0 数据包：拍平的 codex/codebuddy 双 surface bundle + 对应清单，无 profile 维度、无迁移 manifest。
  for (const surface of ["codex", "codebuddy"]) {
    assert(await exists(join(
      workflowDataRoot, "harness", "bundles", surface
    )), `workflow data package missing ${surface} bundle`);
    assert(await exists(join(
      workflowDataRoot, "harness", "manifests", `${surface}.json`
    )), `workflow data package missing ${surface} manifest`);
  }
  for (const retired of ["general", "java"]) {
    assert(await exists(join(workflowDataRoot, "harness", "bundles", retired)) === false,
      `workflow data package must not contain retired profile bundle: ${retired}`);
    assert(await exists(join(workflowDataRoot, "harness", "manifests", `${retired}.json`)) === false,
      `workflow data package must not contain retired profile manifest: ${retired}`);
  }
  for (const retiredAdapter of ["claude-code", "cursor", "pi"]) {
    assert(await exists(join(workflowDataRoot, "harness", "bundles", retiredAdapter)) === false,
      `workflow data package must not contain retired adapter bundle: ${retiredAdapter}`);
  }
  assert(await exists(join(workflowDataRoot, "harness", "migrations")) === false,
    "workflow data package must not contain migration manifests (hard cut)");

  const bin = join(packagedRoot, "dist", "bin.js");
  // Fail before project writes if the packed workflow requires a newer or
  // different CLI surface. This exercises the exact installed tarballs.
  const capabilityOutput = run(
    process.execPath,
    [bin, "capabilities", "--json"],
    { cwd: temporary, capture: true }
  );
  const capabilityReceipt = JSON.parse(capabilityOutput.trim());
  assert(capabilityReceipt.compatibility?.compatible === true,
    "packed workflow and CLI capability contract is incompatible");
  for (const capability of ["sync@1", "knowledge-sync@2", "remote-sync-push@1", "remote-sync-pull@1"]) {
    assert(capabilityReceipt.capabilities?.includes(capability),
      `packed CLI is missing required capability ${capability}`);
  }
  for (const retired of ["rules-sync@1", "rules-review@1"]) {
    assert(capabilityReceipt.capabilities?.includes(retired) === false,
      `packed CLI must not advertise retired capability ${retired}`);
  }

  const packagedCodexBundle = join(
    workflowDataRoot,
    "harness",
    "bundles",
    "codex"
  );
  const commandDocuments = await markdownFiles(packagedCodexBundle);
  const documentedCommands = extractHunterHarnessCommands(
    (await Promise.all(commandDocuments.map((path) => readFile(path, "utf8")))).join("\n")
  );
  assert(documentedCommands.length > 0, "packed Skills contain no CLI command examples");
  for (const command of documentedCommands) {
    assert(capabilityReceipt.commands?.[command]?.available === true,
      `packed Skill references unavailable CLI command ${command}`);
    run(process.execPath, [bin, command, "--help"], {
      cwd: temporary,
      capture: true
    });
  }

  const preview = run(process.execPath, [bin, "--non-interactive", "--dry-run", "--json"],
    { cwd: temporary, capture: true });
  const previewResult = JSON.parse(preview.trim());
  if (previewResult.ok !== true || previewResult.dry_run !== true) {
    throw new Error("packaged CLI dry-run output is invalid");
  }
  assert(await exists(join(temporary, ".harness")) === false, "dry-run wrote project state");

  // v1.0 固定双投影安装 + 幂等 refresh + 冲突保留。
  const project = await mkdtemp(join(tmpdir(), "hunter-pack-smoke-"));
  try {
    const projectBin = bin;
    // 用户既有 AGENTS/CLAUDE 内容必须保留。
    await writeFile(join(project, "CLAUDE.md"), "# User Claude\nkeep this.\n");
    await writeFile(join(project, "AGENTS.md"), "# User Agents\nkeep this too.\n");

    run(process.execPath, [projectBin, "--non-interactive", "--yes"],
      { cwd: project, capture: true });
    await stat(join(project, ".agents", "skills", "harness-review", "SKILL.md"));
    for (const supportFile of ["SKILL.md", "protocols.md", "coding-reference.md", "coding-checklist.md",
      "testing-reference.md", "testing-checklist.md", "testing-pitfalls.md"]) {
      await stat(join(project, ".agents", "skills", "harness-execute", supportFile));
    }
    await stat(join(project, ".codebuddy", "skills", "harness-review", "SKILL.md"));
    // v1.0：不再投影其他适配器根目录与独立 agents 目录。
    for (const retiredRoot of [".claude", ".cursor", ".pi", ".codebuddy/agents"]) {
      assert(await exists(join(project, retiredRoot)) === false,
        `install must not create retired projection root: ${retiredRoot}`);
    }
    // 最小 .harness 布局：无 cache/reports/.gitkeep/README。
    assert(await exists(join(project, ".harness", "cache")) === false, "must not pre-create cache");
    assert(await exists(join(project, ".harness", "reports")) === false, "must not pre-create reports");
    assert(await exists(join(project, ".harness", "README.md")) === false, "must not generate README");
    assert(await exists(join(project, ".harness", "state", "local", "installed-harness-bundle.json")),
      "must write schema-v5 installed state");
    const installedState = JSON.parse(await readFile(
      join(project, ".harness", "state", "local", "installed-harness-bundle.json"), "utf8"
    ));
    assert(installedState.schema_version === 5,
      `installed state must be schema_version 5, got ${installedState.schema_version}`);
    // 用户 CLAUDE.md 逐字保留（v1.0 不再触碰）；用户 AGENTS.md 内容保留并注入受管块。
    const claude = await readFile(join(project, "CLAUDE.md"), "utf8");
    assert(claude === "# User Claude\nkeep this.\n",
      "CLAUDE.md user content must remain byte-for-byte unchanged");
    const agents = await readFile(join(project, "AGENTS.md"), "utf8");
    assert(agents.includes("# User Agents") && agents.includes("keep this too."),
      "AGENTS.md user content must be preserved");
    assert(agents.includes("hunter-harness-core") && agents.includes("hunter-harness-learned-rules"),
      "AGENTS.md must carry core and learned-rules managed blocks");
    assert(await exists(join(project, ".gitattributes")) === false,
      "install must not generate .gitattributes");

    // The exact packed CLI must ignore generated Python runtime caches before
    // scanning or proposal construction. This catches worktree builds that
    // accidentally bundle stale @hunter-harness/core sources via node_modules.
    const pythonCache = join(
      project,
      ".agents",
      "skills",
      "harness-knowledge-ingest",
      "scripts",
      "__pycache__"
    );
    await mkdir(pythonCache, { recursive: true });
    const cachedBytecode = Buffer.alloc(512 * 1024, 0x20);
    cachedBytecode.write(
      "C:\\Users\\Example\\Hunter-Harness\\harness_knowledge.py"
    );
    await writeFile(
      join(pythonCache, "harness_knowledge.cpython-311.pyc"),
      cachedBytecode
    );
    const knowledgeRoot = join(project, ".harness", "knowledge");
    const staleKnowledge = join(knowledgeRoot, "entries", "stale");
    const supersededKnowledge = join(
      knowledgeRoot,
      "entries",
      "superseded"
    );
    await mkdir(staleKnowledge, { recursive: true });
    await mkdir(supersededKnowledge, { recursive: true });
    await writeFile(
      join(knowledgeRoot, "index.json"),
      Buffer.alloc(11 * 1024 * 1024, 0x20)
    );
    await writeFile(
      join(staleKnowledge, "stale-entry.json"),
      Buffer.alloc(1024, 0x20)
    );
    await writeFile(
      join(supersededKnowledge, "superseded-entry.json"),
      Buffer.alloc(1024, 0x20)
    );
    const pushOutput = run(process.execPath, [
      projectBin,
      "push",
      "--dry-run",
      "--non-interactive",
      "--yes",
      "--json"
    ], { cwd: project, capture: true });
    const pushReceipt = JSON.parse(pushOutput.trim());
    assert(pushReceipt.ok === true, "packed CLI rejected generated Python cache");
    assert(pushReceipt.summary?.findings === 0,
      "packed CLI scanned generated Python cache");
    assert(pushReceipt.items?.every((item) => !item.path.includes("__pycache__")),
      "packed CLI included generated Python cache in proposal");
    assert(pushReceipt.items?.every((item) =>
      item.path !== ".harness/knowledge/index.json" &&
      !item.path.startsWith(".harness/knowledge/entries/stale/") &&
      !item.path.startsWith(".harness/knowledge/entries/superseded/")
    ), "packed CLI included rebuildable knowledge projections in proposal");

    // 重跑相同命令必须保持受管文件字节不变。
    const beforeProject = await readFile(join(project, ".harness", "project.yaml"), "utf8");
    const beforeSkills = await Promise.all([
      readFile(join(project, ".agents", "skills", "harness-review", "SKILL.md")),
      readFile(join(project, ".codebuddy", "skills", "harness-review", "SKILL.md"))
    ]);
    run(process.execPath, [projectBin, "--non-interactive", "--yes"], { cwd: project, capture: true });
    const afterProject = await readFile(join(project, ".harness", "project.yaml"), "utf8");
    assert(beforeProject === afterProject, "refresh must not reset project identity");
    const afterSkills = await Promise.all([
      readFile(join(project, ".agents", "skills", "harness-review", "SKILL.md")),
      readFile(join(project, ".codebuddy", "skills", "harness-review", "SKILL.md"))
    ]);
    assert(beforeSkills.every((bytes, index) => bytes.equals(afterSkills[index])),
      "identical install changed managed skill bytes");

    // 用户修改 Bundle working copy → refresh 保留并 exit 5。
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

    // uninstall dry-run 只预览不删除；--yes 精确移除全部受管内容。
    const uninstallPreview = JSON.parse(run(process.execPath,
      [projectBin, "uninstall", "--non-interactive", "--dry-run", "--json"],
      { cwd: project, capture: true }).trim());
    assert(uninstallPreview.dry_run === true && Array.isArray(uninstallPreview.actions),
      "uninstall dry-run output is invalid");
    assert(await exists(join(project, ".agents", "skills", "harness-review", "SKILL.md")),
      "uninstall dry-run must not delete managed files");
    run(process.execPath, [projectBin, "uninstall", "--non-interactive", "--yes"],
      { cwd: project, capture: true });
    assert(await exists(join(project, ".agents")) === false,
      "uninstall must remove .agents projection");
    assert(await exists(join(project, ".codebuddy")) === false,
      "uninstall must remove .codebuddy projection");
    assert(await exists(join(project, ".harness")) === false,
      "uninstall must remove the .harness working tree (default keepData=false)");
    const agentsAfter = await readFile(join(project, "AGENTS.md"), "utf8");
    assert(agentsAfter.includes("# User Agents") && !agentsAfter.includes("hunter-harness-core"),
      "uninstall must strip managed blocks but preserve user AGENTS.md content");
  } finally {
    await rm(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  run(process.execPath, [npmCli, "pack", "-w", "packages/skill-cli", "--pack-destination", temporary]);
  const skillArchive = (await readdir(temporary)).find((name) =>
    name.startsWith("hunter-harness-skills-") && name.endsWith(".tgz")
  );
  if (skillArchive === undefined) throw new Error("npm pack did not create the Skill CLI archive");
  run(process.execPath, [npmCli, "install", "--prefix", temporary, "--ignore-scripts", "--omit=optional", join(temporary, skillArchive)], { timeout: 180_000 });
  const skillShim = join(
    temporary,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "skills.cmd" : "skills"
  );
  const legacySkillShim = join(
    temporary,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "hunter-harness-skill.cmd" : "hunter-harness-skill"
  );
  await stat(skillShim);
  await stat(legacySkillShim);
  const skillBin = join(temporary, "node_modules", "@hunter-harness", "skills", "dist", "bin.js");
  const skillHelp = run(process.execPath, [skillBin, "--help"], { cwd: temporary, capture: true });
  if (!skillHelp.includes("install") || !skillHelp.includes("upload") ||
    /\b(search|download|update|uninstall|publish)\b/.test(skillHelp)) {
    throw new Error("packaged Skill CLI command surface is invalid");
  }
  process.stdout.write("packaged project CLI and Skill CLI smoke tests passed\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
