import { timingSafeEqual } from "node:crypto";

type JsonObject = Record<string, unknown>;

export function verifyTelegramWebhookSecret(configuredSecret: string | undefined, receivedSecret: string | null): boolean {
  if (!configuredSecret) return true;
  if (!receivedSecret) return false;
  return safeEqual(receivedSecret, configuredSecret);
}

export function verifyFeishuVerificationToken(configuredToken: string | undefined, payload: unknown): boolean {
  if (!configuredToken) return true;

  const body = asObject(payload);
  const header = asObject(body?.header);
  const receivedToken = readString(header, "token") ?? readString(body, "token");
  if (!receivedToken) return false;

  return safeEqual(receivedToken, configuredToken);
}

export function verifyDingTalkRobotCode(configuredRobotCode: string | undefined, payload: unknown): boolean {
  if (!configuredRobotCode) return true;

  const body = asObject(payload);
  const receivedRobotCode = readString(body, "robotCode");
  if (!receivedRobotCode) return false;

  return safeEqual(receivedRobotCode, configuredRobotCode);
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
}

function readString(object: JsonObject | null, key: string): string | null {
  const value = object?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}
