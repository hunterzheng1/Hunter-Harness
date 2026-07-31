import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat
} from "node:fs/promises";
import { join } from "node:path";

import {
  projectConfigSchema,
  type RecoveryAction,
  type RecoveryMutationState
} from "@hunter-harness/contracts";
import { parse as parseYaml } from "yaml";

import { sha256Bytes, sha256File } from "../fs/hash.js";
import { assertNoSymlinks } from "../fs/path-safety.js";
import { collectProtectedLocalRootsInventory } from "../project/local-state.js";
import { uuidV7 } from "../project/uuid-v7.js";
import {
  scanSensitiveFiles,
  SENSITIVE_SCANNER_VERSION
} from "../security/scanner.js";
import { atomicWriteJson } from "../state/atomic.js";
import { stateLayout } from "../state/layout.js";
import type {
  TransactionJournal,
  TransactionJournalOperation,
  TransactionOperation
} from "./journal.js";
import {
  acquireRecoveryMutationLock,
  locateRecovery,
  readDurableRecoveryIds,
  resolveRecoveryRoot,
  syncDurableRecovery,
  type RecoveryLocation,
  type RecoveryLocationOptions
} from "./recovery-store.js";
import {
  applyTransactionOperation,
  assertJournalCheckpoint,
  assertRollbackRecoveryPreconditions,
  computeSnapshotDigest,
  rollbackTransaction,
  runTransaction,
  transactionJournalPlanHash,
  transactionTargetState,
  writeTransactionJournal,
  type TransactionResult
} from "./transaction.js";

export async function recoverTransaction(
  projectRoot: string,
  transactionId: string,
  options: RecoveryLocationOptions = {}
): Promise<TransactionResult> {
  return rollbackTransaction(projectRoot, transactionId, options);
}

export interface TransactionSummary {
  transactionId: string;
  recoveryId: string;
  kind: TransactionJournal["kind"];
  state: TransactionJournal["state"];
  mutationState: RecoveryMutationState;
  appliedCount: number;
  operationCount: number;
  createdAt: string;
}

export function recoveryMutationState(
  state: TransactionJournal["state"],
  appliedCount: number
): RecoveryMutationState {
  if (state === "committed") return "COMMITTED";
  if (state === "rolled_back") return "ROLLED_BACK";
  if (state === "prepared") return "SNAPSHOTTED";
  if (state === "applying" || state === "interrupted" ||
      state === "rolling_back" || state === "recovery_required") {
    return appliedCount > 0 ? "APPLIED_PARTIAL" : "SNAPSHOTTED";
  }
  return "NOT_STARTED";
}

const RECOVERY_STATES = new Set<TransactionJournal["state"]>([
  "prepared",
  "applying",
  "interrupted",
  "rolling_back",
  "recovery_required"
]);
const INSTALLED_BUNDLE_PATH =
  ".harness/state/local/installed-harness-bundle.json";
const PROJECT_CONFIG_PATH = ".harness/project.yaml";
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

export async function listTransactions(projectRoot: string): Promise<TransactionSummary[]> {
  const root = stateLayout(projectRoot).transactions;
  let localNames: string[] = [];
  try {
    localNames = await readdir(root);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  const recoveryRoot = process.env.HUNTER_HARNESS_RECOVERY_ROOT?.trim()
    ? resolveRecoveryRoot()
    : undefined;
  const durableNames = recoveryRoot === undefined
    ? []
    : await readDurableRecoveryIds(projectRoot, recoveryRoot);
  const names = [...new Set([...localNames, ...durableNames])];
  const transactions: TransactionSummary[] = [];
  for (const transactionId of names) {
    try {
      const location = await locateRecovery(
        projectRoot,
        transactionId,
        recoveryRoot === undefined ? {} : { recoveryRoot }
      );
      if (location === null) continue;
      const journal = location.journal;
      transactions.push({
        transactionId,
        recoveryId: journal.recovery_id ?? transactionId,
        kind: journal.kind,
        state: journal.state,
        mutationState: recoveryMutationState(journal.state, journal.applied_count ?? 0),
        appliedCount: journal.applied_count ?? 0,
        operationCount: journal.operations.length,
        createdAt: journal.created_at
      });
    } catch {
      // Ignore non-transaction entries; state validation reports malformed journals separately.
    }
  }
  return transactions.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function pendingTransactions(
  projectRoot: string
): Promise<TransactionSummary[]> {
  return (await listTransactions(projectRoot)).filter((item) =>
    RECOVERY_STATES.has(item.state)
  );
}

export interface ResumeTransactionOptions extends RecoveryLocationOptions {
  cliVersion?: string;
  targetBundleVersion?: string;
  ownershipManifestHash?: string;
  expectedPlanHash?: string;
}

export interface RecoveryInspection {
  source: RecoveryLocation["source"];
  recoveryId: string;
  transactionId: string;
  kind: TransactionJournal["kind"];
  createdAt: string;
  state: TransactionJournal["state"];
  mutationState: RecoveryMutationState;
  safeActions: RecoveryAction[];
  planHash: string | null;
  projectIdentity: string | null;
  affectedPaths: string[];
}

export interface RecoveryTargetBundleState {
  adapters: string[];
  profiles: Record<string, string>;
  manifests: Array<{
    adapter: string;
    profile: string;
    bundleVersion: string;
    bundleManifestHash: string;
  }>;
  projectIdentity: string | null;
  projectAdapters: string[] | null;
  projectProfiles: string[] | null;
}

export interface RecoveryDiagnosis {
  schemaVersion: 1;
  recoveryId: string;
  source: RecoveryLocation["source"];
  state: TransactionJournal["state"];
  mutationState: RecoveryMutationState;
  reasonCode: "RECOVERY_FAILURE_RECORDED" | null;
  planHash: string | null;
  projectIdentityHash: string;
  affectedPathHashes: string[];
  failureFingerprint: string | null;
  scannerVersion: string;
  scanPassed: boolean;
}

export class RecoveryPreconditionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RecoveryPreconditionError";
    this.code = code;
  }
}

