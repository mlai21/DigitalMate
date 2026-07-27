import { expect, test } from "@playwright/test";
import type {
  Page,
  Route,
} from "@playwright/test";
import {
  DIGITALMATE_ADMIN_ROUTE_BASELINES,
  DIGITALMATE_ADMIN_ROUTES,
  DIGITALMATE_PAGE_ROUTE_BASELINES,
} from "./admin-console.routes";

const AGENT_ID = "00000000-0000-4000-8000-000000000011";
const GOAL_ID = "20000000-0000-4000-8000-000000000001";
const MEMORY_ID = "30000000-0000-4000-8000-000000000001";
const REFLECTION_ID =
  "40000000-0000-4000-8000-000000000001";

const interjectionOverview = {
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
      sent_last_hour: 1,
      sent_today: 2,
      next_allowed_at: "2026-07-27T12:30:00.000Z",
    },
    dingtalk: {
      capability: "capability_limited",
      limitation: "unmentioned_group_events_unavailable",
      sent_last_hour: 0,
      sent_today: 0,
      next_allowed_at: null,
    },
  },
  decisions: [
    {
      id: "50000000-0000-4000-8000-000000000001",
      channel: "telegram",
      external_conversation_id: "group-1",
      should_interject: true,
      reason: "relevant",
      created_at: "2026-07-27T12:00:00.000Z",
    },
  ],
};

const goalSummary = {
  id: GOAL_ID,
  title: "整理 Console 验收证据",
  status: "running",
  revision: 4,
  objective: "完成管理后台验收",
  network_authorized: false,
  progress_summary: "已完成 API 映射",
  budget_used: { rounds: 2, tokens: 1200, cost_usd: 0.02 },
  needs_human_prompt: null,
  next_run_at: "2026-07-27T13:00:00.000Z",
  finished_at: null,
  created_at: "2026-07-27T10:00:00.000Z",
  updated_at: "2026-07-27T12:00:00.000Z",
};

const memoryEntry = {
  id: MEMORY_ID,
  kind: "profile",
  content: "用户偏好简洁、直接的中文表达。",
  confidence: 0.92,
  source: { type: "message", id: null },
  created_at: "2026-07-27T10:00:00.000Z",
  expires_at: null,
};

const reflectionEntry = {
  id: REFLECTION_ID,
  positives: ["表达自然"],
  negatives: ["有时过长"],
  suggestions: ["先给结论", "减少重复解释"],
  status: "recorded",
  created_at: "2026-07-27T11:00:00.000Z",
};

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
        csrf_token: "admin-console-e2e",
        csrf_expires_at:
          Math.floor(Date.now() / 1_000) + 3_600,
      });
    },
  );
  await installDomainMocks(page);
});

test("固定路由集合包含 30 条且没有重复", () => {
  expect(DIGITALMATE_ADMIN_ROUTES).toHaveLength(30);
  expect(new Set(DIGITALMATE_ADMIN_ROUTES).size).toBe(30);
});

for (const baseline of DIGITALMATE_ADMIN_ROUTE_BASELINES) {
  test(`Console 全页面深层刷新 ${baseline.route}`, async ({
    page,
  }) => {
    await page.goto(`/admin-preview${baseline.route}`);
    await expectConsolePage(page, baseline);
  });
}

test("四个 DigitalMate 页面按批准的导航分组出现", async ({
  page,
}) => {
  await page.goto("/admin-preview/interjections");
  await expectConsoleReady(page);

  for (const baseline of DIGITALMATE_PAGE_ROUTE_BASELINES) {
    const name = new RegExp(baseline.marker);
    await expect(
      page
        .getByRole("menuitem", { name })
        .or(page.getByRole("button", { name })),
    ).toBeVisible();
  }
});

test("Interjections 保存 revision 策略并展示平台限制", async ({
  page,
}) => {
  let mutation: Record<string, unknown> | null = null;
  const saveResponse = deferred();
  await page.route(
    "**/api/admin/compat/interjections/policy",
    async (route) => {
      mutation = route.request().postDataJSON();
      await saveResponse.promise;
      await json(route, {
        revision: 8,
        policy: {
          ...interjectionOverview.policy,
          minIntervalMinutes: 45,
        },
      });
    },
  );

  await page.goto("/admin-preview/interjections");
  await expectConsolePage(
    page,
    DIGITALMATE_PAGE_ROUTE_BASELINES[0],
  );
  await expect(
    page.getByRole("alert").getByText("平台能力限制"),
  ).toBeVisible();
  await page.getByLabel("最小间隔（分钟）").fill("45");
  await page.getByRole("button", { name: "保存策略" }).click();
  await expect(
    page.getByRole("dialog", {
      name: "确认保存插话策略？",
    }),
  ).toBeVisible();
  const saveButton = page.getByRole("button", {
    name: "保存策略",
  });
  await page.getByRole("button", { name: "确认保存" }).click();
  await expect(saveButton).toBeDisabled();
  saveResponse.resolve();
  await expect.poll(() => mutation).toMatchObject({
    revision: 7,
    policy: {
      min_interval_minutes: 45,
    },
  });
});

