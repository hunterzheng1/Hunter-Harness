import { z } from "zod";

const SCHEMA_VERSION = 1 as const;
const MAX_RESULTS = 10;
const MAX_SUMMARY_BYTES = 65_536;
const MAX_QUERY_BYTES = 4_096;
const MAX_QUERY_ID = 160;
const MAX_PROJECT_ID = 128;
const MAX_IDEMPOTENCY_KEY = 240;

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const requestIdSchema = z.uuid();
const printableHeaderValueSchema = z.string().min(1).max(MAX_IDEMPOTENCY_KEY)
  .regex(/^[\x21-\x7e]+$/u);

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedText(maximum: number, minimum = 1) {
  return z.string().min(minimum).max(maximum)
    .refine((value) => value === value.trim(), "text must be trimmed")
    .refine((value) => value === value.normalize("NFC"), "text must be NFC")
    .refine((value) => !hasControlCharacter(value) && !hasLoneSurrogate(value), "text contains an unsafe character");
}

const projectIdSchema = boundedText(MAX_PROJECT_ID).regex(/^prj_[A-Za-z0-9_-]{1,124}$/u);
const queryIdSchema = z.string().regex(/^knowledge_query:[a-f0-9]{64}$/u).max(MAX_QUERY_ID);
const receiptIdSchema = z.string().regex(/^knowledge_query_receipt:[a-f0-9]{64}$/u).max(192);
const sourceVersionSchema = boundedText(128);
const resultIdSchema = boundedText(256);
const indexGenerationSchema = boundedText(128);
const reasonCodeSchema = z.enum(["initial_intent", "directed_evidence_followup"]);
const resultKindSchema = z.enum([
  "archive_knowledge",
  "implementation_fact",
  "design",
  "rule",
  "change_document"
]);
const relevanceSchema = z.enum(["high", "medium", "low"]);
const queryBudgetSchema = z.object({
  max_results: z.number().int().min(1).max(MAX_RESULTS),
  max_total_summary_bytes: z.number().int().min(1).max(MAX_SUMMARY_BYTES),
  deadline_ms: z.number().int().min(1).max(60_000)
}).strict();

export const knowledgeQueryHttpRequestSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  project_id: projectIdSchema,
  query_id: queryIdSchema,
  query_hash: sha256Schema,
  reason_code: reasonCodeSchema,
  query: boundedText(MAX_QUERY_BYTES),
  budget: queryBudgetSchema
}).strict().superRefine((value, context) => {
  if (value.query_id.slice("knowledge_query:".length) !== value.query_hash.slice("sha256:".length)) {
    context.addIssue({ code: "custom", path: ["query_id"], message: "query_id must bind query_hash" });
  }
  if (utf8Bytes(value.query) > MAX_QUERY_BYTES) {
    context.addIssue({ code: "too_big", origin: "string", maximum: MAX_QUERY_BYTES, inclusive: true,
      path: ["query"], message: "query exceeds the UTF-8 byte limit" });
  }
});

const resultSchema = z.object({
  result_id: resultIdSchema,
  kind: resultKindSchema,
  summary: boundedText(1_024),
  relevance: relevanceSchema,
  source: boundedText(256).optional(),
  verified_at: z.iso.datetime().optional(),
  source_version: sourceVersionSchema.optional(),
  conflicts_with_intent: z.boolean(),
  conflict_summary: boundedText(1_024).optional()
}).strict().superRefine((value, context) => {
  if (value.conflicts_with_intent && value.conflict_summary === undefined) {
    context.addIssue({ code: "custom", path: ["conflict_summary"], message: "conflicts require a summary" });
  }
  if (!value.conflicts_with_intent && value.conflict_summary !== undefined) {
    context.addIssue({ code: "custom", path: ["conflict_summary"], message: "non-conflicting results cannot carry a conflict summary" });
  }
  if (utf8Bytes(value.summary) > 1_024) {
    context.addIssue({ code: "too_big", origin: "string", maximum: 1_024, inclusive: true,
      path: ["summary"], message: "summary exceeds the UTF-8 byte limit" });
  }
});

const sortedUniqueStrings = (values: readonly string[]): boolean => {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous === undefined || current === undefined || previous >= current) return false;
  }
  return true;
};

function compareCodepoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodepoint);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => compareCodepoint(left, right))
      .map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

