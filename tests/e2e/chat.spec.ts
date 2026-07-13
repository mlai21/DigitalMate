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

test("mobile attachment menu stays clear of the new-message control", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await page.locator(".chat-stage").evaluate((stage) => {
    const button = document.createElement("button");
    button.className = "new-message-button";
    button.type = "button";
    button.textContent = "1 条新消息";
    stage.append(button);

    const attachmentTrigger = stage.querySelector<HTMLButtonElement>("[aria-label='添加附件']");
    if (attachmentTrigger) {
      attachmentTrigger.disabled = false;
      const reactPropsKey = Object.keys(attachmentTrigger).find((key) => key.startsWith("__reactProps$"));
      if (reactPropsKey) {
        const reactProps = (attachmentTrigger as unknown as Record<string, {
          disabled?: boolean;
          onClick?: () => void;
        }>)[reactPropsKey];
        reactProps.disabled = false;
        reactProps.onClick?.();
      }
    }
  });

  const attachmentTrigger = page.getByRole("button", { name: "添加附件" });

  const menu = page.getByRole("menu", { name: "添加附件菜单" });
  const newMessageButton = page.getByRole("button", { name: "1 条新消息" });
  const sendButton = page.getByRole("button", { name: "发送" });
  await expect(menu).toBeVisible();

  const menuBox = await menu.boundingBox();
  const newMessageBox = await newMessageButton.boundingBox();
  expect(menuBox).not.toBeNull();
  expect(newMessageBox).not.toBeNull();
  expect(rectanglesIntersect(menuBox!, newMessageBox!)).toBe(false);

  for (const box of [menuBox!, newMessageBox!]) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.y + box.height).toBeLessThanOrEqual(844);
  }

  for (const control of [
    attachmentTrigger,
    sendButton,
    newMessageButton,
    page.getByRole("menuitem", { name: "上传文件" }),
    page.getByRole("menuitem", { name: "上传图片" }),
  ]) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
});

function rectanglesIntersect(
  first: { x: number; y: number; width: number; height: number },
  second: { x: number; y: number; width: number; height: number },
) {
  return !(
    first.x + first.width <= second.x
    || second.x + second.width <= first.x
    || first.y + first.height <= second.y
    || second.y + second.height <= first.y
  );
}