test("Goals 支持状态筛选、详情和暂停确认", async ({
  page,
}) => {
  let actionBody: Record<string, unknown> | null = null;
  const actionResponse = deferred();
  await page.route(
    `**/api/admin/compat/goals/${GOAL_ID}/actions/pause`,
    async (route) => {
      actionBody = route.request().postDataJSON();
      await actionResponse.promise;
      await json(route, {
        ...goalSummary,
        status: "paused",
        revision: 5,
      });
    },
  );

  await page.goto("/admin-preview/goals");
  await expectConsolePage(
    page,
    DIGITALMATE_PAGE_ROUTE_BASELINES[1],
  );
  await page
    .getByRole("combobox", { name: "目标状态" })
    .click();
  await page
    .locator(
      ".qwenpaw-select-dropdown:visible .qwenpaw-select-item-option",
    )
    .filter({ hasText: "运行中" })
    .click();
  await expect(page.getByText(goalSummary.title)).toBeVisible();
  await page
    .getByRole("button", { name: "查看目标详情" })
    .click();
  await expect(
    page.getByRole("dialog", { name: goalSummary.title }),
  ).toBeVisible();
  const pauseButton = page.getByRole("button", {
    name: "暂停目标",
  });
  await pauseButton.click();
  await expect(
    page.getByRole("dialog", { name: "确认暂停目标？" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "确认暂停" }).click();
  await expect(pauseButton).toBeDisabled();
  actionResponse.resolve();
  await expect.poll(() => actionBody).toMatchObject({
    revision: 4,
  });
});

test("Memory 支持类型筛选、编辑确认和删除确认", async ({
  page,
}) => {
  let updateBody: Record<string, unknown> | null = null;
  let deleteBody: Record<string, unknown> | null = null;
  const updateResponse = deferred();
  await page.route(
    `**/api/admin/compat/memories/${MEMORY_ID}`,
    async (route) => {
      if (route.request().method() === "PUT") {
        updateBody = route.request().postDataJSON();
        await updateResponse.promise;
        await json(route, {
          ...memoryEntry,
          content: "用户偏好先给结论。",
        });
        return;
      }
      deleteBody = route.request().postDataJSON();
      await json(route, { id: MEMORY_ID, deleted: true });
    },
  );

  await page.goto("/admin-preview/memory");
  await expectConsolePage(
    page,
    DIGITALMATE_PAGE_ROUTE_BASELINES[2],
  );
  await page
    .getByRole("combobox", { name: "记忆类型" })
    .click();
  await page
    .locator(
      ".qwenpaw-select-dropdown:visible .qwenpaw-select-item-option",
    )
    .filter({ hasText: "用户画像" })
    .click();
  await page.getByRole("button", { name: "编辑记忆" }).click();
  await page
    .getByLabel("记忆内容")
    .fill("用户偏好先给结论。");
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(
    page.getByRole("dialog", {
      name: "确认修改这条记忆？",
    }),
  ).toBeVisible();
  const saveButton = page.getByRole("button", {
    name: "保存修改",
  });
  await page.getByRole("button", { name: "确认修改" }).click();
  await expect(saveButton).toBeDisabled();
  updateResponse.resolve();
  await expect.poll(() => updateBody).toMatchObject({
    kind: "profile",
    content: "用户偏好先给结论。",
    confirmed: true,
  });

  await page.getByRole("button", { name: "删除记忆" }).click();
  await expect(
    page.getByRole("dialog", {
      name: "确认删除这条记忆？",
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "确认删除" }).click();
  await expect.poll(() => deleteBody).toMatchObject({
    confirmed: true,
  });
});

test("Reflections 只应用用户勾选的建议并要求确认", async ({
  page,
}) => {
  let actionBody: Record<string, unknown> | null = null;
  const actionResponse = deferred();
  await page.route(
    `**/api/admin/compat/reflections/${REFLECTION_ID}/actions/apply`,
    async (route) => {
      actionBody = route.request().postDataJSON();
      await actionResponse.promise;
      await json(route, {
        ...reflectionEntry,
        status: "applied",
        profile_revision: 10,
      });
    },
  );

  await page.goto("/admin-preview/reflections");
  await expectConsolePage(
    page,
    DIGITALMATE_PAGE_ROUTE_BASELINES[3],
  );
  const applyButton = page.getByRole("button", {
    name: "应用所选建议",
  });
  await expect(applyButton).toBeDisabled();
  await page.getByRole("checkbox", { name: "先给结论" }).check();
  await expect(applyButton).toBeEnabled();
  await applyButton.click();
  await expect(
    page.getByRole("dialog", {
      name: "确认应用所选建议？",
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "确认应用" }).click();
  await expect(applyButton).toBeDisabled();
  actionResponse.resolve();
  await expect.poll(() => actionBody).toMatchObject({
    revision: 9,
    confirmed: true,
    suggestion_indexes: [0],
  });
});

test("冻结能力显示稳定原因且 Plugin Manager 不访问市场", async ({
  page,
}) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("agentscope.io")) {
      externalRequests.push(request.url());
    }
  });

  await page.goto("/admin-preview/coding");
  await expect(page.getByText("编程模式暂未开放")).toBeVisible();

  await page.goto("/admin-preview/acp");
  await expect(page.getByText("ACP 能力当前冻结")).toBeVisible();

  await page.goto("/admin-preview/models");
  await page.getByText(/本地.*自定义/).click();
  await expect(page.getByText("本地模型能力当前冻结")).toBeVisible();

  await page.goto("/admin-preview/plugin-manager");
  await expect(
    page.getByText("插件扩展需单独确认且当前冻结"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "安装插件" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("link", { name: "第三方许可" }),
  ).toHaveAttribute(
    "href",
    /github\.com\/agentscope-ai\/QwenPaw\/tree\/fef7e64d/,
  );
  expect(externalRequests).toEqual([]);
});

