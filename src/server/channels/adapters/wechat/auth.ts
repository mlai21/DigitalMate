import { randomInt } from "node:crypto";

export function createWechatHeaders(
  botToken = "",
  randomUint32: () => number = () =>
    randomInt(0, 0x1_0000_0000),
): Record<string, string> {
  const value = randomUint32();
  if (
    !Number.isSafeInteger(value)
    || value < 0
    || value > 0xffff_ffff
  ) {
    throw new Error("wechat_uin_invalid");
  }
  return {
    "content-type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": Buffer.from(
      String(value),
      "utf8",
    ).toString("base64"),
    ...(botToken
      ? { Authorization: `Bearer ${botToken}` }
      : {}),
  };
}
