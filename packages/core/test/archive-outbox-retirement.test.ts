import { access, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

/**
 * O6 工作包 F5 退役守卫（决策点 2 + 3）：
 * - F5a：archive-outbox v2 与 local-authority（零生产接线、测试独占）已删除；
 * - F5b：archive-outbox v1 与 archive-remote-adapter（claim 链零生产调用方，
 *   Python republish 为唯一权威投递链）已删除。
 * 本测试锁死旧路径不得回潮。
 */

const coreSrc = new URL("../src/", import.meta.url);
const coreBarrel = new URL("../src/index.ts", import.meta.url);
const fsStable = new URL("../src/fs/stable.ts", import.meta.url);
const fixtureDir = new URL("./fixtures/", import.meta.url);

async function exists(url: URL): Promise<boolean> {
  try {
    await access(url);
    return true;
  } catch {
    return false;
  }
}

describe("archive-outbox / archive-remote-adapter 退役守卫（O6 F5）", () => {
  it("src/archive-outbox 目录整体退役（v1 + v2 + local-authority）", async () => {
    expect(await exists(new URL("archive-outbox/", coreSrc))).toBe(false);
  });

  it("src/archive-remote-adapter 目录整体退役", async () => {
    expect(await exists(new URL("archive-remote-adapter/", coreSrc))).toBe(false);
  });

  it("core barrel 不再导出 outbox / remote-adapter 符号", async () => {
    const source = await readFile(coreBarrel, "utf8");
    expect(source).not.toMatch(/archive-outbox/u);
    expect(source).not.toMatch(/archive-remote-adapter/u);
    expect(source).not.toMatch(/createArchiveOutbox/u);
    expect(source).not.toMatch(/createArchiveRemoteAdapter/u);
  });

  it("fs/stable.ts 不再携带 local-authority 专供的 strictLocalAuthorityHash", async () => {
    const source = await readFile(fsStable, "utf8");
    expect(source).not.toMatch(/strictLocalAuthorityHash/u);
  });

  it("退役链的测试 fixture 一并清除", async () => {
    for (const name of [
      "archive-outbox-v0-legacy.json",
      "archive-outbox-v1-current.json",
      "archive-outbox-local-authority-v2-current.json",
      "archive-remote-adapter-v0-legacy.json"
    ]) {
      expect(await exists(new URL(name, fixtureDir))).toBe(false);
    }
  });
});