function affectedOperationPaths(
  operation: TransactionJournalOperation
): string[] {
  return operation.operation === "rename"
    ? [operation.from_path, operation.to_path]
    : [operation.path];
}

async function operationFromJournal(
  transactionRoot: string,
  operation: TransactionJournalOperation,
  index: number
): Promise<TransactionOperation> {
  if (operation.operation === "delete") {
    return { operation: "delete", path: operation.path };
  }
  const content = await readFile(join(transactionRoot, "staged", String(index)));
  if (operation.operation === "rename") {
    return {
      operation: "rename",
      from_path: operation.from_path,
      to_path: operation.to_path,
      content
    };
  }
  return {
    operation: operation.operation,
    path: operation.path,
    content
  };
}

function assertV3Identity(
  journal: TransactionJournal,
  options: ResumeTransactionOptions
): void {
  if (journal.schema_version !== 3) {
    throw new RecoveryPreconditionError(
      "LEGACY_RECOVERY_RESUME_UNSUPPORTED",
      "schema v1/v2 recovery is inspect-and-rollback only"
    );
  }
  if (journal.plan_hash === null || journal.plan_hash === undefined ||
      journal.plan_hash === "" || journal.snapshot_digest === null ||
      journal.snapshot_digest === undefined || journal.snapshot_digest === "") {
    throw new RecoveryPreconditionError(
      "RECOVERY_PRECONDITION_FAILED",
      "schema v3 recovery plan or snapshot identity is incomplete"
    );
  }
  const identityComparisons: Array<[
    string,
    string | undefined,
    string | null | undefined
  ]> = [
    ["PROJECT_IDENTITY_CHANGED", options.projectIdentity, journal.project_identity],
    ["CLI_VERSION_CHANGED", options.cliVersion, journal.cli_version],
    [
      "TARGET_BUNDLE_VERSION_CHANGED",
      options.targetBundleVersion,
      journal.target_bundle_version
    ],
    [
      "OWNERSHIP_MANIFEST_CHANGED",
      options.ownershipManifestHash,
      journal.ownership_manifest_hash
    ]
  ];
  const hasCompleteGuardedIdentity = identityComparisons.every(
    ([, , actual]) => actual !== null && actual !== undefined && actual !== ""
  );
  if (hasCompleteGuardedIdentity && identityComparisons.some(
    ([, expected]) => expected === undefined || expected === ""
  )) {
    throw new RecoveryPreconditionError(
      "RECOVERY_PRECONDITION_FAILED",
      "current project, CLI, Bundle, and ownership identity are required"
    );
  }
  for (const [reason, expected, actual] of identityComparisons) {
    if (actual !== null && actual !== undefined && actual !== "" &&
        expected !== undefined && expected !== actual) {
      throw new RecoveryPreconditionError(
        "RECOVERY_PRECONDITION_FAILED",
        reason + ": recovery identity does not match"
      );
    }
  }
  if (options.expectedPlanHash !== undefined &&
      options.expectedPlanHash !== journal.plan_hash) {
    throw new RecoveryPreconditionError(
      "RECOVERY_PRECONDITION_FAILED",
      "PLAN_HASH_CHANGED: immutable recovery plan does not match"
    );
  }
  if (transactionJournalPlanHash(journal) !== journal.plan_hash) {
    throw new RecoveryPreconditionError(
      "RECOVERY_PRECONDITION_FAILED",
      "recovery plan metadata has drifted"
    );
  }
}

