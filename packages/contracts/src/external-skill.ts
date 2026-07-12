import { z } from "zod";

export const externalSkillSourceTypeSchema = z.enum(["npm", "github"]);
export type ExternalSkillSourceType = z.infer<typeof externalSkillSourceTypeSchema>;

export const externalSkillSourceSchema = z.object({
  type: externalSkillSourceTypeSchema,
  /** npm 包名，或规范化后的 `owner/repo` */
  ref: z.string().min(1)
}).strict();
export type ExternalSkillSource = z.infer<typeof externalSkillSourceSchema>;

export const externalSkillSnapshotSchema = z.object({
  name: z.string(),
  description: z.string(),
  version: z.string().nullable(),
  readme: z.string().nullable(),
  installCommand: z.string(),
  license: z.string().nullable(),
  homepage: z.string().nullable(),
  releaseUrl: z.string().nullable(),
  fetchedAt: z.string()
}).strict();
export type ExternalSkillSnapshot = z.infer<typeof externalSkillSnapshotSchema>;

export const externalSkillSchema = z.object({
  id: z.string().regex(/^ext_/),
  source: externalSkillSourceSchema,
  snapshot: externalSkillSnapshotSchema,
  curationNote: z.string(),
  tags: z.array(z.string()),
  updateAvailable: z.boolean(),
  lastCheckedAt: z.string(),
  revision: z.number().int().positive(),
  created_at: z.string(),
  updated_at: z.string()
}).strict();
export type ExternalSkill = z.infer<typeof externalSkillSchema>;

export const createExternalSkillRequestSchema = z.object({
  source: externalSkillSourceSchema,
  curationNote: z.string().default(""),
  tags: z.array(z.string()).default([])
}).strict();
export type CreateExternalSkillRequest = z.infer<typeof createExternalSkillRequestSchema>;

export const patchExternalSkillRequestSchema = z.object({
  curationNote: z.string().optional(),
  tags: z.array(z.string()).optional(),
  /** 清除「有更新」徽章（不改变 curationNote / snapshot） */
  acknowledgeUpdate: z.boolean().optional(),
  revision: z.number().int().positive()
}).strict();
export type PatchExternalSkillRequest = z.infer<typeof patchExternalSkillRequestSchema>;
