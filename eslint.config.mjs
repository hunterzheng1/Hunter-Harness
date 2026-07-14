import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/coverage/**",
      "requirements/**",
      // gitignored 本机目录（AI 工具 / harness 本地件），非仓库代码，不参与 lint
      ".claude/**",
      ".cursor/**",
      ".harness/**",
      ".codegraph/**",
      // canonical Harness 源（Python/Markdown 为主，辅助 .mjs 不受 TS lint 约束）
      "harness/**",
      // 生成 Bundle 与复制产物（harness_deploy.py 输出，字节一致，不应 lint）
      "resources/**",
      "packages/cli/resources/**",
      "packages/workflow-data-harness/harness/**",
      // sync-harness.mjs 临时 staging（harness 副本，atomicSwapDir 后应清理，残留不 lint）
      ".sync-staging/**",
      "packages/core/test/fixtures/**"
    ]
  },
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-confusing-void-expression": "off"
    }
  }
);
