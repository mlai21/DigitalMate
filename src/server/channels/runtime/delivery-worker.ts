import { splitAssistantText } from "@/server/agent/streaming";

import type {
  ClaimedChannelDelivery,
  DeliverySegmentStart,
} from "./delivery-repository";
import { nextRetryAt } from "./retry";
import type { SendResult, StreamingState } from "./types";

const DEFAULT_MAX_ATTEMPTS = 8;

export type { DeliverySegmentStart };

export type ChannelDeliveryMode =
  | "segmented"
  | "streaming"
  | "task-streaming";

export type ChannelDeliveryPart = Readonly<{
  delivery: ClaimedChannelDelivery;
  mode: ChannelDeliveryMode;
  segmentNo: number;
  segmentCount: number;
  body: string;
  state: StreamingState;
  previousResult: SendResult | null;
}>;

export type ChannelDeliverySegmentPlan = Readonly<{
  segments: readonly string[];
  prefix: string;
}>;

export type ChannelDeliveryTransport = Readonly<{
  mode(
    delivery: ClaimedChannelDelivery,
    signal: AbortSignal,
  ): Promise<ChannelDeliveryMode>;
  taskSegmentCodePointLimit?(
    delivery: ClaimedChannelDelivery,
    signal: AbortSignal,
  ): Promise<number>;
  segmentBodies?(
    delivery: ClaimedChannelDelivery,
    signal: AbortSignal,
  ): Promise<ChannelDeliverySegmentPlan | null>;
  send(
    part: ChannelDeliveryPart,
    signal: AbortSignal,
  ): Promise<SendResult>;
}>;

type DeliveryRepository = Readonly<{
  leaseDurationMs?: number;
  claimNext(
    owner: string,
    now?: Date,
  ): Promise<ClaimedChannelDelivery | null>;
  renew(
    claim: ClaimedChannelDelivery,
    now?: Date,
  ): Promise<Date | null>;
  freezeSegments(
    claim: ClaimedChannelDelivery,
    segments: readonly string[],
    now?: Date,
  ): Promise<string[]>;
  beginSegment(
    claim: ClaimedChannelDelivery,
    segmentNo: number,
    now?: Date,
  ): Promise<DeliverySegmentStart>;
  completeSegment(
    claim: ClaimedChannelDelivery,
    segmentNo: number,
    result: Readonly<{
      status: "sent" | "retryable" | "failed";
      platformResult?: SendResult;
      errorCode?: string;
    }>,
    now?: Date,
  ): Promise<boolean>;
  markSent(
    claim: ClaimedChannelDelivery,
    now?: Date,
  ): Promise<boolean>;
  scheduleRetry(
    claim: ClaimedChannelDelivery,
    nextAttemptAt: Date,
    errorCode: string,
    now?: Date,
  ): Promise<boolean>;
  deadLetter(
    claim: ClaimedChannelDelivery,
    errorCode: string,
    now?: Date,
  ): Promise<boolean>;
}>;

type DeliveryCadence = Readonly<{
  responseDelayMs: number;
  segmentDelayMs: number;
  maxSegments: number;
}>;

export class ChannelSendError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(input: Readonly<{
    code: string;
    retryable: boolean;
    retryAfterMs?: number;
  }>) {
    assertErrorCode(input.code);
    if (
      input.retryAfterMs !== undefined
      && (
        !Number.isFinite(input.retryAfterMs)
        || input.retryAfterMs < 0
      )
    ) {
      throw new Error("channel_send_retry_after_invalid");
    }
    super(input.code);
    this.name = "ChannelSendError";
    this.code = input.code;
    this.retryable = input.retryable;
    this.retryAfterMs = input.retryAfterMs;
  }
}

export class ChannelDeliveryDeferred extends Error {
  constructor() {
    super("channel_delivery_deferred");
    this.name = "ChannelDeliveryDeferred";
  }
}

