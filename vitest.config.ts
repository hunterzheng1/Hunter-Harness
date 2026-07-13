import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

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
    testTimeout: 30000,
    hookTimeout: 30000,
    // 四 Agent 初始化等 I/O 重测试在高并行下易互相拖垮超时（Windows pre-push 尤甚）
    maxWorkers: 2,
    include: [
      "packages/**/*.test.ts",
      "apps/**/*.test.ts",
      "apps/**/*.test.tsx",
      "tests/**/*.test.ts"
    ],
    coverage: {
      reporter: ["text", "json", "html"]
    }
  }
});
