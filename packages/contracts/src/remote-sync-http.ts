import { z } from "zod";

import {
  remoteSyncContentChunkSchema,
  remoteSyncIdempotencyOutcomeSchema,
  remoteSyncLeaseSchema,
  remoteSyncOperationSchema,
  remoteSyncPreparedPushSchema,
  remoteSyncPullReceiptSchema,
  remoteSyncPullRequestSchema,
  remoteSyncPushCommitSchema,
  remoteSyncPushStatusQuerySchema,
  remoteSyncPushStatusSchema,
  remoteSyncRemoteFileMetadataSchema,
  remoteSyncRemoteSnapshotSchema,
  remoteSyncSourceRefSchema
} from "./content-sync.js";
import { remoteContentUploadHttpRefSchema } from "./remote-content-upload-http.js";

/** HTTP v1 keeps the same server-authority model as the other project APIs. */
const remoteSyncHttpScopeValues = ["files:read", "files:write"] as const;
export const remoteSyncHttpScopeSchema = z.enum(remoteSyncHttpScopeValues);

export const remoteSyncHttpAuthSchema = z.object({
  actor_source: z.literal("authenticated_principal"),
  project_allowlist_source: z.literal("server_authority"),
  project_key_scope: remoteSyncHttpScopeSchema
}).strict();

export const remoteSyncHttpRequestIdSchema = z.uuid();
export const remoteSyncHttpIdempotencyKeySchema = z.string()
  .min(1)
  .max(240)
  // Header values are deliberately printable ASCII so a key cannot smuggle
  // a second header or a line break through a transport adapter.
  .regex(/^[\x21-\x7e]+$/u);

export const remoteSyncHttpRequestIdHeaderSchema = z.literal("X-Request-Id");
export const remoteSyncHttpIdempotencyHeaderSchema = z.literal("Idempotency-Key");
export const remoteSyncHttpRequestHeadersSchema = z.object({
  "X-Request-Id": remoteSyncHttpRequestIdSchema.optional(),
  "Idempotency-Key": remoteSyncHttpIdempotencyKeySchema.optional()
}).strict();
/** Alias used by adapters that model all HTTP headers under the shorter name. */
export const remoteSyncHttpHeadersSchema = remoteSyncHttpRequestHeadersSchema;

const remoteSyncHttpErrorCodeValues = [
  "AUTH_REQUIRED",
  "TOKEN_INVALID",
  "SESSION_INVALID",
  "VALIDATION_FAILED",
  "PROJECT_INFORMATION_FORBIDDEN",
  "PROJECT_KEY_SCOPE",
  "PROJECT_KEY_MISMATCH",
  "REMOTE_UNAVAILABLE",
  "ARCHIVE_HASH_MISMATCH",
  "ARCHIVE_PACKAGE_INVALID",
  "ARCHIVE_PACKAGE_CONFLICT",
  "ARCHIVE_RECEIPT_MISMATCH",
  "SYNC_CONFLICT_DECISION_REQUIRED",
  "SYNC_CONFLICT_DECISION_INVALID",
  "SYNC_LEGACY_FIXTURE_INVALID",
  "SYNC_LOCK_UNAVAILABLE",
  "SYNC_CONTENT_INVALID",
  "SYNC_PATH_NOT_ELIGIBLE",
  "SYNC_PATH_COLLISION",
  "SYNC_PAGE_LIMIT_INVALID",
  "SYNC_CURSOR_INVALID",
  "SYNC_SNAPSHOT_NOT_FOUND",
  "SYNC_PREVIEW_HASH_MISMATCH",
  "SYNC_PREVIEW_STALE",
  "SYNC_RESTORE_SOURCE_REQUIRED",
  "SYNC_SENSITIVE_CONTENT_BLOCKED",
  "SYNC_LEASE_INVALID",
  "SYNC_LEASE_EXPIRED",
  "SYNC_LEASE_FENCED",
  "SYNC_LEASE_SCOPE_MISMATCH",
  "SYNC_LEASE_BUSY",
  "SYNC_PREPARE_NOT_FOUND",
  "SYNC_PREPARE_EXPIRED",
  "SYNC_COMMIT_AMBIGUOUS",
  "SYNC_STREAM_INVALID",
  "SYNC_STREAM_TOO_LARGE",
  "SYNC_STREAM_ABORTED",
  "SYNC_PULL_WORKSPACE_FAILED",
  "SYNC_IDEMPOTENCY_CONFLICT"
] as const;

