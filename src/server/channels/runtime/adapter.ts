import type { ChannelManifest } from "@/server/channels/manifests/types";

import type {
  ChannelDelivery,
  ChannelHealth,
  ChannelReaction,
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
  // Places or withdraws a reaction on the user's own message, for platforms
  // that offer reactions instead of a typing indicator.
  reaction?(
    input: Readonly<{
      platformMessageId: string;
      externalConversationId: string;
      reaction: ChannelReaction;
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
