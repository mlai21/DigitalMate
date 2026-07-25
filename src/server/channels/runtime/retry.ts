const MAX_RETRY_DELAY_MS = 300_000;

export function nextRetryAt(input: Readonly<{
  attempt: number;
  now: Date;
  retryAfterMs?: number;
  random: number;
}>): Date {
  if (!Number.isInteger(input.attempt) || input.attempt <= 0) {
    throw new Error("channel_retry_attempt_invalid");
  }
  if (!Number.isFinite(input.now.getTime())) {
    throw new Error("channel_retry_now_invalid");
  }
  if (
    !Number.isFinite(input.random)
    || input.random < 0
    || input.random > 1
  ) {
    throw new Error("channel_retry_random_invalid");
  }
  if (
    input.retryAfterMs !== undefined
    && (
      !Number.isFinite(input.retryAfterMs)
      || input.retryAfterMs < 0
    )
  ) {
    throw new Error("channel_retry_after_invalid");
  }

  const exponential = Math.min(
    MAX_RETRY_DELAY_MS,
    1_000 * 2 ** Math.max(0, input.attempt - 1),
  );
  const withJitter = Math.round(
    exponential * (0.8 + input.random * 0.4),
  );
  const delay = Math.max(
    input.retryAfterMs ?? 0,
    withJitter,
  );
  return new Date(input.now.getTime() + delay);
}
