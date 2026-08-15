import { z } from "zod";

import { canonicalJson } from "./canonical-json.js";

const schemaVersionSchema = z.literal(1);
const idSchema = z.string().min(1).max(160);
const branchNameSchema = z.string().min(1).max(512);
const projectIdSchema = z.string().regex(/^prj_[A-Za-z0-9_-]{1,156}$/u);
const hashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const commitShaSchema = z.string().regex(/^[a-f0-9]{40,64}$/u);
const timestampSchema = z.iso.datetime({ offset: true });
const cursorSchema = z.string().regex(/^[A-Za-z0-9_-]{16,512}$/u).nullable();
const pathSchema = z.string().min(1).max(1024).refine((value) =>
  !value.startsWith("/") && !value.includes("\\") &&
  value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
);

export const platformInformationViewSchema = z.enum([
  "branch_monitor",
  "branch_files",
  "project_materials",
  "project_knowledge",
  "change_records",
  "version_records"
]);

export const platformInformationPageStateSchema = z.enum([
  "ready", "empty", "processing", "partial_failure", "failed", "forbidden"
]);

export const platformInformationContentTypeSchema = z.enum([
  "run_event",
  "branch_file",
  "config",
  "rule",
  "architecture",
  "instruction",
  "knowledge_entry",
  "change_document",
  "archive_package",
  "project_content_candidate"
]);

export const platformInformationSortSchema = z.enum([
  "last_event_at_desc_run_id_asc",
  "uploaded_at_desc_snapshot_version_asc",
  "category_asc_path_asc_version_desc",
  "extracted_at_desc_knowledge_id_asc",
  "archived_at_desc_change_key_asc"
]);

/** Stage 12 canonical Plan phases consumed by the branch-monitor projection. */
export const platformInformationPlanPhaseSchema = z.enum([
  "plan",
  "run",
  "test",
  "review",
  "package",
  "apidoc",
  "submit",
  "merge",
  "archive"
]);

const viewPolicy = {
  branch_monitor: {
    sort: "last_event_at_desc_run_id_asc",
    contentTypes: ["run_event"],
    itemKind: "branch_monitor"
  },
  branch_files: {
    sort: "uploaded_at_desc_snapshot_version_asc",
    contentTypes: ["branch_file"],
    itemKind: "branch_snapshot"
  },
  project_materials: {
    sort: "category_asc_path_asc_version_desc",
    contentTypes: ["config", "rule", "architecture", "instruction"],
    itemKind: "project_material"
  },
  project_knowledge: {
    sort: "extracted_at_desc_knowledge_id_asc",
    contentTypes: ["knowledge_entry"],
    itemKind: "knowledge_entry"
  },
  change_records: {
    sort: "archived_at_desc_change_key_asc",
    contentTypes: ["change_document", "archive_package", "project_content_candidate"],
    itemKind: "change_record"
  },
  version_records: {
    sort: "uploaded_at_desc_snapshot_version_asc",
    contentTypes: ["branch_file"],
    itemKind: "version_record"
  }
} as const;

export const platformInformationQueryScopeSchema = z.object({
  actor_id: idSchema,
  accessible_project_ids: z.array(projectIdSchema).min(1).max(100),
  content_types: z.array(platformInformationContentTypeSchema).min(1).max(10)
}).strict().superRefine((value, context) => {
  if (new Set(value.accessible_project_ids).size !== value.accessible_project_ids.length) {
    context.addIssue({ code: "custom", message: "accessible_project_ids must be unique" });
  }
  if (new Set(value.content_types).size !== value.content_types.length) {
    context.addIssue({ code: "custom", message: "content_types must be unique" });
  }
});

