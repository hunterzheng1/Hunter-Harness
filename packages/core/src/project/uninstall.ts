import { createHash } from "node:crypto";
import { readdir, readFile, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/**
 * v1.0 卸载引擎：一键移除 hunter-harness 在项目（及可选的用户级目录）写入的
 * 全部受管内容。只删受管文件——
 * 1. 安装状态（`.harness/state/local/installed-harness-bundle.json`）逐文件校验
 *    sha256，被本地改过的文件跳过并告警；v5 与 0.x（schema 1-4）都可解析——0.x
 *    的 files 记录与 v5 同构，且按 bundle 全量清单生成，故同样覆盖 contracts/ 等
 *    无前缀附属内容；
 * 2. 状态不可解析时退化为前缀清扫：按 `harness-` 前缀清理已知适配器根
 *    （.claude/.cursor/.pi/.codebuddy/.agents 的 skills/rules），并对全部 skills
 *    根提示无法验证所有权的 bundle 附属残留；
 * 3. AGENTS.md / CLAUDE.md / CODEBUDDY.md 只摘 `hunter-harness` 受管段落，文件
 *    摘空才删除；
 * 4. `.mcp.json` 只摘除与安装时写入形状完全一致的 `mcpServers.codegraph` 条目；
 * 5. `.gitignore` 不做反向编辑（无法区分 harness 写入与用户自行添加的同名行），
 *    在报告中提示人工清理。
 */

export interface UninstallOptions {
  projectRoot: string;
  /** 默认 false；CLI 层默认先 dry-run 预览。 */
  dryRun?: boolean;
  /** 保留 `.harness/state` 运行数据（事务、归档回执、凭据等）。 */
  keepData?: boolean;
  /** 同时清理用户级目录（状态根、~/.hunter-harness、全局 skills 投影）。 */
  global?: boolean;
  /** 用户级状态根（含 last-server.json 与 recovery/），由 CLI 解析后传入。 */
  userStateRoot?: string;
  userHome?: string;
}

export type UninstallActionKind =
  | "delete-file"
  | "delete-dir"
  | "strip-file"
  | "skip";

export interface UninstallAction {
  kind: UninstallActionKind;
  path: string;
  detail: string;
}

export interface UninstallReport {
  dry_run: boolean;
  keep_data: boolean;
  global_scope: boolean;
  actions: UninstallAction[];
  warnings: string[];
  counts: { deleted: number; stripped: number; skipped: number };
}

/** 状态记录的文件条目；0.x（schema 2）没有 owner，故各字段按需收窄。 */
interface InstalledFileEntry {
  owner?: unknown;
  source_path?: unknown;
  target_path?: unknown;
  sha256?: unknown;
}

interface InstalledStateV5 {
  schema_version: number;
  surfaces?: string[];
  files: InstalledFileEntry[];
  managed_blocks: unknown[];
}

/** 当前状态 schema；1-4 为 0.x 旧版，files 与 v5 同构，可直接用于精确删除。 */
const CURRENT_STATE_SCHEMA_VERSION = 5;
const MIN_LEGACY_STATE_SCHEMA_VERSION = 1;

/** 解析后的可用状态。 */
interface InstalledState {
  schemaVersion: number;
  /** true 表示 0.x 旧版状态（schema 1-4）。 */
  legacy: boolean;
  files: InstalledFileEntry[];
}

/** 项目内 skills 根（v1.0 两个投影面 + 0.x 历史面），也是 bundle 附属内容的投影根。 */
const SKILLS_ROOTS = [
  ".agents/skills",
  ".codebuddy/skills",
  ".claude/skills",
  ".cursor/skills",
  ".pi/skills"
];

/** 项目内已知适配器根（skills 根 + rules 根），只做 harness- 前缀清扫。 */
const PROJECT_SWEEP_ROOTS = [
  ...SKILLS_ROOTS,
  ".claude/rules",
  ".codebuddy/rules",
  ".cursor/rules"
];

/** bundle 中不带 harness- 前缀的附属内容（状态可用时按状态精确删除，缺失时只提示）。 */
const BUNDLE_EXTRA_ENTRIES = new Set([
  "contracts",
  "protocols",
  "scripts",
  ".harness-build.json",
  "CONTEXT.md",
  "README.md"
]);

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "CODEBUDDY.md"];

