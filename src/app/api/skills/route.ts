import { NextResponse } from "next/server";
import { requireCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";

export const runtime = "nodejs";

/** Enabled-skill index for the chat slash picker (P1-11). */
export async function GET() {
  let user;
  try {
    user = await requireCurrentUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const skills = await createRepositories().skills.listEnabled(user.id);
  return NextResponse.json({
    skills: skills.map((skill) => ({ id: skill.id, name: skill.name, trigger: skill.trigger })),
  });
}
