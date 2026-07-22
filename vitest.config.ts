import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// I/O 密集型集成测试：每个用例都真实部署 14MB/718 文件 harness bundle。
// 当某测试文件单文件耗时 > 60s 或在 30s testTimeout 下 flaky 超时时，加入此列表。
const integrationTestFiles = [
  "packages/cli/test/**/*.test.ts",
  "packages/core/test/refresh.test.ts",
  "packages/core/test/initialize.test.ts",
  "packages/core/test/freshness.test.ts",
  "packages/core/test/bundle-content-projection.test.ts",
  "packages/core/test/agent-adapters.test.ts"
];

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
            "apps/**/*.test.ts",
            "apps/**/*.test.tsx",
            "tests/**/*.test.ts"
          ],
          exclude: integrationTestFiles
        }
      },
      {
        extends: true,
        test: {
          name: "integration",
          testTimeout: 120000,
          hookTimeout: 120000,
          include: integrationTestFiles
        }
      }
    ]
  }
});
