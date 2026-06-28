import { z } from "zod";

import { skillDiffFileSchema } from "./registry.js";

export const fixActionSchema = z.enum(["auto", "confirm", "suggest"]);

export const fixPlanItemSchema = z.object({
  checkId: z.string(),
  action: fixActionSchema,
  label: z.string(),
  affectedPaths: z.array(z.string()),
  riskDelta: z.string().nullable(),
  message: z.string(),
  // AI 内容生成切片：fix-suggestions 端点填充（fixer.buildFixPatch 填的 item 不带，向后兼容）
  suggestedContent: z.string().nullable().optional(),
  explanation: z.string().nullable().optional(),
  appliesTo: z.enum(["examples", "allowed_capabilities", "instructions", "description", "tags"]).nullable().optional(),
  generatedAt: z.string().nullable().optional()
}).strict();

export const fixPlanSchema = z.object({
  items: z.array(fixPlanItemSchema),
  mergedFiles: z.array(skillDiffFileSchema),
  summary: z.object({
    autoCount: z.number().int(),
    confirmCount: z.number().int(),
    suggestCount: z.number().int(),
    changedFiles: z.number().int(),
    changedLines: z.number().int()
  })
}).strict();

export type FixAction = z.infer<typeof fixActionSchema>;
export type FixPlanItem = z.infer<typeof fixPlanItemSchema>;
export type FixPlan = z.infer<typeof fixPlanSchema>;
