import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pdfMocks = vi.hoisted(() => ({
  constructor: vi.fn(),
  destroy: vi.fn<() => Promise<void>>(),
  getText: vi.fn<() => Promise<{ text: string }>>(),
}));

vi.mock("pdf-parse", () => ({
  PDFParse: class {
    constructor(options: unknown) {
      pdfMocks.constructor(options);
    }

    getText() {
      return pdfMocks.getText();
    }

    destroy() {
      return pdfMocks.destroy();
    }
  },
}));

import {
  extractAttachmentText,
  extractPdfText,
  truncateAttachmentText,
} from "@/server/attachments/extraction";

describe("attachment text extraction", () => {
  beforeEach(() => {
    pdfMocks.constructor.mockReset();
    pdfMocks.destroy.mockReset().mockResolvedValue(undefined);
    pdfMocks.getText.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("truncates each document at the configured character boundary", () => {
    expect(truncateAttachmentText("a".repeat(120_000), 100_000)).toEqual({
      text: "a".repeat(100_000),
      truncated: true,
    });
    expect(truncateAttachmentText("short", 100_000)).toEqual({
      text: "short",
      truncated: false,
    });
  });

  it("extracts and truncates a UTF-8 text document", async () => {
    await expect(
      extractAttachmentText({
        mimeType: "text/markdown",
        bytes: Buffer.from("界".repeat(100_001)),
      }),
    ).resolves.toEqual({ text: "界".repeat(100_000), truncated: true });
  });

  it("uses PDFParse v2 getText and always destroys it after success", async () => {
    pdfMocks.getText.mockResolvedValue({ text: "  PDF content  " });
    const bytes = Buffer.from("%PDF-1.7\n");

    await expect(extractPdfText(bytes)).resolves.toBe("PDF content");
    expect(pdfMocks.constructor).toHaveBeenCalledWith({ data: new Uint8Array(bytes) });
    expect(pdfMocks.getText).toHaveBeenCalledTimes(1);
    expect(pdfMocks.destroy).toHaveBeenCalledTimes(1);
  });

  it("destroys the PDF parser when extraction fails", async () => {
    pdfMocks.getText.mockRejectedValue(new Error("broken pdf"));

    await expect(extractPdfText(Buffer.from("%PDF-broken"))).rejects.toThrow(
      "attachment_text_extraction_failed",
    );
    expect(pdfMocks.destroy).toHaveBeenCalledTimes(1);
  });

  it("times out PDF extraction after 15 seconds and still destroys the parser", async () => {
    vi.useFakeTimers();
    pdfMocks.getText.mockReturnValue(new Promise(() => undefined));

    const result = extractPdfText(Buffer.from("%PDF-slow"));
    const assertion = expect(result).rejects.toThrow("attachment_extraction_timeout");
    await vi.advanceTimersByTimeAsync(15_000);

    await assertion;
    expect(pdfMocks.destroy).toHaveBeenCalledTimes(1);
  });

  it("returns a stable error when a PDF has no extractable text", async () => {
    pdfMocks.getText.mockResolvedValue({ text: " \n\t " });

    await expect(
      extractAttachmentText({ mimeType: "application/pdf", bytes: Buffer.from("%PDF-empty") }),
    ).rejects.toThrow("attachment_no_extractable_text");
    expect(pdfMocks.destroy).toHaveBeenCalledTimes(1);
  });
});