export const platformInformationQuerySchema = z.object({
  schema_version: schemaVersionSchema,
  contract_kind: z.literal("query"),
  view: platformInformationViewSchema,
  project_id: projectIdSchema,
  query_scope: platformInformationQueryScopeSchema,
  limit: z.number().int().min(1).max(100),
  cursor: cursorSchema,
  cursor_verification: z.literal("server_port_required"),
  sort: platformInformationSortSchema
}).strict().superRefine((value, context) => {
  const policy = viewPolicy[value.view];
  if (value.sort !== policy.sort) {
    context.addIssue({ code: "custom", path: ["sort"], message: "sort does not match view" });
  }
  if (JSON.stringify(value.query_scope.content_types) !== JSON.stringify(policy.contentTypes)) {
    context.addIssue({ code: "custom", path: ["query_scope", "content_types"], message: "content types do not match view" });
  }
  if (!value.query_scope.accessible_project_ids.includes(value.project_id)) {
    context.addIssue({ code: "custom", path: ["query_scope", "accessible_project_ids"], message: "project is outside actor allowlist" });
  }
});

const sortKeySchema = z.string().min(1).max(512);
const blobRefSchema = z.object({
  blob_hash: hashSchema,
  snapshot_version: idSchema
}).strict();

const branchMonitorItemSchema = z.object({
  item_kind: z.literal("branch_monitor"),
  lifecycle_kind: z.literal("change"),
  run_id: idSchema,
  branch_name: branchNameSchema,
  change_key: idSchema,
  run_status: z.enum(["running", "succeeded", "failed", "partial"]),
  current_phase: platformInformationPlanPhaseSchema.nullable(),
  started_at: timestampSchema,
  ended_at: timestampSchema.nullable(),
  duration_ms: z.number().int().nonnegative().nullable(),
  last_event_at: timestampSchema,
  sort_key: sortKeySchema
}).strict();

const branchSnapshotItemSchema = z.object({
  item_kind: z.literal("branch_snapshot"),
  branch_name: idSchema,
  snapshot_version: idSchema,
  commit_sha: commitShaSchema,
  uploaded_at: timestampSchema,
  file_count: z.number().int().nonnegative(),
  changed_file_count: z.number().int().nonnegative(),
  sort_key: sortKeySchema
}).strict();

const projectMaterialItemSchema = z.object({
  item_kind: z.literal("project_material"),
  material_id: idSchema,
  category: z.enum(["config", "rule", "architecture_map", "architecture_constraint", "instruction"]),
  path: pathSchema,
  blob_ref: blobRefSchema,
  source_branch_name: idSchema,
  source_commit_sha: commitShaSchema,
  sort_key: sortKeySchema
}).strict();

const knowledgeItemSchema = z.object({
  item_kind: z.literal("knowledge_entry"),
  knowledge_id: idSchema,
  display_title: z.string().min(1).max(240),
  lifecycle_status: z.enum(["candidate", "active", "stale", "deprecated", "superseded", "conflicted"]),
  source_change_key: idSchema,
  extracted_at: timestampSchema,
  relationship_count: z.number().int().nonnegative(),
  sort_key: sortKeySchema
}).strict();

const archiveDownloadRefSchema = z.object({
  archive_id: idSchema,
  package_hash: hashSchema
}).strict();

const changeRecordItemSchema = z.object({
  item_kind: z.literal("change_record"),
  change_key: idSchema,
  title: z.string().min(1).max(240),
  archived_at: timestampSchema,
  archive_status: z.enum(["absent", "uploading", "stored", "failed"]),
  knowledge_extraction_status: z.enum(["not_scheduled", "queued", "extracting", "ready", "failed"]),
  document_refs: z.array(idSchema).max(20),
  candidate_count: z.number().int().nonnegative(),
  archive_download_ref: archiveDownloadRefSchema.nullable(),
  sort_key: sortKeySchema
}).strict();

const versionRecordItemSchema = z.object({
  item_kind: z.literal("version_record"),
  snapshot_version: idSchema,
  branch_name: idSchema,
  commit_sha: commitShaSchema,
  uploaded_at: timestampSchema,
  file_count: z.number().int().nonnegative(),
  changed_file_count: z.number().int().nonnegative(),
  diff_ref: idSchema,
  sort_key: sortKeySchema
}).strict();

