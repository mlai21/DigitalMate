import { NextResponse } from "next/server";
import { deleteAttachment } from "@/server/attachments/storage";
import { requireCurrentUser } from "@/server/auth/current-user";
import { readEnv } from "@/server/config/env";
import { createRepositories } from "@/server/db/repositories";

export const runtime = "nodejs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function errorResponse(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

function deletedResponse() {
  return new Response(null, { status: 204 });
}

export async function DELETE(
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
    return deletedResponse();
  }

  const attachments = createRepositories().messageAttachments;
  let attachment;
  try {
    attachment = await attachments.claimDraftForDeletion(user.id, attachmentId);
  } catch {
    return errorResponse("attachment_delete_failed", 500);
  }
  if (!attachment) {
    return deletedResponse();
  }
  if (!attachment.deletionClaimToken) {
    return errorResponse("attachment_delete_failed", 500);
  }
  const deletionClaimToken = attachment.deletionClaimToken;

  const releaseClaim = async () => {
    try {
      return await attachments.releaseDeletionClaim(
        user.id,
        attachment.id,
        deletionClaimToken,
        "attachment_delete_failed",
      );
    } catch {
      return false;
    }
  };

  try {
    await deleteAttachment(readEnv().attachmentStorageDir, attachment.storageKey);
  } catch {
    await releaseClaim();
    return errorResponse("attachment_delete_failed", 500);
  }

  try {
    const deleted = await attachments.deleteDraft(
      user.id,
      attachment.id,
      deletionClaimToken,
    );
    if (!deleted) {
      await releaseClaim();
      return errorResponse("attachment_delete_failed", 500);
    }
  } catch {
    await releaseClaim();
    return errorResponse("attachment_delete_failed", 500);
  }

  return deletedResponse();
}