const HARNESS_MANAGED_BLOCK_PATTERN =
  /[ \t]*<!-- hunter-harness:start[^\n]*-->\r?\n[\s\S]*?<!-- hunter-harness:end[^\n]*-->\r?\n?/g;

const HARNESS_MCP_ENTRY = { command: "codegraph", args: ["serve", "--mcp"] };

interface Ctx {
  absRoot: string;
  dryRun: boolean;
  actions: UninstallAction[];
  warnings: string[];
  /** 因本地改动被跳过的绝对路径（保护其不被后续前缀清扫删除）。 */
  protectedPaths: Set<string>;
  deleted: number;
  stripped: number;
  skipped: number;
}

async function statOrNull(path: string) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

function displayPath(ctx: Ctx, absPath: string): string {
  const prefix = ctx.absRoot + sep;
  return absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath;
}

/** 项目内路径防护：拒绝逃逸项目根的目标（防御损坏的状态文件）。 */
function resolveInsideRoot(absRoot: string, relativePath: string): string | null {
  const abs = resolve(absRoot, relativePath);
  return abs === absRoot || abs.startsWith(absRoot + sep) ? abs : null;
}

function record(ctx: Ctx, kind: UninstallActionKind, absPath: string, detail: string) {
  ctx.actions.push({ kind, path: displayPath(ctx, absPath), detail });
  if (kind === "delete-file" || kind === "delete-dir") ctx.deleted += 1;
  else if (kind === "strip-file") ctx.stripped += 1;
  else ctx.skipped += 1;
}

async function deleteFile(ctx: Ctx, absPath: string, detail: string) {
  record(ctx, "delete-file", absPath, detail);
  if (!ctx.dryRun) await unlink(absPath);
  await pruneEmptyAncestors(ctx, dirname(absPath));
}

async function deleteDir(ctx: Ctx, absPath: string, detail: string) {
  record(ctx, "delete-dir", absPath, detail);
  if (!ctx.dryRun) await rm(absPath, { recursive: true, force: true });
  await pruneEmptyAncestors(ctx, dirname(absPath));
}

/** 自底向上移除空目录，停在项目根（不含）。rmdir 只删空目录，天然安全。 */
async function pruneEmptyAncestors(ctx: Ctx, startDir: string) {
  let dir = startDir;
  while (dir.startsWith(ctx.absRoot + sep)) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    if (entries.length > 0) return;
    // fs.promises.rm 无 recursive 拒绝目录目标（EISDIR），空目录清理用 rmdir。
    if (!ctx.dryRun) await rmdir(dir);
    dir = dirname(dir);
  }
}

/**
 * 解析安装状态。接受 v5（严格）与 0.x 旧版（schema 1-4，宽松：files 记录与 v5
 * 同构——0.x 由 bundle 全量清单生成，含 contracts/ 等无前缀附属内容——可直接
 * 精确删除）；解析失败或 schema 未知返回 null，由前缀清扫兜底。
 */
async function readInstalledState(absRoot: string): Promise<InstalledState | null> {
  let raw: string;
  try {
    raw = await readFile(
      join(absRoot, ".harness", "state", "local", "installed-harness-bundle.json"),
      "utf8"
    );
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<InstalledStateV5> & { schema_version?: unknown };
    if (typeof parsed.schema_version !== "number" || !Number.isInteger(parsed.schema_version)) {
      return null;
    }
    if (!Array.isArray(parsed.files)) return null;
    if (parsed.schema_version === CURRENT_STATE_SCHEMA_VERSION) {
      if (!Array.isArray(parsed.managed_blocks)) return null;
      return { schemaVersion: parsed.schema_version, legacy: false, files: parsed.files };
    }
    if (
      parsed.schema_version >= MIN_LEGACY_STATE_SCHEMA_VERSION &&
      parsed.schema_version < CURRENT_STATE_SCHEMA_VERSION
    ) {
      return { schemaVersion: parsed.schema_version, legacy: true, files: parsed.files };
    }
    return null;
  } catch {
    return null;
  }
}

