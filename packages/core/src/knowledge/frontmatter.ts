import { knowledgeFrontmatterSchema, type KnowledgeFrontmatter } from "@hunter-harness/contracts";
import { parse as parseYaml } from "yaml";

import { sha256Bytes } from "../fs/hash.js";
import { normalizeManagedPath } from "../fs/path-safety.js";

export interface ParsedKnowledge {
  path: string;
  frontmatter: KnowledgeFrontmatter;
  body: string;
  summary: string;
  contentHash: string;
}

function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, "\n").trim().replace(/[ \t]+$/gm, "") + "\n";
}

export function parseKnowledgeMarkdown(content: string, path: string): ParsedKnowledge {
  const normalizedPath = normalizeManagedPath(path);
  if (!normalizedPath.endsWith(".md")) {
    throw new Error("knowledge entry must be a Markdown file");
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(content);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error("knowledge entry requires YAML frontmatter");
  }
  const frontmatter = knowledgeFrontmatterSchema.parse(parseYaml(match[1]));
  const body = normalizeBody(match[2]);
  const summary = body.split(/\n\s*\n/, 1)[0]?.trim() ?? "";
  if (summary === "") {
    throw new Error("knowledge entry requires a summary paragraph");
  }
  return {
    path: normalizedPath,
    frontmatter,
    body,
    summary,
    contentHash: sha256Bytes(body)
  };
}
