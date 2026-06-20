import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "packages/**/*.test.ts",
      "apps/**/*.test.ts",
      "tests/**/*.test.ts"
    ],
    coverage: {
      reporter: ["text", "json", "html"]
    }
  }
});
