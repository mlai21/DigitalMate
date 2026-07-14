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

test("real attachment APIs persist the first-phase allowlist across desktop and mobile", async ({ page }) => {
  test.setTimeout(180_000);
  const chatRequests: Array<Record<string, unknown>> = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/chat") && request.method() === "POST") {
      chatRequests.push(request.postDataJSON() as Record<string, unknown>);
    }
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "添加附件" }).click();
  await expect(page.getByRole("dialog", { name: "添加附件" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator(".chat-input-shell").evaluate((composer) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(
      ['<svg xmlns="http://www.w3.org/2000/svg"/>'],
      "unsafe.svg",
      { type: "image/svg+xml" },
    ));
    composer.dispatchEvent(new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer,
    }));
  });
  await expect(page.locator(".attachment-validation-error")).toContainText("仅支持 JPEG、PNG、WebP、PDF、TXT、MD、JSON、CSV");
  await page.getByLabel("选择文件").setInputFiles({
    name: "large.txt",
    mimeType: "text/plain",
    buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 0x61),
  });
  await expect(page.locator(".attachment-validation-error")).toContainText("单个附件不能超过 10 MB");

  await page.getByLabel("选择图片").setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+7n8pAAAAAElFTkSuQmCC",
      "base64",
    ),
  });
  await page.getByLabel("选择文件").setInputFiles([
    { name: "brief.pdf", mimeType: "application/pdf", buffer: buildSimplePdf("Real PDF") },
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("plain text") },
    { name: "guide.md", mimeType: "text/markdown", buffer: Buffer.from("# guide") },
  ]);
  await expect(page.locator(".attachment-preview-card")).toHaveCount(4);
  const firstChatResponsePromise = page.waitForResponse(
    (response) => response.url().endsWith("/api/chat") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "发送" }).click();
  const firstChatResponse = await firstChatResponsePromise;
  expect(firstChatResponse.status(), await firstChatResponse.text()).toBe(200);
  await expect(page.locator(".attachment-preview-card")).toHaveCount(0);
  await expect(page.getByRole("link", { name: /pixel\.png/ })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("选择文件").setInputFiles([
    { name: "config.json", mimeType: "application/json", buffer: Buffer.from('{"safe":true}') },
    { name: "table.csv", mimeType: "text/csv", buffer: Buffer.from("name,value\na,1") },
  ]);
  await expect(page.locator(".attachment-preview-card")).toHaveCount(2);
  const sendButton = page.getByRole("button", { name: "发送" });
  await expect(sendButton).toBeVisible();
  await sendButton.click();
  await expect(page.locator(".attachment-preview-card")).toHaveCount(0);
  await expect(page.getByRole("link", { name: /table\.csv/ })).toBeVisible();

  expect(chatRequests).toHaveLength(2);
  expect(chatRequests[0].message).toBe("");
  expect(chatRequests[1].message).toBe("");
  expect(chatRequests[0].attachmentIds).toHaveLength(4);
  expect(chatRequests[1].attachmentIds).toHaveLength(2);
  const serializedRequests = JSON.stringify(chatRequests);
  expect(serializedRequests).not.toContain("base64");
  expect(serializedRequests).not.toContain("extractedText");
  expect(serializedRequests).not.toContain("storageKey");
  expect(serializedRequests).not.toContain("iVBORw0KGgo");

  const conversationId = String(chatRequests[0].conversationId);
  const persistedBeforeReload = await page.evaluate(async (id) => {
    const response = await fetch(`/api/conversations/${id}/messages`);
    return { status: response.status, body: await response.json() };
  }, conversationId);
  expect(persistedBeforeReload.status).toBe(200);
  expect(
    (persistedBeforeReload.body.messages as Array<{ attachments?: Array<{ fileName?: string }> }>)
      .flatMap((message) => message.attachments ?? [])
      .map((attachment) => attachment.fileName),
  ).toEqual(expect.arrayContaining(["pixel.png", "brief.pdf", "notes.txt", "guide.md", "config.json", "table.csv"]));

  await page.reload({ waitUntil: "domcontentloaded" });
  for (const fileName of ["pixel.png", "brief.pdf", "notes.txt", "guide.md", "config.json", "table.csv"]) {
    await expect(page.getByRole("link", { name: new RegExp(fileName.replace(".", "\\.")) })).toBeVisible();
  }

  const imageLink = page.getByRole("link", { name: /pixel\.png/ });
  await expect(imageLink).not.toHaveAttribute("download");
  const popupPromise = page.waitForEvent("popup");
  await imageLink.dispatchEvent("click");
  const popup = await popupPromise;
  await expect(popup.locator("img")).toBeVisible();
  await popup.close();

  const documentLink = page.getByRole("link", { name: /guide\.md/ });
  await expect(documentLink).toHaveAttribute("download", "guide.md");
  const downloadPromise = page.waitForEvent("download");
  await documentLink.dispatchEvent("click");
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("guide.md");

  const apiRejections = await page.evaluate(async () => {
    const upload = async (name: string, type: string, bytes: Uint8Array, kind: "image" | "document") => {
      const form = new FormData();
      form.set("kind", kind);
      const fileBytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      form.set("file", new File([fileBytes], name, { type }));
      const response = await fetch("/api/chat/attachments", { method: "POST", body: form });
      return { status: response.status, body: await response.json() };
    };
    return {
      svg: await upload(
        "unsafe.svg",
        "image/svg+xml",
        new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        "image",
      ),
      oversized: await upload(
        "large.txt",
        "text/plain",
        new Uint8Array(10 * 1024 * 1024 + 1),
        "document",
      ),
    };
  });
  expect(apiRejections.svg).toEqual({ status: 415, body: { error: "attachment_type_not_allowed" } });
  expect(apiRejections.oversized).toEqual({ status: 413, body: { error: "attachment_file_too_large" } });
});

function buildSimplePdf(text: string) {
  const escapedText = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const stream = `BT /F1 12 Tf 72 100 Td (${escapedText}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body);
}
