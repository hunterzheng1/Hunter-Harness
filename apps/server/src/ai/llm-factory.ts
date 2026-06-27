import type { AiProviderConfig } from "@hunter-harness/contracts";
import { DeepSeekLlmClient, type LlmClient } from "@hunter-harness/core";

// LlmClient 装配：根据 provider 配置 + secret key 构造 DeepSeek（OpenAI-compatible）客户端。
// 超时 30s + 重试 1 次（指数退避，见 DeepSeekLlmClient）；不绑定单一供应商，换 provider 仅改配置。
export function createLlmClient(provider: AiProviderConfig, apiKey: string): LlmClient {
  return new DeepSeekLlmClient({
    baseUrl: provider.base_url,
    model: provider.model,
    apiKey,
    timeoutMs: 30000,
    maxRetries: 1
  });
}
