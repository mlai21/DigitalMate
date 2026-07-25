import {
  getChannelManifest,
} from "@/server/channels/manifests/catalog";

export type QQConfig = Readonly<
  Record<string, unknown> & {
    enabled: boolean;
    app_id: string;
    client_secret: string;
    markdown_enabled: boolean;
    max_reconnect_attempts: number;
    ack_message: string;
  }
>;

export const qqConfigSchema =
  getChannelManifest("qq").configSchema;

export function parseQQConfig(input: unknown): QQConfig {
  const parsed = qqConfigSchema.parse(input) as QQConfig;
  const appId = parsed.app_id.trim();
  if (!appId) throw new Error("qq_app_id_required");
  if (!/^\d{5,32}$/.test(appId)) {
    throw new Error("qq_app_id_invalid");
  }
  if (!parsed.client_secret.trim()) {
    throw new Error("qq_client_secret_required");
  }
  if (
    !Number.isSafeInteger(parsed.max_reconnect_attempts)
    || parsed.max_reconnect_attempts < -1
  ) {
    throw new Error("qq_max_reconnect_attempts_invalid");
  }
  if (parsed.ack_message.length > 2_000) {
    throw new Error("qq_ack_message_too_long");
  }
  return {
    ...parsed,
    app_id: appId,
  };
}
