import { NextResponse } from "next/server";
import { withFreshUserDataLease } from "@/server/admin/user-data-lease";
import { requireCurrentUser } from "@/server/auth/current-user";
import { readEnv } from "@/server/config/env";

export const runtime = "nodejs";

const PRIVATE_NO_STORE_HEADERS = {
  "cache-control": "private, no-store",
  pragma: "no-cache",
} as const;

export async function GET(request: Request) {
  const user = await requireCurrentUser();
  try {
    return await withFreshUserDataLease(user.id, async (repositories, signal) => {
      const keyState = readEnv().channelSecretsKey;
      const data = await repositories.personalData.export(
        user.id,
        keyState.status === "ready" ? keyState.key : null,
        signal,
      );
      return NextResponse.json(data, {
        headers: {
          ...PRIVATE_NO_STORE_HEADERS,
          "content-disposition": `attachment; filename="digitalmate-data-${user.id}.json"`,
        },
      });
    }, { signal: request.signal });
  } catch {
    console.error("personal_data_export_failed", {
      code: "personal_data_export_failed",
    });
    return NextResponse.json(
      { error: "personal_data_export_failed" },
      {
        status: 500,
        headers: PRIVATE_NO_STORE_HEADERS,
      },
    );
  }
}
