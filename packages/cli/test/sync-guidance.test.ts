import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("harness-sync interaction guidance", () => {
  it("uses a Chinese checkbox follow-up with concrete outcomes", async () => {
    const skill = await readFile(
      join(process.cwd(), "harness", "harness-sync", "SKILL.md"),
      "utf8"
    );

    expect(skill).toContain("多选复选框");
    expect(skill).toContain("只显示与本次非 OK 组件对应的选项");
    expect(skill).toContain("生成 Codebase Map");
    expect(skill).toContain("STACK.md");
    expect(skill).toContain("map-summary.md");
    expect(skill).toContain("运行指令审计");
    expect(skill).toContain("生成中文优化提案");
    expect(skill).toContain("不会直接修改项目文档");
    expect(skill).toContain("保持现状");
  });

  it("forbids lifecycle events, monitoring upload and persistent sync reports", async () => {
    const skill = await readFile(
      join(process.cwd(), "harness", "harness-sync", "SKILL.md"),
      "utf8"
    );
    const reference = await readFile(
      join(process.cwd(), "harness", "harness-sync", "reference.md"),
      "utf8"
    );

    expect(skill).toContain("不追加 change 事件");
    expect(skill).toContain("不调用 `events-sync`");
    expect(skill).toContain("不写入 `.harness/runtime/sync/`");
    expect(skill).not.toContain("shared/logging.md");
    expect(reference).toContain("`reportPath` 和 `reportSha256` 固定为 `null`");
  });
});