export const remoteSyncHttpErrorCodeSchema = z.enum(remoteSyncHttpErrorCodeValues);
export type RemoteSyncHttpErrorCode = z.infer<typeof remoteSyncHttpErrorCodeSchema>;

const remoteSyncHttpErrorDetailsSchema = z.record(
  z.string().min(1).max(64),
  z.unknown()
);

export const remoteSyncHttpErrorEnvelopeSchema = z.object({
  error: z.object({
    code: remoteSyncHttpErrorCodeSchema,
    message: z.string().min(1).max(2_000),
    request_id: remoteSyncHttpRequestIdSchema,
    outcome: remoteSyncIdempotencyOutcomeSchema.optional(),
    details: remoteSyncHttpErrorDetailsSchema.optional()
  }).strict()
}).strict();

const REMOTE_SYNC_HTTP_DEFAULT_LEASE_TTL_MS = 60_000;
const REMOTE_SYNC_HTTP_MAX_LEASE_TTL_MS = 10 * 60_000;
const REMOTE_SYNC_HTTP_MAX_CHUNK_BYTES = 1024 * 1024;
const REMOTE_SYNC_HTTP_MAX_FILE_BYTES = 10 * 1024 * 1024;
const REMOTE_SYNC_HTTP_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const REMOTE_SYNC_HTTP_MAX_OPERATIONS = 100_000;

export const remoteSyncHttpDefaultLeaseTtlMs = REMOTE_SYNC_HTTP_DEFAULT_LEASE_TTL_MS;
export const remoteSyncHttpMaxLeaseTtlMs = REMOTE_SYNC_HTTP_MAX_LEASE_TTL_MS;
export const remoteSyncHttpMaxChunkBytes = REMOTE_SYNC_HTTP_MAX_CHUNK_BYTES;
export const remoteSyncHttpMaxFileBytes = REMOTE_SYNC_HTTP_MAX_FILE_BYTES;
export const remoteSyncHttpMaxTotalBytes = REMOTE_SYNC_HTTP_MAX_TOTAL_BYTES;
export const remoteSyncHttpMaxOperations = REMOTE_SYNC_HTTP_MAX_OPERATIONS;

const remoteSyncHttpLeaseTtlSchema = z.number()
  .int()
  .min(1)
  .max(REMOTE_SYNC_HTTP_MAX_LEASE_TTL_MS)
  .optional()
  .default(REMOTE_SYNC_HTTP_DEFAULT_LEASE_TTL_MS);

const remoteSyncHttpPathSchema = z.string()
  .min(1)
  .max(1_024)
  .refine((value) => !value.startsWith("/") && !value.includes("\\") &&
    value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".." &&
      [...segment].every((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint > 0x1f && codePoint !== 0x7f &&
          (codePoint < 0xd800 || codePoint > 0xdfff);
      })), "path must be canonical and relative");

