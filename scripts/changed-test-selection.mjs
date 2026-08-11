const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const RELATED_SOURCE_PATTERN =
  /^(?:packages\/[^/]+\/src|scripts)\/.+\.[cm]?[jt]sx?$/;
const GENERATED_PATH_PATTERN = /(?:^|\/)(?:dist|coverage|resources)\//;
const CI_ONLY_TEST_FILES = new Set([
  "packages/cli/test/init.test.ts"
]);

const CONTRACT_TESTS_BY_PATH = new Map([
  [".github/workflows/check.yml", ["tests/release-pipeline.test.ts"]],
  ["package.json", ["tests/release-pipeline.test.ts"]],
  [
    "packages/cli/src/commands/refresh.ts",
    ["packages/cli/test/project-detection.test.ts"]
  ],
  [
    "packages/cli/src/commands/sync.ts",
    [
      "packages/cli/test/sync-command.test.ts",
      "packages/cli/test/sync-process.test.ts"
    ]
  ],
  [
    "packages/cli/src/sync/codegraph-status.ts",
    ["packages/cli/test/codegraph-status.test.ts"]
  ],
  [
    "packages/cli/src/sync/git-delta.ts",
    ["packages/cli/test/git-delta.test.ts"]
  ],
  [
    "packages/core/src/instructions/graph.ts",
    ["packages/core/test/instruction-graph.test.ts"]
  ],
  [
    "scripts/sync-harness.mjs",
    [
      "packages/cli/test/sync-harness-closure.test.ts",
      "packages/cli/test/sync-harness.test.ts"
    ]
  ],
  [
    "scripts/changed-test-selection.mjs",
    [
      "tests/changed-test-selection.test.ts",
      "tests/release-pipeline.test.ts"
    ]
  ],
  [
    "scripts/test-changed.mjs",
    [
      "tests/changed-test-selection.test.ts",
      "tests/release-pipeline.test.ts"
    ]
  ]
]);

export function selectChangedTestInputs(paths) {
  const directTests = new Set();
  const relatedSources = new Set();
  const deferredTests = new Set();
  const normalizedPaths = new Set(
    paths.map((path) => path.replaceAll("\\", "/").trim()).filter(Boolean)
  );

  for (const path of normalizedPaths) {
    for (const contractTest of CONTRACT_TESTS_BY_PATH.get(path) ?? []) {
      directTests.add(contractTest);
    }

    if (TEST_FILE_PATTERN.test(path)) {
      if (CI_ONLY_TEST_FILES.has(path)) {
        deferredTests.add(path);
      } else {
        directTests.add(path);
      }
      continue;
    }
    if (
      !CONTRACT_TESTS_BY_PATH.has(path) &&
      !GENERATED_PATH_PATTERN.test(path) &&
      RELATED_SOURCE_PATTERN.test(path)
    ) {
      relatedSources.add(path);
    }
  }

  return {
    directTests: [...directTests].sort(),
    relatedSources: [...relatedSources].sort(),
    deferredTests: [...deferredTests].sort()
  };
}
