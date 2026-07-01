import * as path from "node:path";
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

// 写入/更新 secret file 中某 provider 的 key（及可选 baseUrl/model 覆盖）。
// 保留其他 provider 条目；文件/目录不存在则创建。key 只写文件，不进 store/log/响应。
export async function writeAiSecret(secretFile: string, providerId: string, secret: AiSecret): Promise<void> {
  let obj: Record<string, unknown> = {};
  try {
    const text = await fs.readFile(secretFile, "utf8");
    const parsed = JSON.parse(text) as unknown;
    if (parsed !== null && typeof parsed === "object") {
      obj = parsed as Record<string, unknown>;
    }
  } catch {
    // 文件不存在或非法 JSON，用空对象新建
  }
  const entry: Record<string, unknown> = { apiKey: secret.apiKey };
  if (secret.baseUrl !== undefined) entry.baseUrl = secret.baseUrl;
  if (secret.model !== undefined) entry.model = secret.model;
  obj[providerId] = entry;
  await fs.mkdir(path.dirname(secretFile), { recursive: true });
  await fs.writeFile(secretFile, JSON.stringify(obj, null, 2) + "\n", "utf8");
}
