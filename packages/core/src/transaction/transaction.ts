import { randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { canonicalJson } from "@hunter-harness/contracts";

import {
  assertNoCaseCollisions,
  assertNoSymlinks,
  assertSameVolume,
  normalizeManagedPath
} from "../fs/path-safety.js";
import { sha256Bytes, sha256File } from "../fs/hash.js";
import {
  collectProtectedLocalRootsInventory,
  PROTECTED_LOCAL_ROOTS,
  type ProtectedLocalRootInventory
} from "../project/local-state.js";
import { atomicWriteJson } from "../state/atomic.js";
import { ensureStateLayout } from "../state/layout.js";
import type {
  CompletedTargetState,
  SnapshotRecord,
  TransactionJournal,
  TransactionJournalOperation,
  TransactionOperation
} from "./journal.js";
import {
  acquireRecoveryMutationLock,
  assertValidRecoveryId,
  locateRecovery,
  prepareDurableRecovery,
  resolveRecoveryRoot,
  syncDurableRecovery,
  type RecoveryLocation,
  type RecoveryLocationOptions,
  type RecoveryStoreOptions
} from "./recovery-store.js";

export interface TransactionOptions {
  id?: string;
  kind?: TransactionJournal["kind"];
  failAfterApply?: number;
  interruptAfterApply?: number;
  /** @internal deterministic concurrency hook for transaction protocol tests. */
  pauseBeforeApply?: () => Promise<void>;
  allowedProtectedLocalRoots?: readonly typeof PROTECTED_LOCAL_ROOTS[number][];
  projectIdentity?: string;
  cliVersion?: string;
  targetBundleVersion?: string;
  ownershipManifestHash?: string;
  recoveryStore?: RecoveryStoreOptions;
}

export interface TransactionResult {
  transactionId: string;
  recoveryId: string;
  planHash: string | null;
  status: "committed" | "rolled_back";
  protectedLocalRoots: {
    before: ProtectedLocalRootInventory[];
    after: ProtectedLocalRootInventory[];
    unchanged: boolean;
  };
}

export class PlanChangedAfterPreviewError extends Error {
  readonly code = "PLAN_CHANGED_AFTER_PREVIEW";
  readonly exitCode = 5;
  readonly expectedPlanHash: string;
  readonly actualPlanHash: string;

  constructor(expectedPlanHash: string, actualPlanHash: string) {
    super("guarded plan changed after preview; refusing to mutate project");
    this.name = "PlanChangedAfterPreviewError";
    this.expectedPlanHash = expectedPlanHash;
    this.actualPlanHash = actualPlanHash;
  }
}

export function assertExpectedPlanHash(
  expectedPlanHash: string | undefined,
  actualPlanHash: string
): void {
  if (expectedPlanHash !== undefined && expectedPlanHash !== actualPlanHash) {
    throw new PlanChangedAfterPreviewError(expectedPlanHash, actualPlanHash);
  }
}

export class ProtectedLocalRootMutationError extends Error {
  readonly code = "PROTECTED_LOCAL_ROOT_WRITE_FORBIDDEN";
  readonly paths: string[];

  constructor(paths: string[]) {
    super(
      "transaction does not declare write permission for protected local paths: " +
      paths.join(", ")
    );
    this.name = "ProtectedLocalRootMutationError";
    this.paths = paths;
  }
}

class InterruptedTransactionError extends Error {
  constructor() {
    super("transaction interrupted by failure injection");
    this.name = "InterruptedTransactionError";
  }
}

function encodePath(path: string): string {
  return Buffer.from(path).toString("base64url");
}

async function exists(path: string): Promise<boolean> {
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

function affectedPaths(operation: TransactionOperation): string[] {
  if (operation.operation === "rename") {
    return [operation.from_path, operation.to_path];
  }
  return [operation.path];
}

function protectedRootForPath(
  path: string
): typeof PROTECTED_LOCAL_ROOTS[number] | null {
  return PROTECTED_LOCAL_ROOTS.find((root) =>
    path === root || path.startsWith(root + "/")
  ) ?? null;
}

function inventoriesEqual(
  left: readonly ProtectedLocalRootInventory[],
  right: readonly ProtectedLocalRootInventory[]
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function writeTransactionJournal(
  transactionRoot: string,
  journal: TransactionJournal
): Promise<void> {
  journal.updated_at = new Date().toISOString();
  await atomicWriteJson(join(transactionRoot, "journal.json"), journal);
  await writeStatus(transactionRoot, journal);
}

async function writeStatus(
  transactionRoot: string,
  journal: TransactionJournal
): Promise<void> {
  await atomicWriteJson(join(transactionRoot, "status.json"), {
    schema_version: 1,
    transaction_id: journal.transaction_id,
    recovery_id: journal.recovery_id ?? journal.transaction_id,
    state: journal.state,
    applied_count: journal.applied_count,
    completed_operations: journal.completed_operations ?? [],
    pending_operations: journal.pending_operations ?? [],
    completed_target_states: journal.completed_target_states ?? [],
    failure: journal.failure,
    updated_at: new Date().toISOString()
  });
}

function journalOperation(
  operation: TransactionOperation
): TransactionJournalOperation {
  if (operation.operation === "rename") {
    return {
      operation: "rename",
      from_path: operation.from_path,
      to_path: operation.to_path,
      content_sha256: sha256Bytes(operation.content)
    };
  }
  return {
    operation: operation.operation,
    path: operation.path,
    ...(operation.operation === "delete"
      ? {}
      : { content_sha256: sha256Bytes(operation.content) })
  };
}

function planOperation(operation: TransactionOperation): Record<string, unknown> {
  if (operation.operation === "rename") {
    return {
      operation: operation.operation,
      from_path: normalizeManagedPath(operation.from_path),
      to_path: normalizeManagedPath(operation.to_path),
      content_sha256: sha256Bytes(operation.content)
    };
  }
  return {
    operation: operation.operation,
    path: normalizeManagedPath(operation.path),
    ...(operation.operation === "delete"
      ? {}
      : { content_sha256: sha256Bytes(operation.content) })
  };
}

export function transactionPlanHash(
  operations: readonly TransactionOperation[],
  options: Pick<
    TransactionOptions,
    "kind" | "projectIdentity" | "cliVersion" | "targetBundleVersion" |
    "ownershipManifestHash"
  >,
  protectedPathInventory: readonly ProtectedLocalRootInventory[]
): string {
  return sha256Bytes(canonicalJson({
    kind: options.kind ?? null,
    project_identity: options.projectIdentity ?? null,
    cli_version: options.cliVersion ?? null,
    target_bundle_version: options.targetBundleVersion ?? null,
    ownership_manifest_hash: options.ownershipManifestHash ?? null,
    protected_path_inventory: protectedPathInventory,
    operations: operations.map(planOperation)
  }));
}

export function transactionJournalPlanHash(
  journal: TransactionJournal
): string {
  return sha256Bytes(canonicalJson({
    kind: journal.kind ?? null,
    project_identity: journal.project_identity ?? null,
    cli_version: journal.cli_version ?? null,
    target_bundle_version: journal.target_bundle_version ?? null,
    ownership_manifest_hash: journal.ownership_manifest_hash ?? null,
    protected_path_inventory: journal.protected_local_roots?.before ?? [],
    operations: journal.operations.map((operation) => {
      if (operation.operation === "rename") {
        return {
          operation: operation.operation,
          from_path: operation.from_path,
          to_path: operation.to_path,
          content_sha256: operation.content_sha256
        };
      }
      return {
        operation: operation.operation,
        path: operation.path,
        ...(operation.operation === "delete"
          ? {}
          : { content_sha256: operation.content_sha256 })
      };
    })
  }));
}

export async function computeSnapshotDigest(
  transactionRoot: string,
  snapshots: readonly SnapshotRecord[]
): Promise<string> {
  const entries = [];
  for (const snapshot of snapshots) {
    entries.push({
      path: snapshot.path,
      existed: snapshot.existed,
      content_sha256: snapshot.snapshot_name === null
        ? null
        : await sha256File(join(transactionRoot, "before", snapshot.snapshot_name))
    });
  }
  return sha256Bytes(canonicalJson(entries));
}

// design §10：提交后剪除同 kind 的更早成功事务，仅保留最新一个供回滚。
// 只读 journal.json 判定 state/kind，绝不动非 committed（interrupted/failed/recovery_required）事务。
async function pruneOlderSuccessful(
  layout: { transactions: string },
  currentId: string,
  kind: string | undefined
): Promise<void> {
  if (kind === undefined) return;
  let entries: string[];
  try {
    entries = await readdir(layout.transactions);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  for (const name of entries) {
    if (name === currentId) continue;
    const txRoot = join(layout.transactions, name);
    try {
      const journal = JSON.parse(await readFile(join(txRoot, "journal.json"), "utf8")) as {
        state?: string; kind?: string;
      };
      if (journal.state === "committed" && journal.kind === kind) {
        await rm(txRoot, { recursive: true, force: true });
      }
    } catch {
      continue;
    }
  }
}

async function snapshotPaths(
  projectRoot: string,
  transactionRoot: string,
  paths: readonly string[]
): Promise<SnapshotRecord[]> {
  const snapshots: SnapshotRecord[] = [];
  for (const path of paths) {
    const target = join(projectRoot, path);
    const present = await exists(target);
    const snapshotName = present ? encodePath(path) : null;
    if (snapshotName !== null) {
      await copyFile(target, join(transactionRoot, "before", snapshotName));
    }
    snapshots.push({ path, existed: present, snapshot_name: snapshotName });
  }
  return snapshots;
}

async function stageOperations(
  transactionRoot: string,
  operations: readonly TransactionOperation[]
): Promise<void> {
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    if (operation?.operation === "add" || operation?.operation === "modify" ||
        operation?.operation === "rename") {
      await writeFile(join(transactionRoot, "staged", String(index)), operation.content);
    }
  }
}

async function installStaged(
  staged: string,
  target: string,
  transactionId: string
): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  assertSameVolume(staged, target);
  const temporary = join(
    dirname(target),
    ".hunter-" + transactionId + "-" + randomUUID() + ".tmp"
  );
  await copyFile(staged, temporary);
  await rm(target, { force: true });
  await rename(temporary, target);
}

export async function applyTransactionOperation(
  projectRoot: string,
  transactionRoot: string,
  operation: TransactionOperation,
  index: number,
  transactionId: string
): Promise<void> {
  if (operation.operation === "delete") {
    await rm(join(projectRoot, operation.path), { force: true });
    return;
  }
  if (operation.operation === "rename") {
    await rm(join(projectRoot, operation.from_path), { force: true });
    await installStaged(
      join(transactionRoot, "staged", String(index)),
      join(projectRoot, operation.to_path),
      transactionId
    );
    return;
  }
  await installStaged(
    join(transactionRoot, "staged", String(index)),
    join(projectRoot, operation.path),
    transactionId
  );
}

export async function transactionTargetState(
  projectRoot: string,
  operation: TransactionJournalOperation,
  operationIndex: number
): Promise<CompletedTargetState> {
  const paths = operation.operation === "rename"
    ? [operation.from_path, operation.to_path]
    : [operation.path];
  const targets = [];
  for (const path of paths) {
    const target = join(projectRoot, path);
    const present = await exists(target);
    targets.push({
      path,
      exists: present,
      hash: present ? await sha256File(target) : null
    });
  }
  return { operation_index: operationIndex, targets };
}

function recoveryPrecondition(message: string): Error {
  return Object.assign(new Error(message), {
    code: "RECOVERY_PRECONDITION_FAILED"
  });
}

export function assertJournalCheckpoint(journal: TransactionJournal): void {
  const operationIndexes = journal.operations.map((_item, index) => index);
  const completed = journal.completed_operations ??
    operationIndexes.filter((index) => index < journal.applied_count);
  const pending = journal.pending_operations ??
    operationIndexes.filter((index) => index >= journal.applied_count);
  const completedSet = new Set(completed);
  const pendingSet = new Set(pending);
  const valid = completed.length === completedSet.size &&
    pending.length === pendingSet.size &&
    completed.every((index) =>
      Number.isInteger(index) && operationIndexes.includes(index)
    ) &&
    pending.every((index) =>
      Number.isInteger(index) && operationIndexes.includes(index)
    ) &&
    completed.every((index) => !pendingSet.has(index)) &&
    [...completed, ...pending].sort((left, right) => left - right)
      .every((index, position) => index === operationIndexes[position]) &&
    journal.applied_count === completed.length;
  if (!valid) {
    throw recoveryPrecondition("recovery checkpoint partition is inconsistent");
  }
  if (journal.schema_version === 3) {
    const targetStateIndexes = (journal.completed_target_states ?? [])
      .map((item) => item.operation_index);
    if (targetStateIndexes.length !== completed.length ||
        completed.some((index) => !targetStateIndexes.includes(index))) {
      throw recoveryPrecondition(
        "schema v3 recovery checkpoint is missing a completed target state"
      );
    }
  }
}

async function assertRollbackPreconditions(
  projectRoot: string,
  location: RecoveryLocation,
  journal: TransactionJournal,
  completed: readonly number[],
  restorePaths: ReadonlySet<string>
): Promise<void> {
  assertJournalCheckpoint(journal);
  if (journal.schema_version === 3 &&
      (typeof journal.plan_hash !== "string" ||
        transactionJournalPlanHash(journal) !== journal.plan_hash)) {
    throw recoveryPrecondition("recovery plan metadata has drifted");
  }
  for (const path of restorePaths) {
    try {
      await assertNoSymlinks(projectRoot, path);
    } catch {
      throw recoveryPrecondition(
        "rollback target path is no longer symlink-safe"
      );
    }
  }
  for (const completedState of journal.completed_target_states ?? []) {
    if (!completed.includes(completedState.operation_index)) continue;
    const operation = journal.operations[completedState.operation_index];
    if (operation === undefined) {
      throw recoveryPrecondition("completed operation metadata is invalid");
    }
    const current = await transactionTargetState(
      projectRoot,
      operation,
      completedState.operation_index
    );
    if (JSON.stringify(current) !== JSON.stringify(completedState)) {
      throw recoveryPrecondition("a completed target changed after interruption");
    }
  }

  const beforeRoot = join(location.transactionRoot, "before");
  const beforeStat = await lstat(beforeRoot).catch(() => null);
  if (beforeStat === null || beforeStat.isSymbolicLink() ||
      !beforeStat.isDirectory()) {
    throw recoveryPrecondition("recovery snapshot directory is unavailable");
  }
  const relevantSnapshots = journal.snapshots.filter((snapshot) =>
    restorePaths.has(snapshot.path)
  );
  if ([...restorePaths].some((path) =>
    !relevantSnapshots.some((snapshot) => snapshot.path === path)
  )) {
    throw recoveryPrecondition(
      "recovery journal is missing a required target snapshot"
    );
  }
  for (const snapshot of relevantSnapshots) {
    if (!snapshot.existed) continue;
    if (snapshot.snapshot_name === null) {
      throw recoveryPrecondition("recovery snapshot metadata is incomplete");
    }
    const snapshotStat = await lstat(
      join(beforeRoot, snapshot.snapshot_name)
    ).catch(() => null);
    if (snapshotStat === null || snapshotStat.isSymbolicLink() ||
        !snapshotStat.isFile()) {
      throw recoveryPrecondition("recovery snapshot payload is unavailable");
    }
  }

  try {
    if (location.source === "project") {
      if (journal.schema_version === 3) {
        if (typeof journal.snapshot_digest !== "string" ||
            await computeSnapshotDigest(
              location.transactionRoot,
              journal.snapshots
            ) !== journal.snapshot_digest) {
          throw recoveryPrecondition(
            "SNAPSHOT_DIGEST_MISMATCH: recovery snapshot digest does not match"
          );
        }
      }
      return;
    }

    const mirror = location.mirror;
    if (mirror === null) {
      throw recoveryPrecondition("durable recovery mirror metadata is unavailable");
    }
    const mirroredPathSet = new Set(mirror.mirroredSnapshotPaths);
    if (mirroredPathSet.size !== mirror.mirroredSnapshotPaths.length ||
        relevantSnapshots.some((snapshot) =>
          !mirroredPathSet.has(snapshot.path)
        )) {
      throw recoveryPrecondition(
        "durable recovery mirror does not contain every required snapshot"
      );
    }
    const mirroredSnapshots = journal.snapshots.filter((snapshot) =>
      mirroredPathSet.has(snapshot.path)
    );
    if (mirroredSnapshots.length !== mirroredPathSet.size ||
        await computeSnapshotDigest(
          location.transactionRoot,
          mirroredSnapshots
        ) !== mirror.snapshotDigest) {
      throw recoveryPrecondition(
        "SNAPSHOT_DIGEST_MISMATCH: durable recovery snapshot digest does not match"
      );
    }
  } catch (error) {
    if (error instanceof Error && "code" in error &&
        error.code === "RECOVERY_PRECONDITION_FAILED") {
      throw error;
    }
    throw recoveryPrecondition("recovery snapshot integrity could not be verified");
  }
}

export async function assertRollbackRecoveryPreconditions(
  projectRoot: string,
  location: RecoveryLocation,
  journal: TransactionJournal
): Promise<void> {
  const completed = journal.completed_operations ??
    journal.operations.map((_operation, index) => index)
      .filter((index) => index < journal.applied_count);
  const restorePaths = new Set(completed.flatMap((index) => {
    const operation = journal.operations[index];
    if (operation === undefined) return [];
    return operation.operation === "rename"
      ? [operation.from_path, operation.to_path]
      : [operation.path];
  }));
  await assertRollbackPreconditions(
    projectRoot,
    location,
    journal,
    completed,
    restorePaths
  );
}

async function rollbackTransactionWithoutLock(
  projectRoot: string,
  transactionId: string,
  options: RecoveryLocationOptions = {}
): Promise<TransactionResult> {
  const location = await locateRecovery(projectRoot, transactionId, options);
  if (location === null) {
    throw Object.assign(new Error("recoveryId does not exist"), {
      code: "RECOVERY_NOT_FOUND"
    });
  }
  const transactionRoot = location.transactionRoot;
  const journal = JSON.parse(
      await readFile(join(transactionRoot, "journal.json"), "utf8")
    ) as TransactionJournal;
    const currentProtectedRoots = await collectProtectedLocalRootsInventory(projectRoot);
    const protectedLocalRoots = journal.protected_local_roots ?? {
      before: currentProtectedRoots,
      after: currentProtectedRoots,
      unchanged: true
    };
    if (journal.state === "committed" || journal.state === "rolled_back") {
      return {
        transactionId: journal.transaction_id,
        recoveryId: journal.recovery_id ?? transactionId,
        planHash: journal.plan_hash ?? null,
        status: journal.state,
        protectedLocalRoots
      };
    }

    const completed = journal.completed_operations ??
      journal.operations.map((_operation, index) => index)
        .filter((index) => index < journal.applied_count);
    if (location.source === "durable" && completed.some((index) =>
      !location.mirror?.mirroredOperationIndexes.includes(index)
    )) {
      throw Object.assign(new Error(
        "durable mirror does not contain every applied managed operation"
      ), { code: "RECOVERY_PRECONDITION_FAILED" });
    }
    const restorePaths = new Set(completed.flatMap((index) => {
      const operation = journal.operations[index];
      if (operation === undefined) return [];
      return operation.operation === "rename"
        ? [operation.from_path, operation.to_path]
        : [operation.path];
    }));
    await assertRollbackRecoveryPreconditions(projectRoot, location, journal);
    journal.state = "rolling_back";
    await writeTransactionJournal(transactionRoot, journal);
    if (location.source === "project" && options.recoveryRoot !== undefined) {
      await syncDurableRecovery(projectRoot, journal, {
        root: options.recoveryRoot
      });
    }
    try {
      for (const snapshot of [...journal.snapshots].reverse()) {
        if (!restorePaths.has(snapshot.path)) continue;
        const target = join(projectRoot, snapshot.path);
        await rm(target, { force: true, recursive: true });
        if (snapshot.existed && snapshot.snapshot_name !== null) {
          await mkdir(dirname(target), { recursive: true });
          await copyFile(
            join(transactionRoot, "before", snapshot.snapshot_name),
            target
          );
        }
      }
      journal.state = "rolled_back";
      await writeTransactionJournal(transactionRoot, journal);
      if (location.source === "project" && options.recoveryRoot !== undefined) {
        await syncDurableRecovery(projectRoot, journal, {
          root: options.recoveryRoot
        });
      }
      const afterRollback = await collectProtectedLocalRootsInventory(projectRoot);
      return {
        transactionId: journal.transaction_id,
        recoveryId: journal.recovery_id ?? transactionId,
        planHash: journal.plan_hash ?? null,
        status: "rolled_back",
        protectedLocalRoots: {
          before: protectedLocalRoots.before,
          after: afterRollback,
          unchanged: inventoriesEqual(protectedLocalRoots.before, afterRollback)
        }
      };
    } catch (error) {
      journal.state = "recovery_required";
      journal.failure = error instanceof Error ? error.message : String(error);
      await writeTransactionJournal(transactionRoot, journal);
      if (location.source === "project" && options.recoveryRoot !== undefined) {
        await syncDurableRecovery(projectRoot, journal, {
          root: options.recoveryRoot
        });
      }
      throw error;
    }
}

export async function rollbackTransaction(
  projectRoot: string,
  transactionId: string,
  options: RecoveryLocationOptions = {}
): Promise<TransactionResult> {
  const location = await locateRecovery(projectRoot, transactionId, options);
  if (location === null) {
    throw Object.assign(new Error("recoveryId does not exist"), {
      code: "RECOVERY_NOT_FOUND"
    });
  }
  const release = await acquireRecoveryMutationLock(location.transactionRoot);
  try {
    return await rollbackTransactionWithoutLock(
      projectRoot,
      transactionId,
      options
    );
  } finally {
    await release();
  }
}

export async function runTransaction(
  projectRoot: string,
  rawOperations: readonly TransactionOperation[],
  options: TransactionOptions = {}
): Promise<TransactionResult> {
  const layout = await ensureStateLayout(projectRoot);
  const transactionId = options.id ?? "tx_" + Date.now() + "_" + randomUUID();
  assertValidRecoveryId(transactionId);
  const transactionRoot = join(layout.transactions, transactionId);
  await Promise.all([
    mkdir(join(transactionRoot, "before"), { recursive: true }),
    mkdir(join(transactionRoot, "after"), { recursive: true }),
    mkdir(join(transactionRoot, "staged"), { recursive: true })
  ]);

  const operations = rawOperations.map((operation): TransactionOperation => {
    if (operation.operation === "rename") {
      return {
        ...operation,
        from_path: normalizeManagedPath(operation.from_path),
        to_path: normalizeManagedPath(operation.to_path)
      };
    }
    return { ...operation, path: normalizeManagedPath(operation.path) };
  });
  const paths = operations.flatMap(affectedPaths);
  const recoveryStore = options.recoveryStore ??
    (process.env.HUNTER_HARNESS_RECOVERY_ROOT?.trim()
      ? {
          root: resolveRecoveryRoot(),
          managedPaths: paths
        }
      : undefined);
  assertNoCaseCollisions(paths);
  const allowedProtectedRoots = new Set(options.allowedProtectedLocalRoots ?? []);
  const forbiddenProtectedPaths = paths.filter((path) => {
    const protectedRoot = protectedRootForPath(path);
    return protectedRoot !== null && !allowedProtectedRoots.has(protectedRoot);
  });
  if (forbiddenProtectedPaths.length > 0) {
    throw new ProtectedLocalRootMutationError(forbiddenProtectedPaths);
  }
  for (const path of paths) {
    await assertNoSymlinks(projectRoot, path);
  }

  const protectedBefore = await collectProtectedLocalRootsInventory(projectRoot);
  const planHash = transactionPlanHash(operations, options, protectedBefore);
  const snapshots = await snapshotPaths(projectRoot, transactionRoot, paths);
  const snapshotDigest = await computeSnapshotDigest(transactionRoot, snapshots);
  await stageOperations(transactionRoot, operations);
  const journal: TransactionJournal = {
    schema_version: 3,
    transaction_id: transactionId,
    recovery_id: transactionId,
    ...(options.kind === undefined ? {} : { kind: options.kind }),
    state: "prepared",
    created_at: new Date().toISOString(),
    operations: operations.map(journalOperation),
    snapshots,
    applied_count: 0,
    failure: null,
    project_identity: options.projectIdentity ?? null,
    cli_version: options.cliVersion ?? null,
    target_bundle_version: options.targetBundleVersion ?? null,
    ownership_manifest_hash: options.ownershipManifestHash ?? null,
    plan_hash: planHash,
    snapshot_digest: snapshotDigest,
    completed_operations: [],
    pending_operations: operations.map((_operation, index) => index),
    completed_target_states: [],
    verification_outcomes: [],
    protected_local_roots: {
      before: protectedBefore,
      after: protectedBefore,
      unchanged: true
    }
  };
  const release = await acquireRecoveryMutationLock(transactionRoot);
  try {
    await writeTransactionJournal(transactionRoot, journal);
    if (recoveryStore !== undefined) {
      await prepareDurableRecovery(
        projectRoot,
        transactionRoot,
        journal,
        recoveryStore
      );
    }
    await options.pauseBeforeApply?.();
    try {
      journal.state = "applying";
      await writeTransactionJournal(transactionRoot, journal);
      if (recoveryStore !== undefined) {
        await syncDurableRecovery(projectRoot, journal, recoveryStore);
      }
      for (let index = 0; index < operations.length; index += 1) {
        const operation = operations[index];
        if (operation === undefined) {
          continue;
        }
        await applyTransactionOperation(
          projectRoot,
          transactionRoot,
          operation,
          index,
          transactionId
        );
        journal.applied_count = index + 1;
        journal.completed_operations = operations
          .map((_item, operationIndex) => operationIndex)
          .filter((operationIndex) => operationIndex < journal.applied_count);
        journal.pending_operations = operations
          .map((_item, operationIndex) => operationIndex)
          .filter((operationIndex) => operationIndex >= journal.applied_count);
        journal.completed_target_states = [
          ...(journal.completed_target_states ?? []).filter(
            (item) => item.operation_index !== index
          ),
          await transactionTargetState(
            projectRoot,
            journal.operations[index] ?? journalOperation(operation),
            index
          )
        ];
        // The canonical checkpoint must reach disk before another operation
        // can begin. Recovery never guesses between status and journal.
        await writeTransactionJournal(transactionRoot, journal);
        if (recoveryStore !== undefined) {
          await syncDurableRecovery(projectRoot, journal, recoveryStore);
        }
        if (options.interruptAfterApply === journal.applied_count) {
          journal.state = "interrupted";
          journal.failure = "injected interruption";
          await writeTransactionJournal(transactionRoot, journal);
          if (recoveryStore !== undefined) {
            await syncDurableRecovery(
              projectRoot,
              journal,
              recoveryStore
            );
          }
          throw new InterruptedTransactionError();
        }
        if (options.failAfterApply === journal.applied_count) {
          throw new Error("injected transaction failure");
        }
      }

      const after = [];
      for (const path of paths) {
        const target = join(projectRoot, path);
        after.push({
          path,
          exists: await exists(target),
          hash: await exists(target) ? await sha256File(target) : null
        });
      }
      await atomicWriteJson(
        join(transactionRoot, "after", "manifest.json"),
        after
      );
      const protectedAfter = await collectProtectedLocalRootsInventory(projectRoot);
      const protectedUnchanged = inventoriesEqual(protectedBefore, protectedAfter);
      journal.protected_local_roots = {
        before: protectedBefore,
        after: protectedAfter,
        unchanged: protectedUnchanged
      };
      if (!protectedUnchanged) {
        journal.verification_outcomes = [{
          name: "protected-local-roots",
          status: "failed",
          detail: "inventory changed without a declared transaction operation"
        }];
        throw new Error(
          "PROTECTED_LOCAL_ROOT_INVENTORY_CHANGED: protected local state changed " +
          "without a declared transaction operation"
        );
      }
      journal.verification_outcomes = [{
        name: "protected-local-roots",
        status: "passed"
      }];
      journal.state = "committed";
      await writeTransactionJournal(transactionRoot, journal);
      if (recoveryStore !== undefined) {
        await syncDurableRecovery(projectRoot, journal, recoveryStore);
      }
    } catch (error) {
      if (error instanceof InterruptedTransactionError) {
        throw error;
      }
      journal.failure = error instanceof Error ? error.message : String(error);
      await writeTransactionJournal(transactionRoot, journal);
      if (recoveryStore !== undefined) {
        await syncDurableRecovery(projectRoot, journal, recoveryStore);
      }
      await rollbackTransactionWithoutLock(projectRoot, transactionId);
      throw error;
    }
    // 成功提交后删 staged/，并按 kind 保留最新成功事务。
    await rm(join(transactionRoot, "staged"), { recursive: true, force: true });
    await pruneOlderSuccessful(layout, transactionId, options.kind);
    return {
      transactionId,
      recoveryId: transactionId,
      planHash,
      status: "committed",
      protectedLocalRoots: journal.protected_local_roots ?? {
        before: protectedBefore,
        after: protectedBefore,
        unchanged: true
      }
    };
  } finally {
    await release();
  }
}

export async function verifyStagedContent(
  content: string | Uint8Array,
  expectedSha256: string
): Promise<void> {
  if (sha256Bytes(content) !== expectedSha256) {
    throw new Error("staged content hash mismatch");
  }
}