async function assertRecoveryPayloads(
  projectRoot: string,
  location: RecoveryLocation,
  journal: TransactionJournal
): Promise<void> {
  const pending = journal.pending_operations ??
    journal.operations.map((_operation, index) => index)
      .filter((index) => index >= journal.applied_count);
  if (location.source === "durable" && location.mirror !== null &&
      pending.some((index) =>
        !location.mirror?.mirroredOperationIndexes.includes(index)
      )) {
    throw new RecoveryPreconditionError(
      "RECOVERY_PRECONDITION_FAILED",
      "durable mirror does not contain every pending managed payload"
    );
  }
  for (const path of journal.operations.flatMap(affectedOperationPaths)) {
    try {
      await assertNoSymlinks(projectRoot, path);
    } catch {
      throw new RecoveryPreconditionError(
        "RECOVERY_PRECONDITION_FAILED",
        "recovery target path is no longer symlink-safe"
      );
    }
  }
  if (location.source === "project") {
    const digest = await computeSnapshotDigest(
      location.transactionRoot,
      journal.snapshots
    );
    if (digest !== journal.snapshot_digest) {
      throw new RecoveryPreconditionError(
        "RECOVERY_PRECONDITION_FAILED",
        "SNAPSHOT_DIGEST_MISMATCH: recovery snapshot digest does not match"
      );
    }
  } else if (location.mirror !== null) {
    const mirroredPaths = new Set(location.mirror.mirroredSnapshotPaths);
    const mirroredSnapshots = journal.snapshots.filter((snapshot) =>
      mirroredPaths.has(snapshot.path)
    );
    if (mirroredSnapshots.length !== mirroredPaths.size ||
        await computeSnapshotDigest(
          location.transactionRoot,
          mirroredSnapshots
        ) !== location.mirror.snapshotDigest) {
      throw new RecoveryPreconditionError(
        "RECOVERY_PRECONDITION_FAILED",
        "SNAPSHOT_DIGEST_MISMATCH: durable recovery snapshot digest does not match"
      );
    }
  }
  for (const index of pending) {
    const operation = journal.operations[index];
    if (operation === undefined || operation.operation === "delete") {
      continue;
    }
    if (operation.content_sha256 === undefined) {
      throw new RecoveryPreconditionError(
        "RECOVERY_PRECONDITION_FAILED",
        "pending operation is missing its content hash"
      );
    }
    try {
      if (await sha256File(
        join(location.transactionRoot, "staged", String(index))
      ) !== operation.content_sha256) {
        throw new RecoveryPreconditionError(
          "RECOVERY_PRECONDITION_FAILED",
          "staged payload digest does not match"
        );
      }
    } catch (error) {
      if (error instanceof RecoveryPreconditionError) throw error;
      throw new RecoveryPreconditionError(
        "RECOVERY_PRECONDITION_FAILED",
        "staged payload is unavailable"
      );
    }
    for (const path of affectedOperationPaths(operation)) {
      const snapshot = journal.snapshots.find((item) => item.path === path);
      if (snapshot === undefined) {
        throw new RecoveryPreconditionError(
          "RECOVERY_PRECONDITION_FAILED",
          "RESUME_PENDING_TARGET_CHANGED: snapshot is missing for " + path
        );
      }
      const target = join(projectRoot, path);
      const targetExists = await pathExists(target);
      if (targetExists !== snapshot.existed) {
        throw new RecoveryPreconditionError(
          "RECOVERY_PRECONDITION_FAILED",
          "RESUME_PENDING_TARGET_CHANGED: " + path
        );
      }
      if (!targetExists) continue;
      if (snapshot.snapshot_name === null) {
        throw new RecoveryPreconditionError(
          "RECOVERY_PRECONDITION_FAILED",
          "RESUME_PENDING_TARGET_CHANGED: invalid snapshot for " + path
        );
      }
      try {
        if (await sha256File(target) !== await sha256File(join(
          location.transactionRoot,
          "before",
          snapshot.snapshot_name
        ))) {
          throw new RecoveryPreconditionError(
            "RECOVERY_PRECONDITION_FAILED",
            "RESUME_PENDING_TARGET_CHANGED: " + path
          );
        }
      } catch (error) {
        if (error instanceof RecoveryPreconditionError) throw error;
        throw new RecoveryPreconditionError(
          "RECOVERY_PRECONDITION_FAILED",
          "RESUME_PENDING_TARGET_CHANGED: snapshot unavailable for " + path
        );
      }
    }
  }
  for (const completed of journal.completed_target_states ?? []) {
    const operation = journal.operations[completed.operation_index];
    if (operation === undefined) {
      throw new RecoveryPreconditionError(
        "RECOVERY_PRECONDITION_FAILED",
        "completed operation metadata is invalid"
      );
    }
    const current = await transactionTargetState(
      projectRoot,
      operation,
      completed.operation_index
    );
    if (JSON.stringify(current) !== JSON.stringify(completed)) {
      throw new RecoveryPreconditionError(
        "RECOVERY_PRECONDITION_FAILED",
        "a completed target changed after interruption"
      );
    }
  }
  const protectedBefore = journal.protected_local_roots?.before;
  if (protectedBefore !== undefined) {
    const current = await collectProtectedLocalRootsInventory(projectRoot);
    if (JSON.stringify(current) !== JSON.stringify(protectedBefore)) {
      throw new RecoveryPreconditionError(
        "RECOVERY_PRECONDITION_FAILED",
        "protected local state changed after interruption"
      );
    }
  }
}

