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

export type InstructionEdgeType = "include" | "catalog" | "ownership";

export type InstructionReferenceTokenType =
  | "inline-code"
  | "at-ref"
  | "markdown-link"
  | "json-field";

export type InstructionResolutionRoot = "project-root" | "document-relative";

export interface InstructionResolutionTrace {
  rawToken: string;
  tokenType: InstructionReferenceTokenType;
  attemptedRoots: InstructionResolutionRoot[];
  selectedRoot: InstructionResolutionRoot | null;
  selectedPath: string | null;
  rejectionReason: string | null;
}

export interface InstructionGraphEdge {
  from: string;
  to: string;
  type: InstructionEdgeType;
  sourceField: string | null;
  traversed: boolean;
  reason: string | null;
  resolutionTrace?: InstructionResolutionTrace;
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
  edges: InstructionGraphEdge[];
  diagnostics: {
    edgeCount: number;
    edgeTypeCounts: Record<InstructionEdgeType, number>;
    unresolvedCount: number;
    unresolvedOmitted: number;
    maxFiles: number;
    maxDepth: number;
    maxBytes: number;
    budgetExceededAt: string | null;
  };
}

const MAX_FILES = 64;
const MAX_DEPTH = 8;
const MAX_BYTES = 512 * 1024;
const MAX_DIAGNOSTIC_SAMPLES = 50;
const MAX_UNRESOLVED_IDENTITIES = 1024;

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

function escapesProject(root: string, candidate: string): boolean {
  const rel = projectRelative(root, candidate);
  return rel === ".." || rel.startsWith("../");
}

/**
 * Resolves a raw reference token to a candidate file path.
 *
 * - `./` / `../` tokens are document-relative only (resolved against `dirname(from)`).
 * - Every other token is treated as a project-root-relative path first (matching how
 *   most references such as `docs/ai/x.json` or `.harness/rules/x.md` are authored),
 *   falling back to document-relative resolution only when the project-root candidate
 *   does not exist. When neither candidate exists, the project-root candidate is kept
 *   for unresolved/missing reporting to match legacy (0.2.37) behavior.
 */
async function resolveReference(
  root: string,
  from: string,
  reference: string,
  tokenType: InstructionReferenceTokenType
): Promise<{ target: string | null; trace: InstructionResolutionTrace }> {
  const rawToken = reference;
  if (reference.includes("://") || isAbsolute(reference)) {
    return {
      target: null,
      trace: {
        rawToken,
        tokenType,
        attemptedRoots: [],
        selectedRoot: null,
        selectedPath: null,
        rejectionReason: "absolute-or-url"
      }
    };
  }

  if (reference.startsWith("./") || reference.startsWith("../")) {
    const candidate = resolve(dirname(from), reference);
    if (escapesProject(root, candidate)) {
      return {
        target: null,
        trace: {
          rawToken,
          tokenType,
          attemptedRoots: ["document-relative"],
          selectedRoot: null,
          selectedPath: null,
          rejectionReason: "outside-project"
        }
      };
    }
    return {
      target: candidate,
      trace: {
        rawToken,
        tokenType,
        attemptedRoots: ["document-relative"],
        selectedRoot: "document-relative",
        selectedPath: projectRelative(root, candidate),
        rejectionReason: null
      }
    };
  }

  const rootCandidate = resolve(root, reference);
  const rootOk = !escapesProject(root, rootCandidate);
  const docCandidate = resolve(dirname(from), reference);
  const docOk = !escapesProject(root, docCandidate);

  if (!rootOk && !docOk) {
    return {
      target: null,
      trace: {
        rawToken,
        tokenType,
        attemptedRoots: [],
        selectedRoot: null,
        selectedPath: null,
        rejectionReason: "outside-project"
      }
    };
  }

  const attemptedRoots: InstructionResolutionRoot[] = [
    ...(rootOk ? (["project-root"] as const) : []),
    ...(docOk ? (["document-relative"] as const) : [])
  ];
  const rootExists = rootOk && (await existsFile(rootCandidate));
  const docExists = !rootExists && docOk && (await existsFile(docCandidate));

  if (rootExists) {
    return {
      target: rootCandidate,
      trace: {
        rawToken,
        tokenType,
        attemptedRoots,
        selectedRoot: "project-root",
        selectedPath: projectRelative(root, rootCandidate),
        rejectionReason: null
      }
    };
  }
  if (docExists) {
    return {
      target: docCandidate,
      trace: {
        rawToken,
        tokenType,
        attemptedRoots,
        selectedRoot: "document-relative",
        selectedPath: projectRelative(root, docCandidate),
        rejectionReason: null
      }
    };
  }
  const preferRoot = rootOk;
  const preferred = preferRoot ? rootCandidate : docCandidate;
  return {
    target: preferred,
    trace: {
      rawToken,
      tokenType,
      attemptedRoots,
      selectedRoot: preferRoot ? "project-root" : "document-relative",
      selectedPath: projectRelative(root, preferred),
      rejectionReason: null
    }
  };
}

