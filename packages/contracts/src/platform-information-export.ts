import { z } from "zod";

import { canonicalJson } from "./canonical-json.js";
import {
  platformInformationExportResultSchema,
  platformInformationItemSchema,
  platformInformationQueryScopeSchema,
  platformInformationSortSchema,
  platformInformationViewSchema,
} from "./platform-information.js";

const schemaVersionSchema = z.literal(1);
const idSchema = z.string().min(1).max(160);
const projectIdSchema = z.string().regex(/^prj_[A-Za-z0-9_-]{1,156}$/u);
const hashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const timestampSchema = z.iso.datetime({ offset: true });
const cursorSchema = z.string().regex(/^[A-Za-z0-9_-]{16,512}$/u).nullable();
export const PLATFORM_INFORMATION_EXPORT_FORMAT = "canonical_jsonl_v1" as const;
export const PLATFORM_INFORMATION_EXPORT_MEDIA_TYPE = "application/x-ndjson" as const;
export const PLATFORM_INFORMATION_EXPORT_LIMITS = Object.freeze({
  receipt_bytes: 2_000_000,
  artifact_bytes: 512 * 1024 * 1024,
  chunk_bytes: 1024 * 1024,
  items: 1_000_000,
  pages: 10_000,
});
const maximumReceiptBytes = PLATFORM_INFORMATION_EXPORT_LIMITS.receipt_bytes;
const maximumArtifactBytes = PLATFORM_INFORMATION_EXPORT_LIMITS.artifact_bytes;
const maximumExportItems = PLATFORM_INFORMATION_EXPORT_LIMITS.items;
const maximumExportPages = PLATFORM_INFORMATION_EXPORT_LIMITS.pages;
const maximumLineCharacters = 2_000_000;

export const platformInformationExportRangeSchema = z.object({
  query_scope: platformInformationQueryScopeSchema,
  limit: z.number().int().min(1).max(100),
  source_cursor: cursorSchema,
  cursor_verification: z.literal("server_port_required"),
  sort: platformInformationSortSchema,
}).strict();

const exportPageProofSchema = z.object({
  request_cursor: cursorSchema,
  response_next_cursor: cursorSchema,
  result_count: z.number().int().min(0).max(100),
}).strict();

export const platformInformationExportM4ProofSchema = z.object({
  pages: z.array(exportPageProofSchema).min(1).max(maximumExportPages),
  exported_count: z.number().int().min(0).max(maximumExportItems),
  items_sha: hashSchema,
  completed: z.literal(true),
}).strict();

export const platformInformationExportArtifactSummarySchema = z.object({
  format: z.literal(PLATFORM_INFORMATION_EXPORT_FORMAT),
  media_type: z.literal(PLATFORM_INFORMATION_EXPORT_MEDIA_TYPE),
  content_sha: hashSchema,
  items_sha: hashSchema,
  byte_count: z.number().int().min(1).max(maximumArtifactBytes),
  item_count: z.number().int().min(0).max(maximumExportItems),
  page_count: z.number().int().min(1).max(maximumExportPages),
}).strict();

export const platformInformationExportDownloadRefSchema = z.object({
  export_id: idSchema,
  project_id: projectIdSchema,
  content_sha: hashSchema,
}).strict();

