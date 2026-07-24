import { NextResponse } from "next/server";
import { withFreshUserDataLease } from "@/server/admin/user-data-lease";
import { requireCurrentUser } from "@/server/auth/current-user";
import { createSkillDraft } from "@/server/evolution/skills";
import { redirectUrl } from "@/server/http/redirect";

export async function POST(request: Request) {
  const user = await requireCurrentUser();
  return withFreshUserDataLease(user.id, async (repositories) => {
    const form = await request.formData();
    const name = String(form.get("name") ?? "").trim();
    const trigger = String(form.get("trigger") ?? "").trim();
    const steps = String(form.get("steps") ?? "")
      .split(/\r?\n/)
      .map((step) => step.replace(/^[-*\d.\s]+/, "").trim())
      .filter(Boolean);

    if (name && trigger && steps.length > 0) {
      await repositories.skills.create(user.id, createSkillDraft({ name, trigger, steps }));
    }

    return NextResponse.redirect(redirectUrl(request, "/admin/skills"), { status: 303 });
  });
}
