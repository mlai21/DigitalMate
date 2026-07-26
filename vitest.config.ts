import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    // Several suites start isolated embedded PostgreSQL instances. Bounding
    // workers prevents host shared-memory exhaustion without skipping PG tests.
    maxWorkers: 4,
    environment: "jsdom",
    env: {
      TZ: "Asia/Shanghai",
    },
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    exclude: [
      "**/node_modules/**",
      "tests/e2e/**",
      ".worktrees/**",
      "vendor/**",
      "patches/**",
      ".generated/**",
      "public/_admin-console/**",
    ],
  },
});