export function createChannelDeliveryWorker(input: Readonly<{
  owner: string;
  deliveries: DeliveryRepository;
  transport: ChannelDeliveryTransport;
  loadCadence(
    delivery: ClaimedChannelDelivery,
  ): Promise<unknown>;
  now?: () => Date;
  random?: () => number;
  delay?: (
    milliseconds: number,
    signal?: AbortSignal,
  ) => Promise<unknown> | unknown;
  heartbeatMs?: number;
  maxAttempts?: number;
}>) {
  assertOwner(input.owner);
  const now = input.now ?? (() => new Date());
  const random = input.random ?? Math.random;
  const maxAttempts = validateMaxAttempts(
    input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
  );
  const heartbeatMs = validateHeartbeat(
    input.heartbeatMs
      ?? Math.max(
        100,
        Math.min(
          10_000,
          Math.floor(
            (input.deliveries.leaseDurationMs ?? 30_000) / 3,
          ),
        ),
      ),
  );

  const worker = {
    async runOne(
      options: Readonly<{ signal?: AbortSignal }> = {},
    ): Promise<boolean> {
      options.signal?.throwIfAborted();
      const claim = await input.deliveries.claimNext(
        input.owner,
        now(),
      );
      if (!claim) return false;

      const signal = options.signal ?? new AbortController().signal;
      const heartbeat = startHeartbeat({
        deliveries: input.deliveries,
        claim,
        intervalMs: heartbeatMs,
        now,
      });
      try {
        await processDelivery({
          claim,
          deliveries: input.deliveries,
          transport: input.transport,
          cadence: normalizeCadence(
            await input.loadCadence(claim),
          ),
          maxAttempts,
          now,
          random,
          delay: input.delay ?? delayWithSignal,
          signal,
        });
        return true;
      } finally {
        heartbeat.stop();
      }
    },

    async drainUntilIdle(
      options: Readonly<{
        signal?: AbortSignal;
        maxClaims?: number;
      }> = {},
    ): Promise<number> {
      const maxClaims = options.maxClaims ?? 1_000;
      if (
        !Number.isInteger(maxClaims)
        || maxClaims <= 0
        || maxClaims > 100_000
      ) {
        throw new Error("channel_delivery_drain_limit_invalid");
      }
      let processed = 0;
      while (processed < maxClaims) {
        const didProcess = await worker.runOne({
          signal: options.signal,
        });
        if (!didProcess) break;
        processed += 1;
      }
      return processed;
    },
  };

  return worker;
}

export function segmentDeliveryBody(
  body: string,
  cadence: Readonly<{ maxSegments: number }>,
): string[] {
  const maxSegments = normalizeMaxSegments(cadence.maxSegments);
  const parts = splitAssistantText(body);
  if (parts.length <= maxSegments) return parts;
  if (maxSegments === 1) return [parts.join("\n\n")];
  return [
    ...parts.slice(0, maxSegments - 1),
    parts.slice(maxSegments - 1).join("\n\n"),
  ];
}

export function segmentTaskDeliveryBody(
  body: string,
  maxCodePoints = 4_000,
): string[] {
  if (
    !Number.isInteger(maxCodePoints)
    || maxCodePoints <= 0
    || maxCodePoints > 4_000
  ) {
    throw new Error("channel_task_segment_limit_invalid");
  }
  const codePoints = Array.from(body);
  const segments: string[] = [];
  for (
    let index = 0;
    index < codePoints.length;
    index += maxCodePoints
  ) {
    segments.push(
      codePoints
        .slice(index, index + maxCodePoints)
        .join(""),
    );
  }
  if (segments.length > 0) {
    segments.push("");
  }
  return segments;
}

