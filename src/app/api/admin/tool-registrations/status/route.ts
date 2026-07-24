import { NextResponse } from "next/server";
import { withFreshUserDataLease } from "@/server/admin/user-data-lease";
import { requireCurrentUser } from "@/server/auth/current-user";
import { redirectUrl } from "@/server/http/redirect";

export async function POST(request: Request) {
  const user = await requireCurrentUser();
  return withFreshUserDataLease(user.id, async (repositories) => {
    const form = await request.formData();
    const toolId = String(form.get("toolId") ?? "");
    const status = String(form.get("status") ?? "");
    if (toolId && (status === "enabled" || status === "disabled" || status === "rejected")) {
      await repositories.toolRegistrations.setStatus(user.id, toolId, status);
    }
    return NextResponse.redirect(redirectUrl(request, "/admin/tool-registrations"), { status: 303 });
  });
}
