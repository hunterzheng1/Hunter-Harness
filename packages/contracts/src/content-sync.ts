import { z } from "zod";

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const validationReasonCodeParam = "content_sync_reason_code";
const validationEvidenceParam = "content_sync_validation_evidence";
const schemaVersionEvidence = "schema_version";

type FrozenStringEnumSchema<T extends readonly [string, ...string[]]> =
  z.ZodType<T[number]> & Readonly<{ options: T }>;

function frozenStringEnumSchema<const T extends readonly [string, ...string[]]>(
  options: T
) {
  const allowedValues = new Set<string>(options);
  const outputSchema = z.enum(options);
  const validationSchema = z.string().superRefine((value, context) => {
    if (allowedValues.has(value)) return;
    context.addIssue({
      code: "custom",
      params: {
        [validationReasonCodeParam]: "CONTENT_SYNC_ENUM_INVALID"
      }
    });
  }).pipe(outputSchema);
  const publicProperties: Readonly<{ options: T }> = { options };
  return Object.assign(validationSchema, publicProperties) as FrozenStringEnumSchema<T>;
}

function frozenStringLiteralSchema<const T extends string>(value: T) {
  return frozenStringEnumSchema([value]);
}

function correlatedStringLiteralSchema<const T extends string>(value: T) {
  return z.literal(value);
}

const correlatedSchemaVersionSchema = z.literal(1);

const schemaVersionSchema = z.number().superRefine((value, context) => {
  if (value === 1) return;
  context.addIssue({
    code: "custom",
    params: {
      [validationReasonCodeParam]: "CONTENT_SYNC_SCHEMA_INVALID",
      [validationEvidenceParam]: schemaVersionEvidence
    }
  });
}).pipe(z.literal(1));

const incompleteV1StatusesSchema = z.boolean().superRefine((value, context) => {
  if (!value) return;
  context.addIssue({
    code: "custom",
    params: {
      [validationReasonCodeParam]: "CONTENT_SYNC_SCHEMA_INVALID"
    }
  });
}).pipe(z.literal(false));

const contentKindValues = [
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
] as const;
export const contentKindSchema: FrozenStringEnumSchema<typeof contentKindValues> =
  frozenStringEnumSchema(contentKindValues);

const syncScopeValues = [
  "config",
  "rules",
  "architecture",
  "instructions",
  "branch_files",
  "archive"
] as const;
export const syncScopeSchema: FrozenStringEnumSchema<typeof syncScopeValues> =
  frozenStringEnumSchema(syncScopeValues);

const syncDirectionValues = ["push", "pull"] as const;
export const syncDirectionSchema: FrozenStringEnumSchema<typeof syncDirectionValues> =
  frozenStringEnumSchema(syncDirectionValues);

const syncActionValues = [
  "add",
  "modify",
  "delete",
  "restore",
  "rename",
  "no_change"
] as const;
export const syncActionSchema: FrozenStringEnumSchema<typeof syncActionValues> =
  frozenStringEnumSchema(syncActionValues);

const conflictResolutionValues = [
  "keep_local",
  "accept_remote",
  "skip",
  "cancel"
] as const;
export const conflictResolutionSchema: FrozenStringEnumSchema<typeof conflictResolutionValues> =
  frozenStringEnumSchema(conflictResolutionValues);

const projectContentCandidateTypeValues = [
  "rule",
  "architecture-decision",
  "glossary"
] as const;
export const projectContentCandidateTypeSchema: FrozenStringEnumSchema<
  typeof projectContentCandidateTypeValues
> = frozenStringEnumSchema(projectContentCandidateTypeValues);

const projectContentCandidateStatusValues = [
  "pending",
  "proposed",
  "accepted",
  "rejected",
  "superseded"
] as const;
export const projectContentCandidateStatusSchema: FrozenStringEnumSchema<
  typeof projectContentCandidateStatusValues
> = frozenStringEnumSchema(projectContentCandidateStatusValues);

const knowledgeCandidateStatusValues = [
  "pending",
  "accepted",
  "rejected",
  "superseded"
] as const;
export const knowledgeCandidateStatusSchema: FrozenStringEnumSchema<
  typeof knowledgeCandidateStatusValues
> = frozenStringEnumSchema(knowledgeCandidateStatusValues);

// 与 knowledge.ts 的 knowledgeIngestEntryTypeSchema 逐值对齐：候选携带的
// entry_type 最终原样落到知识条目的 type 上，两处漂移会让桥在投影时
// safeParse 失败并静默丢条目（见 semantic/knowledge-projection.ts）。
const knowledgeCandidateEntryTypeValues = [
  "requirement",
  "decision",
  "implementation",
  "risk",
  "test-evidence",
  "pitfall",
  "api-contract"
] as const;
export const knowledgeCandidateEntryTypeSchema: FrozenStringEnumSchema<
  typeof knowledgeCandidateEntryTypeValues
> = frozenStringEnumSchema(knowledgeCandidateEntryTypeValues);

const candidateProvenanceSourceKindValues = [
  "archive",
  "plan",
  "review",
  "manual",
  "migration"
] as const;
export const candidateProvenanceSourceKindSchema: FrozenStringEnumSchema<
  typeof candidateProvenanceSourceKindValues
> = frozenStringEnumSchema(candidateProvenanceSourceKindValues);

export const INSTRUCTION_ENTRYPOINTS = [
  "AGENTS.md",
  "CLAUDE.md",
  "CODEBUDDY.md"
] as const;
const maxSelectedInstructionEntrypoints = INSTRUCTION_ENTRYPOINTS.length;

export const instructionEntrypointSchema: FrozenStringEnumSchema<
  typeof INSTRUCTION_ENTRYPOINTS
> = frozenStringEnumSchema(INSTRUCTION_ENTRYPOINTS);

const archiveStatusValues = [
  "absent",
  "uploading",
  "stored",
  "failed"
] as const;
export const archiveStatusValueSchema: FrozenStringEnumSchema<typeof archiveStatusValues> =
  frozenStringEnumSchema(archiveStatusValues);

const changeIndexStatusValues = [
  "not_scheduled",
  "queued",
  "indexing",
  "ready",
  "failed"
] as const;
export const changeIndexStatusValueSchema: FrozenStringEnumSchema<
  typeof changeIndexStatusValues
> = frozenStringEnumSchema(changeIndexStatusValues);

const knowledgeExtractionStatusValues = [
  "not_scheduled",
  "queued",
  "extracting",
  "ready",
  "failed"
] as const;
export const knowledgeExtractionStatusValueSchema: FrozenStringEnumSchema<
  typeof knowledgeExtractionStatusValues
> = frozenStringEnumSchema(knowledgeExtractionStatusValues);

const managedSnapshotStatusValues = [
  "absent",
  "publishing",
  "ready",
  "conflict",
  "failed"
] as const;
export const managedSnapshotStatusValueSchema: FrozenStringEnumSchema<
  typeof managedSnapshotStatusValues
> = frozenStringEnumSchema(managedSnapshotStatusValues);

const pullPolicyValues = [
  "regular",
  "explicit_source_only",
  "not_pullable"
] as const;
export const pullPolicySchema: FrozenStringEnumSchema<typeof pullPolicyValues> =
  frozenStringEnumSchema(pullPolicyValues);

const contentScanPolicyValues = [
  "required",
  "skip_content_scan"
] as const;
export const contentScanPolicySchema: FrozenStringEnumSchema<typeof contentScanPolicyValues> =
  frozenStringEnumSchema(contentScanPolicyValues);

export const contentSyncReasonCodeValueSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Z][A-Z0-9_]*$/u);

const rfc3339DateTimeSchema = z.iso.datetime({ offset: true });

const statusMetadataFields = {
  updated_at: rfc3339DateTimeSchema,
  retryable: z.boolean(),
  reason_code: contentSyncReasonCodeValueSchema.optional()
};

export const archiveStatusSchema = z.object({
  status: archiveStatusValueSchema,
  ...statusMetadataFields
}).strict();

