// LLM 调用抽象（供应商无关；core 不依赖具体 SDK，DeepSeek 用原生 fetch 实现）

export interface LlmPrompt {
  system: string;
  user: string;
}

export interface LlmResponse {
  content: string;
  // usage: requests/tokens 总数（向后兼容）；input_tokens/output_tokens/cache_hit_tokens/cache_create_tokens 为 per-model 拆分（可选，供 recordUsage 精确算 cost）。
  usage?: { requests: number; tokens: number; input_tokens?: number; output_tokens?: number; cache_hit_tokens?: number; cache_create_tokens?: number };
}

export interface LlmClient {
  analyze(prompt: LlmPrompt): Promise<LlmResponse>;
}

// fetch 抽象（便于测试注入 mock；真实实现用 globalThis.fetch）
export interface LlmFetchResult {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type LlmFetch = (url: string, init: RequestInit) => Promise<LlmFetchResult>;
