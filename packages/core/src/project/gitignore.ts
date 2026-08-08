import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const INSTALLED_BUNDLE_RELATIVE = ".harness/state/local/installed-harness-bundle.json";
const GENERATED_PROJECTIONS_START = "# hunter-harness:generated-projections:start";
const GENERATED_PROJECTIONS_END = "# hunter-harness:generated-projections:end";
const PROJECTION_PREFIXES = [
  ".claude/skills/",
  ".claude/agents/",
  ".claude/rules/",
  ".claude/commands/",
  ".agents/skills/",
  ".agents/agents/",
  ".agents/rules/",
  ".agents/commands/",
  ".cursor/skills/",
  ".cursor/agents/",
  ".cursor/rules/",
  ".cursor/commands/",
  ".codebuddy/skills/",
  ".codebuddy/agents/",
  ".codebuddy/rules/",
  ".codebuddy/.rules/",
  ".codebuddy/commands/"
] as const;

export const ROOT_INSTRUCTION_DOCUMENTS = [
  "AGENTS.md",
  "CLAUDE.md",
  "CODEBUDDY.md"
] as const;

const HARNESS_GITIGNORE_ENTRIES = [
  { pattern: "/.harness/", probe: ".harness/__hunter_probe__" },
  { pattern: "/.worktrees/", probe: ".worktrees/__hunter_probe__" },
  { pattern: "/.claude/worktrees/", probe: ".claude/worktrees/__hunter_probe__" },
  { pattern: "/.claude/skills/harness-*/", probe: ".claude/skills/harness-probe/__probe__" },
  { pattern: "/.claude/agents/harness-*.md", probe: ".claude/agents/harness-probe.md" },
  { pattern: "/.claude/rules/harness-*.md", probe: ".claude/rules/harness-probe.md" },
  { pattern: "/.agents/worktrees/", probe: ".agents/worktrees/__hunter_probe__" },
  { pattern: "/.agents/skills/harness-*/", probe: ".agents/skills/harness-probe/__probe__" },
  { pattern: "/.agents/agents/harness-*.md", probe: ".agents/agents/harness-probe.md" },
  { pattern: "/.agents/rules/harness-*.md", probe: ".agents/rules/harness-probe.md" },
  { pattern: "/.cursor/worktrees/", probe: ".cursor/worktrees/__hunter_probe__" },
  { pattern: "/.cursor/skills/harness-*/", probe: ".cursor/skills/harness-probe/__probe__" },
  { pattern: "/.cursor/agents/harness-*.md", probe: ".cursor/agents/harness-probe.md" },
  { pattern: "/.cursor/rules/harness-*.md", probe: ".cursor/rules/harness-probe.md" },
  { pattern: "/.codebuddy/worktrees/", probe: ".codebuddy/worktrees/__hunter_probe__" },
  { pattern: "/.codebuddy/skills/harness-*/", probe: ".codebuddy/skills/harness-probe/__probe__" },
  { pattern: "/.codebuddy/agents/harness-*.md", probe: ".codebuddy/agents/harness-probe.md" },
  { pattern: "/.codebuddy/rules/harness-*.md", probe: ".codebuddy/rules/harness-probe.md" },
  { pattern: "/.codebuddy/.rules/harness-*.mdc", probe: ".codebuddy/.rules/harness-probe.mdc" }
] as const;

const PROVENANCE_RELATIVE = ".harness/state/local/gitignore-provenance.json";

interface GitignoreProvenance {
  schema_version: 1;
  generated_root_documents: string[];
}

export interface EnsureHarnessGitignoreOptions {
  dryRun?: boolean;
  platformBound?: boolean;
  generatedRootDocuments?: readonly string[];
}

export interface EnsureHarnessGitignoreResult {
  changed: boolean;
  path: ".gitignore";
  ignoredRootDocuments: string[];
  skippedBecauseOfNegation: boolean;
  patternResults: GitignorePatternResult[];
}

export interface GitignorePatternResult {
  pattern: string;
  status: "added" | "planned" | "already-ignored" | "already-present" |
    "preserved-by-negation" | "tracked";
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readProvenance(projectRoot: string): Promise<GitignoreProvenance> {
  try {
    const parsed = JSON.parse(
      await readFile(join(projectRoot, PROVENANCE_RELATIVE), "utf8")
    ) as Partial<GitignoreProvenance>;
    return {
      schema_version: 1,
      generated_root_documents: Array.isArray(parsed.generated_root_documents)
        ? parsed.generated_root_documents.filter((value): value is string =>
          ROOT_INSTRUCTION_DOCUMENTS.includes(value as typeof ROOT_INSTRUCTION_DOCUMENTS[number]))
        : []
    };
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) {
      return { schema_version: 1, generated_root_documents: [] };
    }
    throw error;
  }
}

