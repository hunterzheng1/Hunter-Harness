// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiProviderConfig, AiQuotaUsage } from "@hunter-harness/contracts";

import { AiConfigPanel } from "../components/ai-config-panel";

// mock browserApi：可写 mock（listAiProviders 返回多模型 providers；各 mutation 返回成功）
const { api } = vi.hoisted(() => {
  const mockProviders: AiProviderConfig[] = [
    {
      provider_id: "deepseek", label: "DeepSeek", base_url: "https://api.deepseek.com",
      model: "deepseek-chat", enabled: true, is_default: true, api_key_env: "secret-file",
      revision: 1, daily_request_limit: null, daily_token_limit: null,
      created_at: "2026-06-25T00:00:00Z", updated_at: "2026-06-25T00:00:00Z",
      models: [
        { id: "ds-chat", display_model: "DeepSeek Chat", request_model: "deepseek-chat", input_cost: 0.27, output_cost: 1.1, cache_hit_cost: 0.07, cache_create_cost: 0.27 },
        { id: "ds-reasoner", display_model: "DeepSeek Reasoner", request_model: "deepseek-reasoner", input_cost: 0.55, output_cost: 2.19, cache_hit_cost: 0.14, cache_create_cost: 0.55 }
      ],
      api_format: "openai", note: "主力供应商", website: "https://platform.deepseek.com", selected_model_id: "ds-chat", sort_order: 0
    },
    {
      provider_id: "openai", label: "OpenAI", base_url: "https://api.openai.com",
      model: "gpt-4o", enabled: false, is_default: false, api_key_env: "secret-file",
      revision: 1, daily_request_limit: null, daily_token_limit: null,
      created_at: "2026-06-25T00:00:00Z", updated_at: "2026-06-25T00:00:00Z",
      models: [{ id: "o4o", display_model: "GPT-4o", request_model: "gpt-4o", input_cost: 2.5, output_cost: 10, cache_hit_cost: 1.25, cache_create_cost: 0 }],
      api_format: "openai", note: "", website: "https://platform.openai.com", selected_model_id: "o4o", sort_order: 1
    },
    {
      provider_id: "anthropic", label: "Anthropic", base_url: "https://api.anthropic.com",
      model: "claude-sonnet-4-6", enabled: false, is_default: false, api_key_env: "secret-file",
      revision: 1, daily_request_limit: null, daily_token_limit: null,
      created_at: "2026-06-25T00:00:00Z", updated_at: "2026-06-25T00:00:00Z",
      models: [{ id: "sonnet", display_model: "Claude Sonnet 4.6", request_model: "claude-sonnet-4-6", input_cost: 3, output_cost: 15, cache_hit_cost: 0.3, cache_create_cost: 3.75 }],
      api_format: "anthropic", note: "", website: "https://console.anthropic.com", selected_model_id: "sonnet", sort_order: 2
    }
  ];
  const mockUsage: AiQuotaUsage[] = [
    { provider_id: "deepseek", date: "2026-07-01", model: "deepseek-chat", requests: 38, tokens: 440000, input_tokens: 280000, output_tokens: 160000, cache_hit_tokens: 40000, cache_create_tokens: 0, cost: 0.27 },
    { provider_id: "deepseek", date: "2026-07-01", model: "deepseek-reasoner", requests: 12, tokens: 400000, input_tokens: 180000, output_tokens: 220000, cache_hit_tokens: 0, cache_create_tokens: 0, cost: 0.58 }
  ];
  const api = {
    listAiProviders: vi.fn(async () => ({ items: mockProviders.map((p) => ({ ...p, models: p.models.map((m) => ({ ...m })) })), default_provider: "deepseek" })),
    createAiProvider: vi.fn(async (input: Record<string, unknown>) => ({ is_default: false, daily_request_limit: null, daily_token_limit: null, created_at: "2026-07-02T00:00:00Z", updated_at: "2026-07-02T00:00:00Z", models: [], api_format: "openai", note: "", website: "", selected_model_id: null, sort_order: 0, ...input, revision: 1 } as unknown as AiProviderConfig)),
    updateAiProvider: vi.fn(async (id: string, rev: number, patch: Record<string, unknown>) => {
      const base = mockProviders.find((p) => p.provider_id === id) ?? mockProviders[0];
      return { ...base, ...patch, revision: rev + 1 } as AiProviderConfig;
    }),
    deleteAiProvider: vi.fn(async (id: string) => ({ provider_id: id, deleted: true })),
    testAiProvider: vi.fn(async (id: string) => ({ provider_id: id, ok: true, model: "deepseek-chat" })),
    setAiProviderKey: vi.fn(async (id: string) => ({ provider_id: id, key_set: true })),
    getAiUsage: vi.fn(async () => mockUsage.map((u) => ({ ...u }))),
    reorderAiProviders: vi.fn(async (ids: string[]) => ({ provider_ids: ids }))
  };
  return { api };
});

vi.mock("../lib/api", () => ({ browserApi: () => api }));

const EDIT = /编辑|Edit/;
const ADD_PROVIDER = /新增供应商|Add provider/;
const ADD_MODEL = /新增模型|Add model/;
const DUPLICATE = /复制|Duplicate/;
const TEST_CONN = /测试连通性|Test connection/;
const USAGE = /^用量$|^Usage$/;
const REQUEST_MODEL_PH = /如 deepseek-chat/i;
const ENABLED = /^已启用$|^Enabled$/;
const DISABLED = /^未启用$|^Disabled$/;

afterEach(cleanup);

function btn(name: RegExp | string): HTMLElement {
  const el = screen.getAllByRole("button", { name })[0];
  if (el === undefined) throw new Error(`button ${String(name)} not found`);
  return el;
}

