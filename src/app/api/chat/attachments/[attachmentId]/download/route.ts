import { NextResponse } from "next/server";
import { readAttachment } from "@/server/attachments/storage";
import { requireCurrentUser } from "@/server/auth/current-user";
import { readEnv } from "@/server/config/env";
import { createRepositories } from "@/server/db/repositories";

export const runtime = "nodejs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INLINE_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function errorResponse(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

function isMissingFile(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function encodeRfc5987FileName(fileName: string) {
  return encodeURIComponent(fileName).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ attachmentId: string }> },
) {
  let user;
  try {
    user = await requireCurrentUser();
  } catch {
    return errorResponse("unauthorized", 401);
  }

  const { attachmentId } = await context.params;
  if (!UUID_PATTERN.test(attachmentId)) {
    return errorResponse("attachment_not_found", 404);
  }

  let attachment;
  try {
    attachment = await createRepositories().messageAttachments.getForUser(user.id, attachmentId);
  } catch {
    return errorResponse("attachment_download_failed", 500);
  }
  if (!attachment || (attachment.status !== "ready" && attachment.status !== "bound")) {
    return errorResponse("attachment_not_found", 404);
  }

  let bytes: Buffer;
  try {
    bytes = await readAttachment(readEnv().attachmentStorageDir, attachment.storageKey);
  } catch (error) {
    if (isMissingFile(error)) {
      return errorResponse("attachment_not_found", 404);
    }
    return errorResponse("attachment_download_failed", 500);
  }

  const disposition = attachment.kind === "image" && INLINE_IMAGE_MIME_TYPES.has(attachment.mimeType)
    ? "inline"
    : "attachment";
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": attachment.mimeType,
      "content-length": String(bytes.byteLength),
      "content-disposition": `${disposition}; filename*=UTF-8''${encodeRfc5987FileName(attachment.fileName)}`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
