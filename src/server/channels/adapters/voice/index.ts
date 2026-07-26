import type { AgentScope } from "@/server/agents/types";
import {
  getChannelManifest,
} from "@/server/channels/manifests/catalog";
import type {
  ChannelAdapter,
} from "@/server/channels/runtime/adapter";
import {
  ChannelConnectionError,
} from "@/server/channels/runtime/connection-manager";
import type {
  InboundContext,
  IngressResult,
} from "@/server/channels/runtime/types";

import {
  parseVoiceConfig,
  type VoiceConfig,
} from "./config";
import {
  voiceGatewayHub,
  type VoicePromptPayload,
  type VoiceTransportPort,
} from "./relay";

export type VoiceAdapterDependencies = Readonly<{
  transport?: VoiceTransportPort;
  publicBaseUrl?: string;
  scope?: AgentScope;
  acceptInbound?(
    payload: unknown,
    context: InboundContext,
    scope: AgentScope,
  ): Promise<IngressResult>;
  autoListen?: boolean;
  now?: () => Date;
}>;

export function createVoiceAdapter(
  dependencies: VoiceAdapterDependencies = {},
): ChannelAdapter<VoiceConfig> {
  const manifest = getChannelManifest("voice");
  const now = dependencies.now ?? (() => new Date());
  const transport = dependencies.transport
    ?? voiceGatewayHub.createTransport();
  let config: VoiceConfig | null = null;
  let status:
    | "stopped"
    | "healthy"
    | "degraded" = "stopped";
  let started = false;
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let detachAbort: (() => void) | null = null;
  let healthError:
    | Readonly<{
        code: "network_unreachable"
          | "runtime_prerequisite_missing"
          | "unknown";
        detail: string;
      }>
    | undefined;

  const adapter: ChannelAdapter<VoiceConfig> = {
    manifest,
    validateConfig(input) {
      config = parseVoiceConfig(input);
      return config;
    },
    start(context) {
      if (stopPromise) {
        return stopPromise.then(() => adapter.start(context));
      }
      if (started) return Promise.resolve();
      if (startPromise) return startPromise;
      startPromise = start(context).finally(() => {
        startPromise = null;
      });
      return startPromise;
    },
    async stop() {
      await stop();
    },
    async health() {
      const state = transport.state();
      return {
        status,
        checkedAt: now(),
        reconnectAttempts: status === "degraded" ? 1 : 0,
        ...(state.lastConnectedAt
          ? { lastConnectedAt: state.lastConnectedAt }
          : {}),
        ...(state.lastEventAt
          ? { lastEventAt: state.lastEventAt }
          : {}),
        ...(healthError ? { error: healthError } : {}),
      };
    },
    async normalizeInbound(payload, context) {
      const prompt = parsePromptPayload(payload);
      if (!prompt) return null;
      return {
        connectionId: context.connectionId,
        agentId: context.agentId,
        channelType: "voice",
        externalEventId:
          `${prompt.callSid}:prompt:${prompt.sequence}`,
        externalConversationId: prompt.callSid,
        externalSenderId: prompt.from,
        chatType: "direct",
        mentioned: true,
        text: prompt.prompt.voicePrompt,
        thread: {},
        attachments: [],
        occurredAt: context.receivedAt,
        receivedAt: context.receivedAt,
        permission: {
          webSearch: false,
          backgroundNetwork: false,
          tools: false,
          skills: "none",
          attachmentsPresent: false,
        },
        rawSummary: {
          callSid: prompt.callSid,
          from: prompt.from,
          to: prompt.to,
          sequence: prompt.sequence,
          language: prompt.prompt.lang ?? null,
          final: true,
        },
        replyHandle: {
          publicFields: {
            callSid: prompt.callSid,
            from: prompt.from,
            to: prompt.to,
          },
          secretFields: {},
          expiresAt: null,
        },
      };
    },
    async acknowledge() {
      return { status: 200 };
    },
    async send(delivery, context) {
      context.signal.throwIfAborted();
      const callSid = delivery.replyHandle
        ?.publicFields.callSid
        ?? delivery.recipient.externalConversationId;
      if (!isCallSid(callSid)) {
        throw new Error("voice_call_sid_invalid");
      }
      return transport.send({
        callSid,
        text: delivery.body,
        deliveryId: delivery.id,
        signal: context.signal,
      });
    },
    async resolveRecipient(target) {
      if (
        target.chatType === "group"
        || !isCallSid(target.externalConversationId)
      ) {
        throw new Error("voice_direct_call_required");
      }
      return {
        address: {
          callSid: target.externalConversationId,
        },
      };
    },
  };
  return adapter;

  async function start(
    context: Parameters<typeof adapter.start>[0],
  ): Promise<void> {
    const activeConfig = parseVoiceConfig(context.config);
    config = activeConfig;
    const publicBaseUrl = dependencies.publicBaseUrl ?? "";
    if (!isHttpsOrigin(publicBaseUrl)) {
      const error = new ChannelConnectionError({
        code: "runtime_prerequisite_missing",
        detail: "voice_public_https_required",
      });
      applyError(error);
      throw error;
    }
    if (
      dependencies.autoListen !== false
      && (!dependencies.acceptInbound || !dependencies.scope)
    ) {
      const error = new ChannelConnectionError({
        code: "runtime_prerequisite_missing",
        detail: "voice_ingress_unavailable",
      });
      applyError(error);
      throw error;
    }
    try {
      await transport.start({
        connectionId: context.connectionId,
        config: activeConfig,
        publicBaseUrl,
        signal: context.signal,
        onPrompt: async (payload) => {
          if (dependencies.autoListen === false) return;
          await dependencies.acceptInbound!(
            payload,
            {
              connectionId: context.connectionId,
              agentId: context.agentId,
              receivedAt: now(),
            },
            dependencies.scope!,
          );
        },
      });
      context.signal.throwIfAborted();
      started = true;
      status = "healthy";
      healthError = undefined;
      const onAbort = () => void stop();
      context.signal.addEventListener("abort", onAbort, {
        once: true,
      });
      detachAbort = () =>
        context.signal.removeEventListener("abort", onAbort);
    } catch (error) {
      applyError(error);
      throw error;
    }
  }

  async function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    if (!started && !startPromise && status === "stopped") return;
    const pendingStart = startPromise;
    stopPromise = (async () => {
      await pendingStart?.catch(() => undefined);
      started = false;
      detachAbort?.();
      detachAbort = null;
      await transport.stop();
    })().finally(() => {
      status = "stopped";
      healthError = undefined;
      stopPromise = null;
    });
    return stopPromise;
  }

  function applyError(error: unknown): void {
    status = "degraded";
    if (error instanceof ChannelConnectionError) {
      healthError = {
        code: "runtime_prerequisite_missing",
        detail: error.detail,
      };
      return;
    }
    healthError = {
      code: error instanceof Error
        && error.message === "voice_webhook_configuration_failed"
        ? "network_unreachable"
        : "unknown",
      detail: error instanceof Error
        ? error.message
        : "voice_unknown_error",
    };
  }
}

