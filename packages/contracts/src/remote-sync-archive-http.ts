import { z } from "zod";

import { isRuntimeProxy } from "./browser-safe-proxy.js";
import { sha256Text } from "./browser-safe-sha256.js";

function canonicalArchiveHttpValue(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalArchiveHttpValue).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort()
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalArchiveHttpValue((value as Record<string, unknown>)[key])}`).join(",")}}`;
  throw new Error("REMOTE_ARCHIVE_INPUT_INVALID");
}
export function remoteSyncArchiveHttpStableHash(value: unknown): `sha256:${string}` {
  return `sha256:${sha256Text(canonicalArchiveHttpValue(value))}`;
}
const sameCanonical = (left: unknown, right: unknown): boolean =>
  remoteSyncArchiveHttpStableHash(left) === remoteSyncArchiveHttpStableHash(right);

const remoteSyncArchiveHttpErrorCodeValues = [
  "AUTH_REQUIRED",
  "TOKEN_INVALID",
  "SESSION_INVALID",
  "VALIDATION_FAILED",
  "PROJECT_INFORMATION_FORBIDDEN",
  "PROJECT_KEY_SCOPE",
  "PROJECT_KEY_MISMATCH",
  "REMOTE_UNAVAILABLE",
  "REMOTE_ARCHIVE_INPUT_INVALID",
  "REMOTE_ARCHIVE_PAYLOAD_HASH_MISMATCH",
  "REMOTE_ARCHIVE_IDEMPOTENCY_CONFLICT",
  "REMOTE_ARCHIVE_PREPARE_NOT_FOUND",
  "REMOTE_ARCHIVE_PREPARE_EXPIRED",
  "REMOTE_ARCHIVE_LEASE_FENCED",
  "REMOTE_ARCHIVE_LEASE_SCOPE_MISMATCH",
  "REMOTE_ARCHIVE_CAPABILITY_UNAVAILABLE",
  "REMOTE_ARCHIVE_COMMIT_AMBIGUOUS",
  "REMOTE_ARCHIVE_RECORD_INVALID",
  "REMOTE_ARCHIVE_LEGACY_READ_ONLY"
] as const;

export const REMOTE_SYNC_ARCHIVE_HTTP_ERROR_CODES = Object.freeze(remoteSyncArchiveHttpErrorCodeValues);
export const remoteSyncArchiveHttpErrorCodeSchema = z.enum(remoteSyncArchiveHttpErrorCodeValues);
export const remoteSyncArchiveHttpScopeSchema = z.enum(["archive:read", "archive:write"]);
export const remoteSyncArchiveHttpAuthSchema = z.object({
  actor_source: z.literal("authenticated_principal"),
  project_allowlist_source: z.literal("server_authority"),
  project_key_scope: remoteSyncArchiveHttpScopeSchema
}).strict();
const remoteSyncArchiveHttpErrorDetailValueSchema = z.union([
  z.string().max(2_000), z.number().finite(), z.boolean(), z.null()
]);
const remoteSyncArchiveHttpErrorDetailsSchema = z.record(z.string().min(1).max(64), remoteSyncArchiveHttpErrorDetailValueSchema)
  .superRefine((value, context) => {
    if (Object.keys(value).length > 32) context.addIssue({ code: "custom", message: "details exceed 32 entries" });
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 8_192) {
      context.addIssue({ code: "custom", message: "details exceed 8192 bytes" });
    }
  });
export const remoteSyncArchiveHttpErrorEnvelopeSchema = z.object({
  error: z.object({
    code: remoteSyncArchiveHttpErrorCodeSchema,
    message: z.string().min(1).max(2_000),
    request_id: z.uuid(),
    details: remoteSyncArchiveHttpErrorDetailsSchema.optional()
  }).strict()
}).strict();

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const boundedText = (maximum = 160) => z.string().min(1).max(maximum)
  .refine((value) => value.trim() === value && [...value].every((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point > 0x1f && point !== 0x7f;
  }), "text must be bounded printable data");
