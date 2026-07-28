import type { ChannelManifest } from "@/server/channels/manifests/types";

import type {
  ChannelDelivery,
  ChannelHealth,
  ChannelRecipient,
  ChannelRuntimeContext,
  InboundContext,
  IngressResult,
  NormalizedChannelEvent,
  PlatformAcknowledgement,
  ResolvedRecipient,
  SendContext,
  SendResult,
  StreamingState,
} from "./types";

export interface ChannelAdapter<
  TConfig extends Record<string, unknown>,
> {
  readonly manifest: ChannelManifest;
  validateConfig(config: unknown): TConfig;
  start(context: ChannelRuntimeContext<TConfig>): Promise<void>;
  stop(reason: "disabled" | "reconfigure" | "shutdown"): Promise<void>;
  health(): Promise<ChannelHealth>;
  normalizeInbound(
    payload: unknown,
    context: InboundContext,
  ): Promise<NormalizedChannelEvent | null>;
  acknowledge(
    payload: unknown,
    result: IngressResult,
  ): Promise<PlatformAcknowledgement>;
  send(
    delivery: ChannelDelivery,
    context: SendContext<TConfig>,
  ): Promise<SendResult>;
  typing?(
    recipient: ResolvedRecipient,
    active: boolean,
  ): Promise<void>;
  // Marks the user's own message as being worked on, for platforms that offer
  // reactions instead of a typing indicator.
  ackReaction?(
    input: Readonly<{
      externalEventId: string;
      externalConversationId: string;
      active: boolean;
    }>,
  ): Promise<void>;
  streaming?(
    delivery: ChannelDelivery,
    state: StreamingState,
  ): Promise<SendResult>;
  resolveRecipient(
    target: ChannelRecipient,
  ): Promise<ResolvedRecipient>;
}