interface MarkdownReference {
  reference: string;
  tokenType: InstructionReferenceTokenType;
}

function markdownReferences(content: string): MarkdownReference[] {
  const references = new Map<string, InstructionReferenceTokenType>();
  const add = (reference: string, tokenType: InstructionReferenceTokenType): void => {
    if (!references.has(reference)) references.set(reference, tokenType);
  };
  for (const match of content.matchAll(/@([A-Za-z0-9_.\-/]+\.(?:md|json))/gi)) {
    if (match[1] !== undefined) add(match[1], "at-ref");
  }
  for (const match of content.matchAll(/`((?:\.?\.?\/)?[A-Za-z0-9_.\-/]+\.(?:md|json))`/gi)) {
    if (match[1] !== undefined) add(match[1], "inline-code");
  }
  for (const match of content.matchAll(/\[[^\]\n]*\]\(([A-Za-z0-9_.\-/]+\.(?:md|json))\)/gi)) {
    if (match[1] !== undefined) add(match[1], "markdown-link");
  }
  return [...references.entries()].map(([reference, tokenType]) => ({ reference, tokenType }));
}

interface TypedReference {
  reference: string;
  type: InstructionEdgeType;
  sourceField: string | null;
  tokenType: InstructionReferenceTokenType;
}

function jsonReferences(
  value: unknown,
  path: readonly string[] = [],
  output: TypedReference[] = []
): TypedReference[] {
  if (typeof value === "string" && /\.(?:md|json)$/i.test(value)) {
    const field = path.at(-1) ?? "";
    const ancestors = new Set(path);
    const type: InstructionEdgeType | null =
      field === "instructions" || field === "shared_instructions"
        ? "ownership"
        : ancestors.has("rules")
          ? "catalog"
          : ["include", "includes", "references", "imports"].includes(field)
            ? "include"
            : null;
    if (type !== null) {
      output.push({
        reference: value,
        type,
        sourceField: path.join("."),
        tokenType: "json-field"
      });
    }
  } else if (Array.isArray(value)) {
    for (const item of value) jsonReferences(item, path, output);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      jsonReferences(item, [...path, key], output);
    }
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
  if (
    path.startsWith(".harness/codebase/")
    || path.startsWith(".harness/knowledge/")
    || path.startsWith(".harness/archive/")
    || path.startsWith(".harness/runtime/")
    || path.startsWith(".harness/state/")
    || path.startsWith(".harness/cache/")
  ) {
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
  const unresolvedSamples = new Set<string>();
  const unresolvedIdentities = new Set<string>();
  let unresolvedCount = 0;
  const reasonCodes = new Set<string>();
  const cycles: string[][] = [];
  const edges: InstructionGraphEdge[] = [];
  const visiting: string[] = [];
  let maxDepth = 0;
  let totalBytes = 0;
  let budgetExceededAt: string | null = null;

  const addUnresolved = (reference: string): void => {
    const unseen = !unresolvedIdentities.has(reference);
    if (unseen) {
      unresolvedCount += 1;
      if (unresolvedIdentities.size < MAX_UNRESOLVED_IDENTITIES) {
        unresolvedIdentities.add(reference);
      }
      if (unresolvedSamples.size < MAX_DIAGNOSTIC_SAMPLES) {
        unresolvedSamples.add(reference);
      }
    }
  };

  const visit = async (path: string, depth: number): Promise<void> => {
    const rel = projectRelative(root, path);
    if (depth > MAX_DEPTH || reachable.size >= MAX_FILES || totalBytes >= MAX_BYTES) {
      reasonCodes.add("INSTRUCTION_GRAPH_BUDGET_EXCEEDED");
      budgetExceededAt ??= rel;
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
      addUnresolved(rel);
      reasonCodes.add("INSTRUCTION_REFERENCE_MISSING");
      return;
    }
    const fileStat = await stat(path);
    if (fileStat.size > MAX_BYTES - totalBytes) {
      reasonCodes.add("INSTRUCTION_GRAPH_BUDGET_EXCEEDED");
      budgetExceededAt ??= rel;
      return;
    }
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch {
      addUnresolved(rel);
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
    let references: TypedReference[];
    if (rel.endsWith(".json")) {
      try {
        references = jsonReferences(JSON.parse(content));
      } catch {
        reasonCodes.add("INSTRUCTION_JSON_INVALID");
        references = [];
      }
    } else {
      references = markdownReferences(content).map((markdownReference) => ({
        reference: markdownReference.reference,
        type: "include" as const,
        sourceField: null,
        tokenType: markdownReference.tokenType
      }));
    }
    for (const typedReference of references) {
      const { reference } = typedReference;
      const { target, trace } = await resolveReference(
        root,
        path,
        reference,
        typedReference.tokenType
      );
      if (target === null) {
        addUnresolved(reference);
        reasonCodes.add("INSTRUCTION_REFERENCE_OUTSIDE_PROJECT");
        edges.push({
          from: rel,
          to: reference,
          type: typedReference.type,
          sourceField: typedReference.sourceField,
          traversed: false,
          reason: "outside-project",
          resolutionTrace: trace
        });
        continue;
      }
      const targetRelative = projectRelative(root, target);
      if (
        rel === ".harness/context-index.json" &&
        ["AGENTS.md", "CLAUDE.md", "CODEBUDDY.md"].includes(targetRelative)
      ) {
        edges.push({
          from: rel,
          to: targetRelative,
          type: "ownership",
          sourceField: typedReference.sourceField,
          traversed: false,
          reason: "entrypoint-ownership-pointer",
          resolutionTrace: trace
        });
        continue;
      }
      if (ownershipOf(targetRelative) === "generated") {
        edges.push({
          from: rel,
          to: targetRelative,
          type: typedReference.type,
          sourceField: typedReference.sourceField,
          traversed: false,
          reason: "generated-state-boundary",
          resolutionTrace: trace
        });
        continue;
      }
      if (!(await existsFile(target))) {
        if (
          typedReference.tokenType === "inline-code"
          && !reference.includes("/")
        ) {
          edges.push({
            from: rel,
            to: targetRelative,
            type: typedReference.type,
            sourceField: typedReference.sourceField,
            traversed: false,
            reason: "informational-inline-code-missing",
            resolutionTrace: trace
          });
          continue;
        }
        addUnresolved(targetRelative);
        reasonCodes.add("INSTRUCTION_REFERENCE_MISSING");
        edges.push({
          from: rel,
          to: targetRelative,
          type: typedReference.type,
          sourceField: typedReference.sourceField,
          traversed: false,
          reason: "missing",
          resolutionTrace: trace
        });
        continue;
      }
      edges.push({
        from: rel,
        to: targetRelative,
        type: typedReference.type,
        sourceField: typedReference.sourceField,
        traversed: true,
        reason: null,
        resolutionTrace: trace
      });
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
    unresolvedReferences: [...unresolvedSamples].sort(),
    cycles,
    maxDepth,
    totalBytes,
    ownership,
    edges,
    diagnostics: {
      edgeCount: edges.length,
      edgeTypeCounts: {
        include: edges.filter((edge) => edge.type === "include").length,
        catalog: edges.filter((edge) => edge.type === "catalog").length,
        ownership: edges.filter((edge) => edge.type === "ownership").length
      },
      unresolvedCount,
      unresolvedOmitted: Math.max(0, unresolvedCount - unresolvedSamples.size),
      maxFiles: MAX_FILES,
      maxDepth: MAX_DEPTH,
      maxBytes: MAX_BYTES,
      budgetExceededAt
    }
  };
}
