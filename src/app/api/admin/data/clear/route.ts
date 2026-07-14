import { NextResponse } from "next/server";
import { deleteAttachment } from "@/server/attachments/storage";
import { requireCurrentUser } from "@/server/auth/current-user";
import { readEnv } from "@/server/config/env";
import { createRepositories } from "@/server/db/repositories";
import { redirectUrl } from "@/server/http/redirect";
import { defaultArtifactRoot, deleteArtifactTree } from "@/server/tasks/artifacts";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await requireCurrentUser();
  const repositories = createRepositories();
  let releaseMutationLock: (() => Promise<void>) | undefined;
  try {
    releaseMutationLock = await repositories.messageAttachments.acquireUserMutationLock(user.id);
    const storageKeys = await repositories.personalData.listAttachmentStorageKeys(user.id);
    const storageRoot = readEnv().attachmentStorageDir;
    // Delete blobs first. If any deletion fails, DB keys remain available for a safe retry.
    for (const storageKey of storageKeys) {
      await deleteAttachment(storageRoot, storageKey);
    }
    await repositories.personalData.clear(user.id);
    await deleteArtifactTree(defaultArtifactRoot(), user.id);
    return NextResponse.redirect(redirectUrl(request, "/admin/settings?cleared=1"), { status: 303 });
  } catch (error) {
    console.error("personal_data_clear_failed", {
      code: "personal_data_clear_failed",
      errorType: error instanceof Error ? "Error" : "NonError",
    });
    return NextResponse.json({ error: "personal_data_clear_failed" }, { status: 500 });
  } finally {
    if (releaseMutationLock) {
      await releaseMutationLock().catch(() => {
        console.error("attachment_mutation_lock_release_failed", { code: "attachment_mutation_lock_release_failed" });
      });
    }
  }
}
