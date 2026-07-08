import { NextResponse } from "next/server";
import { requireCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";
import { redirectUrl } from "@/server/http/redirect";

export async function POST(request: Request) {
  const user = await requireCurrentUser();
  const form = await request.formData();
  const skillId = String(form.get("skillId") ?? "");
  const status = String(form.get("status") ?? "");
  if (skillId && (status === "enabled" || status === "disabled" || status === "rejected")) {
    await createRepositories().skills.setStatus(user.id, skillId, status);
  }
  return NextResponse.redirect(redirectUrl(request, "/admin/skills"), { status: 303 });
}
