import { NextResponse } from "next/server";
import { withFreshUserDataLease } from "@/server/admin/user-data-lease";
import { requireCurrentUser } from "@/server/auth/current-user";
import { readEnv } from "@/server/config/env";

export const runtime = "nodejs";

export async function GET() {
  const user = await requireCurrentUser();
  try {
    return await withFreshUserDataLease(user.id, async (repositories) => {
      const keyState = readEnv().channelSecretsKey;
      const data = await repositories.personalData.export(
        user.id,
        keyState.status === "ready" ? keyState.key : null,
      );
      return NextResponse.json(data, {
        headers: {
          "content-disposition": `attachment; filename="digitalmate-data-${user.id}.json"`,
        },
      });
    });
  } catch {
    console.error("personal_data_export_failed", {
      code: "personal_data_export_failed",
    });
    return NextResponse.json(
      { error: "personal_data_export_failed" },
      { status: 500 },
    );
  }
}
