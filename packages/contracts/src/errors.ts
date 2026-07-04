import { z } from "zod";

export const apiErrorCodeSchema = z.enum([
  "VALIDATION_FAILED",
  "INVALID_CURSOR",
  "INVALID_PATH",
  "AUTH_REQUIRED",
  "TOKEN_INVALID",
  "AUTH_FORBIDDEN",
  "PROJECT_BIND_FORBIDDEN",
  "PROJECT_NOT_FOUND",
  "PROPOSAL_NOT_FOUND",
  "ARTIFACT_NOT_FOUND",
  "IDEMPOTENCY_KEY_REUSED",
  "PROJECT_BINDING_CONFLICT",
  "PROJECT_VERSION_CONFLICT",
  "BLOB_NOT_DECLARED",
  "UPLOAD_SESSION_EXPIRED",
  "FILE_TOO_LARGE",
  "PROPOSAL_TOO_LARGE",
  "UPLOAD_CHUNK_HASH_MISMATCH",
  "ARTIFACT_HASH_MISMATCH",
  "POLICY_PATH_FORBIDDEN",
  "SENSITIVE_CONTENT_BLOCKED",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
  "SERVICE_UNAVAILABLE",
  "CONFLICT_LOCAL_DIRTY",
  "LOCAL_LOCKED",
  "LOCAL_TRANSACTION_RECOVERY_REQUIRED",
  "SKILL_VALIDATION_FAILED",
  "SKILL_ENTRY_NOT_FOUND",
  "SKILL_NOT_FOUND",
  "DRAFT_NOT_FOUND",
  "REVISION_CONFLICT",
  "ADAPTER_NOT_INSTALLABLE",
  "WORKFLOW_PACKAGE_REDIRECT"
]);

export const apiErrorEnvelopeSchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string().min(1),
    request_id: z.uuid(),
    details: z.record(z.string(), z.unknown())
  }).strict()
}).strict();

// Skill 相关错误码命名常量（含 wire + 非 wire 码），供各层复用（R2 契约单一来源）。
// wire 码进 apiErrorCodeSchema；非 wire 码（SLUG_INVALID/FRONTMATTER_INVALID）仅本地使用。
export const SKILL_ERROR_CODE = {
  VALIDATION_FAILED: "SKILL_VALIDATION_FAILED",
  ENTRY_NOT_FOUND: "SKILL_ENTRY_NOT_FOUND",
  NOT_FOUND: "SKILL_NOT_FOUND",
  DRAFT_NOT_FOUND: "DRAFT_NOT_FOUND",
  REVISION_CONFLICT: "REVISION_CONFLICT",
  ADAPTER_NOT_INSTALLABLE: "ADAPTER_NOT_INSTALLABLE",
  WORKFLOW_PACKAGE_REDIRECT: "WORKFLOW_PACKAGE_REDIRECT",
  SLUG_INVALID: "SKILL_SLUG_INVALID",
  FRONTMATTER_INVALID: "FRONTMATTER_INVALID"
} as const;

export const cliExitCodeSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
  z.literal(7),
  z.literal(8)
]);

export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;
export type CliExitCode = z.infer<typeof cliExitCodeSchema>;
