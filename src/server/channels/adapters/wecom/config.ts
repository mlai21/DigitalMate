import {
  getChannelManifest,
} from "@/server/channels/manifests/catalog";

export type WeComConfig = Readonly<
  Record<string, unknown> & {
    enabled: boolean;
    bot_id: string;
    secret: string;
    media_dir: string | null;
    welcome_text: string;
    share_session_in_group: boolean;
    max_reconnect_attempts: number;
    streaming_enabled: boolean;
    bot_prefix: string;
    filter_tool_messages: true;
    filter_thinking: true;
  }
>;

export const weComConfigSchema =
  getChannelManifest("wecom").configSchema;

export function parseWeComConfig(input: unknown): WeComConfig {
  const parsed = weComConfigSchema.parse(input) as WeComConfig;
  const botId = parsed.bot_id.trim();
  const secret = parsed.secret.trim();
  const welcomeText = parsed.welcome_text.trim();

  if (!botId) {
    throw new Error("wecom_bot_id_required");
  }
  if (!secret) {
    throw new Error("wecom_secret_required");
  }
  if (parsed.max_reconnect_attempts < -1) {
    throw new Error("wecom_max_reconnect_attempts_invalid");
  }

  return {
    ...parsed,
    bot_id: botId,
    secret,
    welcome_text: welcomeText,
    media_dir: optionalString(parsed.media_dir),
    filter_tool_messages: true,
    filter_thinking: true,
  };
}

function optionalString(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}