async function processDelivery(input: {
  claim: ClaimedChannelDelivery;
  deliveries: DeliveryRepository;
  transport: ChannelDeliveryTransport;
  cadence: DeliveryCadence;
  maxAttempts: number;
  now: () => Date;
  random: () => number;
  delay(
    milliseconds: number,
    signal?: AbortSignal,
  ): Promise<unknown> | unknown;
  signal: AbortSignal;
}): Promise<void> {
  input.signal.throwIfAborted();
  const cycleAttempt = input.claim.attempts
    - input.claim.attemptCycleBaseline;
  if (!Number.isInteger(cycleAttempt) || cycleAttempt <= 0) {
    throw new Error("channel_delivery_attempt_cycle_invalid");
  }
  if (cycleAttempt > input.maxAttempts) {
    await requireClaimMutation(
      input.deliveries.deadLetter(
        input.claim,
        "delivery_attempts_exhausted",
        input.now(),
      ),
    );
    return;
  }

  const mode = await input.transport.mode(
    input.claim,
    input.signal,
  );
  const computedSegments = mode === "task-streaming"
    ? segmentTaskDeliveryBody(
        input.claim.body,
        await input.transport.taskSegmentCodePointLimit?.(
          input.claim,
          input.signal,
        ) ?? 4_000,
      )
    : mode === "segmented"
      ? await segmentedDeliveryBodies(input)
      : segmentDeliveryBody(
          input.claim.body,
          input.cadence,
        );
  const segments = computedSegments.length > 0
    ? await input.deliveries.freezeSegments(
        input.claim,
        computedSegments,
        input.now(),
      )
    : computedSegments;
  if (segments.length === 0) {
    await requireClaimMutation(
      input.deliveries.deadLetter(
        input.claim,
        "delivery_body_empty",
        input.now(),
      ),
    );
    return;
  }

  let previousResult: SendResult | null = null;
  for (const [index, segment] of segments.entries()) {
    input.signal.throwIfAborted();
    const delayMs = index === 0
      ? input.cadence.responseDelayMs
      : input.cadence.segmentDelayMs;
    if (delayMs > 0) {
      await input.delay(delayMs, input.signal);
      input.signal.throwIfAborted();
    }

    const segmentNo = index + 1;
    const started = await input.deliveries.beginSegment(
      input.claim,
      segmentNo,
      input.now(),
    );
    if (started.action === "already_sent") {
      previousResult =
        started.previousResult ?? previousResult;
      continue;
    }
    if (started.action === "ambiguous") {
      await requireClaimMutation(
        input.deliveries.deadLetter(
          input.claim,
          "delivery_outcome_unknown",
          input.now(),
        ),
      );
      return;
    }

    let result: SendResult;
    try {
      const cumulativeBody = segments
        .slice(0, segmentNo)
        .join(mode === "task-streaming" ? "" : "\n\n");
      result = await input.transport.send({
        delivery: input.claim,
        mode,
        segmentNo,
        segmentCount: segments.length,
        body: mode === "streaming"
          || mode === "task-streaming"
          ? cumulativeBody
          : segment,
        state: {
          sequence: segmentNo,
          final: segmentNo === segments.length,
        },
        previousResult,
      }, input.signal);
      result = validateSendResult(
        result,
        mode,
        previousResult,
      );
    } catch (error) {
      if (input.signal.aborted) throw error;
      if (error instanceof ChannelDeliveryDeferred) {
        return;
      }
      const failure = normalizeSendFailure(error);
      await requireClaimMutation(
        input.deliveries.completeSegment(
          input.claim,
          segmentNo,
          {
            status: failure.retryable
              ? "retryable"
              : "failed",
            errorCode: failure.code,
          },
          input.now(),
        ),
      );
      if (
        !failure.retryable
        || cycleAttempt >= input.maxAttempts
      ) {
        await requireClaimMutation(
          input.deliveries.deadLetter(
            input.claim,
            failure.code,
            input.now(),
          ),
        );
        return;
      }
      await requireClaimMutation(
        input.deliveries.scheduleRetry(
          input.claim,
          nextRetryAt({
            attempt: cycleAttempt,
            now: input.now(),
            retryAfterMs: failure.retryAfterMs,
            random: input.random(),
          }),
          failure.code,
          input.now(),
        ),
      );
      return;
    }
    await requireClaimMutation(
      input.deliveries.completeSegment(
        input.claim,
        segmentNo,
        {
          status: "sent",
          platformResult: result,
        },
        input.now(),
      ),
    );
    previousResult = result;
  }

  await requireClaimMutation(
    input.deliveries.markSent(input.claim, input.now()),
  );
}

async function segmentedDeliveryBodies(input: {
  claim: ClaimedChannelDelivery;
  transport: ChannelDeliveryTransport;
  cadence: DeliveryCadence;
  signal: AbortSignal;
}): Promise<string[]> {
  const custom = await input.transport.segmentBodies?.(
    input.claim,
    input.signal,
  );
  if (custom === undefined || custom === null) {
    return segmentDeliveryBody(
      input.claim.body,
      input.cadence,
    );
  }
  const { segments, prefix } = custom;
  if (
    typeof prefix !== "string"
    || segments.length === 0
    || segments.length > 10_000
    || segments.some((segment) =>
      typeof segment !== "string"
      || segment.length === 0
    )
    || segments.join("") !== input.claim.body
  ) {
    throw new Error("channel_delivery_segments_invalid");
  }
  return [
    `${prefix}${segments[0]}`,
    ...segments.slice(1),
  ];
}

