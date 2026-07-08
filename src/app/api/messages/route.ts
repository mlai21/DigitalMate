import { NextResponse } from "next/server";
import { requireCurrentUser } from "@/server/auth/current-user";
import { createRepositories } from "@/server/db/repositories";

export const runtime = "nodejs";

export async function GET(request: Request) {
  let user;
  try {
    user = await requireCurrentUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const conversation = await createRepositories().conversations.getOrCreateDefault(user.id);
  const after = url.searchParams.get("after") ? new Date(url.searchParams.get("after") as string) : new Date(0);
  const messages = await createRepositories().messages.listAfter(conversation.id, after);

  return NextResponse.json({ messages });
}
