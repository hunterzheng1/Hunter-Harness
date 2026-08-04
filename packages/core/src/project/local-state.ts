import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  lstat,
  readFile,
  readdir,
  readlink
} from "node:fs/promises";
import { join, relative } from "node:path";

import { sha256File } from "../fs/hash.js";

export const PROTECTED_LOCAL_ROOTS = [
  ".harness/archive",
  ".harness/changes",
  ".harness/knowledge/project-local"
] as const;

const ADAPTER_SKILL_ROOTS = [
  ".agents/skills",
  ".claude/skills",
  ".cursor/skills",
  ".codebuddy/skills"
] as const;

const MANAGED_INSTRUCTION_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "CODEBUDDY.md"
] as const;

const RECOVERY_TRANSACTION_STATES = new Set([
  "applying",
  "interrupted",
  "rolling_back",
  "recovery_required"
]);

export interface ProtectedLocalRootInventory {
  path: typeof PROTECTED_LOCAL_ROOTS[number];
  exists: boolean;
  files: number;
  directories: number;
  bytes: number;
  merkleRoot: string;
  firstIdentity: string | null;
  lastIdentity: string | null;
}

export interface HarnessStateEvidence {
  sentinels: string[];
  protectedLocalRoots: ProtectedLocalRootInventory[];
  recoveryRequired: boolean;
  recoveryTransactions: string[];
}

interface InventoryEntry {
  path: string;
  kind: "file" | "symlink";
  bytes: number;
  sha256: string;
}

async function optionalStat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function directoryHasEntries(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length > 0;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function collectInventoryEntries(
  root: string,
  directory: string,
  entries: InventoryEntry[]
): Promise<number> {
  let directories = 0;
  const children = await readdir(directory, { withFileTypes: true });
  for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = join(directory, child.name);
    const portable = relative(root, absolute).replaceAll("\\", "/");
    if (child.isDirectory()) {
      directories += 1;
      directories += await collectInventoryEntries(root, absolute, entries);
      continue;
    }
    if (child.isSymbolicLink()) {
      const target = await readlink(absolute);
      entries.push({
        path: portable,
        kind: "symlink",
        bytes: Buffer.byteLength(target),
        sha256: "sha256:" + createHash("sha256").update(target).digest("hex")
      });
      continue;
    }
    if (!child.isFile()) continue;
    const metadata = await lstat(absolute);
    entries.push({
      path: portable,
      kind: "file",
      bytes: metadata.size,
      sha256: await sha256File(absolute)
    });
  }
  return directories;
}