function operationTargetPath(
  operation: TransactionJournalOperation
): string | null {
  if (operation.operation === "delete") return null;
  return operation.operation === "rename"
    ? operation.to_path
    : operation.path;
}

async function readPlannedTargetContent(
  location: RecoveryLocation,
  journal: TransactionJournal,
  targetPath: string,
  label: string
): Promise<string | null> {
  const operationIndex = journal.operations
    .map((operation, index) => ({ operation, index }))
    .filter(({ operation }) => operationTargetPath(operation) === targetPath)
    .at(-1)?.index;
  if (operationIndex === undefined) return null;
  const operation = journal.operations[operationIndex];
  if (operation === undefined ||
      operation.operation === "delete" ||
      operation.content_sha256 === undefined) {
    throw new RecoveryPreconditionError(
      "RECOVERY_PRECONDITION_FAILED",
      `planned ${label} is incomplete`
    );
  }
  const stagedPath = join(
    location.transactionRoot,
    "staged",
    String(operationIndex)
  );
  try {
    if (await sha256File(stagedPath) !== operation.content_sha256) {
      throw new RecoveryPreconditionError(
        "RECOVERY_PRECONDITION_FAILED",
        `planned ${label} digest does not match`
      );
    }
    return await readFile(stagedPath, "utf8");
  } catch (error) {
    if (error instanceof RecoveryPreconditionError) throw error;
    throw new RecoveryPreconditionError(
      "RECOVERY_PRECONDITION_FAILED",
      `planned ${label} is unavailable`
    );
  }
}

function sortedUnique(values: readonly string[]): string[] | null {
  const unique = [...new Set(values)].sort();
  return unique.length === values.length ? unique : null;
}

