import { expect, test } from "@playwright/test";

test("a taller composer keeps the latest message visible inside an independent scroller", async ({ page }) => {
  await page.setViewportSize({ width: 1914, height: 683 });
  await page.route("**/api/conversations/conversation-secondary/messages", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        messages: Array.from({ length: 18 }, (_, index) => ({
          id: `secondary-history-${index + 1}`,
          role: index % 3 === 0 ? "user" : "assistant",
          content: `切换后的第 ${index + 1} 条历史消息：新输入框增高后仍需更新留白。`,
          createdAt: new Date(Date.UTC(2026, 6, 14, 0, 1, index)).toISOString(),
        })),
      }),
    });
  });
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "输入消息" })).toBeVisible();
  await expect(page.locator(".message-bubble")).toHaveCount(18);
  const firstComposer = await page.locator(".chat-input-shell").elementHandle();

  await page.getByRole("button", { name: "切换后会话", exact: true }).click();
  await expect(page.locator(".message-bubble")).toHaveCount(18);
  const nextComposer = await page.locator(".chat-input-shell").elementHandle();
  expect(firstComposer).not.toBeNull();
  expect(nextComposer).not.toBeNull();
  expect(await firstComposer!.evaluate((node) => node.isConnected)).toBe(false);
  expect(await nextComposer!.evaluate((node) => node.isConnected)).toBe(true);

  await page.locator(".chat-input-shell").evaluate((node) => {
    node.style.height = "168px";
  });
  await page.waitForFunction(() => {
    const stage = document.querySelector<HTMLElement>(".chat-stage");
    if (!stage) return false;
    const clearance = Number.parseFloat(getComputedStyle(stage).getPropertyValue("--chat-input-clearance"));
    return Number.isFinite(clearance) && clearance >= 200;
  });

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

  await page.clock.install();
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
  await page.clock.fastForward(5_100);
  await expect(page.getByRole("button", { name: "查看 1 条新消息" })).toBeVisible();
  expect(await messages.evaluate((node) => node.scrollTop)).toBe(beforeScrollTop);
  await expect(page.getByRole("status")).toHaveText("1 条新消息");

  await page.getByRole("button", { name: "查看 1 条新消息" }).click();

  await expect(page.getByRole("button", { name: "查看 1 条新消息" })).toBeHidden();
  await expect(page.getByRole("status")).toBeEmpty();
  await expect
    .poll(() => messages.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight))
    .toBeLessThanOrEqual(2);
});

test("the mobile new-message button keeps a 44px touch target above the composer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install();
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
  await page.clock.fastForward(5_100);
  await expect(page.getByRole("button", { name: "查看 1 条新消息" })).toBeVisible();

  const buttonBox = await page.locator(".new-message-button").boundingBox();
  const inputBox = await page.locator(".chat-input-shell").boundingBox();
  expect(buttonBox).not.toBeNull();
  expect(inputBox).not.toBeNull();
  expect(buttonBox!.height).toBeGreaterThanOrEqual(44);
  expect(buttonBox!.y + buttonBox!.height).toBeLessThanOrEqual(inputBox!.y);
  expect(844 - (inputBox!.y + inputBox!.height)).toBeGreaterThanOrEqual(12);
});

for (const height of [667, 568]) {
  test(`short mobile ${height}px keeps four attachments, long text and disclosure usable`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height });
    await page.clock.install();
    let uploadIndex = 0;
    await page.route("**/api/chat/attachments", async (route) => {
      uploadIndex += 1;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          attachment: {
            id: `attachment-e2e-${uploadIndex}`,
            kind: "document",
            fileName: `part-${uploadIndex}.txt`,
            mimeType: "text/plain",
            sizeBytes: 8,
            status: "ready",
          },
        }),
      });
    });
    await page.route("**/api/messages?**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          messages: [{
            id: `assistant-short-${height}`,
            role: "assistant",
            content: "短屏上的真实轮询消息",
            createdAt: "2026-07-14T00:01:00.000Z",
          }],
        }),
      });
    });

    await page.goto("/");
    const messages = page.locator(".messages");
    await messages.evaluate((node) => {
      node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight - 240);
      node.dispatchEvent(new Event("scroll"));
    });
    await page.clock.fastForward(5_100);
    const newMessageButton = page.getByRole("button", { name: "查看 1 条新消息" });
    await expect(newMessageButton).toBeVisible();

    await page.getByLabel("选择文件").setInputFiles(
      Array.from({ length: 4 }, (_, index) => ({
        name: `part-${index + 1}.txt`,
        mimeType: "text/plain",
        buffer: Buffer.from(`part-${index + 1}`),
      })),
    );
    await expect(page.locator(".attachment-preview-card")).toHaveCount(4);
    await page.getByRole("textbox", { name: "输入消息" }).fill(
      Array.from({ length: 8 }, (_, index) => `第 ${index + 1} 行短屏输入`).join("\n"),
    );
    await page.getByRole("button", { name: "添加附件" }).click();

    const disclosure = page.getByRole("dialog", { name: "添加附件" });
    const composer = page.locator(".chat-input-shell");
    await expect(disclosure).toBeVisible();
    const [disclosureBox, newMessageBox, composerBox] = await Promise.all([
      disclosure.boundingBox(),
      newMessageButton.boundingBox(),
      composer.boundingBox(),
    ]);
    expect(disclosureBox).not.toBeNull();
    expect(newMessageBox).not.toBeNull();
    expect(composerBox).not.toBeNull();

    for (const box of [disclosureBox!, newMessageBox!, composerBox!]) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(375);
      expect(box.y + box.height).toBeLessThanOrEqual(height);
    }
    expect(rectanglesIntersect(disclosureBox!, newMessageBox!)).toBe(false);
    expect(rectanglesIntersect(disclosureBox!, composerBox!)).toBe(false);
    expect(rectanglesIntersect(newMessageBox!, composerBox!)).toBe(false);

    const scrollMetrics = await messages.evaluate((node) => ({
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
    }));
    expect(scrollMetrics.clientHeight).toBeGreaterThan(80);
    expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
  });
}

test("an image attachment opens inline in a new page while documents remain downloads", async ({ page }) => {
  const imageUrl = "**/api/chat/attachments/image-e2e/download";
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+7n8pAAAAAElFTkSuQmCC",
    "base64",
  );
  await page.context().route(imageUrl, async (route) => {
    await route.fulfill({
      status: 200,
      body: png,
      headers: {
        "content-type": "image/png",
        "content-disposition": "inline; filename*=UTF-8''cat.png",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });
  let downloadStarted = false;
  page.on("download", () => {
    downloadStarted = true;
  });

  await page.goto("/");
  const imageLink = page.getByRole("link", { name: /cat\.png/ });
  await expect(imageLink).not.toHaveAttribute("download");
  const popupPromise = page.waitForEvent("popup");
  await imageLink.click();
  const popup = await popupPromise;

  await expect(popup).toHaveURL(/\/api\/chat\/attachments\/image-e2e\/download$/);
  await expect(popup.locator("img")).toBeVisible();
  expect(downloadStarted).toBe(false);
  await expect(page.getByRole("link", { name: /notes\.md/ })).toHaveAttribute("download", "notes.md");
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
