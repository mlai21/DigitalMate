import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test as setup } from "@playwright/test";

export const ADMIN_AUTH_STATE = path.join(
  process.env.PLAYWRIGHT_AUTH_STATE_PATH
    ?? path.join(
      process.cwd(),
      "test-results",
      ".auth",
      "admin.json",
    ),
);

setup("建立共享管理后台会话", async ({ page }) => {
  const adminPassword = process.env.PLAYWRIGHT_APP_PASSWORD;
  if (!adminPassword) {
    throw new Error("PLAYWRIGHT_APP_PASSWORD is required");
  }

  const loginResponse = await page.request.post("/api/login", {
    form: {
      password: adminPassword,
    },
  });
  expect(loginResponse.ok()).toBe(true);

  await mkdir(path.dirname(ADMIN_AUTH_STATE), { recursive: true });
  await page.context().storageState({ path: ADMIN_AUTH_STATE });
});
