import {
  knowledgeIngestEntrySchema,
  type SemanticDocument,
  type SemanticEdge,
  type SemanticEdgeKind,
  type SemanticIndexBuild
} from "@hunter-harness/contracts";
import { parseKnowledgeMarkdown, sha256Bytes } from "@hunter-harness/core";

export interface BuildSemanticIndexInput {
  projectId: string;
  artifactId: string;
  files: Readonly<Record<string, string>>;
}

function documentId(projectId: string, sourcePath: string): string {
  return `sem_${sha256Bytes(projectId + "\0" + sourcePath).slice("sha256:".length, "sha256:".length + 16)}`;
}

function edgeId(from: string, to: string, kind: string): string {
  return `sed_${sha256Bytes(from + "\0" + to + "\0" + kind).slice("sha256:".length, "sha256:".length + 16)}`;
}

function isKnowledgeIngestEntryPath(path: string): boolean {
  return /^\.harness\/knowledge\/entries\/[^/]+\/[^/]+\.json$/u.test(path);
}

function isKnowledgeMarkdownPath(path: string): boolean {
  return path.startsWith(".harness/knowledge/") &&
    path.endsWith(".md") &&
    !path.startsWith(".harness/knowledge/project-local/") &&
    !path.startsWith(".harness/knowledge/views/") &&
    !path.includes("/entries/");
}

function isRulePath(path: string): boolean {
  return path.startsWith(".harness/rules/") ||
    path.startsWith(".claude/rules/") ||
    path.startsWith(".cursor/rules/") ||
    path.startsWith(".agents/rules/") ||
    path.startsWith(".codebuddy/.rules/") ||
    path.startsWith(".codebuddy/rules/");
}

function isArchiveSummaryPath(path: string): boolean {
  return /^\.harness\/archive\/[^/]+\/reports\/final\/summary-data\.json$/u.test(path);
}

function isAgentInstructionPath(path: string): boolean {
  return path === "CLAUDE.md" || path === "AGENTS.md" || path === "CODEBUDDY.md";
}

export function isSemanticSourcePath(path: string): boolean {
  return isKnowledgeIngestEntryPath(path) ||
    isKnowledgeMarkdownPath(path) ||
    isRulePath(path) ||
    isArchiveSummaryPath(path) ||
    isAgentInstructionPath(path);
}

/** Documents whose bodies may contain markdown/wiki links worth resolving. */
const LINK_SOURCE_KINDS = new Set<SemanticDocument["kind"]>([
  "knowledge_markdown",
  "rule",
  "agent_instruction"
]);

function dirnameOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function basenameOf(path: string): string {
  const withoutFragment = path.split("#")[0] ?? path;
  const parts = withoutFragment.split("/");
  return parts[parts.length - 1] ?? withoutFragment;
}

function normalizeJoinedPath(base: string, relative: string): string {
  const baseSegments = base === "" ? [] : base.split("/");
  const segments = [...baseSegments];
  for (const part of relative.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return segments.join("/");
}

function isExternalLink(link: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/iu.test(link) || link.startsWith("//");
}

function extractLinkTargets(body: string): string[] {
  const links: string[] = [];
  const markdownLinkPattern = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu;
  for (const match of body.matchAll(markdownLinkPattern)) {
    const target = match[1];
    if (target !== undefined) links.push(target);
  }
  const wikiLinkPattern = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/gu;
  for (const match of body.matchAll(wikiLinkPattern)) {
    const target = match[1];
    if (target !== undefined) links.push(target.trim());
  }
  return links;
}

function resolveLinkTarget(
  fromSourcePath: string,
  rawLink: string,
  bySourcePath: ReadonlyMap<string, SemanticDocument>,
  allDocumentsByBasename: ReadonlyMap<string, SemanticDocument[]>
): SemanticDocument | undefined {
  const link = rawLink.trim();
  if (link === "" || isExternalLink(link)) return undefined;
  const withoutFragment = (link.split("#")[0] ?? link).trim();
  if (withoutFragment === "") return undefined;

  const candidates = withoutFragment.startsWith("/")
    ? [withoutFragment.slice(1)]
    : [withoutFragment, normalizeJoinedPath(dirnameOf(fromSourcePath), withoutFragment)];

  for (const candidate of candidates) {
    const exact = bySourcePath.get(candidate);
    if (exact !== undefined) return exact;
  }

  const byBasename = allDocumentsByBasename.get(basenameOf(withoutFragment));
  if (byBasename !== undefined && byBasename.length > 0) {
    return [...byBasename].sort((left, right) => left.source_path.localeCompare(right.source_path))[0];
  }
  return undefined;
}

function splitTagLike(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item !== "");
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item !== "");
  }
  return [];
}

