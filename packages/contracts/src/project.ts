import { z } from "zod";

const serverUrlSchema = z.string()
  .min(1)
  .max(2048)
  .refine((value) => {
    if (!/^https?:\/\//.test(value)) return false;
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:" || parsed.protocol === "http:";
    } catch {
      return false;
    }
  }, "server_url must be an http(s) URL")
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return !parsed.username && !parsed.password;
    } catch {
      return false;
    }
  }, "server_url must not embed credentials");

export function isAllowedServerUrl(url: string, allowHttp = false): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return true;
    if (!allowHttp || parsed.protocol !== "http:") return false;
    return ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

const tokenEnvSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Z][A-Z0-9_]*$/, "token_env must be an uppercase env var name");

const projectIdSchema = z.string().min(1).max(128);

// v1.0: fixed projection (`.agents/skills` + `AGENTS.md` canonical, `.codebuddy/skills`
// derived) — the 0.x agent/profile/surface selection fields no longer exist. Legacy
// config files are accepted after stripping the retired keys (callers surface a
// deprecation warning listing `stripped`).
export const LEGACY_INIT_CONFIG_FIELDS = ["agents", "profile", "codebuddy_surface"] as const;
export const LEGACY_PROJECT_CONFIG_FIELDS = ["adapters", "adapter_options"] as const;
export const LEGACY_PROJECT_CONFIG_PROJECT_FIELDS = ["profiles"] as const;

export interface LegacyConfigStripResult {
  value: unknown;
  stripped: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Remove retired 0.x config keys before strict parsing (soft landing for old projects). */
export function stripLegacyConfigFields(value: unknown): LegacyConfigStripResult {
  if (!isPlainObject(value)) return { value, stripped: [] };
  const stripped: string[] = [];
  const legacyTopLevel = new Set<string>([...LEGACY_INIT_CONFIG_FIELDS, ...LEGACY_PROJECT_CONFIG_FIELDS]);
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (legacyTopLevel.has(key)) {
      stripped.push(key);
      continue;
    }
    out[key] = entry;
  }
  if (isPlainObject(out.project)) {
    const legacyProjectKeys = new Set<string>(LEGACY_PROJECT_CONFIG_PROJECT_FIELDS);
    const project: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(out.project)) {
      if (legacyProjectKeys.has(key)) {
        stripped.push(`project.${key}`);
        continue;
      }
      project[key] = entry;
    }
    out.project = project;
  }
  return { value: out, stripped };
}

export const initConfigSchema = z.object({
  server_url: serverUrlSchema.nullable().optional(),
  token_env: tokenEnvSchema.nullable().optional(),
  project_id: projectIdSchema.nullable().optional(),
  features: z.object({
    codegraph_check: z.boolean().optional(),
    superpowers_check: z.boolean().optional()
  }).strict().optional()
}).strict();

export const projectConfigSchema = z.object({
  harness: z.object({
    name: z.literal("hunter-harness"),
    schema_version: z.literal(1)
  }).strict(),
  project: z.object({
    name: z.string().min(1).max(128),
    root: z.literal("."),
    local_project_key: z.uuid(),
    project_id: projectIdSchema.nullable()
  }).strict(),
  server: z.object({
    url: serverUrlSchema.nullable(),
    token_env: tokenEnvSchema
  }).strict()
}).strict();

export type InitConfig = z.infer<typeof initConfigSchema>;
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
