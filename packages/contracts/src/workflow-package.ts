import { z } from "zod";

import { sha256Schema } from "./protocol.js";
import { registrySemverSchema, registrySlugSchema, skillCheckResultSchema, sourceFileSchema } from "./registry.js";

// workflow.yaml manifest：引用已发布 skill + 共享资源（agents/protocols/templates）+ 执行顺序/策略。
// 与 registryWorkflowSchema（有序 Skill 清单）不同——package 是可发布的完整工作流包，含 manifest + 共享资源快照 + 版本。
export const workflowPackageManifestSchema = z.object({
  key: registrySlugSchema,
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(1000),
  profile: registrySlugSchema,
  skills: z.array(z.object({
    slug: registrySlugSchema,
    ref: z.string()
  }).strict()),
  agents: z.array(z.object({
    path: z.string(),
    ref: z.string()
  }).strict()),
  protocols: z.array(z.object({
    path: z.string(),
    ref: z.string()
  }).strict()),
  templates: z.array(z.object({
    path: z.string(),
    ref: z.string()
  }).strict()),
  execution_order: z.array(z.string()),
  strategy: z.enum(["sequential", "parallel", "manual"])
}).strict();

// workflow package 制品：ZIP blob 引用（content-addressed，与 registryArtifactSchema 同模式但 package 维度）。
export const workflowPackageArtifactSchema = z.object({
  artifact_id: z.string().regex(/^wfa_/),
  package_key: registrySlugSchema,
  version: registrySemverSchema,
  content_sha256: sha256Schema,
  size_bytes: z.number().int().nonnegative(),
  created_at: z.iso.datetime()
}).strict();

// 一次发布版本：manifest 快照 + artifacts + 源文件 + changeNote（仿 registrySkillVersionSchema）。
export const workflowPackageVersionSchema = z.object({
  package_key: registrySlugSchema,
  version: registrySemverSchema,
  manifest: workflowPackageManifestSchema,
  artifacts: z.array(workflowPackageArtifactSchema),
  sourceFiles: z.array(sourceFileSchema).default([]),
  changeNote: z.string().nullable(),
  created_at: z.iso.datetime()
}).strict();

// 未发布草稿（仿 draftStateSchema；checks 复用 skillCheckResultSchema）。
export const workflowPackageDraftStateSchema = z.object({
  key: registrySlugSchema,
  manifest: workflowPackageManifestSchema,
  sourceFiles: z.array(sourceFileSchema),
  draftVersion: registrySemverSchema.nullable(),
  checks: skillCheckResultSchema.nullable(),
  releaseNote: z.string().nullable(),
  revision: z.number().int(),
  created_at: z.string(),
  updated_at: z.string()
}).strict();

// 已发布 package 详情（仿 registrySkillDetailSchema，version 历史走 listPackageVersions）。
export const workflowPackageSchema = z.object({
  package_id: z.string().regex(/^wfp_/),
  key: registrySlugSchema,
  manifest: workflowPackageManifestSchema,
  latestVersion: registrySemverSchema.nullable(),
  revision: z.number().int().positive(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime()
}).strict();

export const publishWorkflowPackageRequestSchema = z.object({
  version: registrySemverSchema,
  releaseNote: z.string().optional()
}).strict();

export type WorkflowPackageManifest = z.infer<typeof workflowPackageManifestSchema>;
export type WorkflowPackageArtifact = z.infer<typeof workflowPackageArtifactSchema>;
export type WorkflowPackageVersion = z.infer<typeof workflowPackageVersionSchema>;
export type WorkflowPackageDraftState = z.infer<typeof workflowPackageDraftStateSchema>;
export type WorkflowPackage = z.infer<typeof workflowPackageSchema>;
export type PublishWorkflowPackageRequest = z.infer<typeof publishWorkflowPackageRequestSchema>;
