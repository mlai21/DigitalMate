import path from "node:path";

import {
  ATTACHMENT_LIMITS,
  classifyAllowedAttachment,
} from "@/server/attachments/types";
import type {
  InboundAttachmentDescriptor,
  InboundContext,
  NormalizedChannelEvent,
} from "@/server/channels/runtime/types";

import type { XiaoYiConfig } from "./config";
import type { XiaoYiServerName } from "./transport";

export const XIAOYI_TEXT_CHUNK_LIMIT = 4_000;
const MAX_TEXT_BYTES = 1024 * 1024;

export type XiaoYiInboundEnvelope = Readonly<{
  serverName: XiaoYiServerName;
  payload: unknown;
}>;

export function normalizeXiaoYiInbound(
  input: unknown,
  context: InboundContext,
  config: XiaoYiConfig,
): NormalizedChannelEvent | null {
  const envelope = unwrapEnvelope(input);
  const frame = asRecord(envelope.payload);
  if (
    frame.method !== "message/stream"
    || (
      boundedIdentifier(frame.agentId)
      && boundedIdentifier(frame.agentId) !== config.agent_id
    )
  ) {
    return null;
  }

  const params = asRecord(frame.params);
  const message = asRecord(params.message);
  const sessionId = boundedIdentifier(params.sessionId);
  const taskId = boundedIdentifier(params.id);
  const messageId =
    boundedIdentifier(frame.id)
    ?? boundedIdentifier(message.messageId);
  if (!sessionId || !taskId || !messageId) return null;

  const parts = Array.isArray(message.parts)
    ? message.parts
    : [];
  const textParts: string[] = [];
  const attachments: InboundAttachmentDescriptor[] = [];
  for (const partValue of parts) {
    const part = asRecord(partValue);
    if (part.kind === "text") {
      const text = boundedText(part.text);
      if (text) textParts.push(text);
      continue;
    }
    if (part.kind !== "file") continue;
    const descriptor = fileDescriptor(
      asRecord(part.file),
      messageId,
      attachments.length,
    );
    if (descriptor) attachments.push(descriptor);
  }
  if (
    attachments.length > ATTACHMENT_LIMITS.maxCount
    || attachments.reduce(
      (total, attachment) =>
        total + (attachment.sizeBytes ?? 0),
      0,
    ) > ATTACHMENT_LIMITS.maxMessageBytes
  ) {
    return null;
  }
  const text = textParts.join(" ").trim()
    || (attachments.length > 0 ? "[附件]" : "");
  if (!text) return null;

  return {
    connectionId: context.connectionId,
    agentId: context.agentId,
    channelType: "xiaoyi",
    externalEventId:
      `xiaoyi:task:${taskId}:${messageId}`,
    externalConversationId: sessionId,
    externalSenderId: sessionId,
    chatType: "direct",
    mentioned: true,
    text,
    thread: {},
    attachments,
    occurredAt: context.receivedAt,
    receivedAt: context.receivedAt,
    permission: {
      webSearch: false,
      backgroundNetwork: false,
      tools: false,
      skills:
        attachments.length === 0 && text.startsWith("/")
          ? "explicit_slash"
          : "none",
      attachmentsPresent: attachments.length > 0,
    },
    rawSummary: {
      method: "message/stream",
      platformMessageId: messageId,
      taskId,
      serverName: envelope.serverName,
      isBotEvent: false,
    },
    replyHandle: {
      publicFields: {
        sessionId,
        serverName: envelope.serverName,
      },
      secretFields: {
        taskId,
        messageId,
      },
      expiresAt: new Date(
        context.receivedAt.getTime()
          + config.task_timeout_ms,
      ),
    },
  };
}

export function splitXiaoYiText(text: string): string[] {
  const codePoints = Array.from(text);
  if (codePoints.length === 0) return [];
  const chunks: string[] = [];
  for (
    let index = 0;
    index < codePoints.length;
    index += XIAOYI_TEXT_CHUNK_LIMIT
  ) {
    chunks.push(
      codePoints
        .slice(index, index + XIAOYI_TEXT_CHUNK_LIMIT)
        .join(""),
    );
  }
  return chunks;
}

export function buildXiaoYiArtifactFrame(input: Readonly<{
  agentId: string;
  sessionId: string;
  taskId: string;
  messageId: string;
  artifactId: string;
  text: string;
  final: boolean;
}>): Record<string, unknown> {
  return wrapAgentResponse(input, {
    jsonrpc: "2.0",
    id: input.messageId,
    result: {
      taskId: input.taskId,
      kind: "artifact-update",
      append: true,
      lastChunk: true,
      final: input.final,
      artifact: {
        artifactId: input.artifactId,
        parts: [{
          kind: "text",
          text: input.text,
        }],
      },
    },
  });
}