function normalizeCadence(value: unknown): DeliveryCadence {
  const cadence = typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
  return {
    responseDelayMs: boundedDelay(cadence.responseDelayMs),
    segmentDelayMs: boundedDelay(cadence.segmentDelayMs),
    maxSegments: normalizeMaxSegments(cadence.maxSegments),
  };
}

function boundedDelay(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) && numeric > 0
    ? Math.min(Math.floor(numeric), 2_000)
    : 0;
}

function normalizeMaxSegments(value: unknown): number {
  const numeric = Number(value ?? 5);
  return Number.isFinite(numeric) && numeric > 0
    ? Math.min(Math.floor(numeric), 20)
    : 5;
}

function normalizeSendFailure(error: unknown): {
  code: string;
  retryable: boolean;
  retryAfterMs?: number;
} {
  if (error instanceof ChannelSendError) {
    const nonRetryable = new Set([
      "credential_invalid",
      "permission_denied",
      "runtime_prerequisite_missing",
    ]);
    return {
      code: error.code,
      retryable:
        !nonRetryable.has(error.code)
        && error.retryable,
      retryAfterMs: error.retryAfterMs,
    };
  }
  return {
    code: "network_unreachable",
    retryable: true,
  };
}

function validateSendResult(
  result: SendResult,
  mode: ChannelDeliveryMode,
  previousResult: SendResult | null,
): SendResult {
  if (
    typeof result.externalMessageId !== "string"
    || result.externalMessageId.trim().length === 0
    || result.externalMessageId.length > 1_024
    || !(result.sentAt instanceof Date)
    || !Number.isFinite(result.sentAt.getTime())
    || typeof result.rawSummary !== "object"
    || result.rawSummary === null
    || Array.isArray(result.rawSummary)
    || (
      (
        mode === "streaming"
        || mode === "task-streaming"
      )
      && previousResult !== null
      && previousResult.externalMessageId
        !== result.externalMessageId
    )
  ) {
    throw new ChannelSendError({
      code: "platform_result_invalid",
      retryable: false,
    });
  }
  return {
    externalMessageId: result.externalMessageId,
    sentAt: result.sentAt,
    rawSummary: Object.fromEntries(
      Object.entries(result.rawSummary)
        .filter(([key, value]) =>
          key.length <= 128
          && !/(?:authorization|cookie|password|secret|signature|token)/i
            .test(key)
          && (
            value === null
            || typeof value === "boolean"
            || (
              typeof value === "number"
              && Number.isFinite(value)
            )
            || (
              typeof value === "string"
              && value.length <= 4_096
            )
          )
        )
        .slice(0, 128),
    ),
  };
}

async function requireClaimMutation(
  operation: Promise<boolean>,
): Promise<void> {
  if (!await operation) {
    throw new Error("channel_delivery_claim_lost");
  }
}

function startHeartbeat(input: {
  deliveries: DeliveryRepository;
  claim: ClaimedChannelDelivery;
  intervalMs: number;
  now: () => Date;
}) {
  let stopped = false;
  let renewing = false;
  const timer = setInterval(() => {
    if (stopped || renewing) return;
    renewing = true;
    void input.deliveries.renew(input.claim, input.now())
      .catch(() => null)
      .finally(() => {
        renewing = false;
      });
  }, input.intervalMs);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

function delayWithSignal(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      cleanup();
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });

    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }

    function finish() {
      cleanup();
      resolve();
    }
  });
}

function assertOwner(owner: string): void {
  if (owner.trim().length === 0 || owner.length > 256) {
    throw new Error("channel_delivery_worker_owner_invalid");
  }
}

function assertErrorCode(code: string): void {
  if (
    code.trim().length === 0
    || code.length > 128
    || !/^[a-z0-9_:-]+$/i.test(code)
  ) {
    throw new Error("channel_send_error_code_invalid");
  }
}

function validateMaxAttempts(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > 100) {
    throw new Error("channel_delivery_max_attempts_invalid");
  }
  return value;
}

function validateHeartbeat(value: number): number {
  if (!Number.isInteger(value) || value < 100 || value > 60_000) {
    throw new Error("channel_delivery_heartbeat_invalid");
  }
  return value;
}
