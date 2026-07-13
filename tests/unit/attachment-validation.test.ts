import { describe, expect, it } from "vitest";

import {
  ATTACHMENT_LIMITS,
  classifyAllowedAttachment,
  type AttachmentKind,
  type AttachmentStatus,
  type ChatAttachment,
} from "@/server/attachments/types";

describe("attachment types", () => {
  it.each([
    ["photo.jpg", "image/jpeg", "image"],
    ["photo.jpeg", "image/jpeg", "image"],
    ["photo.png", "image/png", "image"],
    ["photo.webp", "image/webp", "image"],
    ["document.pdf", "application/pdf", "document"],
    ["notes.txt", "text/plain", "document"],
    ["notes.md", "text/markdown", "document"],
    ["data.json", "application/json", "document"],
    ["table.csv", "text/csv", "document"],
  ] as const)("accepts %s with its matching MIME", (fileName, mimeType, kind) => {
    expect(classifyAllowedAttachment(fileName, mimeType)).toBe(kind);
  });

  it("normalizes extension and MIME case", () => {
    expect(classifyAllowedAttachment("PHOTO.JPEG", "IMAGE/JPEG")).toBe("image");
  });

  it.each([
    ["photo.png", "image/jpeg"],
    ["notes.md", "text/plain"],
    ["data.json", "text/csv"],
    ["archive.csv", "application/zip"],
  ])("rejects mismatched extension and MIME for %s", (fileName, mimeType) => {
    expect(classifyAllowedAttachment(fileName, mimeType)).toBeNull();
  });

  it.each([
    ["vector.svg", "image/svg+xml"],
    ["page.html", "text/html"],
    ["sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["document.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["archive.zip", "application/zip"],
    ["program.exe", "application/vnd.microsoft.portable-executable"],
  ])("rejects unsupported file %s", (fileName, mimeType) => {
    expect(classifyAllowedAttachment(fileName, mimeType)).toBeNull();
  });

  it("fixes message attachment limits", () => {
    expect(ATTACHMENT_LIMITS).toEqual({
      maxCount: 4,
      maxFileBytes: 10 * 1024 * 1024,
      maxMessageBytes: 20 * 1024 * 1024,
    });
  });

  it("exposes the planned stable attachment domain types", () => {
    const kind: AttachmentKind = "document";
    const status: AttachmentStatus = "ready";
    const attachment: ChatAttachment = {
      id: "attachment-1",
      kind,
      fileName: "notes.md",
      mimeType: "text/markdown",
      sizeBytes: 42,
      status,
      downloadUrl: "/api/chat/attachments/attachment-1/download",
    };

    expect(attachment).toMatchObject({ kind: "document", status: "ready" });
  });
});
