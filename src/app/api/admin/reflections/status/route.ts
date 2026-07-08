import { NextResponse } from "next/server";
import { requireCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";
import { redirectUrl } from "@/server/http/redirect";

export async function POST(request: Request) {
  const user = await requireCurrentUser();
  const form = await request.formData();
  const reflectionId = String(form.get("reflectionId") ?? "");
  const status = String(form.get("status") ?? "");
  if (reflectionId && (status === "applied" || status === "dismissed")) {
    await createRepositories().reflections.setStatus(user.id, reflectionId, status);
  }
  return NextResponse.redirect(redirectUrl(request, "/admin/reflections"), { status: 303 });
}
