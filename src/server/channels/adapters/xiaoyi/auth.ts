import { createHmac } from "node:crypto";

export function generateXiaoYiSignature(
  secretKey: string,
  timestamp: string,
): string {
  return createHmac("sha256", secretKey)
    .update(timestamp)
    .digest("base64");
}

export function generateXiaoYiAuthHeaders(
  accessKey: string,
  secretKey: string,
  agentId: string,
  timestampMs = Date.now(),
): Readonly<Record<string, string>> {
  if (
    !Number.isSafeInteger(timestampMs)
    || timestampMs < 0
  ) {
    throw new Error("xiaoyi_auth_timestamp_invalid");
  }
  const timestamp = String(timestampMs);
  return {
    "x-access-key": accessKey,
    "x-sign": generateXiaoYiSignature(
      secretKey,
      timestamp,
    ),
    "x-ts": timestamp,
    "x-agent-id": agentId,
  };
}
