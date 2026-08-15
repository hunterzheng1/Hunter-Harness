import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import {
  PLATFORM_INFORMATION_HTTP_OPERATIONS,
  platformInformationConfirmRestoreHttpRequestSchema,
  platformInformationListHttpQuerySchema,
  platformInformationPreviewRestoreHttpRequestSchema,
  platformInformationRetryExtractionHttpRequestSchema
  ,validatePlatformInformationConfirmRestoreHttpRequest
} from "../src/index.js";

describe("stage 13 platform information HTTP contract", () => {
  it("matches the independently frozen descriptor fixture", async () => {
    const frozen = JSON.parse(await readFile(new URL("./fixtures/platform-information-http-v1-current.json", import.meta.url), "utf8"));
    expect(PLATFORM_INFORMATION_HTTP_OPERATIONS).toEqual(frozen);
  });
  it("freezes the five route descriptors and excludes client-supplied authority", () => {
    expect(PLATFORM_INFORMATION_HTTP_OPERATIONS.list).toMatchObject({ method: "GET", path: "/api/v1/projects/{project_id}/information/{view}", operation_id: "listPlatformInformation", success_schema: "PlatformInformationPage" });
    expect(PLATFORM_INFORMATION_HTTP_OPERATIONS.export_all).toMatchObject({ method: "GET", path: "/api/v1/projects/{project_id}/information/{view}:export-all", operation_id: "exportAllPlatformInformation", success_schema: "PlatformInformationExportResult" });
    expect(PLATFORM_INFORMATION_HTTP_OPERATIONS.detail).toMatchObject({ method: "GET", path: "/api/v1/projects/{project_id}/information/{view}/{detail_id}", operation_id: "getPlatformInformationDetail", success_schema: "PlatformInformationDetailResponse" });
    expect(PLATFORM_INFORMATION_HTTP_OPERATIONS.preview_restore.path).toBe("/api/v1/projects/{project_id}/information/branch-files:preview-restore");
    expect(PLATFORM_INFORMATION_HTTP_OPERATIONS.confirm_restore.path).toBe("/api/v1/projects/{project_id}/information/branch-files:confirm-restore");
    expect(PLATFORM_INFORMATION_HTTP_OPERATIONS.retry_extraction.path).toBe("/api/v1/projects/{project_id}/information/knowledge:retry-extraction");
    expect(platformInformationListHttpQuerySchema.parse({})).toEqual({ limit: 50, cursor: null });
    expect(platformInformationListHttpQuerySchema.safeParse({ limit: 25, cursor: null, actor_id: "actor_spoof" }).success).toBe(false);
    expect(platformInformationRetryExtractionHttpRequestSchema.safeParse({ job_id: "job_knowledge_01", expected_generation: 2, actor_id: "actor_spoof" }).success).toBe(false);
  });

  it("keeps restore payloads strict and advertises all error envelopes", () => {
    const preview = { schema_version: 1, contract_kind: "branch_files_pull_preview_intent", project_id: "prj_demo", source_branch_name: "main", source_commit_sha: "a".repeat(40), source_artifact_id: "artifact_1", source_project_version: "pv_1", scopes: ["branch_files"], selected_paths: ["AGENTS.md"], preview_only: true };
    expect(platformInformationPreviewRestoreHttpRequestSchema.safeParse(preview).success).toBe(true);
    expect(platformInformationPreviewRestoreHttpRequestSchema.safeParse({ ...preview, actor_id: "actor_spoof" }).success).toBe(false);
    expect(platformInformationConfirmRestoreHttpRequestSchema.safeParse({ preview_receipt: {}, confirmation_intent: {} }).success).toBe(false);
    for (const operation of Object.values(PLATFORM_INFORMATION_HTTP_OPERATIONS)) {
      expect(operation.request_id_header).toBe("X-Request-Id");
      expect(operation.errors[401]).toEqual(["AUTH_REQUIRED", "TOKEN_INVALID", "SESSION_INVALID"]);
    }
    expect(PLATFORM_INFORMATION_HTTP_OPERATIONS.list.auth.project_key_scope_by_view.branch_monitor).toBe("platform:read");
    expect(PLATFORM_INFORMATION_HTTP_OPERATIONS.confirm_restore).toMatchObject({ validator_id: "validatePlatformInformationConfirmRestoreHttpRequest" });
    expect(validatePlatformInformationConfirmRestoreHttpRequest(JSON.stringify({ preview_receipt: {}, confirmation_intent: {} }), { project_id: "prj_demo", client_id: "platform_console" })).toEqual({ ok: false, reason_code: "BRANCH_FILES_PULL_CONFIRMATION_INVALID" });
  });
});
