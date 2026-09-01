import { randomUUID } from "node:crypto";
import {
  copyFile,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  lstat,
  realpath,
  writeFile
} from "node:fs/promises";
import { isAbsolute, basename, join, relative, resolve, sep } from "node:path";

import { CODEBASE_MAP_PUBLICATION_TARGETS } from "../types.js";
import { contentHash, stableHash, stableJson } from "../stable.js";
import { deriveMapPublicationReadbackHash } from "./module.js";
import {
  MAP_PUBLICATION_FILESYSTEM_RECORD_KIND,
  MAP_PUBLICATION_FILESYSTEM_SAFETY_POLICY,
  MAP_PUBLICATION_TARGET_ROOT,
  readMapPublicationFilesystemJournal,
  type MapPublicationCommitRequest,
  type MapPublicationFilesystemJournal,
  type MapPublicationFilesystemTransactionPort,
  MAP_PUBLICATION_GENERATION_POINTER_KIND,
  MAP_PUBLICATION_GENERATION_POINTER_PATH,
  MAP_PUBLICATION_GENERATION_POINTER_SCHEMA_VERSION,
  MAP_PUBLICATION_GENERATION_ROOT,
  type MapPublicationGenerationPointer,
  type MapPublicationGenerationPointerState,
  type MapPublicationSha256,
  type MapPublicationReadback,
  type MapPublicationRollbackOutcome,
  type MapPublicationRollbackRequest,
  type MapPublicationTransactionInspection,
  type MapPublicationTransactionReceipt,
  type MapPublicationTargetRootIdentity
} from "./types.js";
import type { MapPublicationTargetPath } from "../types.js";

const TARGET_PREFIX = ".harness/codebase/";
const OPERATION = /^[a-z][a-z0-9_.:-]{0,159}$/u;

export interface MapPublicationFilesystemTransactionOptions {
  /** Trusted project root supplied by the host, never persisted in a journal. */
  readonly project_root: string;
  readonly project_identity: string;
  /** Optional sibling of the project root for durable journals. */
  readonly journal_root?: string;
  /** @internal deterministic hostile path-swap barrier for protocol tests. */
  readonly before_root_lock_reclaim?: () => void | Promise<void>;
}

interface BackupEntry {
  readonly path: MapPublicationTargetPath;
  readonly existed: boolean;
  readonly hash: string | null;
}

interface JournalContext {
  readonly journal: MapPublicationFilesystemJournal;
  readonly journal_path: string;
  readonly operation_root: string;
  readonly staging_root: string;
  readonly backup_root: string;
  readonly meta_path: string;
  readonly receipt_path: string;
  readonly previous_pointer_path: string;
  readonly rollback_intent_path: string;
}

