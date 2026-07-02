import type { AiProviderConfig } from "@hunter-harness/contracts";
import { DeepSeekLlmClient, type LlmClient } from "@hunter-harness/core";

// LlmClient 装配：根据 provider 配置 + secret key 构造客户端。
// api_format=openai → DeepSeek（OpenAI-compatible），用 selected_model_id 找 request_model（fallback models[0] → provider.model）。
// api_format=anthropic|custom → null（暂无 client 实现，路由层 422 ADAPTER_NOT_IMPLEMENTED）。
// 超时 30s + 重试 1 次（指数退避，见 DeepSeekLlmClient）。
export function createLlmClient(provider: AiProviderConfig, apiKey: string): LlmClient | null {
  if (provider.api_format !== "openai") return null;
  const selected = provider.models.find((m) => m.id === provider.selected_model_id) ?? provider.models[0];
  const requestModel = selected?.request_model ?? provider.model;
  return new DeepSeekLlmClient({
    baseUrl: provider.base_url,
    model: requestModel,
    apiKey,
    timeoutMs: 30000,
    maxRetries: 1
  });
}
