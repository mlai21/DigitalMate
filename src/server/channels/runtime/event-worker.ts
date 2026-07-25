import type { ClaimedChannelEvent } from "./event-repository";
import type { ChannelTurnExecutor } from "./turn-executor";

type EventRepository = Readonly<{
  leaseDurationMs?: number;
  claimNext(
    owner: string,
    now?: Date,
  ): Promise<ClaimedChannelEvent | null>;
  renew(
    claim: ClaimedChannelEvent,
    now?: Date,
  ): Promise<Date | null>;
  fail(
    claim: ClaimedChannelEvent,
    failureCode: string,
    now?: Date,
  ): Promise<boolean>;
}>;

export class ChannelProcessCrashError extends Error {
  readonly isChannelProcessCrash = true;

  constructor(point: string) {
    super(`fault_injected:${point}`);
    this.name = "ChannelProcessCrashError";
  }
}

export function createChannelEventWorker(input: Readonly<{
  owner: string;
  events: EventRepository;
  executor: ChannelTurnExecutor;
  now?: () => Date;
  heartbeatMs?: number;
}>) {
  assertOwner(input.owner);
  const now = input.now ?? (() => new Date());
  const heartbeatMs = validateHeartbeat(
    input.heartbeatMs
      ?? Math.max(
        100,
        Math.min(
          20_000,
          Math.floor(
            (input.events.leaseDurationMs ?? 60_000) / 3,
          ),
        ),
      ),
  );

  return {
    async runOne(
      options: Readonly<{ signal?: AbortSignal }> = {},
    ): Promise<boolean> {
      options.signal?.throwIfAborted();
      const claim = await input.events.claimNext(
        input.owner,
        now(),
      );
      if (!claim) return false;

      const heartbeat = startHeartbeat({
        events: input.events,
        claim,
        intervalMs: heartbeatMs,
        now,
      });
      try {
        await input.executor.execute(claim, {
          signal: options.signal,
        });
        return true;
      } catch (error) {
        if (
          isChannelProcessCrash(error)
          || options.signal?.aborted === true
        ) {
          throw error;
        }
        await input.events.fail(
          claim,
          stableChannelErrorCode(error),
          now(),
        );
        throw error;
      } finally {
        heartbeat.stop();
      }
    },
  };
}

function startHeartbeat(input: {
  events: EventRepository;
  claim: ClaimedChannelEvent;
  intervalMs: number;
  now: () => Date;
}) {
  let stopped = false;
  let renewing = false;
  const timer = setInterval(() => {
    if (stopped || renewing) return;
    renewing = true;
    void input.events.renew(input.claim, input.now())
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

function isChannelProcessCrash(
  error: unknown,
): error is ChannelProcessCrashError {
  return (
    error instanceof ChannelProcessCrashError
    || (
      typeof error === "object"
      && error !== null
      && "isChannelProcessCrash" in error
      && error.isChannelProcessCrash === true
    )
  );
}

function stableChannelErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "channel_turn_failed";
  const candidate = error.message.toLowerCase();
  if (
    candidate.length <= 128
    && /^[a-z0-9_:-]+$/.test(candidate)
    && [
      "attachment_",
      "channel_",
      "client_turn_",
      "execution_",
    ].some((prefix) => candidate.startsWith(prefix))
  ) {
    return candidate;
  }
  return "channel_turn_failed";
}

function assertOwner(owner: string): void {
  if (owner.trim().length === 0 || owner.length > 256) {
    throw new Error("channel_worker_owner_invalid");
  }
}

function validateHeartbeat(value: number): number {
  if (!Number.isInteger(value) || value < 100 || value > 60_000) {
    throw new Error("channel_worker_heartbeat_invalid");
  }
  return value;
}