export const platformInformationItemSchema = z.discriminatedUnion("item_kind", [
  branchMonitorItemSchema,
  branchSnapshotItemSchema,
  projectMaterialItemSchema,
  knowledgeItemSchema,
  changeRecordItemSchema,
  versionRecordItemSchema
]);

const failureSchema = z.object({
  reason_code: z.enum([
    "PROJECT_INFORMATION_FORBIDDEN",
    "PROJECTION_PARTIAL_FAILURE",
    "KNOWLEDGE_EXTRACTION_FAILED"
  ]),
  retryable: z.boolean()
}).strict();

export const platformInformationPageSchema = z.object({
  schema_version: schemaVersionSchema,
  contract_kind: z.literal("page"),
  view: platformInformationViewSchema,
  project_id: projectIdSchema,
  page_state: platformInformationPageStateSchema,
  sort: platformInformationSortSchema,
  items: z.array(platformInformationItemSchema).max(100),
  next_cursor: cursorSchema,
  failures: z.array(failureSchema).max(10)
}).strict().superRefine((value, context) => {
  const policy = viewPolicy[value.view];
  if (value.sort !== policy.sort || value.items.some((item) => item.item_kind !== policy.itemKind)) {
    context.addIssue({ code: "custom", message: "page projection does not match view" });
  }
  if (value.page_state === "ready" && value.items.length === 0) {
    context.addIssue({ code: "custom", path: ["items"], message: "ready page needs items" });
  }
  if (value.page_state === "ready" && value.failures.length !== 0) {
    context.addIssue({ code: "custom", path: ["failures"], message: "ready page cannot contain failures" });
  }
  if ((value.page_state === "empty" || value.page_state === "processing") &&
      (value.items.length !== 0 || value.next_cursor !== null || value.failures.length !== 0)) {
    context.addIssue({ code: "custom", message: "empty or processing page cannot contain results or failures" });
  }
  if (value.page_state === "partial_failure" && (value.items.length === 0 || value.failures.length === 0 ||
      value.failures.some((failure) => failure.reason_code !== "PROJECTION_PARTIAL_FAILURE"))) {
    context.addIssue({ code: "custom", message: "partial failure requires partial results and failures" });
  }
  if (value.page_state === "failed" &&
      (value.view !== "project_knowledge" || value.items.length !== 0 || value.next_cursor !== null ||
       value.failures.length !== 1 || value.failures[0]?.reason_code !== "KNOWLEDGE_EXTRACTION_FAILED" ||
       value.failures[0]?.retryable !== true)) {
    context.addIssue({ code: "custom", message: "failed is an empty retryable project knowledge extraction failure" });
  }
  if (value.page_state === "forbidden" &&
      (value.items.length !== 0 || value.next_cursor !== null || value.failures.length !== 1 ||
       value.failures[0]?.reason_code !== "PROJECT_INFORMATION_FORBIDDEN")) {
    context.addIssue({ code: "custom", message: "forbidden page must fail closed" });
  }
});

export const platformInformationDetailRequestSchema = z.object({
  schema_version: schemaVersionSchema,
  contract_kind: z.literal("detail_request"),
  view: platformInformationViewSchema,
  project_id: projectIdSchema,
  query_scope: platformInformationQueryScopeSchema,
  detail_id: idSchema
}).strict().superRefine((value, context) => {
  const policy = viewPolicy[value.view];
  if (!value.query_scope.accessible_project_ids.includes(value.project_id) ||
      JSON.stringify(value.query_scope.content_types) !== JSON.stringify(policy.contentTypes)) {
    context.addIssue({ code: "custom", message: "detail query scope does not match view" });
  }
});

const contentDetailSchema = z.object({
  detail_kind: z.enum(["branch_file", "project_material", "knowledge_entry", "change_document"]),
  content: z.string().max(2_000_000),
  content_hash: hashSchema,
  media_type: z.enum(["text/plain", "text/markdown", "application/json", "application/yaml"])
}).strict();

