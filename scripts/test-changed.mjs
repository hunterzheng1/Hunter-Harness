import { spawnSync } from "node:child_process";
import console from "node:console";
import { basename, delimiter } from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

import { selectChangedTestInputs } from "./changed-test-selection.mjs";

const defaultBase = "origin/main";
const requestedBase = process.argv[2]?.trim();
const environmentBase = process.env.HUNTER_RELEASE_BASE?.trim();
const base = requestedBase || environmentBase || defaultBase;
const vitestEntry = fileURLToPath(
  new URL("../node_modules/vitest/vitest.mjs", import.meta.url)
);

console.log(`运行受改动影响的测试（比较基准：${base}）`);

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const pythonTestRoot = fileURLToPath(
  new URL("../harness/scripts/tests/", import.meta.url)
);

function run(
  command,
  args,
  { allowFailure = false, cwd = rootDir, env = process.env } = {}
) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env,
    stdio: allowFailure ? "pipe" : "inherit"
  });
  if (result.error) {
    throw result.error;
  }
  if (!allowFailure && result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  return result;
}

function gitPaths(args) {
  const result = run("git", args, { allowFailure: true });
  if (result.status !== 0) {
    const details = result.stderr?.trim() || result.stdout?.trim();
    throw new Error(details || `git ${args.join(" ")} 执行失败`);
  }
  return (result.stdout ?? "").split("\0").filter(Boolean);
}

function collectChangedPaths() {
  const baseCheck = run(
    "git",
    ["rev-parse", "--verify", "--quiet", `${base}^{commit}`],
    { allowFailure: true }
  );
  if (baseCheck.status !== 0) {
    throw new Error(`找不到比较基准 ${base}，可通过参数或 HUNTER_RELEASE_BASE 指定`);
  }

  return [
    ...gitPaths([
      "diff",
      "--name-only",
      "--diff-filter=ACMR",
      "-z",
      `${base}...HEAD`,
      "--"
    ]),
    ...gitPaths([
      "diff",
      "--name-only",
      "--diff-filter=ACMR",
      "-z",
      "--"
    ]),
    ...gitPaths([
      "diff",
      "--cached",
      "--name-only",
      "--diff-filter=ACMR",
      "-z",
      "--"
    ]),
    ...gitPaths(["ls-files", "--others", "--exclude-standard", "-z"])
  ];
}

function runVitest(args) {
  run(process.execPath, [
    vitestEntry,
    ...args,
    "--run",
    "--passWithNoTests",
    "--maxWorkers=2"
  ]);
}

function runPythonTests(paths) {
  const modules = paths.map((path) => basename(path, ".py"));
  run(process.env.HUNTER_HARNESS_PYTHON || "python", [
    "-m",
    "unittest",
    ...modules
  ], {
    cwd: pythonTestRoot,
    env: {
      ...process.env,
      PYTHONPATH: [rootDir, pythonTestRoot, process.env.PYTHONPATH]
        .filter(Boolean)
        .join(delimiter)
    }
  });
}

try {
  const changedPaths = collectChangedPaths();
  const { directTests, relatedSources, deferredTests, pythonTests } = selectChangedTestInputs(changedPaths);
  console.log(
    `检测到 ${new Set(changedPaths).size} 个改动文件；` +
      `直接测试 ${directTests.length} 个，关联源码 ${relatedSources.length} 个，` +
      `Python 聚焦测试 ${pythonTests.length} 个，CI 完整矩阵 ${deferredTests.length} 个`
  );

  if (deferredTests.length > 0) {
    console.log(
      `以下重型测试的完整矩阵交由 CI：${deferredTests.join(", ")}`
    );
  }

  if (directTests.length > 0) {
    runVitest(["run", ...directTests]);
  }
  if (relatedSources.length > 0) {
    runVitest(["related", ...relatedSources]);
  }
  if (pythonTests.length > 0) {
    runPythonTests(pythonTests);
  }
  if (directTests.length === 0 && relatedSources.length === 0 && pythonTests.length === 0) {
    console.log("未发现需要本地执行的关联测试；完整回归将由 CI 承担。");
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`增量测试准备失败：${message}`);
  process.exitCode = 1;
}
