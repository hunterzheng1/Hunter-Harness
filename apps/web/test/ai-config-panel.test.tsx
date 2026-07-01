// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AiConfigPanel } from "../components/ai-config-panel";

// UI v2 迭代：单选互斥启用 + toast 反馈 + 用量弹窗 + 详情精简。
// i18n 默认 zh；正则同时匹配中英文以兼容语言切换。
const EDIT = /编辑|Edit/;
const ADD_PROVIDER = /新增供应商|Add provider/;
const ADD_MODEL = /新增模型|Add model/;
const DUPLICATE = /复制|Duplicate/;
const TEST_CONN = /测试连通性|Test connection/;
const USAGE = /^用量$|^Usage$/;
const CANCEL = /取消|Cancel/;
const REQUEST_MODEL_PH = /如 deepseek-chat/i;
const ENABLED = /^已启用$|^Enabled$/;
const DISABLED = /^未启用$|^Disabled$/;

afterEach(cleanup);

function btn(name: RegExp | string): HTMLElement {
  const el = screen.getAllByRole("button", { name })[0];
  if (el === undefined) throw new Error(`button ${String(name)} not found`);
  return el;
}

describe("AiConfigPanel (UI v2 迭代)", () => {
  it("列表态展示示例供应商", () => {
    render(<AiConfigPanel />);
    expect(screen.getByText("DeepSeek")).toBeInTheDocument();
    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
  });

  it("单选互斥：启用 OpenAI 后 DeepSeek 自动关闭", () => {
    render(<AiConfigPanel />);
    expect(screen.getAllByRole("button", { name: ENABLED }).length).toBe(1);
    fireEvent.click(btn(DISABLED)); // 第一个"未启用"= OpenAI
    expect(screen.getAllByRole("button", { name: ENABLED }).length).toBe(1);
    expect(screen.getAllByRole("button", { name: DISABLED }).length).toBe(2);
  });

  it("复制供应商弹 toast 并生成副本", () => {
    render(<AiConfigPanel />);
    fireEvent.click(btn(DUPLICATE));
    expect(screen.getByText(/DeepSeek 副本/i)).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("测试连通性弹 toast", () => {
    render(<AiConfigPanel />);
    fireEvent.click(btn(TEST_CONN));
    expect(screen.getByText(/连通性测试通过/i)).toBeInTheDocument();
  });

  it("用量按钮打开用量弹窗（含按模型/按日期维度）", () => {
    render(<AiConfigPanel />);
    fireEvent.click(btn(USAGE));
    expect(screen.getByRole("heading", { name: /DeepSeek.*使用统计/i })).toBeInTheDocument();
    expect(screen.getByText(/^按模型$|^By model$/)).toBeInTheDocument();
    expect(screen.getByText(/按日期/i)).toBeInTheDocument();
  });

  it("删除供应商确认后从列表移除", () => {
    render(<AiConfigPanel />);
    expect(screen.getByText("DeepSeek")).toBeInTheDocument();
    fireEvent.click(btn("✕"));
    expect(screen.getByText(/确认删除供应商 DeepSeek/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^删除$|^Delete$/ }));
    expect(screen.queryByText("DeepSeek")).not.toBeInTheDocument();
  });

  it("点击编辑进入详情态展示模型映射", () => {
    render(<AiConfigPanel />);
    fireEvent.click(btn(EDIT));
    expect(screen.getByDisplayValue("deepseek-chat")).toBeInTheDocument();
    expect(screen.getByDisplayValue("deepseek-reasoner")).toBeInTheDocument();
  });

  it("详情态新增模型", () => {
    render(<AiConfigPanel />);
    fireEvent.click(btn(EDIT));
    const before = screen.getAllByPlaceholderText(REQUEST_MODEL_PH).length;
    fireEvent.click(screen.getByRole("button", { name: ADD_MODEL }));
    expect(screen.getAllByPlaceholderText(REQUEST_MODEL_PH).length).toBe(before + 1);
  });

  it("详情态删除模型", () => {
    render(<AiConfigPanel />);
    fireEvent.click(btn(EDIT));
    const before = screen.getAllByPlaceholderText(REQUEST_MODEL_PH).length;
    fireEvent.click(btn(/^删除$|^Delete$/)); // 详情态模型删除按钮带 aria-label="删除"
    expect(screen.getAllByPlaceholderText(REQUEST_MODEL_PH).length).toBe(before - 1);
  });

  it("新增供应商进入详情编辑态", () => {
    render(<AiConfigPanel />);
    fireEvent.click(screen.getByRole("button", { name: ADD_PROVIDER }));
    expect(screen.getByRole("heading", { name: /新建供应商|New provider/i })).toBeInTheDocument();
  });

  it("详情态取消返回列表态", () => {
    render(<AiConfigPanel />);
    fireEvent.click(btn(EDIT));
    fireEvent.click(screen.getByRole("button", { name: CANCEL }));
    expect(screen.getAllByRole("button", { name: EDIT }).length).toBe(3);
  });

  it("拖拽手柄换序", () => {
    const { container } = render(<AiConfigPanel />);
    const handle = container.querySelectorAll(".drag-handle")[0];
    const targetRow = container.querySelectorAll(".provider-row")[1];
    if (handle === undefined || targetRow === undefined) throw new Error("missing drag rows");
    fireEvent.dragStart(handle);
    fireEvent.dragOver(targetRow);
    fireEvent.drop(targetRow);
    const firstRow = container.querySelector(".provider-row");
    // DeepSeek(0) 拖到 OpenAI(1) 位置 → [OpenAI, DeepSeek, Anthropic]
    expect(firstRow?.querySelector("strong")?.textContent).toBe("OpenAI");
  });
});
