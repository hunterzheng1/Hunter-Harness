import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { canonicalJson } from "@hunter-harness/contracts";

import { sha256Bytes, sha256File } from "../fs/hash.js";
import { normalizeManagedPath } from "../fs/path-safety.js";
import { scanSensitiveFiles } from "../security/scanner.js";
import { atomicWriteFile, atomicWriteJson } from "../state/atomic.js";
import type {
  SnapshotRecord,
  TransactionJournal,
  TransactionJournalOperation
} from "./journal.js";

export interface RecoveryStoreOptions {
  root: string;
  managedPaths: readonly string[];
  /**
   * Exact hashes of immutable, bundled payloads whose scanner matches are
   * documented fixture text rather than runtime credentials.
   */
  allowedSensitiveContentHashes?: readonly string[];
}

export interface RecoveryLocationOptions {
  recoveryRoot?: string;
  projectIdentity?: string;
}

export interface RecoveryLocation {
  source: "project" | "durable";
  transactionRoot: string;
  journal: TransactionJournal;
  mirror: DurableRecoveryMirror | null;
}

export function resolveRecoveryRoot(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform = process.platform,
  userHome = homedir()
): string {
  const override = env.HUNTER_HARNESS_RECOVERY_ROOT?.trim();
  if (override !== undefined && override !== "") {
    return resolve(override);
  }
  if (platform === "win32") {
    return join(
      env.LOCALAPPDATA?.trim() || join(userHome, "AppData", "Local"),
      "HunterHarness",
      "recovery"
    );
  }
  return join(
    env.XDG_STATE_HOME?.trim() || join(userHome, ".local", "state"),
    "hunter-harness",
    "recovery"
  );
}

interface DurableRecoveryIndexEntry {
  recoveryId: string;
  projectKey: string;
  projectRootHash: string;
  projectIdentityHash: string;
  createdAt: string;
}

interface DurableRecoveryIndex {
  schemaVersion: 1;
  entries: DurableRecoveryIndexEntry[];
}

export interface DurableRecoveryMirror {
  schemaVersion: 1;
  recoveryId: string;
  projectRootHash: string;
  projectIdentityHash: string;
  mirroredOperationIndexes: number[];
  mirroredSnapshotPaths: string[];
  snapshotDigest: string;
}

export class RecoveryMirrorSensitiveContentError extends Error {
  readonly code = "RECOVERY_MIRROR_SENSITIVE_CONTENT";

  constructor() {
    super("durable recovery payload contains sensitive content");
    this.name = "RecoveryMirrorSensitiveContentError";
  }
}

export class RecoveryMutationConflictError extends Error {
  readonly code = "RECOVERY_CONFLICT";

  constructor() {
    super("another terminal recovery action is active");
    this.name = "RecoveryMutationConflictError";
  }
}

export class InvalidRecoveryIdError extends Error {
  readonly code = "RECOVERY_ID_INVALID";

  constructor() {
    super("recoveryId must use a bounded portable identifier");
    this.name = "InvalidRecoveryIdError";
  }
}

export class RecoveryStoreBoundaryError extends Error {
  readonly code = "RECOVERY_STORE_BOUNDARY_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "RecoveryStoreBoundaryError";
  }
}

const RECOVERY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/;
const STORAGE_KEY_PATTERN = /^[a-f0-9]{64}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_LOCK_CLAIMS = 4096;
const MAX_INDEX_PROJECTION_ATTEMPTS = 24;

export function assertValidRecoveryId(value: string): void {
  if (!RECOVERY_ID_PATTERN.test(value) || value === "." || value === "..") {
    throw new InvalidRecoveryIdError();
  }
}

function assertStorageKey(value: string): void {
  if (!STORAGE_KEY_PATTERN.test(value)) {
    throw new RecoveryStoreBoundaryError("durable recovery index contains an invalid project key");
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    return true;
  }
}

interface OwnershipLockRecord {
  pid: number;
  nonce: string;
  createdAt: string;
  state: "active" | "released";
  releasedAt?: string;
}

interface ParsedOwnershipLock {
  pid: number;
  nonce: string;
  state: "active" | "released";
}

