import { canonicalJson, contentKindSchema } from "@hunter-harness/contracts";

import { sha256Bytes } from "../fs/hash.js";
import { RemoteSyncError } from "./module.js";
import type {
  ArchiveCommit,
  ArchiveSyncReceipt,
  BranchRef,
  BranchSnapshot,
  BranchSnapshotPage,
  ContentFile,
  ProjectRef,
  PullCommit,
  PushCommit,
  RemoteSyncPort,
  RemoteVersionIdentity,
  SnapshotFile,
  SnapshotFilePage,
  SnapshotRef,
  SnapshotVersionPage,
  SourceRef,
  SyncOperation,
  SyncReceipt,
  SyncStatus,
  SyncView
} from "./types.js";

export interface SyncSeedInput {
  base_version?: string;
  baseline_files?: readonly ContentFile[];
  local_files: readonly ContentFile[];
  remote_files: readonly ContentFile[];
}

type ArchiveReceiptIdentityField =
  | "request_id"
  | "idempotency_key"
  | "project_id"
  | "archive_id"
  | "change_key"
  | "package_sha256";

interface BranchState {
  source_ref: SourceRef;
  revision: number;
  base_version: string | null;
  baseline_files: ContentFile[];
  local_files: ContentFile[];
  remote_files: ContentFile[];
  remote_version?: RemoteVersionIdentity | undefined;
  versions: StoredSnapshot[];
}

interface StoredSnapshot {
  identity: RemoteVersionIdentity;
  files: StoredContentFile[];
  deleted_files: StoredContentFile[];
  operations: SyncOperation[];
}

type StoredContentFile = Omit<ContentFile, "content">;

interface CursorValue {
  scope: string;
  offset: number;
}

function cloneFile(file: ContentFile): ContentFile {
  return {
    ...file,
    ...(file.content instanceof Uint8Array
      ? { content: new Uint8Array(file.content) }
      : {})
  };
}

function cloneFiles(files: readonly ContentFile[]): ContentFile[] {
  return files.map(cloneFile).sort((left, right) => left.path.localeCompare(right.path));
}

function storedFile(file: ContentFile): StoredContentFile {
  return {
    path: file.path,
    content_kind: file.content_kind,
    content_hash: file.content_hash,
    size: file.size
  };
}

function branchKey(source_ref: Pick<SourceRef, "project_id" | "branch_name">): string {
  return `${source_ref.project_id}\u0000${source_ref.branch_name}`;
}

function manifestHash(files: readonly ContentFile[]): string {
  return sha256Bytes(canonicalJson(files.map((file) => ({
    path: file.path,
    content_kind: file.content_kind,
    content_hash: file.content_hash,
    size: file.size
  })).sort((left, right) => left.path.localeCompare(right.path))));
}

function pageLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RemoteSyncError("SYNC_PAGE_LIMIT_INVALID");
  }
  return limit;
}

function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined, scope: string): number {
  if (cursor === undefined) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorValue;
    if (parsed.scope !== scope || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) {
      throw new Error("invalid cursor");
    }
    return parsed.offset;
  } catch {
    throw new RemoteSyncError("SYNC_CURSOR_INVALID");
  }
}

function paginate<T>(items: readonly T[], cursor: string | undefined, limit: number, scope: string) {
  const size = pageLimit(limit);
  const offset = decodeCursor(cursor, scope);
  const page = items.slice(offset, offset + size);
  const next = offset + page.length;
  return {
    items: page,
    ...(next < items.length ? { next_cursor: encodeCursor({ scope, offset: next }) } : {})
  };
}

function snapshotFile(file: StoredContentFile, operations: readonly SyncOperation[]): SnapshotFile {
  const action = operations.find((item) => item.path === file.path)?.action;
  return {
    path: file.path,
    content_kind: file.content_kind,
    size: file.size,
    content_hash: file.content_hash,
    ...(action === undefined ? {} : { action })
  };
}

