import {
  canonicalJson,
  classifyContentPath,
  conflictResolutionSchema,
  type ContentKind,
  type SyncScope
} from "@hunter-harness/contracts";

import { sha256Bytes } from "../fs/hash.js";
import { scanSensitiveFiles } from "../security/scanner.js";
import type {
  ArchivePackageRef,
  ArchiveSyncReceipt,
  BranchRef,
  ConflictDecision,
  ContentFile,
  ProjectRef,
  PullCommit,
  RemoteSyncPort,
  SnapshotRef,
  SourceRef,
  SyncConfirmation,
  SyncConflict,
  SyncOperation,
  SyncOperationValidationResult,
  SyncPreview,
  SyncReceipt,
  SyncStatus,
  SyncView
} from "./types.js";

export type RemoteSyncErrorCode =
  | "ARCHIVE_HASH_MISMATCH"
  | "ARCHIVE_PACKAGE_INVALID"
  | "ARCHIVE_PACKAGE_CONFLICT"
  | "ARCHIVE_RECEIPT_MISMATCH"
  | "SYNC_CONFLICT_DECISION_REQUIRED"
  | "SYNC_CONFLICT_DECISION_INVALID"
  | "SYNC_CONTENT_INVALID"
  | "SYNC_IDEMPOTENCY_CONFLICT"
  | "SYNC_LEGACY_FIXTURE_INVALID"
  | "SYNC_LOCK_UNAVAILABLE"
  | "SYNC_PATH_NOT_ELIGIBLE"
  | "SYNC_PATH_COLLISION"
  | "SYNC_PAGE_LIMIT_INVALID"
  | "SYNC_CURSOR_INVALID"
  | "SYNC_SNAPSHOT_NOT_FOUND"
  | "SYNC_PREVIEW_HASH_MISMATCH"
  | "SYNC_PREVIEW_STALE"
  | "SYNC_RESTORE_SOURCE_REQUIRED"
  | "SYNC_SENSITIVE_CONTENT_BLOCKED"
  | "REMOTE_UNAVAILABLE"
  | "SYNC_LEASE_INVALID"
  | "SYNC_LEASE_EXPIRED"
  | "SYNC_LEASE_FENCED"
  | "SYNC_LEASE_SCOPE_MISMATCH"
  | "SYNC_LEASE_BUSY"
  | "SYNC_PREPARE_NOT_FOUND"
  | "SYNC_PREPARE_EXPIRED"
  | "SYNC_COMMIT_AMBIGUOUS"
  | "SYNC_STREAM_INVALID"
  | "SYNC_STREAM_TOO_LARGE"
  | "SYNC_STREAM_ABORTED"
  | "SYNC_PULL_WORKSPACE_FAILED";

export class RemoteSyncError extends Error {
  readonly code: RemoteSyncErrorCode;
  readonly retryable: boolean;

  constructor(code: RemoteSyncErrorCode, retryable = false) {
    super(code);
    this.name = "RemoteSyncError";
    this.code = code;
    this.retryable = retryable;
  }
}

function fileMap(files: readonly ContentFile[]): Map<string, ContentFile> {
  return new Map(files.map((file) => [file.path, file]));
}

function sameFile(left: ContentFile | undefined, right: ContentFile | undefined): boolean {
  return left?.content_hash === right?.content_hash;
}

function operationPathSort(left: SyncOperation, right: SyncOperation): number {
  return left.path.localeCompare(right.path) ||
    (left.source_path ?? "").localeCompare(right.source_path ?? "");
}

function confirmationIdentity(confirmation: SyncConfirmation): unknown {
  return {
    ...confirmation,
    conflict_decisions: [...confirmation.conflict_decisions].sort((left, right) =>
      left.path.localeCompare(right.path) ||
      left.resolution.localeCompare(right.resolution)
    ),
    ...(confirmation.scan_confirmation === undefined ? {} : {
      scan_confirmation: {
        ...confirmation.scan_confirmation,
        overrides: [...confirmation.scan_confirmation.overrides].sort((left, right) =>
          left.finding_fingerprint.localeCompare(right.finding_fingerprint)
        )
      }
    })
  };
}

