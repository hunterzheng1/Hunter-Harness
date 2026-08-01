import { z } from "zod";

export const managedExecutionReasonCodeSchema = z.enum([
  "CHILD_EXIT_ZERO",
  "USER_CANCELLED",
  "SERVICE_START_REQUESTED",
  "SERVICE_READY",
  "SERVICE_REUSED",
  "SERVICE_STOP_REQUESTED",
  "SERVICE_STOPPED",
  "SERVICE_RETIRED",
  "SERVICE_SUPERSEDER_ALREADY_LINKED",
  "ARGUMENT_INVALID",
  "CURSOR_INVALID",
  "PROFILE_INVALID",
  "PROFILE_MIGRATION_UNSAFE",
  "SESSION_SCHEMA_INVALID",
  "PYTHON_RUNTIME_NOT_FOUND",
  "WORKER_LAUNCH_FAILED",
  "LAUNCHER_FAILED",
  "CHILD_EXIT_NONZERO",
  "TIMEOUT",
  "SERVICE_START_FAILED",
  "SERVICE_STOP_FAILED",
  "SERVICE_STOP_TIMEOUT",
  "RESOURCE_LOCK_BUSY",
  "SERVICE_MUTATION_CONFLICT",
  "SERVICE_TRANSITION_CONFLICT",
  "SERVICE_SUPERSEDER_CONFLICT",
  "PROCESS_CREATE_TIME_MISMATCH",
  "PROCESS_EXECUTABLE_MISMATCH",
  "PROCESS_ARGV_MISMATCH",
  "PROCESS_CWD_MISMATCH",
  "PROCESS_PARENT_MISMATCH",
  "PROCESS_OWNER_MISMATCH",
  "PROCESS_IDENTITY_MISMATCH",
  "WORKER_IDENTITY_MISMATCH",
  "SERVICE_IDENTITY_STALE",
  "SERVICE_STOP_IDENTITY_LOST",
  "LEASE_CAS_MISMATCH",
  "LISTENER_IDENTITY_UNVERIFIABLE",
  "SENSITIVE_EVIDENCE_QUARANTINE_FAILED",
  "IDENTITY_UNVERIFIABLE",
  "HEARTBEAT_LOST",
  "SERVICE_HEARTBEAT_STALE",
  "SERVICE_CLEANUP_INCOMPLETE",
  "LOG_DECODE_DEGRADED"
]);

export type ManagedExecutionReasonCode = z.infer<
  typeof managedExecutionReasonCodeSchema
>;

export const MANAGED_EXECUTION_EXIT_CODE_BY_REASON = {
  CHILD_EXIT_ZERO: 0,
  USER_CANCELLED: 0,
  SERVICE_START_REQUESTED: 0,
  SERVICE_READY: 0,
  SERVICE_REUSED: 0,
  SERVICE_STOP_REQUESTED: 0,
  SERVICE_STOPPED: 0,
  SERVICE_RETIRED: 0,
  SERVICE_SUPERSEDER_ALREADY_LINKED: 0,
  ARGUMENT_INVALID: 2,
  CURSOR_INVALID: 2,
  PROFILE_INVALID: 2,
  PROFILE_MIGRATION_UNSAFE: 2,
  SESSION_SCHEMA_INVALID: 2,
  PYTHON_RUNTIME_NOT_FOUND: 3,
  WORKER_LAUNCH_FAILED: 3,
  LAUNCHER_FAILED: 3,
  CHILD_EXIT_NONZERO: 3,
  TIMEOUT: 3,
  SERVICE_START_FAILED: 3,
  SERVICE_STOP_FAILED: 3,
  SERVICE_STOP_TIMEOUT: 3,
  RESOURCE_LOCK_BUSY: 4,
  SERVICE_MUTATION_CONFLICT: 4,
  SERVICE_TRANSITION_CONFLICT: 4,
  SERVICE_SUPERSEDER_CONFLICT: 4,
  PROCESS_CREATE_TIME_MISMATCH: 5,
  PROCESS_EXECUTABLE_MISMATCH: 5,
  PROCESS_ARGV_MISMATCH: 5,
  PROCESS_CWD_MISMATCH: 5,
  PROCESS_PARENT_MISMATCH: 5,
  PROCESS_OWNER_MISMATCH: 5,
  PROCESS_IDENTITY_MISMATCH: 5,
  WORKER_IDENTITY_MISMATCH: 5,
  SERVICE_IDENTITY_STALE: 5,
  SERVICE_STOP_IDENTITY_LOST: 5,
  LEASE_CAS_MISMATCH: 5,
  LISTENER_IDENTITY_UNVERIFIABLE: 5,
  SENSITIVE_EVIDENCE_QUARANTINE_FAILED: 5,
  IDENTITY_UNVERIFIABLE: 6,
  HEARTBEAT_LOST: 6,
  SERVICE_HEARTBEAT_STALE: 6,
  SERVICE_CLEANUP_INCOMPLETE: 6,
  LOG_DECODE_DEGRADED: 6
} as const satisfies Record<ManagedExecutionReasonCode, 0 | 2 | 3 | 4 | 5 | 6>;

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const provenanceSchema = z.enum(["OBSERVED", "ATTESTED", "UNAVAILABLE"]);

