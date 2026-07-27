import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { QWENPAW_CONSOLE_ROUTE_BASELINES } from "./admin-console.routes";

const AGENT_ID = "00000000-0000-4000-8000-000000000011";

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
  await page.addInitScript(({ agentId }) => {
    localStorage.setItem("language", "zh");
    localStorage.setItem("qwenpaw-theme", "light");
    localStorage.setItem(
      "qwenpaw-agent-storage",
      JSON.stringify({
        state: {
          selectedAgent: agentId,
          agents: [
            {
              id: agentId,
              name: "DigitalMate",
              is_default: true,
              enabled: true,
            },
          ],
          lastChatIdByAgent: {},
        },
        version: 0,
      }),
    );
  }, { agentId: AGENT_ID });
  await page.route("**/api/admin/compat/auth/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        csrf_token: "admin-console-e2e",
      }),
    });
  });
  await page.route("**/api/admin/compat/models**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/models/active")) {
      await route.fulfill({
        contentType: "application/json",
        body: "{}",
      });
      return;
    }
    if (pathname.endsWith("/models")) {
      await route.fulfill({
        contentType: "application/json",
        body: "[]",
      });
      return;
    }
    await route.continue();
  });
  await page.route(
    "**/api/admin/compat/frontend_plugin",
    async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: "[]",
      });
    },
  );
});

for (const baseline of QWENPAW_CONSOLE_ROUTE_BASELINES) {
  test(`Console 深层刷新 ${baseline.route}`, async ({ page }) => {
    await page.goto(`/admin-preview${baseline.route}`);

    await expectConsolePage(page, baseline);
    await expect(page).not.toHaveURL(/\/login(?:[/?#]|$)/);
    await expectProductBrandIsDigitalMate(page);

    if (baseline.route === "/plugin-manager") {
      const license = page.getByTestId("upstream-license");
      await expect(license).toContainText(
        "QwenPaw v2.0.0.post3",
      );
      await expect(license).toContainText("fef7e64d");
      await expect(license).toContainText("Apache-2.0");
      await expect(
        license.getByRole("link", {
          name: "查看来源与第三方许可",
        }),
      ).toHaveAttribute(
        "href",
        /github\.com\/agentscope-ai\/QwenPaw\/tree\/fef7e64d/,
      );
    }

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

test("正式 /admin 默认回退旧后台，旧后台也可直接访问", async ({ page }) => {
  await page.goto("/admin");

  await expect(page.locator(".admin-shell")).toBeVisible();
  await expect(page.getByRole("heading", { name: "管理后台" })).toBeVisible();
  await expect(page).toHaveURL("/admin-legacy");
  await expect(
    page.getByRole("link", { name: "返回新控制台" }),
  ).toHaveAttribute("href", "/admin");

  await page.goto("/admin-legacy/interjections");
  await expect(page.locator(".admin-shell")).toBeVisible();
  await expect(page).toHaveURL("/admin-legacy/interjections");
});

test("Console 结构截图保持稳定", async ({ page }) => {
  await page.goto("/admin-preview/inbox");
  await expectConsoleReady(page);
  await expect(page.locator(".page-content")).toContainText("收件箱");
  await page
    .waitForLoadState("networkidle", { timeout: 5_000 })
    .catch(() => undefined);
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
      .ant-badge-status-dot,
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

async function expectProductBrandIsDigitalMate(page: Page) {
  const textOutsideLicense = await page.locator("body").evaluate((body) => {
    const copy = body.cloneNode(true) as HTMLElement;
    copy
      .querySelectorAll('[data-testid="upstream-license"]')
      .forEach((node) => node.remove());
    return copy.innerText;
  });

  expect(textOutsideLicense).not.toContain("QwenPaw");
}
