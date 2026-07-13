import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  extractAttachmentText,
  extractPdfText,
  extractPdfWithinBudget,
  truncateAttachmentText,
  type PdfExtractionWorker,
} from "@/server/attachments/extraction";

class FakePdfWorker extends EventEmitter implements PdfExtractionWorker {
  running = true;
  terminate = vi.fn(async () => {
    this.running = false;
    return 1;
  });
}

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
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    body += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("attachment text extraction", () => {
  it("truncates by Unicode code point without splitting a surrogate pair", () => {
    expect(truncateAttachmentText("a".repeat(120_000), 100_000)).toEqual({
      text: "a".repeat(100_000),
      truncated: true,
    });
    expect(truncateAttachmentText("😀😀", 1)).toEqual({ text: "😀", truncated: true });
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

  it("runs PDFParse v2 in a real worker and extracts a simple PDF", async () => {
    await expect(extractPdfText(buildSimplePdf("Worker PDF"))).resolves.toContain("Worker PDF");
  }, 20_000);

  it("limits pages before parsing all PDF text", async () => {
    const parser = {
      getInfo: vi.fn(async () => ({ total: 4 })),
      getText: vi.fn(async ({ partial }: { partial: number[] }) => ({
        text: `page-${partial[0]}`,
        pages: [{ num: partial[0], text: `page-${partial[0]}` }],
      })),
      destroy: vi.fn(async () => undefined),
    };

    await expect(
      extractPdfWithinBudget(parser, { maxPages: 2, maxCharacters: 100 }),
    ).resolves.toEqual({ text: "page-1\n\npage-2", truncated: true });
    expect(parser.getText).toHaveBeenCalledTimes(2);
    expect(parser.getText).toHaveBeenNthCalledWith(1, { partial: [1], pageJoiner: "" });
    expect(parser.getText).toHaveBeenNthCalledWith(2, { partial: [2], pageJoiner: "" });
    expect(parser.destroy).toHaveBeenCalledTimes(1);
  });

  it("stops parsing more pages when the cumulative text budget is reached", async () => {
    const parser = {
      getInfo: vi.fn(async () => ({ total: 3 })),
      getText: vi.fn(async ({ partial }: { partial: number[] }) => {
        const text = partial[0] === 1 ? "abcd" : "WXYZ";
        return { text, pages: [{ num: partial[0], text }] };
      }),
      destroy: vi.fn(async () => undefined),
    };

    await expect(
      extractPdfWithinBudget(parser, { maxPages: 3, maxCharacters: 8 }),
    ).resolves.toEqual({ text: "abcd\n\nWX", truncated: true });
    expect(parser.getText).toHaveBeenCalledTimes(2);
    expect(parser.destroy).toHaveBeenCalledTimes(1);
  });

  it("does not let destroy failure replace the primary extraction error", async () => {
    const parser = {
      getInfo: vi.fn(async () => {
        throw new Error("broken pdf");
      }),
      getText: vi.fn(),
      destroy: vi.fn(async () => {
        throw new Error("destroy failed");
      }),
    };

    await expect(
      extractPdfWithinBudget(parser, { maxPages: 2, maxCharacters: 100 }),
    ).rejects.toThrow("attachment_text_extraction_failed");
    expect(parser.destroy).toHaveBeenCalledTimes(1);
  });

  it("returns a stable error when a PDF has no extractable text", async () => {
    const parser = {
      getInfo: vi.fn(async () => ({ total: 1 })),
      getText: vi.fn(async () => ({ text: " \n\t ", pages: [{ num: 1, text: " \n\t " }] })),
      destroy: vi.fn(async () => undefined),
    };

    await expect(
      extractPdfWithinBudget(parser, { maxPages: 2, maxCharacters: 100 }),
    ).rejects.toThrow("attachment_no_extractable_text");
  });

  it("terminates the underlying worker before reporting a 15-second timeout", async () => {
    vi.useFakeTimers();
    const worker = new FakePdfWorker();

    const result = extractPdfText(Buffer.from("%PDF-slow"), {
      workerFactory: () => worker,
    });
    const assertion = expect(result).rejects.toThrow("attachment_extraction_timeout");
    await vi.advanceTimersByTimeAsync(15_000);

    await assertion;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.running).toBe(false);
  });
});
