import { z } from "zod";

const projectIdSchema = z.string().regex(/^prj_[A-Za-z0-9_-]+$/);
const tokenEnvSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
const httpsUrlSchema = z.url().refine(
  (value) => new URL(value).protocol === "https:",
  "server URL must use HTTPS"
);

export const adapterNameSchema = z.enum([
  "claude-code",
  "codex",
  "generic",
  "mcp"
]);

export const initConfigSchema = z.object({
  adapter: adapterNameSchema,
  profile: z.string().min(1).regex(/^[a-z][a-z0-9-]*$/),
  server_url: httpsUrlSchema.nullable().optional(),
  token_env: tokenEnvSchema.nullable().optional(),
  project_id: projectIdSchema.nullable().optional(),
  features: z.object({
    codegraph_check: z.boolean().default(true),
    superpowers_check: z.boolean().default(true)
  }).strict().optional()
}).strict();

export const projectConfigSchema = z.object({
  harness: z.object({
    name: z.literal("hunter-harness"),
    schema_version: z.literal(1)
  }).strict(),
  project: z.object({
    name: z.string().min(1),
    root: z.literal("."),
    local_project_key: z.uuid(),
    project_id: projectIdSchema.nullable(),
    profiles: z.array(z.string().min(1)).min(1)
  }).strict(),
  server: z.object({
    url: httpsUrlSchema.nullable(),
    token_env: tokenEnvSchema
  }).strict(),
  adapters: z.object({
    enabled: z.array(adapterNameSchema).min(1)
  }).strict()
}).strict();

export type InitConfig = z.infer<typeof initConfigSchema>;
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
