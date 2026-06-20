import type { KnowledgeFrontmatter } from "@hunter-harness/contracts";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { atomicWriteJson } from "../state/atomic.js";
import { parseKnowledgeMarkdown, type ParsedKnowledge } from "./frontmatter.js";

export interface KnowledgeIndexEntry extends KnowledgeFrontmatter {
  path: string;
  content_sha256: string;
  summary: string;
  local: boolean;
}

export interface KnowledgeIndex {
  schema_version: 1;
  generated_at: string;
  entries: KnowledgeIndexEntry[];
}

export interface BuildKnowledgeIndexOptions {
  now?: Date;
  includeLocal?: boolean;
}

const MAX_ENTRY_BYTES = 64 * 1024;

async function markdownPaths(root: string, current = root): Promise<string[]> {
  const paths: string[] = [];
  for (const item of await readdir(current, { withFileTypes: true })) {
    const path = join(current, item.name);
    if (item.isSymbolicLink()) {
      throw new Error("knowledge symlinks are not supported: " + path);
    }
    if (item.isDirectory()) {
      paths.push(...await markdownPaths(root, path));
    } else if (item.isFile() && item.name.endsWith(".md")) {
      paths.push(path);
    }
  }
  return paths;
}

function assertUnique(entries: readonly ParsedKnowledge[]): void {
  const ids = new Set<string>();
  const content = new Map<string, string>();
  for (const entry of entries) {
    if (ids.has(entry.frontmatter.id)) {
      throw new Error("duplicate id: " + entry.frontmatter.id);
    }
    ids.add(entry.frontmatter.id);
    const duplicatePath = content.get(entry.contentHash);
    if (duplicatePath !== undefined) {
      throw new Error(
        "duplicate content: " + duplicatePath + " and " + entry.path
      );
    }
    content.set(entry.contentHash, entry.path);
  }
}

function assertRelationshipGraph(entries: readonly ParsedKnowledge[]): void {
  const byId = new Map(entries.map((entry) => [entry.frontmatter.id, entry]));
  const edges = new Map<string, Set<string>>();
  const addEdge = (newer: string, older: string): void => {
    if (!byId.has(older)) {
      throw new Error("unknown supersedes relationship: " + older);
    }
    const targets = edges.get(newer) ?? new Set<string>();
    targets.add(older);
    edges.set(newer, targets);
  };
  for (const entry of entries) {
    for (const older of entry.frontmatter.supersedes) {
      addEdge(entry.frontmatter.id, older);
      const reverse = byId.get(older)?.frontmatter.superseded_by ?? [];
      if (!reverse.includes(entry.frontmatter.id)) {
        throw new Error("inconsistent reverse supersedes link: " + older);
      }
    }
    for (const newer of entry.frontmatter.superseded_by) {
      if (!byId.has(newer)) {
        throw new Error("unknown superseded_by relationship: " + newer);
      }
      addEdge(newer, entry.frontmatter.id);
      const reverse = byId.get(newer)?.frontmatter.supersedes ?? [];
      if (!reverse.includes(entry.frontmatter.id)) {
        throw new Error("inconsistent reverse superseded_by link: " + newer);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      throw new Error("supersedes cycle detected at " + id);
    }
    if (visited.has(id)) {
      return;
    }
    visiting.add(id);
    for (const target of edges.get(id) ?? []) {
      visit(target);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) {
    visit(id);
  }
}

function isLocal(entry: ParsedKnowledge): boolean {
  return entry.path.startsWith("project-local/") ||
    entry.frontmatter.type === "project-local" ||
    entry.frontmatter.scope === "local";
}

export function buildKnowledgeIndex(
  entries: readonly ParsedKnowledge[],
  options: BuildKnowledgeIndexOptions = {}
): KnowledgeIndex {
  assertUnique(entries);
  assertRelationshipGraph(entries);
  const now = options.now ?? new Date();
  const indexed = entries
    .filter((entry) => options.includeLocal === true || !isLocal(entry))
    .map((entry): KnowledgeIndexEntry => {
      const expired = entry.frontmatter.expires_at !== null &&
        Date.parse(entry.frontmatter.expires_at) <= now.getTime();
      return {
        ...entry.frontmatter,
        status: expired && entry.frontmatter.status === "active"
          ? "stale"
          : entry.frontmatter.status,
        path: entry.path,
        content_sha256: entry.contentHash,
        summary: entry.summary,
        local: isLocal(entry)
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    schema_version: 1,
    generated_at: now.toISOString(),
    entries: indexed
  };
}

export function validateCandidatePromotion(entry: ParsedKnowledge): {
  candidate_id: string;
  target_status: "active";
  requires_server_review: true;
} {
  if (!entry.path.startsWith("_candidates/") ||
      entry.frontmatter.status !== "candidate") {
    throw new Error("candidate promotion requires a _candidates entry");
  }
  if (entry.frontmatter.confidence === "verified") {
    throw new Error("candidate confidence cannot be verified before review");
  }
  return {
    candidate_id: entry.frontmatter.id,
    target_status: "active",
    requires_server_review: true
  };
}

export async function rebuildKnowledgeIndex(
  knowledgeRoot: string,
  options: BuildKnowledgeIndexOptions = {}
): Promise<KnowledgeIndex> {
  const root = resolve(knowledgeRoot);
  const entries = [];
  for (const path of (await markdownPaths(root)).sort()) {
    const content = await readFile(path, "utf8");
    if (Buffer.byteLength(content) > MAX_ENTRY_BYTES) {
      throw new Error("knowledge entry exceeds 64 KiB: " + path);
    }
    entries.push(parseKnowledgeMarkdown(
      content,
      relative(root, path).replaceAll("\\", "/")
    ));
  }
  const index = buildKnowledgeIndex(entries, options);
  await atomicWriteJson(join(root, "index.json"), index);
  return index;
}
