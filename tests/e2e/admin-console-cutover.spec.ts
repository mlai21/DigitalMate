import { expect, test } from "@playwright/test";

const AGENT_ID = "00000000-0000-4000-8000-000000000011";

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
  await page.route(
    "**/api/admin/compat/auth/status",
    async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          authenticated: true,
          csrf_token: "admin-console-cutover-e2e",
        }),
      });
    },
  );
});

test("开关开启后正式 /admin 深层路由服务 Console，Chat 返回首页", async ({
  page,
}) => {
  await page.goto("/admin/inbox");

  await expect(page).toHaveURL("/admin/inbox");
  await expect(
    page.locator("#root .qwenpaw-layout").first(),
  ).toBeVisible();
  await expect(page.locator(".page-content")).toHaveAttribute(
    "data-console-route",
    "core.inbox",
  );
  await expect(page.locator(".page-content")).toContainText("收件箱");

  await page.getByRole("button", { name: /Chat|聊天/ }).click();
  await expect(page).toHaveURL("/");
  await expect(
    page.getByRole("textbox", { name: "输入消息" }),
  ).toBeVisible();
});

test("开关开启后未登录请求保留正式路径和查询参数", async ({ page }) => {
  await page.context().clearCookies();
  await page.goto("/admin/settings?tab=models");

  await expect(page).toHaveURL(
    "/login?redirect=%2Fadmin%2Fsettings%3Ftab%3Dmodels",
  );
  await expect(
    page.getByRole("heading", { name: "欢迎回来" }),
  ).toBeVisible();
});

test("开关开启时旧后台仍可直接访问", async ({ page }) => {
  await page.goto("/admin-legacy/interjections");

  await expect(page).toHaveURL("/admin-legacy/interjections");
  await expect(page.locator(".admin-shell")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "插话决策" }),
  ).toHaveClass(/active/);
  await expect(page.locator(".admin-content")).toContainText(
    "还没有群聊插话决策。",
  );

  await page.context().clearCookies();
  await page.reload();
  await expect(page.locator(".admin-content")).toContainText(
    "需要登录后查看插话决策。",
  );
  await expect(page.locator(".admin-content")).not.toContainText(
    "还没有群聊插话决策。",
  );
});