export const remoteSyncPushFileMetadataHttpSchema = remoteSyncRemoteFileMetadataSchema.extend({
  /** Opaque project-scoped bytes staged by the bounded content-upload route. */
  upload_ref: remoteContentUploadHttpRefSchema.optional()
}).strict().superRefine((file, context) => {
  if (file.size > 0 && file.upload_ref === undefined) {
    context.addIssue({ code: "custom", path: ["upload_ref"], message: "non-empty push files require an upload reference" });
  }
  if (file.size === 0 && file.upload_ref !== undefined) {
    context.addIssue({ code: "custom", path: ["upload_ref"], message: "empty push files cannot carry an upload reference" });
  }
  if (file.upload_ref !== undefined &&
      (file.upload_ref.sha256 !== file.content_hash || file.upload_ref.size_bytes !== file.size)) {
    context.addIssue({ code: "custom", path: ["upload_ref"], message: "upload reference does not match file identity" });
  }
});
export type RemoteSyncPushFileMetadataHttp = z.infer<typeof remoteSyncPushFileMetadataHttpSchema>;

const remoteSyncHttpBoundedFilesSchema = z.array(remoteSyncPushFileMetadataHttpSchema)
  .max(REMOTE_SYNC_HTTP_MAX_OPERATIONS)
  .superRefine((files, context) => {
    let total = 0;
    files.forEach((file, index) => {
      if (file.size > REMOTE_SYNC_HTTP_MAX_FILE_BYTES) {
        context.addIssue({ code: "too_big", origin: "number", maximum: REMOTE_SYNC_HTTP_MAX_FILE_BYTES, inclusive: true, path: [index, "size"], message: "file exceeds the per-file limit" });
      }
      total += file.size;
    });
    if (total > REMOTE_SYNC_HTTP_MAX_TOTAL_BYTES) {
      context.addIssue({ code: "too_big", origin: "number", maximum: REMOTE_SYNC_HTTP_MAX_TOTAL_BYTES, inclusive: true, path: [], message: "files exceed the total byte limit" });
    }
  });

const remoteSyncHttpOperationsSchema = z.array(remoteSyncOperationSchema)
  .max(REMOTE_SYNC_HTTP_MAX_OPERATIONS);

export const remoteSyncLeaseAcquireHttpRequestSchema = z.object({
  source: remoteSyncSourceRefSchema,
  ttl_ms: remoteSyncHttpLeaseTtlSchema
}).strict();

export const remoteSyncLeaseRenewHttpRequestSchema = z.object({
  lease: remoteSyncLeaseSchema,
  ttl_ms: remoteSyncHttpLeaseTtlSchema
}).strict();

export const remoteSyncLeaseReleaseHttpRequestSchema = z.object({
  lease: remoteSyncLeaseSchema
}).strict();

export const remoteSyncLeaseHttpResponseSchema = z.object({
  lease: remoteSyncLeaseSchema,
  outcome: z.enum(["new", "replay"])
}).strict();

export const remoteSyncLeaseReleaseHttpResponseSchema = z.object({
  outcome: z.enum(["new", "replay"])
}).strict();

export const remoteSyncSnapshotHttpRequestSchema = z.object({
  source: remoteSyncSourceRefSchema,
  expected_revision: z.string().min(1).max(160).optional()
}).strict();

export const remoteSyncRemoteSnapshotHttpResponseSchema = remoteSyncRemoteSnapshotSchema;

export const remoteSyncContentStreamHttpRequestSchema = z.object({
  source: remoteSyncSourceRefSchema,
  path: remoteSyncHttpPathSchema,
  snapshot_id: z.string().min(1).max(160),
  expected_revision: z.string().min(1).max(160),
  chunk_size: z.number().int().min(1).max(REMOTE_SYNC_HTTP_MAX_CHUNK_BYTES)
    .optional()
    .default(REMOTE_SYNC_HTTP_MAX_CHUNK_BYTES)
}).strict();

/** JSON metadata for a binary stream; bytes travel in the response body. */
export const remoteSyncContentStreamHttpChunkSchema = remoteSyncContentChunkSchema
  .omit({ bytes: true })
  .strict();
/** Alias retained for clients that put HTTP before the value name. */
export const remoteSyncHttpContentChunkSchema = remoteSyncContentStreamHttpChunkSchema;

