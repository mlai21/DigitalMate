import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createSessionToken, sessionCookieName, shouldUseSecureSessionCookie, verifyPassword } from "@/server/auth/session";
import { readEnv } from "@/server/config/env";
import { createRepositories } from "@/server/db/repositories";
import { redirectUrl } from "@/server/http/redirect";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const env = readEnv();
  const formData = await request.formData();
  const password = String(formData.get("password") ?? "");

  if (env.appPassword && !(await verifyPassword(password, env.appPassword))) {
    return NextResponse.redirect(redirectUrl(request, "/login?error=1"), { status: 303 });
  }

  if (!env.appPassword && process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "APP_PASSWORD is required in production" }, { status: 500 });
  }

  const user = await createRepositories().users.ensureDefault();
  const token = await createSessionToken(user.id, env.appSecret);
  const cookieStore = await cookies();
  cookieStore.set(sessionCookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureSessionCookie(request),
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });

  return NextResponse.redirect(redirectUrl(request, "/"), { status: 303 });
}