function classifyEligiblePath(
  path: string,
  expectedKind: ContentKind
): {
  ok: true;
  scope: SyncScope;
  scan_policy: "required" | "skip_content_scan";
} | { ok: false; kindMismatch: boolean } {
  const result = classifyContentPath({
    schema_version: 1,
    path,
    ...(expectedKind === "branch_file" ? { source_kind: "branch_file" } : {})
  });
  if (!("content_kind" in result)) return { ok: false, kindMismatch: false };
  if (result.content_kind !== expectedKind) return { ok: false, kindMismatch: true };
  return {
    ok: true,
    scope: result.sync_scope,
    scan_policy: result.content_scan_policy
  };
}

export function validateSyncOperation(
  operation: SyncOperation
): SyncOperationValidationResult {
  if (operation.action === "rename") {
    if (typeof operation.source_path !== "string") {
      return { ok: false, reason_code: "SYNC_RENAME_SOURCE_REQUIRED" };
    }
  } else if (operation.source_path !== undefined) {
    return { ok: false, reason_code: "SYNC_OPERATION_SOURCE_PATH_FORBIDDEN" };
  }
  const target = classifyEligiblePath(operation.path, operation.content_kind);
  if (!target.ok) {
    return {
      ok: false,
      reason_code: target.kindMismatch
        ? "SYNC_CONTENT_KIND_MISMATCH"
        : "SYNC_PATH_NOT_ELIGIBLE"
    };
  }
  if (operation.action === "rename") {
    const sourcePath = operation.source_path;
    if (sourcePath === undefined) {
      return { ok: false, reason_code: "SYNC_RENAME_SOURCE_REQUIRED" };
    }
    const source = classifyEligiblePath(sourcePath, operation.content_kind);
    if (!source.ok || source.scope !== target.scope) {
      return {
        ok: false,
        reason_code: source.ok || source.kindMismatch
          ? "SYNC_CONTENT_KIND_MISMATCH"
          : "SYNC_PATH_NOT_ELIGIBLE"
      };
    }
  }
  return { ok: true };
}

function verifyContent(file: ContentFile): void {
  const classified = classifyEligiblePath(file.path, file.content_kind);
  if (!classified.ok) throw new RemoteSyncError("SYNC_PATH_NOT_ELIGIBLE");
  const bytes = typeof file.content === "string"
    ? Buffer.byteLength(file.content)
    : file.content.byteLength;
  if (bytes !== file.size || sha256Bytes(file.content) !== file.content_hash) {
    throw new RemoteSyncError("SYNC_CONTENT_INVALID");
  }
}

function verifyFileSet(files: readonly ContentFile[]): void {
  const paths = new Set<string>();
  for (const file of files) {
    verifyContent(file);
    const folded = file.path.toLocaleLowerCase("en-US");
    if (paths.has(folded)) throw new RemoteSyncError("SYNC_PATH_COLLISION");
    paths.add(folded);
  }
}

function inScopes(file: ContentFile | undefined, scopes: ReadonlySet<SyncScope>): boolean {
  if (file === undefined) return false;
  const classified = classifyEligiblePath(file.path, file.content_kind);
  if (!classified.ok) throw new RemoteSyncError("SYNC_PATH_NOT_ELIGIBLE");
  return scopes.has(classified.scope);
}

type Direction = "push" | "pull";

function operation(
  action: SyncOperation["action"],
  path: string,
  kind: ContentKind,
  base: ContentFile | undefined,
  local: ContentFile | undefined,
  remote: ContentFile | undefined
): SyncOperation {
  return {
    path,
    content_kind: kind,
    action,
    local_hash: local?.content_hash,
    remote_hash: remote?.content_hash,
    base_hash: base?.content_hash
  };
}

function conflict(
  path: string,
  kind: ContentKind,
  base: ContentFile | undefined,
  local: ContentFile | undefined,
  remote: ContentFile | undefined
): SyncConflict {
  return {
    ...operation("modify", path, kind, base, local, remote),
    reason_code: "SYNC_CONTENT_CONFLICT"
  };
}

