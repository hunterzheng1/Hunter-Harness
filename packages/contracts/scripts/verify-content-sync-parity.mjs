import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

const argumentsList = process.argv.slice(2);
const platformFlagIndex = argumentsList.indexOf("--platform-root");

function finish(payload, exitCode) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = exitCode;
}

if (platformFlagIndex === -1 || platformFlagIndex + 1 >= argumentsList.length ||
    argumentsList.length !== 2) {
  finish({
    ok: false,
    reason_code: "invalid_arguments",
    message: "usage: verify-content-sync-parity.mjs --platform-root <path>"
  }, 2);
} else {
  const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const platformRoot = resolve(argumentsList[platformFlagIndex + 1]);
  const artifacts = [
    {
      artifact: "openapi",
      harness_path: "packages/contracts/openapi/hunter-harness-v1.yaml",
      platform_path: "apps/server/openapi/hunter-harness-v1.yaml"
    },
    {
      artifact: "openapi_sidecar",
      harness_path: "packages/contracts/openapi/hunter-harness-v1.yaml.sha256",
      platform_path: "apps/server/openapi/hunter-harness-v1.yaml.sha256"
    },
    {
      artifact: "content_sync_source",
      harness_path: "packages/contracts/src/content-sync.ts",
      platform_path: "packages/contracts/src/content-sync.ts"
    },
    {
      artifact: "current_fixture",
      harness_path: "packages/contracts/test/fixtures/content-sync-v1-current.json",
      platform_path: "packages/contracts/test/fixtures/content-sync-v1-current.json"
    },
    {
      artifact: "legacy_fixture",
      harness_path: "packages/contracts/test/fixtures/content-sync-v0-legacy.json",
      platform_path: "packages/contracts/test/fixtures/content-sync-v0-legacy.json"
    },
    {
      artifact: "content_sync_declaration",
      harness_path: "packages/contracts/dist/content-sync.d.ts",
      platform_path: "packages/contracts/dist/content-sync.d.ts"
    },
    {
      artifact: "platform_information_source",
      harness_path: "packages/contracts/src/platform-information.ts",
      platform_path: "packages/contracts/src/platform-information.ts"
    },
    {
      artifact: "platform_information_current_fixture",
      harness_path: "packages/contracts/test/fixtures/platform-information-v1-current.json",
      platform_path: "packages/contracts/test/fixtures/platform-information-v1-current.json"
    },
    {
      artifact: "platform_information_legacy_fixture",
      harness_path: "packages/contracts/test/fixtures/platform-information-v0-legacy.json",
      platform_path: "packages/contracts/test/fixtures/platform-information-v0-legacy.json"
    },
    {
      artifact: "platform_information_declaration",
      harness_path: "packages/contracts/dist/platform-information.d.ts",
      platform_path: "packages/contracts/dist/platform-information.d.ts"
    }
  ];
  const hashes = {};
  let failed = false;

  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const load = async (repository, root, artifact, path) => {
    try {
      return await readFile(resolve(root, path));
    } catch (error) {
      const reasonCode = error?.code === "ENOENT" ? "artifact_missing" : "artifact_read_failed";
      finish({
        ok: false,
        reason_code: reasonCode,
        repository,
        artifact,
        path,
        ...(error?.code === undefined ? {} : { error_code: error.code })
      }, 1);
      failed = true;
      return undefined;
    }
  };

  for (const item of artifacts) {
    if (failed) break;
    const harnessBytes = await load(
      "harness", harnessRoot, item.artifact, item.harness_path
    );
    if (failed) break;
    const platformBytes = await load(
      "platform", platformRoot, item.artifact, item.platform_path
    );
    if (failed) break;
    const harnessHash = digest(harnessBytes);
    const platformHash = digest(platformBytes);
    if (!harnessBytes.equals(platformBytes)) {
      finish({
        ok: false,
        reason_code: "artifact_byte_mismatch",
        artifact: item.artifact,
        harness_sha256: harnessHash,
        platform_sha256: platformHash,
        harness_bytes: harnessBytes.length,
        platform_bytes: platformBytes.length
      }, 1);
      failed = true;
      break;
    }
    hashes[item.artifact] = harnessHash;
  }

  if (!failed) {
    const openApiBytes = await readFile(resolve(
      harnessRoot, "packages/contracts/openapi/hunter-harness-v1.yaml"
    ));
    const sidecar = (await readFile(resolve(
      harnessRoot, "packages/contracts/openapi/hunter-harness-v1.yaml.sha256"
    ), "utf8")).trim();
    if (!/^[a-f0-9]{64}$/u.test(sidecar)) {
      finish({
        ok: false,
        reason_code: "sidecar_invalid",
        sidecar_length: Buffer.byteLength(sidecar, "utf8"),
        sidecar_sha256: digest(Buffer.from(sidecar, "utf8"))
      }, 1);
    } else {
      const actualHash = digest(openApiBytes);
      if (sidecar !== actualHash) {
        finish({
          ok: false,
          reason_code: "sidecar_mismatch",
          expected_sha256: sidecar,
          actual_sha256: actualHash
        }, 1);
      } else {
        const document = parseYaml(openApiBytes.toString("utf8"));
        const schemas = document?.components?.schemas ?? {};
        const query = schemas.PlatformInformationQuery;
        const page = schemas.PlatformInformationPage;
        const exportResult = schemas.PlatformInformationExportResult;
        const restoreConfirmation = schemas.RestoreBranchFilesConfirmationIntent;
        const structuralParity = query?.additionalProperties === false &&
          query?.properties?.limit?.maximum === 100 &&
          query?.properties?.cursor?.pattern === "^[A-Za-z0-9_-]{16,512}$" &&
          query?.properties?.cursor_verification?.const === "server_port_required" &&
          typeof schemas.PlatformInformationPath?.pattern === "string" &&
          page?.additionalProperties === false &&
          page?.oneOf?.length === 6 &&
          schemas.KnowledgeExtractionRetryIntent?.properties?.request_only?.const === true &&
          exportResult?.properties?.pages?.maxItems === 10000 &&
          exportResult?.properties?.exported_count?.maximum === 1000000 &&
          exportResult?.properties?.range?.additionalProperties === false &&
          exportResult?.properties?.range?.properties?.limit?.maximum === 100 &&
          exportResult?.properties?.range?.properties?.cursor_verification?.const === "server_port_required" &&
          Array.isArray(exportResult?.properties?.range?.properties?.source_cursor?.type) &&
          exportResult.properties.range.properties.source_cursor.type.includes("null") &&
          schemas.RestoreBranchFilesIntent?.properties?.preview_only?.const === true &&
          restoreConfirmation?.additionalProperties === false &&
          restoreConfirmation?.oneOf?.length === 2;
        if (!structuralParity) {
          finish({ ok: false, reason_code: "platform_information_openapi_constraint_drift" }, 1);
        } else {
          const harnessModule = await import(pathToFileURL(resolve(
            harnessRoot, "packages/contracts/dist/platform-information.js"
          )).href + `?parity=${Date.now()}`);
          const platformModule = await import(pathToFileURL(resolve(
            platformRoot, "packages/contracts/dist/platform-information.js"
          )).href + `?parity=${Date.now()}`);
          const harnessContentModule = await import(pathToFileURL(resolve(
            harnessRoot, "packages/contracts/dist/content-sync.js"
          )).href + `?parity=${Date.now()}`);
          const platformContentModule = await import(pathToFileURL(resolve(
            platformRoot, "packages/contracts/dist/content-sync.js"
          )).href + `?parity=${Date.now()}`);
          const current = JSON.parse(await readFile(resolve(
            harnessRoot, "packages/contracts/test/fixtures/platform-information-v1-current.json"
          ), "utf8"));
          const queryValue = current.queries[1];
          const pages = current.pages;
          const exportValue = current.export_result;
          const confirmation = current.restore_confirmation_intent;
          const contentCurrent = JSON.parse(await readFile(resolve(
            harnessRoot, "packages/contracts/test/fixtures/content-sync-v1-current.json"
          ), "utf8"));
          const matrices = [
            ["platformInformationQuerySchema", queryValue, true],
            ["platformInformationQuerySchema", { ...queryValue, limit: 101 }, false],
            ["platformInformationQuerySchema", { ...queryValue, cursor: "offset=25" }, false],
            ["platformInformationQuerySchema", { ...queryValue, unexpected: true }, false],
            ["platformInformationPageSchema", pages[2], true],
            ["platformInformationPageSchema", { ...pages[2], failures: [{ reason_code: "PROJECT_INFORMATION_UNAVAILABLE", retryable: true }] }, false],
            ["platformInformationPageSchema", pages[3], true],
            ["platformInformationPageSchema", { ...pages[3], items: [] }, false],
            ["platformInformationPageSchema", current.knowledge_failed_page, true],
            ["platformInformationPageSchema", { ...current.knowledge_failed_page, view: "branch_files", sort: "uploaded_at_desc_snapshot_version_asc" }, false],
            ["knowledgeExtractionRetryIntentSchema", current.knowledge_retry_intent, true],
            ["knowledgeExtractionRetryIntentSchema", { ...current.knowledge_retry_intent, request_only: false }, false],
            ["platformInformationPageSchema", { ...pages[4], next_cursor: "pic_Zm9yYmlkZGVuOjI1" }, false],
            ["platformInformationExportResultSchema", exportValue, true],
            ["platformInformationExportResultSchema", { ...exportValue, pages: [
              { request_cursor: null, response_next_cursor: null, result_count: 3 }
            ], exported_count: 3 }, true],
            ["platformInformationExportResultSchema", { ...exportValue, exported_count: 1 }, false],
            ["platformInformationExportResultSchema", { ...exportValue, range: {
              ...exportValue.range, sort: "uploaded_at_desc_snapshot_version_asc"
            } }, false],
            ["platformInformationExportResultSchema", { ...exportValue, pages: [
              { request_cursor: "pic_a25vd2xlZGdlOjA", response_next_cursor: "pic_a25vd2xlZGdlOjI1", result_count: 1 },
              { request_cursor: "pic_a25vd2xlZGdlOjI1", response_next_cursor: "pic_a25vd2xlZGdlOjA", result_count: 1 },
              { request_cursor: "pic_a25vd2xlZGdlOjA", response_next_cursor: null, result_count: 1 }
            ], exported_count: 3 }, false],
            ["restoreBranchFilesConfirmationIntentSchema", confirmation, true],
            ["restoreBranchFilesConfirmationIntentSchema", { ...confirmation, preview_hash: `sha256:${"f".repeat(64)}` }, true],
            ["restoreBranchFilesConfirmationIntentSchema", { ...confirmation, action: "stop" }, false]
          ];
          const matrixFailure = matrices.find(([schemaName, value, expected]) => {
            const harnessAccepted = harnessModule[schemaName].safeParse(value).success;
            const platformAccepted = platformModule[schemaName].safeParse(value).success;
            return harnessAccepted !== expected || platformAccepted !== expected || harnessAccepted !== platformAccepted;
          });
          const legacySerialized = await readFile(resolve(
            harnessRoot, "packages/contracts/test/fixtures/platform-information-v0-legacy.json"
          ), "utf8");
          const readerCases = [
            [legacySerialized, true, "legacy_read_only"],
            [{ schema_version: 1 }, false, "PLATFORM_INFORMATION_SERIALIZED_JSON_REQUIRED"],
            [JSON.stringify({ schema_version: 2 }), false, "PLATFORM_INFORMATION_VERSION_UNSUPPORTED"]
          ];
          const readerFailure = readerCases.find(([value, expectedOk, expectedReason]) => {
            const harnessResult = harnessModule.readPlatformInformationContract(value);
            const platformResult = platformModule.readPlatformInformationContract(value);
            const actual = harnessResult.ok ? harnessResult.mode : harnessResult.reason_code;
            return JSON.stringify(harnessResult) !== JSON.stringify(platformResult) ||
              harnessResult.ok !== expectedOk || actual !== expectedReason;
          });
          const exportQuery = current.queries[3];
          const exportVerificationCases = [
            [JSON.stringify(exportValue), exportQuery, true, undefined],
            [JSON.stringify({ ...exportValue, range: { ...exportValue.range,
              query_scope: { ...exportValue.range.query_scope, actor_id: "actor_2" }
            } }), exportQuery, false, "PLATFORM_INFORMATION_EXPORT_RANGE_MISMATCH"],
            [exportValue, exportQuery, false, "PLATFORM_INFORMATION_EXPORT_SERIALIZED_JSON_REQUIRED"]
          ];
          const exportVerificationFailure = exportVerificationCases.find(([value, queryInput,
            expectedOk, expectedReason]) => {
            const harnessResult = harnessModule.verifyPlatformInformationExportResult(value, queryInput);
            const platformResult = platformModule.verifyPlatformInformationExportResult(value, queryInput);
            return JSON.stringify(harnessResult) !== JSON.stringify(platformResult) ||
              harnessResult.ok !== expectedOk ||
              (!harnessResult.ok && harnessResult.reason_code !== expectedReason);
          });
          const preview = current.restore_preview_receipt;
          const combinationCases = [
            [preview, confirmation, true],
            [preview, { ...confirmation, preview_hash: `sha256:${"f".repeat(64)}` }, false],
            [preview, { ...confirmation, conflict_decisions: [] }, false],
            [preview, { ...confirmation, conflict_decisions: [
              ...confirmation.conflict_decisions,
              { ...confirmation.conflict_decisions[0], path: "invented.md" }
            ] }, false]
          ];
          const combinationFailure = combinationCases.find(([previewValue, confirmationValue, expected]) => {
            const harnessResult = harnessModule.validateBranchFilesPullConfirmation(
              JSON.stringify(previewValue), JSON.stringify(confirmationValue));
            const platformResult = platformModule.validateBranchFilesPullConfirmation(
              JSON.stringify(previewValue), JSON.stringify(confirmationValue));
            return JSON.stringify(harnessResult) !== JSON.stringify(platformResult) ||
              harnessResult.ok !== expected;
          });
          const receiptCases = [
            [JSON.stringify(contentCurrent.archive_ingest_receipts.queued), true],
            [JSON.stringify(contentCurrent.archive_ingest_receipts.planning_failed), true],
            [JSON.stringify({ ...contentCurrent.archive_ingest_receipts.queued,
              retryable: true }), false],
            [JSON.stringify({ ...contentCurrent.archive_ingest_receipts.planning_failed,
              archive_status: { ...contentCurrent.archive_ingest_receipts.planning_failed.archive_status,
                updated_at: "2026-08-12T01:12:30.000Z" },
              knowledge_extraction_status: {
                ...contentCurrent.archive_ingest_receipts.planning_failed.knowledge_extraction_status,
                updated_at: "2026-08-12T01:14:00.000Z",
                reason_code: "KNOWLEDGE_JOB_PLAN_FAILED" } }), true],
            [JSON.stringify(Object.fromEntries(
              Object.entries(contentCurrent.archive_ingest_receipts.queued)
                .filter(([key]) => key !== "retryable")
            )), false],
            [contentCurrent.archive_ingest_receipts.queued, false]
          ];
          const receiptFailure = receiptCases.find(([value, expected]) => {
            const harnessResult = harnessContentModule.readArchiveIngestReceipt(value);
            const platformResult = platformContentModule.readArchiveIngestReceipt(value);
            return JSON.stringify(harnessResult) !== JSON.stringify(platformResult) ||
              harnessResult.ok !== expected;
          });
          if (matrixFailure !== undefined || readerFailure !== undefined || exportVerificationFailure !== undefined ||
              combinationFailure !== undefined ||
              receiptFailure !== undefined) {
            finish({ ok: false, reason_code: "platform_information_runtime_parity_failed",
              schema: matrixFailure?.[0] ?? (exportVerificationFailure !== undefined
                ? "export_verifier" : receiptFailure === undefined
                  ? "serialized_reader" : "archive_ingest_receipt") }, 1);
          } else {
            finish({ ok: true, reason_code: "parity_verified", artifacts: hashes,
              platform_information_matrix_cases: matrices.length + readerCases.length +
                exportVerificationCases.length + combinationCases.length,
              archive_ingest_receipt_matrix_cases: receiptCases.length }, 0);
          }
        }
      }
    }
  }
}
