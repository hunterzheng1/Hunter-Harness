import { z } from "zod";

import { isRuntimeProxy } from "./browser-safe-proxy.js";
import { sha256Text } from "./browser-safe-sha256.js";

export const REMOTE_CONTENT_UPLOAD_HTTP_MAX_BYTES = 512 * 1024 * 1024;
export const REMOTE_CONTENT_UPLOAD_HTTP_MAX_REMOTE_SYNC_FILE_BYTES = 10 * 1024 * 1024;
export const REMOTE_CONTENT_UPLOAD_HTTP_MAX_CHUNK_BYTES = 1024 * 1024;
export const REMOTE_CONTENT_UPLOAD_HTTP_MAX_EXPIRY_MS = 15 * 60_000;

export const remoteContentUploadHttpScopeSchema = z.enum([
  "archive:read", "archive:write", "files:read", "files:write"
]);
export const remoteContentUploadHttpAuthSchema = z.object({
  actor_source: z.literal("authenticated_principal"),
  project_allowlist_source: z.literal("server_authority"),
  project_key_scope: remoteContentUploadHttpScopeSchema
}).strict();

const remoteContentUploadHttpErrorCodeValues = [
  "AUTH_REQUIRED",
  "TOKEN_INVALID",
  "SESSION_INVALID",
  "VALIDATION_FAILED",
  "PROJECT_INFORMATION_FORBIDDEN",
  "PROJECT_KEY_SCOPE",
  "PROJECT_KEY_MISMATCH",
  "REMOTE_UNAVAILABLE",
  "REMOTE_CONTENT_UPLOAD_INPUT_INVALID",
  "REMOTE_CONTENT_UPLOAD_IDEMPOTENCY_CONFLICT",
  "REMOTE_CONTENT_UPLOAD_STREAM_INVALID",
  "REMOTE_CONTENT_UPLOAD_HASH_MISMATCH",
  "REMOTE_CONTENT_UPLOAD_SIZE_MISMATCH",
  "REMOTE_CONTENT_UPLOAD_TOO_LARGE",
  "REMOTE_CONTENT_UPLOAD_ABORTED",
  "REMOTE_CONTENT_UPLOAD_SCOPE_MISMATCH",
  "REMOTE_CONTENT_UPLOAD_NOT_FOUND",
  "REMOTE_CONTENT_UPLOAD_EXPIRED",
  "REMOTE_CONTENT_UPLOAD_MEDIA_TYPE_UNSUPPORTED"
] as const;
export const REMOTE_CONTENT_UPLOAD_HTTP_ERROR_CODES = Object.freeze(remoteContentUploadHttpErrorCodeValues);
export const remoteContentUploadHttpErrorCodeSchema = z.enum(remoteContentUploadHttpErrorCodeValues);
const remoteContentUploadHttpErrorDetailValueSchema = z.union([
  z.string().max(2_000), z.number().finite(), z.boolean(), z.null()
]);
const remoteContentUploadHttpErrorDetailsSchema = z.record(
  z.string().min(1).max(64), remoteContentUploadHttpErrorDetailValueSchema
).superRefine((value, context) => {
  if (Object.keys(value).length > 32) context.addIssue({ code: "custom", message: "details exceed 32 entries" });
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 8_192) {
    context.addIssue({ code: "custom", message: "details exceed 8192 bytes" });
  }
});
export const remoteContentUploadHttpErrorEnvelopeSchema = z.object({
  error: z.object({
    code: remoteContentUploadHttpErrorCodeSchema,
    message: z.string().min(1).max(2_000),
    request_id: z.uuid(),
    details: remoteContentUploadHttpErrorDetailsSchema.optional()
  }).strict()
}).strict();

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const boundedText = (maximum: number) => z.string().min(1).max(maximum)
  .refine((value) => value.trim() === value && [...value].every((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point > 0x1f && point !== 0x7f && (point < 0xd800 || point > 0xdfff);
  }), "text must be bounded printable data");
