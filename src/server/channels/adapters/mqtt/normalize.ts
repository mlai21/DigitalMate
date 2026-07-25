import { createHash } from "node:crypto";

import type {
  InboundContext,
  NormalizedChannelEvent,
} from "@/server/channels/runtime/types";

import {
  isValidMqttClientId,
  type MqttQos,
} from "./config";

const MAX_PAYLOAD_BYTES = 1024 * 1024;
const QOS_ZERO_BUCKET_MS = 30_000;

type MqttPacketSummary = Readonly<{
  qos?: unknown;
  messageId?: unknown;
  dup?: unknown;
  retain?: unknown;
}>;

type MqttInboundFrame = Readonly<{
  topic?: unknown;
  payload?: unknown;
  packet?: MqttPacketSummary;
}>;

export function normalizeMqttInbound(
  payload: unknown,
  context: InboundContext,
): NormalizedChannelEvent | null {
  const frame = asRecord(payload) as MqttInboundFrame;
  const topic = safeTopic(frame.topic);
  const decoded = decodePayload(frame.payload);
  const qos = mqttQos(frame.packet?.qos);
  if (!topic || decoded === null || qos === null) {
    return null;
  }

  const parsed = parseBody(decoded);
  if (!parsed) return null;
  const clientId = parsed.clientId
    ?? topic.split("/")[1]
    ?? "";
  if (!isValidMqttClientId(clientId)) return null;

  const eventIdentity = mqttEventIdentity({
    topic,
    payload: decoded,
    eventId: parsed.eventId,
    packetMessageId: frame.packet?.messageId,
    qos,
    receivedAt: context.receivedAt,
  });
  if (!eventIdentity) return null;

  return {
    connectionId: context.connectionId,
    agentId: context.agentId,
    channelType: "mqtt",
    externalEventId: eventIdentity.externalEventId,
    externalConversationId: clientId,
    externalSenderId: clientId,
    chatType: "direct",
    mentioned: true,
    text: parsed.text,
    thread: {},
    attachments: [],
    occurredAt: context.receivedAt,
    receivedAt: context.receivedAt,
    permission: {
      webSearch: false,
      backgroundNetwork: false,
      tools: false,
      skills: parsed.text.trimStart().startsWith("/")
        ? "explicit_slash"
        : "none",
      attachmentsPresent: false,
    },
    rawSummary: {
      eventIdSource: eventIdentity.source,
      qos,
      duplicate: frame.packet?.dup === true,
      retained: frame.packet?.retain === true,
    },
    replyHandle: {
      publicFields: { clientId },
      secretFields: {},
      expiresAt: null,
    },
  };
}

function mqttEventIdentity(input: Readonly<{
  topic: string;
  payload: string;
  eventId: string | null;
  packetMessageId: unknown;
  qos: MqttQos;
  receivedAt: Date;
}>): Readonly<{
  externalEventId: string;
  source: "payload" | "packet" | "qos0_hash";
}> | null {
  if (input.eventId) {
    return {
      externalEventId:
        `mqtt:${input.topic}:${input.eventId}`,
      source: "payload",
    };
  }
  const messageId = packetMessageId(input.packetMessageId);
  if (messageId !== null) {
    return {
      externalEventId:
        `mqtt:${input.topic}:packet-${messageId}`,
      source: "packet",
    };
  }
  if (input.qos !== 0) return null;

  const bucket = Math.floor(
    input.receivedAt.getTime() / QOS_ZERO_BUCKET_MS,
  );
  const digest = createHash("sha256")
    .update(input.topic)
    .update("\u0000")
    .update(input.payload)
    .update("\u0000")
    .update(String(bucket))
    .digest("hex");
  return {
    externalEventId:
      `mqtt:${input.topic}:sha256-${digest}`,
    source: "qos0_hash",
  };
}

function parseBody(value: string): Readonly<{
  text: string;
  clientId: string | null;
  eventId: string | null;
}> | null {
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  if (!normalized.startsWith("{")) {
    return {
      text: normalized,
      clientId: null,
      eventId: null,
    };
  }
  try {
    const record = asRecord(JSON.parse(normalized) as unknown);
    const text = safeText(record.text);
    if (!text) return null;
    const clientId = safeIdentifier(record.redirect_client_id);
    const eventId = safeIdentifier(record.event_id);
    if (
      record.redirect_client_id !== undefined
      && clientId === null
    ) {
      return null;
    }
    if (
      record.event_id !== undefined
      && eventId === null
    ) {
      return null;
    }
    return { text, clientId, eventId };
  } catch {
    return null;
  }
}

function decodePayload(value: unknown): string | null {
  let bytes: Uint8Array;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_PAYLOAD_BYTES) {
      return null;
    }
    return hasWellFormedUnicode(value) ? value : null;
  }
  if (Buffer.isBuffer(value)) {
    bytes = value;
  } else if (value instanceof Uint8Array) {
    bytes = value;
  } else {
    return null;
  }
  if (bytes.byteLength > MAX_PAYLOAD_BYTES) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function safeTopic(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const length = Buffer.byteLength(value, "utf8");
  return value.length > 0
    && length <= 65_535
    && !value.includes("\u0000")
    && hasWellFormedUnicode(value)
    ? value
    : null;
}

function safeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0
    && Buffer.byteLength(normalized, "utf8") <= MAX_PAYLOAD_BYTES
    && hasWellFormedUnicode(normalized)
    ? normalized
    : null;
}

function safeIdentifier(value: unknown): string | null {
  if (
    typeof value !== "string"
    && typeof value !== "number"
  ) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized.length > 0
    && normalized.length <= 1_024
    && !/[\u0000-\u001f\u007f]/u.test(normalized)
    && hasWellFormedUnicode(normalized)
    ? normalized
    : null;
}

function packetMessageId(value: unknown): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 1
    && value <= 65_535
    ? value
    : null;
}

function mqttQos(value: unknown): MqttQos | null {
  return value === 0 || value === 1 || value === 2
    ? value
    : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}
