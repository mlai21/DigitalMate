import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "public/_admin-console/**",
    "vendor/qwenpaw-console/**",
    // 与 tsconfig 的 exclude 保持一致：worktree 内含各分支的构建产物
    ".worktrees/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
