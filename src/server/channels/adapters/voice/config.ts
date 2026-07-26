import {
  getChannelManifest,
} from "@/server/channels/manifests/catalog";

export type VoiceConfig = Record<string, unknown> & Readonly<{
  enabled: boolean;
  bot_prefix: string;
  twilio_account_sid: string;
  twilio_auth_token: string;
  phone_number: string;
  phone_number_sid: string;
  tts_provider: "google" | "amazon" | "elevenlabs";
  tts_voice: string;
  stt_provider: "google" | "deepgram";
  language: string;
  welcome_greeting: string;
  max_concurrent_calls: number;
}>;

const ACCOUNT_SID = /^AC[0-9a-f]{32}$/i;
const PHONE_NUMBER_SID = /^PN[0-9a-f]{32}$/i;
const E164 = /^\+[1-9][0-9]{7,14}$/;
const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const TTS_PROVIDERS = new Set([
  "google",
  "amazon",
  "elevenlabs",
]);
const STT_PROVIDERS = new Set(["google", "deepgram"]);

export function parseVoiceConfig(input: unknown): VoiceConfig {
  if (
    input
    && typeof input === "object"
    && Object.hasOwn(input, "max_concurrent_calls")
  ) {
    const maximum = (
      input as Record<string, unknown>
    ).max_concurrent_calls;
    if (
      typeof maximum !== "number"
      || !Number.isSafeInteger(maximum)
      || maximum < 1
      || maximum > 100
    ) {
      throw new Error("voice_max_concurrent_calls_invalid");
    }
  }
  const parsed = getChannelManifest("voice")
    .configSchema.parse(input) as Record<string, unknown>;
  if (
    typeof parsed.twilio_account_sid !== "string"
    || !ACCOUNT_SID.test(parsed.twilio_account_sid)
  ) {
    throw new Error("voice_twilio_account_sid_invalid");
  }
  if (
    typeof parsed.twilio_auth_token !== "string"
    || parsed.twilio_auth_token.trim().length === 0
  ) {
    throw new Error("voice_twilio_auth_token_required");
  }
  if (
    typeof parsed.phone_number !== "string"
    || !E164.test(parsed.phone_number)
  ) {
    throw new Error("voice_phone_number_invalid");
  }
  if (
    typeof parsed.phone_number_sid !== "string"
    || !PHONE_NUMBER_SID.test(parsed.phone_number_sid)
  ) {
    throw new Error("voice_phone_number_sid_invalid");
  }
  const ttsProvider = normalizedProvider(parsed.tts_provider);
  if (!TTS_PROVIDERS.has(ttsProvider)) {
    throw new Error("voice_tts_provider_invalid");
  }
  const sttProvider = normalizedProvider(parsed.stt_provider);
  if (!STT_PROVIDERS.has(sttProvider)) {
    throw new Error("voice_stt_provider_invalid");
  }
  if (
    typeof parsed.tts_voice !== "string"
    || parsed.tts_voice.trim().length === 0
    || !isXml10Text(parsed.tts_voice)
  ) {
    throw new Error("voice_tts_voice_required");
  }
  if (
    typeof parsed.language !== "string"
    || !LANGUAGE.test(parsed.language)
  ) {
    throw new Error("voice_language_invalid");
  }
  if (
    typeof parsed.max_concurrent_calls !== "number"
    || !Number.isSafeInteger(parsed.max_concurrent_calls)
    || parsed.max_concurrent_calls < 1
    || parsed.max_concurrent_calls > 100
  ) {
    throw new Error("voice_max_concurrent_calls_invalid");
  }
  if (
    typeof parsed.welcome_greeting !== "string"
    || !isXml10Text(parsed.welcome_greeting)
  ) {
    throw new Error("voice_welcome_greeting_invalid");
  }
  return {
    ...parsed,
    tts_provider:
      ttsProvider as VoiceConfig["tts_provider"],
    stt_provider:
      sttProvider as VoiceConfig["stt_provider"],
  } as VoiceConfig;
}

function normalizedProvider(value: unknown): string {
  return typeof value === "string"
    ? value.trim().toLowerCase()
    : "";
}

function isXml10Text(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint !== 0x09
      && codePoint !== 0x0a
      && codePoint !== 0x0d
      && (
        codePoint < 0x20
        || codePoint === 0xfffe
        || codePoint === 0xffff
      )
    ) {
      return false;
    }
  }
  return true;
}
