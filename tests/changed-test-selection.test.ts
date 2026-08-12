import { describe, expect, it } from "vitest";

import { selectChangedTestInputs } from "../scripts/changed-test-selection.mjs";

describe("changed test selection", () => {
  it("runs changed test files directly without treating root metadata as all tests", () => {
    expect(
      selectChangedTestInputs([
        "package.json",
        ".github/workflows/check.yml",
        "tests/release-pipeline.test.ts"
      ])
    ).toEqual({
      directTests: ["tests/release-pipeline.test.ts"],
      relatedSources: [],
      deferredTests: [],
      pythonTests: []
    });
  });

  it("uses package implementation files as related-test inputs", () => {
    expect(
      selectChangedTestInputs([
        "packages/core/src/index.ts",
        "packages/cli/src/bin.ts",
        "README.md"
      ])
    ).toEqual({
      directTests: [],
      relatedSources: [
        "packages/cli/src/bin.ts",
        "packages/core/src/index.ts"
      ],
      deferredTests: [],
      pythonTests: []
    });
  });

  it("normalizes Windows paths, deduplicates inputs and ignores generated output", () => {
    expect(
      selectChangedTestInputs([
        "packages\\core\\test\\gitignore.test.ts",
        "packages/core/test/gitignore.test.ts",
        "packages/core/dist/index.js",
        "docs/release.md"
      ])
    ).toEqual({
      directTests: ["packages/core/test/gitignore.test.ts"],
      relatedSources: [],
      deferredTests: [],
      pythonTests: []
    });
  });

  it("maps release selector changes back to their contract tests", () => {
    expect(selectChangedTestInputs(["scripts/test-changed.mjs"])).toEqual({
      directTests: [
        "tests/changed-test-selection.test.ts",
        "tests/release-pipeline.test.ts"
      ],
      relatedSources: [],
      deferredTests: [],
      pythonTests: []
    });
  });

  it("replaces the heavyweight initialization matrix with a focused local contract", () => {
    expect(selectChangedTestInputs([
      "packages/cli/src/commands/refresh.ts",
      "packages/cli/test/init.test.ts"
    ])).toEqual({
      directTests: ["packages/cli/test/project-detection.test.ts"],
      relatedSources: [],
      deferredTests: ["packages/cli/test/init.test.ts"],
      pythonTests: []
    });
  });

  it("keeps sync release changes on focused contracts instead of the full Core graph", () => {
    expect(selectChangedTestInputs([
      "packages/cli/src/commands/sync.ts",
      "packages/cli/src/sync/codegraph-status.ts",
      "packages/cli/src/sync/git-delta.ts",
      "packages/core/src/instructions/graph.ts",
      "scripts/sync-harness.mjs"
    ])).toEqual({
      directTests: [
        "packages/cli/test/codegraph-status.test.ts",
        "packages/cli/test/git-delta.test.ts",
        "packages/cli/test/sync-command.test.ts",
        "packages/cli/test/sync-harness-closure.test.ts",
        "packages/cli/test/sync-harness.test.ts",
        "packages/cli/test/sync-process.test.ts",
        "packages/core/test/instruction-graph.test.ts"
      ],
      relatedSources: [],
      deferredTests: [],
      pythonTests: []
    });
  });

  it("keeps push and recovery releases on explicit focused contracts", () => {
    expect(selectChangedTestInputs([
      "packages/cli/src/commands/instructions.ts",
      "packages/cli/src/commands/push.ts",
      "packages/cli/src/commands/rules-review.ts",
      "packages/core/src/push/push.ts",
      "packages/core/src/sync/synchronize.ts",
      "packages/core/src/transaction/recovery-store.ts"
    ])).toEqual({
      directTests: [
        "packages/cli/test/instructions.test.ts",
        "packages/cli/test/push.test.ts",
        "packages/cli/test/rules-review.test.ts",
        "packages/core/test/artifact-rebase.test.ts",
        "packages/core/test/push-archive-summary.test.ts",
        "packages/core/test/push-scan.test.ts",
        "packages/core/test/push-stale.test.ts",
        "packages/core/test/recovery-v3.test.ts",
        "packages/core/test/recovery.test.ts",
        "packages/core/test/transaction.test.ts",
        "packages/core/test/update-auth.test.ts"
      ],
      relatedSources: [],
      deferredTests: [],
      pythonTests: []
    });
  });

  it("runs changed Python lifecycle contracts through focused unittest modules", () => {
    expect(selectChangedTestInputs([
      "harness/scripts/harness_archive.py",
      "harness/scripts/harness_context.py",
      "harness/scripts/tests/test_harness_archive_remote.py"
    ])).toEqual({
      directTests: [],
      relatedSources: [],
      deferredTests: [],
      pythonTests: [
        "harness/scripts/tests/test_harness_archive.py",
        "harness/scripts/tests/test_harness_archive_c.py",
        "harness/scripts/tests/test_harness_archive_preflight.py",
        "harness/scripts/tests/test_harness_archive_remote.py",
        "harness/scripts/tests/test_harness_context.py"
      ]
    });
  });
});
