import { isPromise, isProxy } from "node:util/types";

import {
  knowledgeQueryReceiptSchema
} from "../schemas.js";
import { knowledgeResultSetHash } from "../identity.js";
import { deepFreeze, sortedUnique, validTime } from "../stable.js";
import type { KnowledgeResult } from "../types.js";
import {
  REMOTE_KNOWLEDGE_MAX_DEADLINE_MS,
  REMOTE_KNOWLEDGE_MAX_RESULTS,
  REMOTE_KNOWLEDGE_MAX_SUMMARY_BYTES,
  REMOTE_KNOWLEDGE_QUERY_SCHEMA_VERSION,
  type RemoteKnowledgeQueryBudget,
  type RemoteKnowledgeQueryModule,
  type RemoteKnowledgeQueryPort,
  type RemoteKnowledgeQueryRequest,
  type RemoteKnowledgeQueryResponse,
  RemoteKnowledgeQuerySeamError,
  type RemoteKnowledgeQueryErrorCode
} from "./types.js";

const shaPattern = /^sha256:(?!0{64}$)[a-f0-9]{64}$/u;
const queryIdPattern = /^knowledge_query:[a-f0-9]{64}$/u;
const resultKinds = ["archive_knowledge", "implementation_fact", "design", "rule", "change_document"] as const;
const relevanceKinds = ["high", "medium", "low"] as const;
const nativeAbortGetter = typeof AbortSignal === "function"
  ? Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get
  : undefined;

interface SnapshotBudget {
  nodes: number;
  stringBytes: number;
}

function invalid(code: RemoteKnowledgeQueryErrorCode): never {
  throw new RemoteKnowledgeQuerySeamError(code);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  if (isProxy(signal)) invalid("REMOTE_KNOWLEDGE_ABORTED");
  if (typeof nativeAbortGetter !== "function") invalid("REMOTE_KNOWLEDGE_ABORTED");
  try { return Reflect.apply(nativeAbortGetter, signal, []) === true; } catch { invalid("REMOTE_KNOWLEDGE_ABORTED"); }
}

function trustedNativePromise(value: unknown): value is Promise<unknown> {
  if (value === null || (typeof value !== "object" && typeof value !== "function") || isProxy(value)) return false;
  try {
    if (Object.getPrototypeOf(value) !== Promise.prototype || Reflect.ownKeys(value).length !== 0) return false;
    return isPromise(value);
  } catch { return false; }
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xDC00 || next > 0xDFFF) return true;
      index += 1;
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
      return true;
    }
  }
  return false;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1F || code === 0x7F) return true;
  }
  return false;
}

function safeText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    value === value.trim() && value === value.normalize("NFC") &&
    !hasControlCharacter(value) && !hasLoneSurrogate(value);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}

function snapshot(
  value: unknown,
  budget: SnapshotBudget,
  depth = 0,
  active = new WeakSet<object>(),
  failureCode: RemoteKnowledgeQueryErrorCode = "REMOTE_KNOWLEDGE_RESPONSE_INVALID"
): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) invalid(failureCode);
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 32_768 || hasLoneSurrogate(value)) invalid(failureCode);
    budget.stringBytes += new TextEncoder().encode(value).byteLength;
    if (budget.stringBytes > 256 * 1024) invalid(failureCode);
    return value;
  }
  if (typeof value !== "object" || isProxy(value)) invalid(failureCode);
  if (depth > 16 || ++budget.nodes > 10_000 || active.has(value)) invalid(failureCode);
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) invalid(failureCode);
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (lengthDescriptor === undefined || !("value" in lengthDescriptor) ||
          !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value > 1_024) {
        invalid(failureCode);
      }
      const length = lengthDescriptor.value as number;
      const output: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const key = String(index);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          invalid(failureCode);
        }
        output.push(snapshot(descriptor.value, budget, depth + 1, active, failureCode));
      }
      const keys = Reflect.ownKeys(value);
      if (keys.length !== length + 1 || keys.some((key) => key !== "length" &&
          (typeof key !== "string" || !/^\d+$/u.test(key) || Number(key) >= length))) {
        invalid(failureCode);
      }
      return output;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid(failureCode);
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") invalid(failureCode);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        invalid(failureCode);
      }
      output[key] = snapshot(descriptor.value, budget, depth + 1, active, failureCode);
    }
    return output;
  } finally {
    active.delete(value);
  }
}