export interface RecoveryMutationLockOptions {
  beforeStaleClaim?: () => Promise<void>;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readFileIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

async function lstatIfExists(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

function parseOwnershipLock(
  path: string,
  serialized: string
): ParsedOwnershipLock | null {
  try {
    const parsed = JSON.parse(serialized) as {
      pid?: unknown;
      nonce?: unknown;
      createdAt?: unknown;
      state?: unknown;
    };
    if (typeof parsed.pid !== "number" ||
        !Number.isSafeInteger(parsed.pid) ||
        parsed.pid <= 0 ||
        typeof parsed.createdAt !== "string" ||
        Number.isNaN(Date.parse(parsed.createdAt)) ||
        (parsed.state !== undefined &&
          parsed.state !== "active" &&
          parsed.state !== "released")) {
      return null;
    }
    const nonce = typeof parsed.nonce === "string" && parsed.nonce !== ""
      ? parsed.nonce
      : `legacy-${sha256Bytes(`${path}\0${serialized}`)}`;
    return {
      pid: parsed.pid,
      nonce,
      state: parsed.state ?? "active"
    };
  } catch {
    return null;
  }
}

function successorLockPath(
  basePath: string,
  currentPath: string,
  nonce: string
): string {
  const digest = sha256Bytes(`${currentPath}\0${nonce}`)
    .slice("sha256:".length);
  return `${basePath}.claim-${digest}`;
}

async function acquireOwnershipLock(
  lockPath: string,
  options: RecoveryMutationLockOptions = {}
): Promise<() => Promise<void>> {
  const owner: OwnershipLockRecord = {
    pid: process.pid,
    nonce: randomUUID(),
    createdAt: new Date().toISOString(),
    state: "active"
  };
  const serializedOwner = JSON.stringify(owner);
  let candidatePath = lockPath;
  for (let attempt = 0; attempt < MAX_LOCK_CLAIMS; attempt += 1) {
    try {
      await writeFile(candidatePath, serializedOwner, {
        flag: "wx",
        mode: 0o600
      });
      return async () => {
        const current = await readFileIfExists(candidatePath);
        const parsed = current === null
          ? null
          : parseOwnershipLock(candidatePath, current);
        if (parsed?.pid === owner.pid &&
            parsed.nonce === owner.nonce &&
            parsed.state === "active") {
          await atomicWriteJson(candidatePath, {
            ...owner,
            state: "released",
            releasedAt: new Date().toISOString()
          } satisfies OwnershipLockRecord);
          await makePrivateFile(candidatePath);
        }
      };
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) ||
          error.code !== "EEXIST") {
        throw error;
      }
    }

    const current = await readFileIfExists(candidatePath);
    if (current === null) {
      continue;
    }
    const parsed = parseOwnershipLock(candidatePath, current);
    if (parsed === null ||
        (parsed.state === "active" && processIsAlive(parsed.pid))) {
      throw new RecoveryMutationConflictError();
    }
    await options.beforeStaleClaim?.();
    candidatePath = successorLockPath(lockPath, candidatePath, parsed.nonce);
  }
  throw new RecoveryMutationConflictError();
}

export async function acquireRecoveryMutationLock(
  transactionRoot: string,
  options: RecoveryMutationLockOptions = {}
): Promise<() => Promise<void>> {
  return acquireOwnershipLock(
    join(transactionRoot, "recovery.lock"),
    options
  );
}

async function makePrivateFile(path: string): Promise<void> {
  if (process.platform !== "win32") {
    await chmod(path, 0o600);
  }
}

function projectRootHash(projectRoot: string): string {
  const normalized = resolve(projectRoot).replaceAll("\\", "/");
  return sha256Bytes(process.platform === "win32" ? normalized.toLowerCase() : normalized);
}

function identityHash(projectIdentity: string | null | undefined): string {
  return sha256Bytes(projectIdentity ?? "unbound");
}

function projectKey(
  projectRoot: string,
  projectIdentity: string | null | undefined
): string {
  return sha256Bytes(canonicalJson({
    project_root_hash: projectRootHash(projectRoot),
    project_identity_hash: identityHash(projectIdentity)
  })).slice("sha256:".length);
}

function durableTransactionRoot(
  root: string,
  key: string,
  recoveryId: string
): string {
  assertStorageKey(key);
  assertValidRecoveryId(recoveryId);
  return join(resolve(root), "recoveries", key, recoveryId);
}

function normalizedStoragePath(value: string): string {
  const normalized = normalizeManagedPath(value);
  if (normalized !== value) {
    throw new RecoveryStoreBoundaryError("recovery journal contains a non-canonical managed path");
  }
  return normalized;
}

function snapshotName(path: string): string {
  return Buffer.from(path).toString("base64url");
}