async function writeProvenance(
  projectRoot: string,
  generatedRootDocuments: readonly string[]
): Promise<void> {
  const current = await readProvenance(projectRoot);
  const merged = [...new Set([
    ...current.generated_root_documents,
    ...generatedRootDocuments.filter((value) =>
      ROOT_INSTRUCTION_DOCUMENTS.includes(value as typeof ROOT_INSTRUCTION_DOCUMENTS[number]))
  ])].sort();
  await mkdir(join(projectRoot, ".harness", "state", "local"), { recursive: true });
  await writeFile(
    join(projectRoot, PROVENANCE_RELATIVE),
    JSON.stringify({ schema_version: 1, generated_root_documents: merged }, null, 2) + "\n",
    "utf8"
  );
}

async function isTracked(projectRoot: string, relativePath: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["ls-files", "--error-unmatch", "--", relativePath], {
      cwd: projectRoot,
      windowsHide: true
    });
    return true;
  } catch {
    return false;
  }
}

function normalizeProjectionPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return null;
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) ||
      normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
    return null;
  }
  return PROJECTION_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    ? normalized
    : null;
}

async function readInstalledProjectionPaths(projectRoot: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(
      await readFile(join(projectRoot, INSTALLED_BUNDLE_RELATIVE), "utf8")
    ) as { files?: Array<{ target_path?: unknown }> };
    if (!Array.isArray(parsed.files)) return [];
    return [...new Set(parsed.files
      .map((file) => normalizeProjectionPath(file.target_path))
      .filter((value): value is string => value !== null))].sort();
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) return [];
    throw error;
  }
}

function coveredByHarnessPattern(path: string): boolean {
  return /^(?:\.claude|\.agents|\.cursor|\.codebuddy)\/skills\/harness-[^/]+\//.test(path) ||
    /^(?:\.claude|\.agents|\.cursor|\.codebuddy)\/(?:agents|rules)\/harness-[^/]+\.md$/.test(path) ||
    /^\.codebuddy\/\.rules\/harness-[^/]+\.mdc$/.test(path);
}

async function trackedPathSet(projectRoot: string, paths: readonly string[]): Promise<Set<string>> {
  const tracked = new Set<string>();
  for (let index = 0; index < paths.length; index += 100) {
    const batch = paths.slice(index, index + 100);
    try {
      const result = await execFileAsync("git", ["ls-files", "-z", "--", ...batch], {
        cwd: projectRoot,
        windowsHide: true,
        encoding: "utf8"
      });
      for (const value of result.stdout.split("\0")) {
        const normalized = value === "" ? null : normalizeProjectionPath(value);
        if (normalized !== null) tracked.add(normalized);
      }
    } catch {
      // A missing Git executable or non-worktree is handled like an empty index.
      return new Set();
    }
  }
  return tracked;
}

function removeGeneratedProjectionBlock(content: string): {
  content: string;
  patterns: Set<string>;
} {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === GENERATED_PROJECTIONS_START);
  if (start < 0) return { content, patterns: new Set() };
  const endOffset = lines.slice(start + 1)
    .findIndex((line) => line.trim() === GENERATED_PROJECTIONS_END);
  if (endOffset < 0) return { content, patterns: new Set() };
  const end = start + 1 + endOffset;
  const patterns = new Set(lines.slice(start + 1, end).map((line) => line.trim()).filter(Boolean));
  lines.splice(start, end - start + 1);
  if (start === 0 && lines[0] === "") lines.shift();
  return { content: lines.join(eol), patterns };
}

async function hasGitWorkTree(projectRoot: string): Promise<boolean> {
  try {
    const result = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: projectRoot,
      windowsHide: true
    });
    return result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function effectivelyIgnored(
  projectRoot: string,
  entries: readonly { pattern: string; probe: string }[]
): Promise<Set<string>> {
  if (entries.length === 0) return new Set();
  let stdout = "";
  try {
    const result = await execFileAsync(
      "git",
      ["check-ignore", "--no-index", "--", ...entries.map((entry) => entry.probe)],
      {
      cwd: projectRoot,
        windowsHide: true,
        encoding: "utf8"
      }
    );
    stdout = result.stdout;
  } catch (error) {
    if (error !== null && typeof error === "object" && "stdout" in error &&
        typeof error.stdout === "string") {
      stdout = error.stdout;
    }
  }
  const ignoredProbes = new Set(stdout.split(/\r?\n/).filter((value) => value.length > 0));
  return new Set(entries
    .filter((entry) => ignoredProbes.has(entry.probe))
    .map((entry) => entry.pattern));
}

