import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PLAN_PHASES } from "@hunter-harness/core";

/**
 * 阶段清单是一份跨语言的隐式契约：TS 的 PLAN_PHASES 与 Python 的
 * harness_paths.WORKFLOW_PHASES 必须逐项相同，但两边是各自手写的常量，
 * 没有任何机制保证同步。
 *
 * Python 侧刚吃过这个亏——harness_phase 的那份拷贝少了一个 merge，worktree
 * 变更走到 merge 阶段就在 target_required_dag 里硬 raise。收敛成单一真相源之后
 * Python 内部安全了，跨语言这一层仍然是裸的。
 */
describe("plan phase vocabulary", () => {
  it("与 Python 的 harness_paths.WORKFLOW_PHASES 逐项一致", async () => {
    const source = await readFile(
      fileURLToPath(new URL("../../../harness/scripts/harness_paths.py", import.meta.url)),
      "utf8"
    );
    const block = /^WORKFLOW_PHASES\s*=\s*\(([\s\S]*?)\)/mu.exec(source);
    expect(block, "harness_paths.py 里找不到 WORKFLOW_PHASES").not.toBeNull();

    const pythonPhases = [...(block as RegExpExecArray)[1].matchAll(/"([a-z-]+)"/gu)]
      .map((match) => match[1]);

    expect(pythonPhases.length).toBeGreaterThan(0);
    // 顺序也要一致：两边都用它做阶段先后的 rank。
    expect(pythonPhases).toEqual([...PLAN_PHASES]);
  });
});
