import { z } from "zod";

import type {
  knowledgeExtractionRetryIntentSchema,
  platformInformationViewSchema,
} from "./platform-information.js";
import {
  restoreBranchFilesConfirmationIntentSchema,
  restoreBranchFilesIntentSchema,
  restoreBranchFilesPreviewReceiptSchema,
  validateBranchFilesPullConfirmation,
} from "./platform-information.js";

const cursorSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{16,512}$/u)
  .nullable();
const projectIdSchema = z.string().regex(/^prj_[A-Za-z0-9_-]{1,156}$/u);
const idSchema = z.string().min(1).max(160);
const hashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

export const platformInformationProjectKeyScopeSchema = z.enum([
  "platform:read",
  "files:read",
  "knowledge:read",
  "knowledge:write",
]);

/** Public query fields only. Actor, project allowlist, view policy and sort are injected by Server authority. */
export const platformInformationListHttpQuerySchema = z
  .object({
    limit: z.number().int().min(1).max(100).default(50),
    cursor: cursorSchema.default(null),
  })
  .strict();

/** Body for the durable export command.  The view and project are path-bound. */
export const platformInformationExportCreateHttpRequestSchema =
  platformInformationListHttpQuerySchema;

export type PlatformInformationListHttpQueryNormalizationResult =
  | { ok: true; value: z.infer<typeof platformInformationListHttpQuerySchema> }
  | { ok: false; reason_code: "PLATFORM_INFORMATION_HTTP_QUERY_INVALID" };

/** Normalizes Fastify's validated query object into the canonical list input. */
export function normalizePlatformInformationListHttpQuery(
  input: unknown,
): PlatformInformationListHttpQueryNormalizationResult {
  const parsed = platformInformationListHttpQuerySchema.safeParse(input);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason_code: "PLATFORM_INFORMATION_HTTP_QUERY_INVALID" };
}

export const platformInformationPreviewRestoreHttpRequestSchema =
  restoreBranchFilesIntentSchema;

export const platformInformationConfirmRestoreHttpRequestSchema = z
  .object({
    preview_receipt: restoreBranchFilesPreviewReceiptSchema,
    confirmation_intent: restoreBranchFilesConfirmationIntentSchema,
  })
  .strict();

export const platformInformationRetryExtractionHttpRequestSchema = z
  .object({
    job_id: z.string().regex(/^job_knowledge_[A-Za-z0-9._:-]{1,146}$/u),
    expected_generation: z.number().int().nonnegative(),
  })
  .strict();

export const restoreBranchFilesConfirmedIntentSchema = z
  .object({
    schema_version: z.literal(1),
    contract_kind: z.literal("branch_files_pull_confirmed_intent"),
    project_id: projectIdSchema,
    source_ref: restoreBranchFilesPreviewReceiptSchema.shape.source_ref,
    source_version: restoreBranchFilesPreviewReceiptSchema.shape.source_version,
    scopes: z.tuple([z.literal("branch_files")]),
    selected_paths: restoreBranchFilesPreviewReceiptSchema.shape.selected_paths,
    preview_hash: hashSchema,
    idempotency_key: idSchema,
    conflict_decisions:
      restoreBranchFilesConfirmationIntentSchema.shape.conflict_decisions,
    request_only: z.literal(true),
  })
  .strict();

export type PlatformInformationConfirmRestoreValidationResult =
  | { ok: true; value: z.infer<typeof restoreBranchFilesConfirmedIntentSchema> }
  | { ok: false; reason_code: "BRANCH_FILES_PULL_CONFIRMATION_INVALID" | "BRANCH_FILES_PULL_CONFIRMATION_MISMATCH" };