/** 状态驱动的精确删除：只删与记录 sha256 一致（未被本地改动）的受管文件。 */
async function deleteStateTrackedFiles(ctx: Ctx, state: InstalledState) {
  const entries = state.files
    .filter(
      (entry): entry is InstalledFileEntry & { target_path: string; sha256: string } =>
        typeof entry?.target_path === "string" && typeof entry?.sha256 === "string"
    )
    .sort((a, b) => (a.target_path < b.target_path ? -1 : 1));
  for (const entry of entries) {
    const abs = resolveInsideRoot(ctx.absRoot, entry.target_path);
    if (abs === null) {
      ctx.warnings.push(`状态记录的路径越界，已跳过：${entry.target_path}`);
      continue;
    }
    const info = await statOrNull(abs);
    if (info === null) continue; // 已不存在
    if (!info.isFile()) {
      ctx.warnings.push(`受管路径已不是普通文件，已跳过：${displayPath(ctx, abs)}`);
      continue;
    }
    // 状态文件的 sha256 为裸 hex（与 manifest、refresh 校验一致），非 sha256Bytes 前缀格式。
    const currentHash = createHash("sha256").update(await readFile(abs)).digest("hex");
    if (currentHash !== entry.sha256) {
      ctx.protectedPaths.add(abs);
      record(ctx, "skip", abs, "文件已被本地修改，保留（请确认后手动删除）");
      ctx.warnings.push(`本地修改过的受管文件未删除：${displayPath(ctx, abs)}`);
      continue;
    }
    const owner = typeof entry.owner === "string" ? entry.owner : "0.x";
    await deleteFile(ctx, abs, `受管文件（owner=${owner}）`);
  }
}

/** 判定目标是否受保护：自身或其内部包含本地修改过的受管文件时跳过。 */
function isProtected(ctx: Ctx, absPath: string): boolean {
  if (ctx.protectedPaths.has(absPath)) return true;
  const prefix = absPath + sep;
  for (const protectedPath of ctx.protectedPaths) {
    if (protectedPath.startsWith(prefix)) return true;
  }
  return false;
}

/** 历史投影前缀清扫：删除已知适配器根下的 harness-* 条目（0.x 残留兜底）。 */
async function sweepHarnessPrefixedEntries(ctx: Ctx, rootAbs: string, label: string) {
  const info = await statOrNull(rootAbs);
  if (info === null || !info.isDirectory()) return;
  let names: string[];
  try {
    names = await readdir(rootAbs);
  } catch {
    return;
  }
  for (const name of names.sort()) {
    if (!name.startsWith("harness-")) continue;
    const abs = join(rootAbs, name);
    if (isProtected(ctx, abs)) {
      record(ctx, "skip", abs, "包含本地修改过的受管文件，保留（请确认后手动删除）");
      continue;
    }
    const entry = await statOrNull(abs);
    if (entry === null) continue;
    if (entry.isDirectory()) {
      await deleteDir(ctx, abs, `${label} harness 投影目录`);
    } else {
      await deleteFile(ctx, abs, `${label} harness 投影文件`);
    }
  }
}

/**
 * 提示 bundle 附属残留（contracts/protocols/scripts 等无 harness- 前缀、也不在
 * 状态记录里的内容）。这类内容无法在不看安装状态的前提下验证所有权，故只提示
 * 不删除；扫描覆盖全部 skills 根，避免某个历史面（如 .pi）静默残留。
 */
