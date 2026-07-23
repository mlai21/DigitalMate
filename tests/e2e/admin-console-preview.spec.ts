import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { QWENPAW_CONSOLE_ROUTE_BASELINES } from "./admin-console.routes";

async function expectConsoleReady(page: Page) {
  await expect(page.locator("#root")).toBeVisible();
  await expect(page.locator("#root .qwenpaw-layout").first()).toBeVisible({
    timeout: 30_000,
  });
}

async function expectConsolePage(
  page: Page,
  baseline: (typeof QWENPAW_CONSOLE_ROUTE_BASELINES)[number],
  expectedPath: string = baseline.expectedPath,
) {
  await expectConsoleReady(page);
  await expect(page).toHaveURL(`/admin-preview${expectedPath}`);
  const pageContent = page.locator(".page-content");
  await expect(pageContent).toHaveAttribute(
    "data-console-route",
    baseline.routeId,
  );
  await expect(pageContent).not.toBeEmpty();
  await expect(pageContent).toContainText(baseline.marker);
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

for (const baseline of QWENPAW_CONSOLE_ROUTE_BASELINES) {
  test(`Console 深层刷新 ${baseline.route}`, async ({ page }) => {
    await page.goto(`/admin-preview${baseline.route}`);

    await expectConsolePage(page, baseline);
    await expect(page).not.toHaveURL(/\/login(?:[/?#]|$)/);
    await expect(page.locator("body")).not.toContainText("QwenPaw");

    if ("caseInsensitivePath" in baseline) {
      await page.goto(`/admin-preview${baseline.caseInsensitivePath}`);
      await expectConsolePage(page, baseline, baseline.caseInsensitivePath);
    }
  });
}

test("Chat 入口只跳转 DigitalMate 首页", async ({ page }) => {
  await page.goto("/admin-preview/chat");
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("textbox", { name: "输入消息" })).toBeVisible();

  await page.goto("/admin-preview/inbox");
  await expectConsoleReady(page);
  await page.getByRole("button", { name: /Chat|聊天/ }).click();
  await expect(page).toHaveURL("/");
});

test("未知路由不会满足任何注册页面基线", async ({ page }) => {
  await page.goto("/admin-preview/__unknown-route__");

  await expectConsoleReady(page);
  await expect(page).toHaveURL("/admin-preview/__unknown-route__");
  const pageContent = page.locator(".page-content");
  await expect(pageContent).toHaveAttribute("data-console-route", "core.chat");
  await expect(pageContent).toBeEmpty();
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