const canonicalIntegerHeader = (maximum: number) => z.string()
  .regex(/^[1-9][0-9]{0,8}$/u)
  .refine((value) => Number(value) <= maximum, `header exceeds ${maximum}`);

export const remoteContentUploadHttpPathSchema = z.object({
  project_id: boundedText(160),
  branch_name: boundedText(160)
}).strict();
export const remoteContentUploadHttpPrincipalSchema = z.object({
  actor_id: boundedText(160)
}).strict();
export const remoteContentUploadHttpRequestHeadersSchema = z.object({
  "Content-Type": z.enum(["application/zip", "application/octet-stream"]),
  "Content-Length": canonicalIntegerHeader(REMOTE_CONTENT_UPLOAD_HTTP_MAX_BYTES),
  "Idempotency-Key": sha256Schema,
  "X-Content-SHA256": sha256Schema,
  "X-Upload-Expires-In-Ms": canonicalIntegerHeader(REMOTE_CONTENT_UPLOAD_HTTP_MAX_EXPIRY_MS),
  "X-Commit-SHA": boundedText(240).optional(),
  "X-Client-Id": boundedText(240).optional(),
  "X-Change-Key": boundedText(240).optional()
}).strict();
export const remoteContentUploadHttpBodyStreamDescriptorSchema = z.object({
  kind: z.literal("single_binary_stream"),
  media_type: z.enum(["application/zip", "application/octet-stream"]),
  content_encoding: z.literal("identity"),
  content_length_bytes: z.number().int().min(1).max(REMOTE_CONTENT_UPLOAD_HTTP_MAX_BYTES),
  content_sha256: sha256Schema,
  max_chunk_bytes: z.literal(REMOTE_CONTENT_UPLOAD_HTTP_MAX_CHUNK_BYTES)
}).strict();
export const remoteContentUploadHttpRequestDescriptorSchema = z.object({
  schema_version: z.literal(1),
  purpose: z.enum(["remote_archive", "remote_sync_file"]),
  path: remoteContentUploadHttpPathSchema,
  auth: remoteContentUploadHttpPrincipalSchema,
  headers: remoteContentUploadHttpRequestHeadersSchema,
  body_stream: remoteContentUploadHttpBodyStreamDescriptorSchema
}).strict().superRefine((value, context) => {
  if (Number(value.headers["Content-Length"]) !== value.body_stream.content_length_bytes) {
    context.addIssue({ code: "custom", path: ["headers", "Content-Length"], message: "content length binding mismatch" });
  }
  if (value.headers["X-Content-SHA256"] !== value.body_stream.content_sha256) {
    context.addIssue({ code: "custom", path: ["headers", "X-Content-SHA256"], message: "content hash binding mismatch" });
  }
  if (value.headers["Content-Type"] !== value.body_stream.media_type) {
    context.addIssue({ code: "custom", path: ["headers", "Content-Type"], message: "media type binding mismatch" });
  }
  const expectedMediaType = value.purpose === "remote_archive" ? "application/zip" : "application/octet-stream";
  if (value.headers["Content-Type"] !== expectedMediaType) {
    context.addIssue({ code: "custom", path: ["purpose"], message: "purpose and media type mismatch" });
  }
  if (value.purpose === "remote_sync_file" &&
      value.body_stream.content_length_bytes > REMOTE_CONTENT_UPLOAD_HTTP_MAX_REMOTE_SYNC_FILE_BYTES) {
    context.addIssue({ code: "custom", path: ["body_stream", "content_length_bytes"], message: "remote sync file exceeds durable snapshot limit" });
  }
});
export const remoteContentUploadHttpStatusHeadersSchema = z.object({
  "Idempotency-Key": sha256Schema,
  "X-Commit-SHA": boundedText(240).optional(),
  "X-Client-Id": boundedText(240).optional(),
  "X-Change-Key": boundedText(240).optional()
}).strict();
export const remoteContentUploadHttpStatusDescriptorSchema = z.object({
  schema_version: z.literal(1),
  purpose: z.enum(["remote_archive", "remote_sync_file"]),
  path: remoteContentUploadHttpPathSchema,
  auth: remoteContentUploadHttpPrincipalSchema,
  headers: remoteContentUploadHttpStatusHeadersSchema
}).strict();