const parentIdentitySchema = z.object({
  pid: z.number().int().positive(),
  createdAt: z.string().min(1).nullable(),
  executable: z.string().min(1).nullable()
}).strict();

const treeIdentitySchema = z.object({
  platform: z.enum(["WINDOWS", "LINUX", "POSIX"]),
  proofKind: z.string().min(1),
  memberPids: z.array(z.number().int().positive()).refine(
    (items) => new Set(items).size === items.length,
    "tree members must be unique"
  ),
  complete: z.boolean(),
  groupId: z.number().int().positive().optional(),
  sessionId: z.number().int().positive().optional()
}).strict();

export const processIdentitySchema = z.object({
  schemaVersion: z.literal(1),
  pid: z.number().int().positive(),
  alive: z.boolean(),
  createdAt: z.string().min(1).nullable(),
  executable: z.string().min(1).nullable(),
  argvHash: digestSchema.nullable(),
  workingDirectory: z.string().min(1).nullable(),
  parentIdentity: parentIdentitySchema.nullable(),
  ownerTokenHash: digestSchema.nullable(),
  treeIdentity: treeIdentitySchema.nullable(),
  fieldProvenance: z.object({
    pid: z.literal("OBSERVED"),
    createdAt: provenanceSchema,
    executable: provenanceSchema,
    argvHash: provenanceSchema,
    workingDirectory: provenanceSchema,
    parentIdentity: provenanceSchema,
    ownerTokenHash: provenanceSchema,
    treeIdentity: provenanceSchema
  }).strict(),
  capabilities: z.object({
    canObserveCreateTime: z.boolean(),
    canObserveExecutable: z.boolean(),
    canObserveArgv: z.boolean(),
    canObserveWorkingDirectory: z.boolean(),
    canObserveParent: z.boolean(),
    canEnumerateTree: z.boolean(),
    canVerifyOwnership: z.boolean()
  }).strict(),
  commandHash: digestSchema.optional(),
  parentChain: z.array(z.unknown()).optional(),
  startedAt: z.string().min(1).optional()
}).strict();

const heartbeatSchema = z.object({
  kind: z.enum(["WORKER", "SUPERVISOR", "OBSERVER"]),
  writerIdentity: digestSchema,
  lastSeenAt: z.string().min(1),
  ttlSeconds: z.number().int().positive(),
  staleReason: managedExecutionReasonCodeSchema.nullable()
}).strict();

const logStreamSchema = z.object({
  cursor: z.number().int().nonnegative(),
  rawDigest: digestSchema,
  decodeStatus: z.enum(["OK", "LOG_DECODE_DEGRADED"])
}).strict();

export const runSessionSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1),
  status: z.enum([
    "PREPARING",
    "STARTING",
    "RUNNING",
    "FINALIZING",
    "OK",
    "FAIL",
    "CANCELLED",
    "INCOMPLETE"
  ]),
  reasonCode: managedExecutionReasonCodeSchema,
  exitCode: z.number().int().nullable(),
  processIdentity: processIdentitySchema.nullable(),
  heartbeat: heartbeatSchema.nullable(),
  logs: z.object({
    stdout: logStreamSchema,
    stderr: logStreamSchema
  }).strict(),
  cleanup: z.object({
    complete: z.boolean(),
    reasonCode: managedExecutionReasonCodeSchema.nullable()
  }).strict(),
  resultDigest: digestSchema.nullable()
}).strict().superRefine((value, context) => {
  if (value.status === "OK" || value.status === "FAIL") {
    if (value.exitCode === null) {
      context.addIssue({
        code: "custom",
        path: ["exitCode"],
        message: "OK and FAIL require a final exit code"
      });
    }
    if (value.resultDigest === null) {
      context.addIssue({
        code: "custom",
        path: ["resultDigest"],
        message: "terminal run requires a result digest"
      });
    }
  }
  if (value.status === "INCOMPLETE") {
    if (value.exitCode !== null) {
      context.addIssue({
        code: "custom",
        path: ["exitCode"],
        message: "INCOMPLETE must not claim a child exit code"
      });
    }
    if (value.resultDigest === null) {
      context.addIssue({
        code: "custom",
        path: ["resultDigest"],
        message: "INCOMPLETE requires an evidence digest"
      });
    }
  }
});

const serviceHeartbeatSchema = z.object({
  kind: z.enum(["SUPERVISOR", "OBSERVER"]),
  writerIdentity: digestSchema,
  generation: z.number().int().positive(),
  lastSeenAt: z.string().min(1),
  ttlSeconds: z.number().int().positive(),
  staleReason: z.string().min(1).nullable()
}).strict();

