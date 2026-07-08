export type ChannelName = "telegram" | "slack" | "feishu" | "dingtalk" | "web";

export type ChatType = "direct" | "group";

export type NormalizedChannelMessage = {
  channel: ChannelName;
  externalMessageId: string;
  externalConversationId: string;
  senderId: string;
  chatType: ChatType;
  text: string;
  occurredAt: Date;
  raw?: unknown;
};
