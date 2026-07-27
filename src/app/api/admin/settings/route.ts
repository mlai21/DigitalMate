import { NextResponse } from "next/server";
import { withFreshUserDataLease } from "@/server/admin/user-data-lease";
import { requireCurrentUser } from "@/server/auth/current-user";
import { redirectUrl } from "@/server/http/redirect";
import { buildSettingsUpdate } from "@/server/settings/update";
import { resolveDefaultAgentScope } from "@/server/agents/service";

export async function POST(request: Request) {
  const user = await requireCurrentUser();
  return withFreshUserDataLease(user.id, async (repositories) => {
    const form = await request.formData();
    const scope = await resolveDefaultAgentScope(user.id, repositories.agents);
    const current = await repositories.settings.get(scope);
    await repositories.settings.update(scope, buildSettingsUpdate(current, form));
    const requested = String(form.get("redirectTo") ?? "");
    const target = requested === "/admin-legacy/models"
      ? requested
      : "/admin-legacy/settings";
    return NextResponse.redirect(redirectUrl(request, target), { status: 303 });
  });
}