/** The sole semantic entrypoint for HTTP confirmation bodies. */
export function validatePlatformInformationConfirmRestoreHttpRequest(
  serialized: unknown,
  expected: { readonly project_id: string; readonly client_id: string },
): PlatformInformationConfirmRestoreValidationResult {
  if (typeof serialized !== "string" || serialized.length > 4_000_000 ||
      !projectIdSchema.safeParse(expected.project_id).success ||
      !idSchema.safeParse(expected.client_id).success) {
    return { ok: false, reason_code: "BRANCH_FILES_PULL_CONFIRMATION_INVALID" };
  }
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(serialized) as unknown;
  } catch {
    return { ok: false, reason_code: "BRANCH_FILES_PULL_CONFIRMATION_INVALID" };
  }
  const body = platformInformationConfirmRestoreHttpRequestSchema.safeParse(parsedValue);
  if (!body.success) {
    return { ok: false, reason_code: "BRANCH_FILES_PULL_CONFIRMATION_INVALID" };
  }
  const semantic = validateBranchFilesPullConfirmation(
    JSON.stringify(body.data.preview_receipt),
    JSON.stringify(body.data.confirmation_intent),
  );
  if (!semantic.ok || semantic.preview.project_id !== expected.project_id ||
      semantic.preview.source_ref.client_id !== expected.client_id) {
    return { ok: false, reason_code: semantic.ok
      ? "BRANCH_FILES_PULL_CONFIRMATION_MISMATCH"
      : semantic.reason_code };
  }
  const candidate = restoreBranchFilesConfirmedIntentSchema.safeParse({
    schema_version: 1,
    contract_kind: "branch_files_pull_confirmed_intent",
    project_id: semantic.preview.project_id,
    source_ref: semantic.preview.source_ref,
    source_version: semantic.preview.source_version,
    scopes: semantic.preview.scopes,
    selected_paths: semantic.preview.selected_paths,
    preview_hash: semantic.preview.preview_hash,
    idempotency_key: semantic.confirmation.idempotency_key,
    conflict_decisions: semantic.confirmation.conflict_decisions,
    request_only: true,
  });
  return candidate.success
    ? { ok: true, value: candidate.data }
    : { ok: false, reason_code: "BRANCH_FILES_PULL_CONFIRMATION_INVALID" };
}

export const platformInformationHttpErrorCodeSchema = z.enum([
  "AUTH_REQUIRED",
  "TOKEN_INVALID",
  "SESSION_INVALID",
  "VALIDATION_FAILED",
  "PLATFORM_INFORMATION_CURSOR_INVALID",
  "PROJECT_INFORMATION_FORBIDDEN",
  "PROJECT_KEY_SCOPE",
  "PROJECT_KEY_MISMATCH",
  "PLATFORM_INFORMATION_DETAIL_NOT_FOUND",
  "KNOWLEDGE_EXTRACTION_JOB_NOT_FOUND",
  "BRANCH_FILES_PULL_CONFIRMATION_MISMATCH",
  "KNOWLEDGE_EXTRACTION_GENERATION_CONFLICT",
  "PLATFORM_INFORMATION_SOURCE_INVALID",
  "BRANCH_FILES_RESTORE_PREVIEW_INVALID",
  "BRANCH_FILES_PULL_CONFIRMATION_INVALID",
  "KNOWLEDGE_EXTRACTION_RETRY_REQUEST_INVALID",
  "KNOWLEDGE_EXTRACTION_RETRY_INTENT_INVALID",
  "KNOWLEDGE_EXTRACTION_RETRY_AUTHORITY_INVALID",
  "PLATFORM_INFORMATION_UNAVAILABLE",
  "PLATFORM_INFORMATION_EXPORT_UNAVAILABLE",
  "PLATFORM_INFORMATION_EXPORT_IDEMPOTENCY_REQUIRED",
  "PLATFORM_INFORMATION_EXPORT_IDEMPOTENCY_CONFLICT",
  "PLATFORM_INFORMATION_EXPORT_EXPIRED",
  "PLATFORM_INFORMATION_EXPORT_NOT_FOUND",
  "PLATFORM_INFORMATION_EXPORT_DOWNLOAD_UNAVAILABLE",
  "PLATFORM_INFORMATION_EXPORT_SOURCE_INVALID",
]);

