import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CI_ONLY_TEST_FILES } from "../scripts/changed-test-selection.mjs";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

describe("release pipeline", () => {
  it("provides a change-aware local preflight instead of repeating the full suite", () => {
    const packageJson = JSON.parse(
      readFileSync(join(rootDir, "package.json"), "utf8")
    ) as { scripts?: Record<string, string> };
    const scripts = packageJson.scripts ?? {};

    expect(scripts["test:changed"]).toBe("node scripts/test-changed.mjs");
    expect(scripts["release:preflight"]).toContain("npm run check:push");
    expect(scripts["release:preflight"]).toContain("npm run test:changed");
    expect(scripts["release:preflight"]).toContain("npm run build:artifacts");
    expect(scripts["release:preflight"]).not.toContain("check:all");
    expect(scripts["release:preflight"]).not.toMatch(/(?:^|&&\s*)npm test(?:\s|$)/);

    const changedRunner = readFileSync(
      join(rootDir, "scripts", "test-changed.mjs"),
      "utf8"
    );
    expect(changedRunner).toContain('"origin/main"');
    expect(changedRunner).toContain('"related"');
    expect(changedRunner).toContain('"--passWithNoTests"');
    expect(changedRunner).toContain("process.execPath");
    expect(changedRunner).toContain("完整矩阵交由 CI");
  });

  it("excludes the CI-only matrix from every local vitest project, from a single list", () => {
    const config = readFileSync(join(rootDir, "vitest.config.ts"), "utf8");

    // 清单只能有一份来源；config 里另抄一份迟早和选择器漂移
    expect(config).toContain("CI_ONLY_TEST_FILES");
    expect(config).toContain("./scripts/changed-test-selection.mjs");

    // CI 必须照跑完整矩阵，本地必须留有跑全量的正规出路
    expect(config).toContain("process.env.CI");
    expect(config).toContain("HUNTER_TEST_INCLUDE_CI_ONLY");

    // 清单里不允许留下已删除的测试文件，否则排除会静默失效
    expect(CI_ONLY_TEST_FILES.length).toBeGreaterThan(0);
    for (const relativePath of CI_ONLY_TEST_FILES) {
      expect(existsSync(join(rootDir, relativePath))).toBe(true);
    }
  });

  it("keeps one complete Linux check and shards every Windows test across two jobs", () => {
    const workflow = readFileSync(
      join(rootDir, ".github", "workflows", "check.yml"),
      "utf8"
    );

    expect(workflow).toContain("check-linux:");
    expect(workflow).toContain("test-windows:");
    expect(workflow).toContain("shard: [1, 2]");
    expect(workflow).toContain(
      "npm test -- --shard=${{ matrix.shard }}/2"
    );
    expect(workflow).not.toContain("os: [ubuntu-latest, windows-latest]");
    expect(workflow.match(/run: npm run check\s*$/gm)).toHaveLength(1);
    expect(workflow).toContain("timeout-minutes: 10");
    expect(workflow).toContain("package-smoke:");
    expect(workflow).toContain("node22-compat:");
  });

  it("documents the fast local preflight and the complete CI fallback", () => {
    const readme = readFileSync(join(rootDir, "README.md"), "utf8");

    expect(readme).toContain("npm run release:preflight");
    expect(readme).toContain("受改动影响的测试");
    expect(readme).toContain("CI");
    expect(readme).toContain("npm run check:all");
  });
});
