import { NextResponse } from "next/server";
import { requireCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";

export const runtime = "nodejs";

export async function GET() {
  const user = await requireCurrentUser();
  const data = await createRepositories().personalData.export(user.id);

  return NextResponse.json(data, {
    headers: {
      "content-disposition": `attachment; filename="digitalmate-data-${user.id}.json"`,
    },
  });
}