const operationIdSchema = boundedText(240).regex(/^remote_archive_operation:/u);
const prepareIdSchema = boundedText(240).regex(/^remote_archive_prepare:sha256:[a-f0-9]{64}$/u);
const receiptIdSchema = boundedText(240).regex(/^remote_archive_receipt:sha256:[a-f0-9]{64}$/u);
const timestampSchema = z.string().datetime({ offset: false, precision: 3 });
const sourceFields = {
  project_id: boundedText(), branch_name: boundedText(), actor_id: boundedText(),
  commit_sha: boundedText().optional(), client_id: boundedText().optional(), change_key: boundedText().optional()
} as const;
export const remoteSyncArchiveSourceHttpSchema = z.object(sourceFields).strict();
export const remoteSyncArchiveUploadRefHttpSchema = z.object({
  ref_id: boundedText(240), sha256: sha256Schema, size_bytes: z.number().int().min(1).max(512 * 1024 * 1024)
}).strict();
export const remoteSyncArchiveIdentitiesHttpSchema = z.object({
  package_sha256: sha256Schema,
  package_size_bytes: z.number().int().min(1).max(512 * 1024 * 1024),
  archive_schema_version: z.literal(1),
  trusted_package_receipt_hash: sha256Schema,
  local_archive_receipt_hash: sha256Schema,
  manifest_hash: sha256Schema,
  inventory_hash: sha256Schema,
  core_v2_projection_hash: sha256Schema
}).strict();
export const remoteSyncArchiveMetadataHttpSchema = z.object({
  schema_version: z.literal(2), source: remoteSyncArchiveSourceHttpSchema,
  archive_id: boundedText(), identities: remoteSyncArchiveIdentitiesHttpSchema,
  upload_ref: remoteSyncArchiveUploadRefHttpSchema
}).strict().superRefine((value, context) => {
  if (value.upload_ref.sha256 !== value.identities.package_sha256 ||
      value.upload_ref.size_bytes !== value.identities.package_size_bytes) {
    context.addIssue({ code: "custom", path: ["upload_ref"], message: "upload_ref must bind package hash and size" });
  }
});
export const remoteSyncArchiveLeaseHttpSchema = z.object({
  project_id: boundedText(), branch_name: boundedText(), actor_id: boundedText(), capability_hash: sha256Schema,
  fencing_token: z.number().int().min(1), acquired_at: timestampSchema, expires_at: timestampSchema
}).strict().superRefine((value, context) => {
  const duration = Date.parse(value.expires_at) - Date.parse(value.acquired_at);
  if (duration <= 0 || duration > 600_000) {
    context.addIssue({ code: "custom", path: ["expires_at"], message: "lease expiry must follow acquisition" });
  }
});
export const remoteSyncArchiveReceiptHttpSchema = z.object({
  schema_version: z.literal(2), receipt_id: receiptIdSchema, operation_id: operationIdSchema, prepare_id: prepareIdSchema,
  idempotency_key: sha256Schema, payload_hash: sha256Schema, source: remoteSyncArchiveSourceHttpSchema,
  archive_id: boundedText(), package_sha256: sha256Schema,
  package_size_bytes: z.number().int().min(1).max(512 * 1024 * 1024), manifest_hash: sha256Schema,
  trusted_package_receipt_hash: sha256Schema, local_archive_receipt_hash: sha256Schema,
  inventory_hash: sha256Schema, core_v2_projection_hash: sha256Schema,
  stored_at: timestampSchema, receipt_hash: sha256Schema
}).strict().superRefine((value, context) => {
  const { receipt_hash: receiptHash, receipt_id: receiptId, ...body } = value;
  const expected = remoteSyncArchiveHttpStableHash(body);
  if (receiptHash !== expected || receiptId !== `remote_archive_receipt:${expected}`) {
    context.addIssue({ code: "custom", path: ["receipt_hash"], message: "receipt hash identity mismatch" });
  }
});
export const remoteSyncArchiveRecordHttpSchema = z.object({
  schema_version: z.literal(2), operation_id: operationIdSchema, prepare_id: prepareIdSchema,
  idempotency_key: sha256Schema, payload_hash: sha256Schema, source: remoteSyncArchiveSourceHttpSchema,
  archive_id: boundedText(), identities: remoteSyncArchiveIdentitiesHttpSchema, upload_ref: remoteSyncArchiveUploadRefHttpSchema,
  state: z.enum(["pending", "prepared", "committing", "committed", "failed"]), generation: z.number().int().min(0),
  lease: remoteSyncArchiveLeaseHttpSchema.nullable(), receipt: remoteSyncArchiveReceiptHttpSchema.nullable(),
  failure_code: remoteSyncArchiveHttpErrorCodeSchema.nullable(), created_at: timestampSchema,
  updated_at: timestampSchema, record_hash: sha256Schema
}).strict().superRefine((value, context) => {
  const metadata = { schema_version: 2 as const, source: value.source, archive_id: value.archive_id,
    identities: value.identities, upload_ref: value.upload_ref };
  const prepareHash = remoteSyncArchiveHttpStableHash({ operation_id: value.operation_id,
    idempotency_key: value.idempotency_key, payload_hash: value.payload_hash });
  if (value.payload_hash !== remoteSyncArchiveHttpStableHash(metadata)) {
    context.addIssue({ code: "custom", path: ["payload_hash"], message: "payload hash mismatch" });
  }
  if (value.prepare_id !== `remote_archive_prepare:${prepareHash}`) {
    context.addIssue({ code: "custom", path: ["prepare_id"], message: "prepare identity mismatch" });
  }
  if (Date.parse(value.updated_at) < Date.parse(value.created_at)) {
    context.addIssue({ code: "custom", path: ["updated_at"], message: "record time moved backwards" });
  }
  const metadataMatches = value.upload_ref.sha256 === value.identities.package_sha256 &&
    value.upload_ref.size_bytes === value.identities.package_size_bytes;
  if (!metadataMatches) context.addIssue({ code: "custom", path: ["upload_ref"], message: "record upload identity mismatch" });
  if (value.lease !== null && (value.lease.project_id !== value.source.project_id ||
      value.lease.branch_name !== value.source.branch_name || value.lease.actor_id !== value.source.actor_id)) {
    context.addIssue({ code: "custom", path: ["lease"], message: "lease is outside source scope" });
  }
  if (value.lease !== null && Date.parse(value.lease.acquired_at) < Date.parse(value.created_at)) {
    context.addIssue({ code: "custom", path: ["lease", "acquired_at"], message: "lease predates record" });
  }
  if (["prepared", "committing", "committed"].includes(value.state) && value.lease === null) {
    context.addIssue({ code: "custom", path: ["lease"], message: "active record requires a lease" });
  }
  if ((value.state === "committed") !== (value.receipt !== null)) {
    context.addIssue({ code: "custom", path: ["receipt"], message: "receipt must match committed state" });
  }
  if ((value.state === "failed") !== (value.failure_code !== null) ||
      value.state === "failed" && value.failure_code !== "REMOTE_ARCHIVE_PREPARE_EXPIRED") {
    context.addIssue({ code: "custom", path: ["failure_code"], message: "failure code must match failed state" });
  }
  if (value.receipt !== null && (value.receipt.operation_id !== value.operation_id || value.receipt.prepare_id !== value.prepare_id ||
      value.receipt.idempotency_key !== value.idempotency_key || value.receipt.payload_hash !== value.payload_hash ||
      value.receipt.archive_id !== value.archive_id || value.receipt.package_sha256 !== value.identities.package_sha256 ||
      value.receipt.package_size_bytes !== value.identities.package_size_bytes ||
      !sameCanonical(value.receipt.source, value.source) ||
      value.receipt.manifest_hash !== value.identities.manifest_hash ||
      value.receipt.trusted_package_receipt_hash !== value.identities.trusted_package_receipt_hash ||
      value.receipt.local_archive_receipt_hash !== value.identities.local_archive_receipt_hash ||
      value.receipt.inventory_hash !== value.identities.inventory_hash ||
      value.receipt.core_v2_projection_hash !== value.identities.core_v2_projection_hash ||
      Date.parse(value.receipt.stored_at) < Date.parse(value.created_at) ||
      Date.parse(value.receipt.stored_at) > Date.parse(value.updated_at))) {
    context.addIssue({ code: "custom", path: ["receipt"], message: "receipt identity mismatch" });
  }
  if (value.state === "pending" && (value.generation !== 0 || value.lease !== null || value.receipt !== null) ||
      value.state === "prepared" && (value.generation < 1 || value.receipt !== null) ||
      value.state === "committing" && (value.generation < 2 || value.receipt !== null) ||
      value.state === "committed" && value.generation < 3 ||
      value.state === "failed" && (value.generation < 2 || value.lease !== null || value.receipt !== null)) {
    context.addIssue({ code: "custom", path: ["state"], message: "record state closure mismatch" });
  }
  const { record_hash: recordHash, ...body } = value;
  if (recordHash !== remoteSyncArchiveHttpStableHash(body)) {
    context.addIssue({ code: "custom", path: ["record_hash"], message: "record hash mismatch" });
  }
});
export const remoteSyncArchiveClaimHttpSchema = z.object({
  operation_id: operationIdSchema, prepare_id: prepareIdSchema, source: remoteSyncArchiveSourceHttpSchema,
  generation: z.number().int().min(1), fencing_token: z.number().int().min(1),
  capability: boundedText(240).regex(/^remote_archive_capability:/u)
}).strict();