async function readRecoveryTargetBundleStateFromLocation(
  location: RecoveryLocation,
  journal: TransactionJournal
): Promise<RecoveryTargetBundleState | null> {
  const content = await readPlannedTargetContent(
    location,
    journal,
    INSTALLED_BUNDLE_PATH,
    "installed Bundle state"
  );
  if (content === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new RecoveryPreconditionError(
      "RECOVERY_PRECONDITION_FAILED",
      "planned installed Bundle state is invalid"
    );
  }
  const record = parsed as {
    schema_version?: unknown;
    adapters?: unknown;
    profiles?: unknown;
    manifests?: unknown;
  };
  if (record.schema_version !== 4 ||
      !Array.isArray(record.adapters) ||
      !record.adapters.every((value) => typeof value === "string") ||
      record.profiles === null ||
      typeof record.profiles !== "object" ||
      Array.isArray(record.profiles) ||
      !Object.values(record.profiles).every((value) => typeof value === "string") ||
      !Array.isArray(record.manifests) ||
      !record.manifests.every((value) =>
        value !== null &&
        typeof value === "object" &&
        typeof (value as { adapter?: unknown }).adapter === "string" &&
        typeof (value as { profile?: unknown }).profile === "string" &&
        typeof (value as { bundle_version?: unknown }).bundle_version === "string" &&
        typeof (value as { bundle_manifest_hash?: unknown })
          .bundle_manifest_hash === "string" &&
        SHA256_PATTERN.test(
          (value as { bundle_manifest_hash: string }).bundle_manifest_hash
        )
      )) {
    throw new RecoveryPreconditionError(
      "RECOVERY_PRECONDITION_FAILED",
      "planned installed Bundle state is invalid"
    );
  }
  const adapters = [...record.adapters] as string[];
  const profiles = { ...record.profiles } as Record<string, string>;
  const manifests = record.manifests.map((value) => ({
    adapter: (value as { adapter: string }).adapter,
    profile: (value as { profile: string }).profile,
    bundleVersion: (value as { bundle_version: string }).bundle_version,
    bundleManifestHash: (
      value as { bundle_manifest_hash: string }
    ).bundle_manifest_hash
  }));
  const sortedAdapters = sortedUnique(adapters);
  const sortedManifestAdapters = sortedUnique(
    manifests.map((item) => item.adapter)
  );
  const sortedProfileAdapters = sortedUnique(Object.keys(profiles));
  if (sortedAdapters === null ||
      sortedManifestAdapters === null ||
      sortedProfileAdapters === null ||
      new Set(manifests.map((item) => item.adapter)).size !== manifests.length ||
      JSON.stringify(sortedAdapters) !== JSON.stringify(sortedManifestAdapters) ||
      JSON.stringify(sortedAdapters) !== JSON.stringify(sortedProfileAdapters) ||
      manifests.some((manifest) => profiles[manifest.adapter] !== manifest.profile)) {
    throw new RecoveryPreconditionError(
      "RECOVERY_PRECONDITION_FAILED",
      "planned installed Bundle adapters are inconsistent"
    );
  }
  const projectContent = await readPlannedTargetContent(
    location,
    journal,
    PROJECT_CONFIG_PATH,
    "project configuration"
  );
  if (projectContent === null) {
    return {
      adapters,
      profiles,
      manifests,
      projectIdentity: null,
      projectAdapters: null,
      projectProfiles: null
    };
  }
  let projectRaw: unknown;
  try {
    projectRaw = parseYaml(projectContent);
  } catch {
    throw new RecoveryPreconditionError(
      "RECOVERY_PRECONDITION_FAILED",
      "planned project configuration is invalid"
    );
  }
  const project = projectConfigSchema.safeParse(projectRaw);
  if (!project.success) {
    throw new RecoveryPreconditionError(
      "RECOVERY_PRECONDITION_FAILED",
      "planned project configuration is invalid"
    );
  }
  const projectAdapters = sortedUnique(project.data.adapters.enabled);
  const projectProfiles = sortedUnique(project.data.project.profiles);
  const manifestProfiles = sortedUnique(
    manifests.map((manifest) => manifest.profile)
  );
  if (journal.project_identity === null ||
      journal.project_identity === undefined ||
      project.data.project.local_project_key !== journal.project_identity ||
      projectAdapters === null ||
      projectProfiles === null ||
      manifestProfiles === null ||
      JSON.stringify(projectAdapters) !== JSON.stringify(sortedAdapters) ||
      JSON.stringify(projectProfiles) !== JSON.stringify(manifestProfiles)) {
    throw new RecoveryPreconditionError(
      "RECOVERY_PRECONDITION_FAILED",
      "planned project and installed Bundle identities are inconsistent"
    );
  }
  return {
    adapters,
    profiles,
    manifests,
    projectIdentity: project.data.project.local_project_key,
    projectAdapters,
    projectProfiles
  };
}

export async function readRecoveryTargetBundleState(
  projectRoot: string,
  recoveryId: string,
  options: RecoveryLocationOptions = {}
): Promise<RecoveryTargetBundleState | null> {
  const location = await locateRecovery(projectRoot, recoveryId, options);
  if (location === null) {
    throw new RecoveryPreconditionError(
      "RECOVERY_NOT_FOUND",
      "recoveryId does not exist"
    );
  }
  return readRecoveryTargetBundleStateFromLocation(
    location,
    location.journal
  );
}

async function persistRecoveryJournal(
  projectRoot: string,
  location: RecoveryLocation,
  journal: TransactionJournal,
  recoveryRoot: string | undefined
): Promise<void> {
  await writeTransactionJournal(location.transactionRoot, journal);
  if (location.source === "project" && recoveryRoot !== undefined) {
    await syncDurableRecovery(projectRoot, journal, { root: recoveryRoot });
  }
}

