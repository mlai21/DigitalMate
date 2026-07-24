import {
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import {
  resolveRequestOrigin,
  type RequestOriginOptions,
} from "@/server/http/request-origin";

export const sessionCookieName = "dm_session";
export const sessionLifetimeSeconds = 60 * 60 * 24 * 30;
const scrypt = promisify(scryptCallback);

export type VerifiedSession = Readonly<{
  userId: string;
  generation: number;
  issuedAt: Date;
  expiresAt: Date;
  sessionId: string;
}>;

export type SessionGenerationLoader = (
  userId: string,
) => Promise<number | null>;

export async function createSessionToken(
  userId: string,
  generation: number,
  secret: string,
  now: Date = new Date(),
): Promise<string> {
  const issuedAt = now.getTime();
  const payload = base64UrlEncode(
    JSON.stringify({
      v: 1,
      sub: userId,
      gen: generation,
      iat: issuedAt,
      exp: issuedAt + sessionLifetimeSeconds * 1_000,
      jti: randomBytes(18).toString("base64url"),
    }),
  );
  const signature = sign(payload, secret);
  return `${payload}.${signature}`;
}

export async function verifySessionToken(
  token: string,
  secret: string,
  now: Date = new Date(),
): Promise<VerifiedSession | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [payload, signature] = parts;
  if (
    !payload ||
    !signature ||
    payload.length > 2_048 ||
    !/^[A-Za-z0-9_-]+$/.test(payload) ||
    !/^[A-Za-z0-9_-]{43}$/.test(signature)
  ) {
    return null;
  }

  const expected = sign(payload, secret);
  if (!safeEqual(signature, expected)) return null;

  try {
    const decoded = base64UrlDecode(payload);
    if (base64UrlEncode(decoded) !== payload) return null;
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    if (
      !hasOnlySessionClaimKeys(parsed) ||
      parsed.v !== 1 ||
      typeof parsed.sub !== "string" ||
      parsed.sub.length === 0 ||
      parsed.sub.length > 128 ||
      !Number.isSafeInteger(parsed.gen) ||
      Number(parsed.gen) < 1 ||
      !Number.isSafeInteger(parsed.iat) ||
      !Number.isSafeInteger(parsed.exp) ||
      typeof parsed.jti !== "string" ||
      !/^[A-Za-z0-9_-]{24}$/.test(parsed.jti)
    ) {
      return null;
    }

    const issuedAt = Number(parsed.iat);
    const expiresAt = Number(parsed.exp);
    const nowMs = now.getTime();
    if (
      !Number.isFinite(nowMs) ||
      expiresAt - issuedAt !== sessionLifetimeSeconds * 1_000 ||
      expiresAt <= nowMs ||
      issuedAt > nowMs + 60_000
    ) {
      return null;
    }

    return {
      userId: parsed.sub,
      generation: Number(parsed.gen),
      issuedAt: new Date(issuedAt),
      expiresAt: new Date(expiresAt),
      sessionId: parsed.jti,
    };
  } catch {
    return null;
  }
}

export async function verifySessionRequest(
  request: Request,
  defaultUserId: string,
  secret: string,
  loadGeneration: SessionGenerationLoader,
  now: Date = new Date(),
): Promise<string | null> {
  const sessionToken = getSessionTokenFromRequest(request);
  if (!sessionToken) return null;

  const session = await verifySessionToken(sessionToken, secret, now);
  if (!session || !safeEqual(session.userId, defaultUserId)) return null;
  const currentGeneration = await loadGeneration(session.userId);
  return currentGeneration === session.generation ? session.userId : null;
}

export function getSessionTokenFromRequest(
  request: Request,
): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;

  let sessionToken: string | null = null;
  let foundSessionCookie = false;
  for (const rawCookie of cookieHeader.split(";")) {
    const cookie = rawCookie.trim();
    if (!cookie) continue;

    const separatorIndex = cookie.indexOf("=");
    if (separatorIndex < 0) {
      if (cookie === sessionCookieName) return null;
      continue;
    }

    const name = cookie.slice(0, separatorIndex).trim();
    if (name !== sessionCookieName) continue;
    if (foundSessionCookie) return null;
    foundSessionCookie = true;

    const value = cookie.slice(separatorIndex + 1).trim();
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) return null;
    sessionToken = value;
  }
  return sessionToken;
}

export function hasSessionCookie(request: Request): boolean {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return false;
  return cookieHeader.split(";").some((rawCookie) => {
    const cookie = rawCookie.trim();
    const separatorIndex = cookie.indexOf("=");
    const name = separatorIndex < 0
      ? cookie
      : cookie.slice(0, separatorIndex).trim();
    return name === sessionCookieName;
  });
}

export async function verifyPassword(input: string, expected: string): Promise<boolean> {
  const [left, right] = await Promise.all([hashPassword(input), hashPassword(expected)]);
  return timingSafeEqual(left, right);
}

export function shouldUseSecureSessionCookie(
  request: Request,
  options: RequestOriginOptions = {},
): boolean {
  const origin = resolveRequestOrigin(request, options);
  return origin?.startsWith("https://") ?? false;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

async function hashPassword(password: string): Promise<Buffer> {
  return (await scrypt(password, "digitalmate-app-password", 32)) as Buffer;
}

function hasOnlySessionClaimKeys(
  value: Record<string, unknown>,
): boolean {
  const keys = Object.keys(value).sort();
  return keys.join(",") === "exp,gen,iat,jti,sub,v";
}
