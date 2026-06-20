import { z } from "zod";

const overlayTargetSchema = z.object({
  enabled: z.boolean(),
  overlay: z.record(z.string(), z.unknown()).optional()
}).strict();

export const skillIrSchema = z.object({
  name: z.string().regex(/^harness-[a-z0-9-]+$/),
  kind: z.enum(["workflow", "tooling", "migration", "governance"]),
  description: z.string().min(1),
  triggers: z.array(z.string().min(1)).min(1),
  inputs: z.array(z.string().min(1)),
  outputs: z.array(z.string().min(1)).min(1),
  forbidden_actions: z.array(z.string().min(1)),
  required_context: z.array(z.string().min(1)),
  profiles: z.record(z.string(), overlayTargetSchema),
  adapters: z.record(z.string(), overlayTargetSchema),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  instructions: z.array(z.string().min(1)).optional(),
  allowed_capabilities: z.array(z.string().min(1)).optional(),
  source_provenance: z.string().optional()
}).strict();

export type SkillIr = z.infer<typeof skillIrSchema>;
