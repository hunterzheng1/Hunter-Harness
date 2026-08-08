import type {
  BaselineManifest,
  FileOperation
} from "@hunter-harness/contracts";

import { sha256Bytes } from "../fs/hash.js";
import {
  extractManagedBlock,
  extractSingleManagedBlockById,
  managedBlockDigestInput,
  parseManagedBlocks,
  removeManagedBlock,
  upsertManagedBlock,
  upsertManagedBlockById
} from "../managed/managed-block.js";
import { classifyFile, decideUpdate } from "../policy/file-policy.js";
import {
  managedBlockDirty,
  operationAlreadyApplied,
  operationSourcePath,
  operationTargetPath,
  type UpdateSkipReason
} from "../update/conflicts.js";

export type ConflictStrategy = "manual" | "keep-local" | "accept-remote";
export type PerPathResolveStrategy = "keep-local" | "accept-remote";

const FULL_DOCUMENT_INSTRUCTION_PATHS = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "CODEBUDDY.md"
]);

class InvalidManagedArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidManagedArtifactError";
  }
}

function isFullDocumentInstruction(path: string): boolean {
  return FULL_DOCUMENT_INSTRUCTION_PATHS.has(path);
}

/**
 * Historical server artifacts may still contain line or inline managed-marker
 * wrappers. Unwrap valid blocks once while retaining every byte of their body
 * and all user-authored content outside the wrappers. Malformed wrappers must
 * never be accepted as full-document content.
 */
function migrateLegacyInstructionArtifact(content: string): string {
  if (!content.includes("<!-- hunter-harness:start") &&
      !content.includes("<!-- hunter-harness:end")) {
    return content;
  }
  let parsed: ReturnType<typeof parseManagedBlocks>;
  try {
    parsed = parseManagedBlocks(content);
  } catch (error) {
    throw new InvalidManagedArtifactError(
      error instanceof Error ? error.message : "invalid managed markers"
    );
  }
  if (parsed.blocks.length === 0) {
    throw new InvalidManagedArtifactError("unrecognized managed marker syntax");
  }
  let migrated = "";
  let cursor = 0;
  for (const block of parsed.blocks) {
    migrated += content.slice(cursor, block.start) + block.content;
    cursor = block.end;
  }
  return migrated + content.slice(cursor);
}

export interface OperationContext {
  operation: FileOperation;
  incomingContent: string | null;
  sourceContent: string | null;
  targetContent: string | null;
}

export interface PlannedWrite {
  operation: FileOperation;
  path: string;
  content: string | null;
  equivalent: boolean;
  acknowledgeReason?: "policy-never" | "protocol-only";
}

export interface PlannedBaselineUpdate {
  path: string;
  entry: BaselineManifest["files"][string];
}

export interface RebaseConflict {
  path: string;
  operation: FileOperation["operation"];
  reason: UpdateSkipReason;
  expectedBaselineHash?: string;
  actualBaselineHash?: string | null;
}

export interface ArtifactRebasePlan {
  applied: PlannedWrite[];
  acknowledged: PlannedWrite[];
  resolvedKeepLocal: PlannedWrite[];
  resolvedAcceptRemote: PlannedWrite[];
  alreadyApplied: Array<{ path: string; operation: FileOperation }>;
  conflicts: RebaseConflict[];
  baselineUpdates: PlannedBaselineUpdate[];
  baselineAdvanced: boolean;
}

export interface PlanArtifactRebaseInput {
  baseline: BaselineManifest;
  projectVersion: string;
  contexts: readonly OperationContext[];
  conflictStrategy: ConflictStrategy;
  resolveOverrides?: ReadonlyMap<string, PerPathResolveStrategy>;
  protocolOnlyPaths?: ReadonlySet<string>;
}

export function decideStaticOperationUpdate(
  operation: FileOperation,
  protocolOnlyPaths?: ReadonlySet<string>
): ReturnType<typeof decideUpdate> {
  const source = operationSourcePath(operation);
  const target = operationTargetPath(operation);
  if (protocolOnlyPaths?.has(source) === true ||
      protocolOnlyPaths?.has(target) === true) {
    return { apply: false, reason: "protocol-only" };
  }
  for (const path of new Set([source, target])) {
    const decision = decideUpdate(classifyFile(path), false);
    if (!decision.apply) return decision;
  }
  return { apply: true };
}

function expectedBase(operation: FileOperation): string | null {
  return operation.operation === "add" ? null : operation.base_content_sha256;
}

function contentHash(operation: FileOperation): string | null {
  return operation.operation === "delete" ? null : operation.content_sha256;
}

