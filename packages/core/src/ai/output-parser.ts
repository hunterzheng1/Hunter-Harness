import { skillCheckResultSchema, type SkillCheckResult } from "@hunter-harness/contracts";

// 解析 LLM 输出为 SkillCheckResult；失败降级为 AI_PARSE_FAILED yellow（不抛错，保证 draft 可继续）
export function parseAiCheckResult(raw: string): SkillCheckResult {
  try {
    const parsed = JSON.parse(raw);
    const result = skillCheckResultSchema.safeParse(parsed);
    if (result.success) {
      return result.data;
    }
  } catch {
    // fall through to degrade
  }
  return {
    items: [
      {
        id: "AI_PARSE_FAILED",
        label: "AI 分析结果解析失败",
        status: "yellow",
        message: "AI 返回内容无法解析为检查结果，请重试或检查供应商配置",
        filePath: null,
        fixable: false
      }
    ],
    summary: { green: 0, yellow: 1, red: 0 },
    checkedAt: new Date().toISOString()
  };
}