async function warnBundleExtraResidue(
  ctx: Ctx,
  baseAbs: string,
  roots: readonly string[],
  label: string
) {
  for (const skillsRoot of roots) {
    const rootAbs = join(baseAbs, ...skillsRoot.split("/"));
    const info = await statOrNull(rootAbs);
    if (info === null || !info.isDirectory()) continue;
    let entries: string[];
    try {
      entries = await readdir(rootAbs);
    } catch {
      continue;
    }
    const leftovers = entries.filter((name) => BUNDLE_EXTRA_ENTRIES.has(name));
    if (leftovers.length > 0) {
      ctx.warnings.push(
        `${label}${skillsRoot} 下存在疑似 bundle 附属内容（无安装状态可验证，未自动删除）：` +
        leftovers.join(", ")
      );
    }
  }
}

/** 摘除指令文件中的全部 hunter-harness 受管段；摘空则删除文件。 */
async function stripInstructionFile(ctx: Ctx, fileName: string) {
  const abs = join(ctx.absRoot, fileName);
  const info = await statOrNull(abs);
  if (info === null || !info.isFile()) return;
  const content = await readFile(abs, "utf8");
  if (!content.includes("<!-- hunter-harness:start")) return;
  const stripped = content.replace(HARNESS_MANAGED_BLOCK_PATTERN, "");
  if (stripped.trim().length === 0) {
    await deleteFile(ctx, abs, "仅剩受管段落，整文件删除");
    return;
  }
  if (stripped === content) return;
  record(ctx, "strip-file", abs, "摘除 hunter-harness 受管段落");
  if (!ctx.dryRun) await writeFile(abs, stripped, "utf8");
}

/** 摘除 .mcp.json 中与安装时写入形状完全一致的 codegraph 条目。 */
async function stripMcpEntry(ctx: Ctx) {
  const abs = join(ctx.absRoot, ".mcp.json");
  const info = await statOrNull(abs);
  if (info === null || !info.isFile()) return;
  let doc: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await readFile(abs, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
    doc = parsed as Record<string, unknown>;
  } catch {
    return; // 非有效 JSON：不碰用户文件
  }
  const servers = doc.mcpServers;
  if (servers === null || typeof servers !== "object" || Array.isArray(servers)) return;
  const entries = { ...(servers as Record<string, unknown>) };
  const codegraph = entries.codegraph;
  if (codegraph === undefined) return;
  const matchesHarnessEntry =
    codegraph !== null && typeof codegraph === "object" && !Array.isArray(codegraph) &&
    JSON.stringify(codegraph) === JSON.stringify(HARNESS_MCP_ENTRY);
  if (!matchesHarnessEntry) {
    ctx.warnings.push(".mcp.json 的 mcpServers.codegraph 已被修改，保留（请确认后手动删除）");
    record(ctx, "skip", abs, "codegraph 条目与安装形状不一致，保留");
    return;
  }
  delete entries.codegraph;
  const next: Record<string, unknown> = { ...doc };
  if (Object.keys(entries).length === 0) {
    delete next.mcpServers;
  } else {
    next.mcpServers = entries;
  }
  if (Object.keys(next).length === 0) {
    await deleteFile(ctx, abs, "摘除 harness MCP 条目后文件为空，整文件删除");
    return;
  }
  record(ctx, "strip-file", abs, "摘除 mcpServers.codegraph harness 条目");
  if (!ctx.dryRun) await writeFile(abs, JSON.stringify(next, null, 2) + "\n", "utf8");
}

/** 处理 .harness 目录：keepData 时保留 state 子树，否则整树删除。 */
async function removeHarnessDir(ctx: Ctx, keepData: boolean) {
  const harnessRoot = join(ctx.absRoot, ".harness");
  const info = await statOrNull(harnessRoot);
  if (info === null || !info.isDirectory()) return;
  if (!keepData) {
    await deleteDir(ctx, harnessRoot, "harness 工作目录（含运行数据）");
    return;
  }
  for (const name of ["project.yaml", "context-index.json"]) {
    const abs = join(harnessRoot, name);
    if ((await statOrNull(abs))?.isFile() === true) {
      await deleteFile(ctx, abs, "harness 项目配置（--keep-data 保留 state）");
    }
  }
  for (const name of ["rules", "codebase"]) {
    const abs = join(harnessRoot, name);
    if ((await statOrNull(abs))?.isDirectory() === true) {
      await deleteDir(ctx, abs, "harness 受管目录（--keep-data 保留 state）");
    }
  }
}