function baselineEntryFor(
  operation: FileOperation,
  finalContent: string | null,
  projectVersion: string
): BaselineManifest["files"][string] {
  const block = finalContent === null ? null : managedBlockDigestInput(finalContent);
  const remoteHash = contentHash(operation);
  const localHash = finalContent === null ? null : sha256Bytes(finalContent);
  return {
    baseline_hash: remoteHash,
    local_hash_at_apply: localHash,
    file_kind: operation.file_kind,
    last_applied_version: projectVersion,
    deleted: operation.operation === "delete",
    ...(block === null ? {} : { managed_block_hash: sha256Bytes(block) })
  };
}

function acknowledgedEntry(
  operation: FileOperation,
  context: OperationContext,
  projectVersion: string,
  reason: "policy-never" | "protocol-only"
): BaselineManifest["files"][string] {
  void reason;
  const localContent = operation.operation === "delete"
    ? context.sourceContent
    : context.targetContent ?? context.sourceContent;
  const block = localContent === null ? null : managedBlockDigestInput(localContent);
  return {
    baseline_hash: contentHash(operation),
    local_hash_at_apply: localContent === null ? null : sha256Bytes(localContent),
    file_kind: operation.file_kind,
    last_applied_version: projectVersion,
    deleted: operation.operation === "delete",
    ...(block === null ? {} : { managed_block_hash: sha256Bytes(block) })
  };
}

function deletedSourceEntry(
  operation: FileOperation,
  projectVersion: string | null
): BaselineManifest["files"][string] {
  return {
    baseline_hash: null,
    local_hash_at_apply: null,
    file_kind: operation.file_kind,
    last_applied_version: projectVersion,
    deleted: true
  };
}

function isRenameTargetCollision(
  operation: FileOperation,
  targetContent: string | null,
  incomingHash: string | null
): boolean {
  if (operation.operation !== "rename" || targetContent === null) {
    return false;
  }
  return incomingHash === null || sha256Bytes(targetContent) !== incomingHash;
}

function resolveDecision(
  path: string,
  reason: UpdateSkipReason,
  operation: FileOperation,
  conflictStrategy: ConflictStrategy,
  resolveOverrides?: ReadonlyMap<string, PerPathResolveStrategy>
): "conflict" | "keep-local" | "accept-remote" {
  if (reason === "target-collision") {
    return "conflict";
  }
  if (reason === "local-dirty" && operation.operation === "rename") {
    return "conflict";
  }
  const override = resolveOverrides?.get(path);
  if (override !== undefined) {
    return override;
  }
  if (conflictStrategy === "keep-local") {
    return "keep-local";
  }
  if (conflictStrategy === "accept-remote") {
    return "accept-remote";
  }
  return "conflict";
}

function computeFinalContent(
  operation: FileOperation,
  policy: ReturnType<typeof classifyFile>,
  targetContent: string | null,
  sourceContent: string | null,
  incoming: string | null
): { finalContent: string | null; equivalent: boolean } {
  const incomingHash = contentHash(operation);
  let equivalent = incomingHash !== null && targetContent !== null &&
    sha256Bytes(targetContent) === incomingHash;
  let finalContent = incoming;
  if (isFullDocumentInstruction(operationTargetPath(operation)) && incoming !== null) {
    finalContent = migrateLegacyInstructionArtifact(incoming);
    equivalent = finalContent === targetContent;
  } else if (policy.update_policy === "managed-block-only") {
    if (operation.operation === "delete") {
      finalContent = sourceContent === null
        ? null
        : removeManagedBlock(sourceContent);
      equivalent = finalContent === sourceContent;
    } else if (incoming !== null) {
      const parsed = parseManagedBlocks(incoming);
      const incomingBlock = extractManagedBlock(incoming) ?? incoming.trim();
      const incomingId = extractSingleManagedBlockById(incoming)?.id;
      const blockId = operation.operation === "add" || operation.operation === "modify"
        ? operation.block_id ?? incomingId
        : undefined;
      if (blockId !== undefined) {
        const matching = parsed.blocks.find((block) => block.id === blockId);
        const body = matching?.content ??
          (parsed.blocks.length <= 1 ? incomingBlock : null);
        if (body === null) {
          throw new Error(
            `MANAGED_BLOCK_ID_MISSING: incoming artifact does not contain ${blockId}`
          );
        }
        finalContent = upsertManagedBlockById(targetContent ?? "", blockId, body);
      } else if (parsed.blocks.length > 1) {
        if (parsed.blocks.some((block) => block.id === null)) {
          throw new Error(
            "MANAGED_BLOCK_FULL_FILE_AMBIGUOUS: multi-block artifacts require stable IDs"
          );
        }
        finalContent = parsed.blocks.reduce(
          (current, block) => upsertManagedBlockById(
            current,
            block.id as string,
            block.content
          ),
          targetContent ?? ""
        );
      } else {
        finalContent = upsertManagedBlock(targetContent ?? "", incomingBlock);
      }
      equivalent = finalContent === targetContent;
    }
  } else if (operation.operation === "delete" && sourceContent === null) {
    equivalent = true;
    finalContent = null;
  } else if (equivalent) {
    finalContent = targetContent;
  }
  return { finalContent, equivalent };
}

