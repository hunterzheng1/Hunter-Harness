import { z } from "zod";

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