export const remoteSyncPushPrepareHttpRequestSchema = z.object({
  source: remoteSyncSourceRefSchema,
  lease: remoteSyncLeaseSchema,
  expected_revision: z.string().min(1).max(160),
  preview_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  idempotency_key: remoteSyncHttpIdempotencyKeySchema,
  payload_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  /** File metadata is sent here; file bytes use bounded stream transport. */
  files: remoteSyncHttpBoundedFilesSchema,
  operations: remoteSyncHttpOperationsSchema,
  skipped: remoteSyncHttpOperationsSchema
}).strict().superRefine((value, context) => {
  if (value.lease.project_id !== value.source.project_id ||
      value.lease.branch_name !== value.source.branch_name ||
      value.lease.actor_id !== value.source.actor_id) {
    context.addIssue({ code: "custom", path: ["lease"], message: "lease is outside source scope" });
  }
  const filePaths = value.files.map((file) => file.path.toLocaleLowerCase("en-US"));
  const outcomePaths = [...value.operations, ...value.skipped]
    .map((operation) => operation.path.toLocaleLowerCase("en-US"));
  if (new Set(filePaths).size !== filePaths.length) {
    context.addIssue({ code: "custom", path: ["files"], message: "push file paths must be unique" });
  }
  if (new Set(outcomePaths).size !== outcomePaths.length) {
    context.addIssue({ code: "custom", path: ["operations"], message: "operation paths must be unique across outcomes" });
  }
});

export const remoteSyncPushCommitHttpRequestSchema = remoteSyncPushCommitSchema
  .extend({ idempotency_key: remoteSyncHttpIdempotencyKeySchema })
  .strict();
export const remoteSyncPushStatusHttpRequestSchema = remoteSyncPushStatusQuerySchema
  .extend({ idempotency_key: remoteSyncHttpIdempotencyKeySchema })
  .strict();

const remoteSyncPushReceiptFields = {
  schema_version: z.literal(1),
  prepare_id: z.string().min(1).max(160),
  source: remoteSyncSourceRefSchema,
  idempotency_key: remoteSyncHttpIdempotencyKeySchema,
  payload_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  preview_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  project_version: z.string().regex(/^pv_[A-Za-z0-9_-]{1,159}$/u).nullable(),
  artifact_id: z.string().regex(/^art_[A-Za-z0-9_-]{1,159}$/u).nullable(),
  commit_sha: z.string().min(1).max(160).nullable(),
  manifest_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  no_changes: z.boolean(),
  applied: remoteSyncHttpOperationsSchema,
  skipped: remoteSyncHttpOperationsSchema,
  retryable: remoteSyncHttpOperationsSchema
} as const;

export const remoteSyncPushReceiptHttpSchema = z.object(remoteSyncPushReceiptFields)
  .strict()
  .superRefine((value, context) => {
    const paths = [...value.applied, ...value.skipped, ...value.retryable].map((item) => item.path);
    if (new Set(paths).size !== paths.length) {
      context.addIssue({ code: "custom", path: ["applied"], message: "receipt operation paths must be unique across outcomes" });
    }
    if ((!value.no_changes && (value.project_version === null || value.artifact_id === null)) ||
        ((value.project_version === null) !== (value.artifact_id === null))) {
      context.addIssue({ code: "custom", path: ["project_version"], message: "receipt durable identity mismatch" });
    }
  });

export const remoteSyncPushStatusHttpResponseSchema = remoteSyncPushStatusSchema
  .extend({
    idempotency_key: remoteSyncHttpIdempotencyKeySchema,
    receipt: remoteSyncPushReceiptHttpSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.receipt !== undefined &&
        (value.receipt.source.project_id !== value.source.project_id ||
         value.receipt.source.branch_name !== value.source.branch_name ||
         value.receipt.source.actor_id !== value.source.actor_id ||
         value.receipt.idempotency_key !== value.idempotency_key ||
         value.receipt.payload_hash !== value.payload_hash)) {
      context.addIssue({ code: "custom", path: ["receipt"], message: "status receipt identity mismatch" });
    }
  });

