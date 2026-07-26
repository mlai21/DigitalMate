import type {
  ChannelNodeSendOutcome,
  RunnerInboundDraft,
} from "../client.js";
import type { RunnerSendFrame } from "../protocol.js";
import type {
  SipBackend,
  SipIncomingCall,
} from "./backend.js";
import type { SipRunnerConfig } from "./config.js";
import { encodeMuLaw, pcm16LeToSamples } from "./rtp.js";
import { SipCallSessionManager } from "./session.js";
import type {
  SipSpeechRecognizer,
  SipSpeechSession,
} from "./stt.js";
import type { SipSpeechSynthesizer } from "./tts.js";

export function createSipTransport(input: Readonly<{
  config: SipRunnerConfig;
  backend: SipBackend;
  recognizer: SipSpeechRecognizer;
  synthesizer: SipSpeechSynthesizer;
  enqueueInbound(draft: RunnerInboundDraft): Promise<unknown>;
  now?: () => Date;
}>) {
  if (input.config.mode !== input.backend.kind) {
    throw new Error("sip_backend_mode_mismatch");
  }
  const now = input.now ?? (() => new Date());
  const speechSessions = new Map<string, SipSpeechSession>();
  const sessions = new SipCallSessionManager({
    maximumCalls: input.config.maxCalls,
    callTimeoutMilliseconds:
      input.config.callTimeoutMilliseconds,
    onTimeout: async (callId) => {
      await stopSpeech(callId);
      await input.backend.hangup(callId, "timeout");
    },
  });
  let started = false;

  async function onIncomingCall(
    call: SipIncomingCall,
  ): Promise<"accepted" | "busy" | "unavailable"> {
    const disposition = sessions.begin(call);
    if (disposition.status === "busy") {
      return "busy";
    }
    try {
      const speech = await input.recognizer.startCall({
        callId: call.callId,
        sampleRate: input.backend.sampleRate,
        language: input.config.language,
        onSpeechStart() {
          sessions.interruptPlayback(call.callId);
          void input.backend.interruptAudio(call.callId)
            .catch(() => undefined);
        },
        onPartialTranscript() {
          // Partial transcripts are deliberately ephemeral.
        },
        async onFinalTranscript(text) {
          await emitFinalTranscript(call, text);
        },
        async onSessionError() {
          if (!sessions.end(call.callId)) return;
          speechSessions.delete(call.callId);
          await input.backend.hangup(
            call.callId,
            "stt_provider_unavailable",
          );
        },
      });
      speechSessions.set(call.callId, speech);
      return "accepted";
    } catch {
      sessions.end(call.callId);
      await stopSpeech(call.callId);
      return "unavailable";
    }
  }

  async function emitFinalTranscript(
    call: SipIncomingCall,
    transcript: string,
  ): Promise<void> {
    const text = transcript.trim();
    if (!text || !sessions.has(call.callId)) return;
    const externalEventId =
      sessions.nextUtteranceId(call.callId);
    await input.enqueueInbound({
      connectionId: input.config.connectionId,
      payload: {
        externalEventId,
        externalConversationId: call.callId,
        externalSenderId: call.fromUri,
        chatType: "direct",
        mentioned: false,
        text,
        thread: {},
        attachments: [],
        occurredAt: now().toISOString(),
        rawSummary: {
          kind: "sip_final_transcript",
          backend: input.backend.kind,
        },
        replyHandle: {
          publicFields: {
            callId: call.callId,
          },
          secretFields: {},
          expiresAt: null,
        },
      },
    });
  }

  async function playText(
    callId: string,
    deliveryId: string,
    text: string,
    onFrame?: () => void,
  ): Promise<Readonly<{
    frames: number;
    interrupted: boolean;
  }>> {
    const signal = sessions.beginPlayback(
      callId,
      deliveryId,
    );
    let pending = Buffer.alloc(0);
    let frames = 0;
    const pcmFrameBytes =
      input.backend.sampleRate === 8_000 ? 320 : 960;
    for await (const chunk of input.synthesizer.synthesize({
      text,
      voice: input.config.voice,
      sampleRate: input.backend.sampleRate,
      signal,
    })) {
      if (signal.aborted) break;
      if (
        !Buffer.isBuffer(chunk)
        || chunk.byteLength === 0
        || chunk.byteLength % 2 !== 0
      ) {
        throw new Error("sip_tts_pcm_invalid");
      }
      pending = pending.byteLength === 0
        ? Buffer.from(chunk)
        : Buffer.concat([pending, chunk]);
      while (pending.byteLength >= pcmFrameBytes) {
        if (signal.aborted) break;
        const pcm = pending.subarray(0, pcmFrameBytes);
        pending = pending.subarray(pcmFrameBytes);
        const frame = input.backend.kind === "dev"
          ? encodeMuLaw(pcm16LeToSamples(pcm))
          : Buffer.from(pcm);
        const played =
          await input.backend.playAudio(callId, frame);
        if (played) {
          frames += 1;
          onFrame?.();
        }
      }
    }
    if (!signal.aborted && pending.byteLength > 0) {
      const padded = Buffer.alloc(pcmFrameBytes);
      pending.copy(padded);
      const frame = input.backend.kind === "dev"
        ? encodeMuLaw(pcm16LeToSamples(padded))
        : padded;
      const played =
        await input.backend.playAudio(callId, frame);
      if (played) {
        frames += 1;
        onFrame?.();
      }
    }
    if (!signal.aborted && frames === 0) {
      throw new Error("sip_tts_empty_audio");
    }
    return {
      frames,
      interrupted: signal.aborted,
    };
  }

  async function stopSpeech(callId: string): Promise<void> {
    const speech = speechSessions.get(callId);
    speechSessions.delete(callId);
    await speech?.stop();
  }

  return {
    async start(): Promise<void> {
      if (started) return;
      started = true;
      try {
        await input.backend.start({
          onIncomingCall,
          async onCallReady(callId) {
            if (
              input.config.greeting
              && sessions.has(callId)
            ) {
              await playText(
                callId,
                `greeting:${callId}`,
                input.config.greeting,
              );
            }
          },
          async onPcm(callId, pcm16) {
            if (!sessions.has(callId)) return;
            await speechSessions.get(callId)?.pushPcm(pcm16);
          },
          async onSpeechStart(callId) {
            sessions.interruptPlayback(callId);
            await input.backend.interruptAudio(callId);
          },
          async onCallEnded(callId) {
            sessions.end(callId);
            await stopSpeech(callId);
          },
        });
      } catch (error) {
        started = false;
        throw error;
      }
    },
    async stop(): Promise<void> {
      if (!started) return;
      started = false;
      sessions.stop();
      await Promise.allSettled(
        [...speechSessions.values()].map(
          (speech) => speech.stop(),
        ),
      );
      speechSessions.clear();
      await input.backend.stop();
    },
    async send(
      frame: RunnerSendFrame,
    ): Promise<ChannelNodeSendOutcome> {
      const callId =
        frame.payload.recipient.externalConversationId;
      if (
        frame.payload.recipient.chatType !== "direct"
        || frame.payload.recipient.externalThreadId
      ) {
        return {
          status: "failed",
          errorCode: "sip_direct_call_required",
        };
      }
      const replyCallId =
        frame.payload.replyHandle?.publicFields.callId;
      if (replyCallId !== callId) {
        return {
          status: "failed",
          errorCode: "sip_reply_handle_mismatch",
        };
      }
      const call = sessions.call(callId);
      if (!started || !call) {
        return {
          status: "failed",
          errorCode: "sip_call_not_active",
        };
      }
      const externalUserId =
        frame.payload.recipient.externalUserId;
      if (
        externalUserId
        && externalUserId !== call.fromUri
      ) {
        return {
          status: "failed",
          errorCode: "sip_recipient_mismatch",
        };
      }
      let playedFrames = 0;
      try {
        const result = await playText(
          callId,
          frame.deliveryId,
          frame.payload.body,
          () => {
            playedFrames += 1;
          },
        );
        return {
          status: "sent",
          externalMessageId: `sip:${frame.deliveryId}`,
          platformSentAt: now().toISOString(),
          rawSummary: {
            backend: input.backend.kind,
            interrupted: result.interrupted,
            frameCount: result.frames,
          },
        };
      } catch {
        return playedFrames === 0
          ? {
              status: "retryable",
              errorCode: "sip_media_temporarily_unavailable",
              retryAfterMs: 1_000,
            }
          : {
              status: "failed",
              errorCode: "sip_send_outcome_unknown",
            };
      }
    },
    activeCallCount(): number {
      return sessions.count();
    },
  };
}
