import {
  getChannelManifest,
} from "@/server/channels/manifests/catalog";

export type MattermostConfig = Readonly<
  Record<string, unknown> & {
    enabled: boolean;
    url: string;
    bot_token: string;
    show_typing: boolean | null;
    thread_follow_without_mention: boolean;
  }
>;

export const mattermostConfigSchema =
  getChannelManifest("mattermost").configSchema;

export function parseMattermostConfig(
  input: unknown,
): MattermostConfig {
  const config =
    mattermostConfigSchema.parse(input) as MattermostConfig;
  if (config.bot_token.trim().length === 0) {
    throw new Error("mattermost_bot_token_required");
  }
  if (config.url.trim().length === 0) {
    throw new Error("mattermost_url_required");
  }
  return config;
}

export function mattermostBaseUrl(
  config: Pick<MattermostConfig, "url">,
): string {
  return config.url.replace(/\/+$/u, "");
}
