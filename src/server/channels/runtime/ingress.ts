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
  if (
    accepted.event.status === "accepted"
    || accepted.event.status === "pending_attachments"
  ) {
    await input.afterPersist?.(accepted.event, normalized);
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
