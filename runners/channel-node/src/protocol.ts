import { z } from "zod";

export const RUNNER_PROTOCOL_VERSION = 1 as const;
export const RUNNER_MAX_FRAME_BYTES = 1024 * 1024;
export const RUNNER_CHANNEL_TYPES = [
  "imessage",
  "sip",
] as const;

const uuid = z.string().uuid();
const isoDate = z.string().datetime({ offset: true });
const sequence = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const safeString = (maximum: number) =>
  z.string().min(1).max(maximum);
const errorCode = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,127}$/);
const transferId = z.string().regex(/^[a-f0-9]{64}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const stringRecord = z
  .record(
    z.string().min(1).max(128),
    z.string().max(16_384),
  )
  .refine((value) => Object.keys(value).length <= 32);
const scalar = z.union([
  z.string().max(4_096),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const rawSummary = z
  .record(z.string().min(1).max(128), scalar)
  .refine((value) => Object.keys(value).length <= 128);

const baseShape = {
  protocolVersion: z.literal(RUNNER_PROTOCOL_VERSION),
  nodeId: uuid,
  sequence,
  sentAt: isoDate,
} as const;

const replyHandleSchema = z
  .object({
    publicFields: stringRecord,
    secretFields: stringRecord,
    expiresAt: isoDate.nullable(),
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
        body: safeString(RUNNER_MAX_FRAME_BYTES),
        recipient: z
          .object({
            externalConversationId: safeString(1_024),
            externalThreadId: safeString(1_024).optional(),
            externalUserId: safeString(1_024).optional(),
            chatType: z.enum(["direct", "group"]).optional(),
          })
          .strict(),
        replyHandle: replyHandleSchema.optional(),
        streaming: z
          .object({
            sequence: sequence,
            final: z.boolean(),
          })
          .strict()
          .optional(),
      })
      .strict(),
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
        text: z.string().max(RUNNER_MAX_FRAME_BYTES),
        thread: z
          .object({
            externalThreadId: safeString(1_024).optional(),
            replyToEventId: safeString(1_024).optional(),
          })
          .strict(),
        attachments: z
          .array(
            z
              .object({
                externalAttachmentId: safeString(1_024),
                fileName: z.string().max(1_024).nullable(),
                mimeType: z.string().max(256).nullable(),
                sizeBytes: z
                  .number()
                  .int()
                  .nonnegative()
                  .max(10 * 1024 * 1024)
                  .nullable(),
                source: stringRecord,
              })
              .strict(),
          )
          .max(4),
        occurredAt: isoDate,
        rawSummary,
        replyHandle: replyHandleSchema.optional(),
      })
      .strict(),
  })
  .strict();

const sentOutcomeShape = {
  status: z.literal("sent"),
  externalMessageId: safeString(1_024),
  platformSentAt: isoDate,
  rawSummary,
} as const;
const retryableOutcomeShape = {
  status: z.literal("retryable"),
  errorCode,
  retryAfterMs: z
    .number()
    .int()
    .nonnegative()
    .max(24 * 60 * 60 * 1_000)
    .optional(),
} as const;
const failedOutcomeShape = {
  status: z.literal("failed"),
  errorCode,
} as const;
const sendOutcomeSchema = z.discriminatedUnion(
  "status",
  [
    z.object(sentOutcomeShape).strict(),
    z.object(retryableOutcomeShape).strict(),
    z.object(failedOutcomeShape).strict(),
  ],
);
const sendResultFrameSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        type: z.literal("send_result"),
        ...baseShape,
        connectionId: uuid,
        deliveryId: uuid,
        requestSequence: sequence,
        ...sentOutcomeShape,
      })
      .strict(),
    z
      .object({
        type: z.literal("send_result"),
        ...baseShape,
        connectionId: uuid,
        deliveryId: uuid,
        requestSequence: sequence,
        ...retryableOutcomeShape,
      })
      .strict(),
    z
      .object({
        type: z.literal("send_result"),
        ...baseShape,
        connectionId: uuid,
        deliveryId: uuid,
        requestSequence: sequence,
        ...failedOutcomeShape,
      })
      .strict(),
  ],
);

