import { z } from "zod";

export const recoveryStatusSchema = z.enum([
  "OK",
  "RECOVERY_REQUIRED",
  "COMMITTED",
  "ROLLED_BACK",
  "BLOCKED",
  "FAILED"
]);

export const recoveryMutationStateSchema = z.enum([
  "NOT_STARTED",
  "SNAPSHOTTED",
  "APPLIED_PARTIAL",
  "VERIFYING",
  "COMMITTED",
  "ROLLED_BACK"
]);

export const recoveryActionSchema = z.enum([
  "inspect",
  "resume",
  "rollback",
  "diagnose",
  "preserve-project-overlay"
]);

export const recoveryPendingTransactionSchema = z.object({
  transactionId: z.string().min(1),
  recoveryId: z.string().min(1),
  kind: z.string().nullable(),
  state: z.string().min(1),
  mutationState: recoveryMutationStateSchema,
  createdAt: z.string().min(1)
}).strict();

export const recoveryDiagnosisSchema = z.object({
  schemaVersion: z.literal(1),
  recoveryId: z.string().min(1),
  source: z.enum(["project", "durable"]),
  state: z.string().min(1),
  mutationState: recoveryMutationStateSchema,
  reasonCode: z.string().min(1).nullable(),
  planHash: z.string().nullable(),
  projectIdentityHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  affectedPathHashes: z.array(z.string().regex(/^sha256:[0-9a-f]{64}$/)),
  failureFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable(),
  scannerVersion: z.string().min(1),
  scanPassed: z.boolean()
}).strict();

export const recoveryResultSchema = z.object({
  schemaVersion: z.literal(1),
  status: recoveryStatusSchema,
  reasonCode: z.string().min(1).nullable(),
  recoveryId: z.string().min(1).nullable(),
  mutationState: recoveryMutationStateSchema,
  safeActions: z.array(recoveryActionSchema),
  recommendedAction: recoveryActionSchema.nullable(),
  resumeCommand: z.string().min(1).nullable(),
  pending: z.array(recoveryPendingTransactionSchema).optional(),
  affectedPaths: z.array(z.string()).optional(),
  snapshotPath: z.string().nullable().optional(),
  diagnosis: recoveryDiagnosisSchema.optional(),
  message: z.string().optional()
}).strict();

export type RecoveryStatus = z.infer<typeof recoveryStatusSchema>;
export type RecoveryMutationState = z.infer<typeof recoveryMutationStateSchema>;
export type RecoveryAction = z.infer<typeof recoveryActionSchema>;
export type RecoveryDiagnosis = z.infer<typeof recoveryDiagnosisSchema>;
export type RecoveryResult = z.infer<typeof recoveryResultSchema>;
