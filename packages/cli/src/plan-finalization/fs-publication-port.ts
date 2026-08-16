import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import { canonicalJson } from "@hunter-harness/contracts";

import {
  derivePlanDurablePublicationFilesystemBinding,
  derivePlanDurablePublicationFilesystemReadbackHash,
  planDurablePublicationTargetPaths,
  planDurablePublicationTargetSetHash,
  readPlanDurablePublicationFilesystemJournal,
  type PlanDurablePublicationFilesystemApplyRequest,
  type PlanDurablePublicationFilesystemHostAuthority,
  type PlanDurablePublicationFilesystemInspectRequest,
  type PlanDurablePublicationFilesystemJournal,
  type PlanDurablePublicationFilesystemPortInspection,
  type PlanDurablePublicationFilesystemPrepareRequest,
  type PlanDurablePublicationFilesystemReadback,
  type PlanDurablePublicationFilesystemRollbackRequest,
  type PlanDurablePublicationFilesystemSha256,
  type PlanDurablePublicationFilesystemTransactionInspection,
  type PlanDurablePublicationFilesystemTransactionPort
} from "@hunter-harness/core";

/**
 * Plan durable publication 的生产 FS 适配器（T0-1/2/3 冻结方案）：
 * - 写根：`<projectRoot>/.harness/changes/<change_key>/`（change 目录唯一权威）；
 * - staging：`<changeDir>/.publication-staging/<operation_id>/` 全量渲染；
 * - commit：逐 payload 写 `<target>.tmp` → fsync → 原子 rename（同一卷）；
 * - journal：`<changeDir>/meta/publication-journals/<operation_id>.json`，
 *   状态机 prepared → applying → committed / rolled_back / recovery_required；
 * - 崩溃恢复：apply 幂等（内容确定可重放）；非 prepared/applying/committed 状态
 *   一律 recovery_required（ambiguous FS fail closed，T0-5）。
 */
export interface FsPlanPublicationPortOptions {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly now?: () => string;
}

const JOURNALS_DIR = join("meta", "publication-journals");
const STAGING_DIR = ".publication-staging";

function sha256(bytes: Uint8Array | string): PlanDurablePublicationFilesystemSha256 {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function changeDir(root: string, changeKey: string): string {
  return join(root, ".harness", "changes", changeKey);
}

function journalPath(root: string, changeKey: string, operationId: string): string {
  return join(changeDir(root, changeKey), JOURNALS_DIR, `${operationId}.json`);
}

function stagingPath(root: string, changeKey: string, operationId: string): string {
  return join(changeDir(root, changeKey), STAGING_DIR, operationId);
}

async function writeFileAtomic(path: string, bytes: Uint8Array): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  const handle = await fs.open(tmp, "w");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, path);
  // fsync 父目录，确保持久 rename（T0-3 顺序要求）。
  // Windows 不支持目录 fsync（EPERM）——降级跳过；POSIX 上仍强制。
  if (process.platform !== "win32") {
    const dirHandle = await fs.open(dirname(path), "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  }
}

async function readJournal(path: string): Promise<PlanDurablePublicationFilesystemJournal | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("PLAN_DURABLE_PUBLICATION_FILESYSTEM_JOURNAL_INVALID");
  }
  const result = readPlanDurablePublicationFilesystemJournal(parsed);
  if (!result.ok || result.mode !== "current") {
    throw new Error("PLAN_DURABLE_PUBLICATION_FILESYSTEM_JOURNAL_INVALID");
  }
  return result.value;
}

async function writeJournal(path: string, journal: PlanDurablePublicationFilesystemJournal): Promise<void> {
  await writeFileAtomic(path, new TextEncoder().encode(JSON.stringify(journal, null, 2)));
}