export const remoteSyncPushReceiptHttpRequestSchema = z.object({
  source: remoteSyncSourceRefSchema,
  prepare_id: z.string().min(1).max(160)
}).strict();

export const remoteSyncPullHttpRequestSchema = remoteSyncPullRequestSchema
  .extend({ idempotency_key: remoteSyncHttpIdempotencyKeySchema })
  .strict()
  .superRefine((value, context) => {
    if (value.actor_id !== value.source.actor_id) {
      context.addIssue({ code: "custom", path: ["actor_id"], message: "actor_id must match source actor" });
    }
  });
export const remoteSyncPullReceiptHttpSchema = remoteSyncPullReceiptSchema
  .extend({ idempotency_key: remoteSyncHttpIdempotencyKeySchema })
  .strict();

export const remoteSyncPreparedPushHttpSchema = remoteSyncPreparedPushSchema
  .extend({ idempotency_key: remoteSyncHttpIdempotencyKeySchema })
  .strict();

function remoteSyncHttpResult<T extends z.ZodTypeAny>(value: T) {
  return z.discriminatedUnion("outcome", [
    z.object({ outcome: z.literal("new"), value }).strict(),
    z.object({ outcome: z.literal("replay"), value }).strict(),
    z.object({
      outcome: z.literal("conflict"),
      error: z.object({ code: z.literal("SYNC_IDEMPOTENCY_CONFLICT"), retryable: z.boolean() }).strict()
    }).strict()
  ]);
}

export const remoteSyncPushPrepareHttpResponseSchema = remoteSyncHttpResult(remoteSyncPreparedPushHttpSchema);
export const remoteSyncPushCommitHttpResponseSchema = remoteSyncHttpResult(remoteSyncPushReceiptHttpSchema);
export const remoteSyncPushReceiptHttpResponseSchema = remoteSyncPushCommitHttpResponseSchema;
export const remoteSyncPullHttpResponseSchema = remoteSyncHttpResult(remoteSyncPullReceiptHttpSchema);

const unauthorized = Object.freeze(["AUTH_REQUIRED", "TOKEN_INVALID", "SESSION_INVALID"] as const);
const forbidden = Object.freeze(["PROJECT_INFORMATION_FORBIDDEN", "PROJECT_KEY_SCOPE", "PROJECT_KEY_MISMATCH"] as const);
const validation = Object.freeze(["VALIDATION_FAILED"] as const);
const leaseConflicts = Object.freeze(["SYNC_IDEMPOTENCY_CONFLICT", "SYNC_LEASE_FENCED", "SYNC_LEASE_SCOPE_MISMATCH"] as const);
const remoteUnavailable = Object.freeze(["REMOTE_UNAVAILABLE"] as const);

const readAuth = Object.freeze({
  actor_source: "authenticated_principal" as const,
  project_allowlist_source: "server_authority" as const,
  project_key_scope: "files:read" as const
});
const writeAuth = Object.freeze({
  actor_source: "authenticated_principal" as const,
  project_allowlist_source: "server_authority" as const,
  project_key_scope: "files:write" as const
});

const operation = <const T extends object>(
  value: T,
  errors: Readonly<Record<number, readonly string[]>>
) => Object.freeze({
  ...value,
  request_id_header: "X-Request-Id" as const,
  errors: Object.freeze(errors)
});