const monitorDetailSchema = z.object({
  detail_kind: z.literal("branch_monitor"),
  lifecycle_kind: z.literal("change"),
  event_refs: z.array(idSchema).max(100)
}).strict();

const changeDetailSchema = z.object({
  detail_kind: z.literal("change_record"),
  document_refs: z.array(idSchema).max(20),
  candidate_refs: z.array(idSchema).max(100),
  archive_download_ref: archiveDownloadRefSchema.nullable()
}).strict();

const versionDiffDetailSchema = z.object({
  detail_kind: z.literal("version_diff"),
  from_version: idSchema,
  to_version: idSchema,
  changed_paths: z.array(pathSchema).max(1000)
}).strict();

export const platformInformationDetailResponseSchema = z.object({
  schema_version: schemaVersionSchema,
  contract_kind: z.literal("detail_response"),
  view: platformInformationViewSchema,
  project_id: projectIdSchema,
  detail_id: idSchema,
  detail: z.union([contentDetailSchema, monitorDetailSchema, changeDetailSchema, versionDiffDetailSchema])
}).strict().superRefine((value, context) => {
  const allowedDetailKinds = {
    branch_monitor: ["branch_monitor"],
    branch_files: ["branch_file"],
    project_materials: ["project_material"],
    project_knowledge: ["knowledge_entry"],
    change_records: ["change_document", "change_record"],
    version_records: ["version_diff"]
  } as const;
  if (!(allowedDetailKinds[value.view] as readonly string[]).includes(value.detail.detail_kind)) {
    context.addIssue({ code: "custom", path: ["detail", "detail_kind"], message: "detail does not match view" });
  }
});

export const restoreBranchFilesIntentSchema = z.object({
  schema_version: schemaVersionSchema,
  contract_kind: z.literal("branch_files_pull_preview_intent"),
  project_id: projectIdSchema,
  source_branch_name: idSchema,
  source_commit_sha: commitShaSchema,
  source_artifact_id: idSchema,
  source_project_version: idSchema,
  scopes: z.tuple([z.literal("branch_files")]),
  selected_paths: z.array(pathSchema).min(1).max(1000),
  preview_only: z.literal(true)
}).strict().superRefine((value, context) => {
  if (new Set(value.selected_paths).size !== value.selected_paths.length) {
    context.addIssue({ code: "custom", path: ["selected_paths"], message: "selected paths must be unique" });
  }
});

export const knowledgeExtractionRetryIntentSchema = z.object({
  schema_version: schemaVersionSchema,
  contract_kind: z.literal("knowledge_extraction_retry_intent"),
  actor_id: idSchema,
  project_id: projectIdSchema,
  job_id: z.string().regex(/^job_knowledge_[A-Za-z0-9._:-]{1,146}$/u),
  expected_generation: z.number().int().nonnegative(),
  retryable: z.literal(true),
  request_only: z.literal(true),
  intent_hash: hashSchema
}).strict();

export interface KnowledgeExtractionRetryIntentHashPort {
  sha256(canonical_payload: string): string | Promise<string>;
}

export interface KnowledgeExtractionRetryIntentExpected {
  readonly actor_id: string;
  readonly project_id: string;
  readonly job_id: string;
  readonly expected_generation: number;
}

export type KnowledgeExtractionRetryIntentVerificationResult =
  | { ok: true; value: z.infer<typeof knowledgeExtractionRetryIntentSchema> }
  | { ok: false; reason_code:
      | "KNOWLEDGE_EXTRACTION_RETRY_INTENT_INVALID"
      | "KNOWLEDGE_EXTRACTION_RETRY_INTENT_MISMATCH"
      | "KNOWLEDGE_EXTRACTION_RETRY_INTENT_HASH_MISMATCH" };