export const remoteContentUploadHttpSourceSchema = z.object({
  project_id: boundedText(160),
  branch_name: boundedText(160),
  actor_id: boundedText(160),
  commit_sha: boundedText(240).optional(),
  client_id: boundedText(240).optional(),
  change_key: boundedText(240).optional()
}).strict();
export const remoteContentUploadHttpRefSchema = z.object({
  ref_id: z.string().regex(/^bounded_upload:[A-Za-z0-9_-]{43}$/u),
  sha256: sha256Schema,
  size_bytes: z.number().int().min(1).max(REMOTE_CONTENT_UPLOAD_HTTP_MAX_BYTES)
}).strict();

function canonicalRemoteContentUploadRecord(value: {
  schema_version: 1;
  upload_id: string;
  source: z.infer<typeof remoteContentUploadHttpSourceSchema>;
  idempotency_key: string;
  purpose: "remote_archive" | "remote_sync_file";
  content_sha256: string;
  size_bytes: number;
  upload_ref: z.infer<typeof remoteContentUploadHttpRefSchema>;
  state: "stored";
  created_at: string;
  expires_at: string;
}): string {
  const source = { project_id: value.source.project_id, branch_name: value.source.branch_name,
    actor_id: value.source.actor_id,
    ...(value.source.commit_sha === undefined ? {} : { commit_sha: value.source.commit_sha }),
    ...(value.source.client_id === undefined ? {} : { client_id: value.source.client_id }),
    ...(value.source.change_key === undefined ? {} : { change_key: value.source.change_key }) };
  const uploadRef = { ref_id: value.upload_ref.ref_id, sha256: value.upload_ref.sha256,
    size_bytes: value.upload_ref.size_bytes };
  return JSON.stringify({ schema_version: value.schema_version, upload_id: value.upload_id, source,
    idempotency_key: value.idempotency_key, purpose: value.purpose, content_sha256: value.content_sha256,
    size_bytes: value.size_bytes, upload_ref: uploadRef, state: value.state,
    created_at: value.created_at, expires_at: value.expires_at });
}

export function remoteContentUploadHttpRecordHash(value: Parameters<typeof canonicalRemoteContentUploadRecord>[0]):
`sha256:${string}` {
  return `sha256:${sha256Text(canonicalRemoteContentUploadRecord(value))}`;
}

const canonicalTimestampSchema = z.string().datetime({ offset: false, precision: 3 })
  .refine((value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
  }, "timestamp must be canonical UTC");
