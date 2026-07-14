import { describe, expect, it } from "vitest";

import {
  ATTACHMENT_LIMITS,
  classifyAllowedAttachment,
  type AttachmentKind,
  type AttachmentStatus,
  type ChatAttachment,
} from "@/server/attachments/types";
import { validateAttachmentFile } from "@/server/attachments/validation";

const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]);

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

describe("attachment validation", () => {
  it("removes client-supplied path segments from the visible file name", () => {
    expect(
      validateAttachmentFile({
        fileName: "../x.png",
        declaredMime: "image/png",
        bytes: pngBytes,
      }),
    ).toMatchObject({
      fileName: "x.png",
      kind: "image",
      mimeType: "image/png",
      sizeBytes: pngBytes.length,
    });

    expect(
      validateAttachmentFile({
        fileName: "C:\\fakepath\\photo.png",
        declaredMime: "image/png",
        bytes: pngBytes,
      }).fileName,
    ).toBe("photo.png");
  });

  it("removes Unicode bidirectional control characters from the visible file name", () => {
    expect(
      validateAttachmentFile({
        fileName: "safe\u202Egnp.png",
        declaredMime: "image/png",
        bytes: pngBytes,
      }).fileName,
    ).toBe("safegnp.png");
  });

  it.each(["x.png.exe", "x.exe.png", "x.png.pdf", "x.exe.final.png"])(
    "rejects a disguised double extension: %s",
    (fileName) => {
      expect(() =>
        validateAttachmentFile({ fileName, declaredMime: "image/png", bytes: pngBytes }),
      ).toThrow("attachment_type_not_allowed");
    },
  );

  it.each([
    ["x.jpg", "image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0x00])],
    ["x.png", "image/png", pngBytes],
    ["x.webp", "image/webp", Buffer.from("RIFF0000WEBPpayload")],
    ["x.pdf", "application/pdf", Buffer.from("%PDF-1.7\n")],
  ])("accepts the required binary signature for %s", (fileName, declaredMime, bytes) => {
    expect(validateAttachmentFile({ fileName, declaredMime, bytes })).toMatchObject({
      fileName,
      mimeType: declaredMime,
    });
  });

  it("rejects a binary file whose content does not match its signature", () => {
    expect(() =>
      validateAttachmentFile({
        fileName: "x.png",
        declaredMime: "image/png",
        bytes: Buffer.from("not-png"),
      }),
    ).toThrow("attachment_signature_mismatch");
  });

  it.each([
    ["x.jpg", "image/jpeg", Buffer.from([0xff, 0xd8])],
    ["x.png", "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47])],
    ["x.webp", "image/webp", Buffer.from("RIFF0000NOPE")],
    ["x.pdf", "application/pdf", Buffer.from("%PDF")],
  ])("rejects a missing or incomplete binary signature for %s", (fileName, declaredMime, bytes) => {
    expect(() => validateAttachmentFile({ fileName, declaredMime, bytes })).toThrow(
      "attachment_signature_mismatch",
    );
  });

  it("accepts the exact size limit and rejects one byte over it before content parsing", () => {
    const exactLimit = Buffer.alloc(ATTACHMENT_LIMITS.maxFileBytes, 0x20);
    exactLimit.set([0xff, 0xd8, 0xff], 0);

    expect(
      validateAttachmentFile({
        fileName: "large.jpg",
        declaredMime: "image/jpeg",
        bytes: exactLimit,
      }).sizeBytes,
    ).toBe(ATTACHMENT_LIMITS.maxFileBytes);

    expect(() =>
      validateAttachmentFile({
        fileName: "large.jpg",
        declaredMime: "image/jpeg",
        bytes: Buffer.alloc(ATTACHMENT_LIMITS.maxFileBytes + 1),
      }),
    ).toThrow("attachment_file_too_large");
  });

  it.each([
    ["notes.txt", "text/plain"],
    ["notes.md", "text/markdown"],
    ["table.csv", "text/csv"],
  ])("accepts valid UTF-8 text for %s", (fileName, declaredMime) => {
    const bytes = Buffer.from("你好,DigitalMate\n");

    expect(validateAttachmentFile({ fileName, declaredMime, bytes })).toMatchObject({
      kind: "document",
      fileName,
      sizeBytes: bytes.length,
    });
  });

  it("rejects invalid UTF-8 and NUL bytes in text documents", () => {
    expect(() =>
      validateAttachmentFile({
        fileName: "notes.txt",
        declaredMime: "text/plain",
        bytes: Buffer.from([0xc3, 0x28]),
      }),
    ).toThrow("attachment_invalid_utf8");

    expect(() =>
      validateAttachmentFile({
        fileName: "notes.md",
        declaredMime: "text/markdown",
        bytes: Buffer.from("hello\0world"),
      }),
    ).toThrow("attachment_text_contains_nul");
  });

  it("requires JSON documents to be parseable", () => {
    expect(
      validateAttachmentFile({
        fileName: "data.json",
        declaredMime: "application/json",
        bytes: Buffer.from('{"ok":true}'),
      }),
    ).toMatchObject({ kind: "document", mimeType: "application/json" });

    expect(() =>
      validateAttachmentFile({
        fileName: "data.json",
        declaredMime: "application/json",
        bytes: Buffer.from("{broken"),
      }),
    ).toThrow("attachment_invalid_json");
  });
});