export const remoteSyncArchivePrepareHttpRequestStructureSchema = z.object({
  schema_version: z.literal(2), operation_id: operationIdSchema, idempotency_key: sha256Schema,
  payload_hash: sha256Schema, lease_ttl_ms: z.number().int().min(1).max(10 * 60_000),
  metadata: remoteSyncArchiveMetadataHttpSchema
}).strict();
export const remoteSyncArchivePrepareHttpRequestSchema = remoteSyncArchivePrepareHttpRequestStructureSchema.superRefine((value, context) => {
  if (value.payload_hash !== remoteSyncArchiveHttpStableHash(value.metadata)) {
    context.addIssue({ code: "custom", path: ["payload_hash"], message: "payload hash mismatch" });
  }
});
export const remoteSyncArchivePrepareHttpResponseSchema = z.object({
  outcome: z.enum(["new", "replay"]), claim: remoteSyncArchiveClaimHttpSchema.nullable(), record: remoteSyncArchiveRecordHttpSchema
}).strict().superRefine((value, context) => {
  if ((value.outcome === "new") !== (value.claim !== null)) {
    context.addIssue({ code: "custom", path: ["claim"], message: "claim presence must match prepare outcome" });
    return;
  }
  if (value.claim !== null && (value.claim.operation_id !== value.record.operation_id || value.claim.prepare_id !== value.record.prepare_id ||
      value.claim.generation !== value.record.generation || value.claim.fencing_token !== value.record.lease?.fencing_token ||
      !sameCanonical(value.claim.source, value.record.source) ||
      value.record.lease?.capability_hash !== remoteSyncArchiveHttpStableHash(value.claim.capability))) {
    context.addIssue({ code: "custom", path: ["claim"], message: "claim identity mismatch" });
  }
});
export const remoteSyncArchiveCommitHttpRequestSchema = z.object({
  claim: remoteSyncArchiveClaimHttpSchema, idempotency_key: sha256Schema, payload_hash: sha256Schema
}).strict().superRefine((value, context) => {
  const expected = remoteSyncArchiveHttpStableHash({ operation_id: value.claim.operation_id,
    idempotency_key: value.idempotency_key, payload_hash: value.payload_hash });
  if (value.claim.prepare_id !== `remote_archive_prepare:${expected}`) {
    context.addIssue({ code: "custom", path: ["claim", "prepare_id"], message: "prepare identity mismatch" });
  }
});
export const remoteSyncArchiveCommitHttpResponseSchema = z.object({
  outcome: z.enum(["new", "replay"]), record: remoteSyncArchiveRecordHttpSchema,
  receipt: remoteSyncArchiveReceiptHttpSchema
}).strict().superRefine((value, context) => {
  if (value.record.state !== "committed" || value.record.receipt?.receipt_id !== value.receipt.receipt_id ||
      value.record.operation_id !== value.receipt.operation_id || !sameCanonical(value.record.receipt, value.receipt)) {
    context.addIssue({ code: "custom", path: ["receipt"], message: "commit receipt identity mismatch" });
  }
});
export const remoteSyncArchiveLookupHttpRequestSchema = z.object({
  operation_id: operationIdSchema, source: remoteSyncArchiveSourceHttpSchema
}).strict();
export const remoteSyncArchiveStatusHttpResponseSchema = z.object({
  operation_id: operationIdSchema, state: z.enum(["pending", "prepared", "committing", "committed", "failed", "unknown"]),
  record: remoteSyncArchiveRecordHttpSchema.nullable()
}).strict().superRefine((value, context) => {
  if ((value.state === "unknown") !== (value.record === null) ||
      value.record !== null && (value.record.operation_id !== value.operation_id || value.record.state !== value.state)) {
    context.addIssue({ code: "custom", path: ["record"], message: "status record identity mismatch" });
  }
});
export const remoteSyncArchiveReceiptHttpResponseSchema = z.object({ receipt: remoteSyncArchiveReceiptHttpSchema.nullable() }).strict();

