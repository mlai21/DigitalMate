import { cookies } from "next/headers";
import { createRepositories } from "@/server/db/repositories";
import { readEnv } from "@/server/config/env";
import { sessionCookieName, verifySessionToken } from "@/server/auth/session";

export async function getCurrentUser() {
  const env = readEnv();
  const repositories = createRepositories();
  const defaultUser = await repositories.users.ensureDefault();

  if (!env.appPassword && process.env.NODE_ENV !== "production") {
    return defaultUser;
  }

  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieName)?.value;
  if (!token) return null;

  const userId = await verifySessionToken(token, env.appSecret);
  return userId === defaultUser.id ? defaultUser : null;
}

export async function requireCurrentUser() {
  const user = await getCurrentUser();
  if (!user) {
    throw new Error("Unauthorized");
  }
  return user;
}
