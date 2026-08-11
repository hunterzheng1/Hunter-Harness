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
      deferredTests: []
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
      deferredTests: []
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
      deferredTests: []
    });
  });

  it("maps release selector changes back to their contract tests", () => {
    expect(selectChangedTestInputs(["scripts/test-changed.mjs"])).toEqual({
      directTests: [
        "tests/changed-test-selection.test.ts",
        "tests/release-pipeline.test.ts"
      ],
      relatedSources: [],
      deferredTests: []
    });
  });

  it("replaces the heavyweight initialization matrix with a focused local contract", () => {
    expect(selectChangedTestInputs([
      "packages/cli/src/commands/refresh.ts",
      "packages/cli/test/init.test.ts"
    ])).toEqual({
      directTests: ["packages/cli/test/project-detection.test.ts"],
      relatedSources: [],
      deferredTests: ["packages/cli/test/init.test.ts"]
    });
  });
});