export async function uninstallHarness(options: UninstallOptions): Promise<UninstallReport> {
  const absRoot = resolve(options.projectRoot);
  const dryRun = options.dryRun === true;
  const keepData = options.keepData === true;
  const globalScope = options.global === true;
  const ctx: Ctx = {
    absRoot,
    dryRun,
    actions: [],
    warnings: [],
    protectedPaths: new Set(),
    deleted: 0,
    stripped: 0,
    skipped: 0
  };

  // 1. 状态驱动的精确删除（v5 或 0.x 旧版状态，两者 files 记录同构）。
  const state = await readInstalledState(absRoot);
  if (state !== null) {
    if (state.legacy) {
      ctx.warnings.push(
        `安装状态为 0.x 旧版格式（schema_version=${state.schemaVersion}），` +
        "已按状态记录精确删除全部受管文件（含 bundle 附属内容）"
      );
    }
    await deleteStateTrackedFiles(ctx, state);
  } else {
    const legacyState = await statOrNull(
      join(absRoot, ".harness", "state", "local", "installed-harness-bundle.json")
    );
    if (legacyState !== null) {
      ctx.warnings.push(
        "安装状态为 0.x 旧版格式但无法解析，改用前缀清扫（非 harness- 前缀的 bundle 附属文件可能残留）"
      );
    }
  }

  // 2. 前缀清扫（历史残留 + 状态遗漏兜底）；受保护的本地修改文件不会被扫入。
  for (const root of PROJECT_SWEEP_ROOTS) {
    await sweepHarnessPrefixedEntries(ctx, join(absRoot, ...root.split("/")), root);
  }

  // 3. 状态不可用时提示 bundle 附属残留（状态可用时这些条目已在第 1 步精确删除）。
  if (state === null) {
    await warnBundleExtraResidue(ctx, absRoot, SKILLS_ROOTS, "");
  }

  // 4. 指令文件受管段摘除（AGENTS.md 单文件 + 0.x 的 CLAUDE.md/CODEBUDDY.md）。
  for (const fileName of INSTRUCTION_FILES) {
    await stripInstructionFile(ctx, fileName);
  }

  // 5. .mcp.json harness 条目摘除。
  await stripMcpEntry(ctx);

  // 6. .harness 工作目录。
  await removeHarnessDir(ctx, keepData);

  // 7. 用户级清理（--global）。
  if (globalScope) {
    const userHome = options.userHome;
    if (options.userStateRoot !== undefined) {
      const info = await statOrNull(options.userStateRoot);
      if (info !== null && info.isDirectory()) {
        await deleteDir(ctx, options.userStateRoot, "用户级 harness 状态（last-server/recovery）");
      }
    }
    if (userHome !== undefined) {
      const cliState = join(userHome, ".hunter-harness");
      const info = await statOrNull(cliState);
      if (info !== null && info.isDirectory()) {
        await deleteDir(ctx, cliState, "用户级 hunter-harness CLI 状态");
      }
      for (const root of SKILLS_ROOTS) {
        await sweepHarnessPrefixedEntries(ctx, join(userHome, ...root.split("/")), `用户级 ${root}`);
      }
      // 用户级根没有对应安装状态可验证，附属内容永远只提示不删除。
      await warnBundleExtraResidue(ctx, userHome, SKILLS_ROOTS, "用户级 ");
    }
  }

  if (ctx.actions.length > 0) {
    ctx.warnings.push(
      ".gitignore 中的 harness 条目不做自动反向编辑，如需清理请手动删除对应行"
    );
  }

  return {
    dry_run: dryRun,
    keep_data: keepData,
    global_scope: globalScope,
    actions: ctx.actions,
    warnings: ctx.warnings,
    counts: { deleted: ctx.deleted, stripped: ctx.stripped, skipped: ctx.skipped }
  };
}
