import type { FileKind, FileOperation } from "@hunter-harness/contracts";

import { sha256Bytes } from "../fs/hash.js";
import { normalizeManagedPath } from "../fs/path-safety.js";
import { classifyFile, decidePush } from "../policy/file-policy.js";

export interface ProposalBaselineEntry {
  content_sha256: string;
}

export interface ProposalDiffInput {
  baseline: Readonly<Record<string, ProposalBaselineEntry>>;
  files: Readonly<Record<string, string>>;
  deletedAt: string;
  deleteReason: string;
  confirmedProjectLocal: readonly string[];
}

export interface ProposalSkippedItem {
  path: string;
  reason: "policy-never" | "confirmation-required" | "unchanged";
}

export interface ProposalDiff {
  operations: FileOperation[];
  blobs: Record<string, string>;
  skipped: ProposalSkippedItem[];
}

interface CurrentEntry {
  path: string;
  content: string;
  hash: string;
  size: number;
  fileKind: FileKind;
}

function operationPath(operation: FileOperation): string {
  return operation.operation === "rename" ? operation.to_path : operation.path;
}

export function buildProposalDiff(input: ProposalDiffInput): ProposalDiff {
  const confirmed = new Set(input.confirmedProjectLocal.map(normalizeManagedPath));
  const skipped: ProposalSkippedItem[] = [];
  const current = new Map<string, CurrentEntry>();
  for (const [rawPath, content] of Object.entries(input.files)) {
    const path = normalizeManagedPath(rawPath);
    const policy = classifyFile(path);
    const decision = decidePush(policy, confirmed.has(path));
    if (!decision.include) {
      skipped.push({ path, reason: decision.reason });
      continue;
    }
    current.set(path, {
      path,
      content,
      hash: sha256Bytes(content),
      size: Buffer.byteLength(content),
      fileKind: policy.file_kind
    });
  }

  const baseline = new Map<string, ProposalBaselineEntry>();
  for (const [rawPath, entry] of Object.entries(input.baseline)) {
    const path = normalizeManagedPath(rawPath);
    const policy = classifyFile(path);
    const decision = decidePush(policy, confirmed.has(path));
    if (!decision.include) {
      if (!current.has(path)) {
        skipped.push({ path, reason: decision.reason });
      }
      continue;
    }
    baseline.set(path, entry);
  }

  const additions = [...current.values()].filter((entry) => !baseline.has(entry.path));
  const deletions = [...baseline.entries()].filter(([path]) => !current.has(path));
  const consumedAdditions = new Set<string>();
  const consumedDeletions = new Set<string>();
  const operations: FileOperation[] = [];
  const blobs: Record<string, string> = {};

  for (const [fromPath, previous] of deletions) {
    const renamed = additions.find((entry) =>
      !consumedAdditions.has(entry.path) && entry.hash === previous.content_sha256 &&
      entry.fileKind === classifyFile(fromPath).file_kind
    );
    if (renamed === undefined) {
      continue;
    }
    operations.push({
      operation: "rename",
      from_path: fromPath,
      to_path: renamed.path,
      file_kind: renamed.fileKind,
      base_content_sha256: previous.content_sha256,
      content_sha256: renamed.hash,
      size_bytes: renamed.size
    });
    blobs[renamed.hash] = renamed.content;
    consumedAdditions.add(renamed.path);
    consumedDeletions.add(fromPath);
  }

  for (const entry of current.values()) {
    const previous = baseline.get(entry.path);
    if (previous === undefined || previous.content_sha256 === entry.hash) {
      if (previous !== undefined) {
        skipped.push({ path: entry.path, reason: "unchanged" });
      }
      continue;
    }
    operations.push({
      operation: "modify",
      path: entry.path,
      file_kind: entry.fileKind,
      base_content_sha256: previous.content_sha256,
      content_sha256: entry.hash,
      size_bytes: entry.size
    });
    blobs[entry.hash] = entry.content;
  }
  for (const entry of additions) {
    if (consumedAdditions.has(entry.path)) {
      continue;
    }
    operations.push({
      operation: "add",
      path: entry.path,
      file_kind: entry.fileKind,
      content_sha256: entry.hash,
      size_bytes: entry.size
    });
    blobs[entry.hash] = entry.content;
  }
  for (const [path, previous] of deletions) {
    if (consumedDeletions.has(path)) {
      continue;
    }
    operations.push({
      operation: "delete",
      path,
      file_kind: classifyFile(path).file_kind,
      base_content_sha256: previous.content_sha256,
      tombstone: {
        deleted_at: input.deletedAt,
        reason: input.deleteReason,
        previous_sha256: previous.content_sha256
      }
    });
  }

  operations.sort((left, right) => operationPath(left).localeCompare(operationPath(right)));
  skipped.sort((left, right) => left.path.localeCompare(right.path));
  return { operations, blobs, skipped };
}
