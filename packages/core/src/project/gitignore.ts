import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
  if (missing.length === 0) {
    return {
      changed: false,
      path: ".gitignore",
      ignoredRootDocuments,
      skippedBecauseOfNegation: patternResults.some((item) => item.status === "preserved-by-negation"),
      patternResults
    };
  }
  if (options.dryRun !== true) {
    const eol = content.includes("\r\n") ? "\r\n" : "\n";
    const headingNeeded = !existing.has("# Hunter Harness（本地生成，不提交）");
    const block = [
      ...(headingNeeded ? ["# Hunter Harness（本地生成，不提交）"] : []),
      ...missing.map((entry) => entry.pattern)
    ].join(eol);
    // Managed patterns stay before user content so later user negations retain
    // normal Git precedence instead of being silently overridden by the CLI.
    await writeFile(
      gitignorePath,
      byteOrderMark + block + eol + (content.length === 0 ? "" : content),
      "utf8"
    );
    const ignoredAfterWrite = gitWorkTree
      ? await effectivelyIgnored(projectRoot, missing)
      : new Set(missing.map((entry) => entry.pattern));
    for (const entry of missing) {
      patternResults.push({
        pattern: entry.pattern,
        status: ignoredAfterWrite.has(entry.pattern) ? "added" : "preserved-by-negation"
      });
    }
  } else {
    patternResults.push(...missing.map((entry) => ({
      pattern: entry.pattern,
      status: "planned" as const
    })));
  }
  return {
    changed: true,
    path: ".gitignore",
    ignoredRootDocuments,
    skippedBecauseOfNegation: patternResults.some((item) => item.status === "preserved-by-negation"),
    patternResults
  };
}
