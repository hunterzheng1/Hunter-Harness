import { z } from "zod";

import { registryAgentSchema, skillCheckResultSchema } from "./registry.js";

// AI 供应商 api_format：openai 真实支持（DeepSeek/OpenAI-compatible）；anthropic/custom 暂无 client 实现，路由 422 ADAPTER_NOT_IMPLEMENTED。
export const aiProviderApiFormatSchema = z.enum(["openai", "anthropic", "custom"]);
export type AiProviderApiFormat = z.infer<typeof aiProviderApiFormatSchema>;

// 单个模型条目：display_model（展示名）+ request_model（实际请求名）+ 4 项成本（per 1M tokens）。
// 成本字段默认 0，兼容迁移生成的省略成本条目。
export const providerModelSchema = z.object({
  id: z.string(),
  display_model: z.string(),
  request_model: z.string(),
  input_cost: z.number().nonnegative().default(0),
  output_cost: z.number().nonnegative().default(0),
  cache_hit_cost: z.number().nonnegative().default(0),
  cache_create_cost: z.number().nonnegative().default(0)
}).strict();
export type ProviderModel = z.infer<typeof providerModelSchema>;

// AI 供应商配置（不含 key 值；key 走 secret file/env，由 api_key_env 指示读取来源）
// daily_*_limit: null = 不限；缺失时默认 null（兼容旧 provider 无 quota 字段，COM-002）
// models[]/api_format/note/website/selected_model_id/sort_order：多模型扩展，全部带 default 向后兼容旧 snapshot 反序列化（schemaVersion 3→4 迁移）
// model 字段保留：兼容旧 snapshot；迁移后 = selected model 的 request_model
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
  updated_at: z.iso.datetime(),
  models: z.array(providerModelSchema).default([]),
  api_format: aiProviderApiFormatSchema.default("openai"),
  note: z.string().default(""),
  website: z.string().default(""),
  selected_model_id: z.string().nullable().default(null),
  sort_order: z.number().int().nonnegative().default(0)
}).strict();

// GET /providers 响应项：aiProviderConfig + key_set（运行时由 secret file 存在性算出，不进 DB/store）
// key_set=true 表示已写 secret file；响应绝不返回 key 值（安全边界：key 只走 secret file，不进 DB/响应/日志）
export const aiProviderWithKeySetSchema = aiProviderConfigSchema.extend({
  key_set: z.boolean()
}).strict();
export type AiProviderWithKeySet = z.infer<typeof aiProviderWithKeySetSchema>;

// per-provider per-model per-day 用量（date 为 UTC date，滚动重置；COM-001 旧全局 aiUsage 迁移到默认 provider 当日条目）
// tokens = input + output（兼容旧字段）；model/input_tokens/output_tokens/cache_hit_tokens/cache_create_tokens/cost 为 per-model 扩展，默认 ""/0 兼容旧条目
export const aiQuotaUsageSchema = z.object({
  provider_id: z.string(),
  date: z.string(),
  requests: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  model: z.string().default(""),
  input_tokens: z.number().int().nonnegative().default(0),
  output_tokens: z.number().int().nonnegative().default(0),
  cache_hit_tokens: z.number().int().nonnegative().default(0),
  cache_create_tokens: z.number().int().nonnegative().default(0),
  cost: z.number().nonnegative().default(0)
}).strict();

export const aiConfigStateSchema = z.object({
  defaultProvider: z.string().nullable(),
  providers: z.array(aiProviderConfigSchema),
  usage: z.array(aiQuotaUsageSchema).default([])
}).strict();

// POST /api/v1/ai-config/providers/reorder 请求体：provider_ids 为有序完整列表（不多不少，否则 422）。
export const aiProviderReorderRequestSchema = z.object({
  schema_version: z.literal(1),
  provider_ids: z.array(z.string().min(1)).min(1)
}).strict();
export type AiProviderReorderRequest = z.infer<typeof aiProviderReorderRequestSchema>;

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
