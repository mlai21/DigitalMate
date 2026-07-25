import type { ChannelType } from "@/server/channels/manifests/catalog";

export type ChatType = "direct" | "group";

export type PermissionEnvelope = Readonly<{
  webSearch: false;
  backgroundNetwork: false;
  tools: false;
  skills: "none" | "explicit_slash";
  attachmentsPresent: boolean;
  explicitSkillName?: string;
}>;

export type InboundAttachmentDescriptor = Readonly<{
  externalAttachmentId: string;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  source: Readonly<Record<string, string>>;
}>;

export type UnsealedReplyHandle = Readonly<{
  publicFields: Readonly<Record<string, string>>;
  secretFields: Readonly<Record<string, string>>;
  expiresAt: Date | null;
}>;

export type NormalizedChannelEvent = Readonly<{
  connectionId: string;
  agentId: string;
  channelType: ChannelType;
  externalEventId: string;
  externalConversationId: string;
  externalSenderId: string;
  chatType: ChatType;
  mentioned: boolean;
  text: string;
  thread: Readonly<{
    externalThreadId?: string;
    replyToEventId?: string;
  }>;
  attachments: readonly InboundAttachmentDescriptor[];
  occurredAt: Date;
  receivedAt: Date;
  permission: PermissionEnvelope;
  rawSummary: Readonly<
    Record<string, string | number | boolean | null>
  >;
  replyHandle?: UnsealedReplyHandle;
}>;

export type ChannelRecipient = Readonly<{
  externalConversationId: string;
  externalThreadId?: string;
  externalUserId?: string;
}>;

export type ResolvedRecipient = Readonly<{
  address: Readonly<Record<string, string>>;
  displayName?: string;
}>;

export type ChannelDelivery = Readonly<{
  id: string;
  eventId: string;
  connectionId: string;
  assistantMessageId: string;
  body: string;
  recipient: ChannelRecipient;
  replyHandle?: UnsealedReplyHandle;
}>;

export type ChannelHealthStatus =
  | "disconnected"
  | "connecting"
  | "healthy"
  | "degraded"
  | "stopped";

export type ChannelHealthErrorCode =
  | "credential_invalid"
  | "permission_denied"
  | "network_unreachable"
  | "rate_limited"
  | "runtime_prerequisite_missing"
  | "unknown";

export type ChannelHealth = Readonly<{
  status: ChannelHealthStatus;
  checkedAt: Date;
  lastConnectedAt?: Date;
  lastEventAt?: Date;
  reconnectAttempts: number;
  nextAttemptAt?: Date;
  error?: Readonly<{
    code: ChannelHealthErrorCode;
    detail: string;
  }>;
}>;

export type InboundContext = Readonly<{
  connectionId: string;
  agentId: string;
  receivedAt: Date;
}>;

export type IngressResult =
  | Readonly<{ kind: "ignored" }>
  | Readonly<{ kind: "accepted"; eventId: string }>
  | Readonly<{ kind: "rejected"; eventId: string }>
  | Readonly<{ kind: "duplicate"; eventId: string }>;

export type PlatformAcknowledgement = Readonly<{
  status: number;
  headers?: Readonly<Record<string, string>>;
  body?: string;
}>;

export type SendResult = Readonly<{
  externalMessageId: string;
  sentAt: Date;
  rawSummary: Readonly<
    Record<string, string | number | boolean | null>
  >;
}>;

export type StreamingState = Readonly<{
  sequence: number;
  final: boolean;
}>;

export type ChannelRuntimeContext<
  TConfig extends Record<string, unknown>,
> = Readonly<{
  connectionId: string;
  agentId: string;
  config: Readonly<TConfig>;
  signal: AbortSignal;
  now: () => Date;
}>;

export type SendContext<
  TConfig extends Record<string, unknown>,
> = Readonly<{
  config: Readonly<TConfig>;
  signal: AbortSignal;
  now: () => Date;
}>;

export type AdapterDependencies = Readonly<{
  now: () => Date;
}>;