const TAG_METADATA_KEYS = ["domains", "modules", "keywords", "tags"] as const;

function extractTagSet(metadata: Readonly<Record<string, unknown>>): Set<string> {
  const tags = new Set<string>();
  for (const key of TAG_METADATA_KEYS) {
    for (const tag of splitTagLike(metadata[key])) {
      tags.add(tag);
    }
  }
  return tags;
}

function collectPathCandidates(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function collectArchiveRelatedPaths(document: SemanticDocument): string[] {
  const fromMetadata = [
    ...collectPathCandidates(document.metadata.sourceFiles),
    ...collectPathCandidates(document.metadata.relatedFiles),
    ...collectPathCandidates(document.metadata.files)
  ];
  let parsedBody: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(document.body) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      parsedBody = parsed as Record<string, unknown>;
    }
  } catch {
    parsedBody = undefined;
  }
  const fromBody = parsedBody === undefined
    ? []
    : [
      ...collectPathCandidates(parsedBody.sourceFiles),
      ...collectPathCandidates(parsedBody.relatedFiles),
      ...collectPathCandidates(parsedBody.files)
    ];
  return [...new Set([...fromMetadata, ...fromBody])];
}

function orderedPair(left: SemanticDocument, right: SemanticDocument): [SemanticDocument, SemanticDocument] {
  return left.document_id.localeCompare(right.document_id) <= 0 ? [left, right] : [right, left];
}

class EdgeCollector {
  private readonly seen = new Set<string>();
  readonly edges: SemanticEdge[] = [];

  add(
    projectId: string,
    artifactId: string,
    from: SemanticDocument,
    to: SemanticDocument,
    kind: SemanticEdgeKind,
    metadata: Record<string, unknown>
  ): void {
    if (from.document_id === to.document_id) return;
    const id = edgeId(from.document_id, to.document_id, kind);
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.edges.push({
      edge_id: id,
      project_id: projectId,
      artifact_id: artifactId,
      from_document_id: from.document_id,
      to_document_id: to.document_id,
      kind,
      metadata
    });
  }
}