function snapshotRequest(value: unknown): RemoteKnowledgeQueryRequest {
  const copy = snapshot(value, { nodes: 0, stringBytes: 0 }, 0, new WeakSet<object>(),
    "REMOTE_KNOWLEDGE_REQUEST_INVALID");
  if (copy === null || typeof copy !== "object" || Array.isArray(copy)) invalid("REMOTE_KNOWLEDGE_REQUEST_INVALID");
  const request = copy as Record<string, unknown>;
  if (!exactKeys(request, ["schema_version", "project_id", "query_id", "query_hash", "reason_code", "query", "budget"]) ||
      request.schema_version !== REMOTE_KNOWLEDGE_QUERY_SCHEMA_VERSION ||
      !safeText(request.project_id, 128) || typeof request.query_id !== "string" ||
      !queryIdPattern.test(request.query_id) || typeof request.query_hash !== "string" ||
      !shaPattern.test(request.query_hash) || request.query_id.slice("knowledge_query:".length) !== request.query_hash.slice(7) ||
      (request.reason_code !== "initial_intent" && request.reason_code !== "directed_evidence_followup") ||
      !safeText(request.query, 512)) invalid("REMOTE_KNOWLEDGE_REQUEST_INVALID");
  const budget = request.budget;
  if (budget === null || typeof budget !== "object" || Array.isArray(budget) ||
      !exactKeys(budget as Record<string, unknown>, ["max_results", "max_total_summary_bytes", "deadline_ms"])) {
    invalid("REMOTE_KNOWLEDGE_REQUEST_INVALID");
  }
  const typedBudget = budget as RemoteKnowledgeQueryBudget;
  if (!Number.isSafeInteger(typedBudget.max_results) || typedBudget.max_results < 1 ||
      typedBudget.max_results > REMOTE_KNOWLEDGE_MAX_RESULTS ||
      !Number.isSafeInteger(typedBudget.max_total_summary_bytes) || typedBudget.max_total_summary_bytes < 1 ||
      typedBudget.max_total_summary_bytes > REMOTE_KNOWLEDGE_MAX_SUMMARY_BYTES ||
      !Number.isSafeInteger(typedBudget.deadline_ms) || typedBudget.deadline_ms < 1 ||
      typedBudget.deadline_ms > REMOTE_KNOWLEDGE_MAX_DEADLINE_MS) invalid("REMOTE_KNOWLEDGE_REQUEST_INVALID");
  return deepFreeze(copy as RemoteKnowledgeQueryRequest);
}

function validateResult(value: unknown): KnowledgeResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("REMOTE_KNOWLEDGE_RESPONSE_INVALID");
  const result = value as Record<string, unknown>;
  if (!exactKeys(result, ["result_id", "kind", "summary", "relevance", "conflicts_with_intent"],
    ["source", "verified_at", "source_version", "conflict_summary"]) ||
      !safeText(result.result_id, 256) ||
      !resultKinds.includes(result.kind as never) || !safeText(result.summary, 1_024) ||
      !relevanceKinds.includes(result.relevance as never) || typeof result.conflicts_with_intent !== "boolean" ||
      (result.source !== undefined && !safeText(result.source, 256)) ||
      (result.verified_at !== undefined && (typeof result.verified_at !== "string" || !validTime(result.verified_at))) ||
      (result.source_version !== undefined && !safeText(result.source_version, 128)) ||
      (result.conflicts_with_intent
        ? !safeText(result.conflict_summary, 1_024)
        : result.conflict_summary !== undefined)) {
    invalid("REMOTE_KNOWLEDGE_RESPONSE_INVALID");
  }
  return result as unknown as KnowledgeResult;
}