/** Host authority 描述符（T0-1：change 目录写根 + 同目录 journal 根）。 */
export function buildFsPublicationAuthority(options: FsPlanPublicationPortOptions, changeKey: string): PlanDurablePublicationFilesystemHostAuthority {
  return Object.freeze({
    schema_version: 1,
    record_kind: "plan_durable_publication_filesystem_authority",
    root_identity: Object.freeze({
      schema_version: 1,
      project_identity: options.projectId,
      project_root_hash: sha256(`root\0${options.projectId}`)
    }),
    target_identity: Object.freeze({
      schema_version: 1,
      change_key: changeKey,
      target_root: `.harness/changes/${changeKey}`,
      target_set_hash: planDurablePublicationTargetSetHash(changeKey),
      ownership_paths: planDurablePublicationTargetPaths(changeKey)
    }),
    journal_identity: Object.freeze({
      schema_version: 1,
      journal_root: `.harness/changes/${changeKey}/meta/publication-journals`,
      journal_root_hash: sha256(`journal-root\0${changeKey}`)
    })
  });
}

function inspectionOf(operationId: string, journal: PlanDurablePublicationFilesystemJournal | null): PlanDurablePublicationFilesystemTransactionInspection {
  if (journal === null) {
    return { operation_id: operationId, state: "unknown", receipt: null, recovery_token: null, binding: null };
  }
  return {
    operation_id: operationId,
    state: journal.state,
    receipt: null,
    recovery_token: journal.recovery.recovery_token,
    binding: journal.binding
  };
}