const unauthorized = Object.freeze(["AUTH_REQUIRED", "TOKEN_INVALID", "SESSION_INVALID"] as const);
const forbidden = Object.freeze(["PROJECT_INFORMATION_FORBIDDEN", "PROJECT_KEY_SCOPE", "PROJECT_KEY_MISMATCH"] as const);
const listErrors = Object.freeze({
  400: Object.freeze(["VALIDATION_FAILED", "PLATFORM_INFORMATION_CURSOR_INVALID"] as const),
  401: unauthorized, 403: forbidden,
  503: Object.freeze(["PLATFORM_INFORMATION_SOURCE_INVALID", "PLATFORM_INFORMATION_UNAVAILABLE"] as const),
});
const exportErrors = Object.freeze({
  400: Object.freeze(["VALIDATION_FAILED", "PLATFORM_INFORMATION_CURSOR_INVALID"] as const),
  401: unauthorized, 403: forbidden,
  503: Object.freeze(["PLATFORM_INFORMATION_SOURCE_INVALID", "PLATFORM_INFORMATION_UNAVAILABLE"] as const),
});
const exportCreateErrors = Object.freeze({
  400: Object.freeze(["VALIDATION_FAILED"] as const),
  401: unauthorized, 403: forbidden,
  409: Object.freeze(["PLATFORM_INFORMATION_EXPORT_IDEMPOTENCY_CONFLICT"] as const),
  410: Object.freeze(["PLATFORM_INFORMATION_EXPORT_EXPIRED"] as const),
  422: Object.freeze(["PLATFORM_INFORMATION_EXPORT_IDEMPOTENCY_REQUIRED"] as const),
  503: Object.freeze(["PLATFORM_INFORMATION_EXPORT_SOURCE_INVALID", "PLATFORM_INFORMATION_EXPORT_UNAVAILABLE"] as const),
});
const exportDownloadErrors = Object.freeze({
  400: Object.freeze(["VALIDATION_FAILED"] as const),
  401: unauthorized, 403: forbidden,
  404: Object.freeze(["PLATFORM_INFORMATION_EXPORT_NOT_FOUND"] as const),
  410: Object.freeze(["PLATFORM_INFORMATION_EXPORT_EXPIRED"] as const),
  503: Object.freeze(["PLATFORM_INFORMATION_EXPORT_DOWNLOAD_UNAVAILABLE"] as const),
});
const detailErrors = Object.freeze({
  400: Object.freeze(["VALIDATION_FAILED"] as const), 401: unauthorized, 403: forbidden,
  404: Object.freeze(["PLATFORM_INFORMATION_DETAIL_NOT_FOUND"] as const),
  503: Object.freeze(["PLATFORM_INFORMATION_SOURCE_INVALID", "PLATFORM_INFORMATION_UNAVAILABLE"] as const),
});
const previewErrors = Object.freeze({
  400: Object.freeze(["VALIDATION_FAILED"] as const), 401: unauthorized, 403: forbidden,
  422: Object.freeze(["BRANCH_FILES_RESTORE_PREVIEW_INVALID"] as const),
  503: Object.freeze(["PLATFORM_INFORMATION_SOURCE_INVALID", "PLATFORM_INFORMATION_UNAVAILABLE"] as const),
});
const confirmErrors = Object.freeze({
  400: Object.freeze(["VALIDATION_FAILED"] as const), 401: unauthorized, 403: forbidden,
  409: Object.freeze(["BRANCH_FILES_PULL_CONFIRMATION_MISMATCH"] as const),
  422: Object.freeze(["BRANCH_FILES_PULL_CONFIRMATION_INVALID"] as const),
});
const retryErrors = Object.freeze({
  400: Object.freeze(["VALIDATION_FAILED"] as const), 401: unauthorized, 403: forbidden,
  404: Object.freeze(["KNOWLEDGE_EXTRACTION_JOB_NOT_FOUND"] as const),
  409: Object.freeze(["KNOWLEDGE_EXTRACTION_GENERATION_CONFLICT"] as const),
  422: Object.freeze(["KNOWLEDGE_EXTRACTION_RETRY_REQUEST_INVALID"] as const),
  503: Object.freeze(["KNOWLEDGE_EXTRACTION_RETRY_INTENT_INVALID", "KNOWLEDGE_EXTRACTION_RETRY_AUTHORITY_INVALID", "PLATFORM_INFORMATION_UNAVAILABLE"] as const),
});