export function buildXiaoYiCompletedFrame(input: Readonly<{
  agentId: string;
  sessionId: string;
  taskId: string;
  messageId: string;
}>): Record<string, unknown> {
  return wrapAgentResponse(input, {
    jsonrpc: "2.0",
    id: input.messageId,
    result: {
      taskId: input.taskId,
      kind: "status-update",
      final: false,
      status: {
        message: {
          role: "agent",
          parts: [{ kind: "text", text: "" }],
        },
        state: "completed",
      },
    },
  });
}

export function xiaoYiControlRequest(
  value: unknown,
): Readonly<{
  method: "clearContext" | "tasks/cancel";
  requestId: string;
  sessionId: string;
  taskId: string;
}> | null {
  const frame = asRecord(value);
  const action = frame.method ?? frame.action;
  const method = (
    action === "clearContext"
    || action === "clear"
  )
    ? "clearContext"
    : action === "tasks/cancel"
      ? "tasks/cancel"
      : null;
  const requestId = boundedIdentifier(frame.id);
  const sessionId = boundedIdentifier(frame.sessionId);
  if (!method || !requestId || !sessionId) return null;
  return {
    method,
    requestId,
    sessionId,
    taskId:
      boundedIdentifier(frame.taskId) ?? requestId,
  };
}

export function buildXiaoYiControlResponse(input: Readonly<{
  agentId: string;
  method: "clearContext" | "tasks/cancel";
  requestId: string;
  sessionId: string;
  taskId: string;
}>): Record<string, unknown> {
  const canceled = input.method === "tasks/cancel";
  return wrapAgentResponse({
    ...input,
    taskId: input.requestId,
  }, {
    jsonrpc: "2.0",
    id: input.requestId,
    result: canceled
      ? {
          id: input.requestId,
          status: { state: "canceled" },
        }
      : {
          status: { state: "cleared" },
        },
  });
}

export function safeXiaoYiMediaUri(
  value: unknown,
): string | null {
  if (typeof value !== "string" || value.length > 8_192) {
    return null;
  }
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || parsed.port
      || !isHuaweiMediaHost(parsed.hostname)
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function unwrapEnvelope(value: unknown): XiaoYiInboundEnvelope {
  const record = asRecord(value);
  const serverName = record.serverName === "backup"
    ? "backup"
    : "primary";
  return {
    serverName,
    payload:
      Object.hasOwn(record, "payload")
        ? record.payload
        : value,
  };
}

function fileDescriptor(
  file: Record<string, unknown>,
  messageId: string,
  index: number,
): InboundAttachmentDescriptor | null {
  const uri = safeXiaoYiMediaUri(file.uri);
  const fileName = safeFileName(file.name);
  const mimeType = safeMimeType(file.mimeType);
  if (
    !uri
    || !fileName
    || !mimeType
    || !classifyAllowedAttachment(fileName, mimeType)
  ) {
    return null;
  }
  return {
    externalAttachmentId: `${messageId}:${index}`,
    fileName,
    mimeType,
    sizeBytes: safeSize(file.sizeBytes ?? file.size),
    source: { uri },
  };
}

function wrapAgentResponse(
  input: Readonly<{
    agentId: string;
    sessionId: string;
    taskId: string;
  }>,
  detail: Record<string, unknown>,
): Record<string, unknown> {
  return {
    msgType: "agent_response",
    agentId: input.agentId,
    sessionId: input.sessionId,
    taskId: input.taskId,
    msgDetail: JSON.stringify(detail),
  };
}

function isHuaweiMediaHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return [
    "huawei.com",
    "huawei.cn",
    "huaweicloud.com",
    "myhuaweicloud.com",
    "dbankcdn.com",
  ].some((suffix) =>
    host === suffix || host.endsWith(`.${suffix}`)
  );
}

function safeFileName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = path
    .basename(value.replaceAll("\\", "/"))
    .trim();
  return normalized
    && normalized.length <= 255
    && !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : null;
}

function safeMimeType(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0
    && normalized.length <= 255
    && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u
      .test(normalized)
    ? normalized
    : null;
}

function safeSize(value: unknown): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : null;
}

function boundedIdentifier(value: unknown): string | null {
  if (
    typeof value !== "string"
    && typeof value !== "number"
  ) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized
    && normalized.length <= 1_024
    && !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : null;
}

function boundedText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized
    && Buffer.byteLength(normalized, "utf8") <= MAX_TEXT_BYTES
    ? normalized
    : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
