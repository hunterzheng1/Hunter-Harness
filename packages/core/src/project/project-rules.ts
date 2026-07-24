import { createHash } from "node:crypto";
import {
  mkdir, readFile, readdir, rename, unlink, writeFile
} from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

import type { CodeBuddySurface, HarnessAgent } from "@hunter-harness/contracts";

import {
  removeManagedBlockById,
  upsertManagedBlockById
} from "../managed/managed-block.js";

const RULES_ROOT = ".harness/rules";
const RECEIPT_PATH = ".harness/state/local/rule-projections.json";
const CODEX_BLOCK_ID = "hunter-harness-project-rules";
const MANAGED_NAMES = new Set([
  "harness-general.md", "harness-general.mdc",
  "harness-profile-java.md", "harness-profile-java.mdc"
]);

interface ProjectionReceipt {
  schema_version: 1;
  source_hashes: Record<string, string>;
  targets: Record<string, string>;
}

export interface ProjectRuleSyncResult {
  migrated: string[];
  written: string[];
  removed: string[];
  unchanged: string[];
  conflicts: string[];
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function optionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function readReceipt(root: string): Promise<ProjectionReceipt> {
  try {
    const parsed = JSON.parse(await readFile(join(root, RECEIPT_PATH), "utf8")) as ProjectionReceipt;
    if (parsed.schema_version === 1 && parsed.targets && parsed.source_hashes) return parsed;
  } catch {
    // Missing or invalid local receipt is an untrusted baseline.
  }
  return { schema_version: 1, source_hashes: {}, targets: {} };
}

async function markdownFiles(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && [".md", ".mdc"].includes(extname(entry.name).toLowerCase()))
      .map((entry) => entry.name)
      .filter((name) => !MANAGED_NAMES.has(name))
      .sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

function targetsFor(
  name: string,
  agents: readonly HarnessAgent[],
  surface: CodeBuddySurface
): string[] {
  const stem = basename(name, extname(name));
  const targets: string[] = [];
  if (agents.includes("claude-code")) targets.push(`.claude/rules/${stem}.md`);
  if (agents.includes("cursor")) targets.push(`.cursor/rules/${stem}.mdc`);
  if (agents.includes("codebuddy") && surface !== "cli") {
    targets.push(`.codebuddy/.rules/${stem}.mdc`);
  }
  if (agents.includes("codebuddy") && surface !== "ide") {
    targets.push(`.codebuddy/rules/${stem}.md`);
  }
  return targets;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

/**
 * Materialize canonical project rules for each selected agent.
 *
 * Physical links are deliberately avoided: they are unreliable on Windows,
 * rejected by push safety checks, and poorly represented by remote artifacts.
 * A local receipt allows clean projections to update while preserving edits.
 */
export async function synchronizeProjectRules(
  projectRoot: string,
  agents: readonly HarnessAgent[],
  surface: CodeBuddySurface = "both"
): Promise<ProjectRuleSyncResult> {
  const root = resolve(projectRoot);
  const canonicalRoot = join(root, RULES_ROOT);
  const result: ProjectRuleSyncResult = {
    migrated: [], written: [], removed: [], unchanged: [], conflicts: []
  };
  await mkdir(canonicalRoot, { recursive: true });

  if ((await markdownFiles(canonicalRoot)).length === 0) {
    for (const name of await markdownFiles(join(root, ".claude", "rules"))) {
      const destination = join(canonicalRoot, `${basename(name, extname(name))}.md`);
      if (await optionalText(destination) !== null) continue;
      const content = await readFile(join(root, ".claude", "rules", name), "utf8");
      await atomicWrite(destination, content);
      result.migrated.push(`${RULES_ROOT}/${basename(destination)}`);
    }
  }

  const previous = await readReceipt(root);
  const next: ProjectionReceipt = { schema_version: 1, source_hashes: {}, targets: {} };
  const desired = new Map<string, string>();
  for (const name of await markdownFiles(canonicalRoot)) {
    const sourcePath = `${RULES_ROOT}/${name}`;
    const content = await readFile(join(canonicalRoot, name), "utf8");
    next.source_hashes[sourcePath] = sha256(content);
    for (const target of targetsFor(name, agents, surface)) desired.set(target, content);
  }

  for (const [target, content] of desired) {
    const path = join(root, target);
    const current = await optionalText(path);
    const incomingHash = sha256(content);
    if (current === content) {
      result.unchanged.push(target);
      next.targets[target] = incomingHash;
    } else if (current === null || previous.targets[target] === sha256(current)) {
      await atomicWrite(path, content);
      result.written.push(target);
      next.targets[target] = incomingHash;
    } else {
      result.conflicts.push(target);
      next.targets[target] = previous.targets[target] ?? sha256(current);
    }
  }

  for (const [target, trustedHash] of Object.entries(previous.targets)) {
    if (target === "AGENTS.md") continue;
    if (desired.has(target)) continue;
    const path = join(root, target);
    const current = await optionalText(path);
    if (current === null) continue;
    if (sha256(current) === trustedHash) {
      await unlink(path);
      result.removed.push(target);
    } else {
      result.conflicts.push(target);
      next.targets[target] = trustedHash;
    }
  }

  if (agents.includes("codex")) {
    const rules = Object.keys(next.source_hashes).sort();
    const body = [
        "Before project work, read and follow these shared project rules:",
        ...rules.map((path) => `- \`${path}\``)
      ].join("\n");
    const agentsPath = join(root, "AGENTS.md");
    const current = await optionalText(agentsPath) ?? "";
    const updated = rules.length > 0
      ? upsertManagedBlockById(current, CODEX_BLOCK_ID, body)
      : removeManagedBlockById(current, CODEX_BLOCK_ID);
    const target = "AGENTS.md";
    const semanticallyEqual = updated.replace(/\r\n/g, "\n").trimEnd() ===
      current.replace(/\r\n/g, "\n").trimEnd();
    if (semanticallyEqual) result.unchanged.push(target);
    else {
      await atomicWrite(agentsPath, updated);
      result.written.push(target);
    }
    if (rules.length > 0) {
      next.targets[target] = sha256(semanticallyEqual ? current : updated);
    }
  } else if (Object.prototype.hasOwnProperty.call(previous.targets, "AGENTS.md")) {
    const agentsPath = join(root, "AGENTS.md");
    const current = await optionalText(agentsPath);
    if (current !== null) {
      const updated = removeManagedBlockById(current, CODEX_BLOCK_ID);
      if (updated !== current) {
        await atomicWrite(agentsPath, updated);
        result.written.push("AGENTS.md");
      }
    }
  }

  await atomicWrite(join(root, RECEIPT_PATH), JSON.stringify(next, null, 2) + "\n");
  result.migrated.sort();
  result.written.sort();
  result.removed.sort();
  result.unchanged.sort();
  result.conflicts = [...new Set(result.conflicts)].sort();
  return result;
}