function detectRenames(
  operations: readonly SyncOperation[],
  direction: Direction
): SyncOperation[] {
  const additions = operations.filter((item) => item.action === "add");
  const deletions = operations.filter((item) => item.action === "delete");
  const consumedAdds = new Set<string>();
  const consumedDeletes = new Set<string>();
  const renames: SyncOperation[] = [];
  for (const removed of deletions) {
    const removedHash = direction === "push" ? removed.remote_hash : removed.local_hash;
    const added = additions.find((candidate) => {
      const addedHash = direction === "push" ? candidate.local_hash : candidate.remote_hash;
      return !consumedAdds.has(candidate.path) &&
        candidate.content_kind === removed.content_kind &&
        removedHash !== undefined && removedHash === addedHash;
    });
    if (added === undefined) continue;
    const rename: SyncOperation = {
      path: added.path,
      source_path: removed.path,
      content_kind: added.content_kind,
      action: "rename",
      local_hash: direction === "push" ? added.local_hash : removed.local_hash,
      remote_hash: added.remote_hash,
      base_hash: removed.base_hash
    };
    if (!validateSyncOperation(rename).ok) continue;
    consumedAdds.add(added.path);
    consumedDeletes.add(removed.path);
    renames.push(rename);
  }
  return [
    ...operations.filter((item) =>
      !(item.action === "add" && consumedAdds.has(item.path)) &&
      !(item.action === "delete" && consumedDeletes.has(item.path))
    ),
    ...renames
  ].sort(operationPathSort);
}

function planOperations(
  direction: Direction,
  scopes: readonly SyncScope[],
  view: SyncView
): { operations: SyncOperation[]; conflicts: SyncConflict[] } {
  const scopeSet = new Set(scopes);
  const baseline = fileMap(view.baseline_files);
  const local = fileMap(view.local_files);
  const remote = fileMap(view.remote_files);
  const paths = [...new Set([
    ...baseline.keys(), ...local.keys(), ...remote.keys()
  ])].sort();
  const operations: SyncOperation[] = [];
  const conflicts: SyncConflict[] = [];

  for (const path of paths) {
    const base = baseline.get(path);
    const here = local.get(path);
    const there = remote.get(path);
    const representative = here ?? there ?? base;
    if (!inScopes(representative, scopeSet)) continue;
    if (sameFile(here, there)) continue;
    if (representative === undefined) continue;
    const kind = representative.content_kind;

    if (base === undefined) {
      if (direction === "push") {
        if (here !== undefined && there === undefined) {
          operations.push(operation("add", path, kind, base, here, there));
        } else if (here !== undefined && there !== undefined) {
          conflicts.push(conflict(path, kind, base, here, there));
        }
      } else if (there !== undefined && here === undefined) {
        operations.push(operation("add", path, kind, base, here, there));
      } else if (here !== undefined && there !== undefined) {
        conflicts.push(conflict(path, kind, base, here, there));
      }
      continue;
    }

    if (here === undefined) {
      if (there === undefined) continue;
      if (sameFile(base, there)) {
        operations.push(operation(
          direction === "push" ? "delete" : "restore",
          path, kind, base, here, there
        ));
      } else {
        conflicts.push(conflict(path, kind, base, here, there));
      }
      continue;
    }
    if (there === undefined) {
      if (sameFile(base, here)) {
        if (direction === "pull") {
          operations.push(operation("delete", path, kind, base, here, there));
        }
      } else {
        conflicts.push(conflict(path, kind, base, here, there));
      }
      continue;
    }
    if (sameFile(base, here)) {
      if (direction === "pull") {
        operations.push(operation("modify", path, kind, base, here, there));
      }
      continue;
    }
    if (sameFile(base, there)) {
      if (direction === "push") {
        operations.push(operation("modify", path, kind, base, here, there));
      }
      continue;
    }
    conflicts.push(conflict(path, kind, base, here, there));
  }
  return {
    operations: detectRenames(operations, direction),
    conflicts: conflicts.sort(operationPathSort)
  };
}

function buildPreview(
  direction: Direction,
  scopes: readonly SyncScope[],
  source_ref: SourceRef,
  view: SyncView
): SyncPreview {
  verifyFileSet(view.baseline_files);
  verifyFileSet(view.local_files);
  verifyFileSet(view.remote_files);
  const planned = planOperations(direction, scopes, view);
  const security_scan = buildSecurityScan(direction, view, planned);
  const payload = {
    schema_version: 1,
    direction,
    scopes: [...new Set(scopes)].sort(),
    source_ref,
    base_version: view.base_version,
    remote_version: view.remote_version,
    operations: planned.operations,
    conflicts: planned.conflicts,
    security_scan
  };
  return {
    preview_hash: sha256Bytes(canonicalJson(payload)),
    source_ref: { ...source_ref },
    base_version: view.base_version,
    remote_version: view.remote_version,
    operations: planned.operations,
    conflicts: planned.conflicts,
    security_scan
  };
}

