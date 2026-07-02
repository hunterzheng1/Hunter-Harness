import type { LlmClient, LlmFetch, LlmPrompt, LlmResponse } from "./llm-client.js";

export interface DeepSeekLlmClientOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: LlmFetch;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

// DeepSeek（OpenAI-compatible）客户端：POST {baseUrl}/chat/completions，Bearer apiKey
export class DeepSeekLlmClient implements LlmClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: LlmFetch;

  constructor(opts: DeepSeekLlmClientOptions) {
    this.baseUrl = opts.baseUrl;
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 30000;
    this.maxRetries = opts.maxRetries ?? 1;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as LlmFetch);
  }

  async analyze(prompt: LlmPrompt): Promise<LlmResponse> {
    const url = this.baseUrl.replace(/\/$/, "") + "/chat/completions";
    const body = JSON.stringify({
      model: this.model,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user }
      ]
    });
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + this.apiKey
          },
          body,
          signal: controller.signal
        });
        if (!res.ok) {
          throw new Error("LLM HTTP " + res.status);
        }
        const data = (await res.json()) as ChatCompletionResponse;
        const content = data.choices?.[0]?.message?.content ?? "";
        const promptTokens = data.usage?.prompt_tokens ?? 0;
        const completionTokens = data.usage?.completion_tokens ?? 0;
        return {
          content,
          usage: {
            requests: 1,
            tokens: promptTokens + completionTokens,
            input_tokens: promptTokens,
            output_tokens: completionTokens,
            cache_hit_tokens: 0,
          cache_create_tokens: 0
          }
        };
      } catch (err) {
        lastError = err;
        if (attempt < this.maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 500 * Math.pow(2, attempt)));
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new Error("LLM analyze failed");
  }
}
