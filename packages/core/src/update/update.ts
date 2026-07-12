import { lstat, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  artifactManifestSchema,
  baselineManifestSchema,
  canonicalJson,
  projectConfigSchema,
  type ArtifactManifest,
  type FileOperation
} from "@hunter-harness/contracts";
import { parse as parseYaml } from "yaml";

import { ApiError, HunterHarnessApiClient } from "../api/client.js";
import { sha256Bytes, sha256File } from "../fs/hash.js";
import {
  extractManagedBlock,
  extractSingleManagedBlockById,
  removeManagedBlock,
  upsertManagedBlock,
  upsertManagedBlockById
} from "../managed/managed-block.js";
import { classifyFile, decideUpdate } from "../policy/file-policy.js";
import { uuidV7 } from "../project/uuid-v7.js";
import { atomicWriteFile, atomicWriteJson } from "../state/atomic.js";
import { readBaseline } from "../state/baseline.js";
import { acquireProtocolLock } from "../state/locks.js";
import type { TransactionOperation } from "../transaction/journal.js";
import { runTransaction, type TransactionOptions } from "../transaction/transaction.js";
import {
  managedBlockDirty,
  operationAlreadyApplied,
  operationSourcePath,
  operationTargetPath,
  type UpdateConflict
} from "./conflicts.js";

export class UpdateWorkflowError extends Error {
  readonly exitCode: 3 | 4 | 5 | 7 | 8;
  readonly code: string;

  constructor(message: string, exitCode: 3 | 4 | 5 | 7 | 8, code: string) {
    super(message);
    this.name = "UpdateWorkflowError";
    this.exitCode = exitCode;
    this.code = code;
  }
}

export interface UpdateProjectOptions {
  projectRoot: string;
  serverUrl?: string;
  tokenEnv?: string;
  env: Readonly<Record<string, string | undefined>>;
  dryRun: boolean;
  fetch?: typeof globalThis.fetch;
  transactionOptions?: Omit<TransactionOptions, "id">;
}

