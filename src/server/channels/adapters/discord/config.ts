import {
  getChannelManifest,
} from "@/server/channels/manifests/catalog";

export type DiscordConfig = Readonly<
  Record<string, unknown> & {
    enabled: boolean;
    bot_token: string;
    http_proxy: string;
    http_proxy_auth: string;
    accept_bot_messages: boolean;
    streaming_enabled: boolean;
  }
>;

export const discordConfigSchema =
  getChannelManifest("discord").configSchema;

export function parseDiscordConfig(
  input: unknown,
): DiscordConfig {
  const config = discordConfigSchema.parse(input) as DiscordConfig;
  if (config.bot_token.trim().length === 0) {
    throw new Error("discord_bot_token_required");
  }
  if (
    config.http_proxy_auth.length > 0
    && config.http_proxy.length === 0
  ) {
    throw new Error("discord_proxy_url_required");
  }
  if (
    config.http_proxy_auth.length > 0
    && !config.http_proxy_auth.includes(":")
  ) {
    throw new Error("discord_proxy_auth_invalid");
  }
  return config;
}
