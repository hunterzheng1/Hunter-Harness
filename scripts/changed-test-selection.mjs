const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const PYTHON_TEST_FILE_PATTERN = /^harness\/scripts\/tests\/test_.+\.py$/;
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
    "packages/cli/src/commands/instructions.ts",
    ["packages/cli/test/instructions.test.ts"]
  ],
  [
    "packages/cli/src/commands/push.ts",
    ["packages/cli/test/push.test.ts"]
  ],
  [
    "packages/cli/src/commands/rules-review.ts",
    ["packages/cli/test/rules-review.test.ts"]
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
    "packages/core/src/push/push.ts",
    [
      "packages/core/test/push-archive-summary.test.ts",
      "packages/core/test/push-scan.test.ts",
      "packages/core/test/push-stale.test.ts"
    ]
  ],
  [
    "packages/core/src/sync/synchronize.ts",
    [
      "packages/core/test/artifact-rebase.test.ts",
      "packages/core/test/push-stale.test.ts",
      "packages/core/test/update-auth.test.ts"
    ]
  ],
  [
    "packages/core/src/transaction/recovery-store.ts",
    [
      "packages/core/test/recovery-v3.test.ts",
      "packages/core/test/recovery.test.ts",
      "packages/core/test/transaction.test.ts"
    ]
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

const PYTHON_TESTS_BY_PATH = new Map([
  [
    "harness/scripts/harness_archive.py",
    [
      "harness/scripts/tests/test_harness_archive.py",
      "harness/scripts/tests/test_harness_archive_c.py",
      "harness/scripts/tests/test_harness_archive_preflight.py",
      "harness/scripts/tests/test_harness_archive_remote.py"
    ]
  ],
  [
    "harness/scripts/harness_context.py",
    ["harness/scripts/tests/test_harness_context.py"]
  ],
  [
    "harness/scripts/harness_gate.py",
    [
      "harness/scripts/tests/test_harness_gate.py",
      "harness/scripts/tests/test_harness_gate_severity.py"
    ]
  ],
  [
    "harness/scripts/harness_ledger.py",
    [
      "harness/scripts/tests/test_harness_ledger.py",
      "harness/scripts/tests/test_harness_ledger_targets.py",
      "harness/scripts/tests/test_harness_ledger_v3.py"
    ]
  ],
  [
    "harness/scripts/harness_runtime.py",
    ["harness/scripts/tests/test_harness_runtime.py"]
  ]
]);

export function selectChangedTestInputs(paths) {
  const directTests = new Set();
  const relatedSources = new Set();
  const deferredTests = new Set();
  const pythonTests = new Set();
  const normalizedPaths = new Set(
    paths.map((path) => path.replaceAll("\\", "/").trim()).filter(Boolean)
  );

  for (const path of normalizedPaths) {
    for (const pythonTest of PYTHON_TESTS_BY_PATH.get(path) ?? []) {
      pythonTests.add(pythonTest);
    }

    if (PYTHON_TEST_FILE_PATTERN.test(path)) {
      pythonTests.add(path);
      continue;
    }

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
    deferredTests: [...deferredTests].sort(),
    pythonTests: [...pythonTests].sort()
  };
}
