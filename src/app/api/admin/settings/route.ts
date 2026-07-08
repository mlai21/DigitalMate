import { NextResponse } from "next/server";
import { requireCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";
import { redirectUrl } from "@/server/http/redirect";
import { buildSettingsUpdate } from "@/server/settings/update";

export async function POST(request: Request) {
  const user = await requireCurrentUser();
  const form = await request.formData();
  const repositories = createRepositories();
  const current = await repositories.settings.get(user.id);
  await repositories.settings.update(user.id, buildSettingsUpdate(current, form));
  return NextResponse.redirect(redirectUrl(request, "/admin/settings"), { status: 303 });
}
