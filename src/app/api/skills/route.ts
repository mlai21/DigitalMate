import { NextResponse } from "next/server";
import { withFreshUserDataLease } from "@/server/admin/user-data-lease";
import { requireCurrentUser } from "@/server/auth/current-user";

export const runtime = "nodejs";

/** Enabled-skill index for the chat slash picker (P1-11). */
export async function GET() {
  let user;
  try {
    user = await requireCurrentUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  return withFreshUserDataLease(user.id, async (repositories) => {
    const skills = await repositories.skills.listEnabled(user.id);
    return NextResponse.json({
      skills: skills.map((skill) => ({ id: skill.id, name: skill.name, trigger: skill.trigger })),
    });
  });
}
