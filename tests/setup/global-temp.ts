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

import { resolveRecoveryRoot } from "../../packages/core/src/transaction/recovery-store.js";

const ROOT_PREFIX = "hunter-vitest-";
const STALE_MS = 24 * 60 * 60 * 1000;

let tempRoot: string | undefined;
let realRecoveryBaseline: { path: string; count: number } | undefined;

/** 真实恢复存储的索引条目数；用于在 teardown 时发现泄漏。 */
async function countRecoveryIndexEntries(root: string): Promise<number> {
  try {
    return (await readdir(join(root, "recoveries", ".index"))).length;
  } catch {
    return 0;
  }
}

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
  // 必须在覆盖 HUNTER_HARNESS_RECOVERY_ROOT 之前取真实路径，否则量到的是临时根。
  const realRecoveryRoot = resolveRecoveryRoot(process.env);
  realRecoveryBaseline = {
    path: realRecoveryRoot,
    count: await countRecoveryIndexEntries(realRecoveryRoot)
  };
  await sweepStaleRoots(tmpdir());
  tempRoot = await mkdtemp(join(tmpdir(), ROOT_PREFIX));
  process.env["TMPDIR"] = tempRoot;
  process.env["TMP"] = tempRoot;
  process.env["TEMP"] = tempRoot;
  process.env["HUNTER_HARNESS_RECOVERY_ROOT"] = join(tempRoot, "recovery");
}

export async function teardown(): Promise<void> {
  // 泄漏守卫：重定向只作用于 process.env，注入了精简 env 的用例仍会让
  // resolveRecoveryRoot 回退到真实目录。靠人记得不可靠，这里让它自己喊出来。
  if (realRecoveryBaseline !== undefined) {
    const after = await countRecoveryIndexEntries(realRecoveryBaseline.path);
    const leaked = after - realRecoveryBaseline.count;
    if (leaked > 0) {
      console.warn(
        `[global-temp] 本次测试向真实恢复存储写入了 ${leaked} 个条目：` +
        `${realRecoveryBaseline.path}\n` +
        "  常见原因：某个用例给 runCli 注入了精简 env 却没带 " +
        "HUNTER_HARNESS_RECOVERY_ROOT（参见 packages/cli/test/init.test.ts 的 recoveryEnv）。"
      );
    }
  }
  if (tempRoot === undefined) return;
  try {
    // Windows 上文件可能被杀毒/索引短暂占用，重试提高删除成功率。
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    console.warn(`[global-temp] 未能删除临时根目录 ${tempRoot}:`, error);
  }
}