async function renderLoaded(): Promise<void> {
  render(<AiConfigPanel />);
  await waitFor(() => expect(screen.getByText("DeepSeek")).toBeInTheDocument());
}

describe("AiConfigPanel 接后端 API (T11, I-01~I-06)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("I-01 列表态 listAiProviders 加载并渲染后端 providers", async () => {
    await renderLoaded();
    expect(screen.getByText("DeepSeek")).toBeInTheDocument();
    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(api.listAiProviders).toHaveBeenCalledTimes(1);
    expect(api.getAiUsage).toHaveBeenCalledTimes(1);
  });

  it("I-02 拖拽 drop → reorderAiProviders 调用 + 顺序变", async () => {
    const { container } = render(<AiConfigPanel />);
    await waitFor(() => expect(screen.getByText("DeepSeek")).toBeInTheDocument());
    const handle = container.querySelectorAll(".drag-handle")[0];
    const targetRow = container.querySelectorAll(".provider-row")[1];
    if (handle === undefined || targetRow === undefined) throw new Error("missing drag rows");
    fireEvent.dragStart(handle);
    fireEvent.dragOver(targetRow);
    fireEvent.drop(targetRow);
    await waitFor(() => expect(api.reorderAiProviders).toHaveBeenCalledTimes(1));
    expect(api.reorderAiProviders.mock.calls[0]?.[0]).toEqual(["openai", "deepseek", "anthropic"]);
  });

  it("I-03 用量弹窗 getAiUsage per-model 维度", async () => {
    await renderLoaded();
    fireEvent.click(btn(USAGE));
    expect(screen.getByRole("heading", { name: /DeepSeek.*使用统计/i })).toBeInTheDocument();
    expect(screen.getByText(/^按模型$|^By model$/)).toBeInTheDocument();
    // per-model：deepseek-chat + deepseek-reasoner 都展示
    expect(screen.getByText("deepseek-chat")).toBeInTheDocument();
    expect(screen.getByText("deepseek-reasoner")).toBeInTheDocument();
  });

  it("I-04 详情保存 updateAiProvider 含 models（已存在 provider）", async () => {
    await renderLoaded();
    fireEvent.click(btn(EDIT));
    fireEvent.click(screen.getByRole("button", { name: /^保存$|^Save$/ }));
    await waitFor(() => expect(api.updateAiProvider).toHaveBeenCalledTimes(1));
    const [, , patch] = api.updateAiProvider.mock.calls[0] ?? [];
    expect(patch).toHaveProperty("models");
    expect((patch as { models: unknown[] }).models).toHaveLength(2);
  });

  it("I-05 启用单选 → updateAiProvider enabled 后后端单选（其他 false）", async () => {
    await renderLoaded();
    // 初始 deepseek enabled，openai/anthropic disabled
    expect(screen.getAllByRole("button", { name: ENABLED }).length).toBe(1);
    fireEvent.click(btn(DISABLED)); // 启用 openai
    await waitFor(() => expect(api.updateAiProvider).toHaveBeenCalledTimes(1));
    // 后端单选：await 后只剩一个 enabled
    await waitFor(() => expect(screen.getAllByRole("button", { name: ENABLED }).length).toBe(1));
  });

  it("I-06 保存 Key → setAiProviderKey 调用 + toast", async () => {
    await renderLoaded();
    fireEvent.click(btn(EDIT));
    fireEvent.change(screen.queryAllByPlaceholderText(/sk-|API key/i)[0] ?? screen.getByDisplayValue(""), { target: { value: "sk-test-123" } });
    fireEvent.click(screen.getByRole("button", { name: /保存 Key|Save key/i }));
    await waitFor(() => expect(api.setAiProviderKey).toHaveBeenCalledTimes(1));
  });

  it("复制供应商调 createAiProvider 持久化 + 生成副本", async () => {
    await renderLoaded();
    fireEvent.click(btn(DUPLICATE));
    await waitFor(() => expect(api.createAiProvider).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/DeepSeek 副本/i)).toBeInTheDocument());
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("测试连通性调 testAiProvider + toast", async () => {
    await renderLoaded();
    fireEvent.click(btn(TEST_CONN));
    await waitFor(() => expect(api.testAiProvider).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/连通性测试通过/i)).toBeInTheDocument());
  });

  it("删除供应商确认后调 deleteAiProvider", async () => {
    await renderLoaded();
    fireEvent.click(btn("✕"));
    expect(screen.getByText(/确认删除供应商 DeepSeek/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^删除$|^Delete$/ }));
    await waitFor(() => expect(api.deleteAiProvider).toHaveBeenCalledTimes(1));
  });

  it("点击编辑进入详情态展示模型映射", async () => {
    await renderLoaded();
    fireEvent.click(btn(EDIT));
    expect(screen.getByDisplayValue("deepseek-chat")).toBeInTheDocument();
    expect(screen.getByDisplayValue("deepseek-reasoner")).toBeInTheDocument();
  });

  it("详情态新增模型", async () => {
    await renderLoaded();
    fireEvent.click(btn(EDIT));
    const before = screen.getAllByPlaceholderText(REQUEST_MODEL_PH).length;
    fireEvent.click(screen.getByRole("button", { name: ADD_MODEL }));
    expect(screen.getAllByPlaceholderText(REQUEST_MODEL_PH).length).toBe(before + 1);
  });

  it("新增供应商进入详情编辑态", async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: ADD_PROVIDER }));
    expect(screen.getByRole("heading", { name: /新建供应商|New provider/i })).toBeInTheDocument();
  });
});
