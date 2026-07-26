import { randomUUID } from "node:crypto";

import type { SipIncomingCall } from "./backend.js";

type TimerHandle = ReturnType<typeof setTimeout>;

type SipSession = {
  call: SipIncomingCall;
  callInstanceId: string;
  utteranceSequence: number;
  timeout: TimerHandle;
  playback: AbortController | null;
  deliveryId: string | null;
};

export class SipCallSessionManager {
  readonly #sessions = new Map<string, SipSession>();
  readonly #maximumCalls: number;
  readonly #callTimeoutMilliseconds: number;
  readonly #onTimeout: (callId: string) => Promise<void>;
  readonly #createCallInstanceId: () => string;

  constructor(input: Readonly<{
    maximumCalls: number;
    callTimeoutMilliseconds: number;
    onTimeout(callId: string): Promise<void>;
    createCallInstanceId?: () => string;
  }>) {
    this.#maximumCalls = input.maximumCalls;
    this.#callTimeoutMilliseconds =
      input.callTimeoutMilliseconds;
    this.#onTimeout = input.onTimeout;
    this.#createCallInstanceId =
      input.createCallInstanceId ?? randomUUID;
  }

  begin(
    call: SipIncomingCall,
  ): Readonly<{ status: "accepted" }>
    | Readonly<{ status: "busy" }> {
    if (this.#sessions.has(call.callId)) {
      return { status: "accepted" };
    }
    if (this.#sessions.size >= this.#maximumCalls) {
      return { status: "busy" };
    }
    const timeout = setTimeout(() => {
      const session = this.#sessions.get(call.callId);
      if (!session) return;
      this.end(call.callId);
      void this.#onTimeout(call.callId)
        .catch(() => undefined);
    }, this.#callTimeoutMilliseconds);
    timeout.unref?.();
    this.#sessions.set(call.callId, {
      call,
      callInstanceId: this.#createCallInstanceId(),
      utteranceSequence: 0,
      timeout,
      playback: null,
      deliveryId: null,
    });
    return { status: "accepted" };
  }

  has(callId: string): boolean {
    return this.#sessions.has(callId);
  }

  count(): number {
    return this.#sessions.size;
  }

  call(callId: string): SipIncomingCall | null {
    return this.#sessions.get(callId)?.call ?? null;
  }

  nextUtteranceId(callId: string): string {
    const session = this.#require(callId);
    if (session.utteranceSequence >= Number.MAX_SAFE_INTEGER) {
      throw new Error("sip_utterance_sequence_exhausted");
    }
    session.utteranceSequence += 1;
    return (
      `${callId}:utterance:${session.callInstanceId}:`
      + `${session.utteranceSequence}`
    );
  }

  beginPlayback(
    callId: string,
    deliveryId: string,
  ): AbortSignal {
    const session = this.#require(callId);
    session.playback?.abort();
    const controller = new AbortController();
    session.playback = controller;
    session.deliveryId = deliveryId;
    return controller.signal;
  }

  interruptPlayback(callId: string): void {
    this.#sessions.get(callId)?.playback?.abort();
  }

  end(callId: string): boolean {
    const session = this.#sessions.get(callId);
    if (!session) return false;
    this.#sessions.delete(callId);
    clearTimeout(session.timeout);
    session.playback?.abort();
    return true;
  }

  stop(): void {
    for (const callId of [...this.#sessions.keys()]) {
      this.end(callId);
    }
  }

  #require(callId: string): SipSession {
    const session = this.#sessions.get(callId);
    if (!session) throw new Error("sip_call_not_active");
    return session;
  }
}