export const changeIndexStatusSchema = z.object({
  status: changeIndexStatusValueSchema,
  ...statusMetadataFields
}).strict();

export const knowledgeExtractionStatusSchema = z.object({
  status: knowledgeExtractionStatusValueSchema,
  ...statusMetadataFields
}).strict();

export const managedSnapshotStatusSchema = z.object({
  status: managedSnapshotStatusValueSchema,
  ...statusMetadataFields
}).strict();

export const contentSyncStatusesSchema = z.object({
  schema_version: schemaVersionSchema,
  archive_status: archiveStatusSchema,
  change_index_status: changeIndexStatusSchema,
  knowledge_extraction_status: knowledgeExtractionStatusSchema,
  managed_snapshot_status: managedSnapshotStatusSchema
}).strict();

const archiveIngestIdentityFields = {
  schema_version: schemaVersionSchema,
  request_id: z.string().regex(/^archive_request:[a-f0-9]{64}$/u),
  idempotency_key: sha256Schema,
  project_id: z.string().regex(/^prj_[A-Za-z0-9][A-Za-z0-9._:-]{0,155}$/u),
  change_key: z.string().min(1).max(160),
  archive_id: z.string().regex(/^arc_[A-Za-z0-9][A-Za-z0-9._:-]{0,155}$/u),
  package_sha256: sha256Schema,
  manifest_sha256: sha256Schema,
  project_version: z.string().regex(/^pv_[A-Za-z0-9][A-Za-z0-9._:-]{0,155}$/u),
  stored_at: rfc3339DateTimeSchema,
  retryable: z.literal(false)
};

const storedArchiveStatusSchema = z.object({
  status: correlatedStringLiteralSchema("stored"),
  updated_at: rfc3339DateTimeSchema,
  retryable: z.literal(false)
}).strict();

const plannedChangeIndexStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: correlatedStringLiteralSchema("queued"), updated_at: rfc3339DateTimeSchema,
    retryable: z.literal(true) }).strict(),
  z.object({ status: correlatedStringLiteralSchema("indexing"), updated_at: rfc3339DateTimeSchema,
    retryable: z.literal(true) }).strict(),
  z.object({ status: correlatedStringLiteralSchema("ready"), updated_at: rfc3339DateTimeSchema,
    retryable: z.literal(false) }).strict(),
  z.object({ status: correlatedStringLiteralSchema("failed"), updated_at: rfc3339DateTimeSchema,
    retryable: z.boolean(), reason_code: contentSyncReasonCodeValueSchema }).strict()
]);

const plannedKnowledgeExtractionStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: correlatedStringLiteralSchema("queued"), updated_at: rfc3339DateTimeSchema,
    retryable: z.literal(true) }).strict(),
  z.object({ status: correlatedStringLiteralSchema("extracting"), updated_at: rfc3339DateTimeSchema,
    retryable: z.literal(true) }).strict(),
  z.object({ status: correlatedStringLiteralSchema("ready"), updated_at: rfc3339DateTimeSchema,
    retryable: z.literal(false) }).strict(),
  z.object({ status: correlatedStringLiteralSchema("failed"), updated_at: rfc3339DateTimeSchema,
    retryable: z.boolean(), reason_code: contentSyncReasonCodeValueSchema }).strict()
]);

const failedChangeIndexStatusSchema = z.object({
  status: correlatedStringLiteralSchema("failed"),
  updated_at: rfc3339DateTimeSchema,
  retryable: z.literal(true),
  reason_code: contentSyncReasonCodeValueSchema
}).strict();

const failedKnowledgeExtractionStatusSchema = z.object({
  status: correlatedStringLiteralSchema("failed"),
  updated_at: rfc3339DateTimeSchema,
  retryable: z.literal(true),
  reason_code: contentSyncReasonCodeValueSchema
}).strict();

const archiveIngestQueuedReceiptSchema = z.object({
  ...archiveIngestIdentityFields,
  archive_status: storedArchiveStatusSchema,
  change_index_status: plannedChangeIndexStatusSchema,
  knowledge_extraction_status: plannedKnowledgeExtractionStatusSchema,
  change_projection_job_id: z.string().regex(/^job_change_[A-Za-z0-9._:-]+$/u),
  knowledge_extraction_job_id: z.string().regex(/^job_knowledge_[A-Za-z0-9._:-]+$/u),
  project_content_job_id: z.string().regex(/^job_content_[A-Za-z0-9._:-]+$/u).optional()
}).strict();

const archiveIngestPlanningFailedReceiptSchema = z.object({
  ...archiveIngestIdentityFields,
  archive_status: storedArchiveStatusSchema,
  change_index_status: failedChangeIndexStatusSchema,
  knowledge_extraction_status: failedKnowledgeExtractionStatusSchema
}).strict();

/**
 * Canonical v1 receipt for a durably stored archive after atomic task planning.
 * `archive_status.status === "stored"` is the machine acknowledgement that the
 * client must not re-upload the immutable package, even when task planning failed.
 */
export const archiveIngestReceiptSchema = z.union([
  archiveIngestQueuedReceiptSchema,
  archiveIngestPlanningFailedReceiptSchema
]);

const remoteProjectIdSchema = z.string().regex(/^prj_/u);
const remoteArtifactIdSchema = z.string().regex(/^art_/u);
const remoteProjectVersionSchema = z.string().regex(/^pv_/u);
const remoteBranchNameSchema = z.string().min(1);
const remoteCommitShaSchema = z.string().min(1);
const remoteManifestHashSchema = sha256Schema;
const remoteUploadedAtSchema = rfc3339DateTimeSchema;
const opaquePageCursorSchema = z.string().min(1).describe(
  "Opaque continuation token. Clients must return it unchanged and must not infer ordering from it."
);
const maxContentSyncPageItems = 100;

export const remoteVersionIdentitySchema = z.object({
  project_id: remoteProjectIdSchema,
  branch_name: remoteBranchNameSchema,
  commit_sha: remoteCommitShaSchema,
  change_key: z.string().min(1).max(160).optional(),
  artifact_id: remoteArtifactIdSchema,
  project_version: remoteProjectVersionSchema,
  uploaded_at: remoteUploadedAtSchema,
  client_id: z.string().regex(/^cli_/u),
  manifest_hash: remoteManifestHashSchema
}).strict();

export const branchSnapshotSchema = z.object({
  project_id: remoteProjectIdSchema,
  branch_name: remoteBranchNameSchema,
  latest_version: remoteProjectVersionSchema,
  commit_sha: remoteCommitShaSchema.optional(),
  artifact_id: remoteArtifactIdSchema,
  manifest_hash: remoteManifestHashSchema,
  file_count: z.number().int().nonnegative(),
  changed_count: z.number().int().nonnegative(),
  uploaded_at: remoteUploadedAtSchema
}).strict();

export const snapshotVersionSchema = z.object({
  branch_name: remoteBranchNameSchema,
  project_version: remoteProjectVersionSchema,
  commit_sha: remoteCommitShaSchema.optional(),
  artifact_id: remoteArtifactIdSchema,
  manifest_hash: remoteManifestHashSchema,
  uploaded_at: remoteUploadedAtSchema
}).strict();

export const snapshotFileSchema = z.object({
  path: z.string().min(1),
  content_kind: contentKindSchema,
  size: z.number().int().nonnegative(),
  content_hash: sha256Schema,
  action: syncActionSchema.optional()
}).strict();

export const branchSnapshotPageSchema = z.object({
  items: z.array(branchSnapshotSchema).max(maxContentSyncPageItems),
  next_cursor: opaquePageCursorSchema.optional()
}).strict().describe(
  "Sorted by uploaded_at descending, then branch_name ascending as the unique tie-breaker."
);

export const snapshotVersionPageSchema = z.object({
  items: z.array(snapshotVersionSchema).max(maxContentSyncPageItems),
  next_cursor: opaquePageCursorSchema.optional()
}).strict().describe(
  "Sorted by uploaded_at descending, then artifact_id ascending as the unique tie-breaker."
);

