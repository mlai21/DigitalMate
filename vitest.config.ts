import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "jsdom",
    env: {
      TZ: "Asia/Shanghai",
    },
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    exclude: ["node_modules/**", "tests/e2e/**"],
  },
});
