import { ATTACHMENT_LIMITS } from "@/server/attachments/types";
import type { DbMessageAttachment } from "@/server/db/repositories";
import type { LlmAttachment } from "@/server/llm/types";

const MAX_DOCUMENT_CHARACTERS = 100_000;
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type AttachmentStorage = {
  read(storageKey: string): Promise<Buffer>;
};

function stableError(code: string): Error {
  return new Error(code);
}

export async function loadLlmAttachments(
  attachments: DbMessageAttachment[],
  storage: AttachmentStorage,
): Promise<LlmAttachment[]> {
  if (attachments.length > ATTACHMENT_LIMITS.maxCount) {
    throw stableError("attachment_context_count_exceeded");
  }

  const declaredImageBytes = attachments
    .filter((attachment) => attachment.kind === "image")
    .reduce((sum, attachment) => sum + attachment.sizeBytes, 0);
  if (declaredImageBytes > ATTACHMENT_LIMITS.maxMessageBytes) {
    throw stableError("attachment_context_image_bytes_exceeded");
  }

  const imageContents = new Map<string, Buffer>();
  let actualImageBytes = 0;
  for (const attachment of attachments) {
    if (attachment.kind !== "image") continue;
    if (!IMAGE_MIME_TYPES.has(attachment.mimeType)) {
      throw stableError("attachment_context_image_type_invalid");
    }
    let bytes: Buffer;
    try {
      bytes = await storage.read(attachment.storageKey);
    } catch {
      throw stableError("attachment_context_image_unavailable");
    }
    actualImageBytes += bytes.byteLength;
    if (actualImageBytes > ATTACHMENT_LIMITS.maxMessageBytes) {
      throw stableError("attachment_context_image_bytes_exceeded");
    }
    imageContents.set(attachment.id, bytes);
  }

  return attachments.map((attachment): LlmAttachment => {
      if (attachment.kind === "image") {
        const bytes = imageContents.get(attachment.id);
        if (!bytes) throw stableError("attachment_context_image_unavailable");
        return {
          kind: "image",
          fileName: attachment.fileName,
          mimeType: attachment.mimeType as "image/jpeg" | "image/png" | "image/webp",
          base64: bytes.toString("base64"),
        };
      }

      if (attachment.extractedText === null) {
        throw stableError("attachment_context_text_unavailable");
      }
      if (attachment.extractedText.length > MAX_DOCUMENT_CHARACTERS) {
        throw stableError("attachment_context_text_exceeded");
      }
      return {
        kind: "document",
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        text: attachment.extractedText,
        truncated: attachment.textTruncated,
      };
    });
}