function stableHash(value: unknown): `sha256:${string}` {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)));
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const bitLength = bytes.length * 8;
  const lengthView = new DataView(padded.buffer);
  lengthView.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  lengthView.setUint32(paddedLength - 4, bitLength >>> 0);

  const roundConstants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  let [a, b, c, d, e, f, g, h] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ];
  const rotateRight = (value: number, amount: number): number =>
    (value >>> amount) | (value << (32 - amount));
  const requiredWord = (value: number | undefined): number => {
    if (value === undefined) throw new Error("invalid SHA-256 schedule");
    return value;
  };
  const schedule = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      schedule[index] = lengthView.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const left = requiredWord(schedule[index - 15]);
      const right = requiredWord(schedule[index - 2]);
      const smallSigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
      const smallSigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
      schedule[index] = (requiredWord(schedule[index - 16]) + smallSigma0 +
        requiredWord(schedule[index - 7]) + smallSigma1) >>> 0;
    }
    let [aa, bb, cc, dd, ee, ff, gg, hh] = [a, b, c, d, e, f, g, h];
    for (let index = 0; index < 64; index += 1) {
      const bigSigma1 = rotateRight(ee, 6) ^ rotateRight(ee, 11) ^ rotateRight(ee, 25);
      const choose = (ee & ff) ^ (~ee & gg);
      const temp1 = (hh + bigSigma1 + choose + requiredWord(roundConstants[index]) +
        requiredWord(schedule[index])) >>> 0;
      const bigSigma0 = rotateRight(aa, 2) ^ rotateRight(aa, 13) ^ rotateRight(aa, 22);
      const majority = (aa & bb) ^ (aa & cc) ^ (bb & cc);
      const temp2 = (bigSigma0 + majority) >>> 0;
      [hh, gg, ff, ee, dd, cc, bb, aa] = [gg, ff, ee, (dd + temp1) >>> 0, cc, bb, aa, (temp1 + temp2) >>> 0];
    }
    a = (a + aa) >>> 0;
    b = (b + bb) >>> 0;
    c = (c + cc) >>> 0;
    d = (d + dd) >>> 0;
    e = (e + ee) >>> 0;
    f = (f + ff) >>> 0;
    g = (g + gg) >>> 0;
    h = (h + hh) >>> 0;
  }
  const hex = [a, b, c, d, e, f, g, h].map((value) => value.toString(16).padStart(8, "0")).join("");
  return `sha256:${hex}`;
}

export function knowledgeQueryHttpResultSetHash(input: Pick<KnowledgeQueryHttpReceipt,
  "index_generation" | "result_ids" | "source_versions"
>): `sha256:${string}` {
  return stableHash({
    index_generation: input.index_generation ?? null,
    result_ids: sortedUnique(input.result_ids),
    source_versions: sortedUnique(input.source_versions)
  });
}

export function knowledgeQueryHttpReceiptId(
  input: Omit<KnowledgeQueryHttpReceipt, "receipt_id">
): `knowledge_query_receipt:${string}` {
  return `knowledge_query_receipt:${stableHash({
    schema_version: input.schema_version,
    query_hash: input.query_hash,
    project_id: input.project_id,
    index_generation: input.index_generation ?? null,
    result_ids: sortedUnique(input.result_ids),
    source_versions: sortedUnique(input.source_versions),
    result_set_hash: input.result_set_hash,
    status: input.status,
    executed_at: input.executed_at,
    reason_code: input.reason_code,
    failure_code: input.failure_code ?? null,
    supersedes: input.supersedes ?? null
  }).slice("sha256:".length)}`;
}

const receiptSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  receipt_id: receiptIdSchema,
  query_hash: sha256Schema,
  project_id: projectIdSchema,
  index_generation: indexGenerationSchema.optional(),
  result_ids: z.array(resultIdSchema).max(MAX_RESULTS),
  source_versions: z.array(sourceVersionSchema).max(MAX_RESULTS),
  result_set_hash: sha256Schema,
  status: z.enum(["succeeded", "failed"]),
  executed_at: z.iso.datetime(),
  reason_code: z.union([reasonCodeSchema, z.literal("remote_knowledge_unavailable")]),
  failure_code: boundedText(128).optional(),
  supersedes: receiptIdSchema.optional()
}).strict().superRefine((value, context) => {
  if (!sortedUniqueStrings(value.result_ids)) {
    context.addIssue({ code: "custom", path: ["result_ids"], message: "result_ids must be sorted and unique" });
  }
  if (!sortedUniqueStrings(value.source_versions)) {
    context.addIssue({ code: "custom", path: ["source_versions"], message: "source_versions must be sorted and unique" });
  }
  if (value.status === "failed") {
    if (value.reason_code !== "remote_knowledge_unavailable" || value.failure_code === undefined ||
        value.result_ids.length !== 0 || value.source_versions.length !== 0) {
      context.addIssue({ code: "custom", path: ["status"], message: "failed receipts must be zero-result unavailable receipts" });
    }
  } else if (value.reason_code === "remote_knowledge_unavailable" || value.failure_code !== undefined) {
    context.addIssue({ code: "custom", path: ["reason_code"], message: "successful receipts cannot carry failure semantics" });
  }
  if (value.result_set_hash !== knowledgeQueryHttpResultSetHash(value)) {
    context.addIssue({ code: "custom", path: ["result_set_hash"], message: "result_set_hash identity drift" });
  }
  if (value.receipt_id !== knowledgeQueryHttpReceiptId(value)) {
    context.addIssue({ code: "custom", path: ["receipt_id"], message: "receipt_id identity drift" });
  }
});

export const knowledgeQueryHttpResponseSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  query_id: queryIdSchema,
  project_id: projectIdSchema,
  receipt: receiptSchema,
  results: z.array(resultSchema).max(MAX_RESULTS)
}).strict().superRefine((value, context) => {
  if (value.receipt.project_id !== value.project_id) {
    context.addIssue({ code: "custom", path: ["receipt", "project_id"], message: "receipt project mismatch" });
  }
  const resultIds = value.results.map((result) => result.result_id);
  if (new Set(resultIds).size !== resultIds.length) {
    context.addIssue({ code: "custom", path: ["results"], message: "result ids must be unique" });
  }
  if (value.receipt.status === "failed" && value.results.length !== 0) {
    context.addIssue({ code: "custom", path: ["results"], message: "failed responses cannot contain results" });
  }
  if (value.receipt.status === "succeeded") {
    if (JSON.stringify(resultIds) !== JSON.stringify(value.receipt.result_ids)) {
      context.addIssue({ code: "custom", path: ["receipt", "result_ids"], message: "receipt result ids mismatch" });
    }
    const sourceVersions = [...new Set(value.results.flatMap((result) =>
      result.source_version === undefined ? [] : [result.source_version]))].sort();
    if (JSON.stringify(sourceVersions) !== JSON.stringify(value.receipt.source_versions)) {
      context.addIssue({ code: "custom", path: ["receipt", "source_versions"], message: "receipt source versions mismatch" });
    }
  }
  const summaryBytes = value.results.reduce((total, result) => total + utf8Bytes(result.summary), 0);
  if (summaryBytes > MAX_SUMMARY_BYTES) {
    context.addIssue({ code: "too_big", origin: "array", maximum: MAX_SUMMARY_BYTES, inclusive: true,
      path: ["results"], message: "summaries exceed the response byte budget" });
  }
});

export type KnowledgeQueryHttpRequest = z.infer<typeof knowledgeQueryHttpRequestSchema>;
export type KnowledgeQueryHttpResponse = z.infer<typeof knowledgeQueryHttpResponseSchema>;
export type KnowledgeQueryHttpReceipt = z.infer<typeof receiptSchema>;
export type KnowledgeQueryHttpResult = z.infer<typeof resultSchema>;

export function validateKnowledgeQueryHttpResponse(
  response: unknown,
  request: unknown
): { readonly success: true; readonly data: KnowledgeQueryHttpResponse } | { readonly success: false } {
  try {
    const parsedRequest = knowledgeQueryHttpRequestSchema.safeParse(request);
    const parsedResponse = knowledgeQueryHttpResponseSchema.safeParse(response);
    if (!parsedRequest.success || !parsedResponse.success) return { success: false };
    const value = parsedResponse.data;
    if (value.query_id !== parsedRequest.data.query_id || value.project_id !== parsedRequest.data.project_id ||
        value.receipt.query_hash !== parsedRequest.data.query_hash ||
        (value.receipt.status === "succeeded"
          ? value.receipt.reason_code !== parsedRequest.data.reason_code
          : value.receipt.reason_code !== "remote_knowledge_unavailable")) {
      return { success: false };
    }
    if (value.results.reduce((total, result) => total + utf8Bytes(result.summary), 0) >
        parsedRequest.data.budget.max_total_summary_bytes ||
        value.results.length > parsedRequest.data.budget.max_results) {
      return { success: false };
    }
    return { success: true, data: value };
  } catch {
    return { success: false };
  }
}

