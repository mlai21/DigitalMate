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

test("auto-scroll keeps the latest message above the floating input", async ({ page }) => {
  await page.setViewportSize({ width: 1914, height: 683 });
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "输入消息" })).toBeVisible();
  await page.waitForTimeout(500);

  await page.evaluate(() => {
    const messages = document.querySelector<HTMLElement>(".messages");
    const input = document.querySelector<HTMLElement>(".chat-input-shell");
    const anchor = messages?.lastElementChild;
    if (!messages || !input || !(anchor instanceof HTMLElement)) {
      throw new Error("chat layout was not rendered");
    }

    input.style.height = "168px";
    const rows = Array.from({ length: 10 }, (_, index) => {
      const row = document.createElement("div");
      row.className = "message-row message-row-assistant";

      const avatar = document.createElement("div");
      avatar.className = "mate-avatar";
      avatar.textContent = "D";

      const bubble = document.createElement("div");
      bubble.className = "message-bubble message-bubble-assistant";
      bubble.textContent = `第 ${index + 1} 条消息：这是一段用于撑开聊天列表的内容，底部自动滚动时不能被输入框遮挡。`;

      row.append(avatar, bubble);
      return row;
    });

    messages.replaceChildren(...rows, anchor);
  });
  await expect(page.locator(".message-bubble")).toHaveCount(10);
  await page.waitForFunction(() => {
    const stage = document.querySelector<HTMLElement>(".chat-stage");
    if (!stage) return false;
    const clearance = Number.parseFloat(getComputedStyle(stage).getPropertyValue("--chat-input-clearance"));
    return Number.isFinite(clearance) && clearance >= 200;
  });

  await page.waitForTimeout(50);
  await page.evaluate(() => {
    document.querySelector<HTMLElement>(".messages")?.lastElementChild?.scrollIntoView({ block: "end" });
  });

  const latestBubbleBox = await page.locator(".message-bubble").last().boundingBox();
  const inputBox = await page.locator(".chat-input-shell").boundingBox();
  expect(latestBubbleBox).not.toBeNull();
  expect(inputBox).not.toBeNull();

  expect(latestBubbleBox!.y + latestBubbleBox!.height).toBeLessThanOrEqual(inputBox!.y - 8);
});
