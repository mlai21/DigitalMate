import { randomUUID } from "node:crypto";

import WebSocket, { type RawData } from "ws";

export interface SipSpeechSynthesizer {
  synthesize(input: Readonly<{
    text: string;
    voice: string;
    sampleRate: 8_000 | 24_000;
    signal: AbortSignal;
  }>): AsyncIterable<Buffer>;
}

export function createDashScopeSpeechSynthesizer(
  input: Readonly<{
    apiKey: string;
    endpoint?: string;
    model?: string;
    createSocket?: (
      url: string,
      options: WebSocket.ClientOptions,
    ) => WebSocket;
  }>,
): SipSpeechSynthesizer {
  const endpoint =
    input.endpoint
    ?? "wss://dashscope.aliyuncs.com/api-ws/v1/inference/";
  const model = input.model ?? "cosyvoice-v2";
  const createSocket =
    input.createSocket
    ?? ((url, options) => new WebSocket(url, options));
  if (!input.apiKey) {
    throw new Error("sip_dashscope_api_key_required");
  }
  return {
    async *synthesize(request) {
      if (!request.text.trim()) return;
      if (request.signal.aborted) return;
      const taskId = randomUUID();
      const queue = new AsyncBufferQueue();
      const socket = createSocket(endpoint, {
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
        },
        handshakeTimeout: 10_000,
        perMessageDeflate: false,
        maxPayload: 1024 * 1024,
      });
      let taskStarted = false;
      let completed = false;
      const abort = () => {
        queue.end();
        socket.close(1_000, "interrupted");
      };
      request.signal.addEventListener("abort", abort, {
        once: true,
      });
      socket.on("open", () => {
        socket.send(JSON.stringify({
          header: {
            action: "run-task",
            task_id: taskId,
            streaming: "duplex",
          },
          payload: {
            task_group: "audio",
            task: "tts",
            function: "SpeechSynthesizer",
            model,
            parameters: {
              text_type: "PlainText",
              voice: request.voice,
              format: "pcm",
              sample_rate: request.sampleRate,
              volume: 50,
              rate: 1,
              pitch: 1,
            },
            input: {},
          },
        }));
      });
      socket.on(
        "message",
        (data: RawData, isBinary: boolean) => {
          if (request.signal.aborted) return;
          if (isBinary) {
            const chunk = Buffer.from(data as Buffer);
            if (chunk.byteLength > 0) queue.push(chunk);
            return;
          }
          const event = parseEvent(data);
          if (
            event.taskId
            && event.taskId !== taskId
          ) {
            return;
          }
          if (event.name === "task-started") {
            if (taskStarted) return;
            taskStarted = true;
            socket.send(JSON.stringify({
              header: {
                action: "continue-task",
                task_id: taskId,
                streaming: "duplex",
              },
              payload: {
                input: {
                  text: request.text,
                },
              },
            }));
            socket.send(JSON.stringify({
              header: {
                action: "finish-task",
                task_id: taskId,
                streaming: "duplex",
              },
              payload: { input: {} },
            }));
          } else if (event.name === "task-finished") {
            completed = true;
            queue.end();
            socket.close(1_000, "finished");
          } else if (event.name === "task-failed") {
            queue.fail(
              new Error("sip_tts_provider_unavailable"),
            );
            socket.close(1_011, "provider_failed");
          }
        },
      );
      socket.on("error", () => {
        queue.fail(
          new Error("sip_tts_provider_unavailable"),
        );
      });
      socket.on("close", () => {
        if (
          completed
          || request.signal.aborted
        ) {
          queue.end();
        } else {
          queue.fail(
            new Error("sip_tts_provider_unavailable"),
          );
        }
      });
      try {
        for await (const chunk of queue) {
          yield chunk;
        }
      } finally {
        request.signal.removeEventListener("abort", abort);
        if (
          socket.readyState === WebSocket.OPEN
          || socket.readyState === WebSocket.CONNECTING
        ) {
          socket.close(1_000, "consumer_closed");
        }
      }
    },
  };
}

class AsyncBufferQueue implements AsyncIterable<Buffer> {
  readonly #values: Buffer[] = [];
  readonly #waiters: Array<Readonly<{
    resolve(value: IteratorResult<Buffer>): void;
    reject(error: Error): void;
  }>> = [];
  #ended = false;
  #error: Error | null = null;

  push(value: Buffer): void {
    if (this.#ended || this.#error) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else this.#values.push(value);
  }

  end(): void {
    if (this.#ended || this.#error) return;
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  fail(error: Error): void {
    if (this.#ended || this.#error) return;
    this.#error = error;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Buffer> {
    return {
      next: async () => {
        if (this.#error) throw this.#error;
        const value = this.#values.shift();
        if (value) return { done: false, value };
        if (this.#ended) {
          return { done: true, value: undefined };
        }
        return new Promise<IteratorResult<Buffer>>(
          (resolve, reject) => {
            this.#waiters.push({ resolve, reject });
          },
        );
      },
    };
  }
}

function parseEvent(data: RawData): Readonly<{
  name: string;
  taskId: string;
}> {
  try {
    const value = JSON.parse(data.toString()) as {
      header?: {
        event?: unknown;
        task_id?: unknown;
      };
    };
    return {
      name: typeof value.header?.event === "string"
        ? value.header.event
        : "",
      taskId: typeof value.header?.task_id === "string"
        ? value.header.task_id
        : "",
    };
  } catch {
    return { name: "", taskId: "" };
  }
}
