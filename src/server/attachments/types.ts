export type AttachmentKind = "image" | "document";

export type AttachmentStatus = "pending" | "ready" | "failed" | "bound";

export type ChatAttachment = {
  id: string;
  kind: AttachmentKind;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  status: AttachmentStatus;
  downloadUrl?: string;
};

export const ATTACHMENT_LIMITS = {
  maxCount: 4,
  maxFileBytes: 10 * 1024 * 1024,
  maxMessageBytes: 20 * 1024 * 1024,
} as const;

type AllowedAttachmentType = {
  kind: AttachmentKind;
  mimeType: string;
};

const ALLOWED_ATTACHMENT_TYPES: Readonly<Record<string, AllowedAttachmentType>> = {
  jpg: { kind: "image", mimeType: "image/jpeg" },
  jpeg: { kind: "image", mimeType: "image/jpeg" },
  png: { kind: "image", mimeType: "image/png" },
  webp: { kind: "image", mimeType: "image/webp" },
  pdf: { kind: "document", mimeType: "application/pdf" },
  txt: { kind: "document", mimeType: "text/plain" },
  md: { kind: "document", mimeType: "text/markdown" },
  json: { kind: "document", mimeType: "application/json" },
  csv: { kind: "document", mimeType: "text/csv" },
};

export function classifyAllowedAttachment(
  fileName: string,
  declaredMime: string,
): AttachmentKind | null {
  const extensionSeparator = fileName.lastIndexOf(".");
  if (extensionSeparator < 0 || extensionSeparator === fileName.length - 1) {
    return null;
  }

  const extension = fileName.slice(extensionSeparator + 1).toLowerCase();
  const allowedType = ALLOWED_ATTACHMENT_TYPES[extension];
  if (!allowedType || allowedType.mimeType !== declaredMime.toLowerCase()) {
    return null;
  }

  return allowedType.kind;
}