export type RemoteSyncArchiveHttpValidation<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly reason_code: "REMOTE_SYNC_ARCHIVE_HTTP_INVALID" };

function snapshotRemoteSyncArchiveHttp(value: unknown): unknown {
  const seen = new WeakSet<object>(); let nodes = 0; let text = 0;
  const copy = (input: unknown, depth: number): unknown => {
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "string") { text += input.length;
      if (input.length > 8_192 || text > 32_768) throw new Error(); return input; }
    if (typeof input === "number") { if (!Number.isFinite(input)) throw new Error(); return input; }
    if (typeof input !== "object" || isRuntimeProxy(input) || depth > 16 || ++nodes > 2_048 || seen.has(input)) throw new Error();
    seen.add(input); const array = Array.isArray(input); const prototype = Object.getPrototypeOf(input);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(input); const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) throw new Error();
    for (const key of keys as string[]) { const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined ||
          (array && key === "length" ? false : descriptor.enumerable !== true)) throw new Error(); }
    if (array) { const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > 128 || keys.length !== length + 1) throw new Error();
      return Array.from({ length }, (_, index) => copy((descriptors[String(index)] as PropertyDescriptor).value, depth + 1)); }
    return Object.fromEntries((keys as string[]).map((key) =>
      [key, copy((descriptors[key] as PropertyDescriptor).value, depth + 1)]));
  };
  const result = copy(value, 0);
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 65_536) throw new Error();
  return result;
}

