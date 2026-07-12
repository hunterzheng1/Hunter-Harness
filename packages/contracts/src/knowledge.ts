import { z } from "zod";

/** Markdown knowledge layer (.harness/knowledge/*.md) */
export const knowledgeStatusSchema = z.enum([
  "candidate",
  "active",
  "stale",
  "deprecated",
  "superseded"
]);

export const knowledgeFrontmatterSchema = z.object({
  id: z.string().regex(/^knowledge\.[a-z0-9.-]+$/),
  type: z.enum([
    "business",
    "architecture",
    "decision",
    "pitfall",
    "api",
    "glossary",
    "project-local"
  ]),
  scope: z.enum([
    "global",
    "project",
    "module",
    "feature",
    "api",
    "business-domain",
    "local"
  ]),
  confidence: z.enum(["verified", "inferred", "unverified", "low"]),
  status: knowledgeStatusSchema,
  domains: z.array(z.string()),
  modules: z.array(z.string()),
  related_paths: z.array(z.string()),
  source: z.object({
    kind: z.enum(["manual", "archive", "review", "imported", "test", "design"]),
    ref: z.string().min(1)
  }).strict(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  last_verified_at: z.iso.datetime().nullable(),
  expires_at: z.iso.datetime().nullable(),
  supersedes: z.array(z.string()),
  superseded_by: z.array(z.string())
}).strict();

export type KnowledgeFrontmatter = z.infer<typeof knowledgeFrontmatterSchema>;

export const knowledgeMarkdownIndexSchema = z.object({
  schema_version: z.literal(1),
  generated_at: z.iso.datetime(),
  entries: z.array(z.object({
    id: z.string(),
    type: z.string(),
    scope: z.string(),
    confidence: z.string(),
    status: knowledgeStatusSchema,
    domains: z.array(z.string()),
    modules: z.array(z.string()),
    related_paths: z.array(z.string()),
    source: knowledgeFrontmatterSchema.shape.source,
    created_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
    last_verified_at: z.iso.datetime().nullable(),
    expires_at: z.iso.datetime().nullable(),
    supersedes: z.array(z.string()),
    superseded_by: z.array(z.string()),
    path: z.string(),
    content_sha256: z.string(),
    summary: z.string(),
    local: z.boolean()
  }).strict())
}).strict();

export type KnowledgeMarkdownIndex = z.infer<typeof knowledgeMarkdownIndexSchema>;

/** Archive-ingest JSON knowledge layer (.harness/knowledge/entries/*.json) */
const knowledgeIngestTimestampSchema = z.string().min(1);

export const knowledgeIngestEntryTypeSchema = z.enum([
  "requirement",
  "decision",
  "implementation",
  "risk",
  "test-evidence",
  "pitfall",
  "api-contract"
]);

export const knowledgeIngestEntryStatusSchema = z.enum([
  "candidate",
  "active",
  "stale",
  "superseded",
  "deprecated",
  "conflicted"
]);

export const knowledgeConfidenceScoreSchema = z.object({
  score: z.number(),
  level: z.string(),
  signals: z.array(z.string()),
  lastCalculatedAt: knowledgeIngestTimestampSchema
}).strict();

export const knowledgeIngestEntryLifecycleSchema = z.object({
  createdAt: knowledgeIngestTimestampSchema,
  verifiedAt: knowledgeIngestTimestampSchema,
  lastCheckedAt: knowledgeIngestTimestampSchema,
  confidence: z.string(),
  supersedes: z.array(z.string()),
  supersededBy: z.string().nullable(),
  conflictsWith: z.array(z.string()),
  staleReasons: z.array(z.string()),
  promotedAt: knowledgeIngestTimestampSchema.optional(),
  promotionNote: z.string().optional(),
  demotedAt: knowledgeIngestTimestampSchema.optional(),
  validation: z.object({
    validatedAt: knowledgeIngestTimestampSchema,
    status: z.enum(["passed", "failed", "skipped"]),
    results: z.array(z.record(z.string(), z.unknown()))
  }).strict().optional()
}).strict();

export const knowledgeIngestEntrySourceSchema = z.object({
  archive: z.string(),
  summaryData: z.string(),
  summarySha256: z.string(),
  sourceCommit: z.string(),
  baseCommit: z.string(),
  changeName: z.string(),
  finalStatus: z.string()
}).strict();

export const knowledgeIngestEntrySchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  projectId: z.string().min(1),
  type: knowledgeIngestEntryTypeSchema,
  status: knowledgeIngestEntryStatusSchema,
  title: z.string(),
  summary: z.string(),
  body: z.string(),
  keywords: z.array(z.string()),
  source: knowledgeIngestEntrySourceSchema,
  scope: z.object({
    sourceFiles: z.array(z.string()),
    staleIfPathsChanged: z.array(z.string()).optional()
  }).strict(),
  lifecycle: knowledgeIngestEntryLifecycleSchema,
  confidence: knowledgeConfidenceScoreSchema.optional(),
  validators: z.array(z.record(z.string(), z.unknown())).optional(),
  reviewReasons: z.array(z.string()).optional()
}).strict();

export type KnowledgeIngestEntry = z.infer<typeof knowledgeIngestEntrySchema>;

export const knowledgeIngestIndexEntryRefSchema = z.object({
  id: z.string(),
  type: knowledgeIngestEntryTypeSchema,
  status: knowledgeIngestEntryStatusSchema,
  title: z.string(),
  sourceArchive: z.string(),
  sourceCommit: z.string(),
  sourceFiles: z.array(z.string()),
  confidence: z.union([knowledgeConfidenceScoreSchema, z.object({}).strict()])
}).strict();

export const knowledgeIngestIndexSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: knowledgeIngestTimestampSchema,
  projectId: z.string(),
  projectRoot: z.string(),
  headCommit: z.string().nullable().optional(),
  archives: z.object({
    scanned: z.number().int().nonnegative(),
    indexed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    items: z.array(z.object({
      archive: z.string(),
      summaryData: z.string(),
      summarySha256: z.string(),
      mtime: knowledgeIngestTimestampSchema
    }).strict())
  }).strict(),
  stats: z.record(z.string(), z.number().int().nonnegative()),
  byType: z.record(z.string(), z.number().int().nonnegative()),
  duplicatesSkipped: z.number().int().nonnegative(),
  ingestMode: z.record(z.string(), z.unknown()),
  failures: z.array(z.record(z.string(), z.string())),
  entries: z.array(knowledgeIngestIndexEntryRefSchema)
}).strict();

export type KnowledgeIngestIndex = z.infer<typeof knowledgeIngestIndexSchema>;
