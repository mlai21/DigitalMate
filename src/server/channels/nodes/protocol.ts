import { createHash } from "node:crypto";

import { z } from "zod";

import {
  CHANNEL_TYPES,
} from "@/server/channels/manifests/catalog";

export const NODE_PROTOCOL_VERSION = 1 as const;
export const NODE_MAX_FRAME_BYTES = 1024 * 1024;
export const NODE_FRAME_TYPES = [
  "register",
  "registered",
  "heartbeat",
  "inbound",
  "inbound_ack",
  "send",
  "send_result",
  "error",
] as const;

const safeString = (maximum: number) =>
  z.string().min(1).max(maximum);
const isoDate = z.string().datetime({ offset: true });
const uuid = z.string().uuid();
const sequence = z.number().int().positive().max(
  Number.MAX_SAFE_INTEGER,
);
const errorCode = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,127}$/);
const scalar = z.union([
  z.string().max(4_096),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const rawSummary = z
  .record(z.string().min(1).max(128), scalar)
  .refine((value) => Object.keys(value).length <= 128, {
    message: "node_raw_summary_too_large",
  });
const stringRecord = (
  maximumKeys: number,
  maximumValueLength: number,
) =>
  z
    .record(
      z.string().min(1).max(128),
      z.string().max(maximumValueLength),
    )
    .refine(
      (value) => Object.keys(value).length <= maximumKeys,
      { message: "node_record_too_large" },
    );

const baseShape = {
  protocolVersion: z.literal(NODE_PROTOCOL_VERSION),
  nodeId: uuid,
  sequence,
  sentAt: isoDate,
} as const;

const threadSchema = z
  .object({
    externalThreadId: safeString(1_024).optional(),
    replyToEventId: safeString(1_024).optional(),
  })
  .strict();

const attachmentSchema = z
  .object({
    externalAttachmentId: safeString(1_024),
    fileName: z.string().max(1_024).nullable(),
    mimeType: z.string().max(256).nullable(),
    sizeBytes: z
      .number()
      .int()
      .nonnegative()
      .max(1024 * 1024 * 1024)
      .nullable(),
    source: stringRecord(32, 16_384),
  })
  .strict();

const replyHandleSchema = z
  .object({
    publicFields: stringRecord(32, 4_096),
    secretFields: stringRecord(32, 16_384),
    expiresAt: isoDate.nullable(),
  })
  .strict();

const recipientSchema = z
  .object({
    externalConversationId: safeString(1_024),
    externalThreadId: safeString(1_024).optional(),
    externalUserId: safeString(1_024).optional(),
  })
  .strict();

const registerFrameSchema = z
  .object({
    type: z.literal("register"),
    ...baseShape,
    certificateFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/),
    supportedChannelTypes: z
      .array(z.enum(CHANNEL_TYPES))
      .min(1)
      .max(CHANNEL_TYPES.length)
      .refine(
        (types) => new Set(types).size === types.length,
        { message: "node_channel_types_duplicate" },
      ),
    clientVersion: safeString(128),
  })
  .strict();

const registeredFrameSchema = z
  .object({
    type: z.literal("registered"),
    ...baseShape,
    heartbeatIntervalMs: z
      .number()
      .int()
      .min(1_000)
      .max(45_000),
    boundConnectionIds: z.array(uuid).max(256),
  })
  .strict();

const heartbeatFrameSchema = z
  .object({
    type: z.literal("heartbeat"),
    ...baseShape,
  })
  .strict();

const inboundFrameSchema = z
  .object({
    type: z.literal("inbound"),
    ...baseShape,
    connectionId: uuid,
    payload: z
      .object({
        externalEventId: safeString(1_024),
        externalConversationId: safeString(1_024),
        externalSenderId: safeString(1_024),
        chatType: z.enum(["direct", "group"]),
        mentioned: z.boolean(),
        text: z.string().max(NODE_MAX_FRAME_BYTES),
        thread: threadSchema,
        attachments: z.array(attachmentSchema).max(32),
        occurredAt: isoDate,
        rawSummary,
        replyHandle: replyHandleSchema.optional(),
      })
      .strict(),
  })
  .strict();

const inboundAckFrameSchema = z
  .object({
    type: z.literal("inbound_ack"),
    ...baseShape,
    connectionId: uuid,
    externalEventId: safeString(1_024),
    eventId: uuid.optional(),
    disposition: z.enum([
      "accepted",
      "duplicate",
      "ignored",
      "rejected",
    ]),
  })
  .strict();

const sendFrameSchema = z
  .object({
    type: z.literal("send"),
    ...baseShape,
    connectionId: uuid,
    deliveryId: uuid,
    expiresAt: isoDate,
    payload: z
      .object({
        body: safeString(NODE_MAX_FRAME_BYTES),
        recipient: recipientSchema,
        replyHandle: replyHandleSchema.optional(),
        streaming: z
          .object({
            sequence: z.number().int().positive(),
            final: z.boolean(),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();

const sentResultFrameSchema = z
  .object({
    type: z.literal("send_result"),
    ...baseShape,
    connectionId: uuid,
    deliveryId: uuid,
    status: z.literal("sent"),
    externalMessageId: safeString(1_024),
    platformSentAt: isoDate,
    rawSummary,
  })
  .strict();

const retryableResultFrameSchema = z
  .object({
    type: z.literal("send_result"),
    ...baseShape,
    connectionId: uuid,
    deliveryId: uuid,
    status: z.literal("retryable"),
    errorCode,
    retryAfterMs: z
      .number()
      .int()
      .nonnegative()
      .max(24 * 60 * 60 * 1_000)
      .optional(),
  })
  .strict();

const failedResultFrameSchema = z
  .object({
    type: z.literal("send_result"),
    ...baseShape,
    connectionId: uuid,
    deliveryId: uuid,
    status: z.literal("failed"),
    errorCode,
  })
  .strict();

const errorFrameSchema = z
  .object({
    type: z.literal("error"),
    ...baseShape,
    code: errorCode,
    message: safeString(1_024),
    relatedSequence: sequence.optional(),
  })
  .strict();

const nodeFrameSchema = z.union([
  registerFrameSchema,
  registeredFrameSchema,
  heartbeatFrameSchema,
  inboundFrameSchema,
  inboundAckFrameSchema,
  sendFrameSchema,
  sentResultFrameSchema,
  retryableResultFrameSchema,
  failedResultFrameSchema,
  errorFrameSchema,
]);

export type NodeFrame = z.infer<typeof nodeFrameSchema>;
export type NodeInboundFrame = z.infer<
  typeof inboundFrameSchema
>;
export type NodeInboundAckFrame = z.infer<
  typeof inboundAckFrameSchema
>;
export type NodeSendFrame = z.infer<typeof sendFrameSchema>;
export type NodeSendPayload = NodeSendFrame["payload"];

export function parseNodeFrame(value: unknown): NodeFrame {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("node_frame_invalid");
  }
  if (serialized === undefined) {
    throw new Error("node_frame_invalid");
  }
  if (
    Buffer.byteLength(serialized, "utf8")
    > NODE_MAX_FRAME_BYTES
  ) {
    throw new Error("node_frame_too_large");
  }
  const parsed = nodeFrameSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("node_frame_invalid");
  }
  return parsed.data;
}

export function createNodeFrameDigest(
  frame: NodeFrame,
): Buffer {
  return createHash("sha256")
    .update(canonicalJson(frame), "utf8")
    .digest();
}

export function createNodeSequenceGuard(
  initial: Readonly<Record<string, number>> = {},
) {
  const sequences = new Map<string, number>();
  for (const [nodeId, value] of Object.entries(initial)) {
    assertSequence(value);
    sequences.set(nodeId, value);
  }
  return {
    accept(frame: NodeFrame): number {
      const previous = sequences.get(frame.nodeId) ?? 0;
      if (frame.sequence <= previous) {
        throw new Error("node_sequence_replayed");
      }
      sequences.set(frame.nodeId, frame.sequence);
      return frame.sequence;
    },
    read(nodeId: string): number {
      return sequences.get(nodeId) ?? 0;
    },
  };
}

export type NodeAuthorizationContext = Readonly<{
  id: string;
  userId: string;
  isBound(connectionId: string): Promise<boolean>;
}>;

export async function authorizeNodeFrame(
  node: NodeAuthorizationContext,
  frame: NodeFrame,
): Promise<void> {
  if (frame.nodeId !== node.id) {
    throw new Error("node_identity_mismatch");
  }
  if (
    "connectionId" in frame
    && !await node.isBound(frame.connectionId)
  ) {
    throw new Error("node_connection_not_bound");
  }
}

function assertSequence(value: number): void {
  if (
    !Number.isSafeInteger(value)
    || value < 0
  ) {
    throw new Error("node_sequence_invalid");
  }
}

function canonicalJson(value: unknown): string {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("node_frame_invalid");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) =>
        `${JSON.stringify(key)}:${canonicalJson(record[key])}`
      )
      .join(",")}}`;
  }
  throw new Error("node_frame_invalid");
}