function safeArchiveHttpValidation<T>(schema: z.ZodType<T>, value: unknown): RemoteSyncArchiveHttpValidation<T> {
  try {
    const result = schema.safeParse(snapshotRemoteSyncArchiveHttp(value));
    return result.success ? Object.freeze({ success: true as const, data: result.data }) :
      Object.freeze({ success: false as const, reason_code: "REMOTE_SYNC_ARCHIVE_HTTP_INVALID" as const });
  } catch {
    return Object.freeze({ success: false as const, reason_code: "REMOTE_SYNC_ARCHIVE_HTTP_INVALID" as const });
  }
}

export const validateRemoteSyncArchiveErrorEnvelope = (value: unknown) =>
  safeArchiveHttpValidation(remoteSyncArchiveHttpErrorEnvelopeSchema, value);
export const validateRemoteSyncArchivePrepareHttpRequest = (value: unknown) =>
  safeArchiveHttpValidation(remoteSyncArchivePrepareHttpRequestSchema, value);
export const validateRemoteSyncArchivePrepareHttpRequestStructure = (value: unknown) =>
  safeArchiveHttpValidation(remoteSyncArchivePrepareHttpRequestStructureSchema, value);
export const validateRemoteSyncArchivePrepareHttpResponse = (value: unknown) =>
  safeArchiveHttpValidation(remoteSyncArchivePrepareHttpResponseSchema, value);
export const validateRemoteSyncArchiveCommitHttpRequest = (value: unknown) =>
  safeArchiveHttpValidation(remoteSyncArchiveCommitHttpRequestSchema, value);
export const validateRemoteSyncArchiveCommitHttpResponse = (value: unknown) =>
  safeArchiveHttpValidation(remoteSyncArchiveCommitHttpResponseSchema, value);
export const validateRemoteSyncArchiveLookupHttpRequest = (value: unknown) =>
  safeArchiveHttpValidation(remoteSyncArchiveLookupHttpRequestSchema, value);
export const validateRemoteSyncArchiveStatusHttpResponse = (value: unknown) =>
  safeArchiveHttpValidation(remoteSyncArchiveStatusHttpResponseSchema, value);
export const validateRemoteSyncArchiveReceiptHttpResponse = (value: unknown) =>
  safeArchiveHttpValidation(remoteSyncArchiveReceiptHttpResponseSchema, value);