export const snapshotFilePageSchema = z.object({
  items: z.array(snapshotFileSchema).max(maxContentSyncPageItems),
  next_cursor: opaquePageCursorSchema.optional()
}).strict().describe(
  "Sorted by path ascending; path is unique within an immutable snapshot."
);

// Remote Sync v1 is deliberately HTTP-neutral.  These schemas describe the
// stable wire/domain values shared by Core and a future transport adapter; no
// HTTP status, header, or route is part of the contract.
const remoteSyncLeaseTokenSchema = z.string()
  .regex(/^lease_[A-Za-z0-9_-]{43}$/u);
const remoteSyncLeaseIdSchema = z.string()
  .regex(/^lease_[A-Za-z0-9_-]{1,127}$/u);
const remoteSyncActorIdSchema = z.string().min(1).max(160);
const remoteSyncExpirySchema = rfc3339DateTimeSchema;

export const remoteSyncSourceRefSchema = z.object({
  project_id: remoteProjectIdSchema,
  branch_name: remoteBranchNameSchema,
  actor_id: remoteSyncActorIdSchema,
  commit_sha: remoteCommitShaSchema.optional(),
  client_id: z.string().regex(/^cli_/u).optional(),
  change_key: z.string().min(1).max(160).optional()
}).strict();

export const remoteSyncErrorCodeSchema = frozenStringEnumSchema([
  "ARCHIVE_HASH_MISMATCH",
  "ARCHIVE_PACKAGE_INVALID",
  "ARCHIVE_PACKAGE_CONFLICT",
  "ARCHIVE_RECEIPT_MISMATCH",
  "SYNC_CONFLICT_DECISION_REQUIRED",
  "SYNC_CONFLICT_DECISION_INVALID",
  "SYNC_CONTENT_INVALID",
  "SYNC_LEGACY_FIXTURE_INVALID",
  "SYNC_LOCK_UNAVAILABLE",
  "SYNC_PATH_NOT_ELIGIBLE",
  "SYNC_PATH_COLLISION",
  "SYNC_PAGE_LIMIT_INVALID",
  "SYNC_CURSOR_INVALID",
  "SYNC_SNAPSHOT_NOT_FOUND",
  "SYNC_PREVIEW_HASH_MISMATCH",
  "SYNC_PREVIEW_STALE",
  "SYNC_RESTORE_SOURCE_REQUIRED",
  "SYNC_SENSITIVE_CONTENT_BLOCKED",
  "REMOTE_UNAVAILABLE",
  "SYNC_LEASE_INVALID",
  "SYNC_LEASE_EXPIRED",
  "SYNC_LEASE_FENCED",
  "SYNC_LEASE_SCOPE_MISMATCH",
  "SYNC_LEASE_BUSY",
  "SYNC_PREPARE_NOT_FOUND",
  "SYNC_PREPARE_EXPIRED",
  "SYNC_COMMIT_AMBIGUOUS",
  "SYNC_STREAM_INVALID",
  "SYNC_STREAM_TOO_LARGE",
  "SYNC_STREAM_ABORTED",
  "SYNC_PULL_WORKSPACE_FAILED",
  "SYNC_IDEMPOTENCY_CONFLICT"
]);

export const remoteSyncIdempotencyOutcomeSchema = frozenStringEnumSchema([
  "new",
  "replay",
  "conflict"
]);

export const remoteSyncPushStateSchema = frozenStringEnumSchema([
  "prepared",
  "committing",
  "committed",
  "failed",
  "unknown"
]);

export const remoteSyncLeaseSchema = z.object({
  schema_version: correlatedSchemaVersionSchema,
  lease_id: remoteSyncLeaseIdSchema,
  lease_token: remoteSyncLeaseTokenSchema,
  generation: z.number().int().positive(),
  project_id: remoteProjectIdSchema,
  branch_name: remoteBranchNameSchema,
  actor_id: remoteSyncActorIdSchema,
  expires_at: remoteSyncExpirySchema
}).strict();

export const remoteSyncContentChunkSchema = z.object({
  sequence: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  size: z.number().int().nonnegative().max(1024 * 1024),
  chunk_hash: sha256Schema,
  final: z.boolean(),
  // Binary transports may carry the bytes out-of-band; the in-memory
  // reference includes them while JSON-facing adapters can omit this field.
  bytes: z.instanceof(Uint8Array).optional()
}).strict();

export const remoteSyncOperationSchema = z.object({
  path: z.string().min(1),
  source_path: z.string().min(1).optional(),
  content_kind: contentKindSchema,
  action: syncActionSchema,
  local_hash: sha256Schema.optional(),
  remote_hash: sha256Schema.optional(),
  base_hash: sha256Schema.optional()
}).strict().superRefine((value, context) => {
  const target = classifyContentPath({ schema_version: 1, path: value.path });
  const explicitBranchFile = value.content_kind === "branch_file" &&
    "reason_code" in target && target.reason_code === "CONTENT_PATH_UNCLASSIFIED";
  const targetKind = "reason_code" in target ? undefined : target.content_kind;
  const targetScope = "reason_code" in target ? undefined : target.sync_scope;
  if ("reason_code" in target && !explicitBranchFile) {
    context.addIssue({ code: "custom", message: target.reason_code });
    return;
  }
  if (!explicitBranchFile && targetKind !== undefined && value.content_kind !== targetKind) {
    context.addIssue({ code: "custom", message: "content_kind does not match path" });
  }
  if (value.action === "rename") {
    if (value.source_path === undefined) {
      context.addIssue({ code: "custom", message: "rename requires source_path" });
    } else {
      const source = classifyContentPath({ schema_version: 1, path: value.source_path });
      const explicitSourceBranchFile = explicitBranchFile && "reason_code" in source &&
        source.reason_code === "CONTENT_PATH_UNCLASSIFIED";
      const sourceReason = "reason_code" in source ? source.reason_code : undefined;
      const sourceKind = "reason_code" in source ? undefined : source.content_kind;
      const sourceScope = "reason_code" in source ? undefined : source.sync_scope;
      if ((!explicitSourceBranchFile && sourceReason !== undefined) ||
          (!explicitBranchFile && sourceKind !== targetKind) ||
          (!explicitSourceBranchFile && !explicitBranchFile && sourceScope !== targetScope)) {
        context.addIssue({ code: "custom", message: "rename paths must share a sync scope" });
      }
    }
  } else if (value.source_path !== undefined) {
    context.addIssue({ code: "custom", message: "source_path is only valid for rename" });
  }
});

export const remoteSyncRemoteFileMetadataSchema = z.object({
  path: z.string().min(1),
  content_hash: sha256Schema,
  size: z.number().int().nonnegative(),
  content_kind: contentKindSchema.optional()
}).strict().superRefine((value, context) => {
  const classification = classifyContentPath({ schema_version: 1, path: value.path });
  const explicitBranchFile = value.content_kind === "branch_file" &&
    "reason_code" in classification && classification.reason_code === "CONTENT_PATH_UNCLASSIFIED";
  const classificationKind = "reason_code" in classification ? undefined : classification.content_kind;
  if ("reason_code" in classification && !explicitBranchFile) {
    context.addIssue({ code: "custom", message: classification.reason_code });
  } else if (!explicitBranchFile && classificationKind !== undefined && value.content_kind !== undefined && value.content_kind !== classificationKind) {
    context.addIssue({ code: "custom", message: "content_kind does not match path" });
  }
});

export const remoteSyncRemoteSnapshotSchema = z.object({
  source: remoteSyncSourceRefSchema,
  snapshot_id: z.string().min(1).max(160),
  revision: z.string().min(1),
  project_version: remoteProjectVersionSchema.nullable(),
  commit_sha: remoteCommitShaSchema.nullable(),
  artifact_id: remoteArtifactIdSchema.nullable(),
  manifest_hash: sha256Schema,
  files: z.array(remoteSyncRemoteFileMetadataSchema)
}).strict();

