import { z } from "zod";

// AI 供应商配置（不含 key 值；key 走 secret file/env，由 api_key_env 指示读取来源）
export const aiProviderConfigSchema = z.object({
  provider_id: z.string(),
  label: z.string(),
  base_url: z.url(),
  model: z.string(),
  enabled: z.boolean(),
  is_default: z.boolean(),
  api_key_env: z.string(),
  revision: z.number().int(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime()
}).strict();

export const aiConfigStateSchema = z.object({
  defaultProvider: z.string().nullable(),
  providers: z.array(aiProviderConfigSchema)
}).strict();

export type AiProviderConfig = z.infer<typeof aiProviderConfigSchema>;
export type AiConfigState = z.infer<typeof aiConfigStateSchema>;
