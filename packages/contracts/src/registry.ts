import { z } from "zod";

import { sha256Schema } from "./protocol.js";

export const registryAgentSchema = z.enum(["claude-code", "codex", "cursor", "generic", "mcp"]);
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

// SKILL.md frontmatter — 松校验，取代 canonical Skill IrSchema。
// .passthrough() 保留未声明的额外字段（author/tags/license 等），避免合法 SKILL.md 因额外字段被拒（评审 RED#1）。
export const skillFrontmatterSchema = z.object({
  name: z.string().regex(/^harness-[a-z0-9-]+$/),
  description: z.string().min(1),
  kind: z.enum(["workflow", "tooling", "migration", "governance"]).optional(),
  triggers: z.array(z.string()).optional(),
  inputs: z.array(z.string()).optional(),
  outputs: z.array(z.string()).optional(),
  forbidden_actions: z.array(z.string()).optional(),
  required_context: z.array(z.string()).optional(),
  version: z.string().optional()
}).passthrough();
export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;

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
  // per-agent 独立版本已启用：每个 agent 持独立 latestVersion/draftVersion/draft 文件包；
  // publish 只前进当前 agent 的 latestVersion，不影响其他 agent（见 server store.agentsFor/publish）。
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
}).strip();

export const skillCheckResultSchema = z.object({
  items: z.array(skillCheckItemSchema),
  summary: z.object({
    green: z.number().int(),
    yellow: z.number().int(),
    red: z.number().int()
  }).strip(),
  checkedAt: z.string()
}).strip();

export const draftStateSchema = z.object({
  slug: z.string(),
  agent: registryAgentSchema,
  sourceFiles: z.array(sourceFileSchema),
  ir: z.unknown().optional(),
  examples: z.array(skillUsageExampleSchema).default([]),
  draftVersion: registrySemverSchema.nullable(),
  checks: skillCheckResultSchema.nullable(),
  aiChecks: skillCheckResultSchema.nullable().default(null),
  releaseNote: z.string().nullable(),
  revision: z.number().int(),
  created_at: z.string(),
  updated_at: z.string()
}).strict();

export const publishSkillRequestSchema = z.object({
  version: registrySemverSchema,
  releaseNote: z.string().optional()
}).strict();

export const setDefaultAgentRequestSchema = z.object({
  defaultAgent: registryAgentSchema,
  revision: z.number().int().positive()
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
  // Y-4：语义已扩展为"任一 installable adapter 可编译"（非仅 claude-code；store.ts createProposal/publish 验 buildArtifacts.length>0）。
  // 字段名保留以维持已发布契约稳定（schemas.test.ts 引用，改名=破坏性）。
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
  agent: registryAgentSchema,
  ir: z.unknown().optional(),
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
  ir: z.unknown().optional(),
  sourceFiles: z.array(sourceFileSchema).default([]),
  examples: z.array(skillUsageExampleSchema).default([])
}).strict();

export const registrySkillProposalSchema = z.object({
  proposal_id: z.string().regex(/^skp_/),
  skill_slug: registrySlugSchema,
  proposed_ir: z.unknown().optional(),
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
export type SetDefaultAgentRequest = z.infer<typeof setDefaultAgentRequestSchema>;
export type SkillDiffFile = z.infer<typeof skillDiffFileSchema>;