export const remoteSyncPushStatusSchema = z.object({
  source: remoteSyncSourceRefSchema,
  state: remoteSyncPushStateSchema,
  prepare_id: z.string().min(1).max(160),
  idempotency_key: z.string().min(1).max(240),
  payload_hash: sha256Schema,
  receipt: z.unknown().optional()
}).strict();

export const remoteSyncPushStatusQuerySchema = z.object({
  source: remoteSyncSourceRefSchema,
  idempotency_key: z.string().min(1).max(240)
}).strict();

export const remoteSyncPreparedPushSchema = z.object({
  schema_version: correlatedSchemaVersionSchema,
  prepare_id: z.string().min(1).max(160),
  source: remoteSyncSourceRefSchema,
  lease_id: remoteSyncLeaseIdSchema,
  lease_token: remoteSyncLeaseTokenSchema,
  lease_generation: z.number().int().positive(),
  expected_revision: z.string().min(1),
  preview_hash: sha256Schema,
  idempotency_key: z.string().min(1).max(240),
  payload_hash: sha256Schema,
  state: frozenStringLiteralSchema("prepared"),
  expires_at: remoteSyncExpirySchema
}).strict();

export const remoteSyncPushCommitSchema = z.object({
  prepare_id: z.string().min(1).max(160),
  lease: remoteSyncLeaseSchema,
  idempotency_key: z.string().min(1).max(240),
  payload_hash: sha256Schema
}).strict();

export const remoteSyncPullRequestSchema = z.object({
  source: remoteSyncSourceRefSchema,
  actor_id: remoteSyncActorIdSchema,
  idempotency_key: z.string().min(1).max(240),
  payload_hash: sha256Schema.optional()
}).strict();

export const remoteSyncPullReceiptSchema = z.object({
  schema_version: correlatedSchemaVersionSchema,
  source: remoteSyncSourceRefSchema,
  idempotency_key: z.string().min(1).max(240),
  payload_hash: sha256Schema,
  remote_revision: z.string().min(1),
  local_transaction: frozenStringLiteralSchema("committed"),
  commit_sha: remoteCommitShaSchema.nullable(),
  artifact_id: remoteArtifactIdSchema.nullable(),
  manifest_hash: sha256Schema,
  project_version: z.string().regex(/^pv_/u).nullable(),
  no_changes: z.boolean(),
  applied: z.array(remoteSyncOperationSchema).max(100_000),
  skipped: z.array(remoteSyncOperationSchema).max(100_000),
  retryable: z.array(remoteSyncOperationSchema).max(100_000)
}).strict();

export const candidateProvenanceSchema = z.object({
  source_kind: candidateProvenanceSourceKindSchema,
  source_ref: z.string().min(1),
  producer: z.string().min(1),
  producer_version: z.string().min(1),
  created_at: rfc3339DateTimeSchema
}).strict();

const candidateIdSchema = (namespace: "kc" | "pcc") => z.string()
  .regex(new RegExp(`^${namespace}_[A-Za-z0-9][A-Za-z0-9_-]{0,155}$`, "u"));

const candidateCommonFields = {
  schema_version: schemaVersionSchema,
  source_change_key: z.string().min(1).max(160),
  content_hash: sha256Schema,
  confidence: z.number().min(0).max(1),
  provenance: candidateProvenanceSchema
};

export const projectContentCandidateSchema = z.object({
  ...candidateCommonFields,
  candidate_id: candidateIdSchema("pcc"),
  candidate_type: projectContentCandidateTypeSchema,
  evidence_refs: z.array(z.string().min(1)),
  rationale: z.string().min(1),
  proposed_content: z.string().min(1),
  status: projectContentCandidateStatusSchema
}).strict();

export const knowledgeCandidateSchema = z.object({
  ...candidateCommonFields,
  candidate_id: candidateIdSchema("kc"),
  source_refs: z.array(z.string().min(1)),
  summary: z.string().min(1),
  reusability_scope: z.string().min(1),
  status: knowledgeCandidateStatusSchema,
  // 入库投影所需、reusability_scope 无法映射的三个字段。可选：老归档不带
  // 它们时整条候选仍然有效，由消费端走降级路径。
  entry_type: knowledgeCandidateEntryTypeSchema.optional(),
  body: z.string().min(1).max(20_000).optional(),
  keywords: z.array(z.string().min(1).max(80)).max(32).optional()
}).strict();

export const contentSyncValidationReasonCodeSchema = frozenStringEnumSchema([
  "CONTENT_SYNC_ENUM_INVALID",
  "CONTENT_SYNC_UNKNOWN_FIELD",
  "CONTENT_SYNC_SCHEMA_INVALID"
]);

function validationIssueParam(issue: z.ZodIssue, name: string): unknown {
  if (issue.code !== "custom" || issue.params === undefined) return undefined;
  return issue.params[name] as unknown;
}

function taggedValidationReasonCode(
  issue: z.ZodIssue
): ContentSyncValidationReasonCode | undefined {
  const reasonCode = validationIssueParam(issue, validationReasonCodeParam);
  if (reasonCode === "CONTENT_SYNC_ENUM_INVALID" ||
      reasonCode === "CONTENT_SYNC_UNKNOWN_FIELD" ||
      reasonCode === "CONTENT_SYNC_SCHEMA_INVALID") {
    return reasonCode;
  }
  return undefined;
}

