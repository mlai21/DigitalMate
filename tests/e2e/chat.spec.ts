import { expect, test } from "@playwright/test";

test("chat page renders input", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "输入消息" })).toBeVisible();
});

test("chat input is centered in the conversation stage on wide screens", async ({ page }) => {
  await page.setViewportSize({ width: 2048, height: 1128 });
  await page.goto("/");

  const stageBox = await page.locator(".chat-stage").boundingBox();
  const messagesBox = await page.locator(".messages").boundingBox();
  const inputBox = await page.locator(".chat-input-shell").boundingBox();
  expect(stageBox).not.toBeNull();
  expect(messagesBox).not.toBeNull();
  expect(inputBox).not.toBeNull();

  const stageCenter = stageBox!.x + stageBox!.width / 2;
  const messagesCenter = messagesBox!.x + messagesBox!.width / 2;
  const inputCenter = inputBox!.x + inputBox!.width / 2;
  expect(Math.abs(stageCenter - messagesCenter)).toBeLessThanOrEqual(2);
  expect(Math.abs(stageCenter - inputCenter)).toBeLessThanOrEqual(2);
});

test("a taller composer keeps the latest message visible inside an independent scroller", async ({ page }) => {
  await page.setViewportSize({ width: 1914, height: 683 });
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "输入消息" })).toBeVisible();
  await expect(page.locator(".message-bubble")).toHaveCount(18);

  await page.locator(".chat-input-shell").evaluate((node) => {
    node.style.height = "168px";
  });
  await page.waitForFunction(() => {
    const stage = document.querySelector<HTMLElement>(".chat-stage");
    if (!stage) return false;
    const clearance = Number.parseFloat(getComputedStyle(stage).getPropertyValue("--chat-input-clearance"));
    return Number.isFinite(clearance) && clearance >= 200;
  });

  await page.waitForTimeout(50);
  await page.locator(".messages").evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });

  const latestBubbleBox = await page.locator(".message-bubble").last().boundingBox();
  const inputBox = await page.locator(".chat-input-shell").boundingBox();
  const scrollMetrics = await page.locator(".messages").evaluate((node) => ({
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
  }));
  expect(latestBubbleBox).not.toBeNull();
  expect(inputBox).not.toBeNull();

  expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
  expect(latestBubbleBox!.y + latestBubbleBox!.height).toBeLessThanOrEqual(inputBox!.y - 8);
});

test("polling preserves history position until the user jumps to the latest message", async ({ page }) => {
  let releaseNewMessage: (() => void) | undefined;
  const newMessageReady = new Promise<void>((resolve) => {
    releaseNewMessage = resolve;
  });

  await page.route("**/api/messages?**", async (route) => {
    await newMessageReady;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        messages: [
          {
            id: "assistant-polled",
            role: "assistant",
            content: "轮询返回的真实组件新消息",
            createdAt: "2026-07-14T00:01:00.000Z",
          },
        ],
      }),
    });
  });

  await page.goto("/");
  const messages = page.locator(".messages");
  await expect(page.locator(".message-bubble")).toHaveCount(18);
  const beforeScrollTop = await messages.evaluate((node) => {
    node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight - 240);
    node.dispatchEvent(new Event("scroll"));
    return node.scrollTop;
  });
  expect(beforeScrollTop).toBeGreaterThan(0);

  releaseNewMessage?.();
  await expect(page.getByRole("button", { name: "查看 1 条新消息" })).toBeVisible({ timeout: 7_000 });
  expect(await messages.evaluate((node) => node.scrollTop)).toBe(beforeScrollTop);
  await expect(page.getByRole("status")).toHaveText("1 条新消息");

  await page.getByRole("button", { name: "查看 1 条新消息" }).click();

  await expect(page.getByRole("button", { name: "查看 1 条新消息" })).toBeHidden();
  await expect(page.getByRole("status")).toBeEmpty();
  await expect
    .poll(() => messages.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight))
    .toBeLessThanOrEqual(2);
});

test("the mobile new-message button keeps a 44px touch target above the safe-area composer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/messages?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        messages: [
          {
            id: "assistant-mobile-polled",
            role: "assistant",
            content: "移动端轮询消息",
            createdAt: "2026-07-14T00:01:00.000Z",
          },
        ],
      }),
    });
  });
  await page.goto("/");
  await page.locator(".messages").evaluate((node) => {
    node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight - 240);
    node.dispatchEvent(new Event("scroll"));
  });
  await expect(page.getByRole("button", { name: "查看 1 条新消息" })).toBeVisible({ timeout: 7_000 });

  const buttonBox = await page.locator(".new-message-button").boundingBox();
  const inputBox = await page.locator(".chat-input-shell").boundingBox();
  expect(buttonBox).not.toBeNull();
  expect(inputBox).not.toBeNull();
  expect(buttonBox!.height).toBeGreaterThanOrEqual(44);
  expect(buttonBox!.y + buttonBox!.height).toBeLessThanOrEqual(inputBox!.y);
});