export const remoteContentUploadHttpRecordSchema = z.object({
  schema_version: z.literal(1),
  upload_id: z.string().regex(/^remote_content_upload:[A-Za-z0-9_-]{43}$/u),
  source: remoteContentUploadHttpSourceSchema,
  idempotency_key: sha256Schema,
  purpose: z.enum(["remote_archive", "remote_sync_file"]),
  content_sha256: sha256Schema,
  size_bytes: z.number().int().min(1).max(REMOTE_CONTENT_UPLOAD_HTTP_MAX_BYTES),
  upload_ref: remoteContentUploadHttpRefSchema,
  state: z.literal("stored"),
  created_at: canonicalTimestampSchema,
  expires_at: canonicalTimestampSchema,
  record_hash: sha256Schema
}).strict().superRefine((value, context) => {
  const token = value.upload_ref.ref_id.slice("bounded_upload:".length);
  const duration = Date.parse(value.expires_at) - Date.parse(value.created_at);
  if (value.upload_id !== `remote_content_upload:${token}`) {
    context.addIssue({ code: "custom", path: ["upload_id"], message: "upload identity mismatch" });
  }
  if (value.upload_ref.sha256 !== value.content_sha256 || value.upload_ref.size_bytes !== value.size_bytes) {
    context.addIssue({ code: "custom", path: ["upload_ref"], message: "upload reference identity mismatch" });
  }
  if (value.purpose === "remote_sync_file" && value.size_bytes > REMOTE_CONTENT_UPLOAD_HTTP_MAX_REMOTE_SYNC_FILE_BYTES) {
    context.addIssue({ code: "custom", path: ["size_bytes"], message: "remote sync file exceeds durable snapshot limit" });
  }
  if (duration <= 0 || duration > REMOTE_CONTENT_UPLOAD_HTTP_MAX_EXPIRY_MS) {
    context.addIssue({ code: "custom", path: ["expires_at"], message: "upload expiry is outside bounds" });
  }
  const { record_hash: recordHash, ...body } = value;
  if (recordHash !== remoteContentUploadHttpRecordHash(body)) {
    context.addIssue({ code: "custom", path: ["record_hash"], message: "record hash mismatch" });
  }
});
export const remoteContentUploadHttpResultSchema = z.object({
  outcome: z.enum(["new", "replay"]),
  upload_ref: remoteContentUploadHttpRefSchema,
  record: remoteContentUploadHttpRecordSchema
}).strict().superRefine((value, context) => {
  if (value.upload_ref.ref_id !== value.record.upload_ref.ref_id ||
      value.upload_ref.sha256 !== value.record.upload_ref.sha256 ||
      value.upload_ref.size_bytes !== value.record.upload_ref.size_bytes) {
    context.addIssue({ code: "custom", path: ["upload_ref"], message: "result reference mismatch" });
  }
});
export const remoteContentUploadHttpStatusSchema = z.object({
  state: z.enum(["stored", "expired", "unknown"]),
  record: remoteContentUploadHttpRecordSchema.nullable()
}).strict().superRefine((value, context) => {
  if ((value.state === "unknown") !== (value.record === null)) {
    context.addIssue({ code: "custom", path: ["record"], message: "status record presence mismatch" });
  }
});

export type RemoteContentUploadHttpValidation<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly reason_code: "REMOTE_CONTENT_UPLOAD_HTTP_INVALID" };

function snapshotRemoteContentUploadHttp(value: unknown): unknown {
  const seen = new WeakSet<object>(); let nodes = 0; let text = 0;
  const copy = (input: unknown, depth: number): unknown => {
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "string") { text += input.length;
      if (input.length > 2_000 || text > 8_192) throw new Error(); return input; }
    if (typeof input === "number") { if (!Number.isFinite(input)) throw new Error(); return input; }
    if (typeof input !== "object" || isRuntimeProxy(input) || Array.isArray(input) || depth > 8 ||
        ++nodes > 64 || seen.has(input) || Object.getPrototypeOf(input) !== Object.prototype) throw new Error();
    seen.add(input); const descriptors = Object.getOwnPropertyDescriptors(input); const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) throw new Error();
    for (const key of keys as string[]) { const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined ||
          descriptor.enumerable !== true) throw new Error(); }
    return Object.fromEntries((keys as string[]).map((key) =>
      [key, copy((descriptors[key] as PropertyDescriptor).value, depth + 1)]));
  };
  const result = copy(value, 0);
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 16_384) throw new Error();
  return result;
}

function safeContentUploadHttpValidation<T>(
  schema: z.ZodType<T>,
  value: unknown
): RemoteContentUploadHttpValidation<T> {
  try {
    const result = schema.safeParse(snapshotRemoteContentUploadHttp(value));
    return result.success ? Object.freeze({ success: true as const, data: result.data }) :
      Object.freeze({ success: false as const, reason_code: "REMOTE_CONTENT_UPLOAD_HTTP_INVALID" as const });
  } catch {
    return Object.freeze({ success: false as const, reason_code: "REMOTE_CONTENT_UPLOAD_HTTP_INVALID" as const });
  }
}

export const validateRemoteContentUploadHttpRequestDescriptor = (value: unknown) =>
  safeContentUploadHttpValidation(remoteContentUploadHttpRequestDescriptorSchema, value);
