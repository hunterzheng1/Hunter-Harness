import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";

import * as contractExports from "../src/index.js";
import type {
  BranchSnapshot,
  BranchSnapshotPage,
  ContentPathClassificationResult,
  ContentPathClassificationValidationResult,
  ContentSyncValidationReasonCode,
  RemoteVersionIdentity,
  SnapshotFile,
  SnapshotFilePage,
  SnapshotVersion,
  SnapshotVersionPage
} from "../src/index.js";
import {
  INSTRUCTION_ENTRYPOINTS,
  archiveIngestReceiptSchema,
  archiveStatusSchema,
  archiveStatusValueSchema,
  archivePackageReceiptSchema,
  branchSnapshotPageSchema,
  branchSnapshotSchema,
  changeIndexStatusSchema,
  changeIndexStatusValueSchema,
  conflictResolutionSchema,
  candidateProvenanceSourceKindSchema,
  classifyContentPath,
  contentPathClassificationInputSchema,
  contentPathClassificationResultSchema,
  contentPathClassificationSuccessSchema,
  contentPathReasonCodeSchema,
  contentKindSchema,
  contentScanPolicySchema,
  contentSyncStatusesSchema,
  contentSyncValidationReasonCodeSchema,
  knowledgeCandidateEntryTypeSchema,
  knowledgeCandidateSchema,
  knowledgeIngestEntryTypeSchema,
  knowledgeCandidateStatusSchema,
  knowledgeExtractionStatusSchema,
  knowledgeExtractionStatusValueSchema,
  instructionEntrypointSchema,
  getLegacyArchiveCompatibilityResult,
  readArchiveIngestReceipt,
  legacyArchiveCompatibilityResultSchema,
  legacyArchivePackageReceiptSchema,
  managedSnapshotStatusSchema,
  managedSnapshotStatusValueSchema,
  mayContainArchiveDeliverables,
  projectContentCandidateStatusSchema,
  projectContentCandidateTypeSchema,
  pullPolicySchema,
  projectContentCandidateSchema,
  remoteVersionIdentitySchema,
  snapshotFilePageSchema,
  snapshotFileSchema,
  snapshotVersionPageSchema,
  snapshotVersionSchema,
  syncActionSchema,
  syncDirectionSchema,
  syncScopeSchema,
  validateContentPathClassificationResult
} from "../src/index.js";

const validateClassificationResult = validateContentPathClassificationResult;

const jsonSpecialOwnKeys = [
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__"
] as const;

function jsonRecordWithExtra(
  value: Readonly<Record<string, unknown>>,
  key: string
): Record<string, unknown> {
  return JSON.parse(JSON.stringify(Object.fromEntries([
    ...Object.entries(value),
    [key, true]
  ]))) as Record<string, unknown>;
}

function withEnumerableThrowingGetter(
  value: Readonly<Record<string, unknown>>,
  key: string,
  onGet: () => void
): Record<string, unknown> {
  const result = Object.assign(Object.create(null) as Record<string, unknown>, value);
  Object.defineProperty(result, key, {
    configurable: true,
    enumerable: true,
    get() {
      onGet();
      throw new Error(`getter executed: ${key}`);
    }
  });
  return result;
}

interface ExactEnumSchema {
  readonly options: readonly string[];
  array(): { parse(input: unknown): unknown };
}

function expectExactEnum(
  schema: ExactEnumSchema,
  fixtureValue: unknown,
  expected: readonly string[]
): void {
  expect(schema.options).toEqual(expected);
  expect(schema.array().parse(fixtureValue)).toEqual(expected);
}

function replaceNestedField(
  input: Readonly<Record<string, unknown>>,
  path: readonly string[],
  value: unknown,
  omit: boolean
): Record<string, unknown> {
  const [field, ...remainingPath] = path;
  if (field === undefined) return { ...input };
  const result = { ...input };
  if (remainingPath.length === 0) {
    if (omit) {
      return Object.fromEntries(
        Object.entries(input).filter(([key]) => key !== field)
      );
    }
    result[field] = value;
    return result;
  }
  const nested = input[field];
  if (nested === null || typeof nested !== "object" || Array.isArray(nested)) {
    throw new Error(`expected object at ${field}`);
  }
  result[field] = replaceNestedField(
    nested as Readonly<Record<string, unknown>>,
    remainingPath,
    value,
    omit
  );
  return result;
}

const currentFixturePath = fileURLToPath(
  new URL("./fixtures/content-sync-v1-current.json", import.meta.url)
);
const legacyFixturePath = fileURLToPath(
  new URL("./fixtures/content-sync-v0-legacy.json", import.meta.url)
);
const contentSyncSourcePath = fileURLToPath(
  new URL("../src/content-sync.ts", import.meta.url)
);
const archiveOutboxFixturePath = fileURLToPath(
  new URL("../../core/test/fixtures/archive-outbox-v1-current.json", import.meta.url)
);

async function readCurrentFixture(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(currentFixturePath, "utf8")) as Record<string, unknown>;
}

async function readLegacyFixture(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(legacyFixturePath, "utf8")) as Record<string, unknown>;
}

