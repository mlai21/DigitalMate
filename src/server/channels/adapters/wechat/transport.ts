import {
  createWechatIlinkClient,
  mapWechatError,
  WechatTransportError,
  type WechatIlinkClientFactory,
  type WechatIlinkClientPort,
  type WechatInboundMessage,
} from "./client";

export type WechatTransportState = Readonly<{
  status: "connected" | "disconnected";
  reconnectAttempts: number;
  nextAttemptAt?: Date;
  retryExhausted?: boolean;
}>;

export type WechatTransportStartInput = Readonly<{
  signal: AbortSignal;
  onInbound(
    payload: WechatInboundMessage,
  ): Promise<void>;
  onState(state: WechatTransportState): void;
  onError(error: WechatTransportError): void;
}>;

export type WechatTransportPort = Readonly<{
  start(input: WechatTransportStartInput): Promise<void>;
  stop(): Promise<void>;
  sendText: WechatIlinkClientPort["sendText"];
  getConfig: WechatIlinkClientPort["getConfig"];
  sendTyping: WechatIlinkClientPort["sendTyping"];
}>;

export function createWechatLongPollTransport(
  config: Readonly<{
    botToken: string;
    baseUrl: string;
  }>,
  dependencies: Readonly<{
    clientFactory?: WechatIlinkClientFactory;
    now?: () => Date;
    delay?: (
      milliseconds: number,
      signal?: AbortSignal,
    ) => Promise<void>;
    poll?: boolean;
  }> = {},
): WechatTransportPort {
  const client = (dependencies.clientFactory
    ?? createWechatIlinkClient)(config);
  const now = dependencies.now ?? (() => new Date());
  const delay = dependencies.delay ?? abortableDelay;
  let input: WechatTransportStartInput | null = null;
  let loopController: AbortController | null = null;
  let loopPromise: Promise<void> | null = null;
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let lifecycleGeneration = 0;
  let cursor = "";
  let reconnectAttempts = 0;

  return {
    start: beginStart,

    stop,

    sendText: (sendInput) =>
      client.sendText(sendInput),
    getConfig: (getConfigInput) =>
      client.getConfig(getConfigInput),
    sendTyping: (typingInput) =>
      client.sendTyping(typingInput),
  };

  function beginStart(
    startInput: WechatTransportStartInput,
  ): Promise<void> {
    if (stopPromise) {
      return stopPromise.then(() =>
        beginStart(startInput));
    }
    if (loopPromise) return Promise.resolve();
    if (startPromise) return startPromise;
    const generation = lifecycleGeneration + 1;
    lifecycleGeneration = generation;
    startPromise = start(
      startInput,
      generation,
    ).finally(() => {
      startPromise = null;
    });
    return startPromise;
  }

  async function start(
    startInput: WechatTransportStartInput,
    generation: number,
  ): Promise<void> {
    startInput.signal.throwIfAborted();
    input = startInput;
    await client.start();
    if (generation !== lifecycleGeneration) {
      throw new WechatTransportError({
        code: "network_unreachable",
        retryable: true,
        detail: "wechat_transport_start_cancelled",
      });
    }
    if (dependencies.poll === false) {
      startInput.onState({
        status: "connected",
        reconnectAttempts: 0,
      });
      return;
    }
    const controller = new AbortController();
    loopController = controller;
    const onAbort = () =>
      controller.abort(startInput.signal.reason);
    startInput.signal.addEventListener(
      "abort",
      onAbort,
      { once: true },
    );
    loopPromise = pollLoop(controller.signal)
      .finally(() => {
        startInput.signal.removeEventListener(
          "abort",
          onAbort,
        );
        if (loopController === controller) {
          loopController = null;
        }
        loopPromise = null;
      });
    startInput.onState({
      status: "connected",
      reconnectAttempts: 0,
    });
  }

  async function pollLoop(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        const response = await client.getUpdates(
          cursor,
          signal,
        );
        if (response.ret === -2) {
          input?.onError(new WechatTransportError({
            code: "credential_invalid",
            retryable: false,
            detail: "wechat_bot_token_invalid",
          }));
          input?.onState({
            status: "disconnected",
            reconnectAttempts,
            retryExhausted: true,
          });
          return;
        }
        for (const message of response.msgs) {
          signal.throwIfAborted();
          await input?.onInbound(message);
        }
        cursor = response.get_updates_buf;
        if (
          response.ret !== 0
          && response.ret !== -1
          && response.msgs.length === 0
        ) {
          await delay(3_000, signal);
        }
        if (reconnectAttempts > 0) {
          input?.onState({
            status: "connected",
            reconnectAttempts: 0,
          });
        }
        reconnectAttempts = 0;
      } catch (error) {
        if (signal.aborted) return;
        reconnectAttempts += 1;
        const mapped = mapWechatError(error);
        input?.onError(mapped);
        if (!mapped.retryable) {
          input?.onState({
            status: "disconnected",
            reconnectAttempts,
            retryExhausted: true,
          });
          return;
        }
        const wait = Math.min(
          5_000 * (2 ** (reconnectAttempts - 1)),
          120_000,
        );
        const nextAttemptAt = new Date(
          now().getTime() + wait,
        );
        input?.onState({
          status: "disconnected",
          reconnectAttempts,
          nextAttemptAt,
        });
        await delay(wait, signal).catch(() => undefined);
      }
    }
  }

  async function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    lifecycleGeneration += 1;
    stopPromise = (async () => {
      loopController?.abort(new Error("shutdown"));
      await startPromise?.catch(() => undefined);
      await loopPromise?.catch(() => undefined);
      await client.stop();
      input = null;
      cursor = "";
      reconnectAttempts = 0;
    })().finally(() => {
      stopPromise = null;
    });
    return stopPromise;
  }
}

function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const timer = setTimeout(finish, milliseconds);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, {
      once: true,
    });
    function finish() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
  });
}
