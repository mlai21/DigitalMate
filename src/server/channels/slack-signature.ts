import { createHmac, timingSafeEqual } from "node:crypto";

const SLACK_SIGNATURE_VERSION = "v0";
const MAX_TIMESTAMP_SKEW_SECONDS = 60 * 5;

type VerifySlackRequestInput = {
  signingSecret: string | undefined;
  timestamp: string | null;
  signature: string | null;
  body: string;
  now?: Date;
};

export function verifySlackRequest(input: VerifySlackRequestInput): boolean {
  if (!input.signingSecret || !input.timestamp || !input.signature) return false;

  const timestampSeconds = Number(input.timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;

  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > MAX_TIMESTAMP_SKEW_SECONDS) return false;

  const baseString = `${SLACK_SIGNATURE_VERSION}:${input.timestamp}:${input.body}`;
  const expectedSignature = `${SLACK_SIGNATURE_VERSION}=${createHmac("sha256", input.signingSecret)
    .update(baseString)
    .digest("hex")}`;

  return safeEqual(input.signature, expectedSignature);
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
