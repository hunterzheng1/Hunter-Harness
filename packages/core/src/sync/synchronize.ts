import { lstat, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  artifactManifestSchema,
  baselineManifestSchema,
  canonicalJson,
  type ArtifactManifest,
  type BaselineManifest,
  type FileOperation,
  type ProjectConfig
} from "@hunter-harness/contracts";

import { HunterHarnessApiClient } from "../api/client.js";
import { sha256Bytes, sha256File } from "../fs/hash.js";
import { extractManagedBlock } from "../managed/managed-block.js";
import { atomicWriteFile, atomicWriteJson } from "../state/atomic.js";
import { acquireProtocolLock } from "../state/locks.js";
import type { TransactionOperation } from "../transaction/journal.js";
import { runTransaction, type TransactionOptions } from "../transaction/transaction.js";
import {
  operationSourcePath,
  operationTargetPath,
  type UpdateConflict
} from "../update/conflicts.js";
import {
  planArtifactRebase,
  type ArtifactRebasePlan,
  type ConflictStrategy,
  type OperationContext,
  type PerPathResolveStrategy,
  type PlannedWrite,
  type RebaseConflict
} from "./artifact-rebase.js";

export type { ConflictStrategy, PerPathResolveStrategy, RebaseConflict } from "./artifact-rebase.js";

export const MAX_SYNC_ARTIFACT_ITERATIONS = 50;

export interface SynchronizeOptions {
  projectRoot: string;
  project: ProjectConfig;
  client: HunterHarnessApiClient;
  requestId: string;
  dryRun: boolean;
  conflictStrategy?: ConflictStrategy;
  resolveOverrides?: ReadonlyMap<string, PerPathResolveStrategy>;
  confirmConflictStrategy?: (
    conflicts: readonly RebaseConflict[]
  ) => Promise<ConflictStrategy | false>;
  transactionOptions?: Omit<TransactionOptions, "id">;
  stopAfterArtifactId?: string | null;
}

