import { NextResponse } from "next/server";
import { requireCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";
import { redirectUrl } from "@/server/http/redirect";
import { buildSettingsUpdate } from "@/server/settings/update";
import { resolveDefaultAgentScope } from "@/server/agents/service";

export async function POST(request: Request) {
  const user = await requireCurrentUser();
  const form = await request.formData();
  const repositories = createRepositories();
  const scope = await resolveDefaultAgentScope(user.id, repositories.agents);
  const current = await repositories.settings.get(scope);
  await repositories.settings.update(scope, buildSettingsUpdate(current, form));
  const requested = String(form.get("redirectTo") ?? "");
  const target = requested === "/admin/models" ? requested : "/admin/settings";
  return NextResponse.redirect(redirectUrl(request, target), { status: 303 });
}
