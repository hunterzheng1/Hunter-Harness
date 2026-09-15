import { readdir, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

/**
 * O6 工作包 F5a 退役守卫（决策点 2）：archive-outbox v2 与 local-authority
 * 自引入起零生产接线、测试独占，已删除。本测试锁死「旧路径不得回潮」：
 * 源码目录、barrel 导出、fs/stable.ts 的 strictLocalAuthorityHash 专供实现
 * 均不得再出现。
 */

const outboxDir = new URL("../src/archive-outbox/", import.meta.url);
const outboxBarrel = new URL("../src/archive-outbox/index.ts", import.meta.url);
const fsStable = new URL("../src/fs/stable.ts", import.meta.url);
const fixtureDir = new URL("./fixtures/", import.meta.url);

describe("archive-outbox v2 / local-authority 退役守卫（O6 F5a）", () => {
  it("src/archive-outbox 只保留 v1 实现，无 v2-* 文件与 local-authority 目录", async () => {
    const entries = await readdir(outboxDir, { withFileTypes: true });
    const names = entries.map((entry) => entry.name);
    expect(names.filter((name) => name.startsWith("v2-"))).toEqual([]);
    expect(names).not.toContain("local-authority");
  });

  it("archive-outbox barrel 不导出 v2 / local-authority 符号", async () => {
    const source = await readFile(outboxBarrel, "utf8");
    expect(source).not.toMatch(/v2-/u);
    expect(source).not.toMatch(/local-authority/u);
  });

  it("fs/stable.ts 不再携带 local-authority 专供的 strictLocalAuthorityHash", async () => {
    const source = await readFile(fsStable, "utf8");
    expect(source).not.toMatch(/strictLocalAuthorityHash/u);
  });

  it("测试 fixture 不再保留 local-authority 快照", async () => {
    const fixtures = await readdir(fixtureDir);
    expect(fixtures).not.toContain("archive-outbox-local-authority-v2-current.json");
  });
});
