import type { AgentScope } from "@/server/agents/types";

import type { ChannelAdapter } from "./adapter";
import type {
  AcceptChannelEventOptions,
  ChannelEventRecord,
} from "./event-repository";
import type {
  ChannelAccessDecision,
} from "./access";
import type {
  InboundContext,
  IngressResult,
  NormalizedChannelEvent,
  PlatformAcknowledgement,
} from "./types";

type IngressEventRepository = Readonly<{
  accept(
    scope: AgentScope,
    event: NormalizedChannelEvent,
    options: AcceptChannelEventOptions,
  ): Promise<{
    created: boolean;
    event: ChannelEventRecord;
  }>;
  markAttachmentsReady?(
    scope: AgentScope,
    eventId: string,
  ): Promise<boolean>;
}>;

type IngressAccessControl = Readonly<{
  evaluate(
    scope: AgentScope,
    event: NormalizedChannelEvent,
  ): Promise<ChannelAccessDecision>;
  recordPendingRequest(
    scope: AgentScope,
    event: ChannelEventRecord,
  ): Promise<void>;
}>;

export type AcceptInboundInput = Readonly<{
  adapter: ChannelAdapter<Record<string, unknown>>;
  payload: unknown;
  context: InboundContext;
  scope: AgentScope;
  access: IngressAccessControl;
  events: IngressEventRepository;
  onAcknowledgementFailure?: (
    eventId: string,
    error: unknown,
  ) => Promise<void>;
  afterPersist?: (
    event: ChannelEventRecord,
    normalized: NormalizedChannelEvent,
  ) => Promise<void>;
  afterDurablePersist?: (
    event: ChannelEventRecord,
    normalized: NormalizedChannelEvent,
  ) => Promise<void>;
  onAttachmentPreparationFailure?: (
    event: ChannelEventRecord,
    error: unknown,
  ) => Promise<void>;
}>;

export async function acceptInbound(
  input: AcceptInboundInput,
): Promise<IngressResult> {
  return (await acceptInboundWithAcknowledgement(input)).result;
}

export async function acceptInboundWithAcknowledgement(
  input: AcceptInboundInput,
): Promise<Readonly<{
  result: IngressResult;
  acknowledgement: PlatformAcknowledgement;
}>> {
  const normalized = await input.adapter.normalizeInbound(
    input.payload,
    input.context,
  );
  if (!normalized) {
    // A dropped inbound message looks exactly like being ignored to the user, and
    // used to leave no trace anywhere — an unsupported DingTalk message type went
    // unnoticed for hours. Content stays out of the log; the shape is enough to
    // tell "unsupported type" from "not addressed to us".
    console.warn("channel_inbound_ignored", {
      channel: input.adapter.manifest.type,
      connectionId: input.context.connectionId,
      agentId: input.context.agentId,
      messageType: inboundMessageType(input.payload),
    });
    const ignored: IngressResult = { kind: "ignored" };
    const acknowledgement = await input.adapter.acknowledge(
      input.payload,
      ignored,
    );
    return { result: ignored, acknowledgement };
  }
  assertNormalizedScope(normalized, input);

  const access = await input.access.evaluate(input.scope, normalized);
  const accepted = await input.events.accept(
    input.scope,
    normalized,
    accessOptions(access, normalized),
  );
  if (accepted.created && access.kind === "pending") {
    await input.access.recordPendingRequest(
      input.scope,
      accepted.event,
    );
  }
  await input.afterDurablePersist?.(
    accepted.event,
    normalized,
  );
  if (
    accepted.event.status === "accepted"
    || accepted.event.status === "pending_attachments"
  ) {
    try {
      await input.afterPersist?.(accepted.event, normalized);
    } catch (error) {
      if (accepted.event.status === "pending_attachments") {
        await input.onAttachmentPreparationFailure?.(
          accepted.event,
          error,
        );
      }
      throw error;
    }
  }
  if (accepted.event.status === "pending_attachments") {
    if (!input.events.markAttachmentsReady) {
      throw new Error(
        "channel_attachment_ready_transition_unavailable",
      );
    }
    const ready = await input.events.markAttachmentsReady(
      input.scope,
      accepted.event.id,
    );
    if (!ready) {
      throw new Error(
        "channel_attachment_ready_transition_failed",
      );
    }
  }

  const result: IngressResult = !accepted.created
    ? { kind: "duplicate", eventId: accepted.event.id }
    : access.allowed
      ? { kind: "accepted", eventId: accepted.event.id }
      : { kind: "rejected", eventId: accepted.event.id };
  try {
    const acknowledgement = await input.adapter.acknowledge(
      input.payload,
      result,
    );
    return { result, acknowledgement };
  } catch (error) {
    await input.onAcknowledgementFailure?.(
      accepted.event.id,
      error,
    ).catch(() => undefined);
    throw error;
  }
}

function accessOptions(
  access: ChannelAccessDecision,
  event: NormalizedChannelEvent,
): AcceptChannelEventOptions {
  return access.allowed
    ? {
        initialStatus: event.attachments.length > 0
          ? "pending_attachments"
          : "accepted",
        failureCode: null,
      }
    : {
        initialStatus: "failed",
        failureCode: access.reason,
      };
}

/**
 * Best-effort type label for the ignore log. Platforms disagree on the field
 * name, and stream-mode payloads carry the event as a JSON string, so this only
 * reads the shallow discriminator and never the message body.
 */
function inboundMessageType(payload: unknown): string {
  const record = payload && typeof payload === "object"
    ? payload as Record<string, unknown>
    : {};
  for (const candidate of [
    record.msgtype,
    record.msgType,
    record.message_type,
  ]) {
    if (typeof candidate === "string" && candidate.length <= 64) {
      return candidate;
    }
  }
  // Stream-mode payloads wrap the event in a JSON string that can reach
  // megabytes, so the discriminator is scanned out of the head rather than
  // parsing the whole body for a log line.
  if (typeof record.data === "string") {
    const match = record.data
      .slice(0, 512)
      .match(/"msg[Tt]ype"\s*:\s*"([^"]{1,64})"/);
    if (match) return match[1]!;
  }
  return "unknown";
}

function assertNormalizedScope(
  event: NormalizedChannelEvent,
  input: Pick<AcceptInboundInput, "context" | "scope">,
): void {
  if (
    event.connectionId !== input.context.connectionId
    || event.agentId !== input.context.agentId
    || event.agentId !== input.scope.agentId
  ) {
    throw new Error("channel_normalized_event_scope_mismatch");
  }
}
