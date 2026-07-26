import { randomUUID } from "node:crypto";

import WebSocket, { type RawData } from "ws";

export type SipSpeechSession = Readonly<{
  pushPcm(pcm16: Buffer): Promise<void>;
  stop(): Promise<void>;
}>;

export interface SipSpeechRecognizer {
  startCall(input: Readonly<{
    callId: string;
    sampleRate: 8_000 | 24_000;
    language: string;
    onSpeechStart(): void;
    onPartialTranscript(text: string): void;
    onFinalTranscript(text: string): Promise<void>;
    onSessionError?(error: Error): Promise<void> | void;
  }>): Promise<SipSpeechSession>;
}

type DashScopeEvent = Readonly<{
  header?: Readonly<{
    event?: string;
    task_id?: string;
  }>;
  payload?: Readonly<{
    output?: Readonly<{
      sentence?: Readonly<{
        text?: string;
        sentence_end?: boolean;
      }>;
    }>;
  }>;
}>;

export function createDashScopeSpeechRecognizer(
  input: Readonly<{
    apiKey: string;
    endpoint?: string;
    createSocket?: (
      url: string,
      options: WebSocket.ClientOptions,
    ) => WebSocket;
  }>,
): SipSpeechRecognizer {
  const endpoint =
    input.endpoint
    ?? "wss://dashscope.aliyuncs.com/api-ws/v1/inference/";
  const createSocket =
    input.createSocket
    ?? ((url, options) => new WebSocket(url, options));
  if (!input.apiKey) {
    throw new Error("sip_dashscope_api_key_required");
  }
  return {
    async startCall(callInput) {
      const taskId = randomUUID();
      const socket = createSocket(endpoint, {
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
        },
        handshakeTimeout: 10_000,
        perMessageDeflate: false,
        maxPayload: 256 * 1024,
      });
      let stopped = false;
      let started = false;
      let completed = false;
      let speaking = false;
      let providerFailed = false;
      let failureNotified = false;
      let dispatch = Promise.resolve();
      const ready = deferred<void>();
      const finished = deferred<void>();
      const fail = () => {
        if (providerFailed) return;
        providerFailed = true;
        const error = new Error(
          "sip_stt_provider_unavailable",
        );
        if (!started) ready.reject(error);
        if (
          started
          && !stopped
          && !completed
          && !failureNotified
        ) {
          failureNotified = true;
          dispatch = dispatch.then(
            () => callInput.onSessionError?.(error),
          ).catch(() => undefined);
        }
        finished.resolve();
      };
      socket.on("open", () => {
        socket.send(JSON.stringify({
          header: {
            action: "run-task",
            task_id: taskId,
            streaming: "duplex",
          },
          payload: {
            task_group: "audio",
            task: "asr",
            function: "recognition",
            model: callInput.sampleRate === 8_000
              ? "paraformer-realtime-8k-v2"
              : "paraformer-realtime-v2",
            parameters: {
              format: "pcm",
              sample_rate: callInput.sampleRate,
              language_hints: languageHints(
                callInput.language,
              ),
            },
            input: {},
          },
        }));
      });
      socket.on(
        "message",
        (data: RawData, isBinary: boolean) => {
          if (isBinary) return;
          const event = parseDashScopeEvent(data);
          if (
            event.header?.task_id
            && event.header.task_id !== taskId
          ) {
            return;
          }
          if (
            stopped
            && event.header?.event !== "task-finished"
            && event.header?.event !== "task-failed"
          ) {
            return;
          }
          switch (event.header?.event) {
            case "task-started":
              started = true;
              ready.resolve();
              break;
            case "result-generated": {
              const sentence =
                event.payload?.output?.sentence;
              const text = sentence?.text?.trim() ?? "";
              if (!text) break;
              if (!speaking) {
                speaking = true;
                callInput.onSpeechStart();
              }
              if (sentence?.sentence_end) {
                speaking = false;
                dispatch = dispatch.then(
                  () => callInput.onFinalTranscript(text),
                ).catch(() => {
                  fail();
                  socket.close(
                    1_011,
                    "inbound_persistence_failed",
                  );
                });
              } else {
                callInput.onPartialTranscript(text);
              }
              break;
            }
            case "task-finished":
              completed = true;
              finished.resolve();
              socket.close(1_000, "finished");
              break;
            case "task-failed":
              fail();
              socket.close(1_011, "provider_failed");
              break;
          }
        },
      );
      socket.on("error", fail);
      socket.on("close", () => {
        if (!stopped && !completed) fail();
        finished.resolve();
      });
      await withTimeout(
        ready.promise,
        10_000,
        "sip_stt_start_timeout",
      );
      return {
        async pushPcm(pcm16) {
          if (
            stopped
            || providerFailed
          ) {
            throw new Error("sip_stt_session_closed");
          }
          if (socket.readyState !== WebSocket.OPEN) {
            fail();
            throw new Error("sip_stt_session_closed");
          }
          if (
            pcm16.byteLength === 0
            || pcm16.byteLength > 256 * 1024
            || pcm16.byteLength % 2 !== 0
          ) {
            throw new Error("sip_stt_pcm_invalid");
          }
          await new Promise<void>((resolve, reject) => {
            socket.send(pcm16, (error) => {
              if (error) {
                fail();
                socket.close(1_011, "provider_failed");
                reject(
                  new Error("sip_stt_provider_unavailable"),
                );
              } else resolve();
            });
          });
        },
        async stop() {
          if (stopped) return;
          stopped = true;
          if (
            started
            && socket.readyState === WebSocket.OPEN
          ) {
            socket.send(JSON.stringify({
              header: {
                action: "finish-task",
                task_id: taskId,
                streaming: "duplex",
              },
              payload: { input: {} },
            }));
            await withTimeout(
              finished.promise.catch(() => undefined),
              5_000,
              "sip_stt_finish_timeout",
            ).catch(() => undefined);
          }
          socket.close(1_000, "stopped");
          await dispatch;
        },
      };
    },
  };
}

function parseDashScopeEvent(data: RawData): DashScopeEvent {
  try {
    const value = JSON.parse(data.toString()) as unknown;
    if (!value || typeof value !== "object") return {};
    return value as DashScopeEvent;
  } catch {
    return {};
  }
}

function languageHints(language: string): string[] {
  const normalized = language.toLowerCase();
  if (normalized.startsWith("zh")) return ["zh"];
  if (normalized.startsWith("en")) return ["en"];
  return [];
}

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  errorCode: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(errorCode)),
          milliseconds,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
