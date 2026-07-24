import { NextResponse } from "next/server";
import { withFreshUserDataLease } from "@/server/admin/user-data-lease";
import { requireCurrentUser } from "@/server/auth/current-user";
import { redirectUrl } from "@/server/http/redirect";

export async function POST(request: Request) {
  const user = await requireCurrentUser();
  return withFreshUserDataLease(user.id, async (repositories) => {
    const form = await request.formData();
    const skillId = String(form.get("skillId") ?? "");
    const status = String(form.get("status") ?? "");
    if (skillId && (status === "enabled" || status === "disabled" || status === "rejected")) {
      await repositories.skills.setStatus(user.id, skillId, status);
    }
    return NextResponse.redirect(redirectUrl(request, "/admin/skills"), { status: 303 });
  });
}