const leaseIdentitySchema = z.object({
  leaseId: z.string().min(1),
  changeId: z.string().min(1),
  runId: z.string().min(1),
  expiresAt: z.string().min(1),
  generation: z.number().int().positive(),
  listenerIdentity: z.record(z.string(), z.unknown()).optional()
}).strict();

export const serviceSessionSchema = z.object({
  schemaVersion: z.literal(1),
  serviceId: z.string().min(1),
  sessionId: z.string().min(1),
  status: z.enum([
    "STARTING",
    "READY",
    "STOPPING",
    "STOPPED",
    "FAILED",
    "STALE_IDENTITY_MISMATCH",
    "RETIRED"
  ]),
  reasonCode: managedExecutionReasonCodeSchema,
  serviceGeneration: z.number().int().positive(),
  stateRevision: z.number().int().positive(),
  operationId: z.string().min(1),
  fingerprint: digestSchema,
  processIdentity: processIdentitySchema.nullable(),
  heartbeat: serviceHeartbeatSchema.nullable(),
  leaseIdentity: leaseIdentitySchema.nullable(),
  transitionHistory: z.array(z.object({
    from: z.string().min(1).nullable(),
    to: z.string().min(1),
    reasonCode: managedExecutionReasonCodeSchema,
    revision: z.number().int().positive(),
    operationId: z.string().min(1).optional(),
    at: z.string().min(1).optional()
  }).strict()),
  cleanupComplete: z.boolean(),
  supersedesSessionId: z.string().min(1).nullable(),
  pid: z.number().int().positive().optional(),
  startedBy: z.string().min(1).optional(),
  moduleInputsHash: digestSchema.optional(),
  moduleInputsFiles: z.array(z.string()).optional(),
  profile: z.string().min(1).optional(),
  startCommandHash: digestSchema.optional(),
  overlayPath: z.string().optional(),
  startedAt: z.string().min(1).optional(),
  command: z.string().optional(),
  argv: z.array(z.string()).optional(),
  ownedPorts: z.array(z.number().int().positive().max(65535)).optional(),
  processAttestation: z.record(z.string(), z.unknown()).optional(),
  ownershipProof: z.record(z.string(), z.unknown()).optional(),
  servicePid: z.number().int().positive().optional(),
  jobId: z.string().min(1).optional(),
  leasedPort: z.number().int().positive().max(65535).optional(),
  leaseOwner: z.string().nullable().optional(),
  worktreeRoot: z.string().min(1).optional(),
  executionRoot: z.string().min(1).optional(),
  changeId: z.string().min(1).optional(),
  attemptId: z.string().min(1).optional(),
  instanceTokenHash: digestSchema.optional(),
  identityCompleteness: z.string().min(1).optional()
}).strict();

export const serviceRetirementReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  receiptId: z.string().min(1),
  operationId: z.string().min(1),
  serviceId: z.string().min(1),
  oldSessionId: z.string().min(1),
  oldGeneration: z.number().int().positive(),
  state: z.enum(["PENDING", "FINALIZED"]),
  retirementStateCommit: z.object({
    status: z.enum(["PENDING", "COMMITTED", "CONFLICT"]),
    reasonCode: managedExecutionReasonCodeSchema
  }).strict(),
  leaseCleanup: z.object({
    status: z.enum(["PENDING", "RELEASED", "RETAINED", "UNVERIFIED"]),
    reasonCode: managedExecutionReasonCodeSchema,
    leaseId: z.string().min(1).nullable()
  }).strict(),
  cleanupComplete: z.boolean(),
  awaitingSuperseder: z.boolean(),
  supersededBySessionId: z.string().min(1).nullable(),
  receiptDigest: digestSchema
}).strict().superRefine((value, context) => {
  if (value.cleanupComplete !== (value.leaseCleanup.status === "RELEASED")) {
    context.addIssue({
      code: "custom",
      path: ["cleanupComplete"],
      message: "cleanupComplete must reflect lease cleanup"
    });
  }
  if (value.awaitingSuperseder && value.supersededBySessionId !== null) {
    context.addIssue({
      code: "custom",
      path: ["supersededBySessionId"],
      message: "awaiting receipt cannot already name a superseder"
    });
  }
});

export type ProcessIdentity = z.infer<typeof processIdentitySchema>;
export type RunSession = z.infer<typeof runSessionSchema>;
export type ServiceSession = z.infer<typeof serviceSessionSchema>;
export type ServiceRetirementReceipt = z.infer<
  typeof serviceRetirementReceiptSchema
>;

export type ExecutionContractName =
  | "process-identity"
  | "run-session"
  | "service-session"
  | "service-retirement-receipt";

export function parseExecutionContract(
  contract: ExecutionContractName,
  value: unknown
) {
  switch (contract) {
    case "process-identity":
      return processIdentitySchema.safeParse(value);
    case "run-session":
      return runSessionSchema.safeParse(value);
    case "service-session":
      return serviceSessionSchema.safeParse(value);
    case "service-retirement-receipt":
      return serviceRetirementReceiptSchema.safeParse(value);
  }
}
