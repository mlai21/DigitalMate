import { Worker, type WorkerOptions } from "node:worker_threads";

export const ATTACHMENT_TEXT_MAX_CHARACTERS = 100_000;
export const PDF_EXTRACTION_LIMITS = {
  maxPages: 100,
  maxCharacters: ATTACHMENT_TEXT_MAX_CHARACTERS,
  timeoutMs: 15_000,
} as const;
const PDF_WORKER_RESOURCE_LIMITS = {
  maxOldGenerationSizeMb: 128,
  maxYoungGenerationSizeMb: 16,
  stackSizeMb: 4,
} as const;

export type ExtractedAttachmentText = {
  text: string;
  truncated: boolean;
};

export type ExtractAttachmentTextInput = {
  mimeType: string;
  bytes: Buffer;
};

type PdfPageTextResult = {
  num: number;
  text: string;
};

export type PdfParser = {
  getInfo(): Promise<{ total: number }>;
  getText(options: { partial: number[]; pageJoiner: string }): Promise<{
    text: string;
    pages?: PdfPageTextResult[];
  }>;
  destroy(): Promise<void>;
};

export type PdfExtractionWorker = {
  once(event: "message", listener: (message: unknown) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: (code: number) => void): unknown;
  off(event: "message", listener: (message: unknown) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
  off(event: "exit", listener: (code: number) => void): unknown;
  terminate(): Promise<number>;
};

export type PdfWorkerFactory = (source: string, options: WorkerOptions) => PdfExtractionWorker;

export type PdfExtractionOptions = {
  workerFactory?: PdfWorkerFactory;
  timeoutMs?: number;
};

type PdfWorkerMessage =
  | { ok: true; result: ExtractedAttachmentText }
  | { ok: false; errorCode: string };

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

export function truncateAttachmentText(
  text: string,
  maxCharacters = ATTACHMENT_TEXT_MAX_CHARACTERS,
): ExtractedAttachmentText {
  const characterLimit = Math.max(0, Math.trunc(maxCharacters));
  let end = 0;
  let characterCount = 0;

  while (end < text.length && characterCount < characterLimit) {
    const firstCodeUnit = text.charCodeAt(end);
    const nextCodeUnit = text.charCodeAt(end + 1);
    const isSurrogatePair =
      firstCodeUnit >= 0xd800 &&
      firstCodeUnit <= 0xdbff &&
      nextCodeUnit >= 0xdc00 &&
      nextCodeUnit <= 0xdfff;

    end += isSurrogatePair ? 2 : 1;
    characterCount += 1;
  }

  if (end === text.length) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, end), truncated: true };
}

/**
 * Kept self-contained because its runtime JavaScript is serialized into the isolated PDF worker.
 */
export async function extractPdfWithinBudget(
  parser: PdfParser,
  limits: { maxPages: number; maxCharacters: number },
): Promise<ExtractedAttachmentText> {
  let primaryError: unknown;
  try {
    try {
      const info = await parser.getInfo();
      const pagesToRead = Math.min(info.total, limits.maxPages);
      let text = "";
      let characterCount = 0;
      let truncated = info.total > limits.maxPages;

      for (let pageNumber = 1; pageNumber <= pagesToRead; pageNumber += 1) {
        if (characterCount >= limits.maxCharacters) {
          truncated = true;
          break;
        }
        const result = await parser.getText({ partial: [pageNumber], pageJoiner: "" });
        const pageText = (result.pages?.[0]?.text ?? result.text).trim();
        if (!pageText) continue;

        const candidate = `${text ? "\n\n" : ""}${pageText}`;
        const candidateCharacters = Array.from(candidate);
        const remainingCharacters = limits.maxCharacters - characterCount;
        if (candidateCharacters.length > remainingCharacters) {
          text += candidateCharacters.slice(0, Math.max(0, remainingCharacters)).join("");
          truncated = true;
          break;
        }

        text += candidate;
        characterCount += candidateCharacters.length;
      }

      text = text.trim();
      if (!text) {
        throw new Error("attachment_no_extractable_text");
      }
      return { text, truncated };
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === "attachment_no_extractable_text" ||
          error.message === "attachment_extraction_timeout")
      ) {
        throw error;
      }
      throw new Error("attachment_text_extraction_failed", { cause: error });
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await parser.destroy();
    } catch (destroyError) {
      if (primaryError === undefined) {
        throw new Error("attachment_text_extraction_failed", { cause: destroyError });
      }
    }
  }
}

