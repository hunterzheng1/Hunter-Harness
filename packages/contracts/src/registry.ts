import { z } from "zod";

import { sha256Schema } from "./protocol.js";
import { skillIrSchema } from "./skill-ir.js";

export const registryAgentSchema = z.enum(["claude-code", "codex", "generic", "mcp"]);
export const registrySkillStatusSchema = z.enum([
  "draft",
  "pending_review",
  "published",
  "rejected",
  "deprecated"
]);
export const registrySkillProposalStatusSchema = z.enum([
  "pending_review",
  "approved",
  "rejected"
]);
export const registrySemverSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
export const registrySlugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const checkStatusSchema = z.enum(["green", "yellow", "red"]);

export const sourceFileSchema = z.object({
  path: z.string(),
  content: z.string()
}).strict();

export const skillUsageExampleSchema = z.object({
  title: z.string(),
  description: z.string(),
  request: z.string(),
  result: z.string(),
  files: z.array(z.string()).default([])
}).strict();

export const agentSkillConfigSchema = z.object({
  agent: registryAgentSchema,
  enabled: z.boolean(),
  isDefault: z.boolean(),
  installTarget: z.string(),
  latestVersion: registrySemverSchema.nullable(),
  draftVersion: registrySemverSchema.nullable(),
  sourcePackagePath: z.string().nullable()
}).strict();

export const skillCheckItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: checkStatusSchema,
  message: z.string(),
  filePath: z.string().nullable(),
  fixable: z.boolean()
}).strict();

export const skillCheckResultSchema = z.object({
  items: z.array(skillCheckItemSchema),
  summary: z.object({
    green: z.number().int(),
    yellow: z.number().int(),
    red: z.number().int()
  }).strict(),
  checkedAt: z.string()
}).strict();

export const draftStateSchema = z.object({
  slug: z.string(),
  sourceFiles: z.array(sourceFileSchema),
  ir: skillIrSchema,
  examples: z.array(skillUsageExampleSchema).default([]),
  draftVersion: registrySemverSchema.nullable(),
  checks: skillCheckResultSchema.nullable(),
  releaseNote: z.string().nullable(),
  revision: z.number().int(),
  created_at: z.string(),
  updated_at: z.string()
}).strict();

export const publishSkillRequestSchema = z.object({
  version: registrySemverSchema,
  releaseNote: z.string().optional()
}).strict();

export const skillDiffFileSchema = z.object({
  path: z.string(),
  status: z.enum(["modified", "added", "removed"]),
  publishedContent: z.string().nullable(),
  draftContent: z.string().nullable()
}).strict();

export const registryValidationSchema = z.object({
  schema_valid: z.boolean(),
  sensitive_findings: z.number().int().nonnegative(),
  claude_compilable: z.boolean()
}).strict();

export const registryArtifactSchema = z.object({
  artifact_id: z.string().regex(/^ska_/),
  skill_slug: registrySlugSchema,
  version: registrySemverSchema,
  agent: registryAgentSchema,
  content_sha256: sha256Schema,
  size_bytes: z.number().int().nonnegative(),
  source_proposal_id: z.string().regex(/^skp_/).nullable(),
  created_at: z.iso.datetime()
}).strict();

export const registrySkillVersionSchema = z.object({
  skill_slug: registrySlugSchema,
  version: registrySemverSchema,
  ir: skillIrSchema,
  artifacts: z.array(registryArtifactSchema),
  source_proposal_id: z.string().regex(/^skp_/).nullable(),
  sourceFiles: z.array(sourceFileSchema).default([]),
  examples: z.array(skillUsageExampleSchema).default([]),
  changeNote: z.string().nullable(),
  created_at: z.iso.datetime()
}).strict();

export const registrySkillSummarySchema = z.object({
  skill_id: z.string().regex(/^skl_/),
  slug: registrySlugSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(registrySlugSchema),
  status: registrySkillStatusSchema,
  latest_version: registrySemverSchema.nullable(),
  defaultAgent: registryAgentSchema.nullable(),
  agents: z.array(agentSkillConfigSchema),
  revision: z.number().int().positive(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime()
}).strict();

export const registrySkillDetailSchema = registrySkillSummarySchema.extend({
  ir: skillIrSchema,
  sourceFiles: z.array(sourceFileSchema).default([]),
  examples: z.array(skillUsageExampleSchema).default([])
}).strict();

export const registrySkillProposalSchema = z.object({
  proposal_id: z.string().regex(/^skp_/),
  skill_slug: registrySlugSchema,
  proposed_ir: skillIrSchema,
  status: registrySkillProposalStatusSchema,
  created_by: z.string().min(1),
  validation: registryValidationSchema,
  created_at: z.iso.datetime(),
  reviewed_at: z.iso.datetime().nullable()
}).strict();

export const registryTagSchema = z.object({
  tag_id: z.string().regex(/^tag_/),
  slug: registrySlugSchema,
  label: z.string().min(1).max(80),
  active: z.boolean(),
  revision: z.number().int().positive(),
  usageCount: z.number().int().nonnegative(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime()
}).strict();

export const registryWorkflowSchema = z.object({
  workflow_id: z.string().regex(/^wf_/),
  key: registrySlugSchema,
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(1000),
  profile: registrySlugSchema,
  default_agent: registryAgentSchema,
  enabled: z.boolean(),
  skill_slugs: z.array(registrySlugSchema),
  revision: z.number().int().positive(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime()
}).strict();

export const registryWorkflowMutationSchema = z.object({
  key: registrySlugSchema,
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(1000),
  profile: registrySlugSchema,
  default_agent: registryAgentSchema,
  enabled: z.boolean(),
  skill_slugs: z.array(registrySlugSchema)
}).strict();

export const registryProjectWorkflowBindingSchema = z.object({
  project_id: z.string().regex(/^prj_/),
  workflow_id: z.string().regex(/^wf_/),
  revision: z.number().int().positive(),
  updated_at: z.iso.datetime()
}).strict();

export type RegistryAgent = z.infer<typeof registryAgentSchema>;
export type RegistryArtifact = z.infer<typeof registryArtifactSchema>;
export type RegistrySkillVersion = z.infer<typeof registrySkillVersionSchema>;
export type RegistrySkillSummary = z.infer<typeof registrySkillSummarySchema>;
export type RegistrySkillDetail = z.infer<typeof registrySkillDetailSchema>;
export type RegistrySkillProposal = z.infer<typeof registrySkillProposalSchema>;
export type RegistryTag = z.infer<typeof registryTagSchema>;
export type RegistryWorkflow = z.infer<typeof registryWorkflowSchema>;
export type RegistryWorkflowMutation = z.infer<typeof registryWorkflowMutationSchema>;
export type RegistryProjectWorkflowBinding = z.infer<typeof registryProjectWorkflowBindingSchema>;
export type CheckStatus = z.infer<typeof checkStatusSchema>;
export type SourceFile = z.infer<typeof sourceFileSchema>;
export type SkillUsageExample = z.infer<typeof skillUsageExampleSchema>;
export type AgentSkillConfig = z.infer<typeof agentSkillConfigSchema>;
export type SkillCheckItem = z.infer<typeof skillCheckItemSchema>;
export type SkillCheckResult = z.infer<typeof skillCheckResultSchema>;
export type DraftState = z.infer<typeof draftStateSchema>;
export type PublishSkillRequest = z.infer<typeof publishSkillRequestSchema>;
export type SkillDiffFile = z.infer<typeof skillDiffFileSchema>;
