import { NextResponse } from "next/server";
import { withFreshUserDataLease } from "@/server/admin/user-data-lease";
import { requireCurrentUser } from "@/server/auth/current-user";
import { redirectUrl } from "@/server/http/redirect";
import { resolveDefaultAgentScope } from "@/server/agents/service";

export async function POST(request: Request) {
  const user = await requireCurrentUser();
  return withFreshUserDataLease(user.id, async (repositories) => {
    const form = await request.formData();
    const reflectionId = String(form.get("reflectionId") ?? "");
    const status = String(form.get("status") ?? "");
    const scope = await resolveDefaultAgentScope(user.id, repositories.agents);
    if (reflectionId && (status === "applied" || status === "dismissed")) {
      await repositories.reflections.setStatus(scope, reflectionId, status);
    }
    return NextResponse.redirect(redirectUrl(request, "/admin/reflections"), { status: 303 });
  });
}
