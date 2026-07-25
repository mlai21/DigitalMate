import {
  getChannelManifest,
} from "@/server/channels/manifests/catalog";

export type SlackConfig = Readonly<
  Record<string, unknown> & {
    enabled: boolean;
    bot_token: string;
    app_token: string;
    signing_secret: string;
    proxy: string | null;
    streaming_enabled: boolean;
    require_mention: boolean;
  }
>;

export const slackConfigSchema =
  getChannelManifest("slack").configSchema;

export function parseSlackConfig(input: unknown): SlackConfig {
  const config = slackConfigSchema.parse(input) as SlackConfig;
  if (!config.bot_token.startsWith("xoxb-")) {
    throw new Error("slack_bot_token_invalid");
  }
  if (!config.app_token.startsWith("xapp-")) {
    throw new Error("slack_app_token_invalid");
  }
  return config;
}
