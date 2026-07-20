import { z } from "zod";

import { sha256Schema } from "./protocol.js";
import {
  registrySemverSchema,
  registrySlugSchema,
  skillTargetAgentSchema,
  skillVariantStatusSchema
} from "./registry.js";

export const skillComponentRoleSchema = z.enum(["skill", "subagent"]);

export const skillBundlePathSchema = z.string().min(1).refine((value) => {
  if (value === ".") return true;
  return !value.includes("\0") && !value.includes("\\") &&
    !value.startsWith("/") && !/^[A-Za-z]:/.test(value) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}, "path must be a normalized relative POSIX path");

export const skillBundleComponentSchema = z.object({
  role: skillComponentRoleSchema,
  source: skillBundlePathSchema,
  name: registrySlugSchema.optional(),
  variants: z.partialRecord(skillTargetAgentSchema, skillBundlePathSchema).optional()
}).strict().superRefine((component, context) => {
  if (component.role === "skill" && component.variants !== undefined) {
    context.addIssue({ code: "custom", message: "skill components cannot define agent variants" });
  }
  if (component.role === "subagent" &&
      (component.name === undefined || component.variants === undefined ||
       Object.keys(component.variants).length === 0)) {
    context.addIssue({ code: "custom", message: "subagent components require a name and variants" });
  }
}).superRefine((component, context) => {
  if (component.role === "subagent" && component.source !== ".") {
    context.addIssue({ code: "custom", message: "subagent source must be '.'; variants select native files" });
  }
});

export const authorSkillBundleManifestSchema = z.object({
  apiVersion: z.literal("hunter-harness/v1"),
  kind: z.literal("SkillBundle"),
  components: z.array(skillBundleComponentSchema).min(1)
}).strict().superRefine((manifest, context) => {
  if (!manifest.components.some((component) => component.role === "skill")) {
    context.addIssue({ code: "custom", message: "bundle requires a skill component" });
  }
});

export const skillPackageFileSchema = z.object({
  path: skillBundlePathSchema,
  sha256: sha256Schema,
  size: z.number().int().nonnegative()
}).strict();

export const skillPackageVariantSchema = z.object({
  status: skillVariantStatusSchema,
  adapterVersion: z.string().min(1),
  buildHash: sha256Schema.nullable(),
  components: z.array(z.string().min(1))
}).strict();

export const skillPackageManifestV3Schema = z.object({
  schema_version: z.literal(3),
  slug: registrySlugSchema,
  version: registrySemverSchema,
  files: z.array(skillPackageFileSchema),
  components: z.array(skillBundleComponentSchema).min(1),
  variants: z.record(skillTargetAgentSchema, skillPackageVariantSchema)
}).strict();

export type SkillComponentRole = z.infer<typeof skillComponentRoleSchema>;
export type SkillBundleComponent = z.infer<typeof skillBundleComponentSchema>;
export type AuthorSkillBundleManifest = z.infer<typeof authorSkillBundleManifestSchema>;
export type SkillPackageFile = z.infer<typeof skillPackageFileSchema>;
export type SkillPackageVariant = z.infer<typeof skillPackageVariantSchema>;
export type SkillPackageManifestV3 = z.infer<typeof skillPackageManifestV3Schema>;
