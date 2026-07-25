import type { ChatType } from "./runtime/types";

export type {
  AdapterDependencies,
  ChannelDelivery,
  ChannelHealth,
  ChannelHealthErrorCode,
  ChannelHealthStatus,
  ChannelRecipient,
  ChannelRuntimeContext,
  InboundAttachmentDescriptor,
  InboundContext,
  IngressResult,
  NormalizedChannelEvent,
  PermissionEnvelope,
  PlatformAcknowledgement,
  ResolvedRecipient,
  SendContext,
  SendResult,
  StreamingState,
  UnsealedReplyHandle,
} from "./runtime/types";
export type { ChannelAdapter } from "./runtime/adapter";
export type { ChatType };

export type ChannelName =
  | "telegram"
  | "discord"
  | "slack"
  | "mattermost"
  | "feishu"
  | "dingtalk"
  | "qq"
  | "mqtt"
  | "web";

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
