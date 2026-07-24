import { NextResponse } from "next/server";
import { withFreshUserDataLease } from "@/server/admin/user-data-lease";
import { requireCurrentUser } from "@/server/auth/current-user";

export const runtime = "nodejs";

export async function GET() {
  const user = await requireCurrentUser();
  return withFreshUserDataLease(user.id, async (repositories) => {
    const data = await repositories.personalData.export(user.id);
    return NextResponse.json(data, {
      headers: {
        "content-disposition": `attachment; filename="digitalmate-data-${user.id}.json"`,
      },
    });
  });
}