/** Shared source of truth for future HTTP adapters and generated clients. */
export const REMOTE_SYNC_HTTP_OPERATIONS = Object.freeze({
  acquire_lease: operation({
    method: "POST" as const,
    path: "/api/v1/projects/{project_id}/branches/{branch_name}/remote-sync/leases" as const,
    operation_id: "acquireRemoteSyncLease" as const,
    request_placement: "path_and_json_body" as const,
    auth: writeAuth,
    request_schema: "RemoteSyncLeaseAcquireHttpRequest" as const,
    idempotency_header: "Idempotency-Key" as const,
    success_status: 201 as const,
    replay_status: 200 as const,
    success_schema: "RemoteSyncLeaseHttpResponse" as const
  }, {
    400: validation,
    401: unauthorized,
    403: forbidden,
    409: Object.freeze(["SYNC_LEASE_BUSY", "SYNC_IDEMPOTENCY_CONFLICT"] as const),
    422: Object.freeze(["SYNC_LEASE_INVALID"] as const),
    503: remoteUnavailable
  }),
  renew_lease: operation({
    method: "POST" as const,
    path: "/api/v1/projects/{project_id}/branches/{branch_name}/remote-sync/leases/{lease_id}:renew" as const,
    operation_id: "renewRemoteSyncLease" as const,
    request_placement: "path_and_json_body" as const,
    auth: writeAuth,
    request_schema: "RemoteSyncLeaseRenewHttpRequest" as const,
    idempotency_header: "Idempotency-Key" as const,
    success_status: 200 as const,
    success_schema: "RemoteSyncLeaseHttpResponse" as const
  }, {
    400: validation,
    401: unauthorized,
    403: forbidden,
    409: leaseConflicts,
    410: Object.freeze(["SYNC_LEASE_EXPIRED"] as const),
    422: Object.freeze(["SYNC_LEASE_INVALID"] as const),
    503: remoteUnavailable
  }),
  release_lease: operation({
    method: "POST" as const,
    path: "/api/v1/projects/{project_id}/branches/{branch_name}/remote-sync/leases/{lease_id}:release" as const,
    operation_id: "releaseRemoteSyncLease" as const,
    request_placement: "path_and_json_body" as const,
    auth: writeAuth,
    request_schema: "RemoteSyncLeaseReleaseHttpRequest" as const,
    idempotency_header: "Idempotency-Key" as const,
    success_status: 200 as const,
    success_schema: "RemoteSyncLeaseReleaseHttpResponse" as const
  }, {
    400: validation,
    401: unauthorized,
    403: forbidden,
    409: leaseConflicts,
    410: Object.freeze(["SYNC_LEASE_EXPIRED"] as const),
    422: Object.freeze(["SYNC_LEASE_INVALID"] as const),
    503: remoteUnavailable
  }),
  snapshot: operation({
    method: "GET" as const,
    path: "/api/v1/projects/{project_id}/branches/{branch_name}/remote-sync/snapshot" as const,
    operation_id: "getRemoteSyncSnapshot" as const,
    request_placement: "path_and_query" as const,
    auth: readAuth,
    request_schema: "RemoteSyncSnapshotHttpRequest" as const,
    success_status: 200 as const,
    success_schema: "RemoteSyncRemoteSnapshotHttpResponse" as const
  }, {
    400: validation,
    401: unauthorized,
    403: forbidden,
    404: Object.freeze(["SYNC_SNAPSHOT_NOT_FOUND"] as const),
    503: remoteUnavailable
  }),
  content_stream: operation({
    method: "GET" as const,
    path: "/api/v1/projects/{project_id}/branches/{branch_name}/remote-sync/snapshots/{snapshot_id}/content" as const,
    operation_id: "streamRemoteSyncContent" as const,
    request_placement: "path_and_query" as const,
    auth: readAuth,
    request_schema: "RemoteSyncContentStreamHttpRequest" as const,
    success_status: 200 as const,
    success_media_type: "application/octet-stream" as const,
    success_schema: null,
    success_headers: Object.freeze({
      content_sha256: "X-Content-SHA256" as const,
      snapshot_id: "X-Remote-Snapshot-Id" as const,
      revision: "X-Remote-Revision" as const
    })
  }, {
    400: Object.freeze(["VALIDATION_FAILED", "SYNC_STREAM_INVALID"] as const),
    401: unauthorized,
    403: forbidden,
    404: Object.freeze(["SYNC_SNAPSHOT_NOT_FOUND"] as const),
    409: Object.freeze(["SYNC_PREVIEW_STALE"] as const),
    413: Object.freeze(["SYNC_STREAM_TOO_LARGE"] as const),
    499: Object.freeze(["SYNC_STREAM_ABORTED"] as const),
    503: remoteUnavailable
  }),
  prepare_push: operation({
    method: "POST" as const,
    path: "/api/v1/projects/{project_id}/branches/{branch_name}/remote-sync/push:prepare" as const,
    operation_id: "prepareRemoteSyncPush" as const,
    request_placement: "path_and_json_body" as const,
    auth: writeAuth,
    request_schema: "RemoteSyncPushPrepareHttpRequest" as const,
    idempotency_header: "Idempotency-Key" as const,
    success_status: 201 as const,
    replay_status: 200 as const,
    success_schema: "RemoteSyncPushPrepareHttpResponse" as const
  }, {
    400: Object.freeze(["VALIDATION_FAILED", "SYNC_STREAM_INVALID"] as const),
    401: unauthorized,
    403: forbidden,
    409: Object.freeze(["SYNC_IDEMPOTENCY_CONFLICT", "SYNC_LEASE_BUSY", "SYNC_LEASE_FENCED", "SYNC_LEASE_SCOPE_MISMATCH", "SYNC_PREVIEW_STALE"] as const),
    410: Object.freeze(["SYNC_LEASE_EXPIRED"] as const),
    413: Object.freeze(["SYNC_STREAM_TOO_LARGE"] as const),
    422: Object.freeze(["SYNC_LEASE_INVALID"] as const),
    503: remoteUnavailable
  }),
  commit_push: operation({
    method: "POST" as const,
    path: "/api/v1/projects/{project_id}/branches/{branch_name}/remote-sync/push:commit" as const,
    operation_id: "commitRemoteSyncPush" as const,
    request_placement: "path_and_json_body" as const,
    auth: writeAuth,
    request_schema: "RemoteSyncPushCommitHttpRequest" as const,
    idempotency_header: "Idempotency-Key" as const,
    success_status: 200 as const,
    replay_status: 200 as const,
    success_schema: "RemoteSyncPushCommitHttpResponse" as const
  }, {
    400: validation,
    401: unauthorized,
    403: forbidden,
    404: Object.freeze(["SYNC_PREPARE_NOT_FOUND"] as const),
    409: Object.freeze(["SYNC_IDEMPOTENCY_CONFLICT", "SYNC_LEASE_FENCED", "SYNC_LEASE_SCOPE_MISMATCH", "SYNC_COMMIT_AMBIGUOUS", "SYNC_PREVIEW_STALE"] as const),
    410: Object.freeze(["SYNC_LEASE_EXPIRED", "SYNC_PREPARE_EXPIRED"] as const),
    503: remoteUnavailable
  }),
  push_status: operation({
    method: "GET" as const,
    path: "/api/v1/projects/{project_id}/branches/{branch_name}/remote-sync/push/status" as const,
    operation_id: "getRemoteSyncPushStatus" as const,
    request_placement: "path_and_query" as const,
    auth: writeAuth,
    request_schema: "RemoteSyncPushStatusHttpRequest" as const,
    success_status: 200 as const,
    success_schema: "RemoteSyncPushStatusHttpResponse" as const
  }, {
    400: validation,
    401: unauthorized,
    403: forbidden,
    404: Object.freeze(["SYNC_PREPARE_NOT_FOUND"] as const),
    503: remoteUnavailable
  }),
  push_receipt: operation({
    method: "GET" as const,
    path: "/api/v1/projects/{project_id}/branches/{branch_name}/remote-sync/push/{prepare_id}/receipt" as const,
    operation_id: "getRemoteSyncPushReceipt" as const,
    request_placement: "path_and_query" as const,
    auth: writeAuth,
    request_schema: "RemoteSyncPushReceiptHttpRequest" as const,
    success_status: 200 as const,
    success_schema: "RemoteSyncPushReceiptHttpResponse" as const
  }, {
    400: validation,
    401: unauthorized,
    403: forbidden,
    404: Object.freeze(["SYNC_PREPARE_NOT_FOUND"] as const),
    503: remoteUnavailable
  }),
  pull: operation({
    method: "POST" as const,
    path: "/api/v1/projects/{project_id}/branches/{branch_name}/remote-sync/pull" as const,
    operation_id: "pullRemoteSync" as const,
    request_placement: "path_and_json_body" as const,
    auth: readAuth,
    request_schema: "RemoteSyncPullHttpRequest" as const,
    idempotency_header: "Idempotency-Key" as const,
    success_status: 201 as const,
    replay_status: 200 as const,
    success_schema: "RemoteSyncPullHttpResponse" as const
  }, {
    400: validation,
    401: unauthorized,
    403: forbidden,
    409: Object.freeze(["SYNC_IDEMPOTENCY_CONFLICT", "SYNC_PREVIEW_STALE"] as const),
    413: Object.freeze(["SYNC_STREAM_TOO_LARGE"] as const),
    422: Object.freeze(["SYNC_PULL_WORKSPACE_FAILED"] as const),
    503: remoteUnavailable
  })
});