const attachmentStartFrameSchema = z
  .object({
    type: z.literal("attachment_start"),
    ...baseShape,
    connectionId: uuid,
    transferId,
    externalEventId: safeString(1_024),
    externalAttachmentId: safeString(1_024),
    fileName: safeString(1_024),
    mimeType: safeString(256),
    sizeBytes: z.number().int().positive()
      .max(10 * 1024 * 1024),
    sha256,
  })
  .strict();

const attachmentChunkFrameSchema = z
  .object({
    type: z.literal("attachment_chunk"),
    ...baseShape,
    connectionId: uuid,
    transferId,
    chunkIndex: z.number().int().nonnegative().max(63),
    dataBase64: z.string().min(1).max(700_000),
  })
  .strict();

const attachmentCommitFrameSchema = z
  .object({
    type: z.literal("attachment_commit"),
    ...baseShape,
    connectionId: uuid,
    transferId,
    chunkCount: z.number().int().positive().max(64),
  })
  .strict();

const attachmentAckFrameSchema = z
  .object({
    type: z.literal("attachment_ack"),
    ...baseShape,
    connectionId: uuid,
    transferId,
    status: z.enum(["ready", "rejected"]),
    errorCode: errorCode.optional(),
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
      .array(z.enum(RUNNER_CHANNEL_TYPES))
      .min(1)
      .max(RUNNER_CHANNEL_TYPES.length)
      .refine(
        (values) => new Set(values).size === values.length,
      ),
    clientVersion: safeString(128),
  })
  .strict();

const heartbeatFrameSchema = z
  .object({
    type: z.literal("heartbeat"),
    ...baseShape,
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

const serverFrameSchema = z.union([
  registeredFrameSchema,
  inboundAckFrameSchema,
  sendFrameSchema,
  attachmentAckFrameSchema,
]);
const runnerFrameSchema = z.union([
  registerFrameSchema,
  heartbeatFrameSchema,
  inboundFrameSchema,
  sendResultFrameSchema,
  attachmentStartFrameSchema,
  attachmentChunkFrameSchema,
  attachmentCommitFrameSchema,
  errorFrameSchema,
]);

export type RunnerRegisteredFrame = z.infer<
  typeof registeredFrameSchema
>;
export type RunnerInboundAckFrame = z.infer<
  typeof inboundAckFrameSchema
>;
export type RunnerSendFrame = z.infer<typeof sendFrameSchema>;
export type RunnerInboundFrame = z.infer<
  typeof inboundFrameSchema
>;
export type RunnerSendResultFrame = z.infer<
  typeof sendResultFrameSchema
>;
export type RunnerAttachmentAckFrame = z.infer<
  typeof attachmentAckFrameSchema
>;
export type RunnerSendOutcome = z.infer<
  typeof sendOutcomeSchema
>;
export type RunnerServerFrame = z.infer<
  typeof serverFrameSchema
>;
export type RunnerFrame = z.infer<typeof runnerFrameSchema>;
export type RunnerChannelType =
  (typeof RUNNER_CHANNEL_TYPES)[number];

export function parseRunnerServerFrame(
  raw: string | Buffer,
): RunnerServerFrame {
  if (Buffer.byteLength(raw) > RUNNER_MAX_FRAME_BYTES) {
    throw new Error("channel_node_frame_too_large");
  }
  return serverFrameSchema.parse(JSON.parse(raw.toString()));
}

export function parseRunnerInboundFrame(
  value: unknown,
): RunnerInboundFrame {
  return inboundFrameSchema.parse(value);
}

export function parseRunnerSendOutcome(
  value: unknown,
): RunnerSendOutcome {
  return sendOutcomeSchema.parse(value);
}

export function isRunnerSendOutcome(
  value: unknown,
): value is RunnerSendOutcome {
  return sendOutcomeSchema.safeParse(value).success;
}

export function serializeRunnerFrame(
  frame: RunnerFrame,
): string {
  const parsed = runnerFrameSchema.parse(frame);
  const serialized = JSON.stringify(parsed);
  if (Buffer.byteLength(serialized) > RUNNER_MAX_FRAME_BYTES) {
    throw new Error("channel_node_frame_too_large");
  }
  return serialized;
}
