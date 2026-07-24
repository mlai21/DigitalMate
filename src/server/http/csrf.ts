import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const csrfTokenLifetimeSeconds = 30 * 60;

const base64UrlPattern = /^[A-Za-z0-9_-]+$/;
const userIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const sha256Base64UrlLength = 43;
const nonceBase64UrlLength = 24;

type CreateCsrfTokenInput = {
  userId: string;
  sessionToken: string;
  secret: string;
  now?: Date;
};

type VerifyCsrfTokenInput = CreateCsrfTokenInput;

export function deriveCsrfSecret(appSecret: string): string {
  return createHmac("sha256", requireSecret(appSecret))
    .update("digitalmate:admin-csrf:v1")
    .digest("base64url");
}

export function createCsrfToken(input: CreateCsrfTokenInput): string {
  const userId = requireUserId(input.userId);
  const sessionToken = requireSessionToken(input.sessionToken);
  const secret = requireSecret(input.secret);
  const nowSeconds = toEpochSeconds(input.now ?? new Date());
  const expiresAt = nowSeconds + csrfTokenLifetimeSeconds;
  const nonce = randomBytes(18).toString("base64url");
  const sessionHash = hashSession(sessionToken);
  const payload = `${userId}.${sessionHash}.${expiresAt}.${nonce}`;
  const signature = sign(payload, secret);
  return `${payload}.${signature}`;
}

export function verifyCsrfToken(
  token: string,
  input: VerifyCsrfTokenInput,
): boolean {
  try {
    if (
      typeof token !== "string" ||
      token.length < 1 ||
      token.length > 512
    ) {
      return false;
    }
    const userId = requireUserId(input.userId);
    const sessionToken = requireSessionToken(input.sessionToken);
    const secret = requireSecret(input.secret);
    const nowSeconds = toEpochSeconds(input.now ?? new Date());
    const parts = token.split(".");
    if (parts.length !== 5) return false;

    const [
      tokenUserId,
      tokenSessionHash,
      expiresAtText,
      nonce,
      signature,
    ] = parts;
    if (
      !tokenUserId ||
      !tokenSessionHash ||
      !expiresAtText ||
      !nonce ||
      !signature ||
      !userIdPattern.test(tokenUserId) ||
      tokenSessionHash.length !== sha256Base64UrlLength ||
      !base64UrlPattern.test(tokenSessionHash) ||
      nonce.length !== nonceBase64UrlLength ||
      !base64UrlPattern.test(nonce) ||
      signature.length !== sha256Base64UrlLength ||
      !base64UrlPattern.test(signature) ||
      !/^[1-9]\d{0,11}$/.test(expiresAtText)
    ) {
      return false;
    }

    const expiresAt = Number(expiresAtText);
    if (
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= nowSeconds ||
      expiresAt > nowSeconds + csrfTokenLifetimeSeconds
    ) {
      return false;
    }

    const expectedSessionHash = hashSession(sessionToken);
    const payload = parts.slice(0, 4).join(".");
    const expectedSignature = sign(payload, secret);
    const userMatches = safeEqual(tokenUserId, userId);
    const sessionMatches = safeEqual(
      tokenSessionHash,
      expectedSessionHash,
    );
    const signatureMatches = safeEqual(signature, expectedSignature);
    return userMatches && sessionMatches && signatureMatches;
  } catch {
    return false;
  }
}

function hashSession(sessionToken: string): string {
  return createHash("sha256").update(sessionToken).digest("base64url");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function requireSecret(secret: string): string {
  if (typeof secret !== "string" || secret.length < 16) {
    throw new Error("invalid_secret");
  }
  return secret;
}

function requireSessionToken(sessionToken: string): string {
  if (
    typeof sessionToken !== "string" ||
    sessionToken.length < 1 ||
    sessionToken.length > 2_048
  ) {
    throw new Error("invalid_session");
  }
  return sessionToken;
}

function requireUserId(userId: string): string {
  if (!userIdPattern.test(userId)) {
    throw new Error("invalid_user");
  }
  return userId;
}

function toEpochSeconds(now: Date): number {
  const timestamp = now.getTime();
  if (!Number.isFinite(timestamp)) throw new Error("invalid_time");
  return Math.floor(timestamp / 1_000);
}