export async function verifyKnowledgeExtractionRetryIntent(
  serialized: unknown,
  expected: KnowledgeExtractionRetryIntentExpected,
  hash_port: KnowledgeExtractionRetryIntentHashPort
): Promise<KnowledgeExtractionRetryIntentVerificationResult> {
  if (typeof serialized !== "string" || serialized.length > 2_000_000) {
    return { ok: false, reason_code: "KNOWLEDGE_EXTRACTION_RETRY_INTENT_INVALID" };
  }
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(serialized) as unknown;
  } catch {
    return { ok: false, reason_code: "KNOWLEDGE_EXTRACTION_RETRY_INTENT_INVALID" };
  }
  const parsed = knowledgeExtractionRetryIntentSchema.safeParse(parsedValue);
  if (!parsed.success) {
    return { ok: false, reason_code: "KNOWLEDGE_EXTRACTION_RETRY_INTENT_INVALID" };
  }
  const value = parsed.data;
  if (value.actor_id !== expected.actor_id || value.project_id !== expected.project_id ||
      value.job_id !== expected.job_id || value.expected_generation !== expected.expected_generation) {
    return { ok: false, reason_code: "KNOWLEDGE_EXTRACTION_RETRY_INTENT_MISMATCH" };
  }
  const { intent_hash, ...identity } = value;
  let actualHash: string;
  try {
    actualHash = await hash_port.sha256(canonicalJson(identity));
  } catch {
    return { ok: false, reason_code: "KNOWLEDGE_EXTRACTION_RETRY_INTENT_HASH_MISMATCH" };
  }
  if (!hashSchema.safeParse(actualHash).success || actualHash !== intent_hash) {
    return { ok: false, reason_code: "KNOWLEDGE_EXTRACTION_RETRY_INTENT_HASH_MISMATCH" };
  }
  return { ok: true, value };
}

const restoreSourceRefSchema = z.object({
  project_id: projectIdSchema,
  branch_name: idSchema,
  commit_sha: commitShaSchema,
  client_id: idSchema
}).strict();

const restoreSourceVersionSchema = z.object({
  branch_name: idSchema,
  commit_sha: commitShaSchema,
  artifact_id: idSchema,
  project_version: idSchema
}).strict();

const restoreConflictSchema = z.object({
  path: pathSchema,
  reason_code: z.enum(["SYNC_CONTENT_CONFLICT", "SYNC_RENAME_TARGET_CONFLICT"])
}).strict();

export const restoreBranchFilesPreviewReceiptSchema = z.object({
  schema_version: schemaVersionSchema,
  contract_kind: z.literal("branch_files_pull_preview_receipt"),
  project_id: projectIdSchema,
  source_ref: restoreSourceRefSchema,
  source_version: restoreSourceVersionSchema,
  scopes: z.tuple([z.literal("branch_files")]),
  selected_paths: z.array(pathSchema).min(1).max(1000),
  preview_hash: hashSchema,
  conflicts: z.array(restoreConflictSchema).max(1000)
}).strict().superRefine((value, context) => {
  const selected = new Set(value.selected_paths);
  if (value.source_ref.project_id !== value.project_id ||
      value.source_ref.branch_name !== value.source_version.branch_name ||
      value.source_ref.commit_sha !== value.source_version.commit_sha ||
      selected.size !== value.selected_paths.length ||
      new Set(value.conflicts.map((conflict) => conflict.path)).size !== value.conflicts.length ||
      value.conflicts.some((conflict) => !selected.has(conflict.path))) {
    context.addIssue({ code: "custom", message: "restore preview binding is invalid" });
  }
});

const restoreConflictDecisionSchema = z.object({
  path: pathSchema,
  resolution: z.enum(["keep_local", "accept_remote", "skip"]),
  expected_preview_hash: hashSchema,
  source_artifact_id: idSchema,
  source_project_version: idSchema
}).strict();

export const restoreBranchFilesConfirmationIntentSchema = z.object({
  schema_version: schemaVersionSchema,
  contract_kind: z.literal("branch_files_pull_confirmation_intent"),
  project_id: projectIdSchema,
  source_ref: restoreSourceRefSchema,
  source_version: restoreSourceVersionSchema,
  scopes: z.tuple([z.literal("branch_files")]),
  preview_hash: hashSchema,
  action: z.enum(["continue", "review", "stop"]),
  idempotency_key: idSchema,
  conflict_decisions: z.array(restoreConflictDecisionSchema).max(1000)
}).strict().superRefine((value, context) => {
  if (value.action !== "continue" && value.conflict_decisions.length !== 0) {
    context.addIssue({ code: "custom", path: ["conflict_decisions"],
      message: "review and stop cannot carry conflict decisions" });
  }
});

