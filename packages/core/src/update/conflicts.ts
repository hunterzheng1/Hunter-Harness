import type { BaselineManifest, FileOperation } from "@hunter-harness/contracts";

import { extractManagedBlock } from "../managed/managed-block.js";
import { sha256Bytes } from "../fs/hash.js";

export type UpdateSkipReason =
  | "policy-never"
  | "protocol-only"
  | "local-dirty"
  | "baseline-diverged"
  | "target-collision";

export interface UpdateConflict {
  path: string;
  operation: FileOperation["operation"];
  reason: UpdateSkipReason;
}

export function operationTargetPath(operation: FileOperation): string {
  return operation.operation === "rename" ? operation.to_path : operation.path;
}

export function operationSourcePath(operation: FileOperation): string {
  return operation.operation === "rename" ? operation.from_path : operation.path;
}

export function operationAlreadyApplied(
  operation: FileOperation,
  baseline: BaselineManifest,
  projectVersion: string | null
): boolean {
  const target = baseline.files[operationTargetPath(operation)];
  if (operation.operation === "delete") {
    return target?.deleted === true && target.last_applied_version === projectVersion;
  }
  return target?.deleted === false &&
    target?.last_applied_version === projectVersion &&
    target.baseline_hash === operation.content_sha256;
}

export function managedBlockDirty(
  currentContent: string,
  managedBlockHash: string | undefined
): boolean {
  if (managedBlockHash === undefined) {
    return true;
  }
  const block = extractManagedBlock(currentContent);
  return block === null || sha256Bytes(block) !== managedBlockHash;
}
