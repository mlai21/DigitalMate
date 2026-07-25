import {
  getChannelManifest,
} from "@/server/channels/manifests/catalog";

export type FeishuConfig = Readonly<
  Record<string, unknown> & {
    enabled: boolean;
    app_id: string;
    app_secret: string;
    encrypt_key: string;
    verification_token: string;
    domain: "feishu" | "lark";
    streaming_enabled: boolean;
    share_session_in_group: boolean;
  }
>;

export const feishuConfigSchema =
  getChannelManifest("feishu").configSchema;

export function parseFeishuConfig(input: unknown): FeishuConfig {
  const config = feishuConfigSchema.parse(input) as FeishuConfig;
  if (!config.app_id.trim()) throw new Error("feishu_app_id_required");
  if (!/^cli_[0-9a-f]{16}$/i.test(config.app_id.trim())) {
    throw new Error("feishu_app_id_invalid");
  }
  if (!config.app_secret.trim()) {
    throw new Error("feishu_app_secret_required");
  }
  return config;
}