export type BranchFilesPullConfirmationValidationResult =
  | { ok: true; preview: z.infer<typeof restoreBranchFilesPreviewReceiptSchema>;
      confirmation: z.infer<typeof restoreBranchFilesConfirmationIntentSchema> }
  | { ok: false; reason_code:
      | "BRANCH_FILES_PULL_CONFIRMATION_INVALID"
      | "BRANCH_FILES_PULL_CONFIRMATION_MISMATCH" };

export function validateBranchFilesPullConfirmation(
  previewJson: string,
  confirmationJson: string
): BranchFilesPullConfirmationValidationResult {
  if (typeof previewJson !== "string" || typeof confirmationJson !== "string" ||
      previewJson.length > 2_000_000 || confirmationJson.length > 2_000_000) {
    return { ok: false, reason_code: "BRANCH_FILES_PULL_CONFIRMATION_INVALID" };
  }
  let previewValue: unknown;
  let confirmationValue: unknown;
  try {
    previewValue = JSON.parse(previewJson) as unknown;
    confirmationValue = JSON.parse(confirmationJson) as unknown;
  } catch {
    return { ok: false, reason_code: "BRANCH_FILES_PULL_CONFIRMATION_INVALID" };
  }
  const parsedPreview = restoreBranchFilesPreviewReceiptSchema.safeParse(previewValue);
  const parsedConfirmation = restoreBranchFilesConfirmationIntentSchema.safeParse(confirmationValue);
  if (!parsedPreview.success || !parsedConfirmation.success) {
    return { ok: false, reason_code: "BRANCH_FILES_PULL_CONFIRMATION_INVALID" };
  }
  const preview = parsedPreview.data;
  const confirmation = parsedConfirmation.data;
  const conflictsByPath = new Map(preview.conflicts.map((conflict) => [conflict.path, conflict]));
  const decisionsByPath = new Map(confirmation.conflict_decisions.map((decision) => [decision.path, decision]));
  const mismatch = preview.project_id !== confirmation.project_id ||
    JSON.stringify(preview.source_ref) !== JSON.stringify(confirmation.source_ref) ||
    JSON.stringify(preview.source_version) !== JSON.stringify(confirmation.source_version) ||
    JSON.stringify(preview.scopes) !== JSON.stringify(confirmation.scopes) ||
    preview.preview_hash !== confirmation.preview_hash ||
    confirmation.action !== "continue" ||
    conflictsByPath.size !== preview.conflicts.length ||
    decisionsByPath.size !== confirmation.conflict_decisions.length ||
    conflictsByPath.size !== decisionsByPath.size ||
    [...conflictsByPath.keys()].some((path) => !decisionsByPath.has(path)) ||
    confirmation.conflict_decisions.some((decision) =>
      decision.expected_preview_hash !== preview.preview_hash ||
      decision.source_artifact_id !== preview.source_version.artifact_id ||
      decision.source_project_version !== preview.source_version.project_version);
  if (mismatch) return { ok: false, reason_code: "BRANCH_FILES_PULL_CONFIRMATION_MISMATCH" };
  return { ok: true, preview, confirmation };
}

const exportPageProofSchema = z.object({
  request_cursor: cursorSchema,
  response_next_cursor: cursorSchema,
  result_count: z.number().int().min(0).max(100)
}).strict();

const maximumExportPages = 10_000;
const maximumExportItems = 1_000_000;