export async function inspectRecovery(
  projectRoot: string,
  recoveryId: string,
  options: RecoveryLocationOptions = {}
): Promise<RecoveryInspection> {
  const location = await locateRecovery(projectRoot, recoveryId, options);
  if (location === null) {
    throw new RecoveryPreconditionError(
      "RECOVERY_NOT_FOUND",
      "recoveryId does not exist"
    );
  }
  const journal = location.journal;
  const terminal = journal.state === "committed" || journal.state === "rolled_back";
  const completed = journal.completed_operations ??
    journal.operations.map((_operation, index) => index)
      .filter((index) => index < journal.applied_count);
  let durableRollbackReady = location.source === "project" ||
    completed.every((index) => location.mirror?.mirroredOperationIndexes.includes(index));
  let durableResumeReady = location.source === "project" ||
    (journal.pending_operations ?? []).every((index) =>
      location.mirror?.mirroredOperationIndexes.includes(index)
    );
  if (!terminal && durableResumeReady && journal.schema_version === 3) {
    try {
      assertJournalCheckpoint(journal);
      await assertRecoveryPayloads(projectRoot, location, journal);
      await readRecoveryTargetBundleStateFromLocation(location, journal);
    } catch {
      durableResumeReady = false;
    }
  }
  if (!terminal && durableRollbackReady) {
    try {
      await assertRollbackRecoveryPreconditions(
        projectRoot,
        location,
        journal
      );
    } catch {
      durableRollbackReady = false;
    }
  }
  const safeActions: RecoveryAction[] = ["inspect", "diagnose"];
  if (!terminal && durableResumeReady && journal.schema_version === 3) {
    safeActions.push("resume");
  }
  if (!terminal && durableRollbackReady) {
    safeActions.push("rollback");
  }
  return {
    source: location.source,
    recoveryId: journal.recovery_id ?? journal.transaction_id,
    transactionId: journal.transaction_id,
    kind: journal.kind,
    createdAt: journal.created_at,
    state: journal.state,
    mutationState: recoveryMutationState(journal.state, journal.applied_count),
    safeActions,
    planHash: journal.plan_hash ?? null,
    projectIdentity: journal.project_identity ?? null,
    affectedPaths: [...new Set(journal.operations.flatMap(affectedOperationPaths))].sort()
  };
}

/**
 * Compatibility projection for callers introduced before the durable v3
 * inspection contract. Mutating actions still revalidate through the v3
 * recovery APIs.
 */
export async function inspectTransaction(
  projectRoot: string,
  transactionId: string
): Promise<{
  status: "RECOVERY_REQUIRED" | "COMMITTED" | "ROLLED_BACK";
  reasonCode: string;
  recoveryId: string;
  transactionId: string;
  mutationState: RecoveryMutationState;
  planHash: string | null;
  kind: TransactionJournal["kind"];
  failureReasonCode: string | null;
  safeActions: RecoveryAction[];
  recommendedAction: "resume" | "rollback" | "inspect" | null;
  resumeCommand: string | null;
}> {
  const inspection = await inspectRecovery(projectRoot, transactionId);
  const pending = inspection.state !== "committed" &&
    inspection.state !== "rolled_back";
  const recommendedAction = pending
    ? inspection.safeActions.includes("resume")
      ? "resume" as const
      : inspection.safeActions.includes("rollback")
        ? "rollback" as const
        : "inspect" as const
    : null;
  return {
    status: pending
      ? "RECOVERY_REQUIRED"
      : inspection.state === "rolled_back"
        ? "ROLLED_BACK"
        : "COMMITTED",
    reasonCode: pending
      ? "TRANSACTION_RECOVERY_REQUIRED"
      : inspection.state === "rolled_back"
        ? "TRANSACTION_ROLLED_BACK"
        : "TRANSACTION_COMMITTED",
    recoveryId: inspection.recoveryId,
    transactionId: inspection.transactionId,
    mutationState: inspection.mutationState,
    planHash: inspection.planHash,
    kind: inspection.kind,
    failureReasonCode: null,
    safeActions: inspection.safeActions,
    recommendedAction,
    resumeCommand: recommendedAction === "resume"
      ? `hunter-harness resume ${inspection.recoveryId} --action resume --json`
      : null
  };
}

export async function diagnoseRecovery(
  projectRoot: string,
  recoveryId: string,
  options: RecoveryLocationOptions = {}
): Promise<RecoveryDiagnosis> {
  const location = await locateRecovery(projectRoot, recoveryId, options);
  if (location === null) {
    throw new RecoveryPreconditionError(
      "RECOVERY_NOT_FOUND",
      "recoveryId does not exist"
    );
  }
  const journal = location.journal;
  const base = {
    schemaVersion: 1 as const,
    recoveryId: journal.recovery_id ?? journal.transaction_id,
    source: location.source,
    state: journal.state,
    mutationState: recoveryMutationState(journal.state, journal.applied_count),
    reasonCode: journal.failure === null
      ? null
      : "RECOVERY_FAILURE_RECORDED" as const,
    planHash: journal.plan_hash ?? null,
    projectIdentityHash: sha256Bytes(journal.project_identity ?? "unbound"),
    affectedPathHashes: [...new Set(
      journal.operations.flatMap(affectedOperationPaths).map(sha256Bytes)
    )].sort(),
    failureFingerprint: journal.failure === null
      ? null
      : sha256Bytes(journal.failure),
    scannerVersion: SENSITIVE_SCANNER_VERSION
  };
  const scan = scanSensitiveFiles({
    "recovery-diagnosis.json": JSON.stringify(base)
  });
  return { ...base, scanPassed: !scan.blocked };
}

