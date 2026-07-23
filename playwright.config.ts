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
    command: "npm run console:build && node scripts/run-e2e-app.mjs",
    url: appUrl,
    reuseExistingServer: false,
    timeout: 240_000,
  },
  projects: [
    {
      name: "Desktop Chrome",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "iPad Mini",
      use: { ...devices["iPad Mini"], browserName: "chromium" },
    },
    {
      name: "Mobile Chrome",
      use: { ...devices["Pixel 5"] },
    },
  ],
});