interface GenerationSnapshot {
  readonly pointer: MapPublicationGenerationPointer;
  readonly payload_hashes: Partial<Record<MapPublicationTargetPath, string>>;
  readonly live_manifest_hash: string | null;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function now(): string {
  return new Date().toISOString();
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, process.platform === "win32" ? "r+" : "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  // Windows requires a read/write directory handle for FlushFileBuffers.  A
  // failure is never downgraded: the caller must enter recovery_required.
  const handle = await open(path, process.platform === "win32" ? "r+" : "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicWrite(path: string, bytes: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await syncFile(temporary);
    await rename(temporary, path);
    await syncDirectory(resolve(path, ".."));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Create a complete immutable record without ever exposing a partially
 * written destination.  `link` is a no-replace operation on the same volume;
 * a crash before the link leaves only a private temporary file.
 */
async function atomicLinkFile(path: string, bytes: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const parent = resolve(path, "..");
  await writeFile(temporary, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await syncFile(temporary);
    await link(temporary, path);
    await syncDirectory(parent);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

const GENERATION_ID = /^map_generation:sha256:[a-f0-9]{64}$/u;
const POINTER_HASH = /^sha256:[a-f0-9]{64}$/u;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function parseGenerationPointer(
  raw: string,
  projectIdentity: string,
  projectRootHash: string,
  targetSetHash: string
): MapPublicationGenerationPointer {
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch { throw new Error("MAP_PUBLICATION_GENERATION_POINTER_INVALID"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) ||
      Object.getPrototypeOf(parsed) !== Object.prototype) {
    throw new Error("MAP_PUBLICATION_GENERATION_POINTER_INVALID");
  }
  const value = parsed as Record<string, unknown>;
  const required = ["schema_version", "record_kind", "state", "generation_id", "project_identity",
    "project_root_hash", "target_set_hash", "manifest_hash", "payload_hashes"] as const;
  if (!exactKeys(value, required) || value.schema_version !== MAP_PUBLICATION_GENERATION_POINTER_SCHEMA_VERSION ||
      value.record_kind !== MAP_PUBLICATION_GENERATION_POINTER_KIND || value.project_identity !== projectIdentity ||
      value.project_root_hash !== projectRootHash || value.target_set_hash !== targetSetHash ||
      (value.state !== "empty" && value.state !== "published") || typeof value.generation_id !== "string" ||
      value.generation_id.length > 192 || value.manifest_hash !== null &&
      (typeof value.manifest_hash !== "string" || !POINTER_HASH.test(value.manifest_hash)) ||
      !value.payload_hashes || typeof value.payload_hashes !== "object" || Array.isArray(value.payload_hashes) ||
      Object.getPrototypeOf(value.payload_hashes) !== Object.prototype) {
    throw new Error("MAP_PUBLICATION_GENERATION_POINTER_INVALID");
  }
  const state = value.state as MapPublicationGenerationPointerState;
  const hashes = value.payload_hashes as Record<string, unknown>;
  if (state === "empty") {
    if (value.generation_id !== "map_generation:empty" || value.manifest_hash !== null || Object.keys(hashes).length !== 0) {
      throw new Error("MAP_PUBLICATION_GENERATION_POINTER_INVALID");
    }
  } else {
    if (!GENERATION_ID.test(value.generation_id as string) || typeof value.manifest_hash !== "string" ||
        !exactKeys(hashes, CODEBASE_MAP_PUBLICATION_TARGETS) ||
        Object.values(hashes).some((hash) => typeof hash !== "string" || !POINTER_HASH.test(hash))) {
      throw new Error("MAP_PUBLICATION_GENERATION_POINTER_INVALID");
    }
  }
  return freeze(value as unknown as MapPublicationGenerationPointer);
}

function pointerBytesEqual(left: MapPublicationGenerationPointer, right: MapPublicationGenerationPointer): boolean {
  return stableJson(left) === stableJson(right);
}

function equivalentPath(left: string, right: string): boolean {
  const lhs = resolve(left);
  const rhs = resolve(right);
  return process.platform === "win32" ? lhs.toLowerCase() === rhs.toLowerCase() : lhs === rhs;
}

/** realpath 等价检查：容忍**祖先**路径别名化（Windows CI 的 8.3 短名、
 *  macOS /tmp→/private/tmp、CI TMPDIR 软链），只要求最终组件自身不被重定向——
 *  最终组件的 symlink/junction 已由调用点的 lstat isSymbolicLink 拦截。
 *  祖先别名两侧经同一 realpath 解析，写入物理位置一致，不削弱安全性。 */
async function realpathEquivalent(path: string): Promise<boolean> {
  const real = await realpath(path);
  if (equivalentPath(real, path)) return true;
  const resolved = resolve(path);
  const parentReal = await realpath(resolve(resolved, ".."));
  return equivalentPath(real, join(parentReal, basename(resolved)));
}

async function safeDirectory(path: string, create = false): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("MAP_PUBLICATION_FILESYSTEM_UNSAFE_ROOT");
    if (!(await realpathEquivalent(path))) throw new Error("MAP_PUBLICATION_FILESYSTEM_UNSAFE_ROOT");
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw error;
  }
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !(await realpathEquivalent(path))) {
    throw new Error("MAP_PUBLICATION_FILESYSTEM_UNSAFE_ROOT");
  }
}

async function safeDirectoryChain(root: string, target: string): Promise<void> {
  const absoluteRoot = resolve(root);
  const absoluteTarget = resolve(target);
  const rel = relative(absoluteRoot, absoluteTarget);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("MAP_PUBLICATION_FILESYSTEM_UNSAFE_ROOT");
  }
  await safeDirectory(absoluteRoot);
  let current = absoluteRoot;
  for (const component of rel.split(/[\\/]+/u).filter(Boolean)) {
    current = join(current, component);
    await safeDirectory(current, true);
  }
}

async function safeFile(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe file");
    if (!(await realpathEquivalent(path))) throw new Error("unsafe file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

const rootLocks = new Map<string, Promise<void>>();

const ROOT_LOCK_MAX_CLAIMS = 4096;

interface RootLockOwner {
  readonly schema_version: 1;
  readonly project_root_hash: string;
  readonly pid: number;
  readonly acquired_at: string;
  readonly nonce: string;
  readonly state: "active" | "released";
}

interface RootLockClaim {
  readonly lock_root: string;
  readonly owner: RootLockOwner;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function parseRootLockOwner(serialized: string, path: string, trustedHash: string): RootLockOwner | null {
  let parsed: unknown;
  try { parsed = JSON.parse(serialized) as unknown; } catch { return null; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  const legacy = keys.length === 4 && keys.every((key) =>
    ["schema_version", "project_root_hash", "pid", "acquired_at"].includes(key));
  const current = keys.length === 6 && keys.every((key) =>
    ["schema_version", "project_root_hash", "pid", "acquired_at", "nonce", "state"].includes(key));
  if ((!legacy && !current) || record.schema_version !== 1 || record.project_root_hash !== trustedHash ||
      !Number.isSafeInteger(record.pid) || (record.pid as number) <= 0 || typeof record.acquired_at !== "string" ||
      !Number.isFinite(Date.parse(record.acquired_at))) return null;
  const nonce = legacy
    ? stableHash(`${path}\u0000${serialized}`)
    : record.nonce;
  if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > 256) return null;
  const state = legacy ? "active" : record.state;
  if (state !== "active" && state !== "released") return null;
  return Object.freeze({
    schema_version: 1 as const,
    project_root_hash: trustedHash,
    pid: record.pid as number,
    acquired_at: record.acquired_at,
    nonce,
    state
  });
}

interface RootLockReclaim {
  readonly schema_version: 1;
  readonly project_root_hash: string;
  readonly owner_nonce: string;
  readonly pid: number;
  readonly acquired_at: string;
  readonly nonce: string;
}

async function restoreQuarantinedLock(source: string, destination: string): Promise<void> {
  try {
    // Hard-link is no-replace on the same volume.  If another owner already
    // claimed the stable path, preserve both records and fail closed.
    await link(source, destination);
    await rm(source, { force: true });
  } catch {
    // The quarantined record is intentionally retained for operator recovery.
  }
}

function parseRootLockReclaim(serialized: string, trustedHash: string): RootLockReclaim | null {
  let parsed: unknown;
  try { parsed = JSON.parse(serialized) as unknown; } catch { return null; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) ||
      Object.getPrototypeOf(parsed) !== Object.prototype) return null;
  const value = parsed as Record<string, unknown>;
  if (!exactKeys(value, ["schema_version", "project_root_hash", "owner_nonce", "pid", "acquired_at", "nonce"]) ||
      value.schema_version !== 1 || value.project_root_hash !== trustedHash ||
      typeof value.owner_nonce !== "string" || value.owner_nonce.length === 0 || value.owner_nonce.length > 256 ||
      !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0 || typeof value.acquired_at !== "string" ||
      !Number.isFinite(Date.parse(value.acquired_at)) || typeof value.nonce !== "string" ||
      value.nonce.length === 0 || value.nonce.length > 256) return null;
  return value as unknown as RootLockReclaim;
}

async function reclaimRootLock(lockPath: string, journalRoot: string, trustedRootHash: string,
  ownerNonce: string, beforeRename?: () => void | Promise<void>): Promise<boolean> {
  const markerPath = `${lockPath}.reclaim`;
  const marker: RootLockReclaim = Object.freeze({ schema_version: 1, project_root_hash: trustedRootHash,
    owner_nonce: ownerNonce, pid: process.pid, acquired_at: now(), nonce: randomUUID() });
  try {
    await atomicLinkFile(markerPath, JSON.stringify(marker));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    let serialized: string;
    try { serialized = await readFile(markerPath, "utf8"); }
    catch (readError) {
      if ((readError as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new Error("MAP_PUBLICATION_FILESYSTEM_LOCKED", { cause: readError });
    }
    const existing = parseRootLockReclaim(serialized, trustedRootHash);
    if (existing === null || processIsAlive(existing.pid)) {
      throw new Error("MAP_PUBLICATION_FILESYSTEM_LOCKED", { cause: error });
    }
    if (existing.owner_nonce !== ownerNonce) {
      // A successor can atomically claim the stable owner path and then crash
      // before clearing its predecessor's durable reclaim marker.  Quarantine
      // that dead predecessor marker only while the exact dead successor owner
      // inode and both immutable payloads remain unchanged.  The unguessable,
      // same-volume rename target makes the later unlink capability-scoped;
      // restoration is no-replace through a hard link.
      const ownerBeforeStat = await lstat(lockPath);
      const ownerBeforeRaw = await readFile(lockPath, "utf8");
      const ownerCheckedStat = await lstat(lockPath);
      const ownerCheckedRaw = await readFile(lockPath, "utf8");
      const ownerRecord = parseRootLockOwner(ownerCheckedRaw, lockPath, trustedRootHash);
      if (!ownerBeforeStat.isFile() || ownerBeforeStat.isSymbolicLink() ||
          ownerBeforeStat.dev !== ownerCheckedStat.dev || ownerBeforeStat.ino !== ownerCheckedStat.ino ||
          ownerBeforeRaw !== ownerCheckedRaw || ownerRecord === null || ownerRecord.nonce !== ownerNonce ||
          (ownerRecord.state === "active" && processIsAlive(ownerRecord.pid))) {
        throw new Error("MAP_PUBLICATION_FILESYSTEM_LOCKED", { cause: error });
      }
      const markerBeforeStat = await lstat(markerPath);
      const markerCheckedRaw = await readFile(markerPath, "utf8");
      const markerCheckedStat = await lstat(markerPath);
      const markerChecked = parseRootLockReclaim(markerCheckedRaw, trustedRootHash);
      if (!markerBeforeStat.isFile() || markerBeforeStat.isSymbolicLink() ||
          markerBeforeStat.dev !== markerCheckedStat.dev || markerBeforeStat.ino !== markerCheckedStat.ino ||
          markerCheckedRaw !== serialized || markerChecked === null || markerChecked.nonce !== existing.nonce ||
          markerChecked.owner_nonce !== existing.owner_nonce || processIsAlive(markerChecked.pid)) {
        throw new Error("MAP_PUBLICATION_FILESYSTEM_LOCKED", { cause: error });
      }
      const predecessor = `${markerPath}.${randomUUID()}.dead-predecessor`;
      try { await rename(markerPath, predecessor); }
      catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw new Error("MAP_PUBLICATION_FILESYSTEM_LOCKED", { cause: renameError });
      }
      try {
        const movedStat = await lstat(predecessor);
        const movedRaw = await readFile(predecessor, "utf8");
        const moved = parseRootLockReclaim(movedRaw, trustedRootHash);
        const ownerAfterStat = await lstat(lockPath);
        const ownerAfterRaw = await readFile(lockPath, "utf8");
        if (movedStat.dev !== markerCheckedStat.dev || movedStat.ino !== markerCheckedStat.ino ||
            movedRaw !== markerCheckedRaw || moved === null || moved.nonce !== existing.nonce ||
            ownerAfterStat.dev !== ownerCheckedStat.dev || ownerAfterStat.ino !== ownerCheckedStat.ino ||
            ownerAfterRaw !== ownerCheckedRaw) {
          throw new Error("MAP_PUBLICATION_FILESYSTEM_LOCKED", { cause: error });
        }
        const removeStat = await lstat(predecessor);
        const removeRaw = await readFile(predecessor, "utf8");
        if (removeStat.dev !== movedStat.dev || removeStat.ino !== movedStat.ino || removeRaw !== movedRaw) {
          throw new Error("MAP_PUBLICATION_FILESYSTEM_LOCKED", { cause: error });
        }
        await rm(predecessor);
        await syncDirectory(journalRoot);
        return false;
      } catch (quarantineError) {
        await restoreQuarantinedLock(predecessor, markerPath);
        if ((quarantineError as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw quarantineError;
      }
    }
    // A dead reclaimer left an immutable marker.  Rename that exact marker so
    // a different process cannot delete a pathname it has replaced.
    const dead = `${markerPath}.dead`;
    const markerStat = await lstat(markerPath);
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
      throw new Error("MAP_PUBLICATION_FILESYSTEM_LOCKED", { cause: error });
    }
    try { await rename(markerPath, dead); }
    catch (renameError) {
      if ((renameError as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new Error("MAP_PUBLICATION_FILESYSTEM_LOCKED", { cause: renameError });
    }
    const deadStat = await lstat(dead);
    const deadRecord = parseRootLockReclaim(await readFile(dead, "utf8"), trustedRootHash);
    if (deadRecord === null || deadRecord.owner_nonce !== existing.owner_nonce ||
        deadStat.dev !== markerStat.dev || deadStat.ino !== markerStat.ino) {
      await restoreQuarantinedLock(dead, markerPath);
      throw new Error("MAP_PUBLICATION_FILESYSTEM_LOCKED", { cause: error });
    }
    await rm(dead, { force: true });
    await syncDirectory(journalRoot);
    return false;
  }
  try {
    const ownerStale = `${lockPath}.${marker.nonce}.stale`;
    // Re-read both the immutable owner payload and filesystem identity after
    // acquiring the reclaim marker.  A path swap by a hostile writer is
    // rejected before the rename; cooperative contenders cannot replace it
    // while the marker is held.
    const beforeRaw = await readFile(lockPath, "utf8");
    const beforeOwner = parseRootLockOwner(beforeRaw, lockPath, trustedRootHash);
    const beforeStat = await lstat(lockPath);
    if (beforeOwner === null || beforeOwner.nonce !== ownerNonce || !beforeStat.isFile() || beforeStat.isSymbolicLink()) {
      throw new Error("MAP_PUBLICATION_FILESYSTEM_LOCKED");
    }
    const checkedRaw = await readFile(lockPath, "utf8");
    const checkedOwner = parseRootLockOwner(checkedRaw, lockPath, trustedRootHash);
    const checkedStat = await lstat(lockPath);
    if (checkedOwner === null || checkedOwner.nonce !== ownerNonce || beforeStat.dev !== checkedStat.dev ||
        beforeStat.ino !== checkedStat.ino) {
      throw new Error("MAP_PUBLICATION_FILESYSTEM_LOCKED");
    }
    await beforeRename?.();
    try {
      // The immutable reclaim marker fences all other contenders while the
      // exact owner inode is atomically moved out of the stable pathname.
      await rename(lockPath, ownerStale);
      let movedRaw: string;
      try { movedRaw = await readFile(ownerStale, "utf8"); }
      catch (error) { throw new Error("MAP_PUBLICATION_FILESYSTEM_LOCKED", { cause: error }); }
      // Legacy four-field records derive their nonce from the stable pathname;
      // keep that original path for validation after the identity-preserving
      // rename.
      const movedOwner = parseRootLockOwner(movedRaw, lockPath, trustedRootHash);
      const movedStat = await lstat(ownerStale);
      if (movedOwner === null || movedOwner.nonce !== ownerNonce || movedStat.dev !== checkedStat.dev ||
          movedStat.ino !== checkedStat.ino) {
        // Never delete a replacement inode that was moved by a hostile/path
        // swap.  Restore it only through a no-replace hard-link; if the stable
        // path has already been claimed, leave both records for recovery.
        await restoreQuarantinedLock(ownerStale, lockPath);
        throw new Error("MAP_PUBLICATION_FILESYSTEM_LOCKED");
      }
      await rm(ownerStale, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // Keep the fixed marker as the durable release/reclaim record.  The next
    // owner clears it after atomically claiming the stable lock path; leaving
    // it here avoids a marker pathname unlink race.
    await syncDirectory(journalRoot);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    // Keep a complete marker for the next stale reclaimer; callers fail
    // closed instead of deleting a potentially replaced lock path.
    throw error;
  }
}

async function clearReclaimMarkerAfterAcquire(lockPath: string, journalRoot: string,
  trustedRootHash: string, ownerNonce: string): Promise<void> {
  const markerPath = `${lockPath}.reclaim`;
  let serialized: string;
  try { serialized = await readFile(markerPath, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("MAP_PUBLICATION_FILESYSTEM_LOCKED", { cause: error });
  }
  const marker = parseRootLockReclaim(serialized, trustedRootHash);
  if (marker === null || marker.owner_nonce === ownerNonce) {
    throw new Error("MAP_PUBLICATION_FILESYSTEM_LOCKED");
  }
  const beforeStat = await lstat(markerPath);
  const quarantine = `${markerPath}.${ownerNonce}.stale`;
  try { await rename(markerPath, quarantine); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("MAP_PUBLICATION_FILESYSTEM_LOCKED", { cause: error });
  }
  const movedStat = await lstat(quarantine);
  const moved = parseRootLockReclaim(await readFile(quarantine, "utf8"), trustedRootHash);
  if (moved === null || moved.owner_nonce !== marker.owner_nonce || movedStat.dev !== beforeStat.dev ||
      movedStat.ino !== beforeStat.ino) {
    await restoreQuarantinedLock(quarantine, markerPath);
    throw new Error("MAP_PUBLICATION_FILESYSTEM_LOCKED");
  }
  await rm(quarantine, { force: true });
  await syncDirectory(journalRoot);
}

async function acquireRootLock(
  rootLockPath: string,
  journalRoot: string,
  trustedRootHash: string,
  beforeReclaim?: () => void | Promise<void>
): Promise<RootLockClaim> {
  const owner: RootLockOwner = Object.freeze({ schema_version: 1, project_root_hash: trustedRootHash,
    pid: process.pid, acquired_at: now(), nonce: randomUUID(), state: "active" });
  for (let attempt = 0; attempt < ROOT_LOCK_MAX_CLAIMS; attempt += 1) {
    try {
      await atomicLinkFile(rootLockPath, JSON.stringify(owner));
      await clearReclaimMarkerAfterAcquire(rootLockPath, journalRoot, trustedRootHash, owner.nonce);
      return { lock_root: rootLockPath, owner };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stat;
      try { stat = await lstat(rootLockPath); }
      catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new Error("MAP_PUBLICATION_FILESYSTEM_LOCKED", { cause: readError });
      }
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("MAP_PUBLICATION_FILESYSTEM_LOCKED", { cause: error });
      }
      let serialized: string;
      try { serialized = await readFile(rootLockPath, "utf8"); }
      catch (readError) {
        throw new Error("MAP_PUBLICATION_FILESYSTEM_LOCKED", { cause: readError });
      }
      const existing = parseRootLockOwner(serialized, rootLockPath, trustedRootHash);
      // A malformed final record is foreign/tampered.  Our own atomic-link
      // protocol never exposes a partial owner, so reclaiming it would weaken
      // the hostile-boundary guarantee.
      if (existing === null || (existing.state === "active" && processIsAlive(existing.pid))) {
        throw new Error("MAP_PUBLICATION_FILESYSTEM_LOCKED", { cause: error });
      }
      // Missing, malformed, released, or dead owner: claim a fixed reclaim
      // marker, then remove only while that marker fences contenders.  No
      // successor chain or read→unlink ABA window is created.
      await reclaimRootLock(rootLockPath, journalRoot, trustedRootHash, existing.nonce, beforeReclaim);
    }
  }
  throw new Error("MAP_PUBLICATION_FILESYSTEM_LOCKED");
}

async function withRootLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  const prior = rootLocks.get(root) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const tail = prior.then(() => gate);
  rootLocks.set(root, tail);
  await prior;
  try { return await work(); }
  finally {
    release();
    if (rootLocks.get(root) === tail) rootLocks.delete(root);
  }
}

/**
 * Shared local-authority safety seam extracted from the independently reviewed
 * Map filesystem protocol. Callers provide only trusted, already-resolved
 * roots; the lock wire persists a hash of that authority, never a raw path.
 */
export async function withLocalFilesystemAuthorityLock<T>(options: {
  readonly project_root: string;
  readonly authority_root: string;
  readonly lock_path: string;
  readonly authority_hash: string;
  readonly before_reclaim?: (() => void | Promise<void>) | undefined;
}, work: () => Promise<T>): Promise<T> {
  const projectRoot = resolve(options.project_root);
  const authorityRoot = resolve(options.authority_root);
  const lockPath = resolve(options.lock_path);
  await safeDirectory(projectRoot);
  await safeDirectoryChain(projectRoot, authorityRoot);
  if (!equivalentPath(resolve(lockPath, ".."), authorityRoot)) throw new Error("LOCAL_FILESYSTEM_AUTHORITY_PATH_INVALID");
  return withRootLock(`${projectRoot}\u0000${lockPath}`, async () => {
    const claim = await acquireRootLock(lockPath, authorityRoot, options.authority_hash, options.before_reclaim);
    try { return await work(); }
    finally { await reclaimRootLock(claim.lock_root, authorityRoot, options.authority_hash, claim.owner.nonce); }
  });
}

export async function ensureLocalFilesystemAuthorityDirectory(projectRoot: string, target: string): Promise<void> {
  await safeDirectory(resolve(projectRoot));
  await safeDirectoryChain(resolve(projectRoot), resolve(target));
}

export async function verifyLocalFilesystemAuthorityFile(path: string): Promise<void> { await safeFile(path); }
export async function writeLocalFilesystemAuthorityPointer(path: string, bytes: string): Promise<void> { await atomicWrite(path, bytes); }
export async function createLocalFilesystemAuthorityGeneration(path: string, bytes: string): Promise<void> { await atomicLinkFile(path, bytes); }

function targetPath(projectRoot: string, path: MapPublicationTargetPath): string {
  if (!CODEBASE_MAP_PUBLICATION_TARGETS.includes(path) || !path.startsWith(TARGET_PREFIX) || path.includes("..") || path.includes("\\")) {
    throw new Error("MAP_PUBLICATION_FILESYSTEM_TARGET_INVALID");
  }
  return resolve(projectRoot, path);
}

function operationFile(root: string, operationId: string, suffix: string): string {
  if (!OPERATION.test(operationId)) throw new Error("MAP_PUBLICATION_FILESYSTEM_OPERATION_INVALID");
  return join(root, `${encodeURIComponent(operationId)}.${suffix}`);
}

function operationSegment(operationId: string): string {
  if (!OPERATION.test(operationId)) throw new Error("MAP_PUBLICATION_FILESYSTEM_OPERATION_INVALID");
  return encodeURIComponent(operationId);
}

function inspectionUnknown(operationId: string): MapPublicationTransactionInspection {
  return { operation_id: operationId, state: "unknown", receipt: null, recovery_token: null, binding: null };
}

function inspectionFromJournal(
  journal: MapPublicationFilesystemJournal,
  receipt: MapPublicationTransactionReceipt | null
): MapPublicationTransactionInspection {
  const state = journal.state;
  return freeze({
    operation_id: journal.operation_id,
    state,
    receipt: state === "committed" || state === "rolled_back" ? receipt : null,
    recovery_token: journal.recovery.recovery_token,
    binding: journal.binding
  });
}

export function createMapPublicationFilesystemTransactionPort(
  options: MapPublicationFilesystemTransactionOptions
): MapPublicationFilesystemTransactionPort {
  const projectRoot = resolve(options.project_root);
  const journalRoot = resolve(options.journal_root ?? join(projectRoot, ".harness", "state", "map-publication"));
  const targetRoot = resolve(projectRoot, MAP_PUBLICATION_TARGET_ROOT);
  const rootLockPath = join(journalRoot, ".root.lock");
  const targetSetHash = stableHash(CODEBASE_MAP_PUBLICATION_TARGETS);
  const generationRoot = resolve(projectRoot, MAP_PUBLICATION_GENERATION_ROOT);
  const pointerPath = resolve(projectRoot, MAP_PUBLICATION_GENERATION_POINTER_PATH);
  let trustedRootHash: string | null = null;

  function emptyPointer(): MapPublicationGenerationPointer {
    if (trustedRootHash === null) throw new Error("MAP_PUBLICATION_GENERATION_POINTER_INVALID");
    return freeze({ schema_version: MAP_PUBLICATION_GENERATION_POINTER_SCHEMA_VERSION,
      record_kind: MAP_PUBLICATION_GENERATION_POINTER_KIND, state: "empty" as const,
      generation_id: "map_generation:empty", project_identity: options.project_identity,
      project_root_hash: trustedRootHash as MapPublicationSha256, target_set_hash: targetSetHash as MapPublicationSha256,
      manifest_hash: null, payload_hashes: {} });
  }

  async function readPointer(): Promise<MapPublicationGenerationPointer | null> {
    await safeDirectory(targetRoot);
    await safeFile(pointerPath);
    let raw: string;
    try { raw = await readFile(pointerPath, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (trustedRootHash === null) await establishRootHash();
    return parseGenerationPointer(raw, options.project_identity, trustedRootHash as string, targetSetHash);
  }

  function generationDirectory(pointer: MapPublicationGenerationPointer): string {
    if (pointer.state !== "published" || !GENERATION_ID.test(pointer.generation_id)) {
      throw new Error("MAP_PUBLICATION_GENERATION_POINTER_INVALID");
    }
    return join(generationRoot, encodeURIComponent(pointer.generation_id));
  }

  async function readGenerationSnapshot(pointer: MapPublicationGenerationPointer): Promise<GenerationSnapshot> {
    if (pointer.state === "empty") {
      return { pointer, payload_hashes: {}, live_manifest_hash: null };
    }
    const directory = generationDirectory(pointer);
    await safeDirectory(generationRoot);
    await safeDirectory(directory);
    const names = await readdir(directory);
    const expected = CODEBASE_MAP_PUBLICATION_TARGETS.map((path) => encodeURIComponent(path));
    if (names.length !== expected.length || names.some((name) => !expected.includes(name))) {
      throw new Error("MAP_PUBLICATION_GENERATION_POINTER_INVALID");
    }
    const hashes: Partial<Record<MapPublicationTargetPath, string>> = {};
    for (const path of CODEBASE_MAP_PUBLICATION_TARGETS) {
      const file = join(directory, encodeURIComponent(path));
      await safeFile(file);
      const bytes = await readFile(file);
      const hash = contentHash(bytes.toString("utf8"));
      if (hash !== pointer.payload_hashes[path]) throw new Error("MAP_PUBLICATION_GENERATION_POINTER_INVALID");
      hashes[path] = hash;
    }
    const current = await readPointer();
    if (current === null || !pointerBytesEqual(pointer, current)) {
      throw new Error("MAP_PUBLICATION_GENERATION_POINTER_CHANGED");
    }
    return { pointer, payload_hashes: hashes, live_manifest_hash: pointer.manifest_hash };
  }

  async function readAuthoritativeSnapshot(): Promise<GenerationSnapshot | null> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let pointer: MapPublicationGenerationPointer | null;
      try { pointer = await readPointer(); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      if (pointer === null) return null;
      try { return await readGenerationSnapshot(pointer); }
      catch (error) {
        if (!(error instanceof Error) || error.message !== "MAP_PUBLICATION_GENERATION_POINTER_CHANGED" || attempt === 2) throw error;
      }
    }
    return null;
  }

  function assertConfiguredPaths(): void {
    const journalRelative = relative(projectRoot, journalRoot);
    if (journalRelative === "" || journalRelative === ".." || journalRelative.startsWith(`..${sep}`) || isAbsolute(journalRelative)) {
      throw new Error("MAP_PUBLICATION_FILESYSTEM_UNSAFE_ROOT");
    }
  }

  async function checkExistingChain(root: string, target: string): Promise<void> {
    const absoluteRoot = resolve(root);
    const absoluteTarget = resolve(target);
    const rel = relative(absoluteRoot, absoluteTarget);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error("MAP_PUBLICATION_FILESYSTEM_UNSAFE_ROOT");
    }
    try { await safeDirectory(absoluteRoot); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let current = absoluteRoot;
    for (const component of rel.split(/[\\/]+/u).filter(Boolean)) {
      current = join(current, component);
      try { await safeDirectory(current); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
  }

  async function validateConfigurationPaths(create: boolean): Promise<void> {
    assertConfiguredPaths();
    if (create) {
      await safeDirectory(projectRoot, true);
      await safeDirectoryChain(projectRoot, targetRoot);
      await safeDirectoryChain(projectRoot, journalRoot);
    } else {
      // Inspect/readback never creates a directory, but it still walks every
      // existing component so a symlink/reparse point cannot be followed.
      await checkExistingChain(projectRoot, targetRoot);
      await checkExistingChain(projectRoot, journalRoot);
    }
    const existingStat = async (path: string) => {
      try { return await lstat(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    };
    const rootStat = await existingStat(projectRoot);
    if (rootStat === null) return;
    for (const path of [targetRoot, journalRoot]) {
      const stat = await existingStat(path);
      if (stat !== null && stat.dev !== rootStat.dev) {
        throw new Error("MAP_PUBLICATION_FILESYSTEM_UNSAFE_ROOT");
      }
    }
  }

  async function establishRootHash(): Promise<void> {
    await safeDirectory(projectRoot);
    trustedRootHash = stableHash(await realpath(projectRoot)) as `sha256:${string}`;
  }

  function sameTargets(value: readonly string[]): boolean {
    return value.length === CODEBASE_MAP_PUBLICATION_TARGETS.length &&
      CODEBASE_MAP_PUBLICATION_TARGETS.every((path, index) => value[index] === path);
  }

  function validateJournalContext(contextValue: JournalContext): void {
    const journal = contextValue.journal;
    const expectedStagingId = `map_stage:${stableHash({ operation_id: journal.operation_id }).slice(7)}`;
    const expectedRecoveryId = `map_recovery:${stableHash({ operation_id: journal.operation_id,
      recoveryToken: journal.recovery.recovery_token }).slice(7)}`;
    if (trustedRootHash === null || journal.root_identity.project_identity !== options.project_identity ||
        journal.root_identity.project_root_hash !== trustedRootHash ||
        journal.root_identity.target_root !== MAP_PUBLICATION_TARGET_ROOT ||
        !sameTargets(journal.root_identity.ownership_paths) ||
        journal.operation_id !== journal.binding.operation_id || journal.action_id !== journal.binding.action_id ||
        journal.idempotency_key !== journal.binding.idempotency_key || !sameTargets(journal.binding.ownership_paths) ||
        journal.staging.target_set_hash !== targetSetHash || journal.staging.staging_id !== expectedStagingId ||
        journal.staging.staging_root_hash !== stableHash(contextValue.staging_root) ||
        journal.recovery.recovery_id !== expectedRecoveryId ||
        journal.safety_policy.same_volume !== MAP_PUBLICATION_FILESYSTEM_SAFETY_POLICY.same_volume ||
        journal.safety_policy.atomic_replace !== MAP_PUBLICATION_FILESYSTEM_SAFETY_POLICY.atomic_replace ||
        journal.safety_policy.fsync !== MAP_PUBLICATION_FILESYSTEM_SAFETY_POLICY.fsync ||
        journal.safety_policy.symlink_policy !== MAP_PUBLICATION_FILESYSTEM_SAFETY_POLICY.symlink_policy ||
        journal.safety_policy.target_allowlist !== MAP_PUBLICATION_FILESYSTEM_SAFETY_POLICY.target_allowlist) {
      throw new Error("MAP_PUBLICATION_PORT_INVALID");
    }
  }

  async function ensureLayout(): Promise<void> {
    await validateConfigurationPaths(true);
    await establishRootHash();
  }

  async function withFilesystemRootLock<T>(work: () => Promise<T>): Promise<T> {
    // The in-memory queue prevents races between adapters in this process.
    // Across processes, ownership is a complete immutable record inside an
    // atomically-created lock directory.  Stale takeover renames that whole
    // directory, so no contender can unlink a pathname after it has been
    // replaced (and normal release reuses the same bounded root path).
    return withRootLock(projectRoot, async () => {
      await ensureLayout();
      if (trustedRootHash === null) throw new Error("MAP_PUBLICATION_FILESYSTEM_LOCKED");
      const claim = await acquireRootLock(rootLockPath, journalRoot, trustedRootHash,
        options.before_root_lock_reclaim);
      try { return await work(); }
      finally {
        // Release by atomically moving the exact directory we acquired.  A
        // crash before/after this rename leaves either a complete owner record
        // or a quarantined directory that the next contender can safely reap.
        await reclaimRootLock(claim.lock_root, journalRoot, trustedRootHash as string, claim.owner.nonce);
      }
    });
  }

  async function context(operationId: string): Promise<JournalContext | null> {
    await validateConfigurationPaths(false);
    const journalPath = operationFile(journalRoot, operationId, "journal.json");
    let raw: string;
    try { raw = await readFile(journalPath, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw) as unknown; } catch { throw new Error("MAP_PUBLICATION_PORT_INVALID"); }
    const checked = readMapPublicationFilesystemJournal(parsed);
    if (!checked.ok || checked.mode !== "current") throw new Error("MAP_PUBLICATION_PORT_INVALID");
    await establishRootHash();
    const operationRoot = join(journalRoot, operationSegment(operationId));
    const contextValue: JournalContext = {
      journal: checked.value,
      journal_path: journalPath,
      operation_root: operationRoot,
      staging_root: join(operationRoot, "staging"),
      backup_root: join(operationRoot, "backup"),
      meta_path: join(operationRoot, "backup.json"),
      receipt_path: join(operationRoot, "receipt.json"),
      previous_pointer_path: join(operationRoot, "previous-pointer.json"),
      rollback_intent_path: join(operationRoot, "rollback-intent.json")
    };
    validateJournalContext(contextValue);
    await safeDirectory(contextValue.operation_root);
    await safeDirectory(contextValue.staging_root);
    await safeDirectory(contextValue.backup_root);
    return contextValue;
  }

  async function writeJournal(ctx: JournalContext, journal: MapPublicationFilesystemJournal): Promise<JournalContext> {
    await safeDirectory(ctx.operation_root, true);
    const next = { ...ctx, journal };
    // Preserve the contract's canonical target-array order.  The journal
    // reader uses that order as a durable allowlist; stableJson sorts object
    // keys and would reorder the expected_payload_hashes map on restart.
    await atomicWrite(ctx.journal_path, JSON.stringify(journal));
    return next;
  }

  async function readReceipt(ctx: JournalContext): Promise<MapPublicationTransactionReceipt | null> {
    try {
      await safeFile(ctx.receipt_path);
      return JSON.parse(await readFile(ctx.receipt_path, "utf8")) as MapPublicationTransactionReceipt;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("MAP_PUBLICATION_PORT_INVALID", { cause: error });
    }
  }

  async function readbackInternal(operationId: string): Promise<MapPublicationReadback> {
    const ctx = await context(operationId);
    const authoritative = await readAuthoritativeSnapshot();
    if (authoritative !== null) {
      return freeze({ operation_id: operationId, live_manifest_hash: authoritative.live_manifest_hash,
        payload_hashes: authoritative.payload_hashes as MapPublicationReadback["payload_hashes"],
        journal_committed: ctx?.journal.state === "committed" });
    }
    if (ctx !== null && (ctx.journal.state === "committed" || ctx.journal.state === "rolled_back")) {
      try {
        await safeFile(ctx.previous_pointer_path);
        await readFile(ctx.previous_pointer_path, "utf8");
        throw new Error("MAP_PUBLICATION_GENERATION_POINTER_INVALID");
      } catch (error) {
        if (error instanceof Error && error.message === "MAP_PUBLICATION_GENERATION_POINTER_INVALID") throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    // Pre-pointer v1 workspaces are read-only compatibility state.  Once a
    // pointer exists, all durable reads above remain generation-fenced.
    const payloadHashes: Partial<Record<MapPublicationTargetPath, string>> = {};
    let complete = true;
    for (const path of CODEBASE_MAP_PUBLICATION_TARGETS) {
      const absolute = targetPath(projectRoot, path);
      await safeFile(absolute);
      try {
        const bytes = await readFile(absolute);
        payloadHashes[path] = contentHash(bytes.toString("utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") complete = false;
        else throw error;
      }
    }
    const manifest = targetPath(projectRoot, ".harness/codebase/map-manifest.json");
    let liveManifestHash: string | null = null;
    try { liveManifestHash = contentHash((await readFile(manifest)).toString("utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return freeze({ operation_id: operationId, live_manifest_hash: liveManifestHash,
      payload_hashes: (complete ? payloadHashes : {}) as MapPublicationReadback["payload_hashes"],
      journal_committed: ctx?.journal.state === "committed" });
  }

  async function createJournal(request: MapPublicationCommitRequest, inputHash: string,
    newManifestHash: string, recoveryToken: string): Promise<JournalContext> {
    await ensureLayout();
    const operationRoot = join(journalRoot, operationSegment(request.operation_id));
    const ctxBase = {
      journal_path: operationFile(journalRoot, request.operation_id, "journal.json"), operation_root: operationRoot,
      staging_root: join(operationRoot, "staging"), backup_root: join(operationRoot, "backup"),
      meta_path: join(operationRoot, "backup.json"), receipt_path: join(operationRoot, "receipt.json"),
      previous_pointer_path: join(operationRoot, "previous-pointer.json"),
      rollback_intent_path: join(operationRoot, "rollback-intent.json")
    };
    await safeDirectory(operationRoot, true);
    await safeDirectory(ctxBase.staging_root, true);
    await safeDirectory(ctxBase.backup_root, true);
    const previousPointer = await readPointer();
    await atomicWrite(ctxBase.previous_pointer_path, stableJson({ schema_version: 1,
      state: previousPointer === null ? "absent" : "present", pointer: previousPointer }));
    const backups: BackupEntry[] = [];
    for (const path of CODEBASE_MAP_PUBLICATION_TARGETS) {
      const absolute = targetPath(projectRoot, path);
      await safeDirectoryChain(projectRoot, resolve(absolute, ".."));
      await safeFile(absolute);
      try {
        const bytes = await readFile(absolute);
        const backup = join(ctxBase.backup_root, encodeURIComponent(path));
        await writeFile(backup, bytes, { flag: "wx", mode: 0o600 });
        await syncFile(backup);
        backups.push({ path, existed: true, hash: contentHash(bytes.toString("utf8")) });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") backups.push({ path, existed: false, hash: null });
        else throw error;
      }
      const staged = join(ctxBase.staging_root, encodeURIComponent(path));
      await writeFile(staged, request.plan.payloads[path], { flag: "wx", mode: 0o600 });
      await syncFile(staged);
    }
    await atomicWrite(ctxBase.meta_path, stableJson(backups));
    const stamp = now();
    const rootIdentity: MapPublicationTargetRootIdentity = {
      schema_version: 1,
      project_identity: options.project_identity,
      project_root_hash: (trustedRootHash ?? stableHash(projectRoot)) as `sha256:${string}`,
      target_root: MAP_PUBLICATION_TARGET_ROOT,
      ownership_paths: CODEBASE_MAP_PUBLICATION_TARGETS
    };
    const journal: MapPublicationFilesystemJournal = {
      schema_version: 1,
      record_kind: MAP_PUBLICATION_FILESYSTEM_RECORD_KIND,
      root_identity: rootIdentity,
      operation_id: request.operation_id,
      action_id: request.action_id,
      idempotency_key: request.idempotency_key,
      binding: {
        operation_id: request.operation_id, action_id: request.action_id, idempotency_key: request.idempotency_key,
        input_hash: inputHash, plan_hash: request.plan.plan_hash, expected_previous_manifest: request.expected_previous_manifest,
        new_manifest_hash: newManifestHash, ownership_paths: CODEBASE_MAP_PUBLICATION_TARGETS,
        expected_payload_hashes: Object.fromEntries(CODEBASE_MAP_PUBLICATION_TARGETS.map((path) =>
          [path, contentHash(request.plan.payloads[path])])) as Record<MapPublicationTargetPath, string>,
        expected_readback_hash: deriveMapPublicationReadbackHash(request)
      },
      staging: { staging_id: `map_stage:${stableHash({ operation_id: request.operation_id }).slice(7)}`,
        staging_root_hash: stableHash(ctxBase.staging_root) as `sha256:${string}`,
        target_set_hash: targetSetHash as `sha256:${string}`, state: "fsynced" },
      recovery: { recovery_id: `map_recovery:${stableHash({ operation_id: request.operation_id, recoveryToken }).slice(7)}`,
        recovery_token: recoveryToken },
      safety_policy: MAP_PUBLICATION_FILESYSTEM_SAFETY_POLICY,
      state: "prepared", commit_ambiguity: "not_ambiguous", readback: "pending", cleanup: "not_required",
      created_at: stamp, updated_at: stamp
    };
    const ctx = { ...ctxBase, journal };
    await atomicWrite(ctx.journal_path, JSON.stringify(journal));
    return ctx;
  }

  async function hasIdempotencyConflict(idempotencyKey: string, operationId: string): Promise<boolean> {
    await ensureLayout();
    let entries: string[];
    try { entries = await readdir(journalRoot); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".journal.json")) continue;
      const encoded = entry.slice(0, -".journal.json".length);
      let candidateOperation: string;
      try { candidateOperation = decodeURIComponent(encoded); }
      catch { throw new Error("MAP_PUBLICATION_PORT_INVALID"); }
      if (!OPERATION.test(candidateOperation)) throw new Error("MAP_PUBLICATION_PORT_INVALID");
      const candidate = await context(candidateOperation);
      if (candidate !== null && candidateOperation !== operationId && candidate.journal.idempotency_key === idempotencyKey) {
        return true;
      }
    }
    return false;
  }

  async function validateStaging(ctx: JournalContext): Promise<void> {
    await safeDirectory(ctx.staging_root);
    const names = await readdir(ctx.staging_root);
    const expectedNames = CODEBASE_MAP_PUBLICATION_TARGETS.map((path) => encodeURIComponent(path));
    if (names.length !== expectedNames.length || names.some((name) => !expectedNames.includes(name))) {
      throw new Error("MAP_PUBLICATION_PORT_INVALID");
    }
    for (const path of CODEBASE_MAP_PUBLICATION_TARGETS) {
      const staged = join(ctx.staging_root, encodeURIComponent(path));
      await safeFile(staged);
      const bytes = await readFile(staged);
      if (contentHash(bytes.toString("utf8")) !== ctx.journal.binding.expected_payload_hashes[path]) {
        throw new Error("MAP_PUBLICATION_PORT_INVALID");
      }
    }
  }

  function generationId(ctx: JournalContext): string {
    return `map_generation:${stableHash({ operation_id: ctx.journal.operation_id,
      input_hash: ctx.journal.binding.input_hash, new_manifest_hash: ctx.journal.binding.new_manifest_hash })}`;
  }

  async function generationMatches(
    directory: string,
    expectedHashes: Readonly<Record<MapPublicationTargetPath, string>>
  ): Promise<boolean> {
    try {
      await safeDirectory(directory);
      const names = await readdir(directory);
      const expected = CODEBASE_MAP_PUBLICATION_TARGETS.map((path) => encodeURIComponent(path));
      if (names.length !== expected.length || names.some((name) => !expected.includes(name))) return false;
      for (const path of CODEBASE_MAP_PUBLICATION_TARGETS) {
        const file = join(directory, encodeURIComponent(path));
        await safeFile(file);
        const hash = contentHash((await readFile(file)).toString("utf8"));
        if (hash !== expectedHashes[path]) return false;
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async function writeGeneration(ctx: JournalContext): Promise<MapPublicationGenerationPointer> {
    if (trustedRootHash === null) throw new Error("MAP_PUBLICATION_GENERATION_POINTER_INVALID");
    await safeDirectory(generationRoot, true);
    const id = generationId(ctx);
    const directory = join(generationRoot, encodeURIComponent(id));
    const expectedHashes = ctx.journal.binding.expected_payload_hashes;
    if (!await generationMatches(directory, expectedHashes)) {
      await safeDirectory(directory, true);
      for (const path of CODEBASE_MAP_PUBLICATION_TARGETS) {
        const staged = join(ctx.staging_root, encodeURIComponent(path));
        const destination = join(directory, encodeURIComponent(path));
        await safeFile(destination);
        const temporary = `${destination}.${randomUUID()}.mapgeneration`;
        await copyFile(staged, temporary);
        try {
          await syncFile(temporary);
          await rename(temporary, destination);
          await syncDirectory(directory);
        } catch (error) {
          await rm(temporary, { force: true }).catch(() => undefined);
          throw error;
        }
      }
      if (!await generationMatches(directory, expectedHashes)) throw new Error("MAP_PUBLICATION_GENERATION_POINTER_INVALID");
      await syncDirectory(generationRoot);
    }
    const pointer: MapPublicationGenerationPointer = freeze({
      schema_version: MAP_PUBLICATION_GENERATION_POINTER_SCHEMA_VERSION,
      record_kind: MAP_PUBLICATION_GENERATION_POINTER_KIND,
      state: "published" as const,
      generation_id: id,
      project_identity: options.project_identity,
      project_root_hash: trustedRootHash as MapPublicationSha256,
      target_set_hash: targetSetHash as MapPublicationSha256,
      manifest_hash: ctx.journal.binding.new_manifest_hash as MapPublicationSha256,
      payload_hashes: { ...expectedHashes } as Record<MapPublicationTargetPath, MapPublicationSha256>
    });
    return pointer;
  }

  async function projectGeneration(ctx: JournalContext, pointer: MapPublicationGenerationPointer): Promise<void> {
    if (pointer.state !== "published") return;
    const directory = generationDirectory(pointer);
    for (const path of CODEBASE_MAP_PUBLICATION_TARGETS) {
      const finalPath = targetPath(projectRoot, path);
      await safeDirectoryChain(projectRoot, resolve(finalPath, ".."));
      await safeFile(finalPath);
      const source = join(directory, encodeURIComponent(path));
      const temporary = `${finalPath}.${randomUUID()}.mapprojection`;
      await copyFile(source, temporary);
      try {
        await syncFile(temporary);
        await rename(temporary, finalPath);
        await syncDirectory(resolve(finalPath, ".."));
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    }
    await syncDirectory(targetRoot);
  }

  async function projectionMatches(pointer: MapPublicationGenerationPointer): Promise<boolean> {
    if (pointer.state !== "published") return true;
    for (const path of CODEBASE_MAP_PUBLICATION_TARGETS) {
      const file = targetPath(projectRoot, path);
      try {
        await safeFile(file);
        if (contentHash((await readFile(file)).toString("utf8")) !== pointer.payload_hashes[path]) return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    }
    return true;
  }

  async function writePointer(pointer: MapPublicationGenerationPointer): Promise<void> {
    await atomicWrite(pointerPath, stableJson(pointer));
  }

  async function readPreviousPointer(ctx: JournalContext): Promise<MapPublicationGenerationPointer | null> {
    let parsed: unknown;
    try {
      await safeFile(ctx.previous_pointer_path);
      parsed = JSON.parse(await readFile(ctx.previous_pointer_path, "utf8")) as unknown;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("MAP_PUBLICATION_GENERATION_POINTER_INVALID", { cause: error });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("MAP_PUBLICATION_GENERATION_POINTER_INVALID");
    }
    const record = parsed as Record<string, unknown>;
    if (!exactKeys(record, ["schema_version", "state", "pointer"]) || record.schema_version !== 1 ||
        (record.state !== "absent" && record.state !== "present")) {
      throw new Error("MAP_PUBLICATION_GENERATION_POINTER_INVALID");
    }
    if (record.state === "absent") {
      if (record.pointer !== null) throw new Error("MAP_PUBLICATION_GENERATION_POINTER_INVALID");
      return null;
    }
    if (typeof record.pointer !== "object" || record.pointer === null) {
      throw new Error("MAP_PUBLICATION_GENERATION_POINTER_INVALID");
    }
    return parseGenerationPointer(stableJson(record.pointer), options.project_identity,
      trustedRootHash as string, targetSetHash);
  }

  async function readRollbackIntent(ctx: JournalContext): Promise<{
    readonly operation_id: string;
    readonly expected_published_manifest_hash: string;
    readonly current_pointer_hash: string;
  } | null> {
    let parsed: unknown;
    try {
      await safeFile(ctx.rollback_intent_path);
      parsed = JSON.parse(await readFile(ctx.rollback_intent_path, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("MAP_PUBLICATION_GENERATION_POINTER_INVALID", { cause: error });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("MAP_PUBLICATION_GENERATION_POINTER_INVALID");
    }
    const value = parsed as Record<string, unknown>;
    if (!exactKeys(value, ["schema_version", "operation_id", "expected_published_manifest_hash", "current_pointer_hash"]) ||
        value.schema_version !== 1 || value.operation_id !== ctx.journal.operation_id ||
        typeof value.expected_published_manifest_hash !== "string" ||
        !POINTER_HASH.test(value.expected_published_manifest_hash) || typeof value.current_pointer_hash !== "string" ||
        !POINTER_HASH.test(value.current_pointer_hash)) {
      throw new Error("MAP_PUBLICATION_GENERATION_POINTER_INVALID");
    }
    return value as {
      readonly operation_id: string;
      readonly expected_published_manifest_hash: string;
      readonly current_pointer_hash: string;
    };
  }

  async function writeRollbackIntent(ctx: JournalContext, current: MapPublicationGenerationPointer): Promise<void> {
    await atomicWrite(ctx.rollback_intent_path, stableJson({ schema_version: 1,
      operation_id: ctx.journal.operation_id,
      expected_published_manifest_hash: ctx.journal.binding.new_manifest_hash,
      current_pointer_hash: stableHash(current) }));
  }

  function isCompleteLiveSet(readback: MapPublicationReadback, journal: MapPublicationFilesystemJournal): boolean {
    return readback.live_manifest_hash === journal.binding.new_manifest_hash &&
      CODEBASE_MAP_PUBLICATION_TARGETS.every((path) => readback.payload_hashes[path] === journal.binding.expected_payload_hashes[path]);
  }

  async function applyInternal(ctx: JournalContext): Promise<MapPublicationTransactionInspection> {
    const current = ctx.journal;
    if (current.state === "committed") return inspectionFromJournal(current, await readReceipt(ctx));
    const applying = await writeJournal(ctx, { ...current, state: "applying", commit_ambiguity: "not_ambiguous",
      readback: "pending", cleanup: "not_required", updated_at: now() });
    try {
      const before = await readbackInternal(current.operation_id);
      const expected = current.binding.expected_previous_manifest.state === "absent"
        ? null : current.binding.expected_previous_manifest.manifest_hash;
      const alreadyPublished = isCompleteLiveSet(before, current);
      let after: MapPublicationReadback;
      if (alreadyPublished) {
        // A process may crash after the final rename but before the journal
        // state is durable.  The complete live set is authoritative for this
        // recovery; do not reject it using the original stale baseline.
        const pointer = await readPointer();
        if (pointer !== null && pointer.state === "published" && !(await projectionMatches(pointer))) {
          // The pointer is durable truth; repair only the compatibility
          // projection before finalizing the journal.
          await projectGeneration(applying, pointer);
        }
        after = await readbackInternal(current.operation_id);
      } else {
        if (before.live_manifest_hash !== expected) {
          const stale = await writeJournal(applying, { ...applying.journal, state: "recovery_required",
            commit_ambiguity: "unknown", readback: "failed", updated_at: now() });
          return inspectionFromJournal(stale.journal, null);
        }
        await validateStaging(applying);
        // Materialize and fsync one immutable generation first.  Compatibility
        // projections may be sequential, but the pointer is published only
        // after all nine are durable; authoritative readers therefore see the
        // old complete generation or the new complete generation, never a
        // mixed set.
        const pointer = await writeGeneration(applying);
        await projectGeneration(applying, pointer);
        await writePointer(pointer);
        after = await readbackInternal(current.operation_id);
      }
      const expectedHashes = current.binding.expected_payload_hashes;
      if (after.live_manifest_hash !== current.binding.new_manifest_hash ||
          CODEBASE_MAP_PUBLICATION_TARGETS.some((path) => after.payload_hashes[path] !== expectedHashes[path])) {
        const failed = await writeJournal(applying, { ...applying.journal, state: "recovery_required",
          commit_ambiguity: "unknown", readback: "failed", updated_at: now() });
        return inspectionFromJournal(failed.journal, null);
      }
      const beforeHashes = before.payload_hashes;
      const modified = CODEBASE_MAP_PUBLICATION_TARGETS.filter((path) =>
        beforeHashes[path] !== expectedHashes[path] ||
        (path === ".harness/codebase/map-manifest.json" && before.live_manifest_hash !== current.binding.new_manifest_hash));
      const modifiedSet = new Set(modified);
      const body = {
        schema_version: 1 as const,
        operation_id: current.operation_id, action_id: current.action_id, idempotency_key: current.idempotency_key,
        plan_hash: current.binding.plan_hash, input_hash: current.binding.input_hash,
        previous_manifest_hash: expected, new_manifest_hash: current.binding.new_manifest_hash,
        modified_paths: modified,
        preserved_paths: CODEBASE_MAP_PUBLICATION_TARGETS.filter((path) => !modifiedSet.has(path)),
        verification: { manifest_hash_verified: true as const, payloads_verified: true as const,
          journal_committed: true as const, readback_hash: current.binding.expected_readback_hash },
        recovery_token: current.recovery.recovery_token, completed_at: now()
      };
      const receipt: MapPublicationTransactionReceipt = { ...body,
        receipt_id: `map_publication_receipt:${stableHash(body).slice(7)}` };
      await atomicWrite(applying.receipt_path, JSON.stringify(receipt));
      const committed = await writeJournal(applying, { ...applying.journal, state: "committed",
        commit_ambiguity: "resolved_committed", readback: "verified", updated_at: now() });
      return inspectionFromJournal(committed.journal, receipt);
    } catch {
      const failed = await writeJournal(applying, { ...applying.journal, state: "recovery_required",
        commit_ambiguity: "unknown", readback: "failed", updated_at: now() });
      return inspectionFromJournal(failed.journal, null);
    }
  }

  function isSha256(value: unknown): value is string {
    return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
  }

  async function readValidatedBackups(ctx: JournalContext): Promise<BackupEntry[]> {
    await safeDirectory(ctx.backup_root);
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(ctx.meta_path, "utf8")) as unknown; }
    catch { throw new Error("MAP_PUBLICATION_BACKUP_INVALID"); }
    if (!Array.isArray(parsed) || parsed.length !== CODEBASE_MAP_PUBLICATION_TARGETS.length) {
      throw new Error("MAP_PUBLICATION_BACKUP_INVALID");
    }
    const backups: BackupEntry[] = [];
    for (const [index, raw] of parsed.entries()) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("MAP_PUBLICATION_BACKUP_INVALID");
      const record = raw as Record<string, unknown>;
      const keys = Object.keys(record);
      if (keys.length !== 3 || !["path", "existed", "hash"].every((key) => Object.hasOwn(record, key)) ||
          record.path !== CODEBASE_MAP_PUBLICATION_TARGETS[index] || typeof record.existed !== "boolean" ||
          !(record.hash === null || isSha256(record.hash)) || (record.existed !== (record.hash !== null))) {
        throw new Error("MAP_PUBLICATION_BACKUP_INVALID");
      }
      backups.push({ path: record.path as MapPublicationTargetPath, existed: record.existed, hash: record.hash as string | null });
    }
    const names = await readdir(ctx.backup_root);
    const expectedNames = backups.filter((entry) => entry.existed).map((entry) => encodeURIComponent(entry.path));
    if (names.length !== expectedNames.length || names.some((name) => !expectedNames.includes(name))) {
      throw new Error("MAP_PUBLICATION_BACKUP_INVALID");
    }
    for (const entry of backups) {
      const backupPath = join(ctx.backup_root, encodeURIComponent(entry.path));
      await safeFile(backupPath);
      if (!entry.existed) continue;
      const bytes = await readFile(backupPath);
      if (contentHash(bytes.toString("utf8")) !== entry.hash) throw new Error("MAP_PUBLICATION_BACKUP_INVALID");
    }
    return backups;
  }

  async function liveMatchesBackups(backups: readonly BackupEntry[]): Promise<boolean> {
    for (const entry of backups) {
      const absolute = targetPath(projectRoot, entry.path);
      await safeFile(absolute);
      try {
        const bytes = await readFile(absolute);
        if (!entry.existed || contentHash(bytes.toString("utf8")) !== entry.hash) return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          if (entry.existed) return false;
        } else throw error;
      }
    }
    return true;
  }

  return {
    async inspect(operationId, idempotencyKey) {
      const ctx = await context(operationId);
      if (ctx === null) return inspectionUnknown(operationId);
      if (idempotencyKey !== undefined && idempotencyKey !== ctx.journal.idempotency_key) {
        return { operation_id: operationId, state: "idempotency_conflict", receipt: null, recovery_token: null, binding: null };
      }
      return inspectionFromJournal(ctx.journal, await readReceipt(ctx));
    },
    async prepare(request, inputHash, newManifestHash, recoveryToken) {
      return withFilesystemRootLock(async () => {
        const existing = await context(request.operation_id);
        if (existing !== null) {
          if (existing.journal.binding.input_hash !== inputHash || existing.journal.idempotency_key !== request.idempotency_key) {
            return { operation_id: request.operation_id, state: "idempotency_conflict", receipt: null, recovery_token: null, binding: null };
          }
          return inspectionFromJournal(existing.journal, await readReceipt(existing));
        }
        if (await hasIdempotencyConflict(request.idempotency_key, request.operation_id)) {
          return { operation_id: request.operation_id, state: "idempotency_conflict", receipt: null, recovery_token: null, binding: null };
        }
        return inspectionFromJournal((await createJournal(request, inputHash, newManifestHash, recoveryToken)).journal, null);
      });
    },
    async apply(operationId, recoveryToken) {
      return withFilesystemRootLock(async () => {
        const ctx = await context(operationId);
        if (ctx === null || ctx.journal.recovery.recovery_token !== recoveryToken) throw new Error("MAP_PUBLICATION_RECOVERY_NOT_FOUND");
        return applyInternal(ctx);
      });
    },
    async recover(operationId, recoveryToken) {
      return withFilesystemRootLock(async () => {
        const ctx = await context(operationId);
        if (ctx === null || ctx.journal.recovery.recovery_token !== recoveryToken) throw new Error("MAP_PUBLICATION_RECOVERY_NOT_FOUND");
        return applyInternal(ctx);
      });
    },
    async rollback(request: MapPublicationRollbackRequest): Promise<MapPublicationRollbackOutcome> {
      return withFilesystemRootLock(async () => {
        const ctx = await context(request.operation_id);
        if (ctx === null || ctx.journal.recovery.recovery_token !== request.recovery_token ||
            ctx.journal.state !== "committed" || ctx.journal.binding.new_manifest_hash !== request.expected_published_manifest_hash) {
          return { outcome: "not_found" };
        }
        const currentPointer = await readPointer();
        if (currentPointer === null) return { outcome: "conflict" };
        let previousPointer: MapPublicationGenerationPointer | null;
        try { previousPointer = await readPreviousPointer(ctx); }
        catch { return { outcome: "conflict" }; }
        let backups: BackupEntry[];
        try { backups = await readValidatedBackups(ctx); }
        catch { return { outcome: "conflict" }; }
        const currentIsPublished = currentPointer.state === "published" &&
          currentPointer.manifest_hash === ctx.journal.binding.new_manifest_hash &&
          CODEBASE_MAP_PUBLICATION_TARGETS.every((path) =>
            currentPointer.payload_hashes[path] === ctx.journal.binding.expected_payload_hashes[path]);
        const currentIsPrevious = previousPointer === null
          ? currentPointer.state === "empty"
          : pointerBytesEqual(currentPointer, previousPointer);
        if (!currentIsPublished && !currentIsPrevious) return { outcome: "conflict" };
        if (currentIsPublished && !await generationMatches(generationDirectory(currentPointer),
          currentPointer.payload_hashes as Record<MapPublicationTargetPath, string>)) {
          return { outcome: "conflict" };
        }
        const intent = await readRollbackIntent(ctx);
        if (intent === null) {
          // A fresh rollback may only start from the exact published pointer;
          // an externally changed compatibility projection is a conflict.
          if (!currentIsPublished || !(await projectionMatches(currentPointer))) return { outcome: "conflict" };
          try { await writeRollbackIntent(ctx, currentPointer); }
          catch { return { outcome: "conflict" }; }
        } else if (intent.expected_published_manifest_hash !== ctx.journal.binding.new_manifest_hash ||
            (currentIsPublished && intent.current_pointer_hash !== stableHash(currentPointer))) {
          return { outcome: "conflict" };
        }
        try {
          if (previousPointer !== null) {
            if (!await generationMatches(generationDirectory(previousPointer),
              previousPointer.payload_hashes as Record<MapPublicationTargetPath, string>)) {
                return { outcome: "conflict" };
            }
            await projectGeneration(ctx, previousPointer);
          } else {
            for (const entry of backups) {
              const finalPath = targetPath(projectRoot, entry.path);
              await safeFile(finalPath);
              if (entry.existed) {
                const backup = join(ctx.backup_root, encodeURIComponent(entry.path));
                const temp = `${finalPath}.${randomUUID()}.rollback`;
                try {
                  await copyFile(backup, temp);
                  await syncFile(temp);
                  await rename(temp, finalPath);
                  await syncDirectory(resolve(finalPath, ".."));
                } catch {
                  await rm(temp, { force: true }).catch(() => undefined);
                  return { outcome: "conflict" };
                }
              } else {
                try { await rm(finalPath, { force: true }); }
                catch { return { outcome: "conflict" }; }
              }
            }
          }
          await writePointer(previousPointer ?? emptyPointer());
        } catch {
          return { outcome: "conflict" };
        }
        try { await syncDirectory(targetRoot); }
        catch { return { outcome: "conflict" }; }
        if (!await liveMatchesBackups(backups)) return { outcome: "conflict" };
        const manifestBackup = backups.find((entry) => entry.path === ".harness/codebase/map-manifest.json");
        const resultingManifestHash = manifestBackup?.hash ?? null;
        await writeJournal(ctx, { ...ctx.journal, state: "rolled_back", commit_ambiguity: "resolved_rolled_back",
          readback: "verified", cleanup: "completed", updated_at: now() });
        await rm(ctx.rollback_intent_path, { force: true }).catch(() => undefined);
        return { outcome: "rolled_back", resulting_manifest_hash: resultingManifestHash };
      });
    },
    async readback(operationId) { return withFilesystemRootLock(() => readbackInternal(operationId)); }
  };
}
