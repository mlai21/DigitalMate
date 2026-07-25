import {
  getChannelManifest,
} from "@/server/channels/manifests/catalog";

export type TelegramConfig = Readonly<
  Record<string, unknown> & {
    enabled: boolean;
    bot_token: string;
    webhook_secret: string;
    base_url: string;
    http_proxy: string;
    http_proxy_auth: string;
    show_typing: boolean | null;
    streaming_enabled: boolean;
  }
>;

export const telegramConfigSchema =
  getChannelManifest("telegram").configSchema;

export function parseTelegramConfig(
  input: unknown,
): TelegramConfig {
  const config = telegramConfigSchema.parse(input) as TelegramConfig;
  if (config.bot_token.trim().length === 0) {
    throw new Error("telegram_bot_token_required");
  }
  return config;
}

export function telegramApiBaseUrl(
  config: TelegramConfig,
): string {
  return (config.base_url || "https://api.telegram.org")
    .replace(/\/+$/u, "");
}
