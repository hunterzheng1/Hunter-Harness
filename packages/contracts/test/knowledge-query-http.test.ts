import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import {
  KNOWLEDGE_QUERY_HTTP_OPERATIONS,
  knowledgeQueryHttpErrorCodeSchema,
  knowledgeQueryHttpErrorEnvelopeSchema,
  knowledgeQueryHttpRequestHeadersSchema,
  knowledgeQueryHttpRequestSchema,
  knowledgeQueryHttpResponseSchema,
  knowledgeQueryHttpReceiptId,
  knowledgeQueryHttpResultSetHash,
  validateKnowledgeQueryHttpResponse
} from "../src/index.js";

const hash = "sha256:" + "a".repeat(64);
const request = {
  schema_version: 1 as const,
  project_id: "prj_contract",
  query_id: "knowledge_query:" + "a".repeat(64),
  query_hash: hash,
  reason_code: "initial_intent" as const,
  query: "Which persistence boundary is authoritative?",
  budget: { max_results: 3, max_total_summary_bytes: 4096, deadline_ms: 10_000 }
};
const receiptBody = {
  schema_version: 1 as const,
  query_hash: hash,
  project_id: request.project_id,
  index_generation: "knowledge_generation:17",
  result_ids: ["knowledge.result.1"],
  source_versions: ["artifact:v4"],
  result_set_hash: knowledgeQueryHttpResultSetHash({
    index_generation: "knowledge_generation:17",
    result_ids: ["knowledge.result.1"],
    source_versions: ["artifact:v4"]
  }),
  status: "succeeded" as const,
  executed_at: "2026-08-14T01:02:03.000Z",
  reason_code: "initial_intent" as const
};
const receipt = {
  ...receiptBody,
  receipt_id: knowledgeQueryHttpReceiptId(receiptBody)
};
const response = {
  schema_version: 1 as const,
  query_id: request.query_id,
  project_id: request.project_id,
  receipt,
  results: [{
    result_id: "knowledge.result.1",
    kind: "archive_knowledge" as const,
    summary: "The durable knowledge projection is the query authority.",
    relevance: "high" as const,
    source: "archive:change-17",
    verified_at: "2026-08-13T12:00:00.000Z",
    source_version: "artifact:v4",
    conflicts_with_intent: false
  }]
};

