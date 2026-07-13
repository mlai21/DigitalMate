import { ATTACHMENT_LIMITS, classifyAllowedAttachment, type AttachmentKind } from "./types";

const FILE_NAME_MAX_CHARACTERS = 255;

const BINARY_SIGNATURES: Readonly<Record<string, (bytes: Buffer) => boolean>> = {
  "image/jpeg": (bytes) => bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  "image/png": (bytes) =>
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/webp": (bytes) =>
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP",
  "application/pdf": (bytes) =>
    bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-",
};

const TEXT_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "application/json",
  "text/csv",
]);

const DISGUISED_EXTENSIONS = new Set([
  "bat",
  "cmd",
  "com",
  "csv",
  "exe",
  "html",
  "htm",
  "jar",
  "jpeg",
  "jpg",
  "js",
  "json",
  "md",
  "msi",
  "pdf",
  "php",
  "png",
  "ps1",
  "py",
  "sh",
  "svg",
  "txt",
  "webp",
]);

export type ValidatedAttachmentFile = {
  fileName: string;
  kind: AttachmentKind;
  mimeType: string;
  sizeBytes: number;
};

export type ValidateAttachmentFileInput = {
  fileName: string;
  declaredMime: string;
  bytes: Buffer;
};

function stableError(code: string, cause?: unknown) {
  return new Error(code, cause === undefined ? undefined : { cause });
}

function truncateFileName(fileName: string) {
  const characters = Array.from(fileName);
  if (characters.length <= FILE_NAME_MAX_CHARACTERS) return fileName;

  const extensionIndex = fileName.lastIndexOf(".");
  const extension = extensionIndex > 0 ? fileName.slice(extensionIndex) : "";
  const extensionCharacters = Array.from(extension);
  const baseLength = Math.max(1, FILE_NAME_MAX_CHARACTERS - extensionCharacters.length);
  return `${characters.slice(0, baseLength).join("")}${extension}`;
}

function sanitizeAttachmentFileName(fileName: string) {
  const normalizedPath = fileName.replaceAll("\\", "/");
  const baseName = normalizedPath.split("/").at(-1) ?? "";
  const withoutControls = baseName.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!withoutControls || withoutControls === "." || withoutControls === "..") {
    throw stableError("attachment_invalid_file_name");
  }
  return truncateFileName(withoutControls);
}

function hasDisguisedDoubleExtension(fileName: string) {
  const segments = fileName.toLowerCase().split(".");
  if (segments.length < 3) return false;
  return DISGUISED_EXTENSIONS.has(segments.at(-2) ?? "");
}

function decodeUtf8(bytes: Buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw stableError("attachment_invalid_utf8", error);
  }
}

function validateTextContent(mimeType: string, bytes: Buffer) {
  if (bytes.includes(0)) {
    throw stableError("attachment_text_contains_nul");
  }

  const text = decodeUtf8(bytes);
  if (mimeType === "application/json") {
    try {
      JSON.parse(text);
    } catch (error) {
      throw stableError("attachment_invalid_json", error);
    }
  }
}

export function validateAttachmentFile({
  fileName,
  declaredMime,
  bytes,
}: ValidateAttachmentFileInput): ValidatedAttachmentFile {
  const safeFileName = sanitizeAttachmentFileName(fileName);
  const mimeType = declaredMime.trim().toLowerCase();

  if (hasDisguisedDoubleExtension(safeFileName)) {
    throw stableError("attachment_type_not_allowed");
  }

  const kind = classifyAllowedAttachment(safeFileName, mimeType);
  if (!kind) {
    throw stableError("attachment_type_not_allowed");
  }

  if (bytes.length > ATTACHMENT_LIMITS.maxFileBytes) {
    throw stableError("attachment_file_too_large");
  }

  const signatureMatches = BINARY_SIGNATURES[mimeType];
  if (signatureMatches && !signatureMatches(bytes)) {
    throw stableError("attachment_signature_mismatch");
  }

  if (TEXT_MIME_TYPES.has(mimeType)) {
    validateTextContent(mimeType, bytes);
  }

  return {
    fileName: safeFileName,
    kind,
    mimeType,
    sizeBytes: bytes.length,
  };
}
