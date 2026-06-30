import { z } from "zod";

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