export function buildSemanticIndex(input: BuildSemanticIndexInput): SemanticIndexBuild {
  const documents: SemanticDocument[] = [];
  const bySourcePath = new Map<string, SemanticDocument>();
  const knowledgeEntrySourceFiles = new Map<string, readonly string[]>();
  const knowledgeEntries: Array<{
    document: SemanticDocument;
    entryId: string;
    supersedes: readonly string[];
    conflictsWith: readonly string[];
    sourceFiles: readonly string[];
  }> = [];

  for (const [sourcePath, content] of Object.entries(input.files).sort(([a], [b]) => a.localeCompare(b))) {
    if (isKnowledgeIngestEntryPath(sourcePath)) {
      try {
        const entry = knowledgeIngestEntrySchema.parse(JSON.parse(content));
        const doc: SemanticDocument = {
          document_id: documentId(input.projectId, sourcePath),
          project_id: input.projectId,
          artifact_id: input.artifactId,
          kind: "knowledge_entry",
          source_path: sourcePath,
          title: entry.title,
          body: entry.body,
          metadata: {
            entry_id: entry.id,
            entry_type: entry.type,
            status: entry.status,
            keywords: entry.keywords,
            source_archive: entry.source.archive,
            source_files: entry.scope.sourceFiles,
            supersedes: entry.lifecycle.supersedes,
            superseded_by: entry.lifecycle.supersededBy,
            conflicts_with: entry.lifecycle.conflictsWith
          },
          content_sha256: sha256Bytes(content)
        };
        documents.push(doc);
        bySourcePath.set(sourcePath, doc);
        knowledgeEntrySourceFiles.set(doc.document_id, entry.scope.sourceFiles);
        knowledgeEntries.push({
          document: doc,
          entryId: entry.id,
          supersedes: entry.lifecycle.supersedes,
          conflictsWith: entry.lifecycle.conflictsWith,
          sourceFiles: entry.scope.sourceFiles
        });
      } catch {
        // Invalid ingest JSON must not block push; skip until next rebuild.
      }
      continue;
    }

    if (isKnowledgeMarkdownPath(sourcePath)) {
      try {
        const parsed = parseKnowledgeMarkdown(content, sourcePath.replace(/^\.harness\/knowledge\//u, ""));
        const doc: SemanticDocument = {
          document_id: documentId(input.projectId, sourcePath),
          project_id: input.projectId,
          artifact_id: input.artifactId,
          kind: "knowledge_markdown",
          source_path: sourcePath,
          title: parsed.frontmatter.id,
          body: parsed.summary,
          metadata: {
            knowledge_id: parsed.frontmatter.id,
            knowledge_type: parsed.frontmatter.type,
            status: parsed.frontmatter.status,
            domains: parsed.frontmatter.domains,
            modules: parsed.frontmatter.modules
          },
          content_sha256: sha256Bytes(content)
        };
        documents.push(doc);
        bySourcePath.set(sourcePath, doc);
      } catch {
        documents.push({
          document_id: documentId(input.projectId, sourcePath),
          project_id: input.projectId,
          artifact_id: input.artifactId,
          kind: "knowledge_markdown",
          source_path: sourcePath,
          title: sourcePath.split("/").pop() ?? sourcePath,
          body: content,
          metadata: { parse_status: "best_effort" },
          content_sha256: sha256Bytes(content)
        });
      }
      continue;
    }

    if (isRulePath(sourcePath)) {
      const doc: SemanticDocument = {
        document_id: documentId(input.projectId, sourcePath),
        project_id: input.projectId,
        artifact_id: input.artifactId,
        kind: "rule",
        source_path: sourcePath,
        title: sourcePath.split("/").pop() ?? sourcePath,
        body: content,
        metadata: {},
        content_sha256: sha256Bytes(content)
      };
      documents.push(doc);
      bySourcePath.set(sourcePath, doc);
      continue;
    }

    if (isArchiveSummaryPath(sourcePath)) {
      try {
        const summary = JSON.parse(content) as Record<string, unknown>;
        const title = String(summary.changeName ?? sourcePath.split("/")[2] ?? "archive");
        const doc: SemanticDocument = {
          document_id: documentId(input.projectId, sourcePath),
          project_id: input.projectId,
          artifact_id: input.artifactId,
          kind: "archive_record",
          source_path: sourcePath,
          title,
          body: JSON.stringify(summary, null, 2),
          metadata: {
            final_status: summary.finalStatus ?? null,
            final_commit: summary.finalCommit ?? summary.final_commit ?? null
          },
          content_sha256: sha256Bytes(content)
        };
        documents.push(doc);
        bySourcePath.set(sourcePath, doc);
      } catch {
        // Malformed archive summary is skipped for the derivative index.
      }
      continue;
    }

    if (isAgentInstructionPath(sourcePath)) {
      const doc: SemanticDocument = {
        document_id: documentId(input.projectId, sourcePath),
        project_id: input.projectId,
        artifact_id: input.artifactId,
        kind: "agent_instruction",
        source_path: sourcePath,
        title: sourcePath,
        body: content,
        metadata: {},
        content_sha256: sha256Bytes(content)
      };
      documents.push(doc);
      bySourcePath.set(sourcePath, doc);
    }
  }

  const byBasename = new Map<string, SemanticDocument[]>();
  const addBasename = (key: string, doc: SemanticDocument): void => {
    const list = byBasename.get(key) ?? [];
    list.push(doc);
    byBasename.set(key, list);
  };
  for (const doc of documents) {
    const basename = basenameOf(doc.source_path);
    addBasename(basename, doc);
    const dotIndex = basename.lastIndexOf(".");
    if (dotIndex > 0) {
      addBasename(basename.slice(0, dotIndex), doc);
    }
  }

  const collector = new EdgeCollector();

  const knowledgeByEntryId = new Map(
    knowledgeEntries.map((entry) => [entry.entryId, entry.document])
  );
  for (const entry of knowledgeEntries) {
    for (const supersededId of entry.supersedes) {
      const target = knowledgeByEntryId.get(supersededId);
      if (target !== undefined) {
        collector.add(
          input.projectId,
          input.artifactId,
          entry.document,
          target,
          "supersedes",
          { entry_id: supersededId }
        );
      }
    }
    for (const conflictId of entry.conflictsWith) {
      const target = knowledgeByEntryId.get(conflictId);
      if (target !== undefined) {
        const [from, to] = orderedPair(entry.document, target);
        collector.add(
          input.projectId,
          input.artifactId,
          from,
          to,
          "conflicts_with",
          { entry_ids: [entry.entryId, conflictId].sort() }
        );
      }
    }
  }

  for (let index = 0; index < knowledgeEntries.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < knowledgeEntries.length; otherIndex += 1) {
      const left = knowledgeEntries[index];
      const right = knowledgeEntries[otherIndex];
      if (left === undefined || right === undefined) continue;
      const rightPaths = new Set(right.sourceFiles);
      const sharedPaths = [...new Set(left.sourceFiles)]
        .filter((path) => rightPaths.has(path))
        .sort();
      if (sharedPaths.length === 0) continue;
      const [from, to] = orderedPair(left.document, right.document);
      collector.add(
        input.projectId,
        input.artifactId,
        from,
        to,
        "shared_scope",
        { shared_paths: sharedPaths }
      );
    }
  }

  for (const [documentIdValue, sourceFiles] of knowledgeEntrySourceFiles.entries()) {
    const from = documents.find((doc) => doc.document_id === documentIdValue);
    if (from === undefined) continue;
    for (const relatedPath of sourceFiles) {
      const target = bySourcePath.get(relatedPath);
      if (target !== undefined) {
        collector.add(input.projectId, input.artifactId, from, target, "references_path", { path: relatedPath });
      }
    }
  }

  for (const doc of documents) {
    if (!LINK_SOURCE_KINDS.has(doc.kind)) continue;
    for (const rawLink of extractLinkTargets(doc.body)) {
      const target = resolveLinkTarget(doc.source_path, rawLink, bySourcePath, byBasename);
      if (target !== undefined) {
        collector.add(input.projectId, input.artifactId, doc, target, "references_path", { path: rawLink });
      }
    }
  }

  const knowledgeMarkdownDocs = documents.filter((doc) => doc.kind === "knowledge_markdown");
  for (let i = 0; i < knowledgeMarkdownDocs.length; i += 1) {
    for (let j = i + 1; j < knowledgeMarkdownDocs.length; j += 1) {
      const left = knowledgeMarkdownDocs[i];
      const right = knowledgeMarkdownDocs[j];
      if (left === undefined || right === undefined) continue;
      const leftTags = extractTagSet(left.metadata);
      const rightTags = extractTagSet(right.metadata);
      const shared = [...leftTags].filter((tag) => rightTags.has(tag)).sort();
      if (shared.length === 0) continue;
      const [from, to] = orderedPair(left, right);
      collector.add(input.projectId, input.artifactId, from, to, "tag_cooccurrence", { shared_tags: shared });
    }
  }

  for (const doc of documents) {
    if (doc.kind !== "archive_record") continue;
    for (const relatedPath of collectArchiveRelatedPaths(doc)) {
      const target = bySourcePath.get(relatedPath) ??
        [...(byBasename.get(basenameOf(relatedPath)) ?? [])]
          .sort((left, right) => left.source_path.localeCompare(right.source_path))[0];
      if (target !== undefined) {
        collector.add(input.projectId, input.artifactId, doc, target, "related_archive", { path: relatedPath });
      }
    }
  }

  return {
    project_id: input.projectId,
    artifact_id: input.artifactId,
    documents,
    edges: collector.edges
  };
}
