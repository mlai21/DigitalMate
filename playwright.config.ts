import { defineConfig, devices } from "@playwright/test";

const appPort = Number(process.env.PLAYWRIGHT_APP_PORT ?? "3100");
const appUrl = `http://127.0.0.1:${appPort}`;

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
    command: "node scripts/run-e2e-app.mjs",
    url: appUrl,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
