import {
  getChannelManifest,
} from "@/server/channels/manifests/catalog";

export type XiaoYiConfig = Readonly<
  Record<string, unknown> & {
    enabled: boolean;
    ak: string;
    sk: string;
    agent_id: string;
    task_timeout_ms: number;
    bot_prefix: string;
    filter_tool_messages: true;
    filter_thinking: true;
  }
>;

export const xiaoYiConfigSchema =
  getChannelManifest("xiaoyi").configSchema;

export function parseXiaoYiConfig(input: unknown): XiaoYiConfig {
  const parsed = xiaoYiConfigSchema.parse(input) as XiaoYiConfig;
  const ak = parsed.ak.trim();
  const sk = parsed.sk.trim();
  const agentId = parsed.agent_id.trim();
  const botPrefix = parsed.bot_prefix;

  if (!ak) throw new Error("xiaoyi_ak_required");
  if (!sk) throw new Error("xiaoyi_sk_required");
  if (!agentId) {
    throw new Error("xiaoyi_agent_id_required");
  }
  if (Array.from(botPrefix).length >= 4_000) {
    throw new Error("xiaoyi_bot_prefix_too_long");
  }

  return {
    ...parsed,
    ak,
    sk,
    agent_id: agentId,
    bot_prefix: botPrefix,
    filter_tool_messages: true,
    filter_thinking: true,
  };
}
