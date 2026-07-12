import {
  knowledgeIngestEntrySchema,
  type SemanticDocument,
  type SemanticEdge,
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
  return path.startsWith(".claude/rules/") ||
    path.startsWith(".cursor/rules/") ||
    path.startsWith(".agents/rules/");
}

function isArchiveSummaryPath(path: string): boolean {
  return /^\.harness\/archive\/[^/]+\/reports\/final\/summary-data\.json$/u.test(path);
}

function isAgentInstructionPath(path: string): boolean {
  return path === "CLAUDE.md" || path === "AGENTS.md" || path === "CODEBUDDY.md";
}

export function buildSemanticIndex(input: BuildSemanticIndexInput): SemanticIndexBuild {
  const documents: SemanticDocument[] = [];
  const edges: SemanticEdge[] = [];
  const bySourcePath = new Map<string, SemanticDocument>();

  for (const [sourcePath, content] of Object.entries(input.files).sort(([a], [b]) => a.localeCompare(b))) {
    if (isKnowledgeIngestEntryPath(sourcePath)) {
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
          source_archive: entry.source.archive
        },
        content_sha256: sha256Bytes(content)
      };
      documents.push(doc);
      bySourcePath.set(sourcePath, doc);
      for (const relatedPath of entry.scope.sourceFiles) {
        const target = [...bySourcePath.values()].find((item) => item.source_path === relatedPath);
        if (target !== undefined) {
          edges.push({
            edge_id: edgeId(doc.document_id, target.document_id, "references_path"),
            project_id: input.projectId,
            artifact_id: input.artifactId,
            from_document_id: doc.document_id,
            to_document_id: target.document_id,
            kind: "references_path",
            metadata: { path: relatedPath }
          });
        }
      }
      continue;
    }

    if (isKnowledgeMarkdownPath(sourcePath)) {
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
          status: parsed.frontmatter.status
        },
        content_sha256: sha256Bytes(content)
      };
      documents.push(doc);
      bySourcePath.set(sourcePath, doc);
      continue;
    }

    if (isRulePath(sourcePath)) {
      documents.push({
        document_id: documentId(input.projectId, sourcePath),
        project_id: input.projectId,
        artifact_id: input.artifactId,
        kind: "rule",
        source_path: sourcePath,
        title: sourcePath.split("/").pop() ?? sourcePath,
        body: content,
        metadata: {},
        content_sha256: sha256Bytes(content)
      });
      continue;
    }

    if (isArchiveSummaryPath(sourcePath)) {
      const summary = JSON.parse(content) as Record<string, unknown>;
      const title = String(summary.changeName ?? sourcePath.split("/")[2] ?? "archive");
      const doc: SemanticDocument = {
        document_id: documentId(input.projectId, sourcePath),
        project_id: input.projectId,
        artifact_id: input.artifactId,
        kind: "archive_change",
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
      continue;
    }

    if (isAgentInstructionPath(sourcePath)) {
      documents.push({
        document_id: documentId(input.projectId, sourcePath),
        project_id: input.projectId,
        artifact_id: input.artifactId,
        kind: "agent_instruction",
        source_path: sourcePath,
        title: sourcePath,
        body: content,
        metadata: {},
        content_sha256: sha256Bytes(content)
      });
    }
  }

  return {
    project_id: input.projectId,
    artifact_id: input.artifactId,
    documents,
    edges
  };
}