export const knowledgeQueryHttpRequestHeadersSchema = z.object({
  "X-Request-Id": requestIdSchema.optional(),
  "Idempotency-Key": printableHeaderValueSchema.optional()
}).strict();

const knowledgeQueryHttpErrorCodeValues = [
  "AUTH_REQUIRED",
  "TOKEN_INVALID",
  "SESSION_INVALID",
  "PROJECT_INFORMATION_FORBIDDEN",
  "PROJECT_KEY_SCOPE",
  "PROJECT_KEY_MISMATCH",
  "KNOWLEDGE_QUERY_INVALID",
  "KNOWLEDGE_QUERY_TIMEOUT",
  "KNOWLEDGE_QUERY_ABORTED",
  "KNOWLEDGE_QUERY_SNAPSHOT_STALE",
  "KNOWLEDGE_QUERY_RECEIPT_INVALID",
  "KNOWLEDGE_QUERY_IDEMPOTENCY_CONFLICT",
  "REMOTE_UNAVAILABLE"
] as const;

export const knowledgeQueryHttpErrorCodeSchema = z.enum(knowledgeQueryHttpErrorCodeValues);
export type KnowledgeQueryHttpErrorCode = z.infer<typeof knowledgeQueryHttpErrorCodeSchema>;

export const knowledgeQueryHttpErrorEnvelopeSchema = z.object({
  error: z.object({
    code: knowledgeQueryHttpErrorCodeSchema,
    message: boundedText(2_000),
    request_id: requestIdSchema,
    outcome: z.enum(["new", "replay", "conflict"]).optional(),
    details: z.record(z.string().min(1).max(64), z.unknown()).optional()
  }).strict()
}).strict();

const unauthorized = Object.freeze(["AUTH_REQUIRED", "TOKEN_INVALID", "SESSION_INVALID"] as const);
const forbidden = Object.freeze(["PROJECT_INFORMATION_FORBIDDEN", "PROJECT_KEY_SCOPE", "PROJECT_KEY_MISMATCH"] as const);
const invalid = Object.freeze(["KNOWLEDGE_QUERY_INVALID"] as const);
const queryAuth = Object.freeze({
  actor_source: "authenticated_principal" as const,
  project_allowlist_source: "server_authority" as const,
  project_key_scope: "knowledge:read" as const
});

const queryOperation = Object.freeze({
  method: "POST" as const,
  path: "/api/v1/projects/{project_id}/knowledge/query" as const,
  operation_id: "queryProjectKnowledge" as const,
  request_placement: "path_and_json_body" as const,
  auth: queryAuth,
  request_schema: "KnowledgeQueryHttpRequest" as const,
  idempotency_header: "Idempotency-Key" as const,
  request_id_header: "X-Request-Id" as const,
  success_status: 201 as const,
  replay_status: 200 as const,
  success_schema: "KnowledgeQueryHttpResponse" as const
});

export const KNOWLEDGE_QUERY_HTTP_OPERATIONS = Object.freeze({
  query: Object.freeze({
    ...queryOperation,
    errors: Object.freeze({
      400: invalid,
      401: unauthorized,
      403: forbidden,
      409: Object.freeze(["KNOWLEDGE_QUERY_IDEMPOTENCY_CONFLICT", "KNOWLEDGE_QUERY_SNAPSHOT_STALE"] as const),
      422: Object.freeze(["KNOWLEDGE_QUERY_RECEIPT_INVALID"] as const),
      499: Object.freeze(["KNOWLEDGE_QUERY_ABORTED"] as const),
      503: Object.freeze(["REMOTE_UNAVAILABLE", "KNOWLEDGE_QUERY_TIMEOUT"] as const)
    })
  })
});

export type KnowledgeQueryHttpOperation = typeof KNOWLEDGE_QUERY_HTTP_OPERATIONS.query;
export type KnowledgeQueryReasonCode = "initial_intent" | "directed_evidence_followup";
