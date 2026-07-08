import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { sessionCookieName } from "@/server/auth/session";
import { redirectUrl } from "@/server/http/redirect";

export async function POST(request: Request) {
  const cookieStore = await cookies();
  cookieStore.delete(sessionCookieName);
  return NextResponse.redirect(redirectUrl(request, "/login"), { status: 303 });
}