export const platformInformationExportResultSchema = z.object({
  schema_version: schemaVersionSchema,
  contract_kind: z.literal("export_all_result"),
  view: platformInformationViewSchema,
  project_id: projectIdSchema,
  range: z.object({
    query_scope: platformInformationQueryScopeSchema,
    limit: z.number().int().min(1).max(100),
    source_cursor: cursorSchema,
    cursor_verification: z.literal("server_port_required"),
    sort: platformInformationSortSchema
  }).strict(),
  pages: z.array(exportPageProofSchema).min(1).max(maximumExportPages),
  exported_count: z.number().int().min(0).max(maximumExportItems),
  completed: z.literal(true)
}).strict().superRefine((value, context) => {
  const policy = viewPolicy[value.view];
  const requestCursors = value.pages.map((page) => page.request_cursor);
  const subsequentRequestCursors = requestCursors.slice(1);
  const nonterminalResponseCursors = value.pages.slice(0, -1).map((page) => page.response_next_cursor);
  if (value.range.sort !== policy.sort ||
      JSON.stringify(value.range.query_scope.content_types) !== JSON.stringify(policy.contentTypes) ||
      !value.range.query_scope.accessible_project_ids.includes(value.project_id) ||
      value.pages[0]?.request_cursor !== value.range.source_cursor ||
      value.pages.at(-1)?.response_next_cursor !== null ||
      value.pages.some((page, index) => index > 0 && page.request_cursor !== value.pages[index - 1]?.response_next_cursor) ||
      value.pages.some((page) => page.result_count > value.range.limit) ||
      subsequentRequestCursors.some((cursor) => cursor === null) ||
      new Set(requestCursors).size !== requestCursors.length ||
      nonterminalResponseCursors.some((cursor) => cursor === null) ||
      new Set(nonterminalResponseCursors).size !== nonterminalResponseCursors.length ||
      value.exported_count !== value.pages.reduce((sum, page) => sum + page.result_count, 0)) {
    context.addIssue({ code: "custom", message: "export cursor proof is incomplete" });
  }
});

export const legacyPlatformInformationSchema = z.object({
  schemaVersion: z.literal(0),
  projectId: projectIdSchema,
  page: z.literal("files"),
  items: z.array(z.object({ path: pathSchema, content: z.string() }).strict()).max(1000)
}).strict();

export const platformInformationContractSchema = z.union([
  platformInformationQuerySchema,
  platformInformationPageSchema,
  platformInformationDetailRequestSchema,
  platformInformationDetailResponseSchema,
  knowledgeExtractionRetryIntentSchema,
  restoreBranchFilesIntentSchema,
  restoreBranchFilesPreviewReceiptSchema,
  restoreBranchFilesConfirmationIntentSchema,
  platformInformationExportResultSchema
]);

export type PlatformInformationContract = z.infer<typeof platformInformationContractSchema>;
export type PlatformInformationQuery = z.infer<typeof platformInformationQuerySchema>;
export type PlatformInformationPage = z.infer<typeof platformInformationPageSchema>;
export type PlatformInformationDetailRequest = z.infer<typeof platformInformationDetailRequestSchema>;
export type PlatformInformationDetailResponse = z.infer<typeof platformInformationDetailResponseSchema>;
export type KnowledgeExtractionRetryIntent = z.infer<typeof knowledgeExtractionRetryIntentSchema>;
export type RestoreBranchFilesIntent = z.infer<typeof restoreBranchFilesIntentSchema>;
export type RestoreBranchFilesPreviewReceipt = z.infer<typeof restoreBranchFilesPreviewReceiptSchema>;
export type RestoreBranchFilesConfirmationIntent = z.infer<typeof restoreBranchFilesConfirmationIntentSchema>;
export type PlatformInformationExportResult = z.infer<typeof platformInformationExportResultSchema>;
export type LegacyPlatformInformation = z.infer<typeof legacyPlatformInformationSchema>;

