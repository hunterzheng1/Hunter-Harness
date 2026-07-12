import { z } from "zod";

export const semanticDocumentKindSchema = z.enum([
  "knowledge_entry",
  "knowledge_markdown",
  "rule",
  "archive_record",
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

export const semanticOverviewSchema = z.object({
  project_id: z.string(),
  artifact_id: z.string().nullable(),
  counts: z.object({
    documents: z.number().int().nonnegative(),
    knowledge: z.number().int().nonnegative(),
    rules: z.number().int().nonnegative(),
    changes: z.number().int().nonnegative(),
    agent_instructions: z.number().int().nonnegative(),
    edges: z.number().int().nonnegative()
  }).strict()
}).strict();

export const semanticSearchHitSchema = z.object({
  document: semanticDocumentSchema,
  project_id: z.string()
}).strict();

export type SemanticOverview = z.infer<typeof semanticOverviewSchema>;
export type SemanticSearchHit = z.infer<typeof semanticSearchHitSchema>;
