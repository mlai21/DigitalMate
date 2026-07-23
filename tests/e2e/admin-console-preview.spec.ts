import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { QWENPAW_BUILTIN_ROUTES } from "./admin-console.routes";

const CONSOLE_ROUTES = QWENPAW_BUILTIN_ROUTES.filter(
  (route) => route !== "/chat",
);

async function expectConsoleReady(page: Page) {
  await expect(page.locator("#root")).toBeVisible();
  await expect(page.locator("#root .qwenpaw-layout").first()).toBeVisible({
    timeout: 30_000,
  });
}

test.beforeEach(async ({ page }) => {
  const loginResponse = await page.request.post("/api/login", {
    form: { password: "" },
  });
  expect(loginResponse.ok()).toBe(true);

  await page.addInitScript(() => {
    localStorage.setItem("language", "zh");
    localStorage.setItem("qwenpaw-theme", "light");
  });
  await page.route("**/api/admin/compat/auth/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        csrf_token: "admin-console-e2e",
      }),
    });
  });
});

for (const route of CONSOLE_ROUTES) {
  test(`Console 深层刷新 ${route}`, async ({ page }) => {
    await page.goto(`/admin-preview${route}`);

    await expectConsoleReady(page);
    await expect(page).not.toHaveURL(/\/login(?:[/?#]|$)/);
  });
}

test("Chat 入口只跳转 DigitalMate 首页", async ({ page }, testInfo) => {
  await page.goto("/admin-preview/chat");
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("textbox", { name: "输入消息" })).toBeVisible();

  if (testInfo.project.name === "Desktop Chrome") {
    await page.goto("/admin-preview/inbox");
    await expectConsoleReady(page);
    await page.getByRole("button", { name: /Chat|聊天/ }).click();
    await expect(page).toHaveURL("/");
  }
});

test("Console 使用 DigitalMate 珊瑚色与暖白背景", async ({ page }) => {
  await page.goto("/admin-preview/inbox");
  await expectConsoleReady(page);
  await expect(page.locator(".page-content")).toContainText("收件箱");

  const theme = await page.evaluate(() => {
    const layout = document.querySelector<HTMLElement>(".qwenpaw-layout");
    if (!layout) throw new Error("Console layout is missing");
    return {
      primary: getComputedStyle(document.documentElement)
        .getPropertyValue("--dm-color-primary")
        .trim(),
      background: getComputedStyle(layout).backgroundColor,
    };
  });

  expect(theme.primary.toUpperCase()).toBe("#E8684A");
  expect(theme.background).toBe("rgb(250, 247, 242)");
});

test("旧 /admin 仍由现有 Next 页面提供", async ({ page }) => {
  await page.goto("/admin");

  await expect(page.locator(".admin-shell")).toBeVisible();
  await expect(page.getByRole("heading", { name: "管理后台" })).toBeVisible();
  await expect(page).toHaveURL("/admin");
});

test("Console 结构截图保持稳定", async ({ page }) => {
  await page.goto("/admin-preview/inbox");
  await expectConsoleReady(page);
  await expect(page.locator(".page-content")).toContainText("收件箱");
  await page.addStyleTag({
    content: `
      *,
      *::before,
      *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition: none !important;
        caret-color: transparent !important;
      }
      time,
      [data-testid*="time"],
      [data-testid*="random"],
      [class*="timestamp"],
      [class*="connectionStatus"],
      [class*="statusDot"],
      [class*="agentStatus"],
      .qwenpaw-message,
      .qwenpaw-notification {
        visibility: hidden !important;
      }
    `,
  });

  await expect(page).toHaveScreenshot("admin-console-inbox.png", {
    animations: "disabled",
    caret: "hide",
    fullPage: true,
  });
});
