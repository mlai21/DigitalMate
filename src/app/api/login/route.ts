import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  createSessionToken,
  sessionCookieName,
  sessionLifetimeSeconds,
  shouldUseSecureSessionCookie,
  verifyPassword,
} from "@/server/auth/session";
import { readEnv } from "@/server/config/env";
import { createRepositories } from "@/server/db/repositories";
import { sanitizeInternalRedirect } from "@/server/http/internal-redirect";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const env = readEnv();
  const formData = await request.formData();
  const password = String(formData.get("password") ?? "");
  const redirect = sanitizeInternalRedirect(formData.get("redirect"));

  if (env.appPassword && !(await verifyPassword(password, env.appPassword))) {
    return redirectResponse(
      `/login?error=1&redirect=${encodeURIComponent(redirect)}`,
    );
  }

  if (!env.appPassword && process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "APP_PASSWORD is required in production" }, { status: 500 });
  }

  try {
    const repositories = createRepositories();
    const user = await repositories.users.ensureDefault();
    const generation = await repositories.sessionStates.rotate(user.id);
    const token = await createSessionToken(
      user.id,
      generation,
      env.appSecret,
    );
    const cookieStore = await cookies();
    cookieStore.set(sessionCookieName, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: shouldUseSecureSessionCookie(request, {
        trustProxyHeaders: env.trustProxyHeaders,
      }),
      path: "/",
      maxAge: sessionLifetimeSeconds,
    });
  } catch {
    return NextResponse.json(
      { error: "session_unavailable" },
      { status: 500 },
    );
  }

  return redirectResponse(redirect);
}

function redirectResponse(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location,
      "cache-control": "no-store",
    },
  });
}