function validateResponse(value: unknown, request: RemoteKnowledgeQueryRequest): RemoteKnowledgeQueryResponse {
  const copy = snapshot(value, { nodes: 0, stringBytes: 0 });
  if (copy === null || typeof copy !== "object" || Array.isArray(copy)) invalid("REMOTE_KNOWLEDGE_RESPONSE_INVALID");
  const response = copy as Record<string, unknown>;
  if (!exactKeys(response, ["schema_version", "query_id", "project_id", "receipt", "results"]) ||
      response.schema_version !== REMOTE_KNOWLEDGE_QUERY_SCHEMA_VERSION ||
      response.query_id !== request.query_id || response.project_id !== request.project_id ||
      !Array.isArray(response.results) || response.results.length > request.budget.max_results) {
    invalid("REMOTE_KNOWLEDGE_RESPONSE_INVALID");
  }
  const parsedReceipt = knowledgeQueryReceiptSchema.safeParse(response.receipt);
  if (!parsedReceipt.success) invalid("REMOTE_KNOWLEDGE_RESPONSE_INVALID");
  const receipt = parsedReceipt.data;
  if (receipt.project_id !== request.project_id || receipt.query_hash !== request.query_hash ||
      (receipt.status === "succeeded" ? receipt.reason_code !== request.reason_code :
        receipt.reason_code !== "remote_knowledge_unavailable")) {
    invalid("REMOTE_KNOWLEDGE_RESPONSE_INVALID");
  }
  const results = (response.results as unknown[]).map(validateResult);
  const totalSummaryBytes = results.reduce((total, result) => total + new TextEncoder().encode(result.summary).byteLength, 0);
  if (totalSummaryBytes > request.budget.max_total_summary_bytes ||
      (receipt.status === "failed" ? results.length !== 0 : results.length !== receipt.result_ids.length)) {
    invalid("REMOTE_KNOWLEDGE_RESPONSE_INVALID");
  }
  const resultIds = results.map((result) => result.result_id);
  const sourceVersions = sortedUnique(results.flatMap((result) => result.source_version === undefined ? [] : [result.source_version]));
  if (JSON.stringify(resultIds) !== JSON.stringify(receipt.result_ids) ||
      JSON.stringify(sourceVersions) !== JSON.stringify(receipt.source_versions) ||
      receipt.result_set_hash !== knowledgeResultSetHash(receipt)) invalid("REMOTE_KNOWLEDGE_RESPONSE_INVALID");
  const seen = new Set<string>();
  for (const result of results) {
    if (seen.has(result.result_id)) invalid("REMOTE_KNOWLEDGE_RESPONSE_INVALID");
    seen.add(result.result_id);
  }
  return deepFreeze(copy as RemoteKnowledgeQueryResponse);
}

function captureExecute(port: unknown): (request: RemoteKnowledgeQueryRequest, signal?: AbortSignal) => unknown {
  if (port === null || typeof port !== "object" || Array.isArray(port) || isProxy(port)) invalid("REMOTE_KNOWLEDGE_PORT_INVALID");
  let prototype: object | null;
  try { prototype = Object.getPrototypeOf(port) as object | null; } catch { invalid("REMOTE_KNOWLEDGE_PORT_INVALID"); }
  if (prototype !== Object.prototype && prototype !== null) invalid("REMOTE_KNOWLEDGE_PORT_INVALID");
  const keys = Reflect.ownKeys(port);
  if (keys.length !== 1 || keys[0] !== "execute") invalid("REMOTE_KNOWLEDGE_PORT_INVALID");
  const descriptor = Object.getOwnPropertyDescriptor(port, "execute");
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor) ||
      typeof descriptor.value !== "function" || isProxy(descriptor.value)) invalid("REMOTE_KNOWLEDGE_PORT_INVALID");
  return (request, signal) => Reflect.apply(descriptor.value as (...args: unknown[]) => unknown, port, [request, signal]);
}

export function createRemoteKnowledgeQueryModule(portInput: RemoteKnowledgeQueryPort): RemoteKnowledgeQueryModule {
  const execute = captureExecute(portInput);
  return Object.freeze({
    async query(input: RemoteKnowledgeQueryRequest, signal?: AbortSignal): Promise<RemoteKnowledgeQueryResponse> {
      const request = snapshotRequest(input);
      if (isAborted(signal)) invalid("REMOTE_KNOWLEDGE_ABORTED");
      let result: unknown;
      try {
        result = execute(request, signal);
      } catch {
        invalid("REMOTE_KNOWLEDGE_UNAVAILABLE");
      }
      if (!trustedNativePromise(result)) invalid("REMOTE_KNOWLEDGE_UNAVAILABLE");
      let resolved: unknown;
      try {
        resolved = await result;
      } catch {
        if (isAborted(signal)) invalid("REMOTE_KNOWLEDGE_ABORTED");
        invalid("REMOTE_KNOWLEDGE_UNAVAILABLE");
      }
      if (isAborted(signal)) invalid("REMOTE_KNOWLEDGE_ABORTED");
      return validateResponse(resolved, request);
    }
  });
}
