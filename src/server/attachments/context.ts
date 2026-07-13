import type { DbMessageAttachment } from "@/server/db/repositories";
import type { LlmAttachment } from "@/server/llm/types";

export const ATTACHMENT_CONTEXT_LIMITS = {
  maxCount: 4,
  maxImageBytes: 10 * 1024 * 1024,
  maxDocumentCharacters: 200_000,
  maxDocumentCharactersPerFile: 100_000,
} as const;

const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type AttachmentStorage = {
  read(storageKey: string): Promise<Buffer>;
};

export type LoadedAttachmentContext = {
  current: LlmAttachment[];
  history: Array<{
    attachment: DbMessageAttachment;
    llmAttachment: LlmAttachment;
  }>;
};

type ContextBudget = {
  count: number;
  imageBytes: number;
  documentCharacters: number;
};

function stableError(code: string): Error {
  return new Error(code);
}

function validateImageType(attachment: DbMessageAttachment): void {
  if (!IMAGE_MIME_TYPES.has(attachment.mimeType)) {
    throw stableError("attachment_context_image_type_invalid");
  }
}

function validateCurrentMetadata(attachments: DbMessageAttachment[]): void {
  if (attachments.length > ATTACHMENT_CONTEXT_LIMITS.maxCount) {
    throw stableError("attachment_context_count_exceeded");
  }
  let imageBytes = 0;
  let documentCharacters = 0;
  for (const attachment of attachments) {
    if (attachment.kind === "image") {
      validateImageType(attachment);
      imageBytes += attachment.sizeBytes;
      if (imageBytes > ATTACHMENT_CONTEXT_LIMITS.maxImageBytes) {
        throw stableError("attachment_context_image_bytes_exceeded");
      }
      continue;
    }
    if (attachment.extractedText === null) {
      throw stableError("attachment_context_text_unavailable");
    }
    if (attachment.extractedText.length > ATTACHMENT_CONTEXT_LIMITS.maxDocumentCharactersPerFile) {
      throw stableError("attachment_context_text_exceeded");
    }
    documentCharacters += attachment.extractedText.length;
    if (documentCharacters > ATTACHMENT_CONTEXT_LIMITS.maxDocumentCharacters) {
      throw stableError("attachment_context_text_exceeded");
    }
  }
}

async function loadCurrentAttachment(
  attachment: DbMessageAttachment,
  storage: AttachmentStorage,
  budget: ContextBudget,
): Promise<LlmAttachment> {
  if (attachment.kind === "document") {
    const text = attachment.extractedText;
    if (text === null) throw stableError("attachment_context_text_unavailable");
    budget.count += 1;
    budget.documentCharacters += text.length;
    return {
      kind: "document",
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      text,
      truncated: attachment.textTruncated,
    };
  }

  let bytes: Buffer;
  try {
    bytes = await storage.read(attachment.storageKey);
  } catch {
    throw stableError("attachment_context_image_unavailable");
  }
  if (budget.imageBytes + bytes.byteLength > ATTACHMENT_CONTEXT_LIMITS.maxImageBytes) {
    throw stableError("attachment_context_image_bytes_exceeded");
  }
  budget.count += 1;
  budget.imageBytes += bytes.byteLength;
  return {
    kind: "image",
    fileName: attachment.fileName,
    mimeType: attachment.mimeType as "image/jpeg" | "image/png" | "image/webp",
    base64: bytes.toString("base64"),
  };
}

async function tryLoadHistoricalAttachment(
  attachment: DbMessageAttachment,
  storage: AttachmentStorage,
  budget: ContextBudget,
  includeImages: boolean,
): Promise<LlmAttachment | null> {
  if (budget.count >= ATTACHMENT_CONTEXT_LIMITS.maxCount) return null;
  if (attachment.kind === "document") {
    const text = attachment.extractedText;
    if (
      text === null
      || text.length > ATTACHMENT_CONTEXT_LIMITS.maxDocumentCharactersPerFile
      || budget.documentCharacters + text.length > ATTACHMENT_CONTEXT_LIMITS.maxDocumentCharacters
    ) {
      return null;
    }
    budget.count += 1;
    budget.documentCharacters += text.length;
    return {
      kind: "document",
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      text,
      truncated: attachment.textTruncated,
    };
  }

  if (!includeImages || !IMAGE_MIME_TYPES.has(attachment.mimeType)) return null;
  if (budget.imageBytes + attachment.sizeBytes > ATTACHMENT_CONTEXT_LIMITS.maxImageBytes) return null;
  let bytes: Buffer;
  try {
    bytes = await storage.read(attachment.storageKey);
  } catch {
    return null;
  }
  if (budget.imageBytes + bytes.byteLength > ATTACHMENT_CONTEXT_LIMITS.maxImageBytes) return null;
  budget.count += 1;
  budget.imageBytes += bytes.byteLength;
  return {
    kind: "image",
    fileName: attachment.fileName,
    mimeType: attachment.mimeType as "image/jpeg" | "image/png" | "image/webp",
    base64: bytes.toString("base64"),
  };
}

export async function loadAttachmentContext(input: {
  currentAttachments: DbMessageAttachment[];
  historicalAttachments: DbMessageAttachment[];
  storage: AttachmentStorage;
  includeHistoricalImages: boolean;
}): Promise<LoadedAttachmentContext> {
  validateCurrentMetadata(input.currentAttachments);
  const budget: ContextBudget = { count: 0, imageBytes: 0, documentCharacters: 0 };
  const current: LlmAttachment[] = [];
  for (const attachment of input.currentAttachments) {
    current.push(await loadCurrentAttachment(attachment, input.storage, budget));
  }

  const selectedHistory: Array<{
    index: number;
    attachment: DbMessageAttachment;
    llmAttachment: LlmAttachment;
  }> = [];
  for (let index = input.historicalAttachments.length - 1; index >= 0; index -= 1) {
    const attachment = input.historicalAttachments[index];
    const llmAttachment = await tryLoadHistoricalAttachment(
      attachment,
      input.storage,
      budget,
      input.includeHistoricalImages,
    );
    if (llmAttachment) selectedHistory.push({ index, attachment, llmAttachment });
  }

  return {
    current,
    history: selectedHistory
      .sort((left, right) => left.index - right.index)
      .map(({ attachment, llmAttachment }) => ({ attachment, llmAttachment })),
  };
}

export async function loadLlmAttachments(
  attachments: DbMessageAttachment[],
  storage: AttachmentStorage,
): Promise<LlmAttachment[]> {
  const context = await loadAttachmentContext({
    currentAttachments: attachments,
    historicalAttachments: [],
    storage,
    includeHistoricalImages: true,
  });
  return context.current;
}