function isDirty(
  operation: FileOperation,
  policy: ReturnType<typeof classifyFile>,
  previous: BaselineManifest["files"][string] | undefined,
  sourceContent: string | null,
  targetContent: string | null,
  incoming: string | null
): { dirty: boolean; equivalent: boolean } {
  const incomingHash = contentHash(operation);
  let equivalent = targetContent !== null && incoming !== null &&
    (targetContent === incoming ||
      (incomingHash !== null && sha256Bytes(targetContent) === incomingHash));
  let dirty = false;
  if (operation.operation === "add") {
    if (targetContent !== null && !equivalent) {
      if (policy.update_policy === "managed-block-only" && incoming !== null) {
        const projected = computeFinalContent(
          operation,
          policy,
          targetContent,
          sourceContent,
          incoming
        );
        equivalent = projected.finalContent === targetContent;
        dirty = !equivalent;
      } else {
        dirty = true;
      }
    }
  } else if (equivalent) {
    dirty = false;
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
  return { dirty, equivalent };
}

function pushBaselineUpdates(
  plan: ArtifactRebasePlan,
  operation: FileOperation,
  target: string,
  entry: BaselineManifest["files"][string]
): void {
  plan.baselineUpdates.push({ path: target, entry });
  if (operation.operation === "rename") {
    plan.baselineUpdates.push({
      path: operation.from_path,
      entry: deletedSourceEntry(operation, entry.last_applied_version ?? null)
    });
  }
}

function recordWrite(
  plan: ArtifactRebasePlan,
  bucket: "applied" | "resolvedKeepLocal" | "resolvedAcceptRemote",
  operation: FileOperation,
  target: string,
  content: string | null,
  equivalent: boolean,
  entry: BaselineManifest["files"][string]
): void {
  const write: PlannedWrite = { operation, path: target, content, equivalent };
  plan[bucket].push(write);
  pushBaselineUpdates(plan, operation, target, entry);
}

export function planArtifactRebase(input: PlanArtifactRebaseInput): ArtifactRebasePlan {
  const plan: ArtifactRebasePlan = {
    applied: [],
    acknowledged: [],
    resolvedKeepLocal: [],
    resolvedAcceptRemote: [],
    alreadyApplied: [],
    conflicts: [],
    baselineUpdates: [],
    baselineAdvanced: false
  };

  for (const context of input.contexts) {
    const operation = context.operation;
    let incoming = context.incomingContent;
    const source = operationSourcePath(operation);
    const target = operationTargetPath(operation);
    const policy = classifyFile(target);
    const incomingHash = contentHash(operation);

    const fullDocumentInstruction = isFullDocumentInstruction(target);
    if (fullDocumentInstruction &&
        (operation.operation === "add" || operation.operation === "modify") &&
        operation.block_id !== undefined) {
      plan.conflicts.push({
        path: target,
        operation: operation.operation,
        reason: "invalid-managed-artifact"
      });
      continue;
    }
    if (fullDocumentInstruction && incoming !== null) {
      try {
        incoming = migrateLegacyInstructionArtifact(incoming);
      } catch (error) {
        if (!(error instanceof InvalidManagedArtifactError)) throw error;
        plan.conflicts.push({
          path: target,
          operation: operation.operation,
          reason: "invalid-managed-artifact"
        });
        continue;
      }
    }

    if (operationAlreadyApplied(operation, input.baseline, input.projectVersion)) {
      if (fullDocumentInstruction && incoming !== null &&
          context.targetContent !== incoming) {
        const previous = input.baseline.files[source];
        const targetClean = context.targetContent === null ||
          previous?.local_hash_at_apply === sha256Bytes(context.targetContent);
        if (!targetClean) {
          plan.conflicts.push({
            path: target,
            operation: operation.operation,
            reason: "local-dirty"
          });
          continue;
        }
        const entry = baselineEntryFor(operation, incoming, input.projectVersion);
        recordWrite(plan, "applied", operation, target, incoming, false, entry);
        continue;
      }
      plan.alreadyApplied.push({ path: target, operation });
      continue;
    }

    const staticDecision = decideStaticOperationUpdate(
      operation,
      input.protocolOnlyPaths
    );
    if (!staticDecision.apply) {
      const acknowledgeReason = staticDecision.reason === "protocol-only"
        ? "protocol-only" as const
        : "policy-never" as const;
      const entry = acknowledgedEntry(
        operation,
        context,
        input.projectVersion,
        acknowledgeReason
      );
      plan.acknowledged.push({
        operation,
        path: target,
        content: null,
        equivalent: true,
        acknowledgeReason
      });
      pushBaselineUpdates(plan, operation, target, entry);
      continue;
    }

    const previous = input.baseline.files[source];
    const expected = expectedBase(operation);
    const actualBaseline = previous?.baseline_hash ?? null;
    if (expected !== actualBaseline) {
      const decision = resolveDecision(
        target,
        "baseline-diverged",
        operation,
        input.conflictStrategy,
        input.resolveOverrides
      );
      if (decision === "conflict") {
        const conflict: RebaseConflict = {
          path: target,
          operation: operation.operation,
          reason: "baseline-diverged",
          actualBaselineHash: actualBaseline
        };
        if (expected !== null) {
          conflict.expectedBaselineHash = expected;
        }
        plan.conflicts.push(conflict);
        continue;
      }
      if (decision === "keep-local") {
        const localContent = operation.operation === "rename"
          ? context.sourceContent
          : context.targetContent ?? context.sourceContent;
        const entry = baselineEntryFor(
          operation,
          localContent,
          input.projectVersion
        );
        recordWrite(
          plan,
          "resolvedKeepLocal",
          operation,
          target,
          localContent,
          true,
          entry
        );
        continue;
      }
      if (decision === "accept-remote") {
        const { finalContent, equivalent } = computeFinalContent(
          operation,
          policy,
          context.targetContent,
          context.sourceContent,
          incoming
        );
        const entry = baselineEntryFor(operation, finalContent, input.projectVersion);
        recordWrite(
          plan,
          "resolvedAcceptRemote",
          operation,
          target,
          finalContent,
          equivalent,
          entry
        );
        continue;
      }
    }

    const targetCollision = isRenameTargetCollision(
      operation,
      context.targetContent,
      incomingHash
    );
    if (targetCollision) {
      plan.conflicts.push({
        path: target,
        operation: operation.operation,
        reason: "target-collision"
      });
      continue;
    }

    const { dirty, equivalent: preEquivalent } = isDirty(
      operation,
      policy,
      previous,
      context.sourceContent,
      context.targetContent,
      incoming
    );

    if (dirty) {
      const reason: UpdateSkipReason = operation.operation === "rename" &&
        context.targetContent !== null && !preEquivalent
        ? "target-collision"
        : "local-dirty";
      const decision = resolveDecision(
        target,
        reason,
        operation,
        input.conflictStrategy,
        input.resolveOverrides
      );
      if (decision === "conflict") {
        plan.conflicts.push({
          path: target,
          operation: operation.operation,
          reason
        });
        continue;
      }
      if (decision === "keep-local") {
        const localContent = operation.operation === "delete"
          ? context.sourceContent
          : operation.operation === "rename"
            ? context.sourceContent
            : context.targetContent ?? context.sourceContent;
        const entry = baselineEntryFor(
          operation,
          localContent,
          input.projectVersion
        );
        recordWrite(
          plan,
          "resolvedKeepLocal",
          operation,
          target,
          localContent,
          true,
          entry
        );
        continue;
      }
      const { finalContent, equivalent } = computeFinalContent(
        operation,
        policy,
        context.targetContent,
        context.sourceContent,
        incoming
      );
      const entry = baselineEntryFor(operation, finalContent, input.projectVersion);
      recordWrite(
        plan,
        "resolvedAcceptRemote",
        operation,
        target,
        finalContent,
        equivalent,
        entry
      );
      continue;
    }

    const { finalContent, equivalent } = computeFinalContent(
      operation,
      policy,
      context.targetContent,
      context.sourceContent,
      incoming
    );
    const entry = baselineEntryFor(operation, finalContent, input.projectVersion);
    if (equivalent) {
      plan.alreadyApplied.push({ path: target, operation });
      pushBaselineUpdates(plan, operation, target, entry);
      continue;
    }
    recordWrite(plan, "applied", operation, target, finalContent, equivalent, entry);
  }

  plan.baselineAdvanced = plan.conflicts.length === 0;
  return plan;
}
