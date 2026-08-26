import process from "node:process";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import { CI_ONLY_TEST_FILES } from "./scripts/changed-test-selection.mjs";

// I/O 密集型集成测试：每个用例都真实部署 14MB/718 文件 harness bundle。
// 当某测试文件单文件耗时 > 60s 或在 30s testTimeout 下 flaky 超时时，加入此列表。
// push-stale/update-auth/push-scan/guarded-project-plan 等文件会真实起 HTTP 服务并
// 走完整事务，Windows 单文件常超 60s；migration/plan-durable/recovery-v3 重建或
// 遍历整套 bundle，单用例常态 > 30s。它们在 fast 项目（30s）下必现超时假失败。
const integrationTestFiles = [
  "packages/cli/test/**/*.test.ts",
  "packages/core/test/refresh.test.ts",
  "packages/core/test/initialize.test.ts",
  "packages/core/test/freshness.test.ts",
  "packages/core/test/bundle-content-projection.test.ts",
  "packages/core/test/agent-adapters.test.ts",
  "packages/core/test/migration.test.ts",
  "packages/core/test/push-stale.test.ts",
  "packages/core/test/update-auth.test.ts",
  "packages/core/test/push-scan.test.ts",
  "packages/core/test/guarded-project-plan.test.ts",
  "packages/core/test/plan-durable-publication-filesystem-contract.test.ts",
  "packages/core/test/recovery-v3.test.ts",
  "packages/core/test/managed-block-refresh.test.ts"
];

// CI_ONLY 清单里的文件本地默认不跑：它们每用例重建整套 bundle，两个文件就占掉
// 本地增量测试约七成墙钟。仅在选择器里 defer 拦不住 `vitest related` 的传递命中，
// 所以在 project 级 exclude 里兜底。CI 上照跑完整矩阵；本地要跑全量走：
//   $env:HUNTER_TEST_INCLUDE_CI_ONLY=1; npm test
const includeCiOnlyTests = Boolean(
  process.env.CI || process.env.HUNTER_TEST_INCLUDE_CI_ONLY
);
const locallySkippedTestFiles = includeCiOnlyTests ? [] : CI_ONLY_TEST_FILES;

export default defineConfig({
  oxc: {
    jsx: {
      runtime: "automatic"
    }
  },
  resolve: {
    alias: {
      "@hunter-harness/contracts": fileURLToPath(
        new URL("./packages/contracts/src/index.ts", import.meta.url)
      ),
      "@hunter-harness/core": fileURLToPath(
        new URL("./packages/core/src/index.ts", import.meta.url)
      )
    }
  },
  test: {
    environment: "node",
    // 避免本机/会话里残留的 DEMO=true 让 web 组件走 mockApi，掩盖对 browserApi 的断言
    env: {
      NEXT_PUBLIC_HUNTER_HARNESS_DEMO: ""
    },
    // 统一临时目录并在运行结束后整树清理，防止 hunter-* fixture 泄漏到系统 Temp
    globalSetup: ["./tests/setup/global-temp.ts"],
    // 四 Agent 初始化等 I/O 重测试在高并行下易互相拖垮超时（Windows pre-push 尤甚）
    maxWorkers: 2,
    coverage: {
      reporter: ["text", "json", "html"]
    },
    projects: [
      {
        extends: true,
        test: {
          name: "fast",
          testTimeout: 30000,
          hookTimeout: 30000,
          include: [
            "packages/**/*.test.ts",
            "tests/**/*.test.ts"
          ],
          exclude: [...integrationTestFiles, ...locallySkippedTestFiles]
        }
      },
      {
        extends: true,
        test: {
          name: "integration",
          testTimeout: 120000,
          hookTimeout: 120000,
          include: integrationTestFiles,
          exclude: locallySkippedTestFiles
        }
      }
    ]
  }
});
