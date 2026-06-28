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

// #1 AI 生成发布变更信息：解析 LLM 纯文本 release note；空/失败返回 null（路由层据 null 降级，不抛错）
export function parseReleaseNote(raw: string): string | null {
  const trimmed = raw.trim();
  // 剥离任意语言标识的 markdown 围栏（```lang ... ``` 或 ``` ... ```）；stripMarkdownFence 只剥 json，release note 是纯文本需剥任意 lang
  const fence = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const text = (fence === null ? trimmed : (fence[1] ?? "")).trim();
  return text.length === 0 ? null : text;
}

// #2 appliesTo 白名单（与 contracts/src/fix.ts fixPlanItemSchema.appliesTo 对齐）
const FIX_APPLIES_TO_WHITELIST = ["examples", "allowed_capabilities", "instructions", "description", "tags"] as const;

export type FixAppliesTo = (typeof FIX_APPLIES_TO_WHITELIST)[number];

export interface FixSuggestionParse {
  suggestedContent: string;
  explanation: string;
  appliesTo: FixAppliesTo | null;
}

// #2 AI 生成修复内容：解析 LLM JSON {suggestedContent,explanation,appliesTo}；appliesTo 非白名单归 null；失败返回 null（路由层降级回退 message-only）
export function parseFixSuggestionResult(raw: string): FixSuggestionParse | null {
  try {
    const text = stripMarkdownFence(raw);
    const jsonText = extractJsonObject(text);
    if (jsonText === null) return null;
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    if (typeof parsed.suggestedContent !== "string" || typeof parsed.explanation !== "string") return null;
    const appliesTo = typeof parsed.appliesTo === "string" && (FIX_APPLIES_TO_WHITELIST as readonly string[]).includes(parsed.appliesTo)
      ? (parsed.appliesTo as FixAppliesTo)
      : null;
    return { suggestedContent: parsed.suggestedContent, explanation: parsed.explanation, appliesTo };
  } catch {
    return null;
  }
}
