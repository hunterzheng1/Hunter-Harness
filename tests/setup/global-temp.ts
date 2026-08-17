// 全局临时目录兜底：测试大量使用 mkdtemp(join(tmpdir(), "hunter-*")) 且不清理，
// 曾泄漏 >100GB 到系统 Temp。这里为每次 vitest 运行创建专属临时根目录，并通过
// TMPDIR/TMP/TEMP 让 os.tmpdir()（含 fork worker 与测试内 spawn 的子进程）指向它，
// 运行结束后整树删除，测试本身无需再各自注册清理。
//
// 事务恢复存储是同一问题的漏网之鱼：resolveRecoveryRoot() 默认落到
// %LOCALAPPDATA%/HunterHarness/recovery，而 init/refresh 每个用例都会往那里写一份
// durable 副本且从不回收——实测 18 天堆出 1.87M 文件 / 37GB，并让每次 runCli 多花
// 十几秒遍历索引。HUNTER_HARNESS_RECOVERY_ROOT 一并指进临时根，随 teardown 消失。
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT_PREFIX = "hunter-vitest-";
const STALE_MS = 24 * 60 * 60 * 1000;

let tempRoot: string | undefined;

/** 进程被强杀时 teardown 不执行，这里清扫上次运行残留的陈旧根目录。 */
async function sweepStaleRoots(base: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of entries) {
    if (!name.startsWith(ROOT_PREFIX)) continue;
    const candidate = join(base, name);
    try {
      const info = await stat(candidate);
      if (!info.isDirectory() || now - info.mtimeMs < STALE_MS) continue;
      await rm(candidate, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // 可能被并行运行的 vitest 占用，留给下次清扫
    }
  }
}

export async function setup(): Promise<void> {
  await sweepStaleRoots(tmpdir());
  tempRoot = await mkdtemp(join(tmpdir(), ROOT_PREFIX));
  process.env["TMPDIR"] = tempRoot;
  process.env["TMP"] = tempRoot;
  process.env["TEMP"] = tempRoot;
  process.env["HUNTER_HARNESS_RECOVERY_ROOT"] = join(tempRoot, "recovery");
}

export async function teardown(): Promise<void> {
  if (tempRoot === undefined) return;
  try {
    // Windows 上文件可能被杀毒/索引短暂占用，重试提高删除成功率。
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    console.warn(`[global-temp] 未能删除临时根目录 ${tempRoot}:`, error);
  }
}