function scanInput(
  direction: Direction,
  view: SyncView,
  planned: { operations: readonly SyncOperation[]; conflicts: readonly SyncConflict[] }
): Record<string, string> {
  const desired = fileMap(direction === "push" ? view.local_files : view.remote_files);
  const paths = new Set([
    ...planned.operations.filter((item) => item.action !== "delete").map((item) => item.path),
    ...planned.conflicts.map((item) => item.path)
  ]);
  const files: Record<string, string> = {};
  for (const path of [...paths].sort()) {
    const file = desired.get(path);
    if (file === undefined) continue;
    const classified = classifyEligiblePath(file.path, file.content_kind);
    if (!classified.ok || classified.scan_policy === "skip_content_scan") continue;
    files[path] = typeof file.content === "string"
      ? file.content
      : new TextDecoder().decode(file.content);
  }
  return files;
}

function buildSecurityScan(
  direction: Direction,
  view: SyncView,
  planned: { operations: readonly SyncOperation[]; conflicts: readonly SyncConflict[] }
): SyncPreview["security_scan"] {
  const result = scanSensitiveFiles(scanInput(direction, view, planned), {
    now: new Date(0)
  });
  return {
    scanner_version: result.scanner_version,
    blocked: result.blocked,
    hard_blocked: result.hard_blocked,
    review_required: result.review_required,
    findings: result.findings
  };
}

function validateSecurityConfirmation(
  direction: Direction,
  view: SyncView,
  preview: SyncPreview,
  confirmation: SyncConfirmation,
  applied: readonly SyncOperation[]
): void {
  const scanConfirmation = confirmation.scan_confirmation;
  if (scanConfirmation !== undefined &&
      scanConfirmation.expected_preview_hash !== preview.preview_hash) {
    throw new RemoteSyncError("SYNC_PREVIEW_HASH_MISMATCH");
  }
  const applicableInput = scanInput(direction, view, {
    operations: applied,
    conflicts: []
  });
  const applicableScan = scanSensitiveFiles(applicableInput, { now: new Date(0) });
  if (!applicableScan.blocked) return;
  if (scanConfirmation === undefined) {
    throw new RemoteSyncError("SYNC_SENSITIVE_CONTENT_BLOCKED");
  }
  const rescanned = scanSensitiveFiles(
    applicableInput,
    { overrides: scanConfirmation.overrides, now: new Date(0) }
  );
  if (rescanned.blocked) {
    throw new RemoteSyncError("SYNC_SENSITIVE_CONTENT_BLOCKED");
  }
}

function decisionMap(
  preview: SyncPreview,
  confirmation: SyncConfirmation
): Map<string, ConflictDecision> {
  if (confirmation.preview_hash !== preview.preview_hash) {
    throw new RemoteSyncError("SYNC_PREVIEW_HASH_MISMATCH");
  }
  const decisions = new Map<string, ConflictDecision>();
  const eligiblePaths = new Set([
    ...preview.conflicts.map((item) => item.path),
    ...preview.operations
      .filter((item) => item.action === "restore")
      .map((item) => item.path)
  ]);
  for (const decision of confirmation.conflict_decisions) {
    if (decision.expected_preview_hash !== preview.preview_hash) {
      throw new RemoteSyncError("SYNC_PREVIEW_HASH_MISMATCH");
    }
    if (!eligiblePaths.has(decision.path) || decisions.has(decision.path) ||
        !conflictResolutionSchema.safeParse(decision.resolution).success) {
      throw new RemoteSyncError("SYNC_CONFLICT_DECISION_INVALID");
    }
    decisions.set(decision.path, decision);
  }
  return decisions;
}