export const contentPathReasonCodeSchema = frozenStringEnumSchema([
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

export const contentPathClassificationInputSchema = z.object({
  schema_version: schemaVersionSchema,
  path: z.string(),
  selected_instruction_entrypoints: z.array(instructionEntrypointSchema)
    .max(maxSelectedInstructionEntrypoints)
    .optional(),
  source_kind: frozenStringLiteralSchema("branch_file").optional()
}).strict();

const contentPathClassificationSuccessValueSchema = z.union([
  z.object({
    schema_version: correlatedSchemaVersionSchema,
    content_kind: correlatedStringLiteralSchema("config"),
    sync_scope: correlatedStringLiteralSchema("config"),
    pull_policy: correlatedStringLiteralSchema("regular"),
    content_scan_policy: correlatedStringLiteralSchema("skip_content_scan")
  }).strict(),
  z.object({
    schema_version: correlatedSchemaVersionSchema,
    content_kind: correlatedStringLiteralSchema("rule"),
    sync_scope: correlatedStringLiteralSchema("rules"),
    pull_policy: correlatedStringLiteralSchema("regular"),
    content_scan_policy: correlatedStringLiteralSchema("required")
  }).strict(),
  z.object({
    schema_version: correlatedSchemaVersionSchema,
    content_kind: correlatedStringLiteralSchema("architecture"),
    sync_scope: correlatedStringLiteralSchema("architecture"),
    pull_policy: correlatedStringLiteralSchema("regular"),
    content_scan_policy: correlatedStringLiteralSchema("required")
  }).strict(),
  z.object({
    schema_version: correlatedSchemaVersionSchema,
    content_kind: correlatedStringLiteralSchema("instruction"),
    sync_scope: correlatedStringLiteralSchema("instructions"),
    pull_policy: correlatedStringLiteralSchema("regular"),
    content_scan_policy: correlatedStringLiteralSchema("required")
  }).strict(),
  z.object({
    schema_version: correlatedSchemaVersionSchema,
    content_kind: correlatedStringLiteralSchema("branch_file"),
    sync_scope: correlatedStringLiteralSchema("branch_files"),
    pull_policy: correlatedStringLiteralSchema("explicit_source_only"),
    content_scan_policy: correlatedStringLiteralSchema("required")
  }).strict()
]);

export const contentPathClassificationSuccessSchema = z.object({
  schema_version: schemaVersionSchema,
  content_kind: contentKindSchema,
  sync_scope: syncScopeSchema,
  pull_policy: pullPolicySchema,
  content_scan_policy: contentScanPolicySchema
}).strict().pipe(contentPathClassificationSuccessValueSchema);

export const contentPathClassificationFailureSchema = z.object({
  schema_version: schemaVersionSchema,
  reason_code: z.union([
    contentPathReasonCodeSchema,
    contentSyncValidationReasonCodeSchema
  ])
}).strict();

export const contentPathClassificationResultSchema = z.union([
  contentPathClassificationSuccessSchema,
  contentPathClassificationFailureSchema
]);

const classificationSuccessKeys = new Set([
  "schema_version",
  "content_kind",
  "sync_scope",
  "pull_policy",
  "content_scan_policy"
]);
const classificationFailureKeys = new Set([
  "schema_version",
  "reason_code"
]);
const classificationInputKeys = new Set([
  "schema_version",
  "path",
  "selected_instruction_entrypoints",
  "source_kind"
]);

function hasTaggedValidationReason(
  issues: readonly z.ZodIssue[],
  reasonCode: ContentSyncValidationReasonCode
): boolean {
  for (const issue of issues) {
    if (taggedValidationReasonCode(issue) === reasonCode) return true;
    if (issue.code === "invalid_union" &&
        issue.errors.some((branch) => hasTaggedValidationReason(branch, reasonCode))) {
      return true;
    }
    if ((issue.code === "invalid_key" || issue.code === "invalid_element") &&
        hasTaggedValidationReason(issue.issues, reasonCode)) {
      return true;
    }
  }
  return false;
}

function hasUnknownFieldIssue(issues: readonly z.ZodIssue[]): boolean {
  for (const issue of issues) {
    if (issue.code === "unrecognized_keys") return true;
    if (issue.code === "invalid_union" &&
        issue.errors.some((branch) => hasUnknownFieldIssue(branch))) {
      return true;
    }
    if ((issue.code === "invalid_key" || issue.code === "invalid_element") &&
        hasUnknownFieldIssue(issue.issues)) {
      return true;
    }
  }
  return false;
}

function validationReasonFromDomainIssues(
  issues: readonly z.ZodIssue[]
): ContentSyncValidationReasonCode {
  if (hasUnknownFieldIssue(issues)) {
    return "CONTENT_SYNC_UNKNOWN_FIELD";
  }
  if (hasTaggedValidationReason(issues, "CONTENT_SYNC_ENUM_INVALID")) {
    return "CONTENT_SYNC_ENUM_INVALID";
  }
  return "CONTENT_SYNC_SCHEMA_INVALID";
}

type ExternalRecordSnapshot =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false };

type ExternalArraySnapshot =
  | { ok: true; value: unknown[] }
  | { ok: false };

function snapshotExternalRecord(input: unknown): ExternalRecordSnapshot {
  if (input === null || typeof input !== "object") return { ok: false };
  try {
    if (Array.isArray(input)) return { ok: false };
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== "string") continue;
      const descriptor = Reflect.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined) return { ok: false };
      if (!descriptor.enumerable) continue;
      if (!("value" in descriptor)) return { ok: false };
      Reflect.defineProperty(snapshot, key, {
        configurable: true,
        enumerable: true,
        value: descriptor.value,
        writable: true
      });
    }
    return { ok: true, value: snapshot };
  } catch {
    return { ok: false };
  }
}

function isBoundedArchiveIngestJsonValue(
  input: unknown,
  depth = 0,
  budget = { remaining: 128 }
): boolean {
  if (input === null || typeof input === "string" || typeof input === "boolean" ||
      (typeof input === "number" && Number.isFinite(input))) {
    return true;
  }
  if (typeof input !== "object" || depth > 4 || budget.remaining <= 0) return false;
  if (Array.isArray(input)) {
    if (input.length > 32) return false;
    for (const value of input) {
      budget.remaining -= 1;
      if (!isBoundedArchiveIngestJsonValue(value, depth + 1, budget)) return false;
    }
    return true;
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length > 32) return false;
  for (const key of keys) {
    budget.remaining -= 1;
    if (!isBoundedArchiveIngestJsonValue(record[key], depth + 1, budget)) return false;
  }
  return true;
}

export function readArchiveIngestReceipt(
  input: unknown
): ArchiveIngestReceiptReadResult {
  if (typeof input !== "string" || input.length > 65_536) {
    return { ok: false, reason_code: "ARCHIVE_INGEST_RECEIPT_JSON_INVALID" };
  }
  let external: unknown;
  try {
    external = JSON.parse(input) as unknown;
  } catch {
    return { ok: false, reason_code: "ARCHIVE_INGEST_RECEIPT_JSON_INVALID" };
  }
  if (!isBoundedArchiveIngestJsonValue(external) || external === null ||
      typeof external !== "object" || Array.isArray(external)) {
    return { ok: false, reason_code: "ARCHIVE_INGEST_RECEIPT_SCHEMA_INVALID" };
  }
  const root = external as Record<string, unknown>;
  if (Object.hasOwn(root, "schema_version") && root.schema_version !== 1) {
    return { ok: false, reason_code: "ARCHIVE_INGEST_RECEIPT_VERSION_UNSUPPORTED" };
  }
  const parsed = archiveIngestReceiptSchema.safeParse(root);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason_code: "ARCHIVE_INGEST_RECEIPT_SCHEMA_INVALID" };
}

function snapshotExternalArray(input: unknown): ExternalArraySnapshot {
  try {
    if (!Array.isArray(input)) return { ok: false };
    const lengthDescriptor = Reflect.getOwnPropertyDescriptor(input, "length");
    if (lengthDescriptor === undefined || !("value" in lengthDescriptor) ||
        typeof lengthDescriptor.value !== "number" ||
        !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
      return { ok: false };
    }
    const length = lengthDescriptor.value;
    if (length > maxSelectedInstructionEntrypoints) return { ok: false };
    const keys = Reflect.ownKeys(input);
    if (length > keys.length) return { ok: false };
    const values = new Map<number, unknown>();
    for (const key of keys) {
      if (typeof key !== "string" || key === "length") continue;
      const descriptor = Reflect.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined) return { ok: false };
      if (!descriptor.enumerable) continue;
      if (!("value" in descriptor)) return { ok: false };
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index < 0 || index >= length ||
          String(index) !== key) {
        return { ok: false };
      }
      values.set(index, descriptor.value);
    }
    if (values.size !== length) return { ok: false };
    const snapshot = new Array<unknown>(length);
    for (const [index, value] of values) snapshot[index] = value;
    return { ok: true, value: snapshot };
  } catch {
    return { ok: false };
  }
}

function hasUnknownOwnKey(
  input: Readonly<Record<string, unknown>>,
  allowedKeys: ReadonlySet<string>
): boolean {
  return Object.keys(input).some((key) => !allowedKeys.has(key));
}

function hasMissingOrNonStringField(
  input: Readonly<Record<string, unknown>>,
  fields: readonly string[]
): boolean {
  return fields.some((field) =>
    !Object.hasOwn(input, field) || typeof input[field] !== "string"
  );
}

export function validateContentPathClassificationResult(
  input: unknown
): ContentPathClassificationValidationResult {
  const snapshot = snapshotExternalRecord(input);
  if (!snapshot.ok) {
    return { ok: false, reason_code: "CONTENT_SYNC_SCHEMA_INVALID" };
  }
  const ownInput = snapshot.value;
  if (!Object.hasOwn(ownInput, "schema_version")) {
    return { ok: false, reason_code: "CONTENT_SYNC_SCHEMA_INVALID" };
  }
  const schemaVersion = ownInput.schema_version;
  if (typeof schemaVersion !== "number" || schemaVersion !== 1) {
    return { ok: false, reason_code: "CONTENT_SYNC_SCHEMA_INVALID" };
  }
  const hasContentKind = Object.hasOwn(ownInput, "content_kind");
  const hasReasonCode = Object.hasOwn(ownInput, "reason_code");
  if (hasContentKind && hasReasonCode) {
    return { ok: false, reason_code: "CONTENT_SYNC_UNKNOWN_FIELD" };
  }
  if (!hasContentKind && !hasReasonCode) {
    return { ok: false, reason_code: "CONTENT_SYNC_SCHEMA_INVALID" };
  }
  const allowedKeys = hasContentKind
    ? classificationSuccessKeys
    : classificationFailureKeys;
  if (hasUnknownOwnKey(ownInput, allowedKeys)) {
    return { ok: false, reason_code: "CONTENT_SYNC_UNKNOWN_FIELD" };
  }
  const stringFields = hasContentKind
    ? ["content_kind", "sync_scope", "pull_policy", "content_scan_policy"]
    : ["reason_code"];
  if (hasMissingOrNonStringField(ownInput, stringFields)) {
    return { ok: false, reason_code: "CONTENT_SYNC_SCHEMA_INVALID" };
  }
  const rootSchema = hasContentKind
    ? contentPathClassificationSuccessSchema
    : contentPathClassificationFailureSchema;
  const parsed = rootSchema.safeParse(ownInput);
  if (!parsed.success) {
    return {
      ok: false,
      reason_code: validationReasonFromDomainIssues(parsed.error.issues)
    };
  }
  return { ok: true, value: parsed.data };
}

