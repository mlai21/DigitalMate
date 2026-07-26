import twilio from "twilio";

export const TWILIO_WEBHOOK_TIMEOUT_MS = 30_000;

export type TwilioWebhookConfiguration = Readonly<{
  accountSid: string;
  authToken: string;
  phoneNumberSid: string;
  voiceUrl: string;
  statusCallback: string;
  signal: AbortSignal;
}>;

export type ConfigureTwilioWebhook = (
  input: TwilioWebhookConfiguration,
) => Promise<void>;

export const configureTwilioWebhook:
ConfigureTwilioWebhook = async (input) => {
  input.signal.throwIfAborted();
  const client = twilio(input.accountSid, input.authToken);
  const update = client
    .incomingPhoneNumbers(input.phoneNumberSid)
    .update({
      voiceUrl: input.voiceUrl,
      voiceMethod: "POST",
      statusCallback: input.statusCallback,
      statusCallbackMethod: "POST",
    })
    .then(() => undefined);
  try {
    await withTimeoutAndAbort(
      update,
      input.signal,
      TWILIO_WEBHOOK_TIMEOUT_MS,
    );
  } catch {
    input.signal.throwIfAborted();
    throw new Error("voice_webhook_configuration_failed");
  }
};

async function withTimeoutAndAbort<T>(
  work: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let detachAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("voice_webhook_timeout")),
      timeoutMs,
    );
    timer.unref();
  });
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(
      signal.reason instanceof Error
        ? signal.reason
        : new Error("voice_webhook_aborted"),
    );
    signal.addEventListener("abort", onAbort, { once: true });
    detachAbort = () =>
      signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([work, timeout, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    detachAbort?.();
  }
}
