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
      ".harness/**",
      ".codegraph/**"
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
