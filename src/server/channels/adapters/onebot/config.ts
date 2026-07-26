import {
  getChannelManifest,
} from "@/server/channels/manifests/catalog";

export type OneBotConfig = Readonly<
  Record<string, unknown> & {
    enabled: boolean;
    bot_prefix: string;
    access_token: string;
    share_session_in_group: boolean;
    ws_host: "0.0.0.0";
    ws_port: 6199;
  }
>;

export const oneBotConfigSchema =
  getChannelManifest("onebot").configSchema;

export function parseOneBotConfig(input: unknown): OneBotConfig {
  const parsed = oneBotConfigSchema.parse(input);
  const accessToken = typeof parsed.access_token === "string"
    ? parsed.access_token.trim()
    : "";
  if (accessToken.length === 0) {
    throw new Error("onebot_access_token_required");
  }
  return {
    ...parsed,
    access_token: accessToken,
    // These fields exist for QwenPaw Console compatibility only. The
    // isolated channel gateway owns the actual listener and route.
    ws_host: "0.0.0.0",
    ws_port: 6_199,
  } as OneBotConfig;
}
