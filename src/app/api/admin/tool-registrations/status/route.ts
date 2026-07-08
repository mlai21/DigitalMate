import { NextResponse } from "next/server";
import { requireCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";
import { redirectUrl } from "@/server/http/redirect";

export async function POST(request: Request) {
  const user = await requireCurrentUser();
  const form = await request.formData();
  const toolId = String(form.get("toolId") ?? "");
  const status = String(form.get("status") ?? "");
  if (toolId && (status === "enabled" || status === "disabled" || status === "rejected")) {
    await createRepositories().toolRegistrations.setStatus(user.id, toolId, status);
  }
  return NextResponse.redirect(redirectUrl(request, "/admin/tool-registrations"), { status: 303 });
}
