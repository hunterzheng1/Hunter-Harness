import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import {
  ManagedBlockStructureError,
  parseManagedBlocks
} from "../managed/managed-block.js";

export type InstructionGraphStatus = "OK" | "WARN" | "FAIL";

export interface InstructionGraphTopic {
  status: "OK" | "WARN";
  evidencePaths: string[];
}

export interface InstructionGraphResult {
  status: InstructionGraphStatus;
  entrypointIntegrity: {
    status: "OK" | "FAIL";
    reasonCodes: string[];
  };
  effectiveGuidanceTopics: {
    architecture: InstructionGraphTopic;
    testing: InstructionGraphTopic;
    codingStyle: InstructionGraphTopic;
    build: InstructionGraphTopic;
    stack: InstructionGraphTopic;
  };
  reachableFiles: string[];
  unresolvedReferences: string[];
  cycles: string[][];
  maxDepth: number;
  totalBytes: number;
  ownership: Record<string, "project" | "harness-managed" | "generated">;
}

const MAX_FILES = 64;
const MAX_DEPTH = 8;
const MAX_BYTES = 512 * 1024;

const TOPICS = {
  architecture: ["architecture", "架构", "module boundary", "dependency"],
  testing: ["testing", "test", "测试", "verification"],
  codingStyle: ["coding-style", "coding style", "编码", "lint", "style"],
  build: ["build", "compile", "构建", "编译"],
  stack: ["stack", "technology", "技术栈", "runtime"]
} as const;

function projectRelative(root: string, path: string): string {
  return relative(root, path).replace(/\\/g, "/");
}

function safeProjectPath(root: string, from: string, reference: string): string | null {
  if (reference.includes("://") || isAbsolute(reference)) return null;
  const sourcePath = projectRelative(root, from);
  const projectRootRelative =
    reference.startsWith(".") || sourcePath === ".harness/context-index.json";
  const candidate = resolve(
    root,
    projectRootRelative
      ? reference
      : projectRelative(root, resolve(dirname(from), reference))
  );
  const rel = projectRelative(root, candidate);
  if (rel === ".." || rel.startsWith("../")) return null;
  return candidate;
}

function markdownReferences(content: string): string[] {
  const references = new Set<string>();
  for (const match of content.matchAll(/@([A-Za-z0-9_.\-/]+\.(?:md|json))/gi)) {
    if (match[1] !== undefined) references.add(match[1]);
  }
  for (const match of content.matchAll(/`((?:\.?\.?\/)?[A-Za-z0-9_.\-/]+\.(?:md|json))`/gi)) {
    if (match[1] !== undefined) references.add(match[1]);
  }
  return [...references];
}

function jsonReferences(value: unknown, output = new Set<string>()): Set<string> {
  if (typeof value === "string" && /\.(?:md|json)$/i.test(value)) {
    output.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) jsonReferences(item, output);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) jsonReferences(item, output);
  }
  return output;
}

async function existsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function ownershipOf(path: string): "project" | "harness-managed" | "generated" {
  if (path.startsWith(".harness/codebase/") || path.startsWith(".harness/knowledge/")) {
    return "generated";
  }
  if (path.startsWith(".harness/rules/") || path === "AGENTS.md" || path === "CLAUDE.md") {
    return "harness-managed";
  }
  return "project";
}

export async function validateInstructionGraph(
  projectRoot: string,
  entrypoint = "CLAUDE.md"
): Promise<InstructionGraphResult> {
  const root = resolve(projectRoot);
  const entry = resolve(root, entrypoint);
  const reachable = new Map<string, string>();
  const ownership: InstructionGraphResult["ownership"] = {};
  const unresolved = new Set<string>();
  const reasonCodes = new Set<string>();
  const cycles: string[][] = [];
  const visiting: string[] = [];
  let maxDepth = 0;
  let totalBytes = 0;

  const visit = async (path: string, depth: number): Promise<void> => {
    const rel = projectRelative(root, path);
    if (depth > MAX_DEPTH || reachable.size >= MAX_FILES || totalBytes >= MAX_BYTES) {
      reasonCodes.add("INSTRUCTION_GRAPH_BUDGET_EXCEEDED");
      return;
    }
    const cycleAt = visiting.indexOf(rel);
    if (cycleAt >= 0) {
      cycles.push([...visiting.slice(cycleAt), rel]);
      reasonCodes.add("INSTRUCTION_REFERENCE_CYCLE");
      return;
    }
    if (reachable.has(rel)) return;
    if (!(await existsFile(path))) {
      unresolved.add(rel);
      reasonCodes.add("INSTRUCTION_REFERENCE_MISSING");
      return;
    }
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch {
      unresolved.add(rel);
      reasonCodes.add("INSTRUCTION_REFERENCE_UNREADABLE");
      return;
    }
    totalBytes += Buffer.byteLength(content);
    maxDepth = Math.max(maxDepth, depth);
    reachable.set(rel, content);
    ownership[rel] = ownershipOf(rel);
    visiting.push(rel);
    if (rel.endsWith(".md")) {
      try {
        parseManagedBlocks(content);
      } catch (error) {
        if (error instanceof ManagedBlockStructureError) {
          reasonCodes.add(error.code);
        } else {
          throw error;
        }
      }
    }
    let references: string[];
    if (rel.endsWith(".json")) {
      try {
        references = [...jsonReferences(JSON.parse(content))];
      } catch {
        reasonCodes.add("INSTRUCTION_JSON_INVALID");
        references = [];
      }
    } else {
      references = markdownReferences(content);
    }
    for (const reference of references) {
      const target = safeProjectPath(root, path, reference);
      if (target === null) {
        unresolved.add(reference);
        reasonCodes.add("INSTRUCTION_REFERENCE_OUTSIDE_PROJECT");
        continue;
      }
      const targetRelative = projectRelative(root, target);
      if (
        rel === ".harness/context-index.json" &&
        ["AGENTS.md", "CLAUDE.md", "CODEBUDDY.md"].includes(targetRelative)
      ) {
        // context-index catalogs adapter entrypoints; those ownership pointers
        // are not include edges back into the instruction graph.
        continue;
      }
      if (!(await existsFile(target))) {
        unresolved.add(targetRelative);
        reasonCodes.add("INSTRUCTION_REFERENCE_MISSING");
        continue;
      }
      await visit(target, depth + 1);
    }
    visiting.pop();
  };

  await visit(entry, 0);
  const topics = Object.fromEntries(
    Object.entries(TOPICS).map(([topic, keywords]) => {
      const evidencePaths = [...reachable.entries()]
        .filter(([path, content]) => {
          const haystack = `${path}\n${content}`.toLowerCase();
          return keywords.some((keyword) => haystack.includes(keyword.toLowerCase()));
        })
        .map(([path]) => path);
      return [
        topic,
        {
          status: evidencePaths.length > 0 ? "OK" : "WARN",
          evidencePaths
        }
      ];
    })
  ) as InstructionGraphResult["effectiveGuidanceTopics"];
  const integrityFailed = reasonCodes.size > 0;
  const topicsMissing = Object.values(topics).some((topic) => topic.status === "WARN");
  return {
    status: integrityFailed ? "FAIL" : topicsMissing ? "WARN" : "OK",
    entrypointIntegrity: {
      status: integrityFailed ? "FAIL" : "OK",
      reasonCodes: [...reasonCodes].sort()
    },
    effectiveGuidanceTopics: topics,
    reachableFiles: [...reachable.keys()].sort(),
    unresolvedReferences: [...unresolved].sort(),
    cycles,
    maxDepth,
    totalBytes,
    ownership
  };
}
