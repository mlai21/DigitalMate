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
  try {
    // Capture only this user's keys before cascading message deletion removes the lookup data.
    const storageKeys = await repositories.personalData.listAttachmentStorageKeys(user.id);
    await repositories.personalData.clear(user.id);
    const storageRoot = readEnv().attachmentStorageDir;
    for (const storageKey of storageKeys) {
      await deleteAttachment(storageRoot, storageKey);
    }
    await deleteArtifactTree(defaultArtifactRoot(), user.id);
    return NextResponse.redirect(redirectUrl(request, "/admin/settings?cleared=1"), { status: 303 });
  } catch (error) {
    console.error("personal_data_clear_failed", {
      code: "personal_data_clear_failed",
      errorType: error instanceof Error ? "Error" : "NonError",
    });
    return NextResponse.json({ error: "personal_data_clear_failed" }, { status: 500 });
  }
}
