import { NextResponse } from "next/server";
import { requireCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";
import { redirectUrl } from "@/server/http/redirect";

export async function POST(request: Request) {
  const user = await requireCurrentUser();
  const form = await request.formData();
  const memoryId = String(form.get("memoryId") ?? "");
  if (memoryId) {
    await createRepositories().memories.delete(user.id, memoryId);
  }
  return NextResponse.redirect(redirectUrl(request, "/admin/memories"), { status: 303 });
}
