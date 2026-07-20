import { z } from "zod";

import { sha256Schema } from "./protocol.js";

export const skillTargetAgentSchema = z.enum(["claude-code", "codex", "cursor", "codebuddy"]);
export const registryAgentSchema = z.enum([
  "claude-code",
  "codex",
  "cursor",
  "codebuddy",
  "generic",
  "mcp"
]);
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
export const skillVariantStatusSchema = z.enum(["ready", "degraded", "unsupported"]);

export const sourceFileSchema = z.object({
  path: z.string(),
  content: z.string()
}).strict();

// SKILL.md frontmatter — 松校验，取代 canonical Skill IrSchema。
// .passthrough() 保留未声明的额外字段（author/tags/license 等），避免合法 SKILL.md 因额外字段被拒（评审 RED#1）。
// name/slug 统一格式（与 registrySlugSchema 同源）：小写字母数字 + 单连字符分隔，不允许连续/尾连字符；不强制 harness- 前缀。
// SKILL_NAME_REGEX 仅校验格式；长度上限（≤64）由 skillNameSchema.max(64) 单独强制。
export const SKILL_NAME_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const skillNameSchema = z.string().regex(
  SKILL_NAME_REGEX,
  "name must be lowercase alphanumeric with single hyphens between segments, at most 64 chars"
).max(64);
export const skillFrontmatterSchema = z.object({
  name: skillNameSchema,
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

export const sensitiveFindingViewSchema = z.object({
  rule_id: z.string().min(1),
  severity: z.enum(["high", "medium", "low"]),
  path: z.string().min(1),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  fingerprint: sha256Schema,
  redacted_preview: z.string(),
  overridable: z.boolean()
}).strict();

export const sensitiveReviewSubmissionSchema = z.object({
  scanner_version: z.string().min(1),
  finding_fingerprints: z.array(sha256Schema).min(1),
  reason: z.string().trim().min(3).max(500)
}).strict();

export const sensitiveReviewEvidenceSchema = sensitiveReviewSubmissionSchema.extend({
  actor: z.string().min(1),
  accepted_at: z.iso.datetime()
}).strict();

export const skillVariantSchema = z.object({
  agent: skillTargetAgentSchema,
  status: skillVariantStatusSchema,
  buildHash: sha256Schema.nullable(),
  adapterVersion: z.string().min(1),
  components: z.array(z.string().min(1))
}).strict();

export const skillReleaseSchema = z.object({
  version: registrySemverSchema,
  packageName: z.string().min(1),
  packageDigest: z.string().min(1),
  variants: z.partialRecord(skillTargetAgentSchema, skillVariantSchema),
  created_at: z.iso.datetime()
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

export const publishUnifiedSkillRequestSchema = z.object({
  version: registrySemverSchema,
  sourceAgent: skillTargetAgentSchema,
  draftRevision: z.number().int().positive(),
  releaseNote: z.string().trim().min(1).max(2_000).optional()
}).strict();

export const publishSkillResponseSchema = z.object({
  release: z.object({
    slug: registrySlugSchema,
    version: registrySemverSchema
  }).strict(),
  npmRelease: z.object({
    status: z.enum(["published", "idempotent"]),
    packageName: z.string().min(1),
    version: registrySemverSchema,
    tarballHash: z.string().min(1)
  }).strict()
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
  // kind 从 entry frontmatter 反范式化（与 description 同理），供 dashboard 分类分布。
  // nullable：新 skill 无 kind 时为 null（overview 回退 "unknown"）；optional：兼容旧数据无此字段。
  kind: z.enum(["workflow", "tooling", "migration", "governance"]).nullable().optional(),
  tags: z.array(registrySlugSchema),
  status: registrySkillStatusSchema,
  latest_version: registrySemverSchema.nullable(),
  defaultAgent: registryAgentSchema.nullable(),
  agents: z.array(agentSkillConfigSchema),
  revision: z.number().int().positive(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  // npm 发布记录（registry snapshot 可选字段，旧快照缺省为 []）
  npmReleases: z.array(z.lazy(() => npmReleaseRecordSchema)).optional().default([])
}).strict();

export const npmReleaseStatusSchema = z.enum(["published", "failed", "conflict"]);

export const npmReleaseRecordSchema = z.object({
  version: registrySemverSchema,
  packageName: z.string().min(1),
  status: npmReleaseStatusSchema,
  publishedAt: z.iso.datetime(),
  error: z.string().nullable().optional().default(null)
}).strict();

export const npmReleaseResponseSchema = z.object({
  slug: registrySlugSchema,
  release: npmReleaseRecordSchema
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

export type RegistryAgent = z.infer<typeof registryAgentSchema>;
export type SkillTargetAgent = z.infer<typeof skillTargetAgentSchema>;
export type SkillVariantStatus = z.infer<typeof skillVariantStatusSchema>;
export type SkillVariant = z.infer<typeof skillVariantSchema>;
export type SkillRelease = z.infer<typeof skillReleaseSchema>;
export type SensitiveFindingView = z.infer<typeof sensitiveFindingViewSchema>;
export type SensitiveReviewSubmission = z.infer<typeof sensitiveReviewSubmissionSchema>;
export type SensitiveReviewEvidence = z.infer<typeof sensitiveReviewEvidenceSchema>;
export type RegistryArtifact = z.infer<typeof registryArtifactSchema>;
export type RegistrySkillVersion = z.infer<typeof registrySkillVersionSchema>;
export type RegistrySkillSummary = z.infer<typeof registrySkillSummarySchema>;
export type RegistrySkillDetail = z.infer<typeof registrySkillDetailSchema>;
export type RegistrySkillProposal = z.infer<typeof registrySkillProposalSchema>;
export type RegistryTag = z.infer<typeof registryTagSchema>;
export type NpmReleaseStatus = z.infer<typeof npmReleaseStatusSchema>;
export type NpmReleaseRecord = z.infer<typeof npmReleaseRecordSchema>;
export type NpmReleaseResponse = z.infer<typeof npmReleaseResponseSchema>;
export type CheckStatus = z.infer<typeof checkStatusSchema>;
export type SourceFile = z.infer<typeof sourceFileSchema>;
export type SkillUsageExample = z.infer<typeof skillUsageExampleSchema>;
export type AgentSkillConfig = z.infer<typeof agentSkillConfigSchema>;
export type SkillCheckItem = z.infer<typeof skillCheckItemSchema>;
export type SkillCheckResult = z.infer<typeof skillCheckResultSchema>;
export type DraftState = z.infer<typeof draftStateSchema>;
export type PublishSkillRequest = z.infer<typeof publishSkillRequestSchema>;
export type PublishUnifiedSkillRequest = z.infer<typeof publishUnifiedSkillRequestSchema>;
export type PublishSkillResponse = z.infer<typeof publishSkillResponseSchema>;
export type SetDefaultAgentRequest = z.infer<typeof setDefaultAgentRequestSchema>;
export type SkillDiffFile = z.infer<typeof skillDiffFileSchema>;
