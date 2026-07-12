import { z } from "zod";

import { sha256Schema } from "./protocol.js";
import {
  npmReleaseRecordSchema,
  registrySemverSchema,
  registrySlugSchema,
  skillCheckResultSchema,
  sourceFileSchema
} from "./registry.js";

export const workflowBundleManifestSchema = z.object({
  schema_version: z.literal(1),
  profile: registrySlugSchema,
  files: z.array(z.object({
    path: z.string().min(1),
    sha256: sha256Schema
  }).strict()).min(1)
}).strict();

export const workflowFamilyBundleArtifactSchema = z.object({
  artifact_id: z.string().regex(/^wfb_/),
  family_slug: registrySlugSchema,
  profile: registrySlugSchema,
  version: registrySemverSchema,
  content_sha256: sha256Schema,
  size_bytes: z.number().int().nonnegative(),
  bundle_manifest: workflowBundleManifestSchema,
  created_at: z.iso.datetime()
}).strict();

export const workflowFamilyVersionProfileSchema = z.object({
  profile: registrySlugSchema,
  bundle_manifest: workflowBundleManifestSchema,
  artifact_id: z.string().regex(/^wfb_/),
  sourceFiles: z.array(sourceFileSchema).default([])
}).strict();

export const workflowFamilyVersionSchema = z.object({
  family_slug: registrySlugSchema,
  version: registrySemverSchema,
  profiles: z.array(workflowFamilyVersionProfileSchema).min(1),
  artifacts: z.array(workflowFamilyBundleArtifactSchema),
  changeNote: z.string().nullable(),
  created_at: z.iso.datetime()
}).strict();

export const workflowFamilyDraftProfileSchema = z.object({
  profile: registrySlugSchema,
  sourceFiles: z.array(sourceFileSchema),
  bundle_manifest: workflowBundleManifestSchema
}).strict();

export const workflowFamilyDraftStateSchema = z.object({
  family_slug: registrySlugSchema,
  profiles: z.array(workflowFamilyDraftProfileSchema),
  required_profiles: z.array(registrySlugSchema),
  draftVersion: registrySemverSchema.nullable(),
  checks: skillCheckResultSchema.nullable(),
  releaseNote: z.string().nullable(),
  revision: z.number().int(),
  created_at: z.string(),
  updated_at: z.string()
}).strict();

export const workflowFamilySchema = z.object({
  family_id: z.string().regex(/^wff_/),
  slug: registrySlugSchema,
  displayName: z.string().min(1).max(120),
  description: z.string().min(1).max(1000),
  tags: z.array(registrySlugSchema).default([]),
  latest_version: registrySemverSchema.nullable(),
  required_profiles: z.array(registrySlugSchema).min(1),
  revision: z.number().int().positive(),
  npmReleases: z.array(npmReleaseRecordSchema).optional().default([]),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime()
}).strict();

export const workflowFamilyMutationSchema = z.object({
  slug: registrySlugSchema,
  displayName: z.string().min(1).max(120),
  description: z.string().min(1).max(1000),
  tags: z.array(registrySlugSchema).default([]),
  required_profiles: z.array(registrySlugSchema).min(1)
}).strict();

export const publishWorkflowFamilyRequestSchema = z.object({
  version: registrySemverSchema,
  releaseNote: z.string().optional()
}).strict();

export const registryProjectWorkflowBindingSchema = z.object({
  project_id: z.string().regex(/^prj_/),
  family_slug: registrySlugSchema,
  profile: registrySlugSchema,
  version: registrySemverSchema.nullable().optional(),
  revision: z.number().int().positive(),
  updated_at: z.iso.datetime()
}).strict();

export const bindProjectWorkflowFamilyRequestSchema = z.object({
  schema_version: z.literal(1),
  family_slug: registrySlugSchema,
  profile: registrySlugSchema,
  version: registrySemverSchema.nullable().optional(),
  revision: z.number().int().nullable()
}).strict();

export type WorkflowBundleManifest = z.infer<typeof workflowBundleManifestSchema>;
export type WorkflowFamilyBundleArtifact = z.infer<typeof workflowFamilyBundleArtifactSchema>;
export type WorkflowFamilyVersionProfile = z.infer<typeof workflowFamilyVersionProfileSchema>;
export type WorkflowFamilyVersion = z.infer<typeof workflowFamilyVersionSchema>;
export type WorkflowFamilyDraftProfile = z.infer<typeof workflowFamilyDraftProfileSchema>;
export type WorkflowFamilyDraftState = z.infer<typeof workflowFamilyDraftStateSchema>;
export type WorkflowFamily = z.infer<typeof workflowFamilySchema>;
export type WorkflowFamilyMutation = z.infer<typeof workflowFamilyMutationSchema>;
export type PublishWorkflowFamilyRequest = z.infer<typeof publishWorkflowFamilyRequestSchema>;
export type RegistryProjectWorkflowBinding = z.infer<typeof registryProjectWorkflowBindingSchema>;
export type BindProjectWorkflowFamilyRequest = z.infer<typeof bindProjectWorkflowFamilyRequestSchema>;