export const validateRemoteContentUploadHttpStatusDescriptor = (value: unknown) =>
  safeContentUploadHttpValidation(remoteContentUploadHttpStatusDescriptorSchema, value);
export const validateRemoteContentUploadHttpResult = (value: unknown) =>
  safeContentUploadHttpValidation(remoteContentUploadHttpResultSchema, value);
export const validateRemoteContentUploadHttpStatus = (value: unknown) =>
  safeContentUploadHttpValidation(remoteContentUploadHttpStatusSchema, value);
export const validateRemoteContentUploadHttpErrorEnvelope = (value: unknown) =>
  safeContentUploadHttpValidation(remoteContentUploadHttpErrorEnvelopeSchema, value);

const unauthorized = Object.freeze(["AUTH_REQUIRED", "TOKEN_INVALID", "SESSION_INVALID"] as const);
const forbidden = Object.freeze([
  "PROJECT_INFORMATION_FORBIDDEN", "PROJECT_KEY_SCOPE", "PROJECT_KEY_MISMATCH"
] as const);
const validation = Object.freeze([
  "VALIDATION_FAILED",
  "REMOTE_CONTENT_UPLOAD_INPUT_INVALID",
  "REMOTE_CONTENT_UPLOAD_STREAM_INVALID",
  "REMOTE_CONTENT_UPLOAD_HASH_MISMATCH",
  "REMOTE_CONTENT_UPLOAD_SIZE_MISMATCH"
] as const);
const unavailable = Object.freeze(["REMOTE_UNAVAILABLE"] as const);
const readAuth = Object.freeze({
  actor_source: "authenticated_principal" as const,
  project_allowlist_source: "server_authority" as const,
  project_key_scope: "archive:read" as const
});
const writeAuth = Object.freeze({
  actor_source: "authenticated_principal" as const,
  project_allowlist_source: "server_authority" as const,
  project_key_scope: "archive:write" as const
});
const fileReadAuth = Object.freeze({
  actor_source: "authenticated_principal" as const,
  project_allowlist_source: "server_authority" as const,
  project_key_scope: "files:read" as const
});
const fileWriteAuth = Object.freeze({
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

export const REMOTE_CONTENT_UPLOAD_HTTP_OPERATIONS = Object.freeze({
  upload_content: operation({
    method: "POST" as const,
    path: "/api/v1/projects/{project_id}/branches/{branch_name}/remote-sync/content-upload" as const,
    operation_id: "stageRemoteContentUpload" as const,
    request_placement: "path_headers_and_binary_body" as const,
    request_media_type: "application/zip" as const,
    body_transport: "single_bounded_stream" as const,
    auth: writeAuth,
    request_descriptor_schema: "RemoteContentUploadHttpRequestDescriptor" as const,
    success_status: 201 as const,
    replay_status: 200 as const,
    success_schema: "RemoteContentUploadHttpResult" as const,
    identity_bindings: Object.freeze([
      Object.freeze(["path.project_id", "response.record.source.project_id"] as const),
      Object.freeze(["path.branch_name", "response.record.source.branch_name"] as const),
      Object.freeze(["auth.actor_id", "response.record.source.actor_id"] as const),
      Object.freeze(["header.Idempotency-Key", "response.record.idempotency_key"] as const),
      Object.freeze(["header.X-Content-SHA256", "body_stream.content_sha256"] as const),
      Object.freeze(["header.Content-Length", "body_stream.content_length_bytes"] as const),
      Object.freeze(["header.X-Commit-SHA", "response.record.source.commit_sha"] as const),
      Object.freeze(["header.X-Client-Id", "response.record.source.client_id"] as const),
      Object.freeze(["header.X-Change-Key", "response.record.source.change_key"] as const),
      Object.freeze(["header.X-Upload-Expires-In-Ms", "response.record.created_at..expires_at"] as const)
    ])
  }, {
    400: validation,
    401: unauthorized,
    403: forbidden,
    409: Object.freeze(["REMOTE_CONTENT_UPLOAD_IDEMPOTENCY_CONFLICT"] as const),
    410: Object.freeze(["REMOTE_CONTENT_UPLOAD_EXPIRED"] as const),
    413: Object.freeze(["REMOTE_CONTENT_UPLOAD_TOO_LARGE"] as const),
    415: Object.freeze(["REMOTE_CONTENT_UPLOAD_MEDIA_TYPE_UNSUPPORTED"] as const),
    499: Object.freeze(["REMOTE_CONTENT_UPLOAD_ABORTED"] as const),
    503: unavailable
  }),
  upload_status: operation({
    method: "GET" as const,
    path: "/api/v1/projects/{project_id}/branches/{branch_name}/remote-sync/content-upload/status" as const,
    operation_id: "getRemoteContentUploadStatus" as const,
    request_placement: "path_and_headers" as const,
    auth: readAuth,
    request_descriptor_schema: "RemoteContentUploadHttpStatusDescriptor" as const,
    success_status: 200 as const,
    success_schema: "RemoteContentUploadHttpStatus" as const,
    identity_bindings: Object.freeze([
      Object.freeze(["path.project_id", "response.record.source.project_id"] as const),
      Object.freeze(["path.branch_name", "response.record.source.branch_name"] as const),
      Object.freeze(["auth.actor_id", "response.record.source.actor_id"] as const),
      Object.freeze(["header.Idempotency-Key", "response.record.idempotency_key"] as const),
      Object.freeze(["header.X-Commit-SHA", "response.record.source.commit_sha"] as const),
      Object.freeze(["header.X-Client-Id", "response.record.source.client_id"] as const),
      Object.freeze(["header.X-Change-Key", "response.record.source.change_key"] as const)
    ])
  }, {
    400: validation,
    401: unauthorized,
    403: Object.freeze([...forbidden, "REMOTE_CONTENT_UPLOAD_SCOPE_MISMATCH"] as const),
    503: unavailable
  }),
  upload_remote_sync_file: operation({
    method: "POST" as const,
    path: "/api/v1/projects/{project_id}/branches/{branch_name}/remote-sync/file-upload" as const,
    operation_id: "stageRemoteSyncFileUpload" as const,
    request_placement: "path_headers_and_binary_body" as const,
    request_media_type: "application/octet-stream" as const,
    body_transport: "single_bounded_stream" as const,
    auth: fileWriteAuth,
    request_descriptor_schema: "RemoteContentUploadHttpRequestDescriptor" as const,
    success_status: 201 as const,
    replay_status: 200 as const,
    success_schema: "RemoteContentUploadHttpResult" as const,
    identity_bindings: Object.freeze([
      Object.freeze(["descriptor.purpose", "response.record.purpose"] as const),
      Object.freeze(["path.project_id", "response.record.source.project_id"] as const),
      Object.freeze(["path.branch_name", "response.record.source.branch_name"] as const),
      Object.freeze(["auth.actor_id", "response.record.source.actor_id"] as const),
      Object.freeze(["header.Idempotency-Key", "response.record.idempotency_key"] as const),
      Object.freeze(["header.X-Content-SHA256", "body_stream.content_sha256"] as const),
      Object.freeze(["header.Content-Length", "body_stream.content_length_bytes"] as const),
      Object.freeze(["header.X-Commit-SHA", "response.record.source.commit_sha"] as const),
      Object.freeze(["header.X-Client-Id", "response.record.source.client_id"] as const),
      Object.freeze(["header.X-Change-Key", "response.record.source.change_key"] as const),
      Object.freeze(["header.X-Upload-Expires-In-Ms", "response.record.created_at..expires_at"] as const)
    ])
  }, {
    400: validation,
    401: unauthorized,
    403: forbidden,
    409: Object.freeze(["REMOTE_CONTENT_UPLOAD_IDEMPOTENCY_CONFLICT"] as const),
    410: Object.freeze(["REMOTE_CONTENT_UPLOAD_EXPIRED"] as const),
    413: Object.freeze(["REMOTE_CONTENT_UPLOAD_TOO_LARGE"] as const),
    415: Object.freeze(["REMOTE_CONTENT_UPLOAD_MEDIA_TYPE_UNSUPPORTED"] as const),
    499: Object.freeze(["REMOTE_CONTENT_UPLOAD_ABORTED"] as const),
    503: unavailable
  }),
  remote_sync_file_status: operation({
    method: "GET" as const,
    path: "/api/v1/projects/{project_id}/branches/{branch_name}/remote-sync/file-upload/status" as const,
    operation_id: "getRemoteSyncFileUploadStatus" as const,
    request_placement: "path_and_headers" as const,
    auth: fileReadAuth,
    request_descriptor_schema: "RemoteContentUploadHttpStatusDescriptor" as const,
    success_status: 200 as const,
    success_schema: "RemoteContentUploadHttpStatus" as const,
    identity_bindings: Object.freeze([
      Object.freeze(["descriptor.purpose", "response.record.purpose"] as const),
      Object.freeze(["path.project_id", "response.record.source.project_id"] as const),
      Object.freeze(["path.branch_name", "response.record.source.branch_name"] as const),
      Object.freeze(["auth.actor_id", "response.record.source.actor_id"] as const),
      Object.freeze(["header.Idempotency-Key", "response.record.idempotency_key"] as const),
      Object.freeze(["header.X-Commit-SHA", "response.record.source.commit_sha"] as const),
      Object.freeze(["header.X-Client-Id", "response.record.source.client_id"] as const),
      Object.freeze(["header.X-Change-Key", "response.record.source.change_key"] as const)
    ])
  }, {
    400: validation,
    401: unauthorized,
    403: Object.freeze([...forbidden, "REMOTE_CONTENT_UPLOAD_SCOPE_MISMATCH"] as const),
    503: unavailable
  })
});

export type RemoteContentUploadHttpScope = z.infer<typeof remoteContentUploadHttpScopeSchema>;
export type RemoteContentUploadHttpAuth = z.infer<typeof remoteContentUploadHttpAuthSchema>;
export type RemoteContentUploadHttpErrorCode = z.infer<typeof remoteContentUploadHttpErrorCodeSchema>;
export type RemoteContentUploadHttpErrorEnvelope = z.infer<typeof remoteContentUploadHttpErrorEnvelopeSchema>;
export type RemoteContentUploadHttpPath = z.infer<typeof remoteContentUploadHttpPathSchema>;
export type RemoteContentUploadHttpPrincipal = z.infer<typeof remoteContentUploadHttpPrincipalSchema>;
export type RemoteContentUploadHttpRequestHeaders = z.infer<typeof remoteContentUploadHttpRequestHeadersSchema>;
export type RemoteContentUploadHttpBodyStreamDescriptor = z.infer<typeof remoteContentUploadHttpBodyStreamDescriptorSchema>;
export type RemoteContentUploadHttpRequestDescriptor = z.infer<typeof remoteContentUploadHttpRequestDescriptorSchema>;
export type RemoteContentUploadHttpStatusHeaders = z.infer<typeof remoteContentUploadHttpStatusHeadersSchema>;
export type RemoteContentUploadHttpStatusDescriptor = z.infer<typeof remoteContentUploadHttpStatusDescriptorSchema>;
export type RemoteContentUploadHttpSource = z.infer<typeof remoteContentUploadHttpSourceSchema>;
export type RemoteContentUploadHttpRef = z.infer<typeof remoteContentUploadHttpRefSchema>;
export type RemoteContentUploadHttpRecord = z.infer<typeof remoteContentUploadHttpRecordSchema>;
export type RemoteContentUploadHttpResult = z.infer<typeof remoteContentUploadHttpResultSchema>;
export type RemoteContentUploadHttpStatus = z.infer<typeof remoteContentUploadHttpStatusSchema>;
