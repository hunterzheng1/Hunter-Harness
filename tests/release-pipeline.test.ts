import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