export async function existingRootInstructionDocuments(
  projectRoot: string
): Promise<Set<string>> {
  const result = new Set<string>();
  await Promise.all(ROOT_INSTRUCTION_DOCUMENTS.map(async (name) => {
    try {
      await access(join(projectRoot, name));
      result.add(name);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }));
  return result;
}

/**
 * Add only Harness-owned local paths to Git's ignore file. Existing user namespaces,
 * tracked instruction documents and explicit negations are always preserved.
 */
export async function ensureHarnessGitignore(
  projectRoot: string,
  options: EnsureHarnessGitignoreOptions = {}
): Promise<EnsureHarnessGitignoreResult> {
  if (options.dryRun !== true && options.generatedRootDocuments !== undefined) {
    await writeProvenance(projectRoot, options.generatedRootDocuments);
  }

  const gitignorePath = join(projectRoot, ".gitignore");
  let content = "";
  try {
    content = await readFile(gitignorePath, "utf8");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const byteOrderMark = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  if (byteOrderMark !== "") content = content.slice(1);
  const originalContent = content;
  const generatedBlock = removeGeneratedProjectionBlock(content);
  content = generatedBlock.content;
  const lines = content.split(/\r?\n/);
  const existing = new Set(lines.map((line) => line.trim()));
  const gitWorkTree = await hasGitWorkTree(projectRoot);
  const wanted = [...HARNESS_GITIGNORE_ENTRIES] as Array<{ pattern: string; probe: string }>;
  const patternResults: GitignorePatternResult[] = [];
  const ignoredRootDocuments: string[] = [];
  if (options.platformBound === true) {
    const provenance = await readProvenance(projectRoot);
    for (const document of provenance.generated_root_documents) {
      const pattern = "/" + document;
      if (await isTracked(projectRoot, document)) {
        patternResults.push({ pattern, status: "tracked" });
      } else {
        wanted.push({ pattern, probe: document });
        ignoredRootDocuments.push(document);
      }
    }
  }

  const projectionPaths = (await readInstalledProjectionPaths(projectRoot))
    .filter((path) => !coveredByHarnessPattern(path));
  const trackedProjections = gitWorkTree
    ? await trackedPathSet(projectRoot, projectionPaths)
    : new Set<string>();
  const generatedEntries: Array<{ pattern: string; probe: string }> = [];
  for (const path of projectionPaths) {
    const pattern = "/" + path;
    if (trackedProjections.has(path)) {
      patternResults.push({ pattern, status: "tracked" });
    } else {
      generatedEntries.push({ pattern, probe: path });
    }
  }

  const initiallyIgnored = gitWorkTree
    ? await effectivelyIgnored(projectRoot, wanted)
    : new Set<string>();
  const missing: Array<{ pattern: string; probe: string }> = [];
  for (const entry of wanted) {
    if (initiallyIgnored.has(entry.pattern)) {
      patternResults.push({ pattern: entry.pattern, status: "already-ignored" });
    } else if (existing.has(entry.pattern)) {
      patternResults.push({
        pattern: entry.pattern,
        status: gitWorkTree ? "preserved-by-negation" : "already-present"
      });
    } else {
      missing.push(entry);
    }
  }
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const generatedLines = generatedEntries.length === 0
    ? []
    : [
        GENERATED_PROJECTIONS_START,
        ...generatedEntries.map((entry) => entry.pattern),
        GENERATED_PROJECTIONS_END
      ];
  const headingNeeded = missing.length > 0 && !existing.has("# Hunter Harness（本地生成，不提交）");
  const prefix = [
    ...generatedLines,
    ...(headingNeeded ? ["# Hunter Harness（本地生成，不提交）"] : []),
    ...missing.map((entry) => entry.pattern)
  ];
  const nextContent = prefix.length === 0
    ? content
    : prefix.join(eol) + eol + (content.length === 0 ? "" : content);
  const changed = nextContent !== originalContent;
  if (options.dryRun !== true) {
    // Managed patterns stay before user content so later user negations retain
    // normal Git precedence instead of being silently overridden by the CLI.
    if (changed) await writeFile(gitignorePath, byteOrderMark + nextContent, "utf8");
    const ignoredAfterWrite = gitWorkTree
      ? await effectivelyIgnored(projectRoot, [...missing, ...generatedEntries])
      : new Set([...missing, ...generatedEntries].map((entry) => entry.pattern));
    for (const entry of [...missing, ...generatedEntries]) {
      patternResults.push({
        pattern: entry.pattern,
        status: ignoredAfterWrite.has(entry.pattern)
          ? (generatedBlock.patterns.has(entry.pattern) ? "already-present" : "added")
          : "preserved-by-negation"
      });
    }
  } else {
    patternResults.push(...missing.map((entry) => ({
      pattern: entry.pattern,
      status: "planned" as const
    })));
    patternResults.push(...generatedEntries.map((entry) => ({
      pattern: entry.pattern,
      status: generatedBlock.patterns.has(entry.pattern) ? "already-present" as const : "planned" as const
    })));
  }
  return {
    changed,
    path: ".gitignore",
    ignoredRootDocuments,
    skippedBecauseOfNegation: patternResults.some((item) => item.status === "preserved-by-negation"),
    patternResults
  };
}