function createPdfWorkerSource() {
  return `
const { parentPort, workerData } = require("node:worker_threads");
const extractPdfWithinBudget = ${extractPdfWithinBudget.toString()};

void (async () => {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(workerData.bytes) });
  const result = await extractPdfWithinBudget(parser, workerData.limits);
  parentPort.postMessage({ ok: true, result });
})().catch((error) => {
  const errorCode = error instanceof Error && error.message.startsWith("attachment_")
    ? error.message
    : "attachment_text_extraction_failed";
  parentPort.postMessage({ ok: false, errorCode });
});
`;
}

function isPdfWorkerMessage(message: unknown): message is PdfWorkerMessage {
  if (!message || typeof message !== "object" || !("ok" in message)) return false;
  if (message.ok === false) {
    return "errorCode" in message && typeof message.errorCode === "string";
  }
  if (message.ok !== true || !("result" in message) || !message.result || typeof message.result !== "object") {
    return false;
  }
  return (
    "text" in message.result &&
    typeof message.result.text === "string" &&
    "truncated" in message.result &&
    typeof message.result.truncated === "boolean"
  );
}

async function terminateWorker(worker: PdfExtractionWorker) {
  try {
    await worker.terminate();
  } catch {
    // The extraction outcome is more useful than a secondary termination failure.
  }
}

function runPdfWorker(worker: PdfExtractionWorker, timeoutMs: number) {
  return new Promise<ExtractedAttachmentText>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };

    const settle = async (
      outcome: { result: ExtractedAttachmentText } | { error: Error },
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      await terminateWorker(worker);
      if ("result" in outcome) resolve(outcome.result);
      else reject(outcome.error);
    };

    const onMessage = (message: unknown) => {
      if (!isPdfWorkerMessage(message)) {
        void settle({ error: stableError("attachment_text_extraction_failed") });
      } else if (message.ok) {
        void settle({ result: message.result });
      } else {
        void settle({ error: stableError(message.errorCode) });
      }
    };
    const onError = () => {
      void settle({ error: stableError("attachment_text_extraction_failed") });
    };
    const onExit = (code: number) => {
      if (code !== 0) {
        void settle({ error: stableError("attachment_text_extraction_failed") });
      }
    };
    const timeout = setTimeout(() => {
      void settle({ error: stableError("attachment_extraction_timeout") });
    }, timeoutMs);

    worker.once("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
  });
}

async function extractPdfResult(
  bytes: Buffer,
  options: PdfExtractionOptions = {},
): Promise<ExtractedAttachmentText> {
  const workerFactory =
    options.workerFactory ?? ((source, workerOptions) => new Worker(source, workerOptions));
  let worker: PdfExtractionWorker;
  try {
    worker = workerFactory(createPdfWorkerSource(), {
      eval: true,
      resourceLimits: PDF_WORKER_RESOURCE_LIMITS,
      workerData: {
        bytes: new Uint8Array(bytes),
        limits: {
          maxPages: PDF_EXTRACTION_LIMITS.maxPages,
          maxCharacters: PDF_EXTRACTION_LIMITS.maxCharacters,
        },
      },
    });
  } catch {
    throw stableError("attachment_text_extraction_failed");
  }
  return runPdfWorker(worker, options.timeoutMs ?? PDF_EXTRACTION_LIMITS.timeoutMs);
}

export async function extractPdfText(
  bytes: Buffer,
  options: PdfExtractionOptions = {},
): Promise<string> {
  return (await extractPdfResult(bytes, options)).text;
}

export async function extractAttachmentText({
  mimeType,
  bytes,
}: ExtractAttachmentTextInput): Promise<ExtractedAttachmentText> {
  if (mimeType.toLowerCase() === "application/pdf") {
    return extractPdfResult(bytes);
  }
  return truncateAttachmentText(decodeUtf8(bytes));
}
