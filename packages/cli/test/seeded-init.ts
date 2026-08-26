import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const seeds = new Map<string, string>();

/**
 * CLI 测试的种子初始化：同一 key 只在首个用例真实执行完整 init（数百文件投影 +
 * 校验 + 事务），后续用例用目录拷贝复用。用例若要求 init 的副作用差异（如不同
 * 配置），必须使用不同的 key。调用方在执行用例步骤前自行写入各自专属的
 * 凭据/配置（这些步骤保持每用例执行，成本为零）。
 */
export async function seededInit(
  root: string,
  key: string,
  build: (seedRoot: string) => Promise<void>
): Promise<void> {
  let seedRoot = seeds.get(key);
  if (seedRoot === undefined) {
    seedRoot = await mkdtemp(join(tmpdir(), "hunter-cli-seed-"));
    await build(seedRoot);
    seeds.set(key, seedRoot);
  }
  await rm(root, { recursive: true, force: true });
  await cp(seedRoot, root, { recursive: true });
}
