import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  platformInformationContractSchema,
  platformInformationDetailResponseSchema,
  platformInformationExportResultSchema,
  knowledgeExtractionRetryIntentSchema,
  verifyKnowledgeExtractionRetryIntent,
  platformInformationPageSchema,
  platformInformationQuerySchema,
  readPlatformInformationContract,
  verifyPlatformInformationExportResult,
  restoreBranchFilesConfirmationIntentSchema,
  restoreBranchFilesIntentSchema,
  restoreBranchFilesPreviewReceiptSchema,
  validateBranchFilesPullConfirmation
} from "../src/index.js";

const currentPath = fileURLToPath(new URL(
  "./fixtures/platform-information-v1-current.json",
  import.meta.url
));
const legacyPath = fileURLToPath(new URL(
  "./fixtures/platform-information-v0-legacy.json",
  import.meta.url
));

async function fixture(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("stage 13 platform information query contracts", () => {
  it("accepts all six bounded, authorized current queries and their page states", async () => {
    const value = await fixture(currentPath);
    const queries = value.queries as unknown[];
    const pages = value.pages as unknown[];

    expect(queries).toHaveLength(6);
    expect(pages).toHaveLength(6);
    for (const query of queries) {
      expect(platformInformationQuerySchema.safeParse(query).success).toBe(true);
      expect(platformInformationContractSchema.safeParse(query).success).toBe(true);
    }
    for (const page of pages) {
      expect(platformInformationPageSchema.safeParse(page).success).toBe(true);
      expect(platformInformationContractSchema.safeParse(page).success).toBe(true);
    }
    const monitorPage = pages[0] as Record<string, unknown>;
    expect(platformInformationPageSchema.safeParse({
      ...monitorPage,
      page_state: "ready",
      items: [{
        item_kind: "branch_monitor",
        lifecycle_kind: "change",
        run_id: "run_01",
        branch_name: "feature/monitor",
        change_key: "change_monitor",
        run_status: "running",
        current_phase: "sync",
        started_at: "2026-08-13T01:00:00Z",
        ended_at: null,
        duration_ms: null,
        last_event_at: "2026-08-13T01:00:00Z",
        sort_key: "2026-08-13T01:00:00Z|run_01"
      }]
    }).success).toBe(false);
    expect(pages.map((page) => (page as { page_state: string }).page_state)).toEqual([
      "processing", "empty", "ready", "partial_failure", "forbidden", "ready"
    ]);
  });

  it("represents an empty failed knowledge extraction and a request-only retry intent", async () => {
    const value = await fixture(currentPath);
    expect(platformInformationPageSchema.parse(value.knowledge_failed_page)).toEqual(
      value.knowledge_failed_page
    );
    expect(knowledgeExtractionRetryIntentSchema.parse(value.knowledge_retry_intent)).toEqual(
      value.knowledge_retry_intent
    );
    expect(platformInformationPageSchema.safeParse({
      ...(value.knowledge_failed_page as object),
      view: "branch_files",
      sort: "uploaded_at_desc_snapshot_version_asc"
    }).success).toBe(false);
    expect(platformInformationPageSchema.safeParse({
      ...(value.knowledge_failed_page as object), items: [{ item_kind: "knowledge_entry" }]
    }).success).toBe(false);
    expect(knowledgeExtractionRetryIntentSchema.safeParse({
      ...(value.knowledge_retry_intent as object), request_only: false
    }).success).toBe(false);
    expect(knowledgeExtractionRetryIntentSchema.safeParse({
      ...(value.knowledge_retry_intent as object), execution_token: "forbidden"
    }).success).toBe(false);
    const knowledgePage = (value.pages as Array<{ items: Record<string, unknown>[] }>)[3];
    if (knowledgePage === undefined) throw new Error("knowledge page fixture is missing");
    const knowledgeItem = knowledgePage.items[0];
    expect(knowledgeItem).toMatchObject({ display_title: "稳定发布约束" });
    expect(knowledgeItem).not.toHaveProperty("title");
  });

  it("recomputes retry intent identity against trusted actor, project, job and generation anchors", async () => {
    const value = await fixture(currentPath);
    const intent = value.knowledge_retry_intent as Record<string, unknown>;
    const expectedCanonical = "{\"actor_id\":\"actor_1\",\"contract_kind\":\"knowledge_extraction_retry_intent\",\"expected_generation\":2,\"job_id\":\"job_knowledge_01\",\"project_id\":\"prj_demo\",\"request_only\":true,\"retryable\":true,\"schema_version\":1}";
    const calls: string[] = [];
    const browserSha256 = async (canonical: string): Promise<string> => {
      calls.push(canonical);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
      return `sha256:${[...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    };
    const verify = (candidate: unknown, expected = {}) => verifyKnowledgeExtractionRetryIntent(
      typeof candidate === "string" ? candidate : JSON.stringify(candidate),
      { actor_id: "actor_1", project_id: "prj_demo", job_id: "job_knowledge_01",
        expected_generation: 2, ...expected },
      { sha256: browserSha256 }
    );
    await expect(verify(intent)).resolves.toMatchObject({ ok: true });
    expect(calls).toEqual([expectedCanonical]);
    for (const [field, replacement] of [
      ["actor_id", "actor_foreign"], ["project_id", "prj_foreign"],
      ["job_id", "job_knowledge_foreign"], ["expected_generation", 3]
    ] as const) {
      await expect(verify({ ...intent, [field]: replacement })).resolves.toEqual({
        ok: false, reason_code: "KNOWLEDGE_EXTRACTION_RETRY_INTENT_MISMATCH"
      });
    }
    await expect(verify({ ...intent, intent_hash: `sha256:${"e".repeat(64)}` })).resolves.toEqual({
      ok: false, reason_code: "KNOWLEDGE_EXTRACTION_RETRY_INTENT_HASH_MISMATCH"
    });
    await expect(verify({ ...intent, unexpected: true })).resolves.toEqual({
      ok: false, reason_code: "KNOWLEDGE_EXTRACTION_RETRY_INTENT_INVALID"
    });
    await expect(verifyKnowledgeExtractionRetryIntent(JSON.stringify(intent), {
      actor_id: "actor_1", project_id: "prj_demo", job_id: "job_knowledge_01",
      expected_generation: 2
    }, { sha256: () => { throw new Error("digest unavailable"); } })).resolves.toEqual({
      ok: false, reason_code: "KNOWLEDGE_EXTRACTION_RETRY_INTENT_HASH_MISMATCH"
    });
    await expect(verifyKnowledgeExtractionRetryIntent(JSON.stringify(intent), {
      actor_id: "actor_1", project_id: "prj_demo", job_id: "job_knowledge_01",
      expected_generation: 2
    }, { sha256: () => "not-a-sha256" })).resolves.toEqual({
      ok: false, reason_code: "KNOWLEDGE_EXTRACTION_RETRY_INTENT_HASH_MISMATCH"
    });
    let executions = 0;
    const getter = Object.defineProperty({}, "intent_hash", {
      enumerable: true, get() { executions += 1; throw new Error("getter"); }
    });
    const proxy = new Proxy({}, { get() { executions += 1; throw new Error("trap"); } });
    for (const hostile of [{}, getter, proxy]) {
      await expect(verifyKnowledgeExtractionRetryIntent(hostile, {
        actor_id: "actor_1", project_id: "prj_demo", job_id: "job_knowledge_01",
        expected_generation: 2
      }, { sha256: () => { executions += 1; return String(intent.intent_hash); } })).resolves.toEqual({
        ok: false, reason_code: "KNOWLEDGE_EXTRACTION_RETRY_INTENT_INVALID"
      });
    }
    expect(executions).toBe(0);
  });

  it("fails closed on unbounded limits, malformed opaque tokens, spoofed access, and unknown fields", async () => {
    const value = await fixture(currentPath);
    const query = (value.queries as Record<string, unknown>[])[1];
    if (query === undefined) throw new Error("branch-files query fixture is missing");

    expect(platformInformationQuerySchema.safeParse({ ...query, limit: 101 }).success).toBe(false);
    expect(platformInformationQuerySchema.safeParse({ ...query, cursor: "offset=100" }).success).toBe(false);
    const withoutVerifierCapability = Object.fromEntries(
      Object.entries(query).filter(([key]) => key !== "cursor_verification")
    );
    expect(platformInformationQuerySchema.safeParse(withoutVerifierCapability).success).toBe(false);
    expect(platformInformationQuerySchema.safeParse({
      ...query,
      query_scope: {
        ...(query.query_scope as Record<string, unknown>),
        accessible_project_ids: ["prj_other"]
      }
    }).success).toBe(false);
    expect(platformInformationQuerySchema.safeParse({ ...query, include_body: true }).success).toBe(false);
  });

  it("keeps bodies out of list pages and constrains content types per view", async () => {
    const value = await fixture(currentPath);
    const serializedPages = JSON.stringify(value.pages);
    expect(serializedPages).not.toContain('"body"');
    expect(serializedPages).not.toContain('"content"');

    const knowledgeQuery = (value.queries as Record<string, unknown>[])[3];
    if (knowledgeQuery === undefined) throw new Error("knowledge query fixture is missing");
    expect(platformInformationQuerySchema.safeParse({
      ...knowledgeQuery,
      query_scope: {
        ...(knowledgeQuery.query_scope as Record<string, unknown>),
        content_types: ["knowledge_entry", "rule"]
      }
    }).success).toBe(false);
  });

  it("emits only a pull-preview intent for branch file restore", async () => {
    const value = await fixture(currentPath);
    const intent = value.restore_intent;
    expect(restoreBranchFilesIntentSchema.parse(intent)).toEqual(intent);
    expect(JSON.stringify(intent)).not.toContain("destination_path");
    expect(JSON.stringify(intent)).not.toContain("write");
  });

  it("binds restore preview and per-file confirmation to branch, immutable snapshot, scope and hash", async () => {
    const value = await fixture(currentPath);
    const preview = value.restore_preview_receipt;
    const confirmation = value.restore_confirmation_intent;
    expect(restoreBranchFilesPreviewReceiptSchema.safeParse(preview).success).toBe(true);
    expect(restoreBranchFilesConfirmationIntentSchema.safeParse(confirmation).success).toBe(true);
    expect(JSON.stringify(confirmation)).not.toContain("content");
    expect(JSON.stringify(confirmation)).not.toContain("destination_path");
    expect(restoreBranchFilesConfirmationIntentSchema.safeParse({
      ...(confirmation as object), preview_hash: `sha256:${"f".repeat(64)}`
    }).success).toBe(true);
    const decisions = (confirmation as { conflict_decisions: Record<string, unknown>[] }).conflict_decisions;
    expect(restoreBranchFilesConfirmationIntentSchema.safeParse({
      ...(confirmation as object), conflict_decisions: [{ ...decisions[0], source_artifact_id: "artifact_other" }]
    }).success).toBe(true);
    expect(restoreBranchFilesConfirmationIntentSchema.safeParse({
      ...(confirmation as object),
      source_version: {
        ...(confirmation as { source_version: object }).source_version,
        branch_name: "other"
      }
    }).success).toBe(true);
    expect(validateBranchFilesPullConfirmation(
      JSON.stringify(preview), JSON.stringify(confirmation)
    )).toMatchObject({ ok: true });
    for (const hostile of [
      { ...(confirmation as object), preview_hash: `sha256:${"f".repeat(64)}` },
      { ...(confirmation as object), conflict_decisions: [] },
      { ...(confirmation as object), conflict_decisions: [...decisions, { ...decisions[0], path: "invented.md" }] },
      { ...(confirmation as object), conflict_decisions: [{ ...decisions[0], source_artifact_id: "artifact_other" }] },
      { ...(confirmation as object), source_ref: {
        ...(confirmation as { source_ref: object }).source_ref, branch_name: "other"
      } }
    ]) {
      expect(validateBranchFilesPullConfirmation(
        JSON.stringify(preview), JSON.stringify(hostile)
      )).toEqual({ ok: false, reason_code: "BRANCH_FILES_PULL_CONFIRMATION_MISMATCH" });
    }
    const noConflictPreview = { ...(preview as object), conflicts: [] };
    const noConflictConfirmation = { ...(confirmation as object), conflict_decisions: [] };
    expect(validateBranchFilesPullConfirmation(
      JSON.stringify(noConflictPreview), JSON.stringify(noConflictConfirmation)
    )).toMatchObject({ ok: true });
    expect(validateBranchFilesPullConfirmation(
      JSON.stringify(noConflictPreview), JSON.stringify(confirmation)
    )).toEqual({ ok: false, reason_code: "BRANCH_FILES_PULL_CONFIRMATION_MISMATCH" });
    let executed = 0;
    const hostileObject = new Proxy({}, { get() { executed += 1; throw new Error("executed"); } });
    expect(validateBranchFilesPullConfirmation(
      hostileObject as unknown as string, JSON.stringify(confirmation)
    )).toEqual({ ok: false, reason_code: "BRANCH_FILES_PULL_CONFIRMATION_INVALID" });
    expect(executed).toBe(0);
  });

  it("loads text only through a view-matched detail response", () => {
    const detail = {
      schema_version: 1,
      contract_kind: "detail_response",
      view: "project_materials",
      project_id: "prj_demo",
      detail_id: "material_rules",
      detail: {
        detail_kind: "project_material",
        content: "# canonical rule projection",
        content_hash: `sha256:${"b".repeat(64)}`,
        media_type: "text/markdown"
      }
    };
    expect(platformInformationDetailResponseSchema.safeParse(detail).success).toBe(true);
    expect(platformInformationDetailResponseSchema.safeParse({
      ...detail,
      view: "project_knowledge"
    }).success).toBe(false);
  });

  it("requires export-all to prove each cursor hop and terminal completion", async () => {
    const value = await fixture(currentPath);
    const result = value.export_result as Record<string, unknown>;
    expect(platformInformationExportResultSchema.safeParse(result).success).toBe(true);
    const pages = result.pages as Record<string, unknown>[];
    expect(pages).toHaveLength(2);
    expect(platformInformationExportResultSchema.safeParse({
      ...result,
      exported_count: 1
    }).success).toBe(false);
    expect(platformInformationExportResultSchema.safeParse({
      ...result,
      pages: [pages[0]]
    }).success).toBe(false);
    expect(platformInformationExportResultSchema.safeParse({
      ...result,
      pages: [pages[0], { ...pages[1], request_cursor: pages[0]?.request_cursor }]
    }).success).toBe(false);
    expect(platformInformationExportResultSchema.safeParse({
      ...result,
      pages: [pages[0], { ...pages[1], response_next_cursor: pages[0]?.response_next_cursor }]
    }).success).toBe(false);
    expect(platformInformationExportResultSchema.safeParse({
      ...result,
      pages: [
        { request_cursor: "pic_a25vd2xlZGdlOjA", response_next_cursor: "pic_a25vd2xlZGdlOjI1", result_count: 1 },
        { request_cursor: "pic_a25vd2xlZGdlOjI1", response_next_cursor: "pic_a25vd2xlZGdlOjA", result_count: 1 },
        { request_cursor: "pic_a25vd2xlZGdlOjA", response_next_cursor: null, result_count: 1 }
      ],
      exported_count: 3
    }).success).toBe(false);
  });

  it("accepts complete export proofs that start without a source cursor", async () => {
    const value = await fixture(currentPath);
    const query = (value.queries as Array<Record<string, unknown>>)[3] as Record<string, unknown>;
    const result = value.export_result as Record<string, unknown>;
    const range = result.range as Record<string, unknown>;
    expect(platformInformationExportResultSchema.safeParse({
      ...result,
      range: { ...range, source_cursor: query.cursor },
      pages: [{ request_cursor: null, response_next_cursor: null, result_count: 3 }],
      exported_count: 3
    }).success).toBe(true);
    expect(platformInformationExportResultSchema.safeParse({
      ...result,
      range: { ...range, source_cursor: query.cursor },
      pages: [
        { request_cursor: null, response_next_cursor: "pic_a25vd2xlZGdlOjI1", result_count: 25 },
        { request_cursor: "pic_a25vd2xlZGdlOjI1", response_next_cursor: null, result_count: 3 }
      ],
      exported_count: 28
    }).success).toBe(true);
  });

  it("binds export proofs to the complete bounded query range", async () => {
    const value = await fixture(currentPath);
    const query = (value.queries as Array<Record<string, unknown>>)[3] as Record<string, unknown>;
    const result = value.export_result as Record<string, unknown>;
    const proof = {
      ...result,
      range: {
        query_scope: query.query_scope,
        limit: query.limit,
        source_cursor: query.cursor,
        cursor_verification: query.cursor_verification,
        sort: query.sort
      },
      pages: [
        { request_cursor: null, response_next_cursor: "pic_a25vd2xlZGdlOjI1", result_count: 25 },
        { request_cursor: "pic_a25vd2xlZGdlOjI1", response_next_cursor: null, result_count: 3 }
      ]
    };
    expect(platformInformationExportResultSchema.safeParse(proof).success).toBe(true);
    expect(platformInformationExportResultSchema.safeParse({
      ...proof,
      project_id: "prj_other"
    }).success).toBe(false);
    expect(platformInformationExportResultSchema.safeParse({
      ...proof,
      range: { ...(proof.range as object), sort: "uploaded_at_desc_snapshot_version_asc" }
    }).success).toBe(false);
    expect(platformInformationExportResultSchema.safeParse({
      ...proof,
      range: {
        ...(proof.range as object),
        query_scope: { ...(query.query_scope as object), content_types: ["branch_file"] }
      }
    }).success).toBe(false);
    expect(platformInformationExportResultSchema.safeParse({
      ...proof,
      range: { ...(proof.range as object), limit: 24 }
    }).success).toBe(false);
  });

  it("verifies a serialized export proof against its trusted query", async () => {
    const value = await fixture(currentPath);
    const query = (value.queries as Array<Record<string, unknown>>)[3] as Record<string, unknown>;
    const proof = value.export_result as Record<string, unknown>;
    expect(verifyPlatformInformationExportResult(JSON.stringify(proof), query)).toMatchObject({
      ok: true,
      value: { contract_kind: "export_all_result", exported_count: 28 }
    });
    const range = proof.range as Record<string, unknown>;
    const queryScope = range.query_scope as Record<string, unknown>;
    expect(verifyPlatformInformationExportResult(JSON.stringify({
      ...proof,
      range: {
        ...range,
        query_scope: { ...queryScope, actor_id: "actor_2" }
      }
    }), query)).toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_EXPORT_RANGE_MISMATCH"
    });
    let traps = 0;
    const hostile = new Proxy({}, { get() { traps += 1; throw new Error("trap"); } });
    expect(verifyPlatformInformationExportResult(hostile, query)).toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_EXPORT_SERIALIZED_JSON_REQUIRED"
    });
    expect(traps).toBe(0);
    expect(verifyPlatformInformationExportResult("{" + " ".repeat(2_000_000), query)).toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_EXPORT_SERIALIZED_JSON_TOO_LARGE"
    });
  });

  it("rejects incomplete, cyclic, discontinuous, repeated, and unbounded export walks", async () => {
    const value = await fixture(currentPath);
    const proof = value.export_result as Record<string, unknown>;
    const range = proof.range as Record<string, unknown>;
    const cursor0 = "pic_a25vd2xlZGdlOjA";
    const cursor25 = "pic_a25vd2xlZGdlOjI1";
    const cursor50 = "pic_a25vd2xlZGdlOjUw";
    const invalidPages: unknown[][] = [
      [{ request_cursor: null, response_next_cursor: cursor25, result_count: 25 }],
      [
        { request_cursor: null, response_next_cursor: cursor25, result_count: 25 },
        { request_cursor: cursor50, response_next_cursor: null, result_count: 3 }
      ],
      [
        { request_cursor: null, response_next_cursor: null, result_count: 25 },
        { request_cursor: null, response_next_cursor: null, result_count: 3 }
      ],
      [
        { request_cursor: cursor0, response_next_cursor: cursor25, result_count: 1 },
        { request_cursor: cursor25, response_next_cursor: cursor0, result_count: 1 },
        { request_cursor: cursor0, response_next_cursor: null, result_count: 1 }
      ],
      [
        { request_cursor: null, response_next_cursor: cursor25, result_count: 25 },
        { request_cursor: cursor25, response_next_cursor: null, result_count: 26 }
      ]
    ];
    for (const pages of invalidPages) {
      expect(platformInformationExportResultSchema.safeParse({
        ...proof,
        pages,
        exported_count: pages.reduce((sum, page) =>
          sum + ((page as { result_count: number }).result_count), 0)
      }).success).toBe(false);
    }
    expect(platformInformationExportResultSchema.safeParse({
      ...proof,
      range: { ...range, source_cursor: cursor0 },
      pages: [{ request_cursor: cursor0, response_next_cursor: null, result_count: 1 }],
      exported_count: 1
    }).success).toBe(true);
    expect(platformInformationExportResultSchema.safeParse({
      ...proof,
      pages: Array.from({ length: 10_001 }, () => ({
        request_cursor: null,
        response_next_cursor: null,
        result_count: 0
      })),
      exported_count: 0
    }).success).toBe(false);
    expect(platformInformationExportResultSchema.safeParse({
      ...proof,
      exported_count: 1_000_001
    }).success).toBe(false);
  });

  it("enforces the complete mutually-exclusive page-state closure", async () => {
    const value = await fixture(currentPath);
    const pages = value.pages as Record<string, unknown>[];
    const ready = pages[2];
    const processing = pages[0];
    const partial = pages[3];
    const forbidden = pages[4];
    if (ready === undefined || processing === undefined || partial === undefined || forbidden === undefined) {
      throw new Error("page-state fixtures are incomplete");
    }
    expect(platformInformationPageSchema.safeParse({
      ...ready, failures: [{ reason_code: "PROJECT_INFORMATION_UNAVAILABLE", retryable: true }]
    }).success).toBe(false);
    expect(platformInformationPageSchema.safeParse({ ...processing, next_cursor: "pic_cHJvY2Vzc2luZw" }).success).toBe(false);
    expect(platformInformationPageSchema.safeParse({
      ...partial,
      failures: [{ reason_code: "PROJECT_INFORMATION_FORBIDDEN", retryable: false }]
    }).success).toBe(false);
    expect(platformInformationPageSchema.safeParse({ ...partial, items: [] }).success).toBe(false);
    expect(platformInformationPageSchema.safeParse({
      ...forbidden,
      failures: [{ reason_code: "PROJECT_INFORMATION_UNAVAILABLE", retryable: false }]
    }).success).toBe(false);
  });

  it("recognizes the exact legacy fixture as read-only and rejects drift", async () => {
    const legacy = await fixture(legacyPath);
    expect(readPlatformInformationContract(JSON.stringify(legacy))).toEqual({
      ok: true,
      mode: "legacy_read_only",
      source_schema_version: 0,
      value: legacy
    });
    expect(readPlatformInformationContract(JSON.stringify({ ...legacy, writable: true }))).toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_CONTRACT_INVALID"
    });
    expect(readPlatformInformationContract(JSON.stringify({ schema_version: 2 }))).toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_VERSION_UNSUPPORTED"
    });
  });

  it("reads only bounded serialized JSON and never executes hostile object behavior", async () => {
    const legacy = await fixture(legacyPath);
    let executed = 0;
    const accessor = Object.defineProperty({}, "schema_version", {
      enumerable: true,
      get() { executed += 1; return 1; }
    });
    const proxy = new Proxy({}, { get() { executed += 1; throw new Error("executed"); } });
    const symbolValue = { [Symbol("hostile")]: true };
    const customProto = Object.create({ schema_version: 1 }) as object;
    for (const value of [accessor, proxy, symbolValue, customProto]) {
      expect(readPlatformInformationContract(value)).toEqual({
        ok: false, reason_code: "PLATFORM_INFORMATION_SERIALIZED_JSON_REQUIRED"
      });
    }
    expect(executed).toBe(0);
    expect(readPlatformInformationContract("{" + " ".repeat(4_000_000))).toEqual({
      ok: false, reason_code: "PLATFORM_INFORMATION_SERIALIZED_JSON_TOO_LARGE"
    });
    expect(readPlatformInformationContract(JSON.stringify(legacy))).toMatchObject({
      ok: true, mode: "legacy_read_only"
    });
  });
});