function assertJournalStorageShape(
  journal: TransactionJournal,
  expectedRecoveryId: string
): void {
  assertValidRecoveryId(journal.transaction_id);
  const recoveryId = journal.recovery_id ?? journal.transaction_id;
  assertValidRecoveryId(recoveryId);
  if (recoveryId !== expectedRecoveryId ||
      !Array.isArray(journal.operations) ||
      !Array.isArray(journal.snapshots)) {
    throw new RecoveryStoreBoundaryError("recovery journal identity is inconsistent");
  }
  for (const operation of journal.operations) {
    for (const path of operationPaths(operation)) normalizedStoragePath(path);
  }
  for (const snapshot of journal.snapshots) {
    normalizedStoragePath(snapshot.path);
    const expectedName = snapshot.existed ? snapshotName(snapshot.path) : null;
    if (snapshot.snapshot_name !== expectedName) {
      throw new RecoveryStoreBoundaryError("recovery snapshot name is inconsistent");
    }
  }
}

function pathIsWithin(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === "" || (!child.startsWith(".." + sep) && child !== ".." &&
    !isAbsolute(child));
}

interface RecoveryRootBoundary {
  resolvedRoot: string;
  realRoot: string;
}

async function inspectRecoveryRoot(
  root: string
): Promise<RecoveryRootBoundary | null> {
  const resolvedRoot = resolve(root);
  const rootStat = await lstatIfExists(resolvedRoot);
  if (rootStat === null) return null;
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new RecoveryStoreBoundaryError(
      "durable recovery root must be a real directory"
    );
  }
  const realRoot = await realpath(resolvedRoot);
  // The root itself must be a real directory, but its parent may be a
  // runner-managed junction (common on Windows). Keep the canonical path as
  // the boundary used by all child containment checks instead of rejecting a
  // safe parent alias before the transaction can start.
  return { resolvedRoot, realRoot };
}

function containedRelativePath(
  boundary: RecoveryRootBoundary,
  candidate: string
): string {
  const resolvedCandidate = resolve(candidate);
  if (!pathIsWithin(boundary.resolvedRoot, resolvedCandidate)) {
    throw new RecoveryStoreBoundaryError(
      "durable recovery path escapes its store"
    );
  }
  return relative(boundary.resolvedRoot, resolvedCandidate);
}

async function validateContainedDirectoryComponent(
  boundary: RecoveryRootBoundary,
  path: string
): Promise<void> {
  const entryStat = await lstat(path);
  if (entryStat.isSymbolicLink() || !entryStat.isDirectory()) {
    throw new RecoveryStoreBoundaryError(
      "durable recovery path contains a link or non-directory"
    );
  }
  const realPath = await realpath(path);
  if (!pathIsWithin(boundary.realRoot, realPath)) {
    throw new RecoveryStoreBoundaryError(
      "durable recovery path resolves outside its store"
    );
  }
}

async function containedDirectoryExists(
  root: string,
  directory: string
): Promise<boolean> {
  const boundary = await inspectRecoveryRoot(root);
  if (boundary === null) return false;
  const child = containedRelativePath(boundary, directory);
  let current = boundary.resolvedRoot;
  if (child === "") return true;
  for (const component of child.split(sep)) {
    current = join(current, component);
    if (await lstatIfExists(current) === null) return false;
    await validateContainedDirectoryComponent(boundary, current);
  }
  return true;
}

async function ensurePrivateContainedDirectory(
  root: string,
  directory: string
): Promise<void> {
  const boundary = await inspectRecoveryRoot(root);
  if (boundary === null) {
    throw new RecoveryStoreBoundaryError(
      "durable recovery root is unavailable"
    );
  }
  const child = containedRelativePath(boundary, directory);
  let current = boundary.resolvedRoot;
  if (child === "") return;
  for (const component of child.split(sep)) {
    current = join(current, component);
    if (await lstatIfExists(current) === null) {
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) ||
            error.code !== "EEXIST") {
          throw error;
        }
      }
    }
    await validateContainedDirectoryComponent(boundary, current);
    if (process.platform !== "win32") {
      await chmod(current, 0o700);
    }
  }
}

async function containedRegularFileExists(
  root: string,
  path: string
): Promise<boolean> {
  if (!await containedDirectoryExists(root, dirname(path))) return false;
  const fileStat = await lstatIfExists(path);
  if (fileStat === null) return false;
  if (fileStat.isSymbolicLink() || !fileStat.isFile() ||
      fileStat.nlink !== 1) {
    throw new RecoveryStoreBoundaryError(
      "durable recovery file is linked, shared, or non-file"
    );
  }
  return true;
}