export async function collectProtectedLocalRootsInventory(
  projectRoot: string
): Promise<ProtectedLocalRootInventory[]> {
  const inventories: ProtectedLocalRootInventory[] = [];
  for (const protectedPath of PROTECTED_LOCAL_ROOTS) {
    const absolute = join(projectRoot, protectedPath);
    const metadata = await optionalStat(absolute);
    if (metadata === null) {
      inventories.push({
        path: protectedPath,
        exists: false,
        files: 0,
        directories: 0,
        bytes: 0,
        merkleRoot: "sha256:" + createHash("sha256").digest("hex"),
        firstIdentity: null,
        lastIdentity: null
      });
      continue;
    }
    const entries: InventoryEntry[] = [];
    let directories = 0;
    if (metadata.isDirectory()) {
      directories = await collectInventoryEntries(absolute, absolute, entries);
    } else if (metadata.isSymbolicLink()) {
      const target = await readlink(absolute);
      entries.push({
        path: ".",
        kind: "symlink",
        bytes: Buffer.byteLength(target),
        sha256: "sha256:" + createHash("sha256").update(target).digest("hex")
      });
    } else if (metadata.isFile()) {
      entries.push({
        path: ".",
        kind: "file",
        bytes: Number(metadata.size),
        sha256: await sha256File(absolute)
      });
    }
    const sorted = entries.sort((left, right) => left.path.localeCompare(right.path));
    const digest = createHash("sha256");
    for (const entry of sorted) {
      digest.update(
        `${entry.kind}\0${entry.path}\0${entry.bytes}\0${entry.sha256}\n`,
        "utf8"
      );
    }
    const identities = protectedPath === ".harness/archive" && metadata.isDirectory()
      ? (await readdir(absolute, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
      : [];
    inventories.push({
      path: protectedPath,
      exists: true,
      files: sorted.length,
      directories,
      bytes: sorted.reduce((total, entry) => total + entry.bytes, 0),
      merkleRoot: "sha256:" + digest.digest("hex"),
      firstIdentity: identities[0] ?? null,
      lastIdentity: identities.at(-1) ?? null
    });
  }
  return inventories;
}

async function collectHarnessDirectorySentinels(projectRoot: string): Promise<string[]> {
  const harnessRoot = join(projectRoot, ".harness");
  let entries: Dirent<string>[];
  try {
    entries = await readdir(harnessRoot, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const sentinels: string[] = [];
  for (const entry of entries) {
    if (entry.name === "project.yaml" || entry.name === "cache") continue;
    const relativePath = `.harness/${entry.name}`;
    const absolute = join(harnessRoot, entry.name);
    if (entry.isDirectory()) {
      if (await directoryHasEntries(absolute)) sentinels.push(relativePath);
      continue;
    }
    sentinels.push(relativePath);
  }
  return sentinels;
}

async function findAdapterBuildMarkers(projectRoot: string): Promise<string[]> {
  const markers: string[] = [];
  for (const root of ADAPTER_SKILL_ROOTS) {
    const absoluteRoot = join(projectRoot, root);
    let skills: Dirent<string>[];
    try {
      skills = await readdir(absoluteRoot, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    for (const skill of skills) {
      if (!skill.isDirectory()) continue;
      const marker = join(absoluteRoot, skill.name, ".harness-build.json");
      if (await optionalStat(marker) !== null) {
        markers.push(`${root}/${skill.name}/.harness-build.json`);
      }
    }
  }
  return markers;
}

async function findManagedInstructionMarkers(projectRoot: string): Promise<string[]> {
  const sentinels: string[] = [];
  for (const name of MANAGED_INSTRUCTION_FILES) {
    try {
      const content = await readFile(join(projectRoot, name), "utf8");
      if (content.includes("<!-- hunter-harness:start")) sentinels.push(name);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
  }
  return sentinels;
}

async function findRecoveryTransactions(projectRoot: string): Promise<string[]> {
  const root = join(projectRoot, ".harness", "state", "transactions");
  let entries: Dirent<string>[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const transactions: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const journal = JSON.parse(
        await readFile(join(root, entry.name, "journal.json"), "utf8")
      ) as { state?: unknown };
      if (typeof journal.state === "string" &&
          RECOVERY_TRANSACTION_STATES.has(journal.state)) {
        transactions.push(entry.name);
      }
    } catch {
      transactions.push(entry.name);
    }
  }
  return transactions.sort();
}

export async function inspectHarnessStateEvidence(
  projectRoot: string
): Promise<HarnessStateEvidence> {
  const [
    harnessSentinels,
    adapterMarkers,
    instructionMarkers,
    protectedLocalRoots,
    recoveryTransactions
  ] = await Promise.all([
    collectHarnessDirectorySentinels(projectRoot),
    findAdapterBuildMarkers(projectRoot),
    findManagedInstructionMarkers(projectRoot),
    collectProtectedLocalRootsInventory(projectRoot),
    findRecoveryTransactions(projectRoot)
  ]);
  return {
    sentinels: [...new Set([
      ...harnessSentinels,
      ...adapterMarkers,
      ...instructionMarkers
    ])].sort(),
    protectedLocalRoots,
    recoveryRequired: recoveryTransactions.length > 0,
    recoveryTransactions
  };
}
