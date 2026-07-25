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
}>;

export async function acceptInbound(
  input: AcceptInboundInput,
): Promise<IngressResult> {
  const normalized = await input.adapter.normalizeInbound(
    input.payload,
    input.context,
  );
  if (!normalized) {
    const ignored: IngressResult = { kind: "ignored" };
    await input.adapter.acknowledge(input.payload, ignored);
    return ignored;
  }
  assertNormalizedScope(normalized, input);

  const access = await input.access.evaluate(input.scope, normalized);
  const accepted = await input.events.accept(
    input.scope,
    normalized,
    accessOptions(access),
  );
  if (accepted.created && access.kind === "pending") {
    await input.access.recordPendingRequest(
      input.scope,
      accepted.event,
    );
  }

  const result: IngressResult = !accepted.created
    ? { kind: "duplicate", eventId: accepted.event.id }
    : access.allowed
      ? { kind: "accepted", eventId: accepted.event.id }
      : { kind: "rejected", eventId: accepted.event.id };
  try {
    await input.adapter.acknowledge(input.payload, result);
  } catch (error) {
    await input.onAcknowledgementFailure?.(
      accepted.event.id,
      error,
    ).catch(() => undefined);
    throw error;
  }
  return result;
}

function accessOptions(
  access: ChannelAccessDecision,
): AcceptChannelEventOptions {
  return access.allowed
    ? {
        initialStatus: "accepted",
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
