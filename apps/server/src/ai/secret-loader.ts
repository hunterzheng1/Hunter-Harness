import { promises as fs } from "node:fs";

// AI provider API key 读取结果（key 只内存用，不写 store/log/响应）
export interface AiSecret {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

// 从项目外 secret file 按 providerId 读取 API key（及可选 baseUrl/model 覆盖）。
// 文件格式：{ "<providerId>": { apiKey, baseUrl?, model? } }
// 文件不存在 / 非法 JSON / 无该 provider 条目 / apiKey 缺失 → 返回 null
// （路由层据此返回 AI_NOT_CONFIGURED）。key 只返回给 LlmClient 构造，不写日志。
export async function loadAiSecret(secretFile: string, providerId: string): Promise<AiSecret | null> {
  let text: string;
  try {
    text = await fs.readFile(secretFile, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const obj = (parsed ?? {}) as Record<string, unknown>;
  const entry = obj[providerId];
  if (entry === null || typeof entry !== "object") return null;
  const rec = entry as Record<string, unknown>;
  const apiKey = rec.apiKey;
  if (typeof apiKey !== "string" || apiKey.length === 0) return null;
  const result: AiSecret = { apiKey };
  if (typeof rec.baseUrl === "string" && rec.baseUrl.length > 0) result.baseUrl = rec.baseUrl;
  if (typeof rec.model === "string" && rec.model.length > 0) result.model = rec.model;
  return result;
}
