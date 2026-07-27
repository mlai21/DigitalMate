import { defineConfig, devices } from "@playwright/test";
import { randomBytes } from "node:crypto";
import path from "node:path";

const appPort = Number(
  process.env.PLAYWRIGHT_ADMIN_CUTOVER_PORT ?? "3102",
);
const appUrl = `http://127.0.0.1:${appPort}`;
const appPassword =
  process.env.PLAYWRIGHT_APP_PASSWORD
  ?? randomBytes(32).toString("base64url");
const appSecret =
  process.env.PLAYWRIGHT_APP_SECRET
  ?? randomBytes(48).toString("base64url");
const adminAuthState = path.join(
  process.cwd(),
  "test-results",
  ".auth",
  "admin-cutover.json",
);
const e2eServerCommand =
  process.env.PLAYWRIGHT_SKIP_CONSOLE_BUILD === "1"
    ? "npm exec -- next build && node scripts/run-e2e-app.mjs"
    : "npm run build && node scripts/run-e2e-app.mjs";

process.env.PLAYWRIGHT_APP_PASSWORD = appPassword;
process.env.PLAYWRIGHT_APP_SECRET = appSecret;
process.env.PLAYWRIGHT_APP_PORT = String(appPort);
process.env.PLAYWRIGHT_AUTH_STATE_PATH = adminAuthState;

export default defineConfig({
  testDir: "./tests/e2e",
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
    env: {
      ADMIN_CONSOLE_ENABLED: "1",
      PLAYWRIGHT_APP_PASSWORD: appPassword,
      PLAYWRIGHT_APP_SECRET: appSecret,
      PLAYWRIGHT_APP_PORT: String(appPort),
      PLAYWRIGHT_AUTH_STATE_PATH: adminAuthState,
    },
  },
  projects: [
    {
      name: "setup",
      testMatch: "**/admin-auth.setup.ts",
    },
    {
      name: "Desktop Chrome",
      testMatch: "**/admin-console-cutover.spec.ts",
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: adminAuthState,
      },
    },
  ],
});