async function assertSafeContainedFileDestination(
  root: string,
  path: string
): Promise<void> {
  if (!await containedDirectoryExists(root, dirname(path))) {
    throw new RecoveryStoreBoundaryError(
      "durable recovery destination directory is unavailable"
    );
  }
  const destinationStat = await lstatIfExists(path);
  if (destinationStat !== null &&
      (destinationStat.isSymbolicLink() || !destinationStat.isFile() ||
        destinationStat.nlink !== 1)) {
    throw new RecoveryStoreBoundaryError(
      "durable recovery destination is linked, shared, or non-file"
    );
  }
}

async function atomicCopyIntoRecoveryRoot(
  root: string,
  source: string,
  destination: string
): Promise<void> {
  await assertSafeContainedFileDestination(root, destination);
  await atomicWriteFile(destination, await readFile(source));
  if (!await containedRegularFileExists(root, destination)) {
    throw new RecoveryStoreBoundaryError(
      "durable recovery copy destination is unavailable"
    );
  }
  await makePrivateFile(destination);
}

async function assertExistingContained(
  parent: string,
  candidate: string
): Promise<void> {
  const [resolvedParent, resolvedCandidate] = await Promise.all([
    realpath(parent),
    realpath(candidate)
  ]);
  if (!pathIsWithin(resolvedParent, resolvedCandidate)) {
    throw new RecoveryStoreBoundaryError("recovery transaction root escapes its store");
  }
}

