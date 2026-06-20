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
