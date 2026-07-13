import { NextResponse } from "next/server";
import { extractAttachmentText } from "@/server/attachments/extraction";
import {
  createAttachmentStorageKey,
  deleteAttachment,
  saveAttachment,
} from "@/server/attachments/storage";
import { ATTACHMENT_LIMITS, type AttachmentKind } from "@/server/attachments/types";
import { validateAttachmentFile } from "@/server/attachments/validation";
import { requireCurrentUser } from "@/server/auth/current-user";
import { readEnv } from "@/server/config/env";
import { createRepositories, type DbMessageAttachment } from "@/server/db/repositories";

export const runtime = "nodejs";

const UNSUPPORTED_ATTACHMENT_ERRORS = new Set([
  "attachment_type_not_allowed",
  "attachment_signature_mismatch",
  "attachment_invalid_utf8",
  "attachment_text_contains_nul",
  "attachment_invalid_json",
  "attachment_kind_mismatch",
]);

const UNPROCESSABLE_ATTACHMENT_ERRORS = new Set([
  "attachment_no_extractable_text",
  "attachment_text_extraction_failed",
  "attachment_extraction_timeout",
]);

function errorResponse(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

function isUploadFile(value: FormDataEntryValue | null): value is File {
  return Boolean(
    value &&
      typeof value !== "string" &&
      typeof value.name === "string" &&
      typeof value.type === "string" &&
      typeof value.size === "number" &&
      typeof value.arrayBuffer === "function",
  );
}

function isAttachmentKind(value: FormDataEntryValue | null): value is AttachmentKind {
  return value === "image" || value === "document";
}

function publicAttachment(attachment: DbMessageAttachment) {
  return {
    id: attachment.id,
    kind: attachment.kind,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    status: "ready" as const,
  };
}

function statusForUploadError(error: unknown) {
  const errorCode = error instanceof Error ? error.message : "";
  if (errorCode === "attachment_file_too_large") {
    return { error: errorCode, status: 413 };
  }
  if (UNSUPPORTED_ATTACHMENT_ERRORS.has(errorCode)) {
    return { error: errorCode, status: 415 };
  }
  if (UNPROCESSABLE_ATTACHMENT_ERRORS.has(errorCode)) {
    return { error: errorCode, status: 422 };
  }
  if (errorCode === "attachment_invalid_file_name") {
    return { error: errorCode, status: 400 };
  }
  return { error: "attachment_upload_failed", status: 500 };
}

export async function POST(request: Request) {
  let user;
  try {
    user = await requireCurrentUser();
  } catch {
    return errorResponse("unauthorized", 401);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorResponse("invalid_request", 400);
  }

  const file = form.get("file");
  if (!isUploadFile(file)) {
    return errorResponse("attachment_file_required", 400);
  }
  const declaredKind = form.get("kind");
  if (!isAttachmentKind(declaredKind)) {
    return errorResponse("attachment_kind_required", 400);
  }
  if (file.size === 0) {
    return errorResponse("attachment_file_empty", 400);
  }
  if (file.size > ATTACHMENT_LIMITS.maxFileBytes) {
    return errorResponse("attachment_file_too_large", 413);
  }

  let storageKey: string | null = null;
  let storageRoot: string | null = null;
  let storageSaved = false;
  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    const validated = validateAttachmentFile({
      fileName: file.name,
      declaredMime: file.type,
      bytes,
    });
    if (validated.kind !== declaredKind) {
      throw new Error("attachment_kind_mismatch");
    }

    const extracted = validated.kind === "document"
      ? await extractAttachmentText({ mimeType: validated.mimeType, bytes })
      : null;
    storageKey = createAttachmentStorageKey();
    storageRoot = readEnv().attachmentStorageDir;
    await saveAttachment(storageRoot, storageKey, bytes);
    storageSaved = true;

    const attachment = await createRepositories().messageAttachments.createDraft({
      userId: user.id,
      kind: validated.kind,
      fileName: validated.fileName,
      mimeType: validated.mimeType,
      sizeBytes: validated.sizeBytes,
      storageKey,
      extractedText: extracted?.text ?? null,
      textTruncated: extracted?.truncated ?? false,
    });

    return NextResponse.json({ attachment: publicAttachment(attachment) }, { status: 201 });
  } catch (error) {
    if (storageKey && storageRoot && storageSaved) {
      await deleteAttachment(storageRoot, storageKey).catch(() => undefined);
    }
    const mapped = statusForUploadError(error);
    return errorResponse(mapped.error, mapped.status);
  }
}
