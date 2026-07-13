import { PDFParse } from "pdf-parse";

export const ATTACHMENT_TEXT_MAX_CHARACTERS = 100_000;
const PDF_EXTRACTION_TIMEOUT_MS = 15_000;

export type ExtractedAttachmentText = {
  text: string;
  truncated: boolean;
};

export type ExtractAttachmentTextInput = {
  mimeType: string;
  bytes: Buffer;
};

function stableError(code: string, cause?: unknown) {
  return new Error(code, cause === undefined ? undefined : { cause });
}

function decodeUtf8(bytes: Buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw stableError("attachment_invalid_utf8", error);
  }
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(stableError("attachment_extraction_timeout")), milliseconds);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function truncateAttachmentText(
  text: string,
  maxCharacters = ATTACHMENT_TEXT_MAX_CHARACTERS,
): ExtractedAttachmentText {
  if (text.length <= maxCharacters) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, maxCharacters), truncated: true };
}

export async function extractPdfText(bytes: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  try {
    let result: Awaited<ReturnType<PDFParse["getText"]>>;
    try {
      result = await withTimeout(parser.getText(), PDF_EXTRACTION_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof Error && error.message === "attachment_extraction_timeout") {
        throw error;
      }
      throw stableError("attachment_text_extraction_failed", error);
    }

    const text = result.text.trim();
    if (!text) {
      throw stableError("attachment_no_extractable_text");
    }
    return text;
  } finally {
    await parser.destroy();
  }
}

export async function extractAttachmentText({
  mimeType,
  bytes,
}: ExtractAttachmentTextInput): Promise<ExtractedAttachmentText> {
  const normalizedMime = mimeType.toLowerCase();
  const text =
    normalizedMime === "application/pdf" ? await extractPdfText(bytes) : decodeUtf8(bytes);

  return truncateAttachmentText(text);
}
