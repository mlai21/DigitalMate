import { NextResponse } from "next/server";
import { withFreshUserDataLease } from "@/server/admin/user-data-lease";
import { requireCurrentUser } from "@/server/auth/current-user";
import { redirectUrl } from "@/server/http/redirect";
import { resolveDefaultAgentScope } from "@/server/agents/service";

export async function POST(request: Request) {
  const user = await requireCurrentUser();
  return withFreshUserDataLease(user.id, async (repositories) => {
    const form = await request.formData();
    const memoryId = String(form.get("memoryId") ?? "");
    const scope = await resolveDefaultAgentScope(user.id, repositories.agents);
    if (memoryId) {
      await repositories.memories.delete(scope, memoryId);
    }
    return NextResponse.redirect(redirectUrl(request, "/admin/memories"), { status: 303 });
  });
}
