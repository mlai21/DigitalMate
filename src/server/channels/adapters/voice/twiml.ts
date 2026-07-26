import type { VoiceConfig } from "./config";

const PROVIDER_LABELS = {
  google: "Google",
  amazon: "Amazon",
  elevenlabs: "ElevenLabs",
  deepgram: "Deepgram",
} as const;

export function buildConversationRelayTwiml(
  config: VoiceConfig,
  relayUrl: string,
): string {
  const attributes = {
    url: relayUrl,
    welcomeGreeting: config.welcome_greeting,
    ttsProvider: PROVIDER_LABELS[config.tts_provider],
    voice: config.tts_voice,
    transcriptionProvider:
      PROVIDER_LABELS[config.stt_provider],
    language: config.language,
    interruptible: "any",
  };
  const serialized = Object.entries(attributes)
    .map(([name, value]) =>
      `${name}="${escapeXmlAttribute(value)}"`
    )
    .join(" ");
  return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
    + `<Response><Connect><ConversationRelay ${serialized}`
    + " /></Connect></Response>";
}

export function buildBusyTwiml(
  message = "正在处理另一通电话，请稍后再试。",
): string {
  return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
    + `<Response><Say>${escapeXmlText(message)}</Say></Response>`;
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value)
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function escapeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
