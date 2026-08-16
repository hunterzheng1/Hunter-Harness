import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import type { CommandDependencies } from "./configure.js";
import { createFsArchiveOutboxPort } from "../archive-production/fs-outbox-port.js";

/**
 * `hunter-harness archive outbox gc`（06B-3 T0-5 冻结语义）。
 *
 * - 默认 dry-run；`--apply` 才执行删除
 * - 只收集显式目标：`--entry <id>`（可重复）或 `--retain-days <n>`（终态且 durable 早于 n 天）
 * - cleanup intent 先落盘再删字节；中断后下次从 intent 继续
 * - CAS 对象仅当无其他 record 引用同 hash 时删除；删除失败有界重试（3 次）后 dead-letter
 * - 默认保留全部：不带任何选择器即报错，绝不默认删除
 */

export interface ArchiveOutboxGcOptions {
  apply?: boolean;
  entry?: string[];
  retainDays?: string;
}

interface OutboxRecordLike {
  readonly entry_id: string;
  readonly state: string;
  readonly local_zip_ref?: { readonly package_sha256?: string } | null;
  readonly updated_at?: string;
  readonly [key: string]: unknown;
}

const TERMINAL = new Set(["acknowledged", "dead_letter"]);
const MAX_DELETE_ATTEMPTS = 3;

const casZipPath = (root: string, sha: string): string =>
  join(root, ".harness", "state", "local", "archive-cas", `${sha.slice(7)}.zip`);
const casBindingPath = (root: string, sha: string): string =>
  join(root, ".harness", "state", "local", "archive-cas", `${sha.slice(7)}.binding.json`);
const intentPath = (root: string, entryId: string): string =>
  join(root, ".harness", "state", "local", "archive-cleanup-intents", `${encodeURIComponent(entryId)}.json`);
const deadLetterPath = (root: string, entryId: string): string =>
  join(root, ".harness", "state", "local", "archive-cleanup-dead-letter", `${encodeURIComponent(entryId)}.json`);

async function writeJson(path: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

export async function runArchiveOutboxGc(
  options: ArchiveOutboxGcOptions,
  dependencies: CommandDependencies
): Promise<number> {
  const root = dependencies.cwd;
  const entries = options.entry ?? [];
  const retainDays = options.retainDays === undefined ? undefined : Number.parseInt(options.retainDays, 10);
  if (entries.length === 0 && (retainDays === undefined || !Number.isSafeInteger(retainDays) || retainDays < 1)) {
    dependencies.stdout(JSON.stringify({
      ok: false, code: "ARCHIVE_OUTBOX_GC_SELECTOR_REQUIRED",
      message: "必须显式指定 --entry <id> 或 --retain-days <n>；默认保留全部，不默认删除"
    }) + "\n");
    return 1;
  }

  const port = createFsArchiveOutboxPort({ projectRoot: root });
  const all: OutboxRecordLike[] = [];
  let cursor: string | undefined;
  do {
    const page = await port.list(cursor, 100) as unknown as { records: OutboxRecordLike[]; next_cursor?: string };
    all.push(...page.records);
    cursor = page.next_cursor;
  } while (cursor !== undefined);

  const now = Date.now();
  const targets = all.filter((record) => {
    if (!TERMINAL.has(record.state)) return false;
    if (entries.length > 0) return entries.includes(record.entry_id);
    const updated = Date.parse(String(record.updated_at ?? ""));
    return Number.isFinite(updated) && now - updated > (retainDays as number) * 86_400_000;
  });

  const referenced = new Map<string, number>();
  for (const record of all) {
    const sha = record.local_zip_ref?.package_sha256;
    if (typeof sha === "string") referenced.set(sha, (referenced.get(sha) ?? 0) + 1);
  }

  const results: { entry_id: string; action: string; detail?: string }[] = [];
  for (const record of targets) {
    const sha = record.local_zip_ref?.package_sha256;
    const shared = typeof sha === "string" && (referenced.get(sha) ?? 0) > 1;
    const plan = {
      entry_id: record.entry_id,
      zip: typeof sha === "string" && !shared ? "delete" : "keep",
      reason: shared ? "shared_cas_hash" : typeof sha === "string" ? "unreferenced" : "no_zip_ref"
    };
    if (options.apply !== true) {
      results.push({ entry_id: record.entry_id, action: "dry_run", detail: plan.reason });
      continue;
    }
    // cleanup intent 先落盘
    await writeJson(intentPath(root, record.entry_id), {
      schema_version: 1,
      entry_id: record.entry_id,
      package_sha256: sha ?? null,
      plan,
      created_at: new Date().toISOString()
    });
    if (plan.zip === "delete" && typeof sha === "string") {
      let deleted = false;
      let lastError = "";
      for (let attempt = 1; attempt <= MAX_DELETE_ATTEMPTS && !deleted; attempt += 1) {
        try {
          await fs.rm(casZipPath(root, sha), { force: true });
          await fs.rm(casBindingPath(root, sha), { force: true });
          deleted = true;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
      if (!deleted) {
        await writeJson(deadLetterPath(root, record.entry_id), {
          entry_id: record.entry_id, package_sha256: sha, error: lastError,
          dead_lettered_at: new Date().toISOString()
        });
        results.push({ entry_id: record.entry_id, action: "dead_letter", detail: lastError });
        continue;
      }
    }
    await fs.rm(intentPath(root, record.entry_id), { force: true });
    results.push({ entry_id: record.entry_id, action: "cleaned", detail: plan.reason });
  }

  dependencies.stdout(JSON.stringify({
    ok: true,
    code: "ARCHIVE_OUTBOX_GC_COMPLETE",
    dry_run: options.apply !== true,
    scanned: all.length,
    targets: targets.length,
    results
  }) + "\n");
  return 0;
}