function desiredConflictOperation(
  direction: Direction,
  conflictItem: SyncConflict,
  view: SyncView
): SyncOperation {
  const desired = direction === "push"
    ? fileMap(view.local_files).get(conflictItem.path)
    : fileMap(view.remote_files).get(conflictItem.path);
  const current = direction === "push"
    ? fileMap(view.remote_files).get(conflictItem.path)
    : fileMap(view.local_files).get(conflictItem.path);
  const action = desired === undefined
    ? "delete"
    : current === undefined ? "add" : "modify";
  return { ...operationFromConflict(conflictItem), action };
}

function operationFromConflict(item: SyncConflict): SyncOperation {
  return {
    path: item.path,
    source_path: item.source_path,
    content_kind: item.content_kind,
    action: item.action,
    local_hash: item.local_hash,
    remote_hash: item.remote_hash,
    base_hash: item.base_hash
  };
}

function applyOperations(
  original: readonly ContentFile[],
  desired: readonly ContentFile[],
  operations: readonly SyncOperation[]
): ContentFile[] {
  const result = fileMap(original);
  const desiredMap = fileMap(desired);
  for (const item of operations) {
    if (item.action === "delete") {
      result.delete(item.path);
      continue;
    }
    if (item.action === "rename") {
      if (item.source_path === undefined) {
        throw new RemoteSyncError("SYNC_CONTENT_INVALID");
      }
      result.delete(item.source_path);
    }
    const file = desiredMap.get(item.path);
    if (file === undefined) {
      throw new RemoteSyncError("SYNC_CONTENT_INVALID");
    }
    result.set(item.path, file);
  }
  return [...result.values()].sort((left, right) => left.path.localeCompare(right.path));
}

interface IdempotencyRecord {
  payload_hash: string;
  receipt: SyncReceipt;
}

function cloneSyncReceipt(receipt: SyncReceipt): SyncReceipt {
  return structuredClone(receipt);
}

function cloneArchiveReceipt(receipt: ArchiveSyncReceipt): ArchiveSyncReceipt {
  return structuredClone(receipt);
}

const ARCHIVE_PACKAGE_KEYS = [
  "request_id",
  "archive_id",
  "change_key",
  "archive_schema_version",
  "package_sha256",
  "content"
] as const;

function validatedArchivePackageRef(input: ArchivePackageRef): ArchivePackageRef {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input) ||
        (Object.getPrototypeOf(input) !== Object.prototype &&
          Object.getPrototypeOf(input) !== null)) {
      throw new Error("invalid archive package prototype");
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(descriptors).length !== ARCHIVE_PACKAGE_KEYS.length ||
        ARCHIVE_PACKAGE_KEYS.some((key) => {
          const descriptor = descriptors[key];
          return descriptor === undefined || !("value" in descriptor);
        })) {
      throw new Error("invalid archive package keys");
    }
    const values = Object.fromEntries(
      ARCHIVE_PACKAGE_KEYS.map((key) => [key, descriptors[key]?.value])
    ) as Record<(typeof ARCHIVE_PACKAGE_KEYS)[number], unknown>;
    if (typeof values.request_id !== "string" || values.request_id.length === 0 ||
        typeof values.archive_id !== "string" ||
        !/^arc_[a-z0-9._:-]+$/u.test(values.archive_id) ||
        typeof values.change_key !== "string" || values.change_key.length === 0 ||
        values.archive_schema_version !== 1 ||
        typeof values.package_sha256 !== "string" ||
        !/^sha256:[a-f0-9]{64}$/u.test(values.package_sha256) ||
        !(values.content instanceof Uint8Array)) {
      throw new Error("invalid archive package values");
    }
    return {
      request_id: values.request_id,
      archive_id: values.archive_id,
      change_key: values.change_key,
      archive_schema_version: values.archive_schema_version,
      package_sha256: values.package_sha256,
      content: values.content.slice()
    };
  } catch {
    throw new RemoteSyncError("ARCHIVE_PACKAGE_INVALID");
  }
}

function validatedPageLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RemoteSyncError("SYNC_PAGE_LIMIT_INVALID");
  }
  return limit;
}