async function preparePrivateRecoveryRoot(
  projectRoot: string,
  recoveryRoot: string
): Promise<void> {
  const project = resolve(projectRoot);
  const root = resolve(recoveryRoot);
  if (pathIsWithin(project, root) || pathIsWithin(root, project)) {
    throw new RecoveryStoreBoundaryError(
      "durable recovery root must not overlap the project"
    );
  }
  const rootStat = await lstatIfExists(root);
  if (rootStat?.isSymbolicLink()) {
    throw new RecoveryStoreBoundaryError("durable recovery root must not be a symbolic link");
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const boundary = await inspectRecoveryRoot(root);
  if (boundary === null) {
    throw new RecoveryStoreBoundaryError("durable recovery root is unavailable");
  }
  const [realProject, realRoot] = await Promise.all([
    realpath(project),
    Promise.resolve(boundary.realRoot)
  ]);
  if (pathIsWithin(realProject, realRoot) || pathIsWithin(realRoot, realProject)) {
    throw new RecoveryStoreBoundaryError(
      "durable recovery root resolves across the project boundary"
    );
  }
  if (process.platform !== "win32") {
    await chmod(root, 0o700);
  }
}

function operationPaths(operation: TransactionJournalOperation): string[] {
  return operation.operation === "rename"
    ? [operation.from_path, operation.to_path]
    : [operation.path];
}

function normalizedManagedPaths(
  _journal: TransactionJournal,
  configured: readonly string[] | undefined
): Set<string> {
  const values = configured ?? [];
  return new Set(values.map(normalizeManagedPath));
}

function operationIsManaged(
  operation: TransactionJournalOperation,
  managed: ReadonlySet<string>
): boolean {
  return operationPaths(operation).every((path) => managed.has(path));
}

function durableJournal(journal: TransactionJournal): TransactionJournal {
  return {
    ...journal,
    failure: journal.failure === null
      ? null
      : `RECOVERY_FAILURE_RECORDED:${sha256Bytes(journal.failure)}`
  };
}

function assertValidIndexEntry(
  entry: DurableRecoveryIndexEntry
): void {
  assertValidRecoveryId(entry.recoveryId);
  assertStorageKey(entry.projectKey);
  if (!SHA256_PATTERN.test(entry.projectRootHash) ||
      !SHA256_PATTERN.test(entry.projectIdentityHash) ||
      typeof entry.createdAt !== "string" ||
      Number.isNaN(Date.parse(entry.createdAt))) {
    throw new RecoveryStoreBoundaryError(
      "durable recovery index contains invalid metadata"
    );
  }
}

function parseIndexEntry(value: unknown): DurableRecoveryIndexEntry {
  if (value === null || typeof value !== "object") {
    throw new RecoveryStoreBoundaryError(
      "durable recovery index contains invalid metadata"
    );
  }
  const entry = value as Partial<DurableRecoveryIndexEntry>;
  if (typeof entry.recoveryId !== "string" ||
      typeof entry.projectKey !== "string" ||
      typeof entry.projectRootHash !== "string" ||
      typeof entry.projectIdentityHash !== "string" ||
      typeof entry.createdAt !== "string") {
    throw new RecoveryStoreBoundaryError(
      "durable recovery index contains invalid metadata"
    );
  }
  const parsed: DurableRecoveryIndexEntry = {
    recoveryId: entry.recoveryId,
    projectKey: entry.projectKey,
    projectRootHash: entry.projectRootHash,
    projectIdentityHash: entry.projectIdentityHash,
    createdAt: entry.createdAt
  };
  assertValidIndexEntry(parsed);
  return parsed;
}

function indexEntryKey(entry: DurableRecoveryIndexEntry): string {
  return `${entry.projectKey}\0${entry.recoveryId}`;
}

function indexEntryName(entry: DurableRecoveryIndexEntry): string {
  return `${sha256Bytes(canonicalJson({
    projectKey: entry.projectKey,
    recoveryId: entry.recoveryId
  })).slice("sha256:".length)}.json`;
}

async function readLegacyIndex(root: string): Promise<DurableRecoveryIndexEntry[]> {
  const indexPath = join(resolve(root), "index.json");
  if (!await containedRegularFileExists(root, indexPath)) return [];
  let serialized: string;
  try {
    serialized = await readFile(indexPath, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }
  let parsed: { schemaVersion?: unknown; entries?: unknown };
  try {
    parsed = JSON.parse(serialized) as {
      schemaVersion?: unknown;
      entries?: unknown;
    };
  } catch {
    throw new RecoveryStoreBoundaryError(
      "durable recovery index contains invalid JSON"
    );
  }
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) {
    throw new RecoveryStoreBoundaryError(
      "durable recovery index contains invalid metadata"
    );
  }
  return parsed.entries.map(parseIndexEntry);
}

async function readAuthoritativeIndexEntries(
  root: string
): Promise<DurableRecoveryIndexEntry[]> {
  const entryRoot = join(resolve(root), "recoveries", ".index");
  if (!await containedDirectoryExists(root, entryRoot)) return [];
  let names: string[];
  try {
    names = await readdir(entryRoot);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const entries: DurableRecoveryIndexEntry[] = [];
  for (const name of names.filter((candidate) => candidate.endsWith(".json")).sort()) {
    const entryPath = join(entryRoot, name);
    const entryStat = await lstatIfExists(entryPath);
    if (entryStat === null) continue;
    if (entryStat.isSymbolicLink() || !entryStat.isFile()) {
      throw new RecoveryStoreBoundaryError(
        "durable recovery index entry is a link or non-file"
      );
    }
    let serialized: string;
    try {
      serialized = await readFile(entryPath, "utf8");
    } catch (error) {
      if (isNotFoundError(error)) continue;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new RecoveryStoreBoundaryError(
        "durable recovery index contains invalid metadata"
      );
    }
    const entry = parseIndexEntry(parsed);
    if (indexEntryName(entry) !== name) {
      throw new RecoveryStoreBoundaryError(
        "durable recovery index entry name is inconsistent"
      );
    }
    entries.push(entry);
  }
  return entries;
}

async function readAuthoritativeIndexEntryNames(
  root: string
): Promise<string[]> {
  const entryRoot = join(resolve(root), "recoveries", ".index");
  if (!await containedDirectoryExists(root, entryRoot)) return [];
  let names: string[];
  try {
    names = await readdir(entryRoot);
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }
  const entries = names
    .filter((name) => name.endsWith(".json"))
    .sort();
  if (!entries.every((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
    throw new RecoveryStoreBoundaryError(
      "durable recovery index entry name is invalid"
    );
  }
  return entries;
}

async function readIndex(root: string): Promise<DurableRecoveryIndex> {
  const entries = new Map<string, DurableRecoveryIndexEntry>();
  for (const entry of await readLegacyIndex(root)) {
    entries.set(indexEntryKey(entry), entry);
  }
  for (const entry of await readAuthoritativeIndexEntries(root)) {
    entries.set(indexEntryKey(entry), entry);
  }
  return {
    schemaVersion: 1,
    entries: [...entries.values()].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.recoveryId.localeCompare(right.recoveryId)
    )
  };
}

function entriesInclude(
  available: readonly DurableRecoveryIndexEntry[],
  required: readonly DurableRecoveryIndexEntry[]
): boolean {
  const byKey = new Map(
    available.map((entry) => [indexEntryKey(entry), canonicalJson(entry)])
  );
  return required.every((entry) =>
    byKey.get(indexEntryKey(entry)) === canonicalJson(entry)
  );
}

function retryableProjectionContentionError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error) ||
      typeof error.code !== "string") {
    return false;
  }
  return new Set(["EACCES", "EBUSY", "ENOENT", "ENOTEMPTY", "EPERM"])
    .has(error.code);
}

