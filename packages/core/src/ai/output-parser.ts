import { skillCheckResultSchema, type SkillCheckResult } from "@hunter-harness/contracts";

// 解析 LLM 输出为 SkillCheckResult；失败降级为 AI_PARSE_FAILED yellow（不抛错，保证 draft 可继续）
export function parseAiCheckResult(raw: string): SkillCheckResult {
  const fallbackCheckedAt = new Date().toISOString();
  try {
    const text = stripMarkdownFence(raw);
    const jsonText = extractJsonObject(text);
    if (jsonText !== null) {
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;
      // LLM 可能漏 checkedAt 或加额外字段；schema 已 .strip() 容错多余字段，checkedAt 缺则补当前时间
      const candidate = {
        ...parsed,
        checkedAt: typeof parsed.checkedAt === "string" ? parsed.checkedAt : fallbackCheckedAt
      };
      const result = skillCheckResultSchema.safeParse(candidate);
      if (result.success) {
        return result.data;
      }
    }
  } catch {
    // fall through to degrade
  }
  return degrade(fallbackCheckedAt);
}

// 剥离 LLM 常见的 markdown 围栏（```json ... ``` 或 ``` ... ```）
function stripMarkdownFence(raw: string): string {
  const trimmed = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fence === null ? trimmed : fence[1] ?? "";
}

// 从可能含前导/尾随说明文字的输出中提取第一个完整 JSON 对象（按花括号深度 + 字符串字面量计数）
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  let i = -1;
  for (const ch of text) {
    i++;
    if (i < start) continue;
    if (inStr) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inStr = false;
      }
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

function degrade(checkedAt: string): SkillCheckResult {
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
    checkedAt
  };
}
