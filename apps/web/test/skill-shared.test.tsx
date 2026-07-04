// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { apiError } from "../components/skill-shared";
import { ApiClientError } from "../lib/api";
import type { useI18n } from "../lib/i18n";

const zhT = {
  error: {
    demoFailed: "明确演示数据失败：",
    apiFailed: "请求失败（{code}）。未显示服务端敏感详情。",
    opFailed: "操作失败，请检查网络和服务端状态。",
    authRequiredSettings: "需要认证，请在设置中配置 token。"
  }
} as unknown as ReturnType<typeof useI18n>["t"];

describe("apiError (U-14)", () => {
  it("attaches redacted ApiClientError message to the base text", () => {
    const error = new ApiClientError(422, "SKILL_VALIDATION_FAILED", "frontmatter 校验失败: 缺少必填字段 name");
    const result = apiError(error, zhT);
    expect(result).toContain("SKILL_VALIDATION_FAILED");
    expect(result).toContain("frontmatter 校验失败");
    expect(result).toContain("缺少必填字段 name");
  });

  it("falls back to opFailed for non-ApiClientError", () => {
    const result = apiError(new Error("random"), zhT);
    expect(result).toBe("操作失败，请检查网络和服务端状态。");
  });

  it("returns authRequiredSettings for 401", () => {
    const error = new ApiClientError(401, "AUTH_REQUIRED", "not authenticated");
    const result = apiError(error, zhT);
    expect(result).toContain("认证");
  });

  it("does not append message when code is HTTP_ERROR", () => {
    const error = new ApiClientError(500, "HTTP_ERROR", "some http failure");
    const result = apiError(error, zhT);
    expect(result).not.toContain("some http failure");
    expect(result).toContain("HTTP_ERROR");
  });
});
