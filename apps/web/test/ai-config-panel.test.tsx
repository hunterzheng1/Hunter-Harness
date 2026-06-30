// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AiProviderConfig } from "@hunter-harness/contracts";
import { AiConfigPanel } from "../components/ai-config-panel";
import type { HunterApi } from "../lib/api";

const mockProvider: AiProviderConfig = {
  provider_id: "deepseek", label: "DeepSeek", base_url: "https://api.deepseek.com",
  model: "deepseek-v4-pro", enabled: true, is_default: true, api_key_env: "secret-file",
  revision: 1, daily_request_limit: null, daily_token_limit: null,
  created_at: "2026-06-25T09:30:00Z", updated_at: "2026-06-25T09:30:00Z"
};

function makeApi(overrides: Partial<HunterApi> = {}): HunterApi {
  return {
    listAiProviders: vi.fn(async () => ({ items: [mockProvider], default_provider: "deepseek" })),
    getAiUsage: vi.fn(async () => [{ provider_id: "deepseek", date: "2026-07-01", requests: 10, tokens: 500 }]),
    testAiProvider: vi.fn(async () => ({ provider_id: "deepseek", ok: true, model: "deepseek-v4-pro" })),
    createAiProvider: vi.fn(async (input: Record<string, unknown>) => ({ ...mockProvider, ...input, revision: 1 })),
    updateAiProvider: vi.fn(async (id: string, rev: number, patch: Record<string, unknown>) => ({ ...mockProvider, ...patch, provider_id: id, revision: rev + 1 })),
    deleteAiProvider: vi.fn(async () => ({ provider_id: "deepseek", deleted: true })),
    runSkillAiChecks: vi.fn(async () => ({ jobId: "test-job", status: "pending" })),
    ...overrides
  } as unknown as HunterApi;
}

afterEach(cleanup);

describe("AiConfigPanel (簇 E, 任务 15/17 — INT-004)", () => {
  it("加载 providers + usage 并展示", async () => {
    const api = makeApi();
    render(<AiConfigPanel api={api} />);
    await waitFor(() => expect(screen.getAllByText("DeepSeek").length).toBeGreaterThan(0));
    expect(api.listAiProviders).toHaveBeenCalledTimes(1);
    expect(api.getAiUsage).toHaveBeenCalledTimes(1);
  });

  it("testConnection 调 testAiProvider 并显示通过", async () => {
    const api = makeApi();
    render(<AiConfigPanel api={api} />);
    await waitFor(() => expect(screen.getAllByText("DeepSeek").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: /测试连通性|Test connection/i }));
    await waitFor(() => expect(api.testAiProvider).toHaveBeenCalledWith("deepseek"));
  });

  it("save 调 updateAiProvider（已存在 provider）", async () => {
    const api = makeApi();
    render(<AiConfigPanel api={api} />);
    await waitFor(() => expect(screen.getAllByText("DeepSeek").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: /保存|save/i }));
    await waitFor(() => expect(api.updateAiProvider).toHaveBeenCalled());
  });

  it("test 失败显示错误信息（不含 key）", async () => {
    const api = makeApi({ testAiProvider: vi.fn(async () => ({ provider_id: "deepseek", ok: false, error: "refused" })) });
    render(<AiConfigPanel api={api} />);
    await waitFor(() => expect(screen.getAllByText("DeepSeek").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: /测试连通性|Test connection/i }));
    await waitFor(() => expect(screen.getByText(/refused|失败|failed/i)).toBeInTheDocument());
    expect(screen.queryByText(/sk-/i)).not.toBeInTheDocument();
  });

  it("新增 provider 调 createAiProvider", async () => {
    const api = makeApi();
    render(<AiConfigPanel api={api} />);
    await waitFor(() => expect(screen.getAllByText("DeepSeek").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: /新增供应商|Add provider/i }));
    fireEvent.click(screen.getByRole("button", { name: /保存|save/i }));
    await waitFor(() => expect(api.createAiProvider).toHaveBeenCalled());
  });
});
