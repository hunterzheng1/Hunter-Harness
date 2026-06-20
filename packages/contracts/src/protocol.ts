import { z } from "zod";

import { fileKindSchema } from "./file-policy.js";

export const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const relativePathSchema = z.string().min(1).refine(
  (path) => !path.startsWith("/") && !path.startsWith("\\") && !/^[A-Za-z]:/.test(path),
  "path must be relative"
);

const commonFileFields = {
  file_kind: fileKindSchema
};

export const addOperationSchema = z.object({
  ...commonFileFields,
  operation: z.literal("add"),
  path: relativePathSchema,
  content_sha256: sha256Schema,
  size_bytes: z.number().int().nonnegative()
}).strict();

export const modifyOperationSchema = z.object({
  ...commonFileFields,
  operation: z.literal("modify"),
  path: relativePathSchema,
  base_content_sha256: sha256Schema,
  content_sha256: sha256Schema,
  size_bytes: z.number().int().nonnegative()
}).strict();

export const deleteOperationSchema = z.object({
  ...commonFileFields,
  operation: z.literal("delete"),
  path: relativePathSchema,
  base_content_sha256: sha256Schema,
  tombstone: z.object({
    deleted_at: z.iso.datetime(),
    reason: z.string().min(1),
    previous_sha256: sha256Schema
  }).strict()
}).strict();

export const renameOperationSchema = z.object({
  ...commonFileFields,
  operation: z.literal("rename"),
  from_path: relativePathSchema,
  to_path: relativePathSchema,
  base_content_sha256: sha256Schema,
  content_sha256: sha256Schema,
  size_bytes: z.number().int().nonnegative()
}).strict();

export const fileOperationSchema = z.discriminatedUnion("operation", [
  addOperationSchema,
  modifyOperationSchema,
  deleteOperationSchema,
  renameOperationSchema
]);

export const artifactManifestSchema = z.object({
  schema_version: z.literal(1),
  project_id: z.string().regex(/^prj_/),
  project_version: z.string().regex(/^pv_/).nullable(),
  artifact_id: z.string().regex(/^art_/),
  files: z.array(fileOperationSchema),
  manifest_sha256: sha256Schema
}).strict();

export const baselineFileSchema = z.object({
  baseline_hash: sha256Schema.nullable(),
  local_hash_at_apply: sha256Schema.nullable(),
  file_kind: fileKindSchema,
  adapter: z.string().optional(),
  canonical_target: z.string().optional(),
  managed_block_hash: sha256Schema.optional(),
  last_applied_version: z.string().nullable(),
  deleted: z.boolean()
}).strict();

export const baselineManifestSchema = z.object({
  schema_version: z.literal(1),
  project_id: z.string().regex(/^prj_/).nullable(),
  complete_project_version: z.string().regex(/^pv_/).nullable(),
  artifact_manifest_hash: sha256Schema.nullable(),
  files: z.record(z.string(), baselineFileSchema)
}).strict();

export const requestMetadataSchema = z.object({
  request_id: z.uuid(),
  idempotency_key: z.uuid(),
  project_id: z.string().regex(/^prj_/),
  client_id: z.string().regex(/^cli_/),
  base_project_version: z.string().regex(/^pv_/).nullable(),
  base_manifest_hash: sha256Schema,
  protocol_version: z.literal(1)
}).strict();

export type FileOperation = z.infer<typeof fileOperationSchema>;
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;
export type BaselineManifest = z.infer<typeof baselineManifestSchema>;