function validateArchiveReceipt(
  receipt: ArchiveSyncReceipt,
  package_ref: ArchivePackageRef,
  source_ref: SourceRef,
  idempotency_key: string
): void {
  const identityMatches = receipt.request_id === package_ref.request_id &&
    receipt.idempotency_key === idempotency_key &&
    receipt.project_id === source_ref.project_id &&
    receipt.archive_id === package_ref.archive_id &&
    receipt.change_key === package_ref.change_key &&
    receipt.package_sha256 === package_ref.package_sha256;
  const stateIsCoherent = receipt.archive_status === "stored"
    ? receipt.retryable === false && receipt.reason_code === undefined
    : receipt.archive_status === "failed" && receipt.retryable === true &&
      receipt.reason_code !== undefined;
  if (!identityMatches || !stateIsCoherent) {
    throw new RemoteSyncError("ARCHIVE_RECEIPT_MISMATCH");
  }
}

export class RemoteSyncModule {
  readonly #port: RemoteSyncPort;
  readonly #idempotency = new Map<string, IdempotencyRecord>();

  constructor(port: RemoteSyncPort) {
    this.#port = port;
  }

  async previewPush(scopes: readonly SyncScope[], source_ref: SourceRef): Promise<SyncPreview> {
    return buildPreview("push", scopes, source_ref, await this.#port.readSyncView(source_ref));
  }

  async previewPull(scopes: readonly SyncScope[], source_ref: SourceRef): Promise<SyncPreview> {
    return buildPreview("pull", scopes, source_ref, await this.#port.readSyncView(source_ref));
  }

  async push(
    scopes: readonly SyncScope[],
    source_ref: SourceRef,
    confirmation: SyncConfirmation
  ): Promise<SyncReceipt> {
    return this.#execute("push", scopes, source_ref, confirmation);
  }

  async pull(
    scopes: readonly SyncScope[],
    source_ref: SourceRef,
    confirmation: SyncConfirmation
  ): Promise<SyncReceipt> {
    return this.#execute("pull", scopes, source_ref, confirmation);
  }

  async #execute(
    direction: Direction,
    scopes: readonly SyncScope[],
    source_ref: SourceRef,
    confirmation: SyncConfirmation
  ): Promise<SyncReceipt> {
    const normalizedScopes = [...new Set(scopes)].sort();
    const idempotencyKey = sha256Bytes(canonicalJson({
      schema_version: 1,
      operation: "remote_sync_command",
      direction,
      source_ref,
      confirmation_idempotency_key: confirmation.idempotency_key
    }));
    const payloadHash = sha256Bytes(canonicalJson({
      scopes: normalizedScopes,
      source_ref,
      confirmation: confirmationIdentity(confirmation)
    }));
    const prior = this.#idempotency.get(idempotencyKey);
    if (prior !== undefined) {
      if (prior.payload_hash !== payloadHash) {
        throw new RemoteSyncError("SYNC_IDEMPOTENCY_CONFLICT");
      }
      return cloneSyncReceipt(prior.receipt);
    }
    const durablePrior = await this.#port.getIdempotentSyncReceipt(
      source_ref,
      direction,
      idempotencyKey,
      payloadHash
    );
    if (durablePrior !== null) {
      this.#idempotency.set(idempotencyKey, {
        payload_hash: payloadHash,
        receipt: durablePrior
      });
      return cloneSyncReceipt(durablePrior);
    }

    const preLockPreview = buildPreview(
      direction,
      normalizedScopes,
      source_ref,
      await this.#port.readSyncView(source_ref)
    );
    if (preLockPreview.preview_hash !== confirmation.preview_hash) {
      throw new RemoteSyncError("SYNC_PREVIEW_STALE");
    }

    try {
      return await this.#port.withProtocolLock(source_ref, async () => {
      const lockedPrior = await this.#port.getIdempotentSyncReceipt(
        source_ref,
        direction,
        idempotencyKey,
        payloadHash
      );
      if (lockedPrior !== null) return cloneSyncReceipt(lockedPrior);
      const view = await this.#port.readSyncView(source_ref);
      const preview = buildPreview(direction, normalizedScopes, source_ref, view);
      if (preview.preview_hash !== confirmation.preview_hash) {
        throw new RemoteSyncError("SYNC_PREVIEW_STALE");
      }
      const decisions = decisionMap(preview, confirmation);
      const applied = [...preview.operations.filter((item) => item.action !== "restore")];
      const skipped = [...preview.operations.filter((item) => item.action === "restore")];
      let cancelled = false;

      for (const item of preview.operations.filter((operationItem) =>
        operationItem.action === "restore"
      )) {
        const choice = decisions.get(item.path);
        if (choice?.resolution === "cancel") {
          cancelled = true;
          break;
        }
        if (choice?.resolution !== "accept_remote") continue;
        if (choice.source_artifact_id !== preview.remote_version?.artifact_id ||
            choice.source_project_version !== preview.remote_version?.project_version) {
          throw new RemoteSyncError("SYNC_RESTORE_SOURCE_REQUIRED");
        }
        skipped.splice(skipped.findIndex((candidate) => candidate.path === item.path), 1);
        applied.push(item);
      }
      for (const item of cancelled ? [] : preview.conflicts) {
        const choice = decisions.get(item.path);
        if (choice === undefined) {
          throw new RemoteSyncError("SYNC_CONFLICT_DECISION_REQUIRED");
        }
        if (choice.resolution === "cancel") {
          cancelled = true;
          break;
        }
        const useDesired = direction === "push"
          ? choice.resolution === "keep_local"
          : choice.resolution === "accept_remote";
        if (useDesired) applied.push(desiredConflictOperation(direction, item, view));
        else skipped.push(operationFromConflict(item));
      }
      applied.sort(operationPathSort);
      skipped.sort(operationPathSort);

      if (cancelled) {
        const receipt: SyncReceipt = {
          preview_hash: preview.preview_hash,
          no_changes: false,
          applied: [],
          skipped: [
            ...preview.operations,
            ...preview.conflicts.map(operationFromConflict)
          ].sort(operationPathSort),
          retryable: [],
          reason_code: "SYNC_CANCELLED"
        };
        await this.#remember(direction, source_ref, idempotencyKey, payloadHash, receipt);
        return receipt;
      }
      validateSecurityConfirmation(
        direction,
        view,
        preview,
        confirmation,
        applied
      );
      if (applied.length === 0) {
        const receipt: SyncReceipt = {
          preview_hash: preview.preview_hash,
          no_changes: preview.operations.length === 0 && preview.conflicts.length === 0,
          applied: [], skipped, retryable: []
        };
        await this.#remember(direction, source_ref, idempotencyKey, payloadHash, receipt);
        return receipt;
      }

      if (direction === "push") {
        try {
          const files = applyOperations(view.remote_files, view.local_files, applied);
          const receipt = await this.#port.commitPush({
            source_ref,
            expected_revision: view.revision,
            preview_hash: preview.preview_hash,
            idempotency_key: idempotencyKey,
            payload_hash: payloadHash,
            files,
            operations: applied,
            skipped
          });
          this.#cacheDurableReceipt(
            direction, source_ref, idempotencyKey, payloadHash, receipt
          );
          return receipt;
        } catch (error) {
          if (error instanceof RemoteSyncError &&
              (error.code === "SYNC_PREVIEW_STALE" ||
                error.code === "SYNC_IDEMPOTENCY_CONFLICT")) {
            throw error;
          }
          const reason_code = error instanceof RemoteSyncError && error.code === "REMOTE_UNAVAILABLE"
            ? "REMOTE_UNAVAILABLE" as const
            : "REMOTE_PUBLISH_FAILED" as const;
          const receipt: SyncReceipt = {
            preview_hash: preview.preview_hash,
            no_changes: false,
            applied: [], skipped, retryable: applied, reason_code
          };
          await this.#remember(
            direction, source_ref, idempotencyKey, payloadHash, receipt, false
          );
          return receipt;
        }
      }

      const files = applyOperations(view.local_files, view.remote_files, applied);
      const command: PullCommit = {
        source_ref,
        expected_revision: view.revision,
        preview_hash: preview.preview_hash,
        idempotency_key: idempotencyKey,
        payload_hash: payloadHash,
        files,
        baseline_files: view.remote_files,
        operations: applied,
        skipped,
        project_version: preview.remote_version?.project_version,
        artifact_id: preview.remote_version?.artifact_id
      };
      try {
        const receipt = await this.#port.commitPull(command);
        this.#cacheDurableReceipt(
          direction, source_ref, idempotencyKey, payloadHash, receipt
        );
        return receipt;
      } catch (error) {
        if (error instanceof RemoteSyncError &&
            (error.code === "SYNC_PREVIEW_STALE" ||
              error.code === "SYNC_IDEMPOTENCY_CONFLICT")) {
          throw error;
        }
        const receipt: SyncReceipt = {
          preview_hash: preview.preview_hash,
          no_changes: false,
          applied: [], skipped, retryable: applied,
          reason_code: "PULL_TRANSACTION_FAILED"
        };
        await this.#remember(
          direction, source_ref, idempotencyKey, payloadHash, receipt, false
        );
        return receipt;
      }
      });
    } catch (error) {
      if (!(error instanceof RemoteSyncError) ||
          error.code !== "SYNC_LOCK_UNAVAILABLE") {
        throw error;
      }
      const receipt: SyncReceipt = {
        preview_hash: preLockPreview.preview_hash,
        no_changes: false,
        applied: [],
        skipped: preLockPreview.conflicts.map(operationFromConflict),
        retryable: preLockPreview.operations,
        reason_code: "SYNC_LOCK_UNAVAILABLE"
      };
      await this.#remember(
        direction, source_ref, idempotencyKey, payloadHash, receipt, false
      );
      return receipt;
    }
  }

  async #remember(
    direction: Direction,
    source_ref: SourceRef,
    idempotencyKey: string,
    payload_hash: string,
    receipt: SyncReceipt,
    durable = true
  ): Promise<void> {
    if (durable) {
      await this.#port.storeIdempotentSyncReceipt(
        source_ref,
        direction,
        idempotencyKey,
        payload_hash,
        receipt
      );
      this.#idempotency.set(idempotencyKey, {
        payload_hash,
        receipt: cloneSyncReceipt(receipt)
      });
    }
  }

  #cacheDurableReceipt(
    direction: Direction,
    source_ref: SourceRef,
    idempotencyKey: string,
    payload_hash: string,
    receipt: SyncReceipt
  ): void {
    this.#idempotency.set(idempotencyKey, {
      payload_hash,
      receipt: cloneSyncReceipt(receipt)
    });
  }

  async publishArchive(
    package_ref: ArchivePackageRef,
    source_ref: SourceRef,
    expectedPackageHash: string
  ): Promise<ArchiveSyncReceipt> {
    const packageSnapshot = validatedArchivePackageRef(package_ref);
    const sourceSnapshot = structuredClone(source_ref);
    if (expectedPackageHash !== packageSnapshot.package_sha256 ||
        sha256Bytes(packageSnapshot.content) !== expectedPackageHash) {
      throw new RemoteSyncError("ARCHIVE_HASH_MISMATCH");
    }
    const logicalIdentity = {
      project_id: sourceSnapshot.project_id,
      change_key: packageSnapshot.change_key,
      archive_schema_version: packageSnapshot.archive_schema_version
    };
    const logical_slot = sha256Bytes(canonicalJson(logicalIdentity));
    const idempotency_key = sha256Bytes(canonicalJson({
      ...logicalIdentity,
      package_sha256: packageSnapshot.package_sha256,
      archive_id: packageSnapshot.archive_id
    }));
    const receipt = await this.#port.commitArchive({
      package_ref: packageSnapshot,
      source_ref: sourceSnapshot,
      idempotency_key,
      logical_slot
    });
    validateArchiveReceipt(
      receipt,
      packageSnapshot,
      sourceSnapshot,
      idempotency_key
    );
    return cloneArchiveReceipt(receipt);
  }

  async getSyncStatus(source_ref: SourceRef): Promise<SyncStatus> {
    return this.#port.getSyncStatus(source_ref);
  }

  async listBranchSnapshots(project_ref: ProjectRef, cursor?: string, limit = 50) {
    const validLimit = validatedPageLimit(limit);
    return this.#port.listBranchSnapshots(project_ref, cursor, validLimit);
  }

  async listSnapshotVersions(branch_ref: BranchRef, cursor?: string, limit = 50) {
    const validLimit = validatedPageLimit(limit);
    return this.#port.listSnapshotVersions(branch_ref, cursor, validLimit);
  }

  async listSnapshotFiles(snapshot_ref: SnapshotRef, cursor?: string, limit = 50) {
    const validLimit = validatedPageLimit(limit);
    return this.#port.listSnapshotFiles(snapshot_ref, cursor, validLimit);
  }

  async getSnapshotFile(snapshot_ref: SnapshotRef, path: string) {
    return this.#port.getSnapshotFile(snapshot_ref, path);
  }
}