function projectionRetryDelay(attempt: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, Math.min(50, (attempt + 1) * 2));
  });
}

async function writeIndexProjection(root: string): Promise<void> {
  const indexPath = join(resolve(root), "index.json");
  for (let attempt = 0; attempt < MAX_INDEX_PROJECTION_ATTEMPTS; attempt += 1) {
    let intended: DurableRecoveryIndex;
    try {
      intended = await readIndex(root);
    } catch (error) {
      if (!retryableProjectionContentionError(error) ||
          attempt + 1 === MAX_INDEX_PROJECTION_ATTEMPTS) {
        throw error;
      }
      await projectionRetryDelay(attempt);
      continue;
    }
    try {
      await atomicWriteJson(indexPath, intended);
      await makePrivateFile(indexPath);
    } catch (error) {
      if (!retryableProjectionContentionError(error) ||
          attempt + 1 === MAX_INDEX_PROJECTION_ATTEMPTS) {
        throw error;
      }
      await projectionRetryDelay(attempt);
      continue;
    }
    let projected: DurableRecoveryIndexEntry[];
    let authoritativeNames: string[];
    try {
      [projected, authoritativeNames] = await Promise.all([
        readLegacyIndex(root),
        readAuthoritativeIndexEntryNames(root)
      ]);
    } catch (error) {
      if (!retryableProjectionContentionError(error) ||
          attempt + 1 === MAX_INDEX_PROJECTION_ATTEMPTS) {
        throw error;
      }
      await projectionRetryDelay(attempt);
      continue;
    }
    const projectedNames = new Set(projected.map(indexEntryName));
    if (entriesInclude(projected, intended.entries) &&
        authoritativeNames.every((name) => projectedNames.has(name))) {
      return;
    }
    if (attempt + 1 < MAX_INDEX_PROJECTION_ATTEMPTS) {
      await projectionRetryDelay(attempt);
    }
  }
  throw new RecoveryStoreBoundaryError(
    "durable recovery index projection did not converge"
  );
}

async function writeIndexEntry(
  root: string,
  entry: DurableRecoveryIndexEntry
): Promise<void> {
  assertValidIndexEntry(entry);
  const entryRoot = join(resolve(root), "recoveries", ".index");
  await ensurePrivateContainedDirectory(root, entryRoot);
  const entryPath = join(entryRoot, indexEntryName(entry));
  await assertSafeContainedFileDestination(root, entryPath);
  await atomicWriteJson(entryPath, entry);
  await makePrivateFile(entryPath);
  await writeIndexProjection(root);
}

