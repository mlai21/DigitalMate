import { NextResponse } from "next/server";
import { requireCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";
import { redirectUrl } from "@/server/http/redirect";
import { defaultArtifactRoot, deleteArtifactTree } from "@/server/tasks/artifacts";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await requireCurrentUser();
  await createRepositories().personalData.clear(user.id);
  await deleteArtifactTree(defaultArtifactRoot(), user.id);
  return NextResponse.redirect(redirectUrl(request, "/admin/settings?cleared=1"), { status: 303 });
}
