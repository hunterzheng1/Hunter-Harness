import { describe, expect, it } from "vitest";

import type { SourceFile } from "@hunter-harness/contracts";
import { computeDiff as coreComputeDiff } from "@hunter-harness/core";

import { computeDiff } from "../components/skill-shared";

// 对等测试：web 端本地 computeDiff（skill-shared.tsx）必须与 core computeDiff（packages/core/src/skill-ir/diff.ts）输出逐字一致。
// 防止两份副本漂移——web 不能 import core（node: scheme 不兼容 webpack），故本地复制；core 端改算法时此测试会失败。
// 见 skill-shared.tsx:238-259 注释（交叉引用 core 源文件）。
const cases: Array<{ name: string; published: SourceFile[]; draft: SourceFile[] }> = [
  { name: "both empty", published: [], draft: [] },
  { name: "added (empty previous)", published: [], draft: [{ path: "SKILL.md", content: "# v1" }] },
  { name: "removed (empty current)", published: [{ path: "SKILL.md", content: "# v1" }], draft: [] },
  { name: "modified", published: [{ path: "SKILL.md", content: "# v1" }], draft: [{ path: "SKILL.md", content: "# v2" }] },
  { name: "unchanged (same content → no diff entry)", published: [{ path: "SKILL.md", content: "# v1" }], draft: [{ path: "SKILL.md", content: "# v1" }] },
  {
    name: "multi-file mixed (added/modified/removed)",
    published: [{ path: "a.md", content: "a1" }, { path: "b.md", content: "b1" }],
    draft: [{ path: "b.md", content: "b2" }, { path: "c.md", content: "c1" }]
  },
  {
    name: "duplicate path in published (last wins)",
    published: [{ path: "a.md", content: "a1" }, { path: "a.md", content: "a2" }],
    draft: [{ path: "a.md", content: "a3" }]
  },
  {
    name: "duplicate path in draft (last wins)",
    published: [{ path: "a.md", content: "a1" }],
    draft: [{ path: "a.md", content: "a2" }, { path: "a.md", content: "a3" }]
  }
];

describe("computeDiff parity: web local (skill-shared) vs core (skill-ir/diff)", () => {
  for (const c of cases) {
    it(c.name, () => {
      const web = computeDiff(c.published, c.draft);
      const core = coreComputeDiff(c.published, c.draft);
      expect(web).toEqual(core);
    });
  }
});