function parsePromptPayload(
  value: unknown,
): VoicePromptPayload | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  if (
    payload.kind !== "prompt"
    || !isCallSid(payload.callSid)
    || typeof payload.from !== "string"
    || payload.from.length === 0
    || typeof payload.to !== "string"
    || payload.to.length === 0
    || !Number.isSafeInteger(payload.sequence)
    || (payload.sequence as number) < 1
    || !payload.prompt
    || typeof payload.prompt !== "object"
  ) {
    return null;
  }
  const prompt = payload.prompt as Record<string, unknown>;
  if (
    prompt.type !== "prompt"
    || prompt.last !== true
    || typeof prompt.voicePrompt !== "string"
    || prompt.voicePrompt.trim().length === 0
  ) {
    return null;
  }
  return {
    kind: "prompt",
    callSid: payload.callSid,
    from: payload.from,
    to: payload.to,
    sequence: payload.sequence as number,
    prompt: {
      type: "prompt",
      voicePrompt: prompt.voicePrompt.trim(),
      last: true,
      ...(typeof prompt.lang === "string"
        && prompt.lang.length > 0
        ? { lang: prompt.lang }
        : {}),
    },
  };
}

function isCallSid(value: unknown): value is string {
  return typeof value === "string"
    && /^CA[0-9a-f]{32}$/i.test(value);
}

function isHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:"
      && url.origin === value.replace(/\/$/, "")
      && url.username.length === 0
      && url.password.length === 0
    );
  } catch {
    return false;
  }
}