const unauthorized = Object.freeze(["AUTH_REQUIRED", "TOKEN_INVALID", "SESSION_INVALID"] as const);
const forbidden = Object.freeze(["PROJECT_INFORMATION_FORBIDDEN", "PROJECT_KEY_SCOPE", "PROJECT_KEY_MISMATCH"] as const);
const validation = Object.freeze(["VALIDATION_FAILED", "REMOTE_ARCHIVE_INPUT_INVALID"] as const);
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
const operation = <const T extends object>(value: T, errors: Readonly<Record<number, readonly string[]>>) => Object.freeze({
  ...value,
  request_id_header: "X-Request-Id" as const,
  errors: Object.freeze(errors)
});

export const REMOTE_SYNC_ARCHIVE_HTTP_OPERATIONS = Object.freeze({
  prepare_archive: operation({ method: "POST" as const,
    path: "/api/v1/projects/{project_id}/branches/{branch_name}/remote-sync/archive:prepare" as const,
    operation_id: "prepareRemoteSyncArchive" as const, request_placement: "path_and_json_body" as const,
    auth: writeAuth, request_schema: "RemoteSyncArchivePrepareHttpRequest" as const,
    idempotency_header: "Idempotency-Key" as const, success_status: 201 as const, replay_status: 200 as const,
    identity_bindings: Object.freeze([
      Object.freeze(["path.project_id", "body.metadata.source.project_id"] as const),
      Object.freeze(["path.branch_name", "body.metadata.source.branch_name"] as const),
      Object.freeze(["auth.actor_id", "body.metadata.source.actor_id"] as const),
      Object.freeze(["header.Idempotency-Key", "body.idempotency_key"] as const)
    ]),
    success_schema: "RemoteSyncArchivePrepareHttpResponse" as const }, {
    400: validation, 401: unauthorized, 403: forbidden,
    409: Object.freeze(["REMOTE_ARCHIVE_IDEMPOTENCY_CONFLICT", "REMOTE_ARCHIVE_CAPABILITY_UNAVAILABLE"] as const),
    422: Object.freeze(["REMOTE_ARCHIVE_PAYLOAD_HASH_MISMATCH"] as const), 503: unavailable
  }),
  commit_archive: operation({ method: "POST" as const,
    path: "/api/v1/projects/{project_id}/branches/{branch_name}/remote-sync/archive:commit" as const,
    operation_id: "commitRemoteSyncArchive" as const, request_placement: "path_and_json_body" as const,
    auth: writeAuth, request_schema: "RemoteSyncArchiveCommitHttpRequest" as const,
    idempotency_header: "Idempotency-Key" as const,
    identity_bindings: Object.freeze([
      Object.freeze(["path.project_id", "body.claim.source.project_id"] as const),
      Object.freeze(["path.branch_name", "body.claim.source.branch_name"] as const),
      Object.freeze(["auth.actor_id", "body.claim.source.actor_id"] as const),
      Object.freeze(["header.Idempotency-Key", "body.idempotency_key"] as const)
    ]),
    success_status: 200 as const, replay_status: 200 as const,
    success_schema: "RemoteSyncArchiveCommitHttpResponse" as const }, {
    400: validation, 401: unauthorized, 403: forbidden,
    404: Object.freeze(["REMOTE_ARCHIVE_PREPARE_NOT_FOUND"] as const),
    409: Object.freeze(["REMOTE_ARCHIVE_LEASE_FENCED", "REMOTE_ARCHIVE_LEASE_SCOPE_MISMATCH",
      "REMOTE_ARCHIVE_CAPABILITY_UNAVAILABLE", "REMOTE_ARCHIVE_COMMIT_AMBIGUOUS"] as const),
    410: Object.freeze(["REMOTE_ARCHIVE_PREPARE_EXPIRED"] as const), 503: unavailable
  }),
  archive_status: operation({ method: "GET" as const,
    path: "/api/v1/projects/{project_id}/branches/{branch_name}/remote-sync/archive/status" as const,
    operation_id: "getRemoteSyncArchiveStatus" as const, request_placement: "path_and_query" as const,
    auth: readAuth, request_schema: "RemoteSyncArchiveLookupHttpRequest" as const,
    identity_bindings: Object.freeze([
      Object.freeze(["path.project_id", "query.source.project_id"] as const),
      Object.freeze(["path.branch_name", "query.source.branch_name"] as const),
      Object.freeze(["auth.actor_id", "query.source.actor_id"] as const)
    ]),
    success_status: 200 as const, success_schema: "RemoteSyncArchiveStatusHttpResponse" as const }, {
    400: validation, 401: unauthorized, 403: forbidden,
    409: Object.freeze(["REMOTE_ARCHIVE_LEASE_SCOPE_MISMATCH"] as const), 503: unavailable
  }),
  archive_receipt: operation({ method: "GET" as const,
    path: "/api/v1/projects/{project_id}/branches/{branch_name}/remote-sync/archive/{operation_id}/receipt" as const,
    operation_id: "getRemoteSyncArchiveReceipt" as const, request_placement: "path_and_query" as const,
    auth: readAuth, request_schema: "RemoteSyncArchiveLookupHttpRequest" as const,
    identity_bindings: Object.freeze([
      Object.freeze(["path.project_id", "query.source.project_id"] as const),
      Object.freeze(["path.branch_name", "query.source.branch_name"] as const),
      Object.freeze(["path.operation_id", "query.operation_id"] as const),
      Object.freeze(["auth.actor_id", "query.source.actor_id"] as const)
    ]),
    success_status: 200 as const, success_schema: "RemoteSyncArchiveReceiptHttpResponse" as const }, {
    400: validation, 401: unauthorized, 403: forbidden,
    409: Object.freeze(["REMOTE_ARCHIVE_LEASE_SCOPE_MISMATCH"] as const), 503: unavailable
  })
});