const runtimePathPrefixes = [
  ".harness/runtime",
  ".harness/lease",
  ".harness/leases",
  ".harness/lock",
  ".harness/locks",
  ".harness/cache",
  ".harness/caches",
  ".harness/tmp",
  ".harness/temp",
  ".harness/log",
  ".harness/logs",
  ".cache"
] as const;

const nonScannablePathPrefixes = [
  ".harness/archive",
  ".harness/archives",
  ".harness/change",
  ".harness/changes",
  ".harness/knowledge",
  ".harness/candidates",
  ".harness/knowledge-candidates",
  ".harness/project-content-candidates"
] as const;

// 归档目录整体是 non-scannable（体积大、多为过程产物），但其中的交付物是要在
// 「分支文件」视图里展示的正式文档，按目录段分组为 PLAN / SPEC / REPORT / DOCS。
//
// reports/ 只取 final/ 的定稿：review/ 与 test/ 是过程产物。这条边界与归档 ZIP
// 的包内容边界一致（见 harness-knowledge-ingest/SKILL.md：测试报告、审查报告
// 不得进入归档包），两条通道不各说各话。
const archiveDeliverableGroups = ["plans", "spec", "docs"] as const;
const archiveReportsGroup = "reports";
const archiveReportsDeliverable = "final";
const archiveRoot = ".harness/archive";

function archiveRelativeSegments(path: string): readonly string[] | undefined {
  const lower = path.toLowerCase();
  if (!isAtOrBelow(lower, archiveRoot)) return undefined;
  const segments = lower.split("/");
  if (segments.some((segment) => segment.length === 0)) return undefined;
  return segments;
}

/**
 * 交付物文档：`.harness/archive/<change-key>/{plans|spec|docs}/**` 以及
 * `.harness/archive/<change-key>/reports/final/**` 下的具体文件。
 * 变更目录名不得以 `.` 开头（排除 `.publication-staging` 之类的暂存目录）。
 */
function isArchiveDeliverableDocument(path: string): boolean {
  const segments = archiveRelativeSegments(path);
  // .harness / archive / <change-key> / <group> / <file...>
  if (segments === undefined || segments.length < 5) return false;
  const changeKey = segments[2] ?? "";
  const group = segments[3] ?? "";
  if (changeKey.startsWith(".")) return false;
  if (archiveDeliverableGroups.some((value) => value === group)) return true;
  // reports/ 再深一层：只有 final/ 下的文件算定稿，散落在 reports/ 根下的不算。
  return group === archiveReportsGroup && segments.length >= 6 &&
    segments[4] === archiveReportsDeliverable;
}

/**
 * 目录是否可能包含交付物文档——工作区遍历据此决定是否下钻。
 * 归档根、变更目录、分组目录及其子目录都要放行，否则遍历在 `.harness/archive`
 * 一层就被剪枝，交付物永远走不到分类这一步。
 *
 * `reports/` 本身必须放行（否则到不了 `final/`），但 `reports/review`、
 * `reports/test` 这类过程子目录直接剪掉，省掉整棵子树的遍历开销。
 */
export function mayContainArchiveDeliverables(path: string): boolean {
  const segments = archiveRelativeSegments(path);
  if (segments === undefined) return false;
  if (segments.length <= 2) return true;
  const changeKey = segments[2] ?? "";
  if (changeKey.startsWith(".")) return false;
  if (segments.length === 3) return true;
  const group = segments[3] ?? "";
  if (archiveDeliverableGroups.some((value) => value === group)) return true;
  if (group !== archiveReportsGroup) return false;
  return segments.length === 4 || segments[4] === archiveReportsDeliverable;
}

