import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Project-relative path of the local installed-bundle state file. */
export const INSTALLED_BUNDLE_STATE_PATH = ".harness/state/local/installed-harness-bundle.json";

/**
 * v1.0 legacy residue detection.
 *
 * Pre-1.0 installs projected skills into per-agent roots (.claude/.cursor/.pi)
 * and wrote CLAUDE.md / CODEBUDDY.md / .harness/rules static content. v1.0 only
 * manages `.agents/skills` + `.codebuddy/skills` + AGENTS.md, so anything left
 * from the old matrix is residue that should be cleaned with
 * `npx hunter-harness uninstall`.
 *
 * Detection is deliberately read-only and conservative: it only reports paths
 * that are clearly harness-owned (harness- prefixed entries, managed blocks,
 * or the legacy installed-state file), never user-owned directories in general.
 */
export interface LegacyResidue {
  /** Project-relative POSIX path of the residue. */
  path: string;
  /** Human-readable explanation of what was found. */
  detail: string;
}

const LEGACY_SKILLS_ROOTS = [".claude/skills", ".cursor/skills", ".pi/skills"];
const LEGACY_RULES_ROOTS = [".claude/rules", ".codebuddy/rules"];
const LEGACY_INSTRUCTION_FILES = ["CLAUDE.md", "CODEBUDDY.md"];
const LEGACY_RULES_DIR = ".harness/rules";
const HARNESS_PREFIX = "harness-";
const MANAGED_BLOCK_MARKER = "hunter-harness:start";
const CURRENT_STATE_SCHEMA_VERSION = 5;

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function listHarnessEntries(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.name.startsWith(HARNESS_PREFIX))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function dirHasFiles(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path);
    return entries.length > 0;
  } catch {
    return false;
  }
}

async function fileContainsMarker(path: string, marker: string): Promise<boolean> {
  try {
    const content = await readFile(path, "utf8");
    return content.includes(marker);
  } catch {
    return false;
  }
}

async function readLegacyStateSchemaVersion(root: string): Promise<number | null> {
  try {
    const raw = await readFile(join(root, INSTALLED_BUNDLE_STATE_PATH), "utf8");
    const parsed = JSON.parse(raw) as { schema_version?: unknown };
    return typeof parsed.schema_version === "number" ? parsed.schema_version : null;
  } catch {
    return null;
  }
}

/**
 * Detect pre-1.0 hunter-harness projection residue in a project.
 *
 * Returns an empty array for clean projects. Callers surface the result as
 * warnings guiding the user to `npx hunter-harness uninstall`; detection never
 * deletes anything by itself.
 */
export async function detectLegacyProjectionResidue(projectRoot: string): Promise<LegacyResidue[]> {
  const root = resolve(projectRoot);
  const residue: LegacyResidue[] = [];

  const stateSchemaVersion = await readLegacyStateSchemaVersion(root);
  if (stateSchemaVersion !== null && stateSchemaVersion !== CURRENT_STATE_SCHEMA_VERSION) {
    residue.push({
      path: INSTALLED_BUNDLE_STATE_PATH,
      detail: `旧版安装状态 (schema_version=${stateSchemaVersion}，当前版本为 ${CURRENT_STATE_SCHEMA_VERSION})`
    });
  }

  for (const skillsRoot of LEGACY_SKILLS_ROOTS) {
    const entries = await listHarnessEntries(join(root, skillsRoot));
    if (entries.length > 0) {
      residue.push({
        path: skillsRoot,
        detail: `旧版 agent 投影残留：${entries.join("、")}`
      });
    }
  }

  for (const rulesRoot of LEGACY_RULES_ROOTS) {
    const entries = await listHarnessEntries(join(root, rulesRoot));
    if (entries.length > 0) {
      residue.push({
        path: rulesRoot,
        detail: `旧版静态 rules 投影残留：${entries.join("、")}`
      });
    }
  }

  if (await dirHasFiles(join(root, LEGACY_RULES_DIR))) {
    residue.push({
      path: LEGACY_RULES_DIR,
      detail: "旧版静态 rules 目录（v1.0 起规则由归档自动学习写入 AGENTS.md）"
    });
  }

  for (const instructionFile of LEGACY_INSTRUCTION_FILES) {
    const absolute = join(root, instructionFile);
    if (await pathExists(absolute) && await fileContainsMarker(absolute, MANAGED_BLOCK_MARKER)) {
      residue.push({
        path: instructionFile,
        detail: "旧版指令文件投影（v1.0 起指令收敛为 AGENTS.md 单文件）"
      });
    }
  }

  return residue;
}

/** Format residue entries into actionable warning lines. */
export function formatLegacyResidueWarnings(residue: LegacyResidue[]): string[] {
  if (residue.length === 0) return [];
  const lines = residue.map((entry) => `  - ${entry.path}：${entry.detail}`);
  return [
    "检测到旧版 hunter-harness 投影残留（v1.0 起仅管理 .agents/skills、.codebuddy/skills 与 AGENTS.md）：",
    ...lines,
    "请运行 `npx hunter-harness uninstall` 清理后重新 init。"
  ];
}