describe("stage 01 content and sync contracts", () => {
  it("keeps the shared content-sync contract free of Node builtins", async () => {
    const source = await readFile(contentSyncSourcePath, "utf8");
    expect(source).not.toMatch(/from\s+["']node:/u);
  });

  it("accepts and exactly echoes the canonical ArchiveOutbox request identity", async () => {
    const fixture = await readCurrentFixture();
    const queued = (fixture.archive_ingest_receipts as Record<string, Record<string, unknown>>)
      .queued;
    const outbox = JSON.parse(await readFile(archiveOutboxFixturePath, "utf8")) as {
      request_id: string;
      idempotency_key: string;
    };
    const receipt = {
      ...queued,
      request_id: outbox.request_id,
      idempotency_key: outbox.idempotency_key
    };

    expect(archiveIngestReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(readArchiveIngestReceipt(JSON.stringify(receipt))).toEqual({
      ok: true,
      value: receipt
    });
    expect(archiveIngestReceiptSchema.safeParse({
      ...receipt,
      request_id: `archive_request:${"A".repeat(64)}`
    }).success).toBe(false);
    expect(archiveIngestReceiptSchema.safeParse({
      ...receipt,
      idempotency_key: `kex_${"1".repeat(64)}`
    }).success).toBe(false);
  });

  it("reads canonical archive ingest receipts and fails closed on drift or hostile input", async () => {
    const fixture = await readCurrentFixture();
    const receipts = fixture.archive_ingest_receipts as Record<string, Record<string, unknown>>;
    for (const receipt of Object.values(receipts)) {
      expect(archiveIngestReceiptSchema.parse(receipt)).toEqual(receipt);
      expect(readArchiveIngestReceipt(JSON.stringify(receipt))).toEqual({ ok: true, value: receipt });
      expect(readArchiveIngestReceipt({ ...receipt, retryable: true })).toEqual({
        ok: false, reason_code: "ARCHIVE_INGEST_RECEIPT_JSON_INVALID"
      });
      expect(readArchiveIngestReceipt({ ...receipt, reason_code: "REMOTE_UNAVAILABLE" }))
        .toEqual({ ok: false, reason_code: "ARCHIVE_INGEST_RECEIPT_JSON_INVALID" });
    }
    const failed = receipts.planning_failed;
    expect(failed).toBeDefined();
    expect(archiveIngestReceiptSchema.safeParse({
      ...failed,
      knowledge_extraction_status: {
        ...(failed.knowledge_extraction_status as object),
        updated_at: "2026-08-12T01:14:00.000Z",
        reason_code: "DIFFERENT_REASON"
      }
    }).success).toBe(true);
    expect(readArchiveIngestReceipt(JSON.stringify({ ...receipts.queued, schema_version: 2 })))
      .toEqual({ ok: false, reason_code: "ARCHIVE_INGEST_RECEIPT_VERSION_UNSUPPORTED" });
    let getterCalls = 0;
    expect(readArchiveIngestReceipt(withEnumerableThrowingGetter(
      receipts.queued,
      "archive_status",
      () => { getterCalls += 1; }
    ))).toEqual({ ok: false, reason_code: "ARCHIVE_INGEST_RECEIPT_JSON_INVALID" });
    expect(getterCalls).toBe(0);
    let proxyCalls = 0;
    const hostile = new Proxy(receipts.queued, {
      ownKeys() { proxyCalls += 1; throw new Error("proxy executed"); },
      getOwnPropertyDescriptor() { proxyCalls += 1; throw new Error("proxy executed"); }
    });
    expect(readArchiveIngestReceipt(hostile)).toEqual({
      ok: false, reason_code: "ARCHIVE_INGEST_RECEIPT_JSON_INVALID"
    });
    expect(proxyCalls).toBe(0);
    const legacy = await readLegacyFixture();
    expect(readArchiveIngestReceipt(JSON.stringify((legacy.receipts as unknown[])[0])))
      .toEqual({ ok: false, reason_code: "ARCHIVE_INGEST_RECEIPT_SCHEMA_INVALID" });
  });
  it("validates exact v1 success and failure classification results through the domain seam", () => {
    const success = {
      schema_version: 1,
      content_kind: "instruction",
      sync_scope: "instructions",
      pull_policy: "regular",
      content_scan_policy: "required"
    } as const;
    const failure = {
      schema_version: 1,
      reason_code: "CONTENT_PATH_UNCLASSIFIED"
    } as const;

    expectTypeOf(validateContentPathClassificationResult).toEqualTypeOf<
      (input: unknown) => ContentPathClassificationValidationResult
    >();
    const validatedSuccess = validateClassificationResult(success);
    const validatedFailure = validateClassificationResult(failure);
    expect(validatedSuccess).toEqual({ ok: true, value: success });
    expect(validatedFailure).toEqual({ ok: true, value: failure });
    if (validatedSuccess.ok) {
      expectTypeOf(validatedSuccess.value).toEqualTypeOf<ContentPathClassificationResult>();
    }
    if (!validatedFailure.ok) {
      expectTypeOf(validatedFailure.reason_code)
        .toEqualTypeOf<ContentSyncValidationReasonCode>();
    }
  });

  it.each([
    ["success content kind", {
      schema_version: 1,
      content_kind: "bogus",
      sync_scope: "instructions",
      pull_policy: "regular",
      content_scan_policy: "required"
    }],
    ["failure reason code", {
      schema_version: 1,
      reason_code: "CONTENT_PATH_NOT_REAL"
    }]
  ])("maps an unknown frozen %s string to the enum reason at the domain seam", (_name, value) => {
    expect(validateClassificationResult(value)).toEqual({
      ok: false,
      reason_code: "CONTENT_SYNC_ENUM_INVALID"
    });
  });

  it.each([
    ["unsupported", {
      schema_version: 2,
      path: "src/app.ts",
      source_kind: "archive_package",
      unexpected: true
    }],
    ["non-number", {
      schema_version: "1",
      path: "src/app.ts",
      source_kind: "archive_package",
      unexpected: true
    }],
    ["missing", {
      path: "src/app.ts",
      source_kind: "archive_package",
      unexpected: true
    }]
  ])("keeps classifier %s schema_version failure ahead of enum and unknown evidence", (
    _name,
    value
  ) => {
    expect(classifyContentPath(value)).toEqual({
      schema_version: 1,
      reason_code: "CONTENT_SYNC_SCHEMA_INVALID"
    });
  });

  it.each([
    ["success", {
      schema_version: 1,
      content_kind: "bogus",
      sync_scope: "instructions",
      pull_policy: "regular",
      content_scan_policy: "required",
      unexpected: true
    }],
    ["failure", {
      schema_version: 1,
      reason_code: "CONTENT_PATH_NOT_REAL",
      unexpected: true
    }]
  ])("prioritizes a real unknown field over enum and schema issues in the %s root", (
    _name,
    value
  ) => {
    expect(validateClassificationResult(value)).toEqual({
      ok: false,
      reason_code: "CONTENT_SYNC_UNKNOWN_FIELD"
    });
  });

  it("does not expose a generic ZodError-only validation reason mapper", () => {
    const legacyMapperName = ["getContentSync", "ValidationReasonCode"].join("");
    expect(Object.hasOwn(contractExports, legacyMapperName)).toBe(false);
  });

  it.each(jsonSpecialOwnKeys)(
    "rejects the real JSON own key %s in a failure result",
    (key) => {
      expect(validateClassificationResult(jsonRecordWithExtra({
        schema_version: 1,
        reason_code: "CONTENT_PATH_UNCLASSIFIED"
      }, key))).toEqual({
        ok: false,
        reason_code: "CONTENT_SYNC_UNKNOWN_FIELD"
      });
    }
  );

  it("rejects a JSON __proto__ own key in success results and classifier inputs", () => {
    const success = JSON.parse(
      "{\"schema_version\":1,\"content_kind\":\"instruction\"," +
      "\"sync_scope\":\"instructions\",\"pull_policy\":\"regular\"," +
      "\"content_scan_policy\":\"required\",\"__proto__\":true}"
    ) as Record<string, unknown>;
    const classifier = JSON.parse(
      "{\"schema_version\":1,\"path\":\"src/app.ts\",\"__proto__\":true}"
    ) as Record<string, unknown>;

    expect(Object.keys(success)).toContain("__proto__");
    expect(Object.keys(classifier)).toContain("__proto__");
    expect(validateClassificationResult(success)).toEqual({
      ok: false,
      reason_code: "CONTENT_SYNC_UNKNOWN_FIELD"
    });
    expect(classifyContentPath(classifier)).toEqual({
      schema_version: 1,
      reason_code: "CONTENT_SYNC_UNKNOWN_FIELD"
    });
  });

  it("keeps schema-version failure above JSON special own keys", () => {
    const invalidVersion = jsonRecordWithExtra({
      schema_version: 2,
      reason_code: "CONTENT_PATH_UNCLASSIFIED"
    }, "__proto__");
    const invalidClassifierVersion = jsonRecordWithExtra({
      schema_version: 2,
      path: "src/app.ts"
    }, "__proto__");

    expect(validateClassificationResult(invalidVersion)).toEqual({
      ok: false,
      reason_code: "CONTENT_SYNC_SCHEMA_INVALID"
    });
    expect(classifyContentPath(invalidClassifierVersion)).toEqual({
      schema_version: 1,
      reason_code: "CONTENT_SYNC_SCHEMA_INVALID"
    });
  });

  it("keeps normal JSON classification values valid without extra own keys", () => {
    const failure = JSON.parse(
      "{\"schema_version\":1,\"reason_code\":\"CONTENT_PATH_UNCLASSIFIED\"}"
    ) as Record<string, unknown>;
    const classifier = JSON.parse(
      "{\"schema_version\":1,\"path\":\"src/app.ts\"}"
    ) as Record<string, unknown>;

    expect(validateClassificationResult(failure)).toEqual({ ok: true, value: failure });
    expect(classifyContentPath(classifier)).toEqual({
      schema_version: 1,
      reason_code: "CONTENT_PATH_UNCLASSIFIED"
    });
  });

  it("requires schema_version to be an own field at both public domain seams", () => {
    const inheritedVersionSuccess = Object.assign(
      Object.create({ schema_version: 1 }) as object,
      {
        content_kind: "instruction",
        sync_scope: "instructions",
        pull_policy: "regular",
        content_scan_policy: "required"
      }
    );
    const inheritedVersionFailure = Object.assign(
      Object.create({ schema_version: 1 }) as object,
      { reason_code: "CONTENT_PATH_UNCLASSIFIED" }
    );
    const inheritedVersionClassifier = Object.assign(
      Object.create({ schema_version: 1 }) as object,
      { path: "src/app.ts", source_kind: "branch_file" }
    );

    expect(validateClassificationResult(inheritedVersionSuccess)).toEqual({
      ok: false,
      reason_code: "CONTENT_SYNC_SCHEMA_INVALID"
    });
    expect(validateClassificationResult(inheritedVersionFailure)).toEqual({
      ok: false,
      reason_code: "CONTENT_SYNC_SCHEMA_INVALID"
    });
    expect(classifyContentPath(inheritedVersionClassifier)).toEqual({
      schema_version: 1,
      reason_code: "CONTENT_SYNC_SCHEMA_INVALID"
    });
    expect(validateClassificationResult({
      schema_version: 1,
      reason_code: "CONTENT_PATH_UNCLASSIFIED"
    })).toEqual({
      ok: true,
      value: { schema_version: 1, reason_code: "CONTENT_PATH_UNCLASSIFIED" }
    });
    expect(classifyContentPath({
      schema_version: 1,
      path: "src/app.ts"
    })).toEqual({
      schema_version: 1,
      reason_code: "CONTENT_PATH_UNCLASSIFIED"
    });
  });

  it("classifies archive deliverable documents as branch files and still rejects process files", () => {
    const change = ".harness/archive/2026-08-17-usage-stats-cli-reporting";
    const branchFile = {
      schema_version: 1,
      content_kind: "branch_file",
      sync_scope: "branch_files",
      pull_policy: "explicit_source_only",
      content_scan_policy: "required"
    };
    // 有实际意义的交付物：plans / spec / docs 全部，reports 只取 final/ 的定稿。
    // 边界与归档 ZIP 一致——review/ 与 test/ 是过程产物，两条通道都不收。
    for (const path of [
      `${change}/plans/usage-stats-cli-reporting-plan.md`,
      `${change}/plans/usage-stats-cli-reporting-design.md`,
      `${change}/spec/spec.md`,
      `${change}/reports/final/summary-data.json`,
      `${change}/reports/final/nested/attachment.md`,
      `${change}/docs/note.md`
    ]) {
      expect(classifyContentPath({ schema_version: 1, path }), path).toEqual(branchFile);
    }
    // 过程文件：不上传，减少上传压力。归档树整体仍是 non-scannable，交付物只是其中开的口子；
    // 且 *.log 一类先被 runtime 规则拦下——两层顺序不能因为这个口子而错位。
    const excluded = [
      [`${change}/runtime/phase-context/current.json`, "CONTENT_PATH_NON_SCANNABLE_KIND"],
      [`${change}/runtime/run-sessions/session.json`, "CONTENT_PATH_NON_SCANNABLE_KIND"],
      [`${change}/meta/publication-journals/journal.json`, "CONTENT_PATH_NON_SCANNABLE_KIND"],
      [`${change}/evidence/fixback/evidence.txt`, "CONTENT_PATH_NON_SCANNABLE_KIND"],
      [`${change}/fixback/batches/batch.json`, "CONTENT_PATH_NON_SCANNABLE_KIND"],
      [`${change}/.publication-staging/pending/payload.json`, "CONTENT_PATH_NON_SCANNABLE_KIND"],
      // reports/ 下只有 final/ 是定稿；review/ 与 test/ 是过程产物，与归档 ZIP 边界一致
      [`${change}/reports/review/review-report-20260817-0950.md`, "CONTENT_PATH_NON_SCANNABLE_KIND"],
      [`${change}/reports/review/review-findings.json`, "CONTENT_PATH_NON_SCANNABLE_KIND"],
      [`${change}/reports/test/test-report-20260817-0930.md`, "CONTENT_PATH_NON_SCANNABLE_KIND"],
      // 直接散落在 reports/ 下、不在 final/ 里的文件同样不算交付物
      [`${change}/reports/loose.md`, "CONTENT_PATH_NON_SCANNABLE_KIND"],
      // 目录名前缀相同但不是交付物目录，不得放行
      [`${change}/plans-scratch/draft.md`, "CONTENT_PATH_NON_SCANNABLE_KIND"],
      [`${change}/plans`, "CONTENT_PATH_NON_SCANNABLE_KIND"],
      // 归档根下的散落文件不属于任何交付物分组
      [`${change}/notes.md`, "CONTENT_PATH_NON_SCANNABLE_KIND"],
      [".harness/archive/loose.json", "CONTENT_PATH_NON_SCANNABLE_KIND"],
      // 交付物目录下的日志/暂存物仍被更早的安全规则拦下
      [`${change}/logs/execution.log`, "CONTENT_PATH_RUNTIME_EXCLUDED"],
      [`${change}/reports/final/debug.log`, "CONTENT_PATH_RUNTIME_EXCLUDED"],
      [`${change}/plans/scratch.tmp`, "CONTENT_PATH_RUNTIME_EXCLUDED"],
      [`${change}/reports/credentials.local.yaml`, "CONTENT_PATH_CREDENTIALS_EXCLUDED"],
      [`${change}/spec/.env.production`, "CONTENT_PATH_ENV_EXCLUDED"]
    ] as const;
    for (const [path, reasonCode] of excluded) {
      expect(classifyContentPath({ schema_version: 1, path }), path).toEqual({
        schema_version: 1,
        reason_code: reasonCode
      });
    }
  });

  it("lets the workspace walk descend only the archive directories that can hold deliverables", () => {
    const change = ".harness/archive/2026-08-17-usage-stats-cli-reporting";
    // 遍历必须能下钻到分组目录，否则归档树在第一层就被剪枝，交付物走不到分类。
    for (const path of [
      ".harness/archive",
      change,
      `${change}/plans`,
      `${change}/spec`,
      // reports/ 本身必须放行下钻，否则到不了 final/
      `${change}/reports`,
      `${change}/reports/final`,
      `${change}/reports/final/nested`,
      `${change}/docs`
    ]) {
      expect(mayContainArchiveDeliverables(path), path).toBe(true);
    }
    // 过程目录与非归档路径一律不下钻。
    for (const path of [
      `${change}/runtime`,
      `${change}/runtime/phase-context`,
      `${change}/meta`,
      `${change}/evidence`,
      `${change}/logs`,
      `${change}/fixback`,
      `${change}/.publication-staging`,
      `${change}/plans-scratch`,
      // reports/ 下的过程子目录不下钻——省掉整棵子树的遍历开销
      `${change}/reports/review`,
      `${change}/reports/test`,
      ".harness/archives",
      ".harness/knowledge",
      ".harness/rules",
      ".harness",
      "src"
    ]) {
      expect(mayContainArchiveDeliverables(path), path).toBe(false);
    }
  });

  it("does not satisfy result fields or classifier policy from the prototype chain", () => {
    const inheritedSuccessFields = Object.assign(
      Object.create({
        sync_scope: "instructions",
        pull_policy: "regular",
        content_scan_policy: "required"
      }) as object,
      { schema_version: 1, content_kind: "instruction" }
    );
    const inheritedReasonCode = Object.assign(
      Object.create({ reason_code: "CONTENT_PATH_UNCLASSIFIED" }) as object,
      { schema_version: 1 }
    );
    const inheritedContentKind = Object.assign(
      Object.create({ content_kind: "instruction" }) as object,
      {
        schema_version: 1,
        sync_scope: "instructions",
        pull_policy: "regular",
        content_scan_policy: "required"
      }
    );
    const inheritedPath = Object.assign(
      Object.create({ path: "src/app.ts" }) as object,
      { schema_version: 1, source_kind: "branch_file" }
    );
    const inheritedExcludedPath = Object.assign(
      Object.create({ path: ".env" }) as object,
      {
        schema_version: 1,
        selected_instruction_entrypoints: ["bad"]
      }
    );
    const inheritedSourceKind = Object.assign(
      Object.create({ source_kind: "branch_file" }) as object,
      { schema_version: 1, path: "src/app.ts" }
    );

    expect(validateClassificationResult(inheritedSuccessFields)).toEqual({
      ok: false,
      reason_code: "CONTENT_SYNC_SCHEMA_INVALID"
    });
    expect(validateClassificationResult(inheritedReasonCode)).toEqual({
      ok: false,
      reason_code: "CONTENT_SYNC_SCHEMA_INVALID"
    });
    expect(validateClassificationResult(inheritedContentKind)).toEqual({
      ok: false,
      reason_code: "CONTENT_SYNC_SCHEMA_INVALID"
    });
    expect(classifyContentPath(inheritedPath)).toEqual({
      schema_version: 1,
      reason_code: "CONTENT_SYNC_SCHEMA_INVALID"
    });
    expect(classifyContentPath(inheritedExcludedPath)).toEqual({
      schema_version: 1,
      reason_code: "CONTENT_SYNC_SCHEMA_INVALID"
    });
    expect(classifyContentPath(inheritedSourceKind)).toEqual({
      schema_version: 1,
      reason_code: "CONTENT_PATH_UNCLASSIFIED"
    });
  });

  it("keeps plain, null-prototype, and string classification inputs supported", () => {
    const nullPrototypeResult = Object.assign(Object.create(null) as Record<string, unknown>, {
      schema_version: 1,
      reason_code: "CONTENT_PATH_UNCLASSIFIED"
    });
    const nullPrototypeClassifier = Object.assign(
      Object.create(null) as Record<string, unknown>,
      { schema_version: 1, path: "src/app.ts" }
    );

    expect(validateClassificationResult(nullPrototypeResult)).toEqual({
      ok: true,
      value: { schema_version: 1, reason_code: "CONTENT_PATH_UNCLASSIFIED" }
    });
    expect(classifyContentPath(nullPrototypeClassifier)).toEqual({
      schema_version: 1,
      reason_code: "CONTENT_PATH_UNCLASSIFIED"
    });
    expect(classifyContentPath("AGENTS.md")).toMatchObject({
      schema_version: 1,
      content_kind: "instruction"
    });
  });

  it("never executes an enumerable getter for any consumed result field", () => {
    const success = {
      schema_version: 1,
      content_kind: "instruction",
      sync_scope: "instructions",
      pull_policy: "regular",
      content_scan_policy: "required"
    };
    const failure = {
      schema_version: 1,
      reason_code: "CONTENT_PATH_UNCLASSIFIED"
    };
    const cases: readonly [string, Readonly<Record<string, unknown>>][] = [
      ...Object.keys(success).map((key) => [key, success] as const),
      ...Object.keys(failure).map((key) => [key, failure] as const)
    ];

    for (const [key, value] of cases) {
      let getterCalls = 0;
      const hostile = withEnumerableThrowingGetter(value, key, () => {
        getterCalls += 1;
      });
      expect(validateClassificationResult(hostile), key).toEqual({
        ok: false,
        reason_code: "CONTENT_SYNC_SCHEMA_INVALID"
      });
      expect(getterCalls, key).toBe(0);
    }
  });

  it("never executes an enumerable getter for any consumed classifier field", () => {
    const classifier = {
      schema_version: 1,
      path: "CLAUDE.md",
      selected_instruction_entrypoints: ["CLAUDE.md"],
      source_kind: "branch_file"
    };

    for (const key of Object.keys(classifier)) {
      let getterCalls = 0;
      const hostile = withEnumerableThrowingGetter(classifier, key, () => {
        getterCalls += 1;
      });
      expect(classifyContentPath(hostile), key).toEqual({
        schema_version: 1,
        reason_code: "CONTENT_SYNC_SCHEMA_INVALID"
      });
      expect(getterCalls, key).toBe(0);
    }
  });

  it("ignores inherited getters without executing them", () => {
    let getterCalls = 0;
    const resultPrototype = {};
    Object.defineProperty(resultPrototype, "sync_scope", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("inherited result getter executed");
      }
    });
    const result = Object.assign(Object.create(resultPrototype) as object, {
      schema_version: 1,
      content_kind: "instruction",
      pull_policy: "regular",
      content_scan_policy: "required"
    });
    const classifierPrototype = {};
    Object.defineProperty(classifierPrototype, "source_kind", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("inherited classifier getter executed");
      }
    });
    const classifier = Object.assign(Object.create(classifierPrototype) as object, {
      schema_version: 1,
      path: "src/app.ts"
    });

    expect(validateClassificationResult(result)).toEqual({
      ok: false,
      reason_code: "CONTENT_SYNC_SCHEMA_INVALID"
    });
    expect(classifyContentPath(classifier)).toEqual({
      schema_version: 1,
      reason_code: "CONTENT_PATH_UNCLASSIFIED"
    });
    expect(getterCalls).toBe(0);
  });

  it("returns schema-invalid for hostile root reflection without throwing", () => {
    const resultTarget = {
      schema_version: 1,
      reason_code: "CONTENT_PATH_UNCLASSIFIED"
    };
    const classifierTarget = { schema_version: 1, path: "src/app.ts" };
    const hostileFactories: readonly [string, (target: Record<string, unknown>) => object][] = [
      ["ownKeys", (target) => new Proxy(target, {
        ownKeys() {
          throw new Error("ownKeys trap");
        }
      })],
      ["descriptor", (target) => new Proxy(target, {
        getOwnPropertyDescriptor() {
          throw new Error("descriptor trap");
        }
      })]
    ];

    for (const [name, factory] of hostileFactories) {
      expect(validateClassificationResult(factory({ ...resultTarget })), name).toEqual({
        ok: false,
        reason_code: "CONTENT_SYNC_SCHEMA_INVALID"
      });
      expect(classifyContentPath(factory({ ...classifierTarget })), name).toEqual({
        schema_version: 1,
        reason_code: "CONTENT_SYNC_SCHEMA_INVALID"
      });
    }

    const revokedResult = Proxy.revocable({ ...resultTarget }, {});
    const revokedClassifier = Proxy.revocable({ ...classifierTarget }, {});
    revokedResult.revoke();
    revokedClassifier.revoke();
    expect(validateClassificationResult(revokedResult.proxy)).toEqual({
      ok: false,
      reason_code: "CONTENT_SYNC_SCHEMA_INVALID"
    });
    expect(classifyContentPath(revokedClassifier.proxy)).toEqual({
      schema_version: 1,
      reason_code: "CONTENT_SYNC_SCHEMA_INVALID"
    });
  });

  it("accepts stable data-descriptor proxies without invoking their get trap", () => {
    let getCalls = 0;
    const result = new Proxy({
      schema_version: 1,
      reason_code: "CONTENT_PATH_UNCLASSIFIED"
    }, {
      get() {
        getCalls += 1;
        throw new Error("result get trap executed");
      }
    });
    const classifier = new Proxy({
      schema_version: 1,
      path: "src/app.ts"
    }, {
      get() {
        getCalls += 1;
        throw new Error("classifier get trap executed");
      }
    });

    expect(validateClassificationResult(result)).toEqual({
      ok: true,
      value: { schema_version: 1, reason_code: "CONTENT_PATH_UNCLASSIFIED" }
    });
    expect(classifyContentPath(classifier)).toEqual({
      schema_version: 1,
      reason_code: "CONTENT_PATH_UNCLASSIFIED"
    });
    expect(getCalls).toBe(0);
  });

  it("rejects revoked proxies stored in consumed data fields without throwing", () => {
    const revokedValue = (): object => {
      const revocable = Proxy.revocable({}, {});
      revocable.revoke();
      return revocable.proxy;
    };
    const success = {
      schema_version: 1,
      content_kind: "instruction",
      sync_scope: "instructions",
      pull_policy: "regular",
      content_scan_policy: "required"
    };
    for (const key of Object.keys(success)) {
      expect(validateClassificationResult({
        ...success,
        [key]: revokedValue()
      }), key).toEqual({
        ok: false,
        reason_code: "CONTENT_SYNC_SCHEMA_INVALID"
      });
    }
    expect(validateClassificationResult({
      schema_version: 1,
      reason_code: revokedValue()
    })).toEqual({
      ok: false,
      reason_code: "CONTENT_SYNC_SCHEMA_INVALID"
    });
    for (const [key, value] of [
      ["schema_version", { schema_version: revokedValue(), path: "src/app.ts" }],
      ["path", { schema_version: 1, path: revokedValue() }],
      ["source_kind", {
        schema_version: 1,
        path: "src/app.ts",
        source_kind: revokedValue()
      }],
      ["selected element", {
        schema_version: 1,
        path: "CLAUDE.md",
        selected_instruction_entrypoints: [revokedValue()]
      }]
    ] as const) {
      expect(classifyContentPath(value), key).toEqual({
        schema_version: 1,
        reason_code: "CONTENT_SYNC_SCHEMA_INVALID"
      });
    }
  });

  it("ignores non-enumerable and symbol fields at the wire boundary", () => {
    let getterCalls = 0;
    const extraSymbol = Symbol("wire-extra");
    const result: Record<PropertyKey, unknown> = {
      schema_version: 1,
      reason_code: "CONTENT_PATH_UNCLASSIFIED"
    };
    Object.defineProperty(result, "hidden_extra", {
      enumerable: false,
      get() {
        getterCalls += 1;
        throw new Error("non-enumerable getter executed");
      }
    });
    Object.defineProperty(result, extraSymbol, {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("symbol getter executed");
      }
    });

    expect(validateClassificationResult(result)).toEqual({
      ok: true,
      value: { schema_version: 1, reason_code: "CONTENT_PATH_UNCLASSIFIED" }
    });
    expect(getterCalls).toBe(0);

    const nonEnumerableReason: Record<string, unknown> = { schema_version: 1 };
    Object.defineProperty(nonEnumerableReason, "reason_code", {
      enumerable: false,
      value: "CONTENT_PATH_UNCLASSIFIED"
    });
    expect(validateClassificationResult(nonEnumerableReason)).toEqual({
      ok: false,
      reason_code: "CONTENT_SYNC_SCHEMA_INVALID"
    });
  });

  it("snapshots selected entrypoint arrays without getters or holes", () => {
    let getterCalls = 0;
    const accessorArray: string[] = [];
    Object.defineProperty(accessorArray, "0", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("selected accessor executed");
      }
    });
    accessorArray.length = 1;
    const inheritedIndexArray = new Array<string>(1);
    const inheritedArrayPrototype = Object.create(Array.prototype) as object;
    Object.defineProperty(inheritedArrayPrototype, "0", {
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error("inherited selected getter executed");
      }
    });
    Object.setPrototypeOf(inheritedIndexArray, inheritedArrayPrototype);
    for (const selected of [accessorArray, new Array<string>(1), inheritedIndexArray]) {
      expect(classifyContentPath({
        schema_version: 1,
        path: "CLAUDE.md",
        selected_instruction_entrypoints: selected
      })).toEqual({
        schema_version: 1,
        reason_code: "CONTENT_SYNC_SCHEMA_INVALID"
      });
    }
    expect(getterCalls).toBe(0);
  });

  it("contains selected-array reflection failures and accepts a stable proxy", () => {
    const classifySelected = (selected: unknown): ContentPathClassificationResult =>
      classifyContentPath({
        schema_version: 1,
        path: "CLAUDE.md",
        selected_instruction_entrypoints: selected
      });
    const ownKeysFailure = new Proxy(["CLAUDE.md"], {
      ownKeys() {
        throw new Error("selected ownKeys trap");
      }
    });
    const descriptorFailure = new Proxy(["CLAUDE.md"], {
      getOwnPropertyDescriptor() {
        throw new Error("selected descriptor trap");
      }
    });
    const revoked = Proxy.revocable(["CLAUDE.md"], {});
    revoked.revoke();

    for (const selected of [ownKeysFailure, descriptorFailure, revoked.proxy]) {
      expect(classifySelected(selected)).toEqual({
        schema_version: 1,
        reason_code: "CONTENT_SYNC_SCHEMA_INVALID"
      });
    }

    let getCalls = 0;
    const stable = new Proxy(["CLAUDE.md"], {
      get() {
        getCalls += 1;
        throw new Error("selected get trap executed");
      }
    });
    expect(classifySelected(stable)).toMatchObject({
      schema_version: 1,
      content_kind: "instruction"
    });
    expect(getCalls).toBe(0);
  });

  it("keeps every primary path or source failure ahead of malformed selected input", () => {
    interface SelectedProbe {
      value: unknown;
      getterCalls: () => number;
      ownKeysCalls: () => number;
      descriptorCalls: () => number;
    }
    const inertCounts = {
      getterCalls: () => 0,
      ownKeysCalls: () => 0,
      descriptorCalls: () => 0
    };
    const selectedFactories: readonly [string, () => SelectedProbe][] = [
      ["non-string element", () => ({ value: [42], ...inertCounts })],
      ["non-array", () => ({ value: 42, ...inertCounts })],
      ["accessor", () => {
        let getterCalls = 0;
        const selected: string[] = [];
        Object.defineProperty(selected, "0", {
          enumerable: true,
          get() {
            getterCalls += 1;
            throw new Error("selected accessor executed");
          }
        });
        selected.length = 1;
        return {
          value: selected,
          getterCalls: () => getterCalls,
          ownKeysCalls: () => 0,
          descriptorCalls: () => 0
        };
      }],
      ["revoked", () => {
        const revocable = Proxy.revocable(["CLAUDE.md"], {});
        revocable.revoke();
        return { value: revocable.proxy, ...inertCounts };
      }],
      ["hole", () => ({ value: new Array<string>(1), ...inertCounts })],
      ["ownKeys trap", () => {
        let ownKeysCalls = 0;
        return {
          value: new Proxy(["CLAUDE.md"], {
            ownKeys() {
              ownKeysCalls += 1;
              throw new Error("selected ownKeys trap");
            }
          }),
          getterCalls: () => 0,
          ownKeysCalls: () => ownKeysCalls,
          descriptorCalls: () => 0
        };
      }],
      ["descriptor trap", () => {
        let descriptorCalls = 0;
        return {
          value: new Proxy(["CLAUDE.md"], {
            getOwnPropertyDescriptor() {
              descriptorCalls += 1;
              throw new Error("selected descriptor trap");
            }
          }),
          getterCalls: () => 0,
          ownKeysCalls: () => 0,
          descriptorCalls: () => descriptorCalls
        };
      }]
    ];
    const primaryCases: readonly [
      string,
      Readonly<Record<string, unknown>>,
      string
    ][] = [
      ["environment", {
        path: ".env",
        source_kind: "branch_file"
      }, "CONTENT_PATH_ENV_EXCLUDED"],
      ["traversal", {
        path: "src/../secret.txt",
        source_kind: "branch_file"
      }, "CONTENT_PATH_TRAVERSAL"],
      ["absolute", {
        path: "C:/secret.txt",
        source_kind: "branch_file"
      }, "CONTENT_PATH_ABSOLUTE"],
      ["invalid source kind", {
        path: "src/app.ts",
        source_kind: "archive_package"
      }, "CONTENT_SYNC_ENUM_INVALID"],
      ["normal", {
        path: "src/app.ts",
        source_kind: "branch_file"
      }, "CONTENT_SYNC_SCHEMA_INVALID"]
    ];

    for (const [selectedName, factory] of selectedFactories) {
      for (const [primaryName, primary, reasonCode] of primaryCases) {
        const selected = factory();
        expect(classifyContentPath({
          schema_version: 1,
          ...primary,
          selected_instruction_entrypoints: selected.value
        }), `${selectedName}/${primaryName}`).toEqual({
          schema_version: 1,
          reason_code: reasonCode
        });
        expect(selected.getterCalls(), `${selectedName}/${primaryName}`).toBe(0);
        if (primaryName !== "normal") {
          expect(selected.ownKeysCalls(), `${selectedName}/${primaryName}`).toBe(0);
          expect(selected.descriptorCalls(), `${selectedName}/${primaryName}`).toBe(0);
        }
      }
    }
  });

  it("returns root-primary validation failures before touching selected reflection", () => {
    const cases: readonly [
      string,
      Readonly<Record<string, unknown>>,
      string
    ][] = [
      ["version", { schema_version: 2, path: "src/app.ts" },
        "CONTENT_SYNC_SCHEMA_INVALID"],
      ["unknown root key", { schema_version: 1, path: "src/app.ts", unexpected: true },
        "CONTENT_SYNC_UNKNOWN_FIELD"],
      ["missing path", { schema_version: 1 }, "CONTENT_SYNC_SCHEMA_INVALID"],
      ["non-string path", { schema_version: 1, path: 42 },
        "CONTENT_SYNC_SCHEMA_INVALID"],
      ["non-string source", { schema_version: 1, path: "src/app.ts", source_kind: 42 },
        "CONTENT_SYNC_SCHEMA_INVALID"]
    ];

    for (const [name, input, reasonCode] of cases) {
      let ownKeysCalls = 0;
      const selected = new Proxy(["CLAUDE.md"], {
        ownKeys() {
          ownKeysCalls += 1;
          throw new Error("selected input must not be inspected");
        }
      });
      expect(classifyContentPath({
        ...input,
        selected_instruction_entrypoints: selected
      }), name).toEqual({ schema_version: 1, reason_code: reasonCode });
      expect(ownKeysCalls, name).toBe(0);
    }
  });

  it("caps selected entrypoints at the frozen domain cardinality before enumeration", () => {
    const tooMany = Array.from({ length: 4 }, () => "AGENTS.md");
    expect(contentPathClassificationInputSchema.safeParse({
      schema_version: 1,
      path: "AGENTS.md",
      selected_instruction_entrypoints: tooMany
    }).success).toBe(false);
    expect(classifyContentPath({
      schema_version: 1,
      path: "AGENTS.md",
      selected_instruction_entrypoints: tooMany
    })).toEqual({
      schema_version: 1,
      reason_code: "CONTENT_SYNC_SCHEMA_INVALID"
    });

    let ownKeysCalls = 0;
    const cappedProxy = new Proxy(tooMany, {
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error("oversized array must be rejected before enumeration");
      }
    });
    expect(classifyContentPath({
      schema_version: 1,
      path: "AGENTS.md",
      selected_instruction_entrypoints: cappedProxy
    })).toEqual({
      schema_version: 1,
      reason_code: "CONTENT_SYNC_SCHEMA_INVALID"
    });
    expect(ownKeysCalls).toBe(0);

    const atLimit = [...INSTRUCTION_ENTRYPOINTS];
    expect(contentPathClassificationInputSchema.safeParse({
      schema_version: 1,
      path: "CODEBUDDY.md",
      selected_instruction_entrypoints: atLimit
    }).success).toBe(true);
    expect(classifyContentPath({
      schema_version: 1,
      path: "CODEBUDDY.md",
      selected_instruction_entrypoints: atLimit
    })).toMatchObject({
      schema_version: 1,
      content_kind: "instruction"
    });
  });

  it.each([
    ["missing", {
      reason_code: "CONTENT_PATH_NOT_REAL",
      unexpected: true
    }],
    ["non-number", {
      schema_version: "1",
      content_kind: "bogus",
      sync_scope: "instructions",
      pull_policy: "regular",
      content_scan_policy: "required",
      unexpected: true
    }],
    ["unsupported", {
      schema_version: 2,
      content_kind: "bogus",
      reason_code: "CONTENT_PATH_NOT_REAL",
      unexpected: true
    }]
  ])("prioritizes a %s schema version over root, unknown-field, and enum evidence", (
    _name,
    value
  ) => {
    expect(validateClassificationResult(value)).toEqual({
      ok: false,
      reason_code: "CONTENT_SYNC_SCHEMA_INVALID"
    });
  });

  it.each([
    [null],
    ["not-an-object"],
    [42],
    [[]]
  ])("rejects non-object classification result input %# as schema-invalid", (value) => {
    expect(validateClassificationResult(value)).toEqual({
      ok: false,
      reason_code: "CONTENT_SYNC_SCHEMA_INVALID"
    });
  });

  it.each([
    ["success fields first", {
      schema_version: 1,
      content_kind: "instruction",
      sync_scope: "instructions",
      pull_policy: "regular",
      content_scan_policy: "required",
      reason_code: "CONTENT_PATH_UNCLASSIFIED"
    }],
    ["failure fields first", {
      schema_version: 1,
      reason_code: "CONTENT_PATH_UNCLASSIFIED",
      content_scan_policy: "required",
      pull_policy: "regular",
      sync_scope: "instructions",
      content_kind: "instruction"
    }]
  ])("rejects mixed success and failure fields as unknown in %s order", (_name, value) => {
    expect(validateClassificationResult(value)).toEqual({
      ok: false,
      reason_code: "CONTENT_SYNC_UNKNOWN_FIELD"
    });
  });

  it("accepts exactly the frozen v1 enumeration values", async () => {
    const fixture = await readCurrentFixture();
    const enums = fixture.enums as Record<string, unknown>;

    expect(fixture.schema_version).toBe(1);
    expectExactEnum(contentKindSchema, enums.content_kind, [
      "config",
      "rule",
      "architecture",
      "instruction",
      "branch_file",
      "change_document",
      "archive_package",
      "knowledge_entry",
      "knowledge_candidate",
      "project_content_candidate"
    ]);
    expectExactEnum(syncScopeSchema, enums.sync_scope, [
      "config",
      "rules",
      "architecture",
      "instructions",
      "branch_files",
      "archive"
    ]);
    expectExactEnum(syncDirectionSchema, enums.sync_direction, ["push", "pull"]);
    expectExactEnum(syncActionSchema, enums.sync_action, [
      "add",
      "modify",
      "delete",
      "restore",
      "rename",
      "no_change"
    ]);
    expectExactEnum(conflictResolutionSchema, enums.conflict_resolution, [
      "keep_local",
      "accept_remote",
      "skip",
      "cancel"
    ]);
    expectExactEnum(
      projectContentCandidateTypeSchema,
      enums.project_content_candidate_type,
      ["rule", "architecture-decision", "glossary"]
    );
    expectExactEnum(
      projectContentCandidateStatusSchema,
      enums.project_content_candidate_status,
      ["pending", "proposed", "accepted", "rejected", "superseded"]
    );
    expectExactEnum(
      knowledgeCandidateStatusSchema,
      enums.knowledge_candidate_status,
      ["pending", "accepted", "rejected", "superseded"]
    );
    expectExactEnum(
      candidateProvenanceSourceKindSchema,
      enums.provenance_source_kind,
      ["archive", "plan", "review", "manual", "migration"]
    );
    expectExactEnum(instructionEntrypointSchema, enums.instruction_entrypoint, [
      "AGENTS.md",
      "CLAUDE.md",
      "CODEBUDDY.md"
    ]);
    expect(INSTRUCTION_ENTRYPOINTS).toEqual(["AGENTS.md", "CLAUDE.md", "CODEBUDDY.md"]);
    expectExactEnum(archiveStatusValueSchema, enums.archive_status, [
      "absent",
      "uploading",
      "stored",
      "failed"
    ]);
    expectExactEnum(changeIndexStatusValueSchema, enums.change_index_status, [
      "not_scheduled",
      "queued",
      "indexing",
      "ready",
      "failed"
    ]);
    expectExactEnum(
      knowledgeExtractionStatusValueSchema,
      enums.knowledge_extraction_status,
      ["not_scheduled", "queued", "extracting", "ready", "failed"]
    );
    expectExactEnum(
      managedSnapshotStatusValueSchema,
      enums.managed_snapshot_status,
      ["absent", "publishing", "ready", "conflict", "failed"]
    );
    expectExactEnum(pullPolicySchema, enums.pull_policy, [
      "regular",
      "explicit_source_only",
      "not_pullable"
    ]);
    expectExactEnum(contentScanPolicySchema, enums.content_scan_policy, [
      "required",
      "skip_content_scan"
    ]);
    expectExactEnum(
      contentSyncValidationReasonCodeSchema,
      enums.content_sync_validation_reason_code,
      [
        "CONTENT_SYNC_ENUM_INVALID",
        "CONTENT_SYNC_UNKNOWN_FIELD",
        "CONTENT_SYNC_SCHEMA_INVALID"
      ]
    );
    expectExactEnum(contentPathReasonCodeSchema, enums.content_path_reason_code, [
      "CONTENT_PATH_EMPTY",
      "CONTENT_PATH_TOO_LONG",
      "CONTENT_PATH_ABSOLUTE",
      "CONTENT_PATH_BACKSLASH_AMBIGUOUS",
      "CONTENT_PATH_TRAVERSAL",
      "CONTENT_PATH_NON_CANONICAL",
      "CONTENT_PATH_ILLEGAL_SEGMENT",
      "CONTENT_PATH_RESERVED_NAME",
      "CONTENT_PATH_VCS_EXCLUDED",
      "CONTENT_PATH_CREDENTIALS_EXCLUDED",
      "CONTENT_PATH_ENV_EXCLUDED",
      "CONTENT_PATH_STATE_EXCLUDED",
      "CONTENT_PATH_RUNTIME_EXCLUDED",
      "CONTENT_PATH_NON_SCANNABLE_KIND",
      "CONTENT_PATH_SELECTED_ENTRYPOINT_INVALID",
      "CONTENT_PATH_UNDECLARED",
      "CONTENT_PATH_UNCLASSIFIED"
    ]);

    expect(contentKindSchema.safeParse("knowledge").success).toBe(false);
    expect(syncActionSchema.safeParse("unchanged").success).toBe(false);
    expect(archiveStatusValueSchema.safeParse("durable").success).toBe(false);
  });

  describe("schema-origin validation evidence", () => {
    const exportedFrozenStringSchemas: readonly {
      name: string;
      schema: z.ZodType;
    }[] = [
      { name: "content kind", schema: contentKindSchema },
      { name: "sync scope", schema: syncScopeSchema },
      { name: "sync direction", schema: syncDirectionSchema },
      { name: "sync action", schema: syncActionSchema },
      { name: "conflict resolution", schema: conflictResolutionSchema },
      { name: "project candidate type", schema: projectContentCandidateTypeSchema },
      { name: "project candidate status", schema: projectContentCandidateStatusSchema },
      { name: "knowledge candidate status", schema: knowledgeCandidateStatusSchema },
      { name: "candidate provenance source kind", schema: candidateProvenanceSourceKindSchema },
      { name: "instruction entrypoint", schema: instructionEntrypointSchema },
      { name: "archive status value", schema: archiveStatusValueSchema },
      { name: "change-index status value", schema: changeIndexStatusValueSchema },
      { name: "knowledge-extraction status value", schema: knowledgeExtractionStatusValueSchema },
      { name: "managed-snapshot status value", schema: managedSnapshotStatusValueSchema },
      { name: "pull policy", schema: pullPolicySchema },
      { name: "content-scan policy", schema: contentScanPolicySchema },
      { name: "validation reason code", schema: contentSyncValidationReasonCodeSchema },
      { name: "content-path reason code", schema: contentPathReasonCodeSchema }
    ];

    for (const { name, schema } of exportedFrozenStringSchemas) {
      it(`rejects unknown ${name} strings`, () => {
        expect(schema.safeParse("bogus").success).toBe(false);
      });

      it(`rejects non-string ${name} values`, () => {
        expect(schema.safeParse(42).success).toBe(false);
      });

      it(`rejects missing ${name} values`, () => {
        expect(schema.safeParse(undefined).success).toBe(false);
      });
    }

    const provenance = {
      source_kind: "review",
      source_ref: "review:stage-01",
      producer: "hunter-platform",
      producer_version: "1.0.0",
      created_at: "2026-08-12T01:04:00Z"
    };
    const projectCandidate = {
      schema_version: 1,
      candidate_id: "pcc_project_boundary_01",
      source_change_key: "change-stage-01",
      candidate_type: "architecture-decision",
      evidence_refs: ["archive:arc_stage01/design.md#boundary"],
      rationale: "Repeated project boundary.",
      proposed_content: "Remote knowledge remains server-derived.",
      content_hash: `sha256:${"a".repeat(64)}`,
      confidence: 0.82,
      status: "proposed",
      provenance
    };
    const knowledgeCandidate = {
      schema_version: 1,
      candidate_id: "kc_reusable_sync_boundary_01",
      source_change_key: "change-stage-01",
      source_refs: ["archive:arc_stage01/summary.md"],
      summary: "Configuration skips content scanning.",
      reusability_scope: "cross_project",
      content_hash: `sha256:${"b".repeat(64)}`,
      confidence: 0.91,
      status: "pending",
      provenance
    };
    const legacyReceipt = {
      schema_version: 1,
      archive_id: "arc_legacy_indexing",
      project_id: "prj_stage01",
      change_key: "change-legacy-indexing",
      package_sha256: `sha256:${"1".repeat(64)}`,
      manifest_sha256: `sha256:${"2".repeat(64)}`,
      artifact_id: "art_legacy_indexing",
      archive_status: "durable",
      knowledge_status: "indexing",
      stored_files: 3,
      uploaded_at: "2026-08-11T01:00:00Z",
      request_id: "00000000-0000-7000-8000-000000000011"
    };
    const legacyCompatibility = {
      schema_version: 1,
      source_format: "legacy_archive_package_receipt",
      complete_v1_statuses: false,
      archive_status: {
        availability: "available",
        value: {
          status: "stored",
          updated_at: "2026-08-11T01:00:00Z",
          retryable: false
        }
      },
      change_index_status: {
        availability: "unavailable",
        reason_code: "LEGACY_CHANGE_INDEX_STATUS_UNAVAILABLE"
      },
      knowledge_extraction_status: {
        availability: "unavailable",
        reason_code: "LEGACY_KNOWLEDGE_EXTRACTION_STATUS_UNAVAILABLE"
      },
      managed_snapshot_status: {
        availability: "unavailable",
        reason_code: "LEGACY_MANAGED_SNAPSHOT_STATUS_UNAVAILABLE"
      }
    };
    const nestedFrozenStringFields: readonly {
      name: string;
      schema: z.ZodType;
      input: Readonly<Record<string, unknown>>;
      path: readonly string[];
    }[] = [
      {
        name: "archive status",
        schema: archiveStatusSchema,
        input: {
          status: "stored",
          updated_at: "2026-08-12T01:04:00Z",
          retryable: false
        },
        path: ["status"]
      },
      {
        name: "project candidate type",
        schema: projectContentCandidateSchema,
        input: projectCandidate,
        path: ["candidate_type"]
      },
      {
        name: "project candidate status",
        schema: projectContentCandidateSchema,
        input: projectCandidate,
        path: ["status"]
      },
      {
        name: "knowledge candidate status",
        schema: knowledgeCandidateSchema,
        input: knowledgeCandidate,
        path: ["status"]
      },
      {
        name: "nested provenance source kind",
        schema: projectContentCandidateSchema,
        input: projectCandidate,
        path: ["provenance", "source_kind"]
      },
      {
        name: "legacy archive status",
        schema: legacyArchivePackageReceiptSchema,
        input: legacyReceipt,
        path: ["archive_status"]
      },
      {
        name: "legacy knowledge status",
        schema: legacyArchivePackageReceiptSchema,
        input: legacyReceipt,
        path: ["knowledge_status"]
      },
      {
        name: "legacy source format",
        schema: legacyArchiveCompatibilityResultSchema,
        input: legacyCompatibility,
        path: ["source_format"]
      },
      {
        name: "legacy available status",
        schema: legacyArchiveCompatibilityResultSchema,
        input: legacyCompatibility,
        path: ["archive_status", "availability"]
      },
      {
        name: "legacy unavailable status",
        schema: legacyArchiveCompatibilityResultSchema,
        input: legacyCompatibility,
        path: ["change_index_status", "availability"]
      },
      {
        name: "legacy change-index reason",
        schema: legacyArchiveCompatibilityResultSchema,
        input: legacyCompatibility,
        path: ["change_index_status", "reason_code"]
      },
      {
        name: "legacy knowledge-extraction reason",
        schema: legacyArchiveCompatibilityResultSchema,
        input: legacyCompatibility,
        path: ["knowledge_extraction_status", "reason_code"]
      },
      {
        name: "legacy managed-snapshot reason",
        schema: legacyArchiveCompatibilityResultSchema,
        input: legacyCompatibility,
        path: ["managed_snapshot_status", "reason_code"]
      }
    ];

    for (const { name, schema, input, path } of nestedFrozenStringFields) {
      it(`rejects unknown nested ${name} strings`, () => {
        expect(schema.safeParse(
          replaceNestedField(input, path, "bogus", false)
        ).success).toBe(false);
      });

      it(`rejects non-string nested ${name} values`, () => {
        expect(schema.safeParse(
          replaceNestedField(input, path, 42, false)
        ).success).toBe(false);
      });

      it(`rejects missing nested ${name} values`, () => {
        expect(schema.safeParse(
          replaceNestedField(input, path, undefined, true)
        ).success).toBe(false);
      });
    }

    it.each([
      [42, "CONTENT_SYNC_SCHEMA_INVALID"],
      ["archive_package", "CONTENT_SYNC_ENUM_INVALID"]
    ])("maps classifier source_kind %j with semantic reason %s", (sourceKind, reasonCode) => {
      expect(classifyContentPath({
        schema_version: 1,
        path: "src/app.ts",
        source_kind: sourceKind
      })).toEqual({
        schema_version: 1,
        reason_code: reasonCode
      });
    });

    it("preserves exact inferred unions for wrapped frozen string schemas", () => {
      expectTypeOf(contentKindSchema.parse("config")).toEqualTypeOf<
        "config" | "rule" | "architecture" | "instruction" | "branch_file" |
        "change_document" | "archive_package" | "knowledge_entry" |
        "knowledge_candidate" | "project_content_candidate"
      >();
      expectTypeOf(syncDirectionSchema.parse("push")).toEqualTypeOf<"push" | "pull">();
      expectTypeOf(instructionEntrypointSchema.parse("AGENTS.md"))
        .toEqualTypeOf<(typeof INSTRUCTION_ENTRYPOINTS)[number]>();
    });
  });

  it("keeps the four v1 status dimensions independent and strict", async () => {
    const fixture = await readCurrentFixture();
    const statuses = fixture.statuses as Record<string, unknown>;
    const parsed = contentSyncStatusesSchema.parse(statuses);

    expect(parsed.archive_status.status).toBe("uploading");
    expect(parsed.change_index_status.status).toBe("indexing");
    expect(parsed.knowledge_extraction_status.status).toBe("extracting");
    expect(parsed.managed_snapshot_status).toMatchObject({
      status: "conflict",
      reason_code: "REMOTE_VERSION_CONFLICT"
    });

    expect(archiveStatusSchema.safeParse({
      status: "durable",
      updated_at: "2026-08-12T01:00:00.000Z",
      retryable: false
    }).success).toBe(false);
    expect(changeIndexStatusSchema.safeParse({
      status: "ready",
      updatedAt: "2026-08-12T01:00:00.000Z",
      retryable: false
    }).success).toBe(false);
    expect(knowledgeExtractionStatusSchema.safeParse({
      status: "ready",
      updated_at: "2026-08-12T01:00:00.000Z",
      retryable: false,
      unexpected: true
    }).success).toBe(false);
    expect(managedSnapshotStatusSchema.safeParse({
      status: "failed",
      updated_at: "2026-08-12T01:00:00.000Z",
      retryable: true,
      reason_code: "not a machine code"
    }).success).toBe(false);
  });

  it("keeps knowledge and project-content candidates strict and non-interchangeable", async () => {
    const fixture = await readCurrentFixture();
    const candidates = fixture.candidates as Record<string, unknown>;
    const projectCandidate = projectContentCandidateSchema.parse(
      candidates.project_content_candidate
    );
    const knowledgeCandidate = knowledgeCandidateSchema.parse(
      candidates.knowledge_candidate
    );

    expect(projectCandidate.candidate_id).toBe("pcc_project_boundary_01");
    expect(projectCandidate.candidate_type).toBe("architecture-decision");
    expect(knowledgeCandidate.candidate_id).toBe("kc_reusable_sync_boundary_01");
    expect(knowledgeCandidate.confidence).toBe(0.91);
    expect(projectContentCandidateSchema.safeParse(knowledgeCandidate).success).toBe(false);
    expect(knowledgeCandidateSchema.safeParse(projectCandidate).success).toBe(false);
    expect(projectContentCandidateSchema.safeParse({
      ...projectCandidate,
      candidate_id: "kc_wrong_namespace"
    }).success).toBe(false);
    expect(knowledgeCandidateSchema.safeParse({
      ...knowledgeCandidate,
      candidate_id: "pcc_wrong_namespace"
    }).success).toBe(false);

    for (const confidence of [-0.01, 1.01]) {
      expect(knowledgeCandidateSchema.safeParse({
        ...knowledgeCandidate,
        confidence
      }).success).toBe(false);
    }
    expect(projectContentCandidateSchema.safeParse({
      ...projectCandidate,
      content_hash: "a".repeat(64)
    }).success).toBe(false);

    const unknownField = projectContentCandidateSchema.safeParse({
      ...projectCandidate,
      unexpected: true
    });
    expect(unknownField.success).toBe(false);

    const { candidate_id: ignoredCandidateId, ...withoutCandidateId } = projectCandidate;
    void ignoredCandidateId;
    const camelCase = projectContentCandidateSchema.safeParse({
      ...withoutCandidateId,
      candidateId: projectCandidate.candidate_id
    });
    expect(camelCase.success).toBe(false);

    const unknownEnum = projectContentCandidateSchema.safeParse({
      ...projectCandidate,
      status: "complete"
    });
    expect(unknownEnum.success).toBe(false);

    expect(knowledgeCandidateSchema.safeParse({
      ...knowledgeCandidate,
      provenance: {
        ...knowledgeCandidate.provenance,
        producerVersion: knowledgeCandidate.provenance.producer_version
      }
    }).success).toBe(false);
  });

  it("carries the optional knowledge entry projection fields", async () => {
    const fixture = await readCurrentFixture();
    const candidates = fixture.candidates as Record<string, unknown>;
    const base = knowledgeCandidateSchema.parse(candidates.knowledge_candidate);

    // 老归档缺这三个字段时必须继续解析成功（降级路径）。
    expect(base.entry_type).toBeUndefined();
    expect(base.body).toBeUndefined();
    expect(base.keywords).toBeUndefined();

    const enriched = knowledgeCandidateSchema.parse({
      ...base,
      entry_type: "pitfall",
      body: "content-sync.ts:1051 nonScannablePathPrefixes rejects the archive tree.",
      keywords: ["content-sync.ts", "contracts", "RED", "FIXED"]
    });
    expect(enriched.entry_type).toBe("pitfall");
    expect(enriched.keywords).toEqual(["content-sync.ts", "contracts", "RED", "FIXED"]);

    // entry_type 必须与 knowledgeIngestEntrySchema 的 7 值枚举一致，
    // 否则桥在投影时会被 safeParse 静默丢弃。
    expect(knowledgeCandidateEntryTypeSchema.options).toEqual([
      "requirement", "decision", "implementation", "risk",
      "test-evidence", "pitfall", "api-contract"
    ]);
    expect(knowledgeIngestEntryTypeSchema.options).toEqual(
      knowledgeCandidateEntryTypeSchema.options
    );

    for (const invalid of [
      { entry_type: "lesson" },
      { entry_type: "" },
      { body: "" },
      { keywords: "content-sync.ts" },
      { keywords: [""] },
      { entryType: "pitfall" },
      { keywords: Array.from({ length: 33 }, (_, index) => `k${index}`) }
    ]) {
      expect(knowledgeCandidateSchema.safeParse({ ...base, ...invalid }).success).toBe(false);
    }
  });

  it("accepts the archive candidate generator's real output", async () => {
    // 该 fixture 由 harness/scripts/harness_knowledge_candidates.py 真实产出
    // （test_harness_knowledge_candidates.py 锁住 Python 侧字节）。这条测试是
    // 跨语言契约锁：生成器与 schema 任何一侧漂移都会在这里断。
    const generated = JSON.parse(await readFile(
      fileURLToPath(new URL("./fixtures/knowledge-candidates-v1-archive.json", import.meta.url)),
      "utf8"
    )) as unknown[];

    const parsed = generated.map((candidate) => knowledgeCandidateSchema.parse(candidate));
    expect(parsed).toHaveLength(4);

    const byType = parsed.reduce<Record<string, number>>((counts, candidate) => {
      const key = candidate.entry_type ?? "(none)";
      return { ...counts, [key]: (counts[key] ?? 0) + 1 };
    }, {});
    expect(byType).toEqual({ pitfall: 1, risk: 3 });

    for (const candidate of parsed) {
      // extractor.ts 的自动放行阈值是 0.82；生成器的质量由 OK/NOT_APPLICABLE
      // 过滤保证，不靠阈值卡，所以每条都必须高于它。
      expect(candidate.confidence).toBeGreaterThanOrEqual(0.82);
      expect(candidate.entry_type).toBeDefined();
      expect(candidate.body).toBeTruthy();
      expect(candidate.keywords?.length ?? 0).toBeGreaterThan(0);
    }

    // 候选文件是知识管道的输入，不是给人读的分支文件：它只能经归档 ZIP 进入
    // 服务端，绝不能被工作区遍历当成交付物上传。放宽交付物白名单时这条会断。
    const candidatesPath = ".harness/archive/usage-stats-cli-reporting/candidates/knowledge.json";
    expect(classifyContentPath({ schema_version: 1, path: candidatesPath })).toEqual({
      schema_version: 1,
      reason_code: "CONTENT_PATH_NON_SCANNABLE_KIND"
    });
    expect(mayContainArchiveDeliverables(
      ".harness/archive/usage-stats-cli-reporting/candidates"
    )).toBe(false);
  });

  it("classifies repository-relative content paths without IO", async () => {
    const fixture = await readCurrentFixture();
    const pathCases = fixture.path_cases as Array<{
      name: string;
      input: unknown;
      expected: unknown;
    }>;

    for (const pathCase of pathCases) {
      const actual = classifyContentPath(pathCase.input);
      expect(contentPathClassificationResultSchema.parse(actual), pathCase.name)
        .toEqual(pathCase.expected);
      expect(classifyContentPath(pathCase.input), `${pathCase.name} must be deterministic`)
        .toEqual(actual);
    }

    expect(classifyContentPath("AGENTS.md")).toEqual({
      schema_version: 1,
      content_kind: "instruction",
      sync_scope: "instructions",
      pull_policy: "regular",
      content_scan_policy: "required"
    });
    expect(classifyContentPath("src/app.ts")).toEqual({
      schema_version: 1,
      reason_code: "CONTENT_PATH_UNCLASSIFIED"
    });
    expect(classifyContentPath({
      schema_version: 1,
      path: "src/app.ts",
      source_kind: "branch_file"
    })).toMatchObject({
      content_kind: "branch_file",
      sync_scope: "branch_files",
      pull_policy: "explicit_source_only"
    });
  });

  it("rejects every .env basename prefix as local credentials", () => {
    for (const path of [".envrc", ".environment", ".harness/config/.envrc"]) {
      expect(classifyContentPath({
        schema_version: 1,
        path,
        source_kind: "branch_file"
      })).toEqual({
        schema_version: 1,
        reason_code: "CONTENT_PATH_ENV_EXCLUDED"
      });
    }
  });

  it("classifies the canonical codebase map manifest before branch-file fallback", () => {
    const expected = {
      schema_version: 1,
      content_kind: "architecture",
      sync_scope: "architecture",
      pull_policy: "regular",
      content_scan_policy: "required"
    } as const;

    expect(classifyContentPath(".harness/codebase/map-manifest.json")).toEqual(expected);
    expect(classifyContentPath({
      schema_version: 1,
      path: ".harness/codebase/map-manifest.json",
      source_kind: "branch_file"
    })).toEqual(expected);
  });

  it("rejects Harness lease roots without excluding ordinary business leases", () => {
    for (const path of [
      ".harness/lease/worker.json",
      ".harness/leases/worker.json"
    ]) {
      expect(classifyContentPath({
        schema_version: 1,
        path,
        source_kind: "branch_file"
      })).toEqual({
        schema_version: 1,
        reason_code: "CONTENT_PATH_RUNTIME_EXCLUDED"
      });
    }
    expect(classifyContentPath({
      schema_version: 1,
      path: "leases/customer-contract.md",
      source_kind: "branch_file"
    })).toMatchObject({
      content_kind: "branch_file",
      sync_scope: "branch_files"
    });
  });

  it.each([
    [".harness/./state/local/baseline.json", "CONTENT_PATH_NON_CANONICAL"],
    [".harness//runtime/session.json", "CONTENT_PATH_NON_CANONICAL"],
    ["src/", "CONTENT_PATH_NON_CANONICAL"],
    ["./src/app.ts", "CONTENT_PATH_NON_CANONICAL"],
    ["src/file.txt:stream", "CONTENT_PATH_ILLEGAL_SEGMENT"],
    ["src/file?.txt", "CONTENT_PATH_ILLEGAL_SEGMENT"],
    ["src/\u0001file.ts", "CONTENT_PATH_ILLEGAL_SEGMENT"],
    ["src/CON/config.ts", "CONTENT_PATH_RESERVED_NAME"],
    ["src/lpt9.txt", "CONTENT_PATH_RESERVED_NAME"],
    ["src/file.", "CONTENT_PATH_ILLEGAL_SEGMENT"],
    ["src/file ", "CONTENT_PATH_ILLEGAL_SEGMENT"],
    ["a".repeat(241), "CONTENT_PATH_TOO_LONG"],
    [".HARNESS/PROJECT.YAML", "CONTENT_PATH_NON_CANONICAL"],
    [".harness/CONFIG/x.yaml", "CONTENT_PATH_NON_CANONICAL"],
    [".harness/STATE/local.json", "CONTENT_PATH_NON_CANONICAL"],
    ["agents.md", "CONTENT_PATH_NON_CANONICAL"],
    ["claude.md", "CONTENT_PATH_NON_CANONICAL"],
    ["codebuddy.md", "CONTENT_PATH_NON_CANONICAL"]
  ])("rejects non-canonical cross-platform path %s with %s", (path, reasonCode) => {
    expect(classifyContentPath({
      schema_version: 1,
      path,
      source_kind: "branch_file"
    })).toEqual({ schema_version: 1, reason_code: reasonCode });
  });

  it("preserves canonical identity for safe mixed-case business paths", () => {
    for (const path of ["src/Domain/OrderService.TS", "a".repeat(240)]) {
      expect(classifyContentPath({
        schema_version: 1,
        path,
        source_kind: "branch_file"
      })).toMatchObject({
        content_kind: "branch_file",
        sync_scope: "branch_files",
        pull_policy: "explicit_source_only"
      });
    }
  });

  it.each([
    ["src/app.ts", ["src/app.ts"]],
    ["CLAUDE.md", ["claude.md"]],
    ["docs/CLAUDE.md", ["docs/CLAUDE.md"]]
  ])("does not promote %s through invalid selected entrypoints", (path, selected) => {
    expect(classifyContentPath({
      schema_version: 1,
      path,
      selected_instruction_entrypoints: selected,
      source_kind: "branch_file"
    })).toEqual({
      schema_version: 1,
      reason_code: "CONTENT_PATH_SELECTED_ENTRYPOINT_INVALID"
    });
  });

  it("allows only frozen root instruction entrypoints", () => {
    const instruction = {
      schema_version: 1,
      content_kind: "instruction",
      sync_scope: "instructions",
      pull_policy: "regular",
      content_scan_policy: "required"
    } as const;

    expect(classifyContentPath("AGENTS.md")).toEqual(instruction);
    for (const path of ["CLAUDE.md", "CODEBUDDY.md"] as const) {
      expect(classifyContentPath({
        schema_version: 1,
        path,
        selected_instruction_entrypoints: [path]
      })).toEqual(instruction);
    }
  });

  it.each([
    "Cargo.lock",
    "yarn.lock",
    "package-lock.json",
    "runtime/index.ts",
    "cache/README.md",
    "src/feature.lock"
  ])("does not mistake business or dependency path %s for runtime state", (path) => {
    expect(classifyContentPath({
      schema_version: 1,
      path,
      source_kind: "branch_file"
    })).toMatchObject({
      content_kind: "branch_file",
      sync_scope: "branch_files"
    });
  });

  it.each(["debug.log", "scratch.tmp", "draft.temp"])(
    "keeps explicit global temporary suffix %s excluded",
    (path) => {
      expect(classifyContentPath({
        schema_version: 1,
        path,
        source_kind: "branch_file"
      })).toEqual({
        schema_version: 1,
        reason_code: "CONTENT_PATH_RUNTIME_EXCLUDED"
      });
    }
  );

  it("distinguishes schema versions, enum values, and unknown fields", () => {
    expect(classifyContentPath({
      schema_version: 2,
      path: "AGENTS.md"
    })).toEqual({
      schema_version: 1,
      reason_code: "CONTENT_SYNC_SCHEMA_INVALID"
    });
    expect(classifyContentPath({
      schema_version: 1,
      path: "src/app.ts",
      source_kind: "archive_package"
    })).toEqual({
      schema_version: 1,
      reason_code: "CONTENT_SYNC_ENUM_INVALID"
    });
    expect(classifyContentPath({
      schema_version: 1,
      path: "AGENTS.md",
      unexpected: true
    })).toEqual({
      schema_version: 1,
      reason_code: "CONTENT_SYNC_UNKNOWN_FIELD"
    });
  });

  it("prioritizes target path failures over invalid auxiliary entrypoints", () => {
    expect(classifyContentPath({
      schema_version: 1,
      path: ".env",
      selected_instruction_entrypoints: ["../CLAUDE.md"],
      source_kind: "branch_file"
    })).toEqual({
      schema_version: 1,
      reason_code: "CONTENT_PATH_ENV_EXCLUDED"
    });
    expect(classifyContentPath({
      schema_version: 1,
      path: "src/app.ts",
      selected_instruction_entrypoints: ["docs/CLAUDE.md"],
      source_kind: "branch_file"
    })).toEqual({
      schema_version: 1,
      reason_code: "CONTENT_PATH_SELECTED_ENTRYPOINT_INVALID"
    });
  });

  it("prioritizes schema-version incompatibility over invalid auxiliary entrypoints", () => {
    expect(classifyContentPath({
      schema_version: 2,
      path: "AGENTS.md",
      selected_instruction_entrypoints: ["src/app.ts"]
    })).toEqual({
      schema_version: 1,
      reason_code: "CONTENT_SYNC_SCHEMA_INVALID"
    });
  });

  it.each([
    [
      {
        schema_version: 1,
        selected_instruction_entrypoints: ["bad"]
      },
      "CONTENT_SYNC_SCHEMA_INVALID"
    ],
    [
      {
        schema_version: 1,
        path: 42,
        selected_instruction_entrypoints: ["bad"]
      },
      "CONTENT_SYNC_SCHEMA_INVALID"
    ],
    [
      {
        schema_version: 1,
        path: "src/app.ts",
        selected_instruction_entrypoints: ["bad"],
        source_kind: "archive_package"
      },
      "CONTENT_SYNC_ENUM_INVALID"
    ]
  ])("prioritizes primary input failures over invalid auxiliary entrypoints %#", (input, reasonCode) => {
    expect(classifyContentPath(input)).toEqual({
      schema_version: 1,
      reason_code: reasonCode
    });
  });

  it.each([".git", ".git/config", ".git/hooks/post-checkout", ".GIT/config"])(
    "excludes VCS metadata path %s case-insensitively",
    (path) => {
      expect(classifyContentPath({
        schema_version: 1,
        path,
        source_kind: "branch_file"
      })).toEqual({
        schema_version: 1,
        reason_code: "CONTENT_PATH_VCS_EXCLUDED"
      });
    }
  );

  it.each([
    ".harness/config/.git/config",
    "src/.git/config",
    ".harness/config/.GIT/config",
    "src/.GIT/config"
  ])("excludes nested Git metadata segment %s case-insensitively", (path) => {
    expect(classifyContentPath({
      schema_version: 1,
      path,
      source_kind: "branch_file"
    })).toEqual({
      schema_version: 1,
      reason_code: "CONTENT_PATH_VCS_EXCLUDED"
    });
  });

  it("does not confuse Git-owned root files with the .git metadata tree", () => {
    for (const path of [".gitignore", ".gitattributes", ".gitmodules"]) {
      expect(classifyContentPath({
        schema_version: 1,
        path,
        source_kind: "branch_file"
      })).toMatchObject({
        content_kind: "branch_file",
        sync_scope: "branch_files"
      });
    }
  });

  it("allows non-Git lookalike path segments", () => {
    for (const path of [
      "src/.gitignore",
      ".github/workflows/check.yml",
      "src/legit/config.ts"
    ]) {
      expect(classifyContentPath({
        schema_version: 1,
        path,
        source_kind: "branch_file"
      })).toMatchObject({
        content_kind: "branch_file",
        sync_scope: "branch_files"
      });
    }
  });

  it.each([".harness", ".harness/unknown/file.txt", ".harness/project.yaml/child"])(
    "rejects undeclared Harness namespace path %s",
    (path) => {
      expect(classifyContentPath({
        schema_version: 1,
        path,
        source_kind: "branch_file"
      })).toEqual({
        schema_version: 1,
        reason_code: "CONTENT_PATH_UNDECLARED"
      });
    }
  );

  it("freezes selected instruction entrypoints in the input schema and classifier", () => {
    expect(contentPathClassificationInputSchema.safeParse({
      schema_version: 1,
      path: "src/app.ts",
      selected_instruction_entrypoints: ["src/app.ts"]
    }).success).toBe(false);
    expect(classifyContentPath({
      schema_version: 1,
      path: "src/app.ts",
      selected_instruction_entrypoints: ["src/app.ts"]
    })).toEqual({
      schema_version: 1,
      reason_code: "CONTENT_PATH_SELECTED_ENTRYPOINT_INVALID"
    });

    const parsed = contentPathClassificationInputSchema.parse({
      schema_version: 1,
      path: "CLAUDE.md",
      selected_instruction_entrypoints: [...INSTRUCTION_ENTRYPOINTS]
    });
    expect(parsed.selected_instruction_entrypoints).toEqual(INSTRUCTION_ENTRYPOINTS);
  });

  it.each([
    ["missing content_kind", {
      schema_version: 1,
      sync_scope: "instructions",
      pull_policy: "regular",
      content_scan_policy: "required"
    }],
    ["non-string content_kind", {
      schema_version: 1,
      content_kind: 42,
      sync_scope: "instructions",
      pull_policy: "regular",
      content_scan_policy: "required"
    }],
    ["missing reason_code", {
      schema_version: 1
    }],
    ["non-string reason_code", {
      schema_version: 1,
      reason_code: 42
    }]
  ])("maps %s to the schema reason at the domain seam", (_name, value) => {
    expect(validateClassificationResult(value)).toEqual({
      ok: false,
      reason_code: "CONTENT_SYNC_SCHEMA_INVALID"
    });
  });

  it.each([
    ["sync_scope", {
      schema_version: 1,
      content_kind: "instruction",
      sync_scope: "bogus",
      pull_policy: "regular",
      content_scan_policy: "required"
    }],
    ["pull_policy", {
      schema_version: 1,
      content_kind: "instruction",
      sync_scope: "instructions",
      pull_policy: "bogus",
      content_scan_policy: "required"
    }],
    ["content_scan_policy", {
      schema_version: 1,
      content_kind: "instruction",
      sync_scope: "instructions",
      pull_policy: "regular",
      content_scan_policy: "bogus"
    }]
  ])("maps an unknown success %s string to the enum reason at the domain seam", (
    _name,
    value
  ) => {
    expect(validateClassificationResult(value)).toEqual({
      ok: false,
      reason_code: "CONTENT_SYNC_ENUM_INVALID"
    });
  });

  it.each([
    ["success", {
      schema_version: 1,
      content_kind: "instruction",
      sync_scope: "instructions",
      pull_policy: "regular",
      content_scan_policy: "required",
      unexpected: true
    }],
    ["failure", {
      schema_version: 1,
      reason_code: "CONTENT_PATH_UNCLASSIFIED",
      unexpected: true
    }]
  ])("maps a strict unknown field in the %s root to the unknown-field reason", (
    _name,
    value
  ) => {
    expect(validateClassificationResult(value)).toEqual({
      ok: false,
      reason_code: "CONTENT_SYNC_UNKNOWN_FIELD"
    });
  });

  it("uses schema failure when no classification result root is declared", () => {
    expect(validateClassificationResult({
      schema_version: 1,
      path: "src/app.ts"
    })).toEqual({
      ok: false,
      reason_code: "CONTENT_SYNC_SCHEMA_INVALID"
    });
  });

  it.each([
    ["mismatched scope", {
      schema_version: 1,
      content_kind: "instruction",
      sync_scope: "rules",
      pull_policy: "regular",
      content_scan_policy: "required"
    }],
    ["non-classification content kind", {
      schema_version: 1,
      content_kind: "archive_package",
      sync_scope: "archive",
      pull_policy: "not_pullable",
      content_scan_policy: "required"
    }]
  ])("maps individually valid but uncorrelated success fields (%s) to schema failure", (
    _name,
    value
  ) => {
    expect(validateClassificationResult(value)).toEqual({
      ok: false,
      reason_code: "CONTENT_SYNC_SCHEMA_INVALID"
    });
  });

  it("keeps classification success fields correlated in the public output type", () => {
    const parsed = contentPathClassificationSuccessSchema.parse({
      schema_version: 1,
      content_kind: "config",
      sync_scope: "config",
      pull_policy: "regular",
      content_scan_policy: "skip_content_scan"
    });
    expectTypeOf(parsed.content_kind).toEqualTypeOf<"config" | "rule" | "architecture" |
      "instruction" | "branch_file">();
    if (parsed.content_kind === "config") {
      expectTypeOf(parsed.sync_scope).toEqualTypeOf<"config">();
      expectTypeOf(parsed.content_scan_policy).toEqualTypeOf<"skip_content_scan">();
    }
  });

  it.each([
    "credentials.local",
    "credentials.local.json",
    "docs/CREDENTIALS.LOCAL.YAML"
  ])("excludes credential basename boundary %s", (path) => {
    expect(classifyContentPath({
      schema_version: 1,
      path,
      source_kind: "branch_file"
    })).toEqual({
      schema_version: 1,
      reason_code: "CONTENT_PATH_CREDENTIALS_EXCLUDED"
    });
  });

  it.each([
    ["credentials.local/key.json", "CONTENT_PATH_CREDENTIALS_EXCLUDED"],
    ["src/credentials.local/token.txt", "CONTENT_PATH_CREDENTIALS_EXCLUDED"],
    ["src/CREDENTIALS.LOCAL.YAML/key.txt", "CONTENT_PATH_CREDENTIALS_EXCLUDED"],
    [".harness/config/credentials.local.json/value", "CONTENT_PATH_CREDENTIALS_EXCLUDED"],
    [".env/secrets.txt", "CONTENT_PATH_ENV_EXCLUDED"],
    ["src/.env.production/config.json", "CONTENT_PATH_ENV_EXCLUDED"],
    [".harness/config/.ENV.local/settings.json", "CONTENT_PATH_ENV_EXCLUDED"]
  ])("excludes sensitive path segment in %s with %s", (path, reasonCode) => {
    expect(classifyContentPath({
      schema_version: 1,
      path,
      source_kind: "branch_file"
    })).toEqual({ schema_version: 1, reason_code: reasonCode });
  });

  it("keeps VCS, credential, and environment segment priority stable", () => {
    expect(classifyContentPath({
      schema_version: 1,
      path: "src/.git/credentials.local/.env/value",
      source_kind: "branch_file"
    })).toEqual({
      schema_version: 1,
      reason_code: "CONTENT_PATH_VCS_EXCLUDED"
    });
    expect(classifyContentPath({
      schema_version: 1,
      path: "src/credentials.local/.env/value",
      source_kind: "branch_file"
    })).toEqual({
      schema_version: 1,
      reason_code: "CONTENT_PATH_CREDENTIALS_EXCLUDED"
    });
  });

  it("does not exclude ordinary credential-like words", () => {
    for (const path of [
      "docs/credentials.locality.md",
      "credentials.localization.md",
      "docs/credentials.locality/value.md"
    ]) {
      expect(classifyContentPath({
        schema_version: 1,
        path,
        source_kind: "branch_file"
      })).toMatchObject({
        content_kind: "branch_file",
        sync_scope: "branch_files"
      });
    }
  });

  it.each([
    "src/COM¹.txt",
    "COM²",
    "com³.log",
    "nested/LPT¹.txt",
    "lpt²",
    "LPT³.any"
  ])("recognizes Windows superscript device suffix in %s", (path) => {
    expect(classifyContentPath({
      schema_version: 1,
      path,
      source_kind: "branch_file"
    })).toEqual({
      schema_version: 1,
      reason_code: "CONTENT_PATH_RESERVED_NAME"
    });
  });

  it("allows superscript device-name prefixes followed by ordinary text", () => {
    for (const path of ["COM¹foo.txt", "nested/LPT²backup"]) {
      expect(classifyContentPath({
        schema_version: 1,
        path,
        source_kind: "branch_file"
      })).toMatchObject({
        content_kind: "branch_file",
        sync_scope: "branch_files"
      });
    }
  });

  it.each([
    ["", "CONTENT_PATH_EMPTY"],
    ["/etc/passwd", "CONTENT_PATH_ABSOLUTE"],
    ["C:/Users/example/secret.txt", "CONTENT_PATH_ABSOLUTE"],
    ["\\\\server\\share\\secret.txt", "CONTENT_PATH_ABSOLUTE"],
    [".harness\\rules\\security.md", "CONTENT_PATH_BACKSLASH_AMBIGUOUS"],
    [".harness/config/../credentials.local.yaml", "CONTENT_PATH_TRAVERSAL"],
    [".harness/credentials.local.yaml", "CONTENT_PATH_CREDENTIALS_EXCLUDED"],
    [".harness/config/credentials.local.json", "CONTENT_PATH_CREDENTIALS_EXCLUDED"],
    [".env", "CONTENT_PATH_ENV_EXCLUDED"],
    [".harness/config/.env.production", "CONTENT_PATH_ENV_EXCLUDED"],
    [".harness/state/local/baseline.json", "CONTENT_PATH_STATE_EXCLUDED"],
    [".harness/runtime/session.json", "CONTENT_PATH_RUNTIME_EXCLUDED"],
    [".harness/locks/sync.lock", "CONTENT_PATH_RUNTIME_EXCLUDED"],
    [".harness/cache/index.json", "CONTENT_PATH_RUNTIME_EXCLUDED"],
    [".harness/tmp/write.tmp", "CONTENT_PATH_RUNTIME_EXCLUDED"],
    ["logs/sync.log", "CONTENT_PATH_RUNTIME_EXCLUDED"],
    [".harness/archive/change-one/package.zip", "CONTENT_PATH_NON_SCANNABLE_KIND"],
    [".harness/knowledge/entry.json", "CONTENT_PATH_NON_SCANNABLE_KIND"],
    [".harness/changes/change-one.md", "CONTENT_PATH_NON_SCANNABLE_KIND"],
    [".harness/candidates/kc_one.json", "CONTENT_PATH_NON_SCANNABLE_KIND"]
  ])("rejects excluded or invalid path %s with %s", (path, reasonCode) => {
    expect(classifyContentPath({
      schema_version: 1,
      path,
      source_kind: "branch_file"
    })).toEqual({ schema_version: 1, reason_code: reasonCode });
  });

  it("rejects malformed classification JSON with stable validation reason codes", () => {
    expect(classifyContentPath({
      schema_version: 1,
      path: "CLAUDE.md",
      selectedInstructionEntrypoints: ["CLAUDE.md"]
    })).toEqual({
      schema_version: 1,
      reason_code: "CONTENT_SYNC_UNKNOWN_FIELD"
    });
    expect(classifyContentPath({
      schema_version: 1,
      path: "src/app.ts",
      source_kind: "archive_package"
    })).toEqual({
      schema_version: 1,
      reason_code: "CONTENT_SYNC_ENUM_INVALID"
    });
    expect(classifyContentPath({
      schema_version: 1,
      path: "AGENTS.md",
      selected_instruction_entrypoints: ["../CLAUDE.md"]
    })).toEqual({
      schema_version: 1,
      reason_code: "CONTENT_PATH_SELECTED_ENTRYPOINT_INVALID"
    });
  });

  it("keeps classification result objects strict", () => {
    expect(contentPathClassificationResultSchema.safeParse({
      ...classifyContentPath("AGENTS.md"),
      unexpected: true
    }).success).toBe(false);
    expect(contentPathClassificationResultSchema.safeParse({
      schema_version: 1,
      reasonCode: "CONTENT_PATH_UNCLASSIFIED"
    }).success).toBe(false);
    expect(contentPathClassificationResultSchema.safeParse({
      schema_version: 1,
      content_kind: "instruction",
      sync_scope: "rules",
      pull_policy: "regular",
      content_scan_policy: "required"
    }).success).toBe(false);
    expect(contentPathClassificationResultSchema.safeParse({
      schema_version: 1,
      content_kind: "archive_package",
      sync_scope: "archive",
      pull_policy: "not_pullable",
      content_scan_policy: "required"
    }).success).toBe(false);
  });

  it("recognizes legacy receipts without inventing complete v1 status success", async () => {
    const fixture = await readLegacyFixture();
    const receipts = fixture.receipts as unknown[];
    const expectedResults = fixture.compatibility_results as unknown[];
    const parsedReceipts = legacyArchivePackageReceiptSchema.array().parse(receipts);

    expect(fixture.fixture_version).toBe(0);
    expect(receipts).toHaveLength(3);
    expect(expectedResults).toHaveLength(receipts.length);
    expect(parsedReceipts.map((receipt) => receipt.knowledge_status))
      .toEqual(["indexing", "ready", "failed"]);
    for (const [index, receipt] of parsedReceipts.entries()) {
      expect(archivePackageReceiptSchema.parse(receipts[index])).toEqual(receipt);
      expect(receipt.archive_status).toBe("durable");
      expect(["indexing", "ready", "failed"]).toContain(receipt.knowledge_status);

      const compatibility = getLegacyArchiveCompatibilityResult(receipt);
      expect(legacyArchiveCompatibilityResultSchema.parse(expectedResults[index]))
        .toEqual(compatibility);
      expect(compatibility.complete_v1_statuses).toBe(false);
      expect(compatibility.archive_status).toMatchObject({
        availability: "available",
        value: { status: "stored", retryable: false }
      });
      expect(compatibility.change_index_status).toEqual({
        availability: "unavailable",
        reason_code: "LEGACY_CHANGE_INDEX_STATUS_UNAVAILABLE"
      });
      expect(compatibility.knowledge_extraction_status).toEqual({
        availability: "unavailable",
        reason_code: "LEGACY_KNOWLEDGE_EXTRACTION_STATUS_UNAVAILABLE"
      });
      expect(compatibility.managed_snapshot_status).toEqual({
        availability: "unavailable",
        reason_code: "LEGACY_MANAGED_SNAPSHOT_STATUS_UNAVAILABLE"
      });
      expect(contentSyncStatusesSchema.safeParse(receipt).success).toBe(false);
    }
  });

  it("keeps both public legacy receipt parsers aligned with the OpenAPI wire set", async () => {
    const fixture = await readLegacyFixture();
    const receipt = (fixture.receipts as Record<string, unknown>[])[0];
    const cases: readonly [string, Record<string, unknown>, boolean][] = [
      ["valid", receipt, true],
      ["empty change_key", { ...receipt, change_key: "" }, true],
      ["empty artifact_id", { ...receipt, artifact_id: "" }, true],
      ["null artifact_id", { ...receipt, artifact_id: null }, true],
      ["RFC3339 offset", { ...receipt, uploaded_at: "2026-08-11T09:00:00+08:00" }, true],
      ["nil UUID", { ...receipt, request_id: "00000000-0000-0000-0000-000000000000" }, true],
      ["unsafe integer", { ...receipt, stored_files: 9007199254740992 }, true],
      ["bad archive_id pattern", { ...receipt, archive_id: "archive_1" }, false],
      ["bad project_id pattern", { ...receipt, project_id: "project_1" }, false],
      ["bad package hash", { ...receipt, package_sha256: "sha256:nope" }, false],
      ["bad manifest hash", { ...receipt, manifest_sha256: "sha256:nope" }, false],
      ["bad UUID", { ...receipt, request_id: "not-a-uuid" }, false],
      ["bad date-time", { ...receipt, uploaded_at: "yesterday" }, false],
      ["fractional stored_files", { ...receipt, stored_files: 1.5 }, false],
      ["unknown field", { ...receipt, unexpected: true }, false],
      ["missing change_key", Object.fromEntries(
        Object.entries(receipt).filter(([key]) => key !== "change_key")
      ), false]
    ];

    for (const [name, value, expected] of cases) {
      expect(archivePackageReceiptSchema.safeParse(value).success, name).toBe(expected);
      expect(legacyArchivePackageReceiptSchema.safeParse(value).success, name).toBe(expected);
    }
  });

  it("projects remote identity and bounded branch snapshot pages from the current fixture", async () => {
    const fixture = await readCurrentFixture();
    const remoteIdentity = remoteVersionIdentitySchema.parse(fixture.remote_version_identity);
    const branchPage = branchSnapshotPageSchema.parse(fixture.branch_snapshots_page);
    const versionPage = snapshotVersionPageSchema.parse(fixture.snapshot_versions_page);
    const filePage = snapshotFilePageSchema.parse(fixture.snapshot_files_page);

    expectTypeOf(remoteIdentity).toEqualTypeOf<RemoteVersionIdentity>();
    expectTypeOf(branchPage).toEqualTypeOf<BranchSnapshotPage>();
    expectTypeOf(branchPage.items[0]).toEqualTypeOf<BranchSnapshot | undefined>();
    expectTypeOf(versionPage).toEqualTypeOf<SnapshotVersionPage>();
    expectTypeOf(versionPage.items[0]).toEqualTypeOf<SnapshotVersion | undefined>();
    expectTypeOf(filePage).toEqualTypeOf<SnapshotFilePage>();
    expectTypeOf(filePage.items[0]).toEqualTypeOf<SnapshotFile | undefined>();

    expect(remoteIdentity).toMatchObject({
      project_id: "prj_stage01",
      branch_name: "feature/content-sync",
      project_version: "pv_00000002",
      client_id: "cli_stage01"
    });
    expect(branchPage.items[0]).toMatchObject({
      latest_version: "pv_00000002",
      file_count: 3,
      changed_count: 2
    });
    expect(versionPage.items[0]).toMatchObject({
      project_version: "pv_00000002",
      artifact_id: "art_stage01_snapshot_02"
    });
    expect(filePage.items.map((item) => item.path)).toEqual([
      ".harness/project.yaml",
      ".harness/rules/security.md",
      "AGENTS.md"
    ]);
  });

  it("keeps branch snapshot projections strict with only documented optional fields", async () => {
    const fixture = await readCurrentFixture();
    const remoteIdentity = fixture.remote_version_identity as Record<string, unknown>;
    const branchPage = fixture.branch_snapshots_page as Record<string, unknown>;
    const versionPage = fixture.snapshot_versions_page as Record<string, unknown>;
    const filePage = fixture.snapshot_files_page as Record<string, unknown>;
    const branch = (branchPage.items as Record<string, unknown>[])[0];
    const version = (versionPage.items as Record<string, unknown>[])[0];

    expect(remoteVersionIdentitySchema.safeParse({
      ...remoteIdentity,
      commit_sha: undefined
    }).success).toBe(false);
    expect(remoteVersionIdentitySchema.safeParse({
      ...remoteIdentity,
      change_key: undefined
    }).success).toBe(true);
    expect(branchSnapshotSchema.safeParse({ ...branch, commit_sha: undefined }).success)
      .toBe(true);
    expect(snapshotVersionSchema.safeParse({ ...version, commit_sha: undefined }).success)
      .toBe(true);
    expect(branchSnapshotPageSchema.safeParse({ items: branchPage.items }).success).toBe(true);
    expect(snapshotVersionPageSchema.safeParse({ items: versionPage.items }).success).toBe(true);
    expect(snapshotFilePageSchema.safeParse({ items: filePage.items }).success).toBe(true);

    for (const [schema, value, requiredField] of [
      [remoteVersionIdentitySchema, remoteIdentity, "client_id"],
      [branchSnapshotSchema, branch, "latest_version"],
      [snapshotVersionSchema, version, "artifact_id"],
      [snapshotFileSchema, (filePage.items as Record<string, unknown>[])[0], "content_hash"]
    ] as const) {
      expect(schema.safeParse({ ...value, unexpected: true }).success, requiredField).toBe(false);
      const missing = Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== requiredField)
      );
      expect(schema.safeParse(missing).success, requiredField).toBe(false);
    }

    expect(branchSnapshotPageSchema.safeParse({
      items: Array.from({ length: 101 }, () => branch)
    }).success).toBe(false);
    expect(snapshotVersionPageSchema.safeParse({
      items: Array.from({ length: 101 }, () => version)
    }).success).toBe(false);
    expect(snapshotFilePageSchema.safeParse({
      items: Array.from({ length: 101 }, () =>
        (filePage.items as Record<string, unknown>[])[0]
      )
    }).success).toBe(false);
  });

  it("keeps legacy and compatibility schemas strict", async () => {
    const fixture = await readLegacyFixture();
    const receipt = (fixture.receipts as unknown[])[0];
    const compatibility = (fixture.compatibility_results as unknown[])[0];

    expect(legacyArchivePackageReceiptSchema.safeParse({
      ...(receipt as Record<string, unknown>),
      knowledge_status: "complete"
    }).success).toBe(false);
    expect(legacyArchivePackageReceiptSchema.safeParse({
      ...(receipt as Record<string, unknown>),
      knowledgeStatus: "ready"
    }).success).toBe(false);
    expect(legacyArchiveCompatibilityResultSchema.safeParse({
      ...(compatibility as Record<string, unknown>),
      unexpected: true
    }).success).toBe(false);
  });
});
