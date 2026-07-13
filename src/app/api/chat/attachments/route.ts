import { NextResponse } from "next/server";
import { extractAttachmentText } from "@/server/attachments/extraction";
import {
  parseAttachmentMultipart,
  type ParsedAttachmentUpload,
} from "@/server/attachments/multipart";
import {
  createAttachmentStorageKey,
  deleteAttachment,
  saveAttachment,
} from "@/server/attachments/storage";
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

const PAYLOAD_LIMIT_ERRORS = new Set([
  "attachment_file_too_large",
  "attachment_request_too_large",
  "attachment_multipart_limit_exceeded",
]);

const BAD_REQUEST_ERRORS = new Set([
  "invalid_request",
  "attachment_file_required",
  "attachment_file_empty",
  "attachment_kind_required",
  "attachment_invalid_file_name",
]);

function errorResponse(error: string, status: number) {
  return NextResponse.json({ error }, { status });
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
  if (PAYLOAD_LIMIT_ERRORS.has(errorCode)) {
    return { error: errorCode, status: 413 };
  }
  if (UNSUPPORTED_ATTACHMENT_ERRORS.has(errorCode)) {
    return { error: errorCode, status: 415 };
  }
  if (UNPROCESSABLE_ATTACHMENT_ERRORS.has(errorCode)) {
    return { error: errorCode, status: 422 };
  }
  if (BAD_REQUEST_ERRORS.has(errorCode)) {
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

  let upload: ParsedAttachmentUpload;
  try {
    upload = await parseAttachmentMultipart(request);
  } catch (error) {
    const mapped = statusForUploadError(error);
    return errorResponse(mapped.error, mapped.status);
  }

  try {
    const validated = validateAttachmentFile({
      fileName: upload.fileName,
      declaredMime: upload.declaredMime,
      bytes: upload.bytes,
    });
    if (validated.kind !== upload.declaredKind) {
      throw new Error("attachment_kind_mismatch");
    }

    const extracted = validated.kind === "document"
      ? await extractAttachmentText({ mimeType: validated.mimeType, bytes: upload.bytes })
      : null;
    const storageKey = createAttachmentStorageKey();
    const storageRoot = readEnv().attachmentStorageDir;
    const attachments = createRepositories().messageAttachments;
    const draft = await attachments.createDraft({
      userId: user.id,
      kind: validated.kind,
      fileName: validated.fileName,
      mimeType: validated.mimeType,
      sizeBytes: validated.sizeBytes,
      storageKey,
      extractedText: extracted?.text ?? null,
      textTruncated: extracted?.truncated ?? false,
    });

    try {
      await saveAttachment(storageRoot, storageKey, upload.bytes);
      const attachment = await attachments.markReady(user.id, draft.id);
      if (!attachment) throw new Error("attachment_ready_transition_failed");
      return NextResponse.json({ attachment: publicAttachment(attachment) }, { status: 201 });
    } catch (error) {
      await attachments.markFailed(user.id, draft.id, "attachment_upload_failed").catch(() => undefined);
      const isExistingTarget = error instanceof Error && "code" in error && error.code === "EEXIST";
      if (!isExistingTarget) {
        await deleteAttachment(storageRoot, storageKey).catch(() => undefined);
      }
      return errorResponse("attachment_upload_failed", 500);
    }
  } catch (error) {
    const mapped = statusForUploadError(error);
    return errorResponse(mapped.error, mapped.status);
  }
}