export const platformInformationExportArtifactReceiptSchema = z.object({
  schema_version: schemaVersionSchema,
  contract_kind: z.literal("platform_information_export_artifact_receipt"),
  export_id: idSchema,
  project_id: projectIdSchema,
  view: platformInformationViewSchema,
  range: platformInformationExportRangeSchema,
  m4_proof: platformInformationExportM4ProofSchema,
  proof_sha: hashSchema,
  artifact: platformInformationExportArtifactSummarySchema,
  download_ref: platformInformationExportDownloadRefSchema,
  status: z.literal("ready"),
  created_at: timestampSchema,
  expires_at: timestampSchema,
}).strict().superRefine((value, context) => {
  const m4Result = platformInformationExportResultSchema.safeParse({
    schema_version: 1,
    contract_kind: "export_all_result",
    view: value.view,
    project_id: value.project_id,
    range: value.range,
    pages: value.m4_proof.pages,
    exported_count: value.m4_proof.exported_count,
    completed: value.m4_proof.completed,
  });
  if (!m4Result.success) {
    context.addIssue({ code: "custom", path: ["m4_proof"], message: "M4 proof does not match range" });
  }
  if (value.artifact.item_count !== value.m4_proof.exported_count ||
      value.artifact.page_count !== value.m4_proof.pages.length ||
      value.artifact.items_sha !== value.m4_proof.items_sha) {
    context.addIssue({ code: "custom", path: ["artifact"], message: "artifact counts do not match M4 proof" });
  }
  if (value.download_ref.export_id !== value.export_id ||
      value.download_ref.project_id !== value.project_id ||
      value.download_ref.content_sha !== value.artifact.content_sha) {
    context.addIssue({ code: "custom", path: ["download_ref"], message: "download identity does not match artifact" });
  }
  if (Date.parse(value.created_at) >= Date.parse(value.expires_at)) {
    context.addIssue({ code: "custom", path: ["expires_at"], message: "expires_at must be later than created_at" });
  }
});

export const platformInformationExportManifestLineSchema = z.object({
  schema_version: schemaVersionSchema,
  line_kind: z.literal("manifest"),
  format: z.literal(PLATFORM_INFORMATION_EXPORT_FORMAT),
  export_id: idSchema,
  project_id: projectIdSchema,
  view: platformInformationViewSchema,
  range: platformInformationExportRangeSchema,
  m4_proof: platformInformationExportM4ProofSchema,
  proof_sha: hashSchema,
  created_at: timestampSchema,
  expires_at: timestampSchema,
}).strict();

export const platformInformationExportItemLineSchema = z.object({
  schema_version: schemaVersionSchema,
  line_kind: z.literal("item"),
  ordinal: z.number().int().min(1).max(maximumExportItems),
  item_sha: hashSchema,
  item: platformInformationItemSchema,
}).strict();

export const platformInformationExportFooterLineSchema = z.object({
  schema_version: schemaVersionSchema,
  line_kind: z.literal("footer"),
  export_id: idSchema,
  proof_sha: hashSchema,
  items_sha: hashSchema,
  item_count: z.number().int().min(0).max(maximumExportItems),
  page_count: z.number().int().min(1).max(maximumExportPages),
}).strict();

export const platformInformationExportJsonlLineSchema = z.discriminatedUnion("line_kind", [
  platformInformationExportManifestLineSchema,
  platformInformationExportItemLineSchema,
  platformInformationExportFooterLineSchema,
]);

export const legacyPlatformInformationExportArtifactReceiptSchema = z.object({
  schemaVersion: z.literal(0),
  exportId: idSchema,
  projectId: projectIdSchema,
  format: z.literal("json"),
  createdAt: timestampSchema,
}).strict();

export type PlatformInformationExportArtifactReceipt = z.infer<typeof platformInformationExportArtifactReceiptSchema>;
export type PlatformInformationExportManifestLine = z.infer<typeof platformInformationExportManifestLineSchema>;
export type PlatformInformationExportItemLine = z.infer<typeof platformInformationExportItemLineSchema>;
export type PlatformInformationExportFooterLine = z.infer<typeof platformInformationExportFooterLineSchema>;
export type LegacyPlatformInformationExportArtifactReceipt = z.infer<typeof legacyPlatformInformationExportArtifactReceiptSchema>;

export interface PlatformInformationExportHashSession {
  update(chunk: Uint8Array): void | Promise<void>;
  digest(): string | Promise<string>;
}

/** Browser and server adapters provide hashing; this contracts Module imports no runtime crypto implementation. */
export interface PlatformInformationExportHashPort {
  sha256(bytes: Uint8Array): string | Promise<string>;
  create_sha256(): PlatformInformationExportHashSession;
}

/** A pull reader keeps backpressure and artifact storage outside this contracts Module. */
export interface PlatformInformationExportChunkReaderPort {
  read(): Uint8Array | null | Promise<Uint8Array | null>;
}

