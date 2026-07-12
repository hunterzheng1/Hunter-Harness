import { z } from "zod";

export const semanticDocumentKindSchema = z.enum([
  "knowledge_entry",
  "knowledge_markdown",
  "rule",
  "archive_change",
  "agent_instruction"
]);

export const semanticEdgeKindSchema = z.enum([
  "references_path",
  "supersedes",
  "related_archive"
]);

export const semanticDocumentSchema = z.object({
  document_id: z.string(),
  project_id: z.string(),
  artifact_id: z.string(),
  kind: semanticDocumentKindSchema,
  source_path: z.string(),
  title: z.string(),
  body: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  content_sha256: z.string()
}).strict();

export const semanticEdgeSchema = z.object({
  edge_id: z.string(),
  project_id: z.string(),
  artifact_id: z.string(),
  from_document_id: z.string(),
  to_document_id: z.string(),
  kind: semanticEdgeKindSchema,
  metadata: z.record(z.string(), z.unknown())
}).strict();

export const semanticIndexBuildSchema = z.object({
  project_id: z.string(),
  artifact_id: z.string(),
  documents: z.array(semanticDocumentSchema),
  edges: z.array(semanticEdgeSchema)
}).strict();

export type SemanticDocumentKind = z.infer<typeof semanticDocumentKindSchema>;
export type SemanticDocument = z.infer<typeof semanticDocumentSchema>;
export type SemanticEdge = z.infer<typeof semanticEdgeSchema>;
export type SemanticIndexBuild = z.infer<typeof semanticIndexBuildSchema>;
