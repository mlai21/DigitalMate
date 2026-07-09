import { NextResponse } from "next/server";
import { requireCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";
import { redirectUrl } from "@/server/http/redirect";

export async function POST(request: Request) {
  const user = await requireCurrentUser();
  const form = await request.formData();
  const revisionId = String(form.get("revisionId") ?? "");
  const decision = String(form.get("decision") ?? "");

  if (revisionId && (decision === "applied" || decision === "rejected")) {
    const repositories = createRepositories();
    const revision = await repositories.skillRevisions.get(user.id, revisionId);
    if (revision && revision.status === "pending") {
      if (decision === "applied") {
        await repositories.skills.applyRevision(user.id, revision.skillId, revision.proposedContent);
      }
      await repositories.skillRevisions.setStatus(user.id, revisionId, decision);
    }
  }

  return NextResponse.redirect(redirectUrl(request, "/admin/skills"), { status: 303 });
}