const domainRecoveryCases = [
  {
    name: "Interjections",
    route: "/interjections",
    request: "**/api/admin/compat/interjections*",
    recovery: interjectionOverview,
    recoveredMarker: "平台能力限制",
  },
  {
    name: "Goals",
    route: "/goals",
    request: "**/api/admin/compat/goals*",
    recovery: [],
    recoveredMarker: "还没有目标",
  },
  {
    name: "Memory",
    route: "/memory",
    request: "**/api/admin/compat/memories*",
    recovery: {
      items: [],
      next_cursor: null,
    },
    recoveredMarker: "还没有记忆",
  },
  {
    name: "Reflections",
    route: "/reflections",
    request: "**/api/admin/compat/reflections*",
    recovery: {
      items: [],
      profile_revision: 9,
      next_cursor: null,
    },
    recoveredMarker: "还没有反思记录",
  },
] as const;

for (const recoveryCase of domainRecoveryCases) {
  test(`${recoveryCase.name} 展示加载、失败并可重试为空态`, async ({
    page,
  }) => {
    const failedResponse = deferred();
    let attempts = 0;
    await page.route(recoveryCase.request, async (route) => {
      attempts += 1;
      if (attempts === 1) {
        await failedResponse.promise;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "temporarily_unavailable" }),
        });
        return;
      }
      await json(route, recoveryCase.recovery);
    });

    await page.goto(`/admin-preview${recoveryCase.route}`);
    await expect(page.getByTestId("domain-loading")).toBeVisible();

    failedResponse.resolve();
    await expect(
      page.getByText("加载失败", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "重新加载" }).click();

    await expect(
      page.getByText(recoveryCase.recoveredMarker).first(),
    ).toBeVisible();
    expect(attempts).toBe(2);
  });
}

async function installDomainMocks(page: Page) {
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
      if (route.request().method() === "GET") {
        await json(route, interjectionOverview);
        return;
      }
      await route.continue();
    },
  );
  await page.route("**/api/admin/compat/goals**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith(`/${GOAL_ID}`)) {
      await json(route, {
        ...goalSummary,
        contract: {
          objective: goalSummary.objective,
          success_criteria: ["后台验收通过"],
          cadence: { kind: "manual" },
          scope: { allowed_tools: [], forbidden: [] },
          budget: { max_rounds: 10 },
          stop_conditions: [],
          deliverable: "验收报告",
          network_authorized: false,
        },
        no_progress_rounds: 0,
        steps: [],
      });
      return;
    }
    await json(route, [goalSummary]);
  });
  await page.route(
    "**/api/admin/compat/memories**",
    async (route) => {
      if (route.request().method() === "GET") {
        await json(route, {
          items: [memoryEntry],
          next_cursor: null,
        });
        return;
      }
      await route.continue();
    },
  );
  await page.route(
    "**/api/admin/compat/reflections**",
    async (route) => {
      if (route.request().method() === "GET") {
        await json(route, {
          items: [reflectionEntry],
          profile_revision: 9,
          next_cursor: null,
        });
        return;
      }
      await route.continue();
    },
  );
}

async function expectConsoleReady(page: Page) {
  await expect(page.locator("#root")).toBeVisible();
  await expect(
    page.locator("#root .qwenpaw-layout").first(),
  ).toBeVisible({ timeout: 30_000 });
}

async function expectConsolePage(
  page: Page,
  baseline: {
    expectedPath: string;
    routeId: string;
    marker: string;
  },
) {
  await expectConsoleReady(page);
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

async function json(route: Route, body: unknown) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
