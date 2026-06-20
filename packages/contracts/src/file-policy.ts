import { z } from "zod";

export const fileKindSchema = z.enum([
  "user_editable",
  "generated_reviewable",
  "internal_state",
  "generated_cache",
  "external_unmanaged"
]);

export const editPolicySchema = z.enum([
  "allow",
  "managed-block-only",
  "discourage",
  "protocol-only",
  "external"
]);

export const pushPolicySchema = z.enum([
  "diff-proposal",
  "full-diff-proposal",
  "confirm-before-proposal",
  "never"
]);

export const updatePolicySchema = z.enum([
  "managed-block-only",
  "skip-if-local-dirty",
  "replace-if-baseline-clean",
  "protocol-only",
  "protocol-rebuild-only",
  "never"
]);

export const conflictPolicySchema = z.enum([
  "skip-and-report",
  "managed-block-skip",
  "transactional-replace",
  "protocol-recover",
  "ignore"
]);

export const filePolicySchema = z.object({
  file_kind: fileKindSchema,
  edit_policy: editPolicySchema,
  push_policy: pushPolicySchema,
  update_policy: updatePolicySchema,
  conflict_policy: conflictPolicySchema
}).strict();

export type FileKind = z.infer<typeof fileKindSchema>;
export type FilePolicy = z.infer<typeof filePolicySchema>;
