import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

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
import { ensureStateLayout, stateLayout } from "../state/layout.js";
import type {
  SnapshotRecord,
  TransactionJournal,
  TransactionJournalOperation,
  TransactionOperation
} from "./journal.js";
import {
  externalRecoveryTransactionRoot,
  mirrorRecoveryTransaction,
  removeRecoveryMirror,
  restoreRecoveryTransaction
} from "./recovery-store.js";

export interface TransactionOptions {
  id?: string;
  kind?: TransactionJournal["kind"];
  failAfterApply?: number;
  interruptAfterApply?: number;
  allowedProtectedLocalRoots?: readonly typeof PROTECTED_LOCAL_ROOTS[number][];
  projectIdentity?: string;
  cliVersion?: string;
  targetBundleVersion?: string;
  ownershipManifestHash?: string;
}

export interface TransactionResult {
  transactionId: string;
  recoveryId: string;
  planHash: string;
  status: "committed" | "rolled_back";
  protectedLocalRoots: {
    before: ProtectedLocalRootInventory[];
    after: ProtectedLocalRootInventory[];
    unchanged: boolean;
  };
}

export interface ResumeTransactionExpectations {
  projectIdentity?: string;
  targetBundleVersion?: string;
  ownershipManifestHash?: string;
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

async function writeJournal(
  transactionRoot: string,
  journal: TransactionJournal
): Promise<void> {
  journal.updated_at = new Date().toISOString();
  await atomicWriteJson(join(transactionRoot, "journal.json"), journal);
  await writeStatus(transactionRoot, journal);
  if (journal.recovery_store_path !== undefined) {
    if (journal.state === "committed" || journal.state === "rolled_back") {
      await removeRecoveryMirror(journal.recovery_store_path);
    } else {
      await mirrorRecoveryTransaction(
        transactionRoot,
        journal.recovery_store_path
      );
    }
  }
}

async function writeStatus(
  transactionRoot: string,
  journal: TransactionJournal
): Promise<void> {
  const status = {
    schema_version: 1,
    transaction_id: journal.transaction_id,
    recovery_id: journal.recovery_id ?? journal.transaction_id,
    state: journal.state,
    applied_count: journal.applied_count,
    plan_hash: journal.plan_hash ?? null,
    completed_operations: journal.completed_operations ?? [],
    pending_operations: journal.pending_operations ?? [],
    failure: journal.failure,
    failure_reason_code: journal.failure_reason_code ?? null,
    safe_actions: journal.safe_actions ?? [],
    updated_at: new Date().toISOString()
  };
  await atomicWriteJson(join(transactionRoot, "status.json"), status);
  if (
    journal.recovery_store_path !== undefined &&
    journal.state !== "committed" &&
    journal.state !== "rolled_back"
  ) {
    await mkdir(journal.recovery_store_path, { recursive: true });
    await atomicWriteJson(
      join(journal.recovery_store_path, "status.json"),
      status
    );
  }
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
  if (operation.operation === "delete") {
    return { operation: "delete", path: operation.path };
  }
  return {
    operation: operation.operation,
    path: operation.path,
    content_sha256: sha256Bytes(operation.content)
  };
}

async function computeSnapshotDigest(
  transactionRoot: string,
  snapshots: readonly SnapshotRecord[]
): Promise<string> {
  const inventory = [];
  for (const snapshot of snapshots) {
    inventory.push({
      path: snapshot.path,
      existed: snapshot.existed,
      hash: snapshot.snapshot_name === null
        ? null
        : await sha256File(join(
            transactionRoot,
            "before",
            snapshot.snapshot_name
          ))
    });
  }
  return sha256Bytes(JSON.stringify(inventory));
}

function computedPlanHash(journal: TransactionJournal): string {
  return sha256Bytes(JSON.stringify({
    operations: journal.operations,
    projectIdentity: journal.project_identity ?? null,
    targetBundleVersion: journal.target_bundle_version ?? null,
    ownershipManifestHash: journal.ownership_manifest_hash ?? null
  }));
}

function fallbackPlanHash(journal: TransactionJournal): string {
  return journal.plan_hash ?? computedPlanHash(journal);
}

export async function assertTransactionJournalIntegrity(
  transactionRoot: string,
  journal: TransactionJournal
): Promise<void> {
  if (journal.schema_version < 3) return;
  if (journal.plan_hash !== computedPlanHash(journal)) {
    throw new Error("TRANSACTION_PLAN_HASH_MISMATCH");
  }
  if (
    journal.snapshot_digest === undefined ||
    journal.snapshot_digest !== await computeSnapshotDigest(
      transactionRoot,
      journal.snapshots
    )
  ) {
    throw new Error("TRANSACTION_SNAPSHOT_DIGEST_MISMATCH");
  }
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

async function applyOperation(
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

export async function rollbackTransaction(
  projectRoot: string,
  transactionId: string
): Promise<TransactionResult> {
  const transactionRoot = await restoreRecoveryTransaction(
    projectRoot,
    transactionId
  );
  const journal = JSON.parse(
    await readFile(join(transactionRoot, "journal.json"), "utf8")
  ) as TransactionJournal;
  const currentProtectedRoots = await collectProtectedLocalRootsInventory(projectRoot);
  const protectedLocalRoots = journal.protected_local_roots ?? {
    before: currentProtectedRoots,
    after: currentProtectedRoots,
    unchanged: true
  };
  if (journal.state === "committed") {
    return {
      transactionId,
      recoveryId: journal.recovery_id ?? transactionId,
      planHash: fallbackPlanHash(journal),
      status: "committed",
      protectedLocalRoots
    };
  }

  await assertTransactionJournalIntegrity(transactionRoot, journal);
  journal.state = "rolling_back";
  await writeJournal(transactionRoot, journal);
  try {
    for (const snapshot of [...journal.snapshots].reverse()) {
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
    await writeJournal(transactionRoot, journal);
    const afterRollback = await collectProtectedLocalRootsInventory(projectRoot);
    return {
      transactionId,
      recoveryId: journal.recovery_id ?? transactionId,
      planHash: fallbackPlanHash(journal),
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
    await writeJournal(transactionRoot, journal);
    throw error;
  }
}

function durableOperationForApply(
  operation: TransactionJournalOperation
): TransactionOperation {
  if (operation.operation === "rename") {
    return {
      operation: "rename",
      from_path: operation.from_path,
      to_path: operation.to_path,
      content: new Uint8Array()
    };
  }
  if (operation.operation === "delete") {
    return { operation: "delete", path: operation.path };
  }
  return {
    operation: operation.operation,
    path: operation.path,
    content: new Uint8Array()
  };
}

async function assertCompletedOperationState(
  projectRoot: string,
  transactionRoot: string,
  operation: TransactionJournalOperation,
  index: number
): Promise<void> {
  const staged = join(transactionRoot, "staged", String(index));
  if (operation.operation === "delete") {
    if (await exists(join(projectRoot, operation.path))) {
      throw new Error("TRANSACTION_RESUME_STATE_MISMATCH");
    }
    return;
  }
  if (operation.content_sha256 === undefined ||
      await sha256File(staged) !== operation.content_sha256) {
    throw new Error("TRANSACTION_STAGED_CONTENT_MISMATCH");
  }
  const targetPath = operation.operation === "rename"
    ? operation.to_path
    : operation.path;
  const target = join(projectRoot, targetPath);
  if (!await exists(target) || await sha256File(target) !== operation.content_sha256) {
    throw new Error("TRANSACTION_RESUME_STATE_MISMATCH");
  }
  if (
    operation.operation === "rename" &&
    await exists(join(projectRoot, operation.from_path))
  ) {
    throw new Error("TRANSACTION_RESUME_STATE_MISMATCH");
  }
}

async function assertSnapshotPathState(
  projectRoot: string,
  transactionRoot: string,
  snapshot: SnapshotRecord
): Promise<void> {
  const target = join(projectRoot, snapshot.path);
  const present = await exists(target);
  if (present !== snapshot.existed) {
    throw new Error("TRANSACTION_RESUME_PENDING_TARGET_CHANGED: " + snapshot.path);
  }
  if (!present) return;
  if (snapshot.snapshot_name === null) {
    throw new Error("TRANSACTION_SNAPSHOT_RECORD_INVALID: " + snapshot.path);
  }
  const before = join(transactionRoot, "before", snapshot.snapshot_name);
  if (await sha256File(target) !== await sha256File(before)) {
    throw new Error("TRANSACTION_RESUME_PENDING_TARGET_CHANGED: " + snapshot.path);
  }
}

function journalAffectedPaths(
  operation: TransactionJournalOperation
): string[] {
  return operation.operation === "rename"
    ? [operation.from_path, operation.to_path]
    : [operation.path];
}

export async function resumeTransaction(
  projectRoot: string,
  transactionId: string,
  expectations: ResumeTransactionExpectations = {}
): Promise<TransactionResult> {
  const layout = stateLayout(projectRoot);
  const transactionRoot = await restoreRecoveryTransaction(
    projectRoot,
    transactionId
  );
  const journal = JSON.parse(
    await readFile(join(transactionRoot, "journal.json"), "utf8")
  ) as TransactionJournal;
  if (journal.state === "committed") {
    const current = await collectProtectedLocalRootsInventory(projectRoot);
    return {
      transactionId,
      recoveryId: journal.recovery_id ?? transactionId,
      planHash: fallbackPlanHash(journal),
      status: "committed",
      protectedLocalRoots: journal.protected_local_roots ?? {
        before: current,
        after: current,
        unchanged: true
      }
    };
  }
  if (journal.schema_version < 3 ||
      journal.state === "rolling_back" ||
      journal.state === "rolled_back") {
    throw new Error("TRANSACTION_RESUME_UNAVAILABLE");
  }
  await assertTransactionJournalIntegrity(transactionRoot, journal);
  const localProjectIdentity = "local-root:" + sha256Bytes(resolve(projectRoot));
  if (
    journal.project_identity?.startsWith("local-root:") === true &&
    journal.project_identity !== localProjectIdentity
  ) {
    throw new Error("TRANSACTION_PROJECT_IDENTITY_CHANGED");
  }
  if (
    expectations.projectIdentity !== undefined &&
    journal.project_identity !== expectations.projectIdentity
  ) {
    throw new Error("TRANSACTION_PROJECT_IDENTITY_CHANGED");
  }
  if (
    expectations.targetBundleVersion !== undefined &&
    journal.target_bundle_version !== expectations.targetBundleVersion
  ) {
    throw new Error("TRANSACTION_TARGET_BUNDLE_VERSION_CHANGED");
  }
  if (
    expectations.ownershipManifestHash !== undefined &&
    journal.ownership_manifest_hash !== expectations.ownershipManifestHash
  ) {
    throw new Error("TRANSACTION_OWNERSHIP_MANIFEST_CHANGED");
  }
  if (journal.cli_version === "direct-core-api") {
    if (journal.target_bundle_version !== "unchanged") {
      throw new Error("TRANSACTION_TARGET_BUNDLE_VERSION_CHANGED");
    }
    if (
      journal.ownership_manifest_hash !==
      sha256Bytes(JSON.stringify(journal.operations))
    ) {
      throw new Error("TRANSACTION_OWNERSHIP_MANIFEST_CHANGED");
    }
  }

  try {
    const status = JSON.parse(
      await readFile(join(transactionRoot, "status.json"), "utf8")
    ) as {
      completed_operations?: number[];
      pending_operations?: number[];
      applied_count?: number;
    };
    if (Array.isArray(status.completed_operations)) {
      journal.completed_operations = status.completed_operations;
    }
    if (Array.isArray(status.pending_operations)) {
      journal.pending_operations = status.pending_operations;
    }
    journal.applied_count = Math.max(
      journal.applied_count,
      Number(status.applied_count ?? 0)
    );
  } catch {
    // journal.json remains the durable fallback for legacy status projections.
  }
  const completed = new Set(journal.completed_operations ?? []);
  const pending = journal.operations
    .map((_operation, index) => index)
    .filter((index) => !completed.has(index));
  for (const index of completed) {
    const operation = journal.operations[index];
    if (operation === undefined) {
      throw new Error("TRANSACTION_PROGRESS_INVALID");
    }
    await assertCompletedOperationState(
      projectRoot,
      transactionRoot,
      operation,
      index
    );
  }
  for (const index of pending) {
    const operation = journal.operations[index];
    if (operation === undefined) {
      throw new Error("TRANSACTION_PROGRESS_INVALID");
    }
    if (
      operation.operation !== "delete" &&
      (
        operation.content_sha256 === undefined ||
        await sha256File(join(transactionRoot, "staged", String(index))) !==
          operation.content_sha256
      )
    ) {
      throw new Error("TRANSACTION_STAGED_CONTENT_MISMATCH");
    }
    for (const path of journalAffectedPaths(operation)) {
      const snapshot = journal.snapshots.find((item) => item.path === path);
      if (snapshot === undefined) {
        throw new Error("TRANSACTION_SNAPSHOT_RECORD_MISSING: " + path);
      }
      await assertSnapshotPathState(
        projectRoot,
        transactionRoot,
        snapshot
      );
    }
  }
  const protectedBefore = journal.protected_local_roots?.before ??
    await collectProtectedLocalRootsInventory(projectRoot);
  const protectedCurrent = await collectProtectedLocalRootsInventory(projectRoot);
  if (!inventoriesEqual(protectedBefore, protectedCurrent)) {
    throw new Error("PROTECTED_LOCAL_ROOT_INVENTORY_CHANGED");
  }

  journal.completed_operations = [...completed].sort((left, right) => left - right);
  journal.pending_operations = pending;
  journal.applied_count = journal.completed_operations.length;
  journal.state = "applying";
  journal.failure = null;
  journal.failure_reason_code = null;
  journal.safe_actions = ["inspect", "resume", "rollback"];
  await writeJournal(transactionRoot, journal);

  for (const index of pending) {
    const operation = journal.operations[index];
    if (operation === undefined) continue;
    await applyOperation(
      projectRoot,
      transactionRoot,
      durableOperationForApply(operation),
      index,
      transactionId
    );
    journal.completed_operations.push(index);
    journal.pending_operations = journal.pending_operations.filter(
      (candidate) => candidate !== index
    );
    journal.applied_count = journal.completed_operations.length;
    await writeStatus(transactionRoot, journal);
  }

  const after = [];
  for (const snapshot of journal.snapshots) {
    const target = join(projectRoot, snapshot.path);
    after.push({
      path: snapshot.path,
      exists: await exists(target),
      hash: await exists(target) ? await sha256File(target) : null
    });
  }
  await atomicWriteJson(join(transactionRoot, "after", "manifest.json"), after);
  const protectedAfter = await collectProtectedLocalRootsInventory(projectRoot);
  if (!inventoriesEqual(protectedBefore, protectedAfter)) {
    throw new Error("PROTECTED_LOCAL_ROOT_INVENTORY_CHANGED");
  }
  journal.protected_local_roots = {
    before: protectedBefore,
    after: protectedAfter,
    unchanged: true
  };
  journal.state = "committed";
  journal.safe_actions = ["inspect", "rollback"];
  await writeJournal(transactionRoot, journal);
  await rm(join(transactionRoot, "staged"), { recursive: true, force: true });
  await pruneOlderSuccessful(layout, transactionId, journal.kind);
  return {
    transactionId,
    recoveryId: journal.recovery_id ?? transactionId,
    planHash: fallbackPlanHash(journal),
    status: "committed",
    protectedLocalRoots: journal.protected_local_roots
  };
}

export async function runTransaction(
  projectRoot: string,
  rawOperations: readonly TransactionOperation[],
  options: TransactionOptions = {}
): Promise<TransactionResult> {
  const layout = await ensureStateLayout(projectRoot);
  const transactionId = options.id ?? "tx_" + Date.now() + "_" + randomUUID();
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
  const snapshots = await snapshotPaths(projectRoot, transactionRoot, paths);
  await stageOperations(transactionRoot, operations);
  const durableOperations = operations.map(journalOperation);
  const projectIdentity = options.projectIdentity ??
    "local-root:" + sha256Bytes(resolve(projectRoot));
  const cliVersion = options.cliVersion ?? "direct-core-api";
  const targetBundleVersion = options.targetBundleVersion ?? "unchanged";
  const ownershipManifestHash = options.ownershipManifestHash ??
    sha256Bytes(JSON.stringify(durableOperations));
  const planHash = sha256Bytes(JSON.stringify({
    operations: durableOperations,
    projectIdentity,
    targetBundleVersion,
    ownershipManifestHash
  }));
  const journal: TransactionJournal = {
    schema_version: 3,
    transaction_id: transactionId,
    recovery_id: transactionId,
    recovery_store_path: externalRecoveryTransactionRoot(
      projectRoot,
      transactionId
    ),
    ...(options.kind === undefined ? {} : { kind: options.kind }),
    state: "prepared",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    project_identity: projectIdentity,
    cli_version: cliVersion,
    target_bundle_version: targetBundleVersion,
    ownership_manifest_hash: ownershipManifestHash,
    plan_hash: planHash,
    snapshot_digest: await computeSnapshotDigest(transactionRoot, snapshots),
    completed_operations: [],
    pending_operations: operations.map((_operation, index) => index),
    failure_reason_code: null,
    safe_actions: ["inspect", "resume", "rollback"],
    operations: durableOperations,
    snapshots,
    applied_count: 0,
    failure: null,
    protected_local_roots: {
      before: protectedBefore,
      after: protectedBefore,
      unchanged: true
    }
  };
  await writeJournal(transactionRoot, journal);

  try {
    journal.state = "applying";
    await writeJournal(transactionRoot, journal);
    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index];
      if (operation === undefined) {
        continue;
      }
      await applyOperation(projectRoot, transactionRoot, operation, index, transactionId);
      journal.applied_count = index + 1;
      journal.completed_operations = [
        ...(journal.completed_operations ?? []),
        index
      ];
      journal.pending_operations = (journal.pending_operations ?? []).filter(
        (pending) => pending !== index
      );
      // Progress is a small fixed-size status write. journal.json is persisted
      // only at state transitions, so N files no longer cause N rewrites of an
      // O(N + payload) document.
      await writeStatus(transactionRoot, journal);
      if (options.interruptAfterApply === journal.applied_count) {
        journal.state = "interrupted";
        journal.failure = "injected interruption";
        journal.failure_reason_code = "TRANSACTION_INTERRUPTED";
        await writeJournal(transactionRoot, journal);
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
    await atomicWriteJson(join(transactionRoot, "after", "manifest.json"), after);
    const protectedAfter = await collectProtectedLocalRootsInventory(projectRoot);
    const protectedUnchanged = inventoriesEqual(protectedBefore, protectedAfter);
    journal.protected_local_roots = {
      before: protectedBefore,
      after: protectedAfter,
      unchanged: protectedUnchanged
    };
    if (!protectedUnchanged) {
      throw new Error(
        "PROTECTED_LOCAL_ROOT_INVENTORY_CHANGED: protected local state changed " +
        "without a declared transaction operation"
      );
    }
    journal.state = "committed";
    journal.safe_actions = ["inspect", "rollback"];
    await writeJournal(transactionRoot, journal);
  } catch (error) {
    if (error instanceof InterruptedTransactionError) {
      throw error;
    }
    journal.failure = error instanceof Error ? error.message : String(error);
    journal.failure_reason_code = "TRANSACTION_APPLY_FAILED";
    await writeJournal(transactionRoot, journal);
    await rollbackTransaction(projectRoot, transactionId);
    throw error;
  }
  // design §10：成功提交后立即删 staged/（保留 before/after/journal/status 供回滚），
  // 并按 kind 保留最新成功事务，剪除更早的同 kind committed 事务。
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
}

export async function verifyStagedContent(
  content: string | Uint8Array,
  expectedSha256: string
): Promise<void> {
  if (sha256Bytes(content) !== expectedSha256) {
    throw new Error("staged content hash mismatch");
  }
}