export interface SynchronizeResult {
  requestId: string;
  projectId: string;
  artifactsProcessed: number;
  applied: string[];
  acknowledged: UpdateConflict[];
  resolvedKeepLocal: string[];
  resolvedAcceptRemote: string[];
  alreadyApplied: string[];
  conflicts: RebaseConflict[];
  skipped: UpdateConflict[];
  operations: readonly FileOperation[];
  artifactId: string | null;
  observedProjectVersion: string | null;
  transactionId: string | null;
  dryRun: boolean;
  baselineAdvanced: boolean;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function optionalContent(root: string, path: string): Promise<string | null> {
  const full = join(root, path);
  return await pathExists(full) ? readFile(full, "utf8") : null;
}

function manifestPayloadHash(manifest: ArtifactManifest): string {
  const payload: Partial<ArtifactManifest> = { ...manifest };
  delete payload.manifest_sha256;
  return sha256Bytes(canonicalJson(payload));
}

async function loadBlob(
  root: string,
  client: HunterHarnessApiClient,
  artifactId: string,
  operation: FileOperation,
  requestId: string,
  dryRun: boolean
): Promise<string | null> {
  if (operation.operation === "delete") {
    return null;
  }
  const hash = operation.content_sha256;
  const cacheRoot = join(root, ".harness", "cache", "server-artifacts", artifactId);
  const cachePath = join(cacheRoot, "blobs", hash.replace(":", "_"));
  if (await pathExists(cachePath) && await sha256File(cachePath) === hash) {
    return readFile(cachePath, "utf8");
  }
  const bytes = await client.downloadArtifactBlob(artifactId, hash, requestId);
  if (bytes.byteLength !== operation.size_bytes || sha256Bytes(bytes) !== hash) {
    await rm(cachePath, { force: true });
    throw new Error("ARTIFACT_HASH_MISMATCH");
  }
  if (!dryRun) {
    await atomicWriteFile(cachePath, bytes);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function writeFromPlan(
  item: PlannedWrite,
  keepLocalNoWrite: boolean
): TransactionOperation | null {
  if (keepLocalNoWrite || item.equivalent) {
    return null;
  }
  const operation = item.operation;
  const target = operationTargetPath(operation);
  if (operation.operation === "delete") {
    return { operation: "delete", path: target };
  }
  if (operation.operation === "rename") {
    return {
      operation: "rename",
      from_path: operation.from_path,
      to_path: operation.to_path,
      content: item.content ?? ""
    };
  }
  return {
    operation: "modify",
    path: target,
    content: item.content ?? ""
  };
}

function collectWrites(plan: ArtifactRebasePlan): TransactionOperation[] {
  const ops: TransactionOperation[] = [];
  for (const item of plan.applied) {
    const op = writeFromPlan(item, false);
    if (op !== null) ops.push(op);
  }
  for (const item of plan.resolvedAcceptRemote) {
    const op = writeFromPlan(item, false);
    if (op !== null) ops.push(op);
  }
  for (const item of plan.resolvedKeepLocal) {
    const op = writeFromPlan(item, true);
    if (op !== null) ops.push(op);
  }
  return ops;
}

function pathsFromPlan(plan: ArtifactRebasePlan): {
  applied: string[];
  acknowledged: UpdateConflict[];
  resolvedKeepLocal: string[];
  resolvedAcceptRemote: string[];
  alreadyApplied: string[];
} {
  const applied = plan.applied.map((item) => item.path);
  const acknowledged = plan.acknowledged.map((item) => ({
    path: item.path,
    operation: item.operation.operation,
    reason: item.acknowledgeReason ?? "policy-never" as const
  }));
  return {
    applied,
    acknowledged,
    resolvedKeepLocal: plan.resolvedKeepLocal.map((item) => item.path),
    resolvedAcceptRemote: plan.resolvedAcceptRemote.map((item) => item.path),
    alreadyApplied: plan.alreadyApplied.map((item) => item.path)
  };
}

async function buildContexts(
  root: string,
  manifest: ArtifactManifest,
  client: HunterHarnessApiClient,
  requestId: string,
  dryRun: boolean
): Promise<OperationContext[]> {
  const contexts: OperationContext[] = [];
  for (const operation of manifest.files) {
    const source = operationSourcePath(operation);
    const target = operationTargetPath(operation);
    const incoming = await loadBlob(root, client, manifest.artifact_id, operation, requestId, dryRun);
    contexts.push({
      operation,
      incomingContent: incoming,
      sourceContent: await optionalContent(root, source),
      targetContent: target === source
        ? await optionalContent(root, source)
        : await optionalContent(root, target)
    });
  }
  return contexts;
}

function applyBaselineUpdates(
  baseline: BaselineManifest,
  plan: ArtifactRebasePlan
): BaselineManifest {
  const next = baselineManifestSchema.parse(structuredClone(baseline));
  for (const update of plan.baselineUpdates) {
    next.files[update.path] = update.entry;
  }
  return next;
}

async function planSingleArtifact(
  root: string,
  baseline: BaselineManifest,
  manifest: ArtifactManifest,
  client: HunterHarnessApiClient,
  requestId: string,
  dryRun: boolean,
  conflictStrategy: ConflictStrategy,
  resolveOverrides?: ReadonlyMap<string, PerPathResolveStrategy>
): Promise<ArtifactRebasePlan> {
  if (manifest.project_version === null) {
    throw new Error("artifact manifest missing project_version");
  }
  const contexts = await buildContexts(root, manifest, client, requestId, dryRun);
  return planArtifactRebase({
    baseline,
    projectVersion: manifest.project_version,
    contexts,
    conflictStrategy,
    ...(resolveOverrides === undefined ? {} : { resolveOverrides })
  });
}

async function saveConflictReport(
  root: string,
  requestId: string,
  manifest: ArtifactManifest,
  plan: ArtifactRebasePlan
): Promise<void> {
  const reportPath = join(root, ".harness", "reports", "conflicts-" + requestId + ".json");
  await atomicWriteJson(reportPath, {
    schema_version: 1,
    request_id: requestId,
    artifact_id: manifest.artifact_id,
    project_version: manifest.project_version,
    conflicts: plan.conflicts,
    resolve_hint: "npx hunter-harness update --resolve <path>=keep-local|accept-remote"
  });
}

export async function synchronizeArtifacts(
  options: SynchronizeOptions,
  initialBaseline: BaselineManifest
): Promise<SynchronizeResult> {
  const root = resolve(options.projectRoot);
  const projectId = options.project.project.project_id;
  if (projectId === null) {
    throw new Error("PROJECT_NOT_BOUND");
  }
  let baseline = initialBaseline;
  const seenArtifactIds = new Set<string>();
  const aggregate: SynchronizeResult = {
    requestId: options.requestId,
    projectId,
    artifactsProcessed: 0,
    applied: [],
    acknowledged: [],
    resolvedKeepLocal: [],
    resolvedAcceptRemote: [],
    alreadyApplied: [],
    conflicts: [],
    skipped: [],
    operations: [],
    artifactId: null,
    observedProjectVersion: null,
    transactionId: null,
    dryRun: options.dryRun,
    baselineAdvanced: false
  };
  const conflictStrategy = options.conflictStrategy ?? "manual";

  for (let iteration = 0; iteration < MAX_SYNC_ARTIFACT_ITERATIONS; iteration++) {
    const discovery = await options.client.getUpdateManifest(
      projectId,
      {
        base_project_version: baseline.complete_project_version,
        base_manifest_hash: sha256Bytes(canonicalJson(baseline)),
        adapter: options.project.adapters.enabled[0] ?? "claude-code",
        profile: options.project.project.profiles[0] ?? "general"
      },
      options.requestId
    );
    aggregate.observedProjectVersion = discovery.observed_project_version;
    if (!discovery.delta_available || discovery.artifact_id === null) {
      aggregate.baselineAdvanced = aggregate.conflicts.length === 0;
      return aggregate;
    }
    if (seenArtifactIds.has(discovery.artifact_id)) {
      throw new Error("DUPLICATE_ARTIFACT_ID:" + discovery.artifact_id);
    }
    seenArtifactIds.add(discovery.artifact_id);
    if (options.stopAfterArtifactId === discovery.artifact_id) {
      return aggregate;
    }

    const manifest = artifactManifestSchema.parse(
      await options.client.getArtifactManifest(discovery.artifact_id, options.requestId)
    );
    if (manifest.artifact_id !== discovery.artifact_id ||
        manifest.project_id !== projectId ||
        manifest.project_version === null ||
        manifestPayloadHash(manifest) !== manifest.manifest_sha256) {
      throw new Error("ARTIFACT_HASH_MISMATCH");
    }

    let plan = await planSingleArtifact(
      root,
      baseline,
      manifest,
      options.client,
      options.requestId,
      options.dryRun,
      conflictStrategy,
      options.resolveOverrides
    );

    if (plan.conflicts.length > 0 && options.confirmConflictStrategy !== undefined) {
      const confirmed = await options.confirmConflictStrategy(plan.conflicts);
      if (confirmed === false) {
        aggregate.conflicts = plan.conflicts;
        aggregate.skipped = plan.conflicts.map((item) => ({
          path: item.path,
          operation: item.operation,
          reason: item.reason
        }));
        aggregate.operations = manifest.files;
        aggregate.artifactId = manifest.artifact_id;
        return aggregate;
      }
      plan = await planSingleArtifact(
        root,
        baseline,
        manifest,
        options.client,
        options.requestId,
        options.dryRun,
        confirmed,
        options.resolveOverrides
      );
    }

    const paths = pathsFromPlan(plan);
    aggregate.applied.push(...paths.applied);
    aggregate.acknowledged.push(...paths.acknowledged);
    aggregate.resolvedKeepLocal.push(...paths.resolvedKeepLocal);
    aggregate.resolvedAcceptRemote.push(...paths.resolvedAcceptRemote);
    aggregate.alreadyApplied.push(...paths.alreadyApplied);
    aggregate.operations = manifest.files;
    aggregate.artifactId = manifest.artifact_id;
    aggregate.artifactsProcessed += 1;

    if (plan.conflicts.length > 0) {
      aggregate.conflicts = plan.conflicts;
      aggregate.skipped = plan.conflicts.map((item) => ({
        path: item.path,
        operation: item.operation,
        reason: item.reason
      }));
      if (conflictStrategy !== "manual") {
        if (!options.dryRun) {
          await saveConflictReport(root, options.requestId, manifest, plan);
        }
        return aggregate;
      }
    }

    const hasApplicableWork = plan.applied.length > 0 ||
      plan.acknowledged.length > 0 ||
      plan.resolvedKeepLocal.length > 0 ||
      plan.resolvedAcceptRemote.length > 0 ||
      plan.baselineUpdates.length > 0;
    if (plan.conflicts.length > 0 && !hasApplicableWork) {
      if (!options.dryRun) {
        await saveConflictReport(root, options.requestId, manifest, plan);
      }
      return aggregate;
    }

    if (options.dryRun) {
      baseline = applyBaselineUpdates(baseline, plan);
      if (plan.baselineAdvanced && plan.conflicts.length === 0) {
        baseline.complete_project_version = manifest.project_version;
        baseline.artifact_manifest_hash = manifest.manifest_sha256;
        baseline.latest_artifact_id = manifest.artifact_id;
      }
      if (plan.conflicts.length > 0) {
        return aggregate;
      }
      continue;
    }

    await atomicWriteJson(join(
      root,
      ".harness",
      "cache",
      "server-artifacts",
      manifest.artifact_id,
      "manifest.json"
    ), manifest);

    const lock = await acquireProtocolLock(root, "update", { requestId: options.requestId });
    try {
      let nextBaseline = applyBaselineUpdates(baseline, plan);
      if (plan.baselineAdvanced && plan.conflicts.length === 0) {
        nextBaseline.complete_project_version = manifest.project_version;
        nextBaseline.artifact_manifest_hash = manifest.manifest_sha256;
        nextBaseline.latest_artifact_id = manifest.artifact_id;
      }
      const transactionId = "tx_sync_" + Date.now() + "_" + options.requestId;
      const reportPath = ".harness/reports/update-" + options.requestId + ".json";
      const report = {
        schema_version: 2,
        request_id: options.requestId,
        artifact_id: manifest.artifact_id,
        observed_project_version: manifest.project_version,
        status: plan.conflicts.length === 0 ? "applied" : "partial_due_to_conflicts",
        applied: paths.applied,
        acknowledged: paths.acknowledged,
        resolved_keep_local: paths.resolvedKeepLocal,
        resolved_accept_remote: paths.resolvedAcceptRemote,
        already_applied: paths.alreadyApplied,
        conflicts: plan.conflicts,
        skipped: aggregate.skipped,
        transaction_id: transactionId
      };
      const fileOps = collectWrites(plan);
      fileOps.push(
        {
          operation: "modify",
          path: ".harness/state/baseline/manifest.json",
          content: JSON.stringify(nextBaseline, null, 2) + "\n"
        },
        {
          operation: "add",
          path: reportPath,
          content: JSON.stringify(report, null, 2) + "\n"
        },
        {
          operation: "modify",
          path: ".harness/state/local/last-update.json",
          content: JSON.stringify(report, null, 2) + "\n"
        }
      );
      await runTransaction(root, fileOps, {
        id: transactionId,
        kind: "update",
        ...(options.transactionOptions ?? {})
      });
      aggregate.transactionId = transactionId;
      baseline = nextBaseline;
      if (plan.conflicts.length > 0) {
        await saveConflictReport(root, options.requestId, manifest, plan);
        aggregate.baselineAdvanced = false;
        return aggregate;
      }
    } finally {
      await lock.release();
    }
  }

  throw new Error("MAX_SYNC_ARTIFACT_ITERATIONS_EXCEEDED");
}

function baselineEntryFromOperation(
  manifest: ArtifactManifest,
  operation: ArtifactManifest["files"][number],
  localContent: string | null
): BaselineManifest["files"][string] {
  const block = localContent === null ? null : extractManagedBlock(localContent);
  return {
    baseline_hash: operation.operation === "delete" ? null : operation.content_sha256,
    local_hash_at_apply: localContent === null ? null : sha256Bytes(localContent),
    file_kind: operation.file_kind,
    last_applied_version: manifest.project_version,
    deleted: operation.operation === "delete",
    ...(block === null ? {} : { managed_block_hash: sha256Bytes(block) })
  };
}

export async function advanceBaselineFromArtifact(
  options: {
    projectRoot: string;
    manifest: ArtifactManifest;
    requestId: string;
    transactionOptions?: Omit<TransactionOptions, "id">;
  },
  baseline: BaselineManifest
): Promise<{ baseline: BaselineManifest; localChanged: boolean; transactionId: string | null }> {
  const root = resolve(options.projectRoot);
  if (options.manifest.project_version === null) {
    throw new Error("artifact manifest missing project_version");
  }
  let localChanged = false;
  for (const operation of options.manifest.files) {
    const source = operationSourcePath(operation);
    const target = operationTargetPath(operation);
    const sourceContent = await optionalContent(root, source);
    const targetContent = target === source
      ? sourceContent
      : await optionalContent(root, target);
    if (operation.operation === "delete") {
      if (sourceContent !== null) {
        localChanged = true;
      }
      continue;
    }
    const expectedHash = operation.content_sha256;
    const actualContent = targetContent ?? sourceContent;
    const actualHash = actualContent === null ? null : sha256Bytes(actualContent);
    if (actualHash !== expectedHash) {
      localChanged = true;
    }
  }
  if (localChanged) {
    return { baseline, localChanged: true, transactionId: null };
  }

  const nextBaseline = baselineManifestSchema.parse(structuredClone(baseline));
  for (const operation of options.manifest.files) {
    const source = operationSourcePath(operation);
    const target = operationTargetPath(operation);
    const sourceContent = await optionalContent(root, source);
    const targetContent = target === source
      ? sourceContent
      : await optionalContent(root, target);
    const localContent = operation.operation === "delete"
      ? null
      : targetContent ?? sourceContent;
    nextBaseline.files[target] = baselineEntryFromOperation(
      options.manifest,
      operation,
      localContent
    );
    if (operation.operation === "rename") {
      nextBaseline.files[operation.from_path] = {
        baseline_hash: null,
        local_hash_at_apply: null,
        file_kind: operation.file_kind,
        last_applied_version: options.manifest.project_version,
        deleted: true
      };
    }
  }
  nextBaseline.complete_project_version = options.manifest.project_version;
  nextBaseline.artifact_manifest_hash = options.manifest.manifest_sha256;
  nextBaseline.latest_artifact_id = options.manifest.artifact_id;
  const transactionId = "tx_push_baseline_" + Date.now();
  await runTransaction(root, [{
    operation: "modify",
    path: ".harness/state/baseline/manifest.json",
    content: JSON.stringify(nextBaseline, null, 2) + "\n"
  }], {
    id: transactionId,
    kind: "update",
    ...(options.transactionOptions ?? {})
  });
  return { baseline: nextBaseline, localChanged: false, transactionId };
}