async function assertNoSymlink(path: string): Promise<void> {
  try {
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink()) throw new Error("PLAN_DURABLE_PUBLICATION_FILESYSTEM_SYMLINK_REJECTED");
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

export function createFsPlanPublicationPort(options: FsPlanPublicationPortOptions): PlanDurablePublicationFilesystemTransactionPort {
  const now = options.now ?? (() => new Date().toISOString());
  const root = options.projectRoot;

  async function findJournalByOperation(operationId: string): Promise<PlanDurablePublicationFilesystemJournal | null> {
    const changesRoot = join(root, ".harness", "changes");
    let changeKeys: string[];
    try {
      changeKeys = (await fs.readdir(changesRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return null;
    }
    for (const changeKey of changeKeys) {
      let journal: PlanDurablePublicationFilesystemJournal | null;
      try {
        journal = await readJournal(journalPath(root, changeKey, operationId));
      } catch {
        journal = null;
      }
      if (journal !== null) return journal;
    }
    return null;
  }

  async function commitFromJournal(journal: PlanDurablePublicationFilesystemJournal): Promise<void> {
    const staging = stagingPath(root, journal.change_key, journal.operation_id);
    const base = changeDir(root, journal.change_key);
    for (const payloadPath of journal.binding.ownership_paths) {
      const staged = join(staging, payloadPath);
      const bytes = await fs.readFile(staged);
      const expected = journal.binding.expected_payload_hashes[payloadPath];
      if (expected === undefined || sha256(bytes) !== expected) {
        throw new Error("PLAN_DURABLE_PUBLICATION_FILESYSTEM_STAGING_TAMPERED");
      }
      const target = join(base, payloadPath);
      await assertNoSymlink(target);
      await writeFileAtomic(target, new Uint8Array(bytes));
    }
  }

  async function applyJournal(input: PlanDurablePublicationFilesystemApplyRequest): Promise<PlanDurablePublicationFilesystemTransactionInspection> {
    const found = await findJournalByOperation(input.operation_id);
    if (found === null || found.recovery.recovery_token !== input.recovery_token) {
      throw new Error("PLAN_DURABLE_PUBLICATION_FILESYSTEM_IDENTITY_MISMATCH");
    }
    if (found.state === "committed") return inspectionOf(input.operation_id, found);
    if (found.state === "rolled_back" || found.state === "recovery_required") {
      throw new Error("PLAN_DURABLE_PUBLICATION_FILESYSTEM_APPLY_INVALID");
    }
    const applying: PlanDurablePublicationFilesystemJournal = Object.freeze({
      ...found, state: "applying", updated_at: now()
    });
    await writeJournal(journalPath(root, found.change_key, input.operation_id), applying);
    await commitFromJournal(applying);
    const committed: PlanDurablePublicationFilesystemJournal = Object.freeze({
      ...applying, state: "committed", commit_ambiguity: "resolved_committed", readback: "verified", updated_at: now()
    });
    await writeJournal(journalPath(root, found.change_key, input.operation_id), committed);
    return inspectionOf(input.operation_id, committed);
  }

  return Object.freeze({
    async inspect(input: PlanDurablePublicationFilesystemInspectRequest): Promise<PlanDurablePublicationFilesystemPortInspection> {
      const found = await findJournalByOperation(input.operation_id);
      if (found === null) return inspectionOf(input.operation_id, null);
      if (input.idempotency_key !== undefined && found.idempotency_key !== input.idempotency_key) {
        return { operation_id: input.operation_id, state: "idempotency_conflict", receipt: null, recovery_token: null, binding: null };
      }
      return inspectionOf(input.operation_id, found);
    },

    async prepare(input: PlanDurablePublicationFilesystemPrepareRequest): Promise<PlanDurablePublicationFilesystemPortInspection> {
      const path = journalPath(root, input.change_key, input.operation_id);
      const existing = await readJournal(path);
      if (existing !== null) {
        if (existing.idempotency_key !== input.idempotency_key || existing.project_id !== input.project_id ||
            existing.change_key !== input.change_key || existing.binding.new_manifest_hash !== input.plan.manifest_hash ||
            existing.recovery.recovery_token !== input.recovery_token) {
          throw new Error("PLAN_DURABLE_PUBLICATION_FILESYSTEM_IDENTITY_MISMATCH");
        }
        return inspectionOf(input.operation_id, existing);
      }
      // 渲染 staging：八 target 精确集合、顺序与哈希逐位核验
      const targetPaths = planDurablePublicationTargetPaths(input.change_key);
      if (input.plan.payloads.length !== targetPaths.length) {
        throw new Error("PLAN_DURABLE_PUBLICATION_FILESYSTEM_PREPARE_INVALID");
      }
      const staging = stagingPath(root, input.change_key, input.operation_id);
      for (const [index, payload] of input.plan.payloads.entries()) {
        const payloadPath = targetPaths[index];
        if (payloadPath === undefined || payload.path !== payloadPath) {
          throw new Error("PLAN_DURABLE_PUBLICATION_FILESYSTEM_PREPARE_INVALID");
        }
        const bytes = Uint8Array.from(payload.bytes);
        if (bytes.byteLength !== payload.byte_length || sha256(bytes) !== payload.serialized_sha256) {
          throw new Error("PLAN_DURABLE_PUBLICATION_FILESYSTEM_PREPARE_INVALID");
        }
        await writeFileAtomic(join(staging, payloadPath), bytes);
      }
      const timestamp = now();
      const journal: PlanDurablePublicationFilesystemJournal = Object.freeze({
        schema_version: 1,
        record_kind: "plan_durable_publication_filesystem",
        authority: input.authority,
        operation_id: input.operation_id,
        idempotency_key: input.idempotency_key,
        project_id: input.project_id,
        change_key: input.change_key,
        binding: derivePlanDurablePublicationFilesystemBinding(input),
        staging: Object.freeze({
          schema_version: 1,
          staging_id: `plan_stage:${sha256(input.operation_id).slice(7)}` as `plan_stage:${string}`,
          staging_root_hash: sha256(`staging\0${input.operation_id}`),
          target_set_hash: input.authority.target_identity.target_set_hash,
          state: "fsynced"
        }),
        recovery: Object.freeze({
          schema_version: 1,
          // 契约派生：plan_recovery_id:<canonicalJson({operation_id, recovery_token}) 的哈希>
          recovery_id: `plan_recovery_id:${sha256(canonicalJson({
            operation_id: input.operation_id,
            recovery_token: input.recovery_token
          })).slice(7)}` as `plan_recovery_id:${string}`,
          recovery_token: input.recovery_token
        }),
        safety_policy: Object.freeze({
          same_volume: "same_volume_required",
          atomic_replace: "atomic_replace_set_required",
          fsync: "file_and_parent_directory_required",
          symlink_policy: "reject_symlink_and_reparse_point",
          target_allowlist: "exact_eight_plan_targets"
        }),
        state: "prepared",
        commit_ambiguity: "not_ambiguous",
        readback: "pending",
        cleanup: "not_required",
        created_at: timestamp,
        updated_at: timestamp
      });
      await writeJournal(path, journal);
      return inspectionOf(input.operation_id, journal);
    },

    async apply(input: PlanDurablePublicationFilesystemApplyRequest): Promise<PlanDurablePublicationFilesystemTransactionInspection> {
      return applyJournal(input);
    },

    async recover(input: PlanDurablePublicationFilesystemApplyRequest): Promise<PlanDurablePublicationFilesystemTransactionInspection> {
      const found = await findJournalByOperation(input.operation_id);
      if (found === null || found.recovery.recovery_token !== input.recovery_token) {
        throw new Error("PLAN_DURABLE_PUBLICATION_FILESYSTEM_IDENTITY_MISMATCH");
      }
      // prepared/applying/committed：apply 幂等重放即可收敛（T0-3）
      if (found.state === "prepared" || found.state === "applying" || found.state === "committed") {
        return applyJournal(input);
      }
      // ambiguous FS（rolled_back / recovery_required / unknown 残留）→ fail closed（T0-5）
      const required: PlanDurablePublicationFilesystemJournal = Object.freeze({
        ...found, state: "recovery_required", commit_ambiguity: "unknown", readback: "pending", updated_at: now()
      });
      await writeJournal(journalPath(root, found.change_key, input.operation_id), required);
      return inspectionOf(input.operation_id, required);
    },

    async rollback(input: PlanDurablePublicationFilesystemRollbackRequest): Promise<PlanDurablePublicationFilesystemTransactionInspection> {
      const found = await findJournalByOperation(input.operation_id);
      if (found === null) return inspectionOf(input.operation_id, null);
      const rolledBack: PlanDurablePublicationFilesystemJournal = Object.freeze({
        ...found, state: "rolled_back", commit_ambiguity: "resolved_rolled_back", readback: "verified", updated_at: now()
      });
      await writeJournal(journalPath(root, found.change_key, input.operation_id), rolledBack);
      return inspectionOf(input.operation_id, rolledBack);
    },

    async readback(operationId: string): Promise<PlanDurablePublicationFilesystemReadback> {
      const found = await findJournalByOperation(operationId);
      if (found === null || found.state !== "committed") {
        return { operation_id: operationId, live_manifest_hash: null, payload_hashes: {}, readback_hash: null, journal_committed: false };
      }
      const base = changeDir(root, found.change_key);
      const payloadHashes: Record<string, PlanDurablePublicationFilesystemSha256> = {};
      for (const payloadPath of found.binding.ownership_paths) {
        try {
          const bytes = await fs.readFile(join(base, payloadPath));
          payloadHashes[payloadPath] = sha256(bytes);
        } catch {
          return { operation_id: operationId, live_manifest_hash: null, payload_hashes: payloadHashes, readback_hash: null, journal_committed: true };
        }
      }
      return {
        operation_id: operationId,
        live_manifest_hash: found.binding.new_manifest_hash,
        payload_hashes: payloadHashes,
        readback_hash: derivePlanDurablePublicationFilesystemReadbackHash({
          manifest_hash: found.binding.new_manifest_hash,
          payload_hashes: payloadHashes,
          change_key: found.change_key
        }),
        journal_committed: true
      };
    }
  });
}
