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
