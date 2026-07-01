import { z } from "zod";

import { registryAgentSchema, skillCheckResultSchema } from "./registry.js";

// AI 供应商配置（不含 key 值；key 走 secret file/env，由 api_key_env 指示读取来源）
// daily_*_limit: null = 不限；缺失时默认 null（兼容旧 provider 无 quota 字段，COM-002）
export const aiProviderConfigSchema = z.object({
  provider_id: z.string(),
  label: z.string(),
  base_url: z.url(),
  model: z.string(),
  enabled: z.boolean(),
  is_default: z.boolean(),
  api_key_env: z.string(),
  revision: z.number().int(),
  daily_request_limit: z.number().int().nonnegative().nullable().default(null),
  daily_token_limit: z.number().int().nonnegative().nullable().default(null),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime()
}).strict();

// per-provider per-day 用量（date 为 UTC date，滚动重置；COM-001 旧全局 aiUsage 迁移到默认 provider 当日条目）
export const aiQuotaUsageSchema = z.object({
  provider_id: z.string(),
  date: z.string(),
  requests: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative()
}).strict();

export const aiConfigStateSchema = z.object({
  defaultProvider: z.string().nullable(),
  providers: z.array(aiProviderConfigSchema),
  usage: z.array(aiQuotaUsageSchema).default([])
}).strict();

export type AiProviderConfig = z.infer<typeof aiProviderConfigSchema>;
export type AiQuotaUsage = z.infer<typeof aiQuotaUsageSchema>;
export type AiConfigState = z.infer<typeof aiConfigStateSchema>;

// 异步 AI 检查 job 状态（GET /api/v1/ai-jobs/:id 响应；与 server AiJobStore 对齐）。
// slug + agent 为 dedup key：同 slug+agent 重复启动 job 返已有 jobId（治 R2 并发限制）。
export const aiJobStateSchema = z.object({
  jobId: z.string(),
  slug: z.string(),
  agent: registryAgentSchema,
  status: z.enum(["pending", "running", "completed", "failed"]),
  result: skillCheckResultSchema.nullable(),
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime()
}).strict();
export type AiJobState = z.infer<typeof aiJobStateSchema>;
