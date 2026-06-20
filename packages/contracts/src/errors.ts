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
  "LOCAL_TRANSACTION_RECOVERY_REQUIRED"
]);

export const apiErrorEnvelopeSchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string().min(1),
    request_id: z.uuid(),
    details: z.record(z.string(), z.unknown())
  }).strict()
}).strict();

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