export type PlatformInformationExportVerificationResult =
  | { ok: true; value: PlatformInformationExportResult }
  | { ok: false; reason_code:
      | "PLATFORM_INFORMATION_EXPORT_SERIALIZED_JSON_REQUIRED"
      | "PLATFORM_INFORMATION_EXPORT_SERIALIZED_JSON_TOO_LARGE"
      | "PLATFORM_INFORMATION_EXPORT_PROOF_INVALID"
      | "PLATFORM_INFORMATION_EXPORT_QUERY_INVALID"
      | "PLATFORM_INFORMATION_EXPORT_RANGE_MISMATCH" };

export function verifyPlatformInformationExportResult(
  serializedProof: unknown,
  expectedQuery: unknown
): PlatformInformationExportVerificationResult {
  if (typeof serializedProof !== "string") {
    return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_SERIALIZED_JSON_REQUIRED" };
  }
  if (serializedProof.length > 2_000_000) {
    return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_SERIALIZED_JSON_TOO_LARGE" };
  }
  let parsedProof: unknown;
  try {
    parsedProof = JSON.parse(serializedProof) as unknown;
  } catch {
    return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_PROOF_INVALID" };
  }
  const proof = platformInformationExportResultSchema.safeParse(parsedProof);
  if (!proof.success) {
    return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_PROOF_INVALID" };
  }
  const query = platformInformationQuerySchema.safeParse(expectedQuery);
  if (!query.success) {
    return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_QUERY_INVALID" };
  }
  const expectedRange = {
    query_scope: query.data.query_scope,
    limit: query.data.limit,
    source_cursor: query.data.cursor,
    cursor_verification: query.data.cursor_verification,
    sort: query.data.sort
  };
  if (proof.data.view !== query.data.view ||
      proof.data.project_id !== query.data.project_id ||
      canonicalJson(proof.data.range) !== canonicalJson(expectedRange)) {
    return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_RANGE_MISMATCH" };
  }
  return { ok: true, value: proof.data };
}

export interface PlatformInformationCursorVerifierPort {
  verify(input: {
    readonly cursor: string;
    readonly project_id: string;
    readonly actor_id: string;
    readonly view: z.infer<typeof platformInformationViewSchema>;
    readonly sort: z.infer<typeof platformInformationSortSchema>;
  }): boolean | Promise<boolean>;
}

export type PlatformInformationReadResult =
  | { ok: true; mode: "current"; source_schema_version: 1; value: PlatformInformationContract }
  | { ok: true; mode: "legacy_read_only"; source_schema_version: 0; value: LegacyPlatformInformation }
  | { ok: false; reason_code:
      | "PLATFORM_INFORMATION_CONTRACT_INVALID"
      | "PLATFORM_INFORMATION_VERSION_UNSUPPORTED"
      | "PLATFORM_INFORMATION_SERIALIZED_JSON_REQUIRED"
      | "PLATFORM_INFORMATION_SERIALIZED_JSON_TOO_LARGE" };

export function readPlatformInformationContract(value: unknown): PlatformInformationReadResult {
  if (typeof value !== "string") {
    return { ok: false, reason_code: "PLATFORM_INFORMATION_SERIALIZED_JSON_REQUIRED" };
  }
  if (value.length > 2_000_000) {
    return { ok: false, reason_code: "PLATFORM_INFORMATION_SERIALIZED_JSON_TOO_LARGE" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return { ok: false, reason_code: "PLATFORM_INFORMATION_CONTRACT_INVALID" };
  }
  const current = platformInformationContractSchema.safeParse(parsed);
  if (current.success) {
    return { ok: true, mode: "current", source_schema_version: 1, value: current.data };
  }
  const legacy = legacyPlatformInformationSchema.safeParse(parsed);
  if (legacy.success) {
    return { ok: true, mode: "legacy_read_only", source_schema_version: 0, value: legacy.data };
  }
  if (parsed !== null && typeof parsed === "object" &&
      Object.hasOwn(parsed, "schema_version") &&
      (parsed as { schema_version?: unknown }).schema_version !== 1) {
    return { ok: false, reason_code: "PLATFORM_INFORMATION_VERSION_UNSUPPORTED" };
  }
  return { ok: false, reason_code: "PLATFORM_INFORMATION_CONTRACT_INVALID" };
}
