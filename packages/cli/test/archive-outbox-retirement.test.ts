import { access, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

/**
 * O6 工作包 F5b 退役守卫（决策点 3）：TS archive outbox v1 的
 * claim→publish→ack 投递链零生产调用方（enqueue 无生产写入），已整体退役，
 * `harness push --scope archive` 的唯一权威投递链是 Python republish。
 * 本测试锁死：生产接线、CLI 命令、dispatch 操作均不得回潮。
 */

const cliSrc = new URL("../src/", import.meta.url);

async function exists(url: URL): Promise<boolean> {
  try {
    await access(url);
    return true;
  } catch {
    return false;
  }
}

describe("archive outbox v1 投递链退役守卫（O6 F5b）", () => {
  it("cli/src/archive-production 生产接线目录已删除", async () => {
    expect(await exists(new URL("archive-production/", cliSrc))).toBe(false);
  });

  it("archive-outbox-gc 命令已删除", async () => {
    expect(await exists(new URL("commands/archive-outbox-gc.ts", cliSrc))).toBe(false);
  });

  it("push-pull.ts 不再携带 claim 路径与 archive_publish dispatch", async () => {
    const source = await readFile(new URL("commands/push-pull.ts", cliSrc), "utf8");
    expect(source).not.toMatch(/pushPullArchive/u);
    expect(source).not.toMatch(/archive_publish/u);
    expect(source).not.toMatch(/ArchivePublishInput/u);
  });

  it("push-pull-adapter 契约不再携带 archive_publish 操作", async () => {
    const source = await readFile(new URL("push-pull-adapter/types.ts", cliSrc), "utf8");
    expect(source).not.toMatch(/archive_publish/u);
  });

  it("bin.ts 不再注册 outbox gc 与 archive 生产接线", async () => {
    const source = await readFile(new URL("bin.ts", cliSrc), "utf8");
    expect(source).not.toMatch(/archive-outbox-gc/u);
    expect(source).not.toMatch(/composeArchiveProduction/u);
  });
});