async function copiedSnapshotDigest(
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

export async function prepareDurableRecovery(
  projectRoot: string,
  projectTransactionRoot: string,
  journal: TransactionJournal,
  options: RecoveryStoreOptions
): Promise<void> {
  if (!Array.isArray(options.managedPaths)) {
    throw new RecoveryStoreBoundaryError(
      "durable recovery managedPaths must be explicitly provided"
    );
  }
  await preparePrivateRecoveryRoot(projectRoot, options.root);
  assertValidRecoveryId(journal.recovery_id ?? journal.transaction_id);
  assertJournalStorageShape(journal, journal.recovery_id ?? journal.transaction_id);
  const managed = normalizedManagedPaths(journal, options.managedPaths);
  const mirroredOperationIndexes = journal.operations
    .map((_operation, index) => index)
    .filter((index) => {
      const operation = journal.operations[index];
      return operation !== undefined && operationIsManaged(operation, managed);
    });
  const allowedSensitive = new Set(
    options.allowedSensitiveContentHashes ?? []
  );
  for (const index of mirroredOperationIndexes) {
    const operation = journal.operations[index];
    if (operation === undefined || operation.operation === "delete") {
      continue;
    }
    const content = await readFile(
      join(projectTransactionRoot, "staged", String(index)),
      "utf8"
    );
    if (scanSensitiveFiles({ [`staged/${index}`]: content }).blocked &&
        (operation.content_sha256 === undefined ||
          !allowedSensitive.has(operation.content_sha256))) {
      throw new RecoveryMirrorSensitiveContentError();
    }
  }
  const mirroredSnapshots = journal.snapshots.filter((snapshot) =>
    managed.has(snapshot.path)
  );
  for (const snapshot of mirroredSnapshots) {
    if (snapshot.snapshot_name === null) continue;
    const snapshotPath = join(
      projectTransactionRoot,
      "before",
      snapshot.snapshot_name
    );
    const [content, digest] = await Promise.all([
      readFile(snapshotPath, "utf8"),
      sha256File(snapshotPath)
    ]);
    if (scanSensitiveFiles({
      [`before/${snapshot.snapshot_name}`]: content
    }).blocked && !allowedSensitive.has(digest)) {
      throw new RecoveryMirrorSensitiveContentError();
    }
  }

  const key = projectKey(projectRoot, journal.project_identity);
  const durableRoot = durableTransactionRoot(options.root, key, journal.recovery_id ??
    journal.transaction_id);
  await ensurePrivateContainedDirectory(options.root, join(durableRoot, "before"));
  await ensurePrivateContainedDirectory(options.root, join(durableRoot, "after"));
  await ensurePrivateContainedDirectory(options.root, join(durableRoot, "staged"));
  for (const index of mirroredOperationIndexes) {
    const operation = journal.operations[index];
    if (operation === undefined || operation.operation === "delete") {
      continue;
    }
    const destination = join(durableRoot, "staged", String(index));
    await atomicCopyIntoRecoveryRoot(
      options.root,
      join(projectTransactionRoot, "staged", String(index)),
      destination
    );
  }
  for (const snapshot of mirroredSnapshots) {
    if (snapshot.snapshot_name !== null) {
      const destination = join(
        durableRoot,
        "before",
        snapshot.snapshot_name
      );
      await atomicCopyIntoRecoveryRoot(
        options.root,
        join(projectTransactionRoot, "before", snapshot.snapshot_name),
        destination
      );
    }
  }
  const mirror: DurableRecoveryMirror = {
    schemaVersion: 1,
    recoveryId: journal.recovery_id ?? journal.transaction_id,
    projectRootHash: projectRootHash(projectRoot),
    projectIdentityHash: identityHash(journal.project_identity),
    mirroredOperationIndexes,
    mirroredSnapshotPaths: mirroredSnapshots.map((item) => item.path),
    snapshotDigest: await copiedSnapshotDigest(durableRoot, mirroredSnapshots)
  };
  if (!await containedDirectoryExists(options.root, durableRoot)) {
    throw new RecoveryStoreBoundaryError(
      "durable recovery transaction directory is unavailable"
    );
  }
  await Promise.all([
    assertSafeContainedFileDestination(
      options.root,
      join(durableRoot, "mirror.json")
    ),
    assertSafeContainedFileDestination(
      options.root,
      join(durableRoot, "journal.json")
    )
  ]);
  await Promise.all([
    atomicWriteJson(join(durableRoot, "mirror.json"), mirror),
    atomicWriteJson(join(durableRoot, "journal.json"), durableJournal(journal))
  ]);
  await Promise.all([
    makePrivateFile(join(durableRoot, "mirror.json")),
    makePrivateFile(join(durableRoot, "journal.json"))
  ]);
  await writeIndexEntry(options.root, {
    recoveryId: mirror.recoveryId,
    projectKey: key,
    projectRootHash: mirror.projectRootHash,
    projectIdentityHash: mirror.projectIdentityHash,
    createdAt: journal.created_at
  });
}

export async function syncDurableRecovery(
  projectRoot: string,
  journal: TransactionJournal,
  options: Pick<RecoveryStoreOptions, "root">
): Promise<void> {
  assertValidRecoveryId(journal.recovery_id ?? journal.transaction_id);
  assertJournalStorageShape(journal, journal.recovery_id ?? journal.transaction_id);
  const key = projectKey(projectRoot, journal.project_identity);
  const durableRoot = durableTransactionRoot(options.root, key, journal.recovery_id ??
    journal.transaction_id);
  if (!await containedDirectoryExists(options.root, durableRoot) ||
      !await containedRegularFileExists(
        options.root,
        join(durableRoot, "mirror.json")
      )) {
    return;
  }
  await assertSafeContainedFileDestination(
    options.root,
    join(durableRoot, "journal.json")
  );
  await atomicWriteJson(
    join(durableRoot, "journal.json"),
    durableJournal(journal)
  );
  await makePrivateFile(join(durableRoot, "journal.json"));
}

export async function locateRecovery(
  projectRoot: string,
  recoveryId: string,
  options: RecoveryLocationOptions = {}
): Promise<RecoveryLocation | null> {
  assertValidRecoveryId(recoveryId);
  const recoveryRoot = options.recoveryRoot ??
    (process.env.HUNTER_HARNESS_RECOVERY_ROOT?.trim()
      ? resolveRecoveryRoot()
      : undefined);
  const projectTransactionsRoot = join(
    projectRoot,
    ".harness",
    "state",
    "transactions"
  );
  const projectTransactionRoot = join(
    projectTransactionsRoot,
    recoveryId
  );
  let localError: unknown = null;
  try {
    await assertExistingContained(projectTransactionsRoot, projectTransactionRoot);
    const journal = JSON.parse(await readFile(
      join(projectTransactionRoot, "journal.json"),
      "utf8"
    )) as TransactionJournal;
    assertJournalStorageShape(journal, recoveryId);
    return {
      source: "project",
      transactionRoot: projectTransactionRoot,
      journal,
      mirror: null
    };
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      localError = error;
    }
  }
  if (recoveryRoot === undefined) {
    if (localError !== null) throw localError;
    return null;
  }
  const index = await readIndex(recoveryRoot);
  const rootHash = projectRootHash(projectRoot);
  const expectedIdentityHash = options.projectIdentity === undefined
    ? null
    : identityHash(options.projectIdentity);
  const candidates = index.entries.filter((entry) =>
    entry.recoveryId === recoveryId &&
    entry.projectRootHash === rootHash &&
    (expectedIdentityHash === null || entry.projectIdentityHash === expectedIdentityHash)
  );
  for (const entry of candidates) {
    const transactionRoot = durableTransactionRoot(
      recoveryRoot,
      entry.projectKey,
      recoveryId
    );
    try {
      if (!await containedDirectoryExists(
        recoveryRoot,
        transactionRoot
      )) {
        continue;
      }
      const journalPath = join(transactionRoot, "journal.json");
      const mirrorPath = join(transactionRoot, "mirror.json");
      if (!await containedRegularFileExists(recoveryRoot, journalPath) ||
          !await containedRegularFileExists(recoveryRoot, mirrorPath)) {
        continue;
      }
      const [journal, mirror] = await Promise.all([
        readFile(journalPath, "utf8")
          .then((value) => JSON.parse(value) as TransactionJournal),
        readFile(mirrorPath, "utf8")
          .then((value) => JSON.parse(value) as DurableRecoveryMirror)
      ]);
      assertJournalStorageShape(journal, recoveryId);
      if (mirror.schemaVersion !== 1 || mirror.recoveryId !== recoveryId ||
          mirror.projectRootHash !== entry.projectRootHash ||
          mirror.projectIdentityHash !== entry.projectIdentityHash ||
          mirror.projectRootHash !== projectRootHash(projectRoot) ||
          mirror.projectIdentityHash !== identityHash(journal.project_identity) ||
          !Array.isArray(mirror.mirroredOperationIndexes) ||
          !Array.isArray(mirror.mirroredSnapshotPaths) ||
          !SHA256_PATTERN.test(mirror.snapshotDigest)) {
        throw new RecoveryStoreBoundaryError(
          "durable recovery mirror metadata is inconsistent"
        );
      }
      for (const path of mirror.mirroredSnapshotPaths) normalizedStoragePath(path);
      return { source: "durable", transactionRoot, journal, mirror };
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  if (localError !== null) throw localError;
  return null;
}

export async function readDurableRecoveryIds(
  projectRoot: string,
  recoveryRoot: string,
  projectIdentity?: string
): Promise<string[]> {
  const index = await readIndex(recoveryRoot);
  const rootHash = projectRootHash(projectRoot);
  const expectedIdentityHash = projectIdentity === undefined
    ? null
    : identityHash(projectIdentity);
  return [...new Set(index.entries.filter((entry) =>
    entry.projectRootHash === rootHash &&
    (expectedIdentityHash === null || entry.projectIdentityHash === expectedIdentityHash)
  ).map((entry) => entry.recoveryId))].sort();
}