export async function resumeTransaction(
  projectRoot: string,
  recoveryId: string,
  options: ResumeTransactionOptions = {}
): Promise<TransactionResult> {
  const location = await locateRecovery(projectRoot, recoveryId, options);
  if (location === null) {
    throw new RecoveryPreconditionError(
      "RECOVERY_NOT_FOUND",
      "recoveryId does not exist"
    );
  }
  const release = await acquireRecoveryMutationLock(location.transactionRoot);
  try {
    const journal = JSON.parse(await readFile(
      join(location.transactionRoot, "journal.json"),
      "utf8"
    )) as TransactionJournal;
    if (journal.state === "committed" || journal.state === "rolled_back") {
      const current = await collectProtectedLocalRootsInventory(projectRoot);
      return {
        transactionId: journal.transaction_id,
        recoveryId: journal.recovery_id ?? journal.transaction_id,
        planHash: journal.plan_hash ?? null,
        status: journal.state,
        protectedLocalRoots: journal.protected_local_roots ?? {
          before: current,
          after: current,
          unchanged: true
        }
      };
    }
    assertV3Identity(journal, options);
    assertJournalCheckpoint(journal);
    await assertRecoveryPayloads(projectRoot, location, journal);
    let mutationStarted = false;
    try {
      const pending = journal.pending_operations ??
        journal.operations.map((_operation, index) => index)
          .filter((index) => index >= journal.applied_count);
      journal.state = "applying";
      journal.failure = null;
      mutationStarted = true;
      await persistRecoveryJournal(
        projectRoot,
        location,
        journal,
        options.recoveryRoot
      );
      for (const index of pending) {
        const journalOperation = journal.operations[index];
        if (journalOperation === undefined) continue;
        const operation = await operationFromJournal(
          location.transactionRoot,
          journalOperation,
          index
        );
        await applyTransactionOperation(
          projectRoot,
          location.transactionRoot,
          operation,
          index,
          journal.transaction_id
        );
        journal.completed_operations = [
          ...new Set([...(journal.completed_operations ?? []), index])
        ].sort((left, right) => left - right);
        journal.pending_operations = pending.filter(
          (pendingIndex) => !journal.completed_operations?.includes(pendingIndex)
        );
        journal.applied_count = journal.completed_operations.length;
        journal.completed_target_states = [
          ...(journal.completed_target_states ?? []).filter(
            (item) => item.operation_index !== index
          ),
          await transactionTargetState(projectRoot, journalOperation, index)
        ].sort((left, right) => left.operation_index - right.operation_index);
        await persistRecoveryJournal(
          projectRoot,
          location,
          journal,
          options.recoveryRoot
        );
      }

      const after = [];
      for (const path of [
        ...new Set(journal.operations.flatMap(affectedOperationPaths))
      ]) {
        const target = join(projectRoot, path);
        const present = await pathExists(target);
        after.push({
          path,
          exists: present,
          hash: present ? await sha256File(target) : null
        });
      }
      await mkdir(join(location.transactionRoot, "after"), {
        recursive: true
      });
      await atomicWriteJson(
        join(location.transactionRoot, "after", "manifest.json"),
        after
      );
      const protectedBefore = journal.protected_local_roots?.before ??
        await collectProtectedLocalRootsInventory(projectRoot);
      const protectedAfter = await collectProtectedLocalRootsInventory(projectRoot);
      const protectedUnchanged = JSON.stringify(protectedBefore) ===
        JSON.stringify(protectedAfter);
      if (!protectedUnchanged) {
        throw new RecoveryPreconditionError(
          "RECOVERY_PRECONDITION_FAILED",
          "protected local state changed while resuming"
        );
      }
      journal.protected_local_roots = {
        before: protectedBefore,
        after: protectedAfter,
        unchanged: true
      };
      journal.verification_outcomes = [{
        name: "protected-local-roots",
        status: "passed"
      }];
      journal.state = "committed";
      await persistRecoveryJournal(
        projectRoot,
        location,
        journal,
        options.recoveryRoot
      );
      await rm(join(location.transactionRoot, "staged"), {
        recursive: true,
        force: true
      });
      return {
        transactionId: journal.transaction_id,
        recoveryId: journal.recovery_id ?? journal.transaction_id,
        planHash: journal.plan_hash ?? null,
        status: "committed",
        protectedLocalRoots: journal.protected_local_roots
      };
    } catch (error) {
      if (mutationStarted && journal.state !== "committed") {
        journal.state = "recovery_required";
        journal.failure = error instanceof Error ? error.message : String(error);
        await persistRecoveryJournal(
          projectRoot,
          location,
          journal,
          options.recoveryRoot
        );
      }
      throw error;
    }
  } finally {
    await release();
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function rollbackCommittedUpdate(
  projectRoot: string,
  transactionId: string
): Promise<TransactionResult> {
  const selected = (await listTransactions(projectRoot)).find((item) =>
    (item.transactionId === transactionId ||
      item.recoveryId === transactionId) &&
    item.kind === "update" &&
    item.state === "committed"
  );
  if (selected === undefined) {
    throw new Error(
      "committed update transaction is not available for rollback: " +
      transactionId
    );
  }
  const transactionRoot = join(
    stateLayout(projectRoot).transactions,
    selected.transactionId
  );
  const journal = JSON.parse(await readFile(
    join(transactionRoot, "journal.json"), "utf8"
  )) as TransactionJournal;
  assertJournalCheckpoint(journal);
  if (await computeSnapshotDigest(
    transactionRoot,
    journal.snapshots
  ) !== journal.snapshot_digest) {
    throw new RecoveryPreconditionError(
      "RECOVERY_PRECONDITION_FAILED",
      "SNAPSHOT_DIGEST_MISMATCH: recovery snapshot digest does not match"
    );
  }
  const after = JSON.parse(await readFile(
    join(transactionRoot, "after", "manifest.json"), "utf8"
  )) as Array<{ path: string; exists: boolean; hash: string | null }>;
  for (const entry of after) {
    const target = join(projectRoot, entry.path);
    const exists = await pathExists(target);
    if (exists !== entry.exists || (exists && await sha256File(target) !== entry.hash)) {
      throw new Error("cannot rollback dirty path: " + entry.path);
    }
  }

  const operations = [];
  const seen = new Set<string>();
  for (const snapshot of journal.snapshots) {
    if (seen.has(snapshot.path)) {
      continue;
    }
    seen.add(snapshot.path);
    const target = join(projectRoot, snapshot.path);
    const exists = await pathExists(target);
    if (snapshot.existed && snapshot.snapshot_name !== null) {
      const content = await readFile(join(
        transactionRoot, "before", snapshot.snapshot_name
      ));
      operations.push({
        operation: exists ? "modify" as const : "add" as const,
        path: snapshot.path,
        content
      });
    } else if (exists) {
      operations.push({ operation: "delete" as const, path: snapshot.path });
    }
  }
  return runTransaction(projectRoot, operations, {
    id: "tx_rollback_" + Date.now() + "_" + uuidV7(),
    kind: "rollback"
  });
}

export async function rollbackLatestCommittedUpdate(
  projectRoot: string
): Promise<TransactionResult> {
  const latest = (await listTransactions(projectRoot)).find((item) =>
    item.kind === "update" && item.state === "committed"
  );
  if (latest === undefined) {
    throw new Error("no committed update transaction is available for rollback");
  }
  return rollbackCommittedUpdate(projectRoot, latest.transactionId);
}

export async function cleanupOldTransactions(
  projectRoot: string,
  now = new Date()
): Promise<string[]> {
  const transactions = await listTransactions(projectRoot);
  const committedUpdates = transactions.filter((item) =>
    item.kind === "update" && item.state === "committed"
  );
  const keepCommitted = new Set(committedUpdates.slice(0, 10).map(
    (item) => item.transactionId
  ));
  const removed: string[] = [];
  for (const item of transactions) {
    if (RECOVERY_STATES.has(item.state) || keepCommitted.has(item.transactionId)) {
      continue;
    }
    const ageDays = (now.getTime() - Date.parse(item.createdAt)) / 86_400_000;
    const removable = item.state === "rolled_back"
      ? ageDays > 7
      : item.state === "committed" && ageDays > 30;
    if (!removable) {
      continue;
    }
    await rm(join(stateLayout(projectRoot).transactions, item.transactionId), {
      recursive: true,
      force: true
    });
    removed.push(item.transactionId);
  }
  return removed;
}