export type PlatformInformationExportReceiptReadResult =
  | { ok: true; mode: "current"; source_schema_version: 1; value: PlatformInformationExportArtifactReceipt }
  | { ok: true; mode: "legacy_read_only"; source_schema_version: 0; value: LegacyPlatformInformationExportArtifactReceipt }
  | { ok: false; reason_code:
      | "PLATFORM_INFORMATION_EXPORT_SERIALIZED_JSON_REQUIRED"
      | "PLATFORM_INFORMATION_EXPORT_SERIALIZED_JSON_TOO_LARGE"
      | "PLATFORM_INFORMATION_EXPORT_RECEIPT_INVALID"
      | "PLATFORM_INFORMATION_EXPORT_VERSION_UNSUPPORTED" };

export function readPlatformInformationExportArtifactReceipt(
  serialized_receipt: unknown,
): PlatformInformationExportReceiptReadResult {
  if (typeof serialized_receipt !== "string") {
    return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_SERIALIZED_JSON_REQUIRED" };
  }
  if (new TextEncoder().encode(serialized_receipt).byteLength > maximumReceiptBytes) {
    return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_SERIALIZED_JSON_TOO_LARGE" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized_receipt) as unknown;
  } catch {
    return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_RECEIPT_INVALID" };
  }
  const current = platformInformationExportArtifactReceiptSchema.safeParse(parsed);
  if (current.success) {
    return { ok: true, mode: "current", source_schema_version: 1, value: current.data };
  }
  const legacy = legacyPlatformInformationExportArtifactReceiptSchema.safeParse(parsed);
  if (legacy.success) {
    return { ok: true, mode: "legacy_read_only", source_schema_version: 0, value: legacy.data };
  }
  if (parsed !== null && typeof parsed === "object" &&
      ((Object.hasOwn(parsed, "schema_version") && (parsed as { schema_version?: unknown }).schema_version !== 1) ||
       (Object.hasOwn(parsed, "schemaVersion") && (parsed as { schemaVersion?: unknown }).schemaVersion !== 0))) {
    return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_VERSION_UNSUPPORTED" };
  }
  return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_RECEIPT_INVALID" };
}

export function platformInformationExportProofPayload(
  receipt: Pick<PlatformInformationExportArtifactReceipt, "export_id" | "project_id" | "view" | "range" | "m4_proof">,
): unknown {
  return {
    schema_version: 1,
    export_id: receipt.export_id,
    project_id: receipt.project_id,
    view: receipt.view,
    range: receipt.range,
    m4_proof: receipt.m4_proof,
  };
}

export type PlatformInformationExportArtifactVerificationResult =
  | { ok: true; value: { receipt: PlatformInformationExportArtifactReceipt; item_count: number; byte_count: number } }
  | { ok: false; reason_code:
      | "PLATFORM_INFORMATION_EXPORT_SERIALIZED_JSON_REQUIRED"
      | "PLATFORM_INFORMATION_EXPORT_SERIALIZED_JSON_TOO_LARGE"
      | "PLATFORM_INFORMATION_EXPORT_RECEIPT_INVALID"
      | "PLATFORM_INFORMATION_EXPORT_LEGACY_READ_ONLY"
      | "PLATFORM_INFORMATION_EXPORT_PROOF_HASH_MISMATCH"
      | "PLATFORM_INFORMATION_EXPORT_HASH_PORT_FAILURE"
      | "PLATFORM_INFORMATION_EXPORT_READ_FAILURE"
      | "PLATFORM_INFORMATION_EXPORT_CHUNK_INVALID"
      | "PLATFORM_INFORMATION_EXPORT_TOO_LARGE"
      | "PLATFORM_INFORMATION_EXPORT_BYTE_COUNT_MISMATCH"
      | "PLATFORM_INFORMATION_EXPORT_UTF8_INVALID"
      | "PLATFORM_INFORMATION_EXPORT_LINE_INVALID"
      | "PLATFORM_INFORMATION_EXPORT_LINE_NOT_CANONICAL"
      | "PLATFORM_INFORMATION_EXPORT_MANIFEST_MISMATCH"
      | "PLATFORM_INFORMATION_EXPORT_ITEM_ORDINAL_INVALID"
      | "PLATFORM_INFORMATION_EXPORT_ITEM_HASH_MISMATCH"
      | "PLATFORM_INFORMATION_EXPORT_ITEM_VIEW_MISMATCH"
      | "PLATFORM_INFORMATION_EXPORT_FOOTER_MISMATCH"
      | "PLATFORM_INFORMATION_EXPORT_CONTENT_HASH_MISMATCH"
      | "PLATFORM_INFORMATION_EXPORT_ITEMS_HASH_MISMATCH"
      | "PLATFORM_INFORMATION_EXPORT_TRUNCATED" };

