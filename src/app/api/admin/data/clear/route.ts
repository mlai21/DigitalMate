import { NextResponse } from "next/server";
import { deleteAttachment } from "@/server/attachments/storage";
import { userConnectionDisconnector } from "@/server/admin/user-connections";
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
  let releaseConnectionDrain: (() => void) | undefined;
  try {
    releaseMutationLock = await repositories.userDataMutations.acquireLock(user.id);
    releaseConnectionDrain = await userConnectionDisconnector.disconnectUser(user.id);
    const storageKeys = await repositories.personalData.listAttachmentStorageKeys(user.id);
    const storageRoot = readEnv().attachmentStorageDir;
    // Delete blobs first. If any deletion fails, DB keys remain available for a safe retry.
    for (const storageKey of storageKeys) {
      await deleteAttachment(storageRoot, storageKey);
    }
    await deleteArtifactTree(defaultArtifactRoot(), user.id);
    await repositories.personalData.clear(user.id);
    return NextResponse.redirect(redirectUrl(request, "/admin/settings?cleared=1"), { status: 303 });
  } catch (error) {
    console.error("personal_data_clear_failed", {
      code: "personal_data_clear_failed",
      errorType: error instanceof Error ? "Error" : "NonError",
    });
    return NextResponse.json({ error: "personal_data_clear_failed" }, { status: 500 });
  } finally {
    releaseConnectionDrain?.();
    if (releaseMutationLock) {
      await releaseMutationLock().catch(() => {
        console.error("user_data_mutation_lock_release_failed", { code: "user_data_mutation_lock_release_failed" });
      });
    }
  }
}
