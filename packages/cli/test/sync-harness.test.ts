import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// v1.0：sync-harness.mjs 收敛为单 bundle 纯脚本（原子交换已随多适配器矩阵退役），
// 本文件只保留 family manifest 与数据包的版本/能力对齐契约。
describe("sync-harness family alignment", () => {
  it("keeps workflow-family and generated bundle versions aligned", async () => {
    const family = JSON.parse(
      await readFile(
        join(process.cwd(), "packages", "workflow-data-harness", "hunter-workflow-family.json"),
        "utf8"
      )
    ) as {
      bundle_version: string;
      minimumCliVersion: string;
      workflowPackageVersion: string;
      capabilities: string[];
    };
    const workflowPackage = JSON.parse(
      await readFile(
        join(process.cwd(), "packages", "workflow-data-harness", "package.json"),
        "utf8"
      )
    ) as { version: string };
    const bundle = JSON.parse(
      await readFile(
        join(
          process.cwd(),
          "packages",
          "workflow-data-harness",
          "harness",
          "manifests",
          "codex.json"
        ),
        "utf8"
      )
    ) as { bundle_version: string };

    expect(family.bundle_version).toBe(bundle.bundle_version);
    expect(family.minimumCliVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(family.workflowPackageVersion).toBe(workflowPackage.version);
    expect(family.capabilities).toEqual(expect.arrayContaining([
      "sync@2",
      "knowledge-sync@3",
      "codegraph-status@2"
    ]));
    // v1.0 退役守卫：人工 rules 队列能力不得回流。
    expect(family.capabilities).not.toContain("rules-sync@1");
    expect(family.capabilities).not.toContain("rules-review@1");
  });
});
