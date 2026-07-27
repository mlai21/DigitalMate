import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import { DIGITALMATE_ADMIN_ROUTE_BASELINES } from "./admin-console.routes";

const AGENT_ID = "00000000-0000-4000-8000-000000000011";
const VISUAL_BASELINE_PLATFORM = "darwin";

const VISUAL_ROUTES = [
  ...DIGITALMATE_ADMIN_ROUTE_BASELINES,
  {
    route: "/chat",
    expectedPath: "/",
    routeId: "digitalmate.home",
    marker: "输入消息",
  },
] as const;

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
      await json(route, {
        authenticated: true,
        csrf_token: "admin-console-visual",
        csrf_expires_at:
          Math.floor(Date.now() / 1_000) + 3_600,
      });
    },
  );
  await installVisualMocks(page);
});

expect(VISUAL_ROUTES).toHaveLength(30);

test.beforeAll(() => {
  if (process.platform !== VISUAL_BASELINE_PLATFORM) {
    throw new Error(
      `Console 视觉基线固定在 ${VISUAL_BASELINE_PLATFORM}；当前平台 ${process.platform} 不得复用该像素基线。`,
    );
  }
});

for (const baseline of VISUAL_ROUTES) {
  test(`视觉基线 ${baseline.route}`, async ({ page }) => {
    await page.goto(`/admin-preview${baseline.route}`);

    if (baseline.route === "/chat") {
      await expect(page).toHaveURL("/");
      await expect(
        page.getByRole("textbox", { name: baseline.marker }),
      ).toBeVisible();
    } else {
      await expect(
        page.locator("#root .qwenpaw-layout").first(),
      ).toBeVisible({ timeout: 30_000 });
      await expect(page).toHaveURL(
        `/admin-preview${baseline.expectedPath}`,
      );
      const pageContent = page.locator(".page-content");
      await expect(pageContent).toHaveAttribute(
        "data-console-route",
        baseline.routeId,
      );
      await expect(pageContent).toContainText(baseline.marker);
    }

    await stabilizeVisuals(page);
    await expect(page).toHaveScreenshot(
      `${screenshotName(baseline.route)}.png`,
      {
        animations: "disabled",
        caret: "hide",
        fullPage: true,
      },
    );
  });
}

async function installVisualMocks(page: Page) {
  await page.route(
    "**/api/admin/compat/models**",
    async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.endsWith("/models/active")) {
        await json(route, {});
        return;
      }
      if (pathname.endsWith("/models")) {
        await json(route, []);
        return;
      }
      await route.continue();
    },
  );
  await page.route(
    "**/api/admin/compat/frontend_plugin",
    async (route) => {
      await json(route, []);
    },
  );
  await page.route(
    "**/api/admin/compat/interjections",
    async (route) => {
      await json(route, {
        revision: 7,
        policy: {
          minIntervalMinutes: 30,
          maxPerHour: 2,
          maxPerDay: 3,
          quietStart: "23:00",
          quietEnd: "08:00",
        },
        channels: {
          telegram: {
            capability: "full",
            sent_last_hour: 0,
            sent_today: 1,
            next_allowed_at: null,
          },
        },
        decisions: [],
      });
    },
  );
  await page.route(
    "**/api/admin/compat/goals**",
    async (route) => {
      await json(route, []);
    },
  );
  await page.route(
    "**/api/admin/compat/memories**",
    async (route) => {
      await json(route, {
        items: [],
        next_cursor: null,
      });
    },
  );
  await page.route(
    "**/api/admin/compat/reflections**",
    async (route) => {
      await json(route, {
        items: [],
        profile_revision: 1,
        next_cursor: null,
      });
    },
  );
}

async function stabilizeVisuals(page: Page) {
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
  await page.waitForTimeout(300);
}

function screenshotName(route: string) {
  if (route === "/") return "root";
  if (route === "/ACP") return "acp-alias";
  return route.slice(1).replaceAll("/", "-") || "root";
}

async function json(route: Route, body: unknown) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}