interface PreparedItem {
  operation: FileOperation;
  content: string | null;
  finalContent: string | null;
  equivalent: boolean;
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

async function optionalContent(path: string): Promise<string | null> {
  return await pathExists(path) ? readFile(path, "utf8") : null;
}

function manifestPayloadHash(manifest: ArtifactManifest): string {
  const payload: Partial<ArtifactManifest> = { ...manifest };
  delete payload.manifest_sha256;
  return sha256Bytes(canonicalJson(payload));
}

function expectedBase(operation: FileOperation): string | null {
  return operation.operation === "add" ? null : operation.base_content_sha256;
}

function contentHash(operation: FileOperation): string | null {
  return operation.operation === "delete" ? null : operation.content_sha256;
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
    throw new UpdateWorkflowError(
      "artifact blob size or hash mismatch",
      4,
      "ARTIFACT_HASH_MISMATCH"
    );
  }
  if (!dryRun) {
    await atomicWriteFile(cachePath, bytes);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function nextBaselineEntry(
  operation: FileOperation,
  finalContent: string | null,
  projectVersion: string | null
) {
  const block = finalContent === null ? null : extractManagedBlock(finalContent);
  return {
    baseline_hash: contentHash(operation),
    local_hash_at_apply: finalContent === null ? null : sha256Bytes(finalContent),
    file_kind: operation.file_kind,
    last_applied_version: projectVersion,
    deleted: operation.operation === "delete",
    ...(block === null ? {} : { managed_block_hash: sha256Bytes(block) })
  };
}

function transactionOperation(
  item: PreparedItem
): TransactionOperation | null {
  if (item.equivalent) {
    return null;
  }
  const operation = item.operation;
  const target = operationTargetPath(operation);
  if (operation.operation === "delete") {
    return item.finalContent === null
      ? { operation: "delete", path: target }
      : { operation: "modify", path: target, content: item.finalContent };
  }
  if (operation.operation === "rename") {
    return {
      operation: "rename",
      from_path: operation.from_path,
      to_path: operation.to_path,
      content: item.finalContent ?? item.content ?? ""
    };
  }
  return {
    operation: "modify",
    path: target,
    content: item.finalContent ?? item.content ?? ""
  };
}

export async function updateProject(options: UpdateProjectOptions) {
  const root = resolve(options.projectRoot);
  let project;
  try {
    project = projectConfigSchema.parse(parseYaml(
      await readFile(join(root, ".harness", "project.yaml"), "utf8")
    ));
  } catch {
    throw new UpdateWorkflowError("project configuration is invalid", 3, "PROJECT_CONFIG_INVALID");
  }
  if (project.project.project_id === null) {
    throw new UpdateWorkflowError("project is not bound to a server", 3, "PROJECT_NOT_BOUND");
  }
  const serverUrl = options.serverUrl ?? project.server.url;
  const tokenEnv = options.tokenEnv ?? project.server.token_env;
  if (serverUrl === null || serverUrl === undefined) {
    throw new UpdateWorkflowError("server_url is required", 3, "SERVER_URL_REQUIRED");
  }
  if (!/^[A-Z_][A-Z0-9_]*$/.test(tokenEnv)) {
    throw new UpdateWorkflowError("token_env is invalid", 3, "TOKEN_ENV_INVALID");
  }
  const token = options.env[tokenEnv];
  if (token === undefined || token.trim() === "") {
    throw new UpdateWorkflowError("API token environment variable is unset", 8, "TOKEN_INVALID");
  }
  const requestId = uuidV7();
  const baseline = await readBaseline(root);
  let parsedServerUrl: URL;
  try {
    parsedServerUrl = new URL(serverUrl);
  } catch {
    throw new UpdateWorkflowError("server_url is invalid", 3, "SERVER_URL_INVALID");
  }
  if (parsedServerUrl.protocol !== "https:") {
    throw new UpdateWorkflowError("server_url must use HTTPS", 3, "SERVER_URL_INVALID");
  }
  const client = new HunterHarnessApiClient({
    serverUrl: parsedServerUrl.toString(),
    token,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch })
  });
  try {
    const discovery = await client.getUpdateManifest(
      project.project.project_id,
      {
        base_project_version: baseline.complete_project_version,
        base_manifest_hash: sha256Bytes(canonicalJson(baseline)),
        adapter: project.adapters.enabled[0] ?? "claude-code",
        profile: project.project.profiles[0] ?? "general"
      },
      requestId
    );
    if (!discovery.delta_available || discovery.artifact_id === null) {
      return {
        requestId,
        projectId: project.project.project_id,
        artifactId: null,
        observedProjectVersion: discovery.observed_project_version,
        operations: [],
        applied: [],
        skipped: [],
        transactionId: null,
        dryRun: options.dryRun
      };
    }
    const manifest = artifactManifestSchema.parse(
      await client.getArtifactManifest(discovery.artifact_id, requestId)
    );
    if (manifest.artifact_id !== discovery.artifact_id ||
        manifest.project_id !== project.project.project_id ||
        manifest.project_version === null ||
        manifestPayloadHash(manifest) !== manifest.manifest_sha256) {
      throw new UpdateWorkflowError("artifact manifest integrity check failed", 4, "ARTIFACT_HASH_MISMATCH");
    }
    const blobs = new Map<FileOperation, string | null>();
    for (const operation of manifest.files) {
      const policy = classifyFile(operationTargetPath(operation));
      if (decideUpdate(policy, false).apply) {
        blobs.set(operation, await loadBlob(
          root, client, manifest.artifact_id, operation, requestId, options.dryRun
        ));
      }
    }

    const prepared: PreparedItem[] = [];
    const skipped: UpdateConflict[] = [];
    for (const operation of manifest.files) {
      if (operationAlreadyApplied(operation, baseline, manifest.project_version)) {
        continue;
      }
      const source = operationSourcePath(operation);
      const target = operationTargetPath(operation);
      const policy = classifyFile(target);
      const staticDecision = decideUpdate(policy, false);
      if (!staticDecision.apply) {
        skipped.push({ path: target, operation: operation.operation, reason: staticDecision.reason });
        continue;
      }
      const previous = baseline.files[source];
      if (expectedBase(operation) !== (previous?.baseline_hash ?? null)) {
        skipped.push({ path: target, operation: operation.operation, reason: "baseline-diverged" });
        continue;
      }
      const sourceContent = await optionalContent(join(root, source));
      const targetContent = target === source
        ? sourceContent
        : await optionalContent(join(root, target));
      const incoming = blobs.get(operation) ?? null;
      const incomingHash = contentHash(operation);
      let equivalent = incomingHash !== null && targetContent !== null &&
        sha256Bytes(targetContent) === incomingHash;
      let dirty = false;
      if (operation.operation === "add") {
        if (targetContent !== null && !equivalent) {
          if (policy.update_policy === "managed-block-only" && incoming !== null) {
            const incomingBlock = extractManagedBlock(incoming) ?? incoming.trim();
            equivalent = extractManagedBlock(targetContent) === incomingBlock;
            dirty = !equivalent;
          } else {
            dirty = true;
          }
        }
      } else if (sourceContent === null) {
        dirty = operation.operation !== "delete";
      } else if (policy.update_policy === "managed-block-only") {
        dirty = previous?.managed_block_hash === undefined
          ? (previous?.local_hash_at_apply ?? previous?.baseline_hash) !==
            sha256Bytes(sourceContent)
          : managedBlockDirty(sourceContent, previous.managed_block_hash);
      } else {
        dirty = (previous?.local_hash_at_apply ?? previous?.baseline_hash) !==
          sha256Bytes(sourceContent);
      }
      if (operation.operation === "rename" && targetContent !== null && !equivalent) {
        dirty = true;
      }
      if (dirty) {
        skipped.push({ path: target, operation: operation.operation, reason: "local-dirty" });
        continue;
      }

      let finalContent = incoming;
      if (policy.update_policy === "managed-block-only") {
        if (operation.operation === "delete") {
          finalContent = sourceContent === null ? null : removeManagedBlock(sourceContent);
          equivalent = finalContent === sourceContent;
        } else if (incoming !== null) {
          const incomingBlock = extractManagedBlock(incoming) ?? incoming.trim();
          const incomingId = extractSingleManagedBlockById(incoming)?.id;
          const blockId = operation.operation === "add" || operation.operation === "modify"
            ? operation.block_id ?? incomingId
            : undefined;
          finalContent = blockId !== undefined
            ? upsertManagedBlockById(targetContent ?? "", blockId, incomingBlock)
            : upsertManagedBlock(targetContent ?? "", incomingBlock);
          equivalent = finalContent === targetContent;
        }
      } else if (operation.operation === "delete" && sourceContent === null) {
        equivalent = true;
      }
      prepared.push({ operation, content: incoming, finalContent, equivalent });
    }

    const applied = prepared.map((item) => operationTargetPath(item.operation));
    if (options.dryRun) {
      return {
        requestId,
        projectId: project.project.project_id,
        artifactId: manifest.artifact_id,
        observedProjectVersion: manifest.project_version,
        operations: manifest.files,
        applied,
        skipped,
        transactionId: null,
        dryRun: true
      };
    }

    await atomicWriteJson(join(
      root,
      ".harness",
      "cache",
      "server-artifacts",
      manifest.artifact_id,
      "manifest.json"
    ), manifest);

    const lock = await acquireProtocolLock(root, "update", { requestId });
    try {
      const nextBaseline = baselineManifestSchema.parse(structuredClone(baseline));
      for (const item of prepared) {
        const target = operationTargetPath(item.operation);
        nextBaseline.files[target] = nextBaselineEntry(
          item.operation,
          item.finalContent,
          manifest.project_version
        );
        if (item.operation.operation === "rename") {
          nextBaseline.files[item.operation.from_path] = {
            baseline_hash: null,
            local_hash_at_apply: null,
            file_kind: item.operation.file_kind,
            last_applied_version: manifest.project_version,
            deleted: true
          };
        }
      }
      if (skipped.length === 0) {
        nextBaseline.complete_project_version = manifest.project_version;
        nextBaseline.artifact_manifest_hash = manifest.manifest_sha256;
      }
      const transactionId = "tx_update_" + Date.now() + "_" + uuidV7();
      const reportPath = ".harness/reports/update-" + requestId + ".json";
      const report = {
        schema_version: 1,
        request_id: requestId,
        artifact_id: manifest.artifact_id,
        observed_project_version: manifest.project_version,
        status: skipped.length === 0 ? "applied" : "partial_due_to_dirty",
        applied,
        skipped,
        transaction_id: transactionId
      };
      const operations = prepared
        .map((item) => transactionOperation(item))
        .filter((item): item is TransactionOperation => item !== null);
      operations.push(
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
      await runTransaction(root, operations, {
        id: transactionId,
        kind: "update",
        ...(options.transactionOptions ?? {})
      });
      return {
        requestId,
        projectId: project.project.project_id,
        artifactId: manifest.artifact_id,
        observedProjectVersion: manifest.project_version,
        operations: manifest.files,
        applied,
        skipped,
        transactionId,
        dryRun: false
      };
    } finally {
      await lock.release();
    }
  } catch (error) {
    if (error instanceof UpdateWorkflowError) {
      throw error;
    }
    if (error instanceof ApiError) {
      throw new UpdateWorkflowError(
        error.message,
        error.status === 401 || error.status === 403 ? 8 : error.status === 409 ? 5 : 4,
        error.code
      );
    }
    if (error instanceof Error && error.name === "ZodError") {
      throw new UpdateWorkflowError("artifact schema validation failed", 7, "SCHEMA_VALIDATION_FAILED");
    }
    throw new UpdateWorkflowError(
      error instanceof Error ? error.message : "update failed",
      4,
      "NETWORK_OR_SERVER_ERROR"
    );
  }
}
