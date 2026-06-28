import { z } from "zod";

import { skillDiffFileSchema } from "./registry.js";

export const fixActionSchema = z.enum(["auto", "confirm", "suggest"]);

export const fixPlanItemSchema = z.object({
  checkId: z.string(),
  action: fixActionSchema,
  label: z.string(),
  affectedPaths: z.array(z.string()),
  riskDelta: z.string().nullable(),
  message: z.string()
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
