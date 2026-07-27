import { defineConfig, devices } from "@playwright/test";
import { randomBytes } from "node:crypto";
import path from "node:path";

const appPort = Number(process.env.PLAYWRIGHT_APP_PORT ?? "3100");
const appUrl = `http://127.0.0.1:${appPort}`;
process.env.PLAYWRIGHT_APP_PASSWORD ??= randomBytes(32).toString(
  "base64url",
);
process.env.PLAYWRIGHT_APP_SECRET ??= randomBytes(48).toString(
  "base64url",
);
const adminAuthState = path.join(
  process.cwd(),
  "test-results",
  ".auth",
  "admin.json",
);
const e2eServerCommand =
  process.env.PLAYWRIGHT_SKIP_CONSOLE_BUILD === "1"
    ? "npm exec -- next build && node scripts/run-e2e-app.mjs"
    : "npm run build && node scripts/run-e2e-app.mjs";

export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore: /chat-scroll\.spec\.ts/,
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: appUrl,
    trace: "on-first-retry",
  },
  webServer: {
    command: e2eServerCommand,
    url: appUrl,
    reuseExistingServer: false,
    timeout: 240_000,
  },
  projects: [
    {
      name: "setup",
      testMatch: "**/*.setup.ts",
    },
    {
      name: "Desktop Chrome",
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: adminAuthState,
      },
    },
    {
      name: "iPad Mini",
      testMatch: [
        "**/admin-console-preview.spec.ts",
        "**/admin-console-pages.spec.ts",
        "**/admin-console.visual.spec.ts",
      ],
      dependencies: ["setup"],
      use: {
        ...devices["iPad Mini"],
        browserName: "chromium",
        storageState: adminAuthState,
      },
    },
    {
      name: "Mobile Chrome",
      testMatch: [
        "**/admin-console-preview.spec.ts",
        "**/admin-console-pages.spec.ts",
        "**/admin-console.visual.spec.ts",
      ],
      dependencies: ["setup"],
      use: {
        ...devices["Pixel 5"],
        storageState: adminAuthState,
      },
    },
  ],
});
