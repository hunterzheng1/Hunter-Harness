// LLM 调用抽象（供应商无关；core 不依赖具体 SDK，DeepSeek 用原生 fetch 实现）

export interface LlmPrompt {
  system: string;
  user: string;
}

export interface LlmResponse {
  content: string;
  usage?: { requests: number; tokens: number };
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