export type RemoteSyncArchiveHttpErrorCode = z.infer<typeof remoteSyncArchiveHttpErrorCodeSchema>;
export type RemoteSyncArchiveHttpScope = z.infer<typeof remoteSyncArchiveHttpScopeSchema>;
export type RemoteSyncArchiveHttpAuth = z.infer<typeof remoteSyncArchiveHttpAuthSchema>;
export type RemoteSyncArchiveHttpErrorEnvelope = z.infer<typeof remoteSyncArchiveHttpErrorEnvelopeSchema>;
export type RemoteSyncArchiveSourceHttp = z.infer<typeof remoteSyncArchiveSourceHttpSchema>;
export type RemoteSyncArchiveUploadRefHttp = z.infer<typeof remoteSyncArchiveUploadRefHttpSchema>;
export type RemoteSyncArchiveIdentitiesHttp = z.infer<typeof remoteSyncArchiveIdentitiesHttpSchema>;
export type RemoteSyncArchiveMetadataHttp = z.infer<typeof remoteSyncArchiveMetadataHttpSchema>;
export type RemoteSyncArchiveLeaseHttp = z.infer<typeof remoteSyncArchiveLeaseHttpSchema>;
export type RemoteSyncArchiveReceiptHttp = z.infer<typeof remoteSyncArchiveReceiptHttpSchema>;
export type RemoteSyncArchiveRecordHttp = z.infer<typeof remoteSyncArchiveRecordHttpSchema>;
export type RemoteSyncArchiveClaimHttp = z.infer<typeof remoteSyncArchiveClaimHttpSchema>;
export type RemoteSyncArchivePrepareHttpRequest = z.infer<typeof remoteSyncArchivePrepareHttpRequestSchema>;
export type RemoteSyncArchivePrepareHttpResponse = z.infer<typeof remoteSyncArchivePrepareHttpResponseSchema>;
export type RemoteSyncArchiveCommitHttpRequest = z.infer<typeof remoteSyncArchiveCommitHttpRequestSchema>;
export type RemoteSyncArchiveCommitHttpResponse = z.infer<typeof remoteSyncArchiveCommitHttpResponseSchema>;
export type RemoteSyncArchiveLookupHttpRequest = z.infer<typeof remoteSyncArchiveLookupHttpRequestSchema>;
export type RemoteSyncArchiveStatusHttpResponse = z.infer<typeof remoteSyncArchiveStatusHttpResponseSchema>;
export type RemoteSyncArchiveReceiptHttpResponse = z.infer<typeof remoteSyncArchiveReceiptHttpResponseSchema>;