function isAtOrBelow(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

const maxContentPathLength = 240;
const windowsReservedSegment = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;
const windowsIllegalCharacter = /[<>:"|?*]/u;
const canonicalHarnessPrefixes = [
  "project.yaml",
  "config",
  "rules",
  "codebase",
  "state",
  "runtime",
  "lease",
  "leases",
  "lock",
  "locks",
  "cache",
  "caches",
  "tmp",
  "temp",
  "log",
  "logs",
  "archive",
  "archives",
  "change",
  "changes",
  "knowledge",
  "candidates",
  "knowledge-candidates",
  "project-content-candidates"
] as const;

function hasIllegalWindowsCharacter(segment: string): boolean {
  return windowsIllegalCharacter.test(segment) ||
    Array.from(segment).some((character) => character.charCodeAt(0) <= 31);
}

function hasNonCanonicalCase(path: string): boolean {
  if (!path.includes("/")) {
    const rootEntrypoint = INSTRUCTION_ENTRYPOINTS.find(
      (entrypoint) => entrypoint.toLowerCase() === path.toLowerCase()
    );
    if (rootEntrypoint !== undefined && rootEntrypoint !== path) return true;
  }

  const segments = path.split("/");
  const harnessSegment = segments[0];
  if (harnessSegment?.toLowerCase() !== ".harness") return false;
  if (harnessSegment !== ".harness") return true;

  const namespaceSegment = segments[1];
  if (namespaceSegment === undefined) return false;
  const canonicalNamespace = canonicalHarnessPrefixes.find(
    (prefix) => prefix === namespaceSegment.toLowerCase()
  );
  if (canonicalNamespace !== undefined && namespaceSegment !== canonicalNamespace) return true;
  if (namespaceSegment.toLowerCase().startsWith("credentials.local") &&
      namespaceSegment !== namespaceSegment.toLowerCase()) {
    return true;
  }

  if (namespaceSegment === "codebase") {
    const codebaseSegment = segments[2];
    if (codebaseSegment?.toLowerCase() === "map" && codebaseSegment !== "map") return true;
    if (codebaseSegment?.toLowerCase() === "map-manifest.json" &&
        codebaseSegment !== "map-manifest.json") {
      return true;
    }
  }
  return false;
}

function structuralPathReason(path: string): ContentPathReasonCode | undefined {
  if (path.length === 0) return "CONTENT_PATH_EMPTY";
  if (path.length > maxContentPathLength) return "CONTENT_PATH_TOO_LONG";
  if (path.startsWith("/") || path.startsWith("\\\\") || /^[A-Za-z]:/u.test(path)) {
    return "CONTENT_PATH_ABSOLUTE";
  }
  if (path.includes("\\")) return "CONTENT_PATH_BACKSLASH_AMBIGUOUS";
  const segments = path.split("/");
  if (segments.includes("..")) return "CONTENT_PATH_TRAVERSAL";
  if (segments.some((segment) => segment.length === 0 || segment === ".")) {
    return "CONTENT_PATH_NON_CANONICAL";
  }
  if (segments.some((segment) => windowsReservedSegment.test(segment))) {
    return "CONTENT_PATH_RESERVED_NAME";
  }
  if (segments.some((segment) =>
    segment.endsWith(".") || segment.endsWith(" ") || hasIllegalWindowsCharacter(segment)
  )) {
    return "CONTENT_PATH_ILLEGAL_SEGMENT";
  }
  if (hasNonCanonicalCase(path)) return "CONTENT_PATH_NON_CANONICAL";
  return undefined;
}

function excludedPathReason(path: string): ContentPathReasonCode | undefined {
  const lowerPath = path.toLowerCase();
  const segments = lowerPath.split("/");
  const basename = segments.at(-1) ?? lowerPath;
  if (segments.includes(".git")) {
    return "CONTENT_PATH_VCS_EXCLUDED";
  }
  if (segments.some((segment) =>
    segment === "credentials.local" || segment.startsWith("credentials.local.")
  )) {
    return "CONTENT_PATH_CREDENTIALS_EXCLUDED";
  }
  if (segments.some((segment) => segment.startsWith(".env"))) {
    return "CONTENT_PATH_ENV_EXCLUDED";
  }
  if (isAtOrBelow(lowerPath, ".harness/state")) {
    return "CONTENT_PATH_STATE_EXCLUDED";
  }
  if (runtimePathPrefixes.some((prefix) => isAtOrBelow(lowerPath, prefix)) ||
      /\.(?:log|tmp|temp)$/u.test(basename)) {
    return "CONTENT_PATH_RUNTIME_EXCLUDED";
  }
  // 交付物文档在此放行；上面的 credentials / env / state / runtime / *.log 排除仍然生效，
  // 所以 reports/ 下的日志与暂存物不会因为这道口子被带出去。
  if (nonScannablePathPrefixes.some((prefix) => isAtOrBelow(lowerPath, prefix)) &&
      !isArchiveDeliverableDocument(lowerPath)) {
    return "CONTENT_PATH_NON_SCANNABLE_KIND";
  }
  return undefined;
}

function classificationFailure(
  reasonCode: ContentPathClassificationFailure["reason_code"]
): ContentPathClassificationFailure {
  return contentPathClassificationFailureSchema.parse({
    schema_version: 1,
    reason_code: reasonCode
  });
}

function classificationSuccess(
  contentKind: ContentKind,
  syncScope: SyncScope,
  pullPolicy: PullPolicy,
  contentScanPolicy: ContentScanPolicy
): ContentPathClassificationSuccess {
  return contentPathClassificationSuccessSchema.parse({
    schema_version: 1,
    content_kind: contentKind,
    sync_scope: syncScope,
    pull_policy: pullPolicy,
    content_scan_policy: contentScanPolicy
  });
}

export function classifyContentPath(input: unknown): ContentPathClassificationResult {
  const normalizedInput = typeof input === "string"
    ? { schema_version: 1, path: input }
    : input;
  const snapshot = snapshotExternalRecord(normalizedInput);
  if (!snapshot.ok) return classificationFailure("CONTENT_SYNC_SCHEMA_INVALID");
  const ownInput = snapshot.value;
  if (!Object.hasOwn(ownInput, "schema_version")) {
    return classificationFailure("CONTENT_SYNC_SCHEMA_INVALID");
  }
  const schemaVersion = ownInput.schema_version;
  if (typeof schemaVersion !== "number" || schemaVersion !== 1) {
    return classificationFailure("CONTENT_SYNC_SCHEMA_INVALID");
  }
  if (hasUnknownOwnKey(ownInput, classificationInputKeys)) {
    return classificationFailure("CONTENT_SYNC_UNKNOWN_FIELD");
  }
  if (hasMissingOrNonStringField(ownInput, ["path"]) ||
      (Object.hasOwn(ownInput, "source_kind") &&
        typeof ownInput.source_kind !== "string")) {
    return classificationFailure("CONTENT_SYNC_SCHEMA_INVALID");
  }
  const targetPath = ownInput.path as string;
  const structuralReason = structuralPathReason(targetPath);
  if (structuralReason !== undefined) return classificationFailure(structuralReason);

  const excludedReason = excludedPathReason(targetPath);
  if (excludedReason !== undefined) return classificationFailure(excludedReason);

  if (Object.hasOwn(ownInput, "source_kind") &&
      ownInput.source_kind !== "branch_file") {
    return classificationFailure("CONTENT_SYNC_ENUM_INVALID");
  }
  let selectedSchemaInvalid = false;
  if (Object.hasOwn(ownInput, "selected_instruction_entrypoints")) {
    const selectedSnapshot = snapshotExternalArray(
      ownInput.selected_instruction_entrypoints
    );
    if (!selectedSnapshot.ok) {
      selectedSchemaInvalid = true;
    } else if (selectedSnapshot.value.some(
      (entrypoint) => typeof entrypoint !== "string"
    )) {
      selectedSchemaInvalid = true;
    } else {
      ownInput.selected_instruction_entrypoints = selectedSnapshot.value;
    }
  }
  if (selectedSchemaInvalid) return classificationFailure("CONTENT_SYNC_SCHEMA_INVALID");
  const parsedInput = contentPathClassificationInputSchema.safeParse(ownInput);
  if (!parsedInput.success) {
    const hasSelectedEntrypointIssue = parsedInput.error.issues.some((issue) =>
      issue.path.some((segment) => segment === "selected_instruction_entrypoints")
    );
    if (hasSelectedEntrypointIssue) {
      const primaryIssues = parsedInput.error.issues.filter((issue) =>
        !issue.path.some((segment) => segment === "selected_instruction_entrypoints")
      );
      if (primaryIssues.length > 0) {
        return classificationFailure(validationReasonFromDomainIssues(primaryIssues));
      }
      return classificationFailure("CONTENT_PATH_SELECTED_ENTRYPOINT_INVALID");
    }
    return classificationFailure(validationReasonFromDomainIssues(parsedInput.error.issues));
  }

  const selectedEntrypoints = parsedInput.data.selected_instruction_entrypoints ?? [];

  if (parsedInput.data.path === ".harness/project.yaml" ||
      parsedInput.data.path.startsWith(".harness/config/")) {
    return classificationSuccess("config", "config", "regular", "skip_content_scan");
  }
  if (parsedInput.data.path.startsWith(".harness/rules/")) {
    return classificationSuccess("rule", "rules", "regular", "required");
  }
  if (parsedInput.data.path === ".harness/codebase/map-manifest.json" ||
      parsedInput.data.path.startsWith(".harness/codebase/map/")) {
    return classificationSuccess("architecture", "architecture", "regular", "required");
  }
  if (parsedInput.data.path === "AGENTS.md" ||
      selectedEntrypoints.some((entrypoint) => entrypoint === parsedInput.data.path)) {
    return classificationSuccess("instruction", "instructions", "regular", "required");
  }
  // 归档交付物按 branch_file 入库，供「分支文件」视图展示；其余归档内容仍是未申报路径。
  if (isArchiveDeliverableDocument(parsedInput.data.path)) {
    return classificationSuccess("branch_file", "branch_files", "explicit_source_only", "required");
  }
  if (isAtOrBelow(parsedInput.data.path, ".harness")) {
    return classificationFailure("CONTENT_PATH_UNDECLARED");
  }
  if (parsedInput.data.source_kind === "branch_file") {
    return classificationSuccess(
      "branch_file",
      "branch_files",
      "explicit_source_only",
      "required"
    );
  }
  return classificationFailure("CONTENT_PATH_UNCLASSIFIED");
}

export const legacyArchivePackageReceiptSchema = z.object({
  schema_version: schemaVersionSchema,
  archive_id: z.string().regex(/^arc_/u),
  project_id: z.string().regex(/^prj_/u),
  change_key: z.string(),
  package_sha256: sha256Schema,
  manifest_sha256: sha256Schema,
  artifact_id: z.string().nullable(),
  archive_status: frozenStringLiteralSchema("durable"),
  knowledge_status: frozenStringEnumSchema(["indexing", "ready", "failed"]),
  stored_files: z.number().nonnegative().refine(Number.isInteger),
  uploaded_at: rfc3339DateTimeSchema,
  request_id: z.string().regex(
    /^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu
  )
}).strict();

const legacyArchiveStatusCompatibilitySchema = z.object({
  availability: frozenStringLiteralSchema("available"),
  value: archiveStatusSchema
}).strict();

const legacyChangeIndexStatusUnavailableSchema = z.object({
  availability: frozenStringLiteralSchema("unavailable"),
  reason_code: frozenStringLiteralSchema("LEGACY_CHANGE_INDEX_STATUS_UNAVAILABLE")
}).strict();

const legacyKnowledgeExtractionStatusUnavailableSchema = z.object({
  availability: frozenStringLiteralSchema("unavailable"),
  reason_code: frozenStringLiteralSchema(
    "LEGACY_KNOWLEDGE_EXTRACTION_STATUS_UNAVAILABLE"
  )
}).strict();

const legacyManagedSnapshotStatusUnavailableSchema = z.object({
  availability: frozenStringLiteralSchema("unavailable"),
  reason_code: frozenStringLiteralSchema("LEGACY_MANAGED_SNAPSHOT_STATUS_UNAVAILABLE")
}).strict();

export const legacyArchiveCompatibilityResultSchema = z.object({
  schema_version: schemaVersionSchema,
  source_format: frozenStringLiteralSchema("legacy_archive_package_receipt"),
  complete_v1_statuses: incompleteV1StatusesSchema,
  archive_status: legacyArchiveStatusCompatibilitySchema,
  change_index_status: legacyChangeIndexStatusUnavailableSchema,
  knowledge_extraction_status: legacyKnowledgeExtractionStatusUnavailableSchema,
  managed_snapshot_status: legacyManagedSnapshotStatusUnavailableSchema
}).strict();

export function getLegacyArchiveCompatibilityResult(
  input: unknown
): LegacyArchiveCompatibilityResult {
  const receipt = legacyArchivePackageReceiptSchema.parse(input);
  return legacyArchiveCompatibilityResultSchema.parse({
    schema_version: 1,
    source_format: "legacy_archive_package_receipt",
    complete_v1_statuses: false,
    archive_status: {
      availability: "available",
      value: {
        status: "stored",
        updated_at: receipt.uploaded_at,
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
  });
}

export type ContentKind = z.infer<typeof contentKindSchema>;
export type ArchiveIngestReceipt = z.infer<typeof archiveIngestReceiptSchema>;
export type ArchiveIngestReceiptReadReasonCode =
  | "ARCHIVE_INGEST_RECEIPT_JSON_INVALID"
  | "ARCHIVE_INGEST_RECEIPT_SCHEMA_INVALID"
  | "ARCHIVE_INGEST_RECEIPT_VERSION_UNSUPPORTED";
export type ArchiveIngestReceiptReadResult =
  | { ok: true; value: ArchiveIngestReceipt }
  | { ok: false; reason_code: ArchiveIngestReceiptReadReasonCode };
export type SyncScope = z.infer<typeof syncScopeSchema>;
export type SyncDirection = z.infer<typeof syncDirectionSchema>;
export type SyncAction = z.infer<typeof syncActionSchema>;
export type ConflictResolution = z.infer<typeof conflictResolutionSchema>;
export type ProjectContentCandidateType = z.infer<typeof projectContentCandidateTypeSchema>;
export type ProjectContentCandidateStatus = z.infer<typeof projectContentCandidateStatusSchema>;
export type KnowledgeCandidateStatus = z.infer<typeof knowledgeCandidateStatusSchema>;
export type KnowledgeCandidateEntryType = z.infer<
  typeof knowledgeCandidateEntryTypeSchema
>;
export type CandidateProvenanceSourceKind = z.infer<
  typeof candidateProvenanceSourceKindSchema
>;
export type InstructionEntrypoint = z.infer<typeof instructionEntrypointSchema>;
export type ArchiveStatusValue = z.infer<typeof archiveStatusValueSchema>;
export type ChangeIndexStatusValue = z.infer<typeof changeIndexStatusValueSchema>;
export type KnowledgeExtractionStatusValue = z.infer<
  typeof knowledgeExtractionStatusValueSchema
>;
export type ManagedSnapshotStatusValue = z.infer<typeof managedSnapshotStatusValueSchema>;
export type PullPolicy = z.infer<typeof pullPolicySchema>;
export type ContentScanPolicy = z.infer<typeof contentScanPolicySchema>;
export type ArchiveStatus = z.infer<typeof archiveStatusSchema>;
export type ChangeIndexStatus = z.infer<typeof changeIndexStatusSchema>;
export type KnowledgeExtractionStatus = z.infer<typeof knowledgeExtractionStatusSchema>;
export type ManagedSnapshotStatus = z.infer<typeof managedSnapshotStatusSchema>;
export type ContentSyncStatuses = z.infer<typeof contentSyncStatusesSchema>;
export type RemoteVersionIdentity = z.infer<typeof remoteVersionIdentitySchema>;
export type BranchSnapshot = z.infer<typeof branchSnapshotSchema>;
export type SnapshotVersion = z.infer<typeof snapshotVersionSchema>;
export type SnapshotFile = z.infer<typeof snapshotFileSchema>;
export type BranchSnapshotPage = z.infer<typeof branchSnapshotPageSchema>;
export type SnapshotVersionPage = z.infer<typeof snapshotVersionPageSchema>;
export type SnapshotFilePage = z.infer<typeof snapshotFilePageSchema>;
export type RemoteSyncErrorCode = z.infer<typeof remoteSyncErrorCodeSchema>;
export type RemoteSyncIdempotencyOutcome = z.infer<
  typeof remoteSyncIdempotencyOutcomeSchema
>;
export type RemoteSyncPushState = z.infer<typeof remoteSyncPushStateSchema>;
export type RemoteSyncSourceRef = z.infer<typeof remoteSyncSourceRefSchema>;
export type RemoteSyncLease = z.infer<typeof remoteSyncLeaseSchema>;
export type RemoteSyncContentChunk = z.infer<typeof remoteSyncContentChunkSchema>;
export type RemoteSyncOperation = z.infer<typeof remoteSyncOperationSchema>;
export type RemoteSyncRemoteFileMetadata = z.infer<typeof remoteSyncRemoteFileMetadataSchema>;
export type RemoteSyncRemoteSnapshot = z.infer<typeof remoteSyncRemoteSnapshotSchema>;
export type RemoteSyncPushStatus = z.infer<typeof remoteSyncPushStatusSchema>;
export type RemoteSyncPushStatusQuery = z.infer<typeof remoteSyncPushStatusQuerySchema>;
export type RemoteSyncPreparedPush = z.infer<typeof remoteSyncPreparedPushSchema>;
export type RemoteSyncPushCommit = z.infer<typeof remoteSyncPushCommitSchema>;
export type RemoteSyncPullRequest = z.infer<typeof remoteSyncPullRequestSchema>;
export type RemoteSyncPullReceipt = z.infer<typeof remoteSyncPullReceiptSchema>;
export type CandidateProvenance = z.infer<typeof candidateProvenanceSchema>;
export type ProjectContentCandidate = z.infer<typeof projectContentCandidateSchema>;
export type KnowledgeCandidate = z.infer<typeof knowledgeCandidateSchema>;
export type ContentSyncValidationReasonCode = z.infer<
  typeof contentSyncValidationReasonCodeSchema
>;
export type ContentPathReasonCode = z.infer<typeof contentPathReasonCodeSchema>;
export type ContentPathClassificationInput = z.infer<
  typeof contentPathClassificationInputSchema
>;
export type ContentPathClassificationSuccess = z.infer<
  typeof contentPathClassificationSuccessSchema
>;
export type ContentPathClassificationFailure = z.infer<
  typeof contentPathClassificationFailureSchema
>;
export type ContentPathClassificationResult = z.infer<
  typeof contentPathClassificationResultSchema
>;
export type ContentPathClassificationValidationResult =
  | { ok: true; value: ContentPathClassificationResult }
  | { ok: false; reason_code: ContentSyncValidationReasonCode };
export type LegacyArchivePackageReceipt = z.infer<
  typeof legacyArchivePackageReceiptSchema
>;
export type LegacyArchiveCompatibilityResult = z.infer<
  typeof legacyArchiveCompatibilityResultSchema
>;