describe("Knowledge Query HTTP v1 shared contract", () => {
  it("matches the frozen operation descriptor and server-bound auth", async () => {
    const frozen = JSON.parse(await readFile(
      new URL("./fixtures/knowledge-query-http-v1-current.json", import.meta.url), "utf8"
    ));
    expect(KNOWLEDGE_QUERY_HTTP_OPERATIONS).toEqual(frozen);
    expect(KNOWLEDGE_QUERY_HTTP_OPERATIONS.query.auth).toEqual({
      actor_source: "authenticated_principal",
      project_allowlist_source: "server_authority",
      project_key_scope: "knowledge:read"
    });
    expect(KNOWLEDGE_QUERY_HTTP_OPERATIONS.query.idempotency_header).toBe("Idempotency-Key");
    expect(KNOWLEDGE_QUERY_HTTP_OPERATIONS.query.success_status).toBe(201);
    expect(KNOWLEDGE_QUERY_HTTP_OPERATIONS.query.replay_status).toBe(200);
  });

  it("accepts bounded descriptor-only requests and rejects actor/body or budget drift", () => {
    expect(knowledgeQueryHttpRequestSchema.safeParse(request).success).toBe(true);
    expect(knowledgeQueryHttpRequestSchema.safeParse({ ...request, actor_id: "spoofed" }).success).toBe(false);
    expect(knowledgeQueryHttpRequestSchema.safeParse({
      ...request, budget: { ...request.budget, max_results: 11 }
    }).success).toBe(false);
    expect(knowledgeQueryHttpRequestSchema.safeParse({
      ...request, query: "bad\nquery"
    }).success).toBe(false);
  });

  it("accepts a receipt-bound response without body/content fields", () => {
    expect(knowledgeQueryHttpResponseSchema.safeParse(response).success).toBe(true);
    expect(validateKnowledgeQueryHttpResponse(response, request).success).toBe(true);
    expect(knowledgeQueryHttpResponseSchema.safeParse({
      ...response,
      results: [{ ...response.results[0], body: "forbidden" }]
    }).success).toBe(false);
    expect(validateKnowledgeQueryHttpResponse({
      ...response, project_id: "project_other"
    }, request).success).toBe(false);
  });

  it("enforces failure receipts as zero-result unavailable responses", () => {
    const failed = {
      ...response,
      receipt: {
        ...receipt,
        result_ids: [],
        source_versions: [],
        result_set_hash: knowledgeQueryHttpResultSetHash({
          index_generation: receipt.index_generation,
          result_ids: [],
          source_versions: []
        }),
        status: "failed" as const,
        reason_code: "remote_knowledge_unavailable" as const,
        failure_code: "REMOTE_UNAVAILABLE"
      },
      results: []
    };
    failed.receipt.receipt_id = knowledgeQueryHttpReceiptId(failed.receipt);
    expect(knowledgeQueryHttpResponseSchema.safeParse(failed).success).toBe(true);
    expect(validateKnowledgeQueryHttpResponse(failed, request).success).toBe(true);
    expect(knowledgeQueryHttpResponseSchema.safeParse({
      ...failed,
      results: [{ ...response.results[0] }]
    }).success).toBe(false);
  });

  it("keeps headers/errors strict and printable", () => {
    expect(knowledgeQueryHttpRequestHeadersSchema.safeParse({
      "X-Request-Id": "018f1f2e-7b5a-7cc0-8c2d-2b320cab1234",
      "Idempotency-Key": "knowledge-query-1"
    }).success).toBe(true);
    expect(knowledgeQueryHttpRequestHeadersSchema.safeParse({
      "X-Request-Id": "018f1f2e-7b5a-7cc0-8c2d-2b320cab1234",
      "Idempotency-Key": "bad key\n"
    }).success).toBe(false);
    expect(knowledgeQueryHttpErrorCodeSchema.safeParse("KNOWLEDGE_QUERY_IDEMPOTENCY_CONFLICT").success).toBe(true);
    expect(knowledgeQueryHttpErrorCodeSchema.safeParse("DB_PASSWORD_SECRET").success).toBe(false);
    expect(knowledgeQueryHttpErrorEnvelopeSchema.safeParse({
      error: {
        code: "KNOWLEDGE_QUERY_TIMEOUT",
        message: "Knowledge query timed out",
        request_id: "018f1f2e-7b5a-7cc0-8c2d-2b320cab1234",
        outcome: "conflict"
      }
    }).success).toBe(true);
  });

  it("rejects duplicate result ids, mismatched receipt ids, and oversized summaries", () => {
    expect(knowledgeQueryHttpResponseSchema.safeParse({
      ...response,
      results: [response.results[0], response.results[0]]
    }).success).toBe(false);
    expect(validateKnowledgeQueryHttpResponse({
      ...response,
      receipt: { ...receipt, result_ids: ["knowledge.other"] }
    }, request).success).toBe(false);
    expect(knowledgeQueryHttpResponseSchema.safeParse({
      ...response,
      results: [{ ...response.results[0], summary: "x".repeat(70_000) }]
    }).success).toBe(false);
  });

  it("closes receipt and result-set identities instead of trusting caller hashes", () => {
    expect(validateKnowledgeQueryHttpResponse({
      ...response,
      receipt: {
        ...response.receipt,
        receipt_id: "knowledge_query_receipt:" + "c".repeat(64),
        result_set_hash: "sha256:" + "b".repeat(64)
      }
    }, request).success).toBe(false);
  });
});