function legacyFixtureError(): never {
  throw new RemoteSyncError("SYNC_LEGACY_FIXTURE_INVALID");
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return legacyFixtureError();
  }
  return value as Record<string, unknown>;
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(record).every((key) => allowedSet.has(key));
}

function legacyContentFiles(value: unknown): ContentFile[] {
  if (!Array.isArray(value)) return legacyFixtureError();
  return value.map((item) => {
    const record = plainRecord(item);
    if (!hasOnlyKeys(record, [
      "path", "content_kind", "content_hash", "size", "content"
    ]) || typeof record.path !== "string" ||
        !contentKindSchema.safeParse(record.content_kind).success ||
        typeof record.content_hash !== "string" ||
        !/^sha256:[a-f0-9]{64}$/u.test(record.content_hash) ||
        typeof record.size !== "number" || !Number.isSafeInteger(record.size) ||
        typeof record.content !== "string" ||
        Buffer.byteLength(record.content) !== record.size ||
        sha256Bytes(record.content) !== record.content_hash) {
      return legacyFixtureError();
    }
    return {
      path: record.path,
      content_kind: record.content_kind as ContentFile["content_kind"],
      content_hash: record.content_hash,
      size: record.size,
      content: record.content
    };
  });
}

export interface MigratedSyncFixtureV1 extends SyncSeedInput {
  schema_version: 1;
  source_ref: SourceRef;
}

/** Test Adapter migration for v0 snapshots that predate branch identity. */
export function migrateLegacySyncFixture(input: unknown): MigratedSyncFixtureV1 {
  const record = plainRecord(input);
  if (!hasOnlyKeys(record, [
    "schema_version", "source_ref", "base_version",
    "baseline_files", "local_files", "remote_files"
  ]) || record.schema_version !== 0 || typeof record.base_version !== "string") {
    return legacyFixtureError();
  }
  const legacySource = plainRecord(record.source_ref);
  if (!hasOnlyKeys(legacySource, [
    "project_id", "commit_sha", "client_id", "change_key"
  ]) || typeof legacySource.project_id !== "string" ||
      !legacySource.project_id.startsWith("prj_") ||
      typeof legacySource.commit_sha !== "string" || legacySource.commit_sha === "" ||
      typeof legacySource.client_id !== "string" ||
      !legacySource.client_id.startsWith("cli_") ||
      (legacySource.change_key !== undefined &&
        typeof legacySource.change_key !== "string")) {
    return legacyFixtureError();
  }
  return {
    schema_version: 1,
    source_ref: {
      project_id: legacySource.project_id,
      branch_name: "unmarked",
      commit_sha: legacySource.commit_sha,
      client_id: legacySource.client_id,
      ...(legacySource.change_key === undefined
        ? {} : { change_key: legacySource.change_key })
    },
    base_version: record.base_version,
    baseline_files: legacyContentFiles(record.baseline_files),
    local_files: legacyContentFiles(record.local_files),
    remote_files: legacyContentFiles(record.remote_files)
  };
}