export type RemoteSyncHttpScope = z.infer<typeof remoteSyncHttpScopeSchema>;
export type RemoteSyncHttpAuth = z.infer<typeof remoteSyncHttpAuthSchema>;
export type RemoteSyncHttpRequestHeaders = z.infer<typeof remoteSyncHttpRequestHeadersSchema>;
export type RemoteSyncLeaseAcquireHttpRequest = z.infer<typeof remoteSyncLeaseAcquireHttpRequestSchema>;
export type RemoteSyncLeaseRenewHttpRequest = z.infer<typeof remoteSyncLeaseRenewHttpRequestSchema>;
export type RemoteSyncLeaseReleaseHttpRequest = z.infer<typeof remoteSyncLeaseReleaseHttpRequestSchema>;
export type RemoteSyncLeaseHttpResponse = z.infer<typeof remoteSyncLeaseHttpResponseSchema>;
export type RemoteSyncSnapshotHttpRequest = z.infer<typeof remoteSyncSnapshotHttpRequestSchema>;
export type RemoteSyncContentStreamHttpRequest = z.infer<typeof remoteSyncContentStreamHttpRequestSchema>;
export type RemoteSyncContentStreamHttpChunk = z.infer<typeof remoteSyncContentStreamHttpChunkSchema>;
export type RemoteSyncPushPrepareHttpRequest = z.infer<typeof remoteSyncPushPrepareHttpRequestSchema>;
export type RemoteSyncPushCommitHttpRequest = z.infer<typeof remoteSyncPushCommitHttpRequestSchema>;
export type RemoteSyncPushStatusHttpRequest = z.infer<typeof remoteSyncPushStatusHttpRequestSchema>;
export type RemoteSyncPushStatusHttpResponse = z.infer<typeof remoteSyncPushStatusHttpResponseSchema>;
export type RemoteSyncPushReceiptHttpRequest = z.infer<typeof remoteSyncPushReceiptHttpRequestSchema>;
export type RemoteSyncPushReceiptHttp = z.infer<typeof remoteSyncPushReceiptHttpSchema>;
export type RemoteSyncPreparedPushHttp = z.infer<typeof remoteSyncPreparedPushHttpSchema>;
export type RemoteSyncPullHttpRequest = z.infer<typeof remoteSyncPullHttpRequestSchema>;
export type RemoteSyncPullReceiptHttp = z.infer<typeof remoteSyncPullReceiptHttpSchema>;