const expectedItemKind = {
  branch_monitor: "branch_monitor",
  branch_files: "branch_snapshot",
  project_materials: "project_material",
  project_knowledge: "knowledge_entry",
} as const;

function isHash(value: string): boolean {
  return hashSchema.safeParse(value).success;
}

async function hashBytes(
  port: PlatformInformationExportHashPort,
  bytes: Uint8Array,
): Promise<string | null> {
  try {
    const value = await port.sha256(bytes);
    return isHash(value) ? value : null;
  } catch {
    return null;
  }
}

export async function verifyPlatformInformationExportArtifact(
  serialized_receipt: unknown,
  ports: {
    readonly hash_port: PlatformInformationExportHashPort;
    readonly chunk_reader: PlatformInformationExportChunkReaderPort;
  },
): Promise<PlatformInformationExportArtifactVerificationResult> {
  const read = readPlatformInformationExportArtifactReceipt(serialized_receipt);
  if (!read.ok) {
    return { ok: false, reason_code: read.reason_code === "PLATFORM_INFORMATION_EXPORT_VERSION_UNSUPPORTED"
      ? "PLATFORM_INFORMATION_EXPORT_RECEIPT_INVALID"
      : read.reason_code === "PLATFORM_INFORMATION_EXPORT_SERIALIZED_JSON_REQUIRED" ||
        read.reason_code === "PLATFORM_INFORMATION_EXPORT_SERIALIZED_JSON_TOO_LARGE"
        ? read.reason_code
        : "PLATFORM_INFORMATION_EXPORT_RECEIPT_INVALID" };
  }
  if (read.mode === "legacy_read_only") {
    return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_LEGACY_READ_ONLY" };
  }
  const receipt = read.value;
  const encoder = new TextEncoder();
  const proofHash = await hashBytes(
    ports.hash_port,
    encoder.encode(canonicalJson(platformInformationExportProofPayload(receipt))),
  );
  if (proofHash === null) return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_HASH_PORT_FAILURE" };
  if (proofHash !== receipt.proof_sha) {
    return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_PROOF_HASH_MISMATCH" };
  }

  let contentHashSession: PlatformInformationExportHashSession;
  let itemsHashSession: PlatformInformationExportHashSession;
  try {
    contentHashSession = ports.hash_port.create_sha256();
    itemsHashSession = ports.hash_port.create_sha256();
  } catch {
    return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_HASH_PORT_FAILURE" };
  }
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let pending = "";
  let byteCount = 0;
  let lineCount = 0;
  let itemCount = 0;
  let footerSeen = false;

  const processLine = async (line: string): Promise<PlatformInformationExportArtifactVerificationResult | null> => {
    if (line.length === 0 || line.length > maximumLineCharacters || line.includes("\r")) {
      return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_LINE_INVALID" };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_LINE_INVALID" };
    }
    const parsed = platformInformationExportJsonlLineSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_LINE_INVALID" };
    const canonicalLine = canonicalJson(parsed.data);
    if (line !== canonicalLine) return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_LINE_NOT_CANONICAL" };
    const lineBytes = encoder.encode(`${canonicalLine}\n`);
    lineCount += 1;
    if (parsed.data.line_kind === "manifest") {
      if (lineCount !== 1 || footerSeen || canonicalJson(parsed.data) !== canonicalJson({
        schema_version: 1,
        line_kind: "manifest",
        format: receipt.artifact.format,
        export_id: receipt.export_id,
        project_id: receipt.project_id,
        view: receipt.view,
        range: receipt.range,
        m4_proof: receipt.m4_proof,
        proof_sha: receipt.proof_sha,
        created_at: receipt.created_at,
        expires_at: receipt.expires_at,
      })) return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_MANIFEST_MISMATCH" };
      return null;
    }
    if (parsed.data.line_kind === "item") {
      if (lineCount === 1 || footerSeen || parsed.data.ordinal !== itemCount + 1) {
        return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_ITEM_ORDINAL_INVALID" };
      }
      if (parsed.data.item.item_kind !== expectedItemKind[receipt.view]) {
        return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_ITEM_VIEW_MISMATCH" };
      }
      const itemHash = await hashBytes(ports.hash_port, encoder.encode(canonicalJson(parsed.data.item)));
      if (itemHash === null) return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_HASH_PORT_FAILURE" };
      if (itemHash !== parsed.data.item_sha) {
        return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_ITEM_HASH_MISMATCH" };
      }
      try {
        await itemsHashSession.update(lineBytes);
      } catch {
        return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_HASH_PORT_FAILURE" };
      }
      itemCount += 1;
      return null;
    }
    if (lineCount === 1 || footerSeen || parsed.data.export_id !== receipt.export_id ||
        parsed.data.proof_sha !== receipt.proof_sha ||
        parsed.data.items_sha !== receipt.artifact.items_sha ||
        parsed.data.item_count !== receipt.artifact.item_count ||
        parsed.data.page_count !== receipt.artifact.page_count ||
        parsed.data.item_count !== itemCount) {
      return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_FOOTER_MISMATCH" };
    }
    footerSeen = true;
    return null;
  };

  while (true) {
    let chunk: Uint8Array | null;
    try {
      chunk = await ports.chunk_reader.read();
    } catch {
      return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_READ_FAILURE" };
    }
    if (chunk === null) break;
    if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0 ||
        chunk.byteLength > PLATFORM_INFORMATION_EXPORT_LIMITS.chunk_bytes) {
      return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_CHUNK_INVALID" };
    }
    byteCount += chunk.byteLength;
    if (byteCount > maximumArtifactBytes || byteCount > receipt.artifact.byte_count) {
      return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_TOO_LARGE" };
    }
    try {
      await contentHashSession.update(chunk);
    } catch {
      return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_HASH_PORT_FAILURE" };
    }
    try {
      pending += decoder.decode(chunk, { stream: true });
    } catch {
      return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_UTF8_INVALID" };
    }
    if (pending.length > maximumLineCharacters && !pending.includes("\n")) {
      return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_LINE_INVALID" };
    }
    const complete = pending;
    let lineStart = 0;
    let newline = complete.indexOf("\n", lineStart);
    while (newline >= 0) {
      const line = complete.slice(lineStart, newline);
      const failure = await processLine(line);
      if (failure !== null) return failure;
      lineStart = newline + 1;
      newline = complete.indexOf("\n", lineStart);
    }
    pending = complete.slice(lineStart);
  }
  try {
    pending += decoder.decode();
  } catch {
    return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_UTF8_INVALID" };
  }
  if (byteCount !== receipt.artifact.byte_count) {
    return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_BYTE_COUNT_MISMATCH" };
  }
  if (pending.length !== 0 || lineCount === 0 || !footerSeen) {
    return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_TRUNCATED" };
  }
  let contentHash: string;
  let itemsHash: string;
  try {
    contentHash = await contentHashSession.digest();
    itemsHash = await itemsHashSession.digest();
  } catch {
    return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_HASH_PORT_FAILURE" };
  }
  if (!isHash(contentHash) || !isHash(itemsHash)) {
    return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_HASH_PORT_FAILURE" };
  }
  if (contentHash !== receipt.artifact.content_sha) {
    return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_CONTENT_HASH_MISMATCH" };
  }
  if (itemsHash !== receipt.artifact.items_sha) {
    return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_ITEMS_HASH_MISMATCH" };
  }
  return { ok: true, value: { receipt, item_count: itemCount, byte_count: byteCount } };
}
