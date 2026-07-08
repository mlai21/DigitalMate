import { createHmac, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

export const sessionCookieName = "dm_session";
const scrypt = promisify(scryptCallback);

export async function createSessionToken(userId: string, secret: string): Promise<string> {
  const payload = base64UrlEncode(JSON.stringify({ sub: userId, iat: Date.now() }));
  const signature = sign(payload, secret);
  return `${payload}.${signature}`;
}

export async function verifySessionToken(token: string, secret: string): Promise<string | null> {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;

  const expected = sign(payload, secret);
  if (!safeEqual(signature, expected)) return null;

  try {
    const parsed = JSON.parse(base64UrlDecode(payload)) as { sub?: unknown };
    return typeof parsed.sub === "string" ? parsed.sub : null;
  } catch {
    return null;
  }
}

export async function verifyPassword(input: string, expected: string): Promise<boolean> {
  const [left, right] = await Promise.all([hashPassword(input), hashPassword(expected)]);
  return timingSafeEqual(left, right);
}

export function shouldUseSecureSessionCookie(request: Request): boolean {
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwardedProto) return forwardedProto === "https";

  return new URL(request.url).protocol === "https:";
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
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