const listAuth = Object.freeze({
  actor_source: "authenticated_principal" as const,
  project_allowlist_source: "server_authority" as const,
  project_key_scope_by_view: Object.freeze({
    branch_monitor: "platform:read" as const,
    branch_files: "files:read" as const,
    project_materials: "files:read" as const,
    project_knowledge: "knowledge:read" as const,
    change_records: "files:read" as const,
    version_records: "files:read" as const,
  }) satisfies Readonly<
    Record<
      z.infer<typeof platformInformationViewSchema>,
      "files:read" | "knowledge:read" | "platform:read"
    >
  >,
});

function operation<const T extends object>(
  value: T,
  operationErrors: Readonly<Record<number, readonly string[]>>,
): Readonly<T & { request_id_header: "X-Request-Id"; errors: typeof operationErrors }> {
  return Object.freeze({
    ...value,
    request_id_header: "X-Request-Id" as const,
    errors: operationErrors,
  });
}

/** Shared source of truth for Server registration and Web client generation. */
export const PLATFORM_INFORMATION_HTTP_OPERATIONS = Object.freeze({
  list: operation({
    method: "GET" as const,
    path: "/api/v1/projects/{project_id}/information/{view}" as const,
    operation_id: "listPlatformInformation" as const,
    request_placement: "path_and_query" as const,
    auth: listAuth,
    request_schema: "PlatformInformationListHttpQuery" as const,
    normalizer_id: "normalizePlatformInformationListHttpQuery" as const,
    success_status: 200 as const,
    success_schema: "PlatformInformationPage" as const,
  }, listErrors),
  export_all: operation({
    method: "GET" as const,
    path: "/api/v1/projects/{project_id}/information/{view}:export-all" as const,
    fastify_path: "/api/v1/projects/:projectId/information/:view([a-z_]+):export-all" as const,
    operation_id: "exportAllPlatformInformation" as const,
    request_placement: "path_and_query" as const,
    auth: Object.freeze({
      actor_source: "authenticated_principal" as const,
      project_allowlist_source: "server_authority" as const,
      project_key_scope: "platform:read" as const,
    }),
    request_schema: "PlatformInformationListHttpQuery" as const,
    normalizer_id: "normalizePlatformInformationListHttpQuery" as const,
    success_status: 200 as const,
    success_schema: "PlatformInformationExportResult" as const,
  }, exportErrors),
  create_export: operation({
    method: "POST" as const,
    path: "/api/v1/projects/{project_id}/information/{view}:export" as const,
    fastify_path: "/api/v1/projects/:projectId/information/:view([a-z_]+):export" as const,
    operation_id: "createPlatformInformationExport" as const,
    request_placement: "path_and_json_body" as const,
    auth: Object.freeze({
      actor_source: "authenticated_principal" as const,
      project_allowlist_source: "server_authority" as const,
      project_key_scope_by_view: listAuth.project_key_scope_by_view,
    }),
    request_schema: "PlatformInformationExportCreateHttpRequest" as const,
    idempotency_header: "Idempotency-Key" as const,
    success_status: 201 as const,
    replay_status: 200 as const,
    success_schema: "PlatformInformationExportArtifactReceipt" as const,
  }, exportCreateErrors),
  download_export: operation({
    method: "GET" as const,
    path: "/api/v1/projects/{project_id}/information/{view}/exports/{export_id}" as const,
    fastify_path: "/api/v1/projects/:projectId/information/:view([a-z_]+)/exports/:exportId" as const,
    operation_id: "downloadPlatformInformationExport" as const,
    request_placement: "path_only" as const,
    auth: Object.freeze({
      actor_source: "authenticated_principal" as const,
      project_allowlist_source: "server_authority" as const,
      project_key_scope_by_view: listAuth.project_key_scope_by_view,
    }),
    request_schema: null,
    success_status: 200 as const,
    success_media_type: "application/x-ndjson" as const,
    success_schema: null,
    success_headers: Object.freeze({
      content_sha256: "X-Content-SHA256" as const,
      content_disposition: "Content-Disposition" as const,
    }),
  }, exportDownloadErrors),
  detail: operation({
    method: "GET" as const,
    path: "/api/v1/projects/{project_id}/information/{view}/{detail_id}" as const,
    operation_id: "getPlatformInformationDetail" as const,
    request_placement: "path_only" as const,
    auth: listAuth,
    request_schema: null,
    success_status: 200 as const,
    success_schema: "PlatformInformationDetailResponse" as const,
  }, detailErrors),
  preview_restore: operation({
    method: "POST" as const,
    path: "/api/v1/projects/{project_id}/information/branch-files:preview-restore" as const,
    fastify_path: "/api/v1/projects/:projectId/information/branch-files::preview-restore" as const,
    operation_id: "previewBranchFilesRestore" as const,
    request_placement: "path_and_json_body" as const,
    auth: Object.freeze({
      actor_source: "authenticated_principal" as const,
      project_allowlist_source: "server_authority" as const,
      project_key_scope: "files:read" as const,
    }),
    request_schema: "RestoreBranchFilesIntent" as const,
    success_status: 200 as const,
    success_schema: "RestoreBranchFilesPreviewReceipt" as const,
  }, previewErrors),
  confirm_restore: operation({
    method: "POST" as const,
    path: "/api/v1/projects/{project_id}/information/branch-files:confirm-restore" as const,
    fastify_path: "/api/v1/projects/:projectId/information/branch-files::confirm-restore" as const,
    operation_id: "confirmBranchFilesRestore" as const,
    request_placement: "path_and_json_body" as const,
    auth: Object.freeze({
      actor_source: "authenticated_principal" as const,
      project_allowlist_source: "server_authority" as const,
      project_key_scope: "files:read" as const,
    }),
    request_schema: "PlatformInformationConfirmRestoreHttpRequest" as const,
    validator_id: "validatePlatformInformationConfirmRestoreHttpRequest" as const,
    success_status: 200 as const,
    success_schema: "RestoreBranchFilesConfirmedIntent" as const,
  }, confirmErrors),
  retry_extraction: operation({
    method: "POST" as const,
    path: "/api/v1/projects/{project_id}/information/knowledge:retry-extraction" as const,
    fastify_path: "/api/v1/projects/:projectId/information/knowledge::retry-extraction" as const,
    operation_id: "retryProjectKnowledgeExtraction" as const,
    request_placement: "path_and_json_body" as const,
    auth: Object.freeze({
      actor_source: "authenticated_principal" as const,
      project_allowlist_source: "server_authority" as const,
      project_key_scope: "knowledge:write" as const,
    }),
    request_schema: "PlatformInformationRetryExtractionHttpRequest" as const,
    success_status: 200 as const,
    success_schema: "KnowledgeExtractionRetryIntent" as const,
  }, retryErrors),
});

export type PlatformInformationListHttpQuery = z.infer<
  typeof platformInformationListHttpQuerySchema
>;
export type PlatformInformationConfirmRestoreHttpRequest = z.infer<
  typeof platformInformationConfirmRestoreHttpRequestSchema
>;
export type PlatformInformationRetryExtractionHttpRequest = z.infer<
  typeof platformInformationRetryExtractionHttpRequestSchema
>;
export type RestoreBranchFilesConfirmedIntent = z.infer<
  typeof restoreBranchFilesConfirmedIntentSchema
>;
export type KnowledgeExtractionRetryHttpResponse = z.infer<
  typeof knowledgeExtractionRetryIntentSchema
>;