export class InMemoryRemoteSyncPort implements RemoteSyncPort {
  readonly #branches = new Map<string, BranchState>();
  readonly #archives = new Map<string, ArchiveSyncReceipt>();
  readonly #archiveSlots = new Map<string, {
    package_sha256: string;
    archive_id: string;
  }>();
  readonly #archiveRequestKeys: string[] = [];
  readonly #archiveLogicalSlots: string[] = [];
  readonly #blobs = new Map<string, Uint8Array | string>();
  readonly #syncReceipts = new Map<string, {
    payload_hash: string;
    receipt: SyncReceipt;
  }>();
  readonly #statuses = new Map<string, SyncStatus>();
  readonly #projectVersionCounters = new Map<string, number>();
  readonly #locks = new Map<string, Promise<void>>();
  #clock = 0;
  #pullFailureAfter: number | null = null;
  #nextPushFailure: RemoteSyncError | null = null;
  #pushFailureAfterSnapshot = false;
  #nextArchiveFailure = false;
  #nextLockFailure = false;
  #tamperArchiveField: ArchiveReceiptIdentityField | null = null;
  #paginationCalls = 0;

  seed(source_ref: SourceRef, input: SyncSeedInput): void {
    const remoteFiles = cloneFiles(input.remote_files);
    const baseVersion = input.base_version ?? null;
    const remote_version = remoteFiles.length === 0 ? undefined : {
      project_id: source_ref.project_id,
      branch_name: source_ref.branch_name,
      commit_sha: source_ref.commit_sha,
      ...(source_ref.change_key === undefined ? {} : { change_key: source_ref.change_key }),
      artifact_id: "art_seed",
      project_version: baseVersion ?? "pv_seed",
      uploaded_at: "2026-01-01T00:00:00.000Z",
      client_id: source_ref.client_id,
      manifest_hash: manifestHash(remoteFiles)
    };
    this.#branches.set(branchKey(source_ref), {
      source_ref: { ...source_ref },
      revision: 0,
      base_version: baseVersion,
      baseline_files: cloneFiles(input.baseline_files ?? []),
      local_files: cloneFiles(input.local_files),
      remote_files: remoteFiles,
      remote_version,
      versions: []
    });
  }

  setLocalFiles(source_ref: SourceRef, files: readonly ContentFile[]): void {
    const state = this.#state(source_ref);
    state.local_files = cloneFiles(files);
    state.revision += 1;
  }

  setRemoteFiles(source_ref: SourceRef, files: readonly ContentFile[]): void {
    const state = this.#state(source_ref);
    state.remote_files = cloneFiles(files);
    state.revision += 1;
    state.remote_version = {
      project_id: source_ref.project_id,
      branch_name: source_ref.branch_name,
      commit_sha: source_ref.commit_sha,
      ...(source_ref.change_key === undefined ? {} : { change_key: source_ref.change_key }),
      artifact_id: "art_concurrent",
      project_version: "pv_concurrent",
      uploaded_at: this.#now(),
      client_id: source_ref.client_id,
      manifest_hash: manifestHash(files)
    };
  }

  failPullAfterApply(count: number): void {
    this.#pullFailureAfter = count;
  }

  failNextPush(error: RemoteSyncError): void {
    this.#nextPushFailure = error;
  }

  failPushAfterSnapshot(): void {
    this.#pushFailureAfterSnapshot = true;
  }

  failNextArchive(): void {
    this.#nextArchiveFailure = true;
  }

  tamperNextArchiveReceipt(field: ArchiveReceiptIdentityField): void {
    this.#tamperArchiveField = field;
  }

  lastArchiveRequestKeys(): {
    request_keys: string[];
    logical_slots: string[];
  } {
    return {
      request_keys: [...this.#archiveRequestKeys],
      logical_slots: [...this.#archiveLogicalSlots]
    };
  }

  paginationCallCount(): number {
    return this.#paginationCalls;
  }

  failNextLock(): void {
    this.#nextLockFailure = true;
  }

  localFiles(source_ref: SourceRef): ContentFile[] {
    return cloneFiles(this.#state(source_ref).local_files);
  }

  versionCount(source_ref: SourceRef): number {
    return this.#state(source_ref).versions.length;
  }

  blobCount(source_ref: SourceRef): number {
    const prefix = `${source_ref.project_id}\u0000`;
    return [...this.#blobs.keys()].filter((key) => key.startsWith(prefix)).length;
  }

  snapshotStoresInlineContent(source_ref: SourceRef): boolean {
    return this.#state(source_ref).versions.some((version) =>
      version.files.some((file) => Object.hasOwn(file, "content"))
    );
  }

  archiveCount(source_ref: SourceRef): number {
    return [...this.#archives.values()].filter((item) =>
      item.project_id === source_ref.project_id
    ).length;
  }

  async withProtocolLock<T>(source_ref: SourceRef, work: () => Promise<T>): Promise<T> {
    if (this.#nextLockFailure) {
      this.#nextLockFailure = false;
      throw new RemoteSyncError("SYNC_LOCK_UNAVAILABLE", true);
    }
    const key = branchKey(source_ref);
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.#locks.set(key, queued);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.#locks.get(key) === queued) this.#locks.delete(key);
    }
  }

  async readSyncView(source_ref: SourceRef): Promise<SyncView> {
    const state = this.#state(source_ref);
    return {
      revision: String(state.revision),
      base_version: state.base_version,
      baseline_files: cloneFiles(state.baseline_files),
      local_files: cloneFiles(state.local_files),
      remote_files: cloneFiles(state.remote_files),
      remote_version: state.remote_version === undefined
        ? undefined
        : { ...state.remote_version }
    };
  }

  async getIdempotentSyncReceipt(
    source_ref: SourceRef,
    direction: "push" | "pull",
    idempotency_key: string,
    payload_hash: string
  ): Promise<SyncReceipt | null> {
    void source_ref;
    void direction;
    const prior = this.#syncReceipts.get(idempotency_key);
    if (prior === undefined) return null;
    if (prior.payload_hash !== payload_hash) {
      throw new RemoteSyncError("SYNC_IDEMPOTENCY_CONFLICT");
    }
    return structuredClone(prior.receipt);
  }

  async storeIdempotentSyncReceipt(
    source_ref: SourceRef,
    direction: "push" | "pull",
    idempotency_key: string,
    payload_hash: string,
    receipt: SyncReceipt
  ): Promise<void> {
    const prior = this.#syncReceipts.get(idempotency_key);
    if (prior !== undefined && prior.payload_hash !== payload_hash) {
      throw new RemoteSyncError("SYNC_IDEMPOTENCY_CONFLICT");
    }
    this.#syncReceipts.set(idempotency_key, {
      payload_hash,
      receipt: structuredClone(receipt)
    });
    this.#recordStatus(source_ref, direction, receipt);
  }

  async getSyncStatus(source_ref: SourceRef): Promise<SyncStatus> {
    return structuredClone(
      this.#statuses.get(this.#statusKey(source_ref)) ?? {
        source_ref: { ...source_ref }
      }
    );
  }

  async commitPush(command: PushCommit): Promise<SyncReceipt> {
    const state = this.#state(command.source_ref);
    const prior = await this.getIdempotentSyncReceipt(
      command.source_ref,
      "push",
      command.idempotency_key,
      command.payload_hash
    );
    if (prior !== null) return prior;
    if (this.#nextPushFailure !== null) {
      const error = this.#nextPushFailure;
      this.#nextPushFailure = null;
      throw error;
    }
    this.#assertRevision(state, command.expected_revision);
    const before = {
      remote_files: cloneFiles(state.remote_files),
      baseline_files: cloneFiles(state.baseline_files),
      base_version: state.base_version,
      remote_version: state.remote_version,
      versions: [...state.versions],
      revision: state.revision,
      blobs: new Map(this.#blobs)
    };
    const projectVersion = this.#nextProjectVersion(command.source_ref.project_id);
    const artifactId = `art_${projectVersion.slice(3)}`;
    const files = cloneFiles(command.files);
    const identity: RemoteVersionIdentity = {
      project_id: command.source_ref.project_id,
      branch_name: command.source_ref.branch_name,
      commit_sha: command.source_ref.commit_sha,
      ...(command.source_ref.change_key === undefined
        ? {} : { change_key: command.source_ref.change_key }),
      artifact_id: artifactId,
      project_version: projectVersion,
      uploaded_at: this.#now(),
      client_id: command.source_ref.client_id,
      manifest_hash: manifestHash(files)
    };
    const snapshot: StoredSnapshot = {
      identity,
      files: files.map(({ content, ...file }) => {
        const blobKey = `${command.source_ref.project_id}\u0000${file.content_hash}`;
        if (!this.#blobs.has(blobKey)) {
          this.#blobs.set(
            blobKey,
            content instanceof Uint8Array ? new Uint8Array(content) : content
          );
        }
        return file;
      }),
      deleted_files: command.operations.flatMap((item) => {
        const deletedPath = item.action === "delete"
          ? item.path
          : item.action === "rename" ? item.source_path : undefined;
        if (deletedPath === undefined) return [];
        const previous = state.remote_files.find((file) => file.path === deletedPath);
        if (previous === undefined) return [];
        return [storedFile(previous)];
      }),
      operations: command.operations.map((item) => ({ ...item }))
    };
    const receipt: SyncReceipt = {
      preview_hash: command.preview_hash,
      project_version: identity.project_version,
      artifact_id: identity.artifact_id,
      no_changes: false,
      applied: command.operations.map((item) => ({ ...item })),
      skipped: command.skipped.map((item) => ({ ...item })),
      retryable: []
    };
    try {
      state.remote_files = cloneFiles(files);
      state.baseline_files = cloneFiles(files);
      state.base_version = projectVersion;
      state.remote_version = identity;
      state.versions.push(snapshot);
      state.revision += 1;
      if (this.#pushFailureAfterSnapshot) {
        throw new Error("injected push transaction failure");
      }
      await this.storeIdempotentSyncReceipt(
        command.source_ref,
        "push",
        command.idempotency_key,
        command.payload_hash,
        receipt
      );
      return receipt;
    } catch (error) {
      state.remote_files = before.remote_files;
      state.baseline_files = before.baseline_files;
      state.base_version = before.base_version;
      state.remote_version = before.remote_version;
      state.versions = before.versions;
      state.revision = before.revision;
      this.#blobs.clear();
      for (const [key, value] of before.blobs) this.#blobs.set(key, value);
      throw error;
    } finally {
      this.#pushFailureAfterSnapshot = false;
    }
  }

  async commitPull(command: PullCommit): Promise<SyncReceipt> {
    const state = this.#state(command.source_ref);
    const prior = await this.getIdempotentSyncReceipt(
      command.source_ref,
      "pull",
      command.idempotency_key,
      command.payload_hash
    );
    if (prior !== null) return prior;
    this.#assertRevision(state, command.expected_revision);
    const beforeLocal = cloneFiles(state.local_files);
    const beforeBaseline = cloneFiles(state.baseline_files);
    const beforeVersion = state.base_version;
    const beforeRevision = state.revision;
    const receipt: SyncReceipt = {
      preview_hash: command.preview_hash,
      project_version: command.project_version,
      artifact_id: command.artifact_id,
      no_changes: false,
      applied: command.operations.map((item) => ({ ...item })),
      skipped: command.skipped.map((item) => ({ ...item })),
      retryable: []
    };
    try {
      if (this.#pullFailureAfter !== null &&
          command.operations.length >= this.#pullFailureAfter) {
        state.local_files = cloneFiles(command.files.slice(0, 1));
        throw new Error("injected pull transaction failure");
      }
      state.local_files = cloneFiles(command.files);
      state.baseline_files = cloneFiles(command.baseline_files);
      state.base_version = state.remote_version?.project_version ?? state.base_version;
      state.revision += 1;
      await this.storeIdempotentSyncReceipt(
        command.source_ref,
        "pull",
        command.idempotency_key,
        command.payload_hash,
        receipt
      );
      return receipt;
    } catch (error) {
      state.local_files = beforeLocal;
      state.baseline_files = beforeBaseline;
      state.base_version = beforeVersion;
      state.revision = beforeRevision;
      throw error;
    } finally {
      this.#pullFailureAfter = null;
    }
  }

  async commitArchive(command: ArchiveCommit): Promise<ArchiveSyncReceipt> {
    const { package_ref, source_ref, idempotency_key, logical_slot } = command;
    this.#archiveRequestKeys.push(idempotency_key);
    this.#archiveLogicalSlots.push(logical_slot);
    const existingPackage = this.#archiveSlots.get(logical_slot);
    if (existingPackage !== undefined &&
        (existingPackage.package_sha256 !== package_ref.package_sha256 ||
          existingPackage.archive_id !== package_ref.archive_id)) {
      throw new RemoteSyncError("ARCHIVE_PACKAGE_CONFLICT");
    }
    const prior = this.#archives.get(idempotency_key);
    if (prior !== undefined) {
      if (prior.package_sha256 !== package_ref.package_sha256 ||
          prior.archive_id !== package_ref.archive_id) {
        throw new RemoteSyncError("ARCHIVE_PACKAGE_CONFLICT");
      }
      return this.#maybeTamperArchiveReceipt(structuredClone(prior));
    }
    this.#archiveSlots.set(logical_slot, {
      package_sha256: package_ref.package_sha256,
      archive_id: package_ref.archive_id
    });
    if (this.#nextArchiveFailure) {
      this.#nextArchiveFailure = false;
      const state = this.#state(source_ref);
      const failed: ArchiveSyncReceipt = {
        request_id: package_ref.request_id,
        idempotency_key,
        project_id: source_ref.project_id,
        archive_id: package_ref.archive_id,
        change_key: package_ref.change_key,
        package_sha256: package_ref.package_sha256,
        archive_status: "failed",
        project_version: state.base_version ?? "pv_0",
        stored_at: this.#now(),
        retryable: true,
        reason_code: "REMOTE_UNAVAILABLE"
      };
      this.#recordArchiveStatus(source_ref, failed);
      return this.#maybeTamperArchiveReceipt(failed);
    }
    const receipt: ArchiveSyncReceipt = {
      request_id: package_ref.request_id,
      idempotency_key,
      project_id: source_ref.project_id,
      archive_id: package_ref.archive_id,
      change_key: package_ref.change_key,
      package_sha256: package_ref.package_sha256,
      archive_status: "stored",
      project_version: `pv_archive_${this.#archives.size + 1}`,
      stored_at: this.#now(),
      retryable: false
    };
    this.#archives.set(idempotency_key, structuredClone(receipt));
    this.#recordArchiveStatus(source_ref, receipt);
    return this.#maybeTamperArchiveReceipt(structuredClone(receipt));
  }

  async listBranchSnapshots(
    project_ref: ProjectRef,
    cursor: string | undefined,
    limit: number
  ): Promise<BranchSnapshotPage> {
    this.#paginationCalls += 1;
    const items: BranchSnapshot[] = [];
    for (const state of this.#branches.values()) {
      if (state.source_ref.project_id !== project_ref.project_id) continue;
      const latest = state.versions.at(-1);
      if (latest === undefined) continue;
      items.push({
        project_id: latest.identity.project_id,
        branch_name: latest.identity.branch_name,
        latest_version: latest.identity.project_version,
        commit_sha: latest.identity.commit_sha,
        artifact_id: latest.identity.artifact_id,
        manifest_hash: latest.identity.manifest_hash,
        file_count: latest.files.length,
        changed_count: latest.operations.length,
        uploaded_at: latest.identity.uploaded_at
      });
    }
    items.sort((left, right) =>
      right.uploaded_at.localeCompare(left.uploaded_at) ||
      left.branch_name.localeCompare(right.branch_name)
    );
    return paginate(items, cursor, limit, `branches:${project_ref.project_id}`);
  }

  async listSnapshotVersions(
    branch_ref: BranchRef,
    cursor: string | undefined,
    limit: number
  ): Promise<SnapshotVersionPage> {
    this.#paginationCalls += 1;
    const state = this.#branches.get(branchKey(branch_ref));
    const items = (state?.versions ?? []).map(({ identity }) => ({
      branch_name: identity.branch_name,
      project_version: identity.project_version,
      commit_sha: identity.commit_sha,
      artifact_id: identity.artifact_id,
      manifest_hash: identity.manifest_hash,
      uploaded_at: identity.uploaded_at
    })).sort((left, right) =>
      right.uploaded_at.localeCompare(left.uploaded_at) ||
      left.artifact_id.localeCompare(right.artifact_id)
    );
    return paginate(
      items, cursor, limit,
      `versions:${branch_ref.project_id}:${branch_ref.branch_name}`
    );
  }

  async listSnapshotFiles(
    snapshot_ref: SnapshotRef,
    cursor: string | undefined,
    limit: number
  ): Promise<SnapshotFilePage> {
    this.#paginationCalls += 1;
    const snapshot = this.#snapshot(snapshot_ref);
    const items = [
      ...snapshot.files.map((file) => snapshotFile(file, snapshot.operations)),
      ...snapshot.deleted_files.map((file): SnapshotFile => ({
        path: file.path,
        content_kind: file.content_kind,
        size: file.size,
        content_hash: file.content_hash,
        action: "delete"
      }))
    ].sort((left, right) => left.path.localeCompare(right.path));
    return paginate(
      items, cursor, limit,
      `files:${snapshot_ref.project_id}:${snapshot_ref.artifact_id}`
    );
  }

  async getSnapshotFile(snapshot_ref: SnapshotRef, path: string): Promise<SnapshotFile | null> {
    const snapshot = this.#snapshot(snapshot_ref);
    const file = snapshot.files.find((item) => item.path === path);
    if (file !== undefined) return snapshotFile(file, snapshot.operations);
    const deleted = snapshot.deleted_files.find((item) => item.path === path);
    return deleted === undefined ? null : {
      path: deleted.path,
      content_kind: deleted.content_kind,
      size: deleted.size,
      content_hash: deleted.content_hash,
      action: "delete"
    };
  }

  #state(source_ref: SourceRef): BranchState {
    const state = this.#branches.get(branchKey(source_ref));
    if (state === undefined) {
      const created: BranchState = {
        source_ref: { ...source_ref },
        revision: 0,
        base_version: null,
        baseline_files: [],
        local_files: [],
        remote_files: [],
        versions: []
      };
      this.#branches.set(branchKey(source_ref), created);
      return created;
    }
    return state;
  }

  #snapshot(snapshot_ref: SnapshotRef): StoredSnapshot {
    for (const state of this.#branches.values()) {
      if (state.source_ref.project_id !== snapshot_ref.project_id) continue;
      const snapshot = state.versions.find((item) =>
        item.identity.artifact_id === snapshot_ref.artifact_id
      );
      if (snapshot !== undefined) return snapshot;
    }
    throw new RemoteSyncError("SYNC_SNAPSHOT_NOT_FOUND");
  }

  #assertRevision(state: BranchState, expected: string): void {
    if (String(state.revision) !== expected) {
      throw new RemoteSyncError("SYNC_PREVIEW_STALE");
    }
  }

  #statusKey(source_ref: SourceRef): string {
    return canonicalJson(source_ref);
  }

  #recordStatus(
    source_ref: SourceRef,
    direction: "push" | "pull",
    receipt: SyncReceipt
  ): void {
    const key = this.#statusKey(source_ref);
    const current = this.#statuses.get(key) ?? { source_ref: { ...source_ref } };
    this.#statuses.set(key, direction === "push"
      ? { ...current, last_push: structuredClone(receipt) }
      : { ...current, last_pull: structuredClone(receipt) });
  }

  #recordArchiveStatus(
    source_ref: SourceRef,
    receipt: ArchiveSyncReceipt
  ): void {
    const key = this.#statusKey(source_ref);
    const current = this.#statuses.get(key) ?? { source_ref: { ...source_ref } };
    this.#statuses.set(key, {
      ...current,
      last_archive: structuredClone(receipt)
    });
  }

  #maybeTamperArchiveReceipt(receipt: ArchiveSyncReceipt): ArchiveSyncReceipt {
    const field = this.#tamperArchiveField;
    this.#tamperArchiveField = null;
    if (field === null) return receipt;
    return { ...receipt, [field]: `${receipt[field]}_mismatch` };
  }

  #nextProjectVersion(projectId: string): string {
    const next = (this.#projectVersionCounters.get(projectId) ?? 0) + 1;
    this.#projectVersionCounters.set(projectId, next);
    return `pv_${next}`;
  }

  #now(): string {
    const value = new Date(Date.UTC(2026, 0, 1, 0, 0, this.#clock));
    this.#clock += 1;
    return value.toISOString();
  }
}
