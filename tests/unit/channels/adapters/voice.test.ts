import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import {
  createVoiceAdapter,
} from "@/server/channels/adapters/voice";
import {
  parseVoiceConfig,
} from "@/server/channels/adapters/voice/config";
import {
  createVoiceGatewayHub,
  type VoiceTransportPort,
} from "@/server/channels/adapters/voice/relay";
import {
  verifyTwilioSignature,
} from "@/server/channels/adapters/voice/signature";
import {
  buildBusyTwiml,
  buildConversationRelayTwiml,
} from "@/server/channels/adapters/voice/twiml";
import {
  ChannelAdapterRegistry,
  registerVoiceChannelAdapter,
} from "@/server/channels/runtime/registry";
import {
  assertStableExternalEventId,
  defineChannelContract,
} from "@/server/channels/testing/contract";

const NOW = new Date("2026-07-27T03:00:00.000Z");
const CONNECTION_ID =
  "20000000-0000-4000-8000-000000000011";
const TOKEN = "t".repeat(43);
const AUTH_TOKEN = "twilio-auth-token";
const CALL_SID = `CA${"a".repeat(32)}`;
const CONFIG = {
  enabled: true,
  twilio_account_sid: `AC${"b".repeat(32)}`,
  twilio_auth_token: AUTH_TOKEN,
  phone_number: "+8613800138000",
  phone_number_sid: `PN${"c".repeat(32)}`,
  tts_provider: "google",
  tts_voice: "Google.zh-CN-Standard-A",
  stt_provider: "deepgram",
  language: "zh-CN",
  welcome_greeting: "你好，<DigitalMate> & 朋友",
  max_concurrent_calls: 2,
} as const;

defineChannelContract({
  type: "voice",

  assertConfig() {
    const config = parseVoiceConfig(CONFIG);
    expect(config).toMatchObject({
      twilio_account_sid: CONFIG.twilio_account_sid,
      tts_provider: "google",
      stt_provider: "deepgram",
      max_concurrent_calls: 2,
    });
    expect(() =>
      parseVoiceConfig({
        ...CONFIG,
        twilio_account_sid: "invalid",
      })
    ).toThrow("voice_twilio_account_sid_invalid");
    expect(() =>
      parseVoiceConfig({
        ...CONFIG,
        max_concurrent_calls: 0,
      })
    ).toThrow("voice_max_concurrent_calls_invalid");
    expect(() =>
      parseVoiceConfig({
        ...CONFIG,
        welcome_greeting: "你好\u0000",
      })
    ).toThrow("voice_welcome_greeting_invalid");
  },

  async assertLifecycle() {
    const transport = new FakeVoiceTransport();
    const adapter = createVoiceAdapter({
      transport,
      autoListen: false,
      publicBaseUrl: "https://mate.example",
      now: () => NOW,
    });
    const context = runtimeContext(adapter);

    await Promise.all([adapter.start(context), adapter.start(context)]);
    expect(transport.starts).toBe(1);
    expect(await adapter.health()).toMatchObject({
      status: "healthy",
    });
    await adapter.stop("reconfigure");
    await adapter.stop("reconfigure");
    expect(transport.stops).toBe(1);
  },

  async assertInbound() {
    const adapter = createVoiceAdapter({
      transport: new FakeVoiceTransport(),
      autoListen: false,
      publicBaseUrl: "https://mate.example",
      now: () => NOW,
    });
    adapter.validateConfig(CONFIG);
    const event = await adapter.normalizeInbound(
      {
        kind: "prompt",
        callSid: CALL_SID,
        from: "+8613900139000",
        to: CONFIG.phone_number,
        sequence: 3,
        prompt: await fixture("prompt-final.json"),
      },
      {
        connectionId: CONNECTION_ID,
        agentId: "agent-1",
        receivedAt: NOW,
      },
    );

    expect(event).toMatchObject({
      channelType: "voice",
      externalEventId: `${CALL_SID}:prompt:3`,
      externalConversationId: CALL_SID,
      externalSenderId: "+8613900139000",
      chatType: "direct",
      mentioned: true,
      text: "你好，今天怎么样？",
      attachments: [],
      permission: {
        webSearch: false,
        backgroundNetwork: false,
        tools: false,
        skills: "none",
        attachmentsPresent: false,
      },
    });
    expect(JSON.stringify(event)).not.toMatch(
      /audio|pcm|base64|voicePrompt/i,
    );
  },

  async assertStableIds() {
    const adapter = createVoiceAdapter({
      transport: new FakeVoiceTransport(),
      autoListen: false,
      publicBaseUrl: "https://mate.example",
      now: () => NOW,
    });
    adapter.validateConfig(CONFIG);
    await expect(
      assertStableExternalEventId(() =>
        adapter.normalizeInbound(
          {
            kind: "prompt",
            callSid: CALL_SID,
            from: "+8613900139000",
            to: CONFIG.phone_number,
            sequence: 1,
            prompt: {
              type: "prompt",
              voicePrompt: "你好",
              last: true,
            },
          },
          {
            connectionId: CONNECTION_ID,
            agentId: "agent-1",
            receivedAt: NOW,
          },
        )
      ),
    ).resolves.toBe(`${CALL_SID}:prompt:1`);
  },

  async assertOutbound() {
    const transport = new FakeVoiceTransport();
    const adapter = createVoiceAdapter({
      transport,
      autoListen: false,
      publicBaseUrl: "https://mate.example",
      now: () => NOW,
    });
    await adapter.start(runtimeContext(adapter));
    const result = await adapter.send(
      outboundDelivery(),
      sendContext(adapter),
    );

    expect(transport.sent).toEqual([{
      callSid: CALL_SID,
      text: "完整回复",
      deliveryId: "delivery-voice-1",
    }]);
    expect(result.externalMessageId).toBe(
      "voice:delivery-voice-1",
    );
    expect(
      await adapter.resolveRecipient(
        outboundDelivery().recipient,
      ),
    ).toEqual({ address: { callSid: CALL_SID } });
    await adapter.stop("shutdown");
  },

  async assertHealth() {
    const transport = new FakeVoiceTransport();
    transport.startError = new Error(
      "voice_webhook_configuration_failed",
    );
    const adapter = createVoiceAdapter({
      transport,
      autoListen: false,
      publicBaseUrl: "https://mate.example",
      now: () => NOW,
    });
    await expect(
      adapter.start(runtimeContext(adapter)),
    ).rejects.toThrow("voice_webhook_configuration_failed");
    expect(await adapter.health()).toMatchObject({
      status: "degraded",
      error: {
        code: "network_unreachable",
      },
    });
  },

  async assertShutdown() {
    const transport = new FakeVoiceTransport();
    const adapter = createVoiceAdapter({
      transport,
      autoListen: false,
      publicBaseUrl: "https://mate.example",
    });
    const controller = new AbortController();
    await adapter.start(runtimeContext(adapter, controller.signal));
    controller.abort();
    await vi.waitFor(() => expect(transport.stops).toBe(1));
  },
});

describe("Twilio Voice gateway", () => {
  it("validates signed form requests and rejects tampering", () => {
    const url =
      `https://mate.example/channel-gateway/voice/${CONNECTION_ID}/incoming`;
    const params = {
      CallSid: CALL_SID,
      From: "+8613900139000",
      To: CONFIG.phone_number,
    };
    const signature = sign(url, params);

    expect(
      verifyTwilioSignature({
        url,
        params,
        signature,
      }, AUTH_TOKEN),
    ).toBe(true);
    expect(
      verifyTwilioSignature({
        url,
        params: { ...params, From: "+10000000000" },
        signature,
      }, AUTH_TOKEN),
    ).toBe(false);
  });

  it("builds escaped ConversationRelay and busy TwiML", () => {
    const config = parseVoiceConfig(CONFIG);
    const xml = buildConversationRelayTwiml(
      config,
      "wss://mate.example/channel-gateway/voice/id/relay?token=a&amp;b",
    );

    expect(xml).toContain("<ConversationRelay");
    expect(xml).toContain('ttsProvider="Google"');
    expect(xml).toContain('transcriptionProvider="Deepgram"');
    expect(xml).toContain(
      'welcomeGreeting="你好，&lt;DigitalMate&gt; &amp; 朋友"',
    );
    expect(xml).toContain("token=a&amp;amp;b");
    expect(xml).not.toContain("<DigitalMate>");
    expect(buildBusyTwiml("稍后再试 & 谢谢")).toContain(
      "<Say>稍后再试 &amp; 谢谢</Say>",
    );
  });

  it("uses a single-use relay token, accepts only final prompts, and never forwards audio", async () => {
    const configureWebhook = vi.fn(async () => undefined);
    const onPrompt = vi.fn(async () => undefined);
    const hub = createVoiceGatewayHub({
      now: () => NOW,
      generateToken: () => TOKEN,
    });
    const transport = hub.createTransport({ configureWebhook });
    const controller = new AbortController();
    await transport.start({
      connectionId: CONNECTION_ID,
      config: parseVoiceConfig(CONFIG),
      publicBaseUrl: "https://mate.example",
      signal: controller.signal,
      onPrompt,
    });

    expect(configureWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        accountSid: CONFIG.twilio_account_sid,
        authToken: CONFIG.twilio_auth_token,
        phoneNumberSid: CONFIG.phone_number_sid,
        voiceUrl:
          `https://mate.example/channel-gateway/voice/${CONNECTION_ID}/incoming`,
        statusCallback:
          `https://mate.example/channel-gateway/voice/${CONNECTION_ID}/status`,
      }),
    );

    const incomingUrl =
      `https://mate.example/channel-gateway/voice/${CONNECTION_ID}/incoming`;
    const incomingParams = {
      CallSid: CALL_SID,
      From: "+8613900139000",
      To: CONFIG.phone_number,
    };
    const incoming = formRequest(
      incomingUrl,
      incomingParams,
      sign(incomingUrl, incomingParams),
    );
    const response = await hub.handleIncoming(
      incoming,
      { connectionId: CONNECTION_ID },
    );
    const xml = await response.text();
    const replayResponse = await hub.handleIncoming(
      formRequest(
        incomingUrl,
        incomingParams,
        sign(incomingUrl, incomingParams),
      ),
      { connectionId: CONNECTION_ID },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(
      "text/xml",
    );
    expect(xml).toContain(`token=${TOKEN}`);
    expect(await replayResponse.text()).toBe(xml);
    expect(hub.inspect(CONNECTION_ID)).toMatchObject({
      pendingCalls: 1,
      activeCalls: 0,
    });
    expect(JSON.stringify(hub.inspect(CONNECTION_ID))).not.toContain(
      TOKEN,
    );

    const upgradeUrl =
      `/channel-gateway/voice/${CONNECTION_ID}/relay?token=${TOKEN}`;
    const signedUpgradeUrl =
      `wss://mate.example${upgradeUrl}`;
    const upgrade = upgradeRequest(
      upgradeUrl,
      sign(signedUpgradeUrl, {}),
    );
    const route = {
      type: "voice-relay" as const,
      connectionId: CONNECTION_ID,
    };
    expect(hub.authorize(route, upgrade)).toBe(true);
    expect(hub.authorize(route, upgradeRequest(
      upgradeUrl,
      sign(signedUpgradeUrl, {}),
    ))).toBe(401);

    const socket = new FakeWebSocket();
    await hub.accept(route, socket.asWebSocket(), upgrade);
    socket.receive({
      type: "setup",
      callSid: CALL_SID,
      from: "+8613900139000",
      to: CONFIG.phone_number,
    });
    socket.receive({
      type: "prompt",
      voicePrompt: "尚未结束",
      last: false,
      audio: "must-not-forward",
    });
    socket.receive({
      type: "prompt",
      voicePrompt: "最终问题",
      lang: "zh-CN",
      last: true,
      audio: "must-not-forward",
    });
    await vi.waitFor(() => expect(onPrompt).toHaveBeenCalledOnce());
    expect(onPrompt).toHaveBeenCalledWith({
      kind: "prompt",
      callSid: CALL_SID,
      from: "+8613900139000",
      to: CONFIG.phone_number,
      sequence: 1,
      prompt: {
        type: "prompt",
        voicePrompt: "最终问题",
        lang: "zh-CN",
        last: true,
      },
    });
    expect(JSON.stringify(onPrompt.mock.calls)).not.toContain(
      "must-not-forward",
    );
    expect(hub.inspect(CONNECTION_ID)).toMatchObject({
      pendingCalls: 0,
      activeCalls: 1,
    });

    const statusUrl =
      `https://mate.example/channel-gateway/voice/${CONNECTION_ID}/status`;
    const statusParams = {
      CallSid: CALL_SID,
      CallStatus: "completed",
    };
    const statusResponse = await hub.handleStatus(
      formRequest(
        statusUrl,
        statusParams,
        sign(statusUrl, statusParams),
      ),
      { connectionId: CONNECTION_ID },
    );
    expect(statusResponse.status).toBe(204);
    expect(socket.closed).toBe(true);
    expect(hub.inspect(CONNECTION_ID)).toMatchObject({
      activeCalls: 0,
    });

    await transport.stop();
  });

  it("validates the exact HTTP query as part of the Twilio signature", async () => {
    const hub = createVoiceGatewayHub({
      now: () => NOW,
      generateToken: () => TOKEN,
    });
    const transport = hub.createTransport({
      configureWebhook: async () => undefined,
    });
    await transport.start({
      connectionId: CONNECTION_ID,
      config: parseVoiceConfig(CONFIG),
      publicBaseUrl: "https://mate.example",
      signal: new AbortController().signal,
      onPrompt: async () => undefined,
    });
    const url =
      `https://mate.example/channel-gateway/voice/${CONNECTION_ID}/incoming?edge=1`;
    const unsignedUrl =
      `https://mate.example/channel-gateway/voice/${CONNECTION_ID}/incoming`;
    const params = {
      CallSid: CALL_SID,
      From: "+8613900139000",
      To: CONFIG.phone_number,
    };

    const wrong = await hub.handleIncoming(
      formRequest(url, params, sign(unsignedUrl, params)),
      { connectionId: CONNECTION_ID },
    );
    expect(wrong.status).toBe(403);
    const valid = await hub.handleIncoming(
      formRequest(url, params, sign(url, params)),
      { connectionId: CONNECTION_ID },
    );
    expect(valid.status).toBe(200);
    await transport.stop();
  });

  it("rejects an authorized relay after expiry or channel stop", async () => {
    let current = NOW;
    const hub = createVoiceGatewayHub({
      now: () => current,
      generateToken: () => TOKEN,
    });
    const transport = hub.createTransport({
      configureWebhook: async () => undefined,
    });
    await transport.start({
      connectionId: CONNECTION_ID,
      config: parseVoiceConfig(CONFIG),
      publicBaseUrl: "https://mate.example",
      signal: new AbortController().signal,
      onPrompt: async () => undefined,
    });
    const expired = await authorizeCall(hub, CALL_SID);
    current = new Date(NOW.getTime() + 2 * 60 * 1_000 + 1);
    const expiredSocket = new FakeWebSocket();
    await hub.accept(
      expired.route,
      expiredSocket.asWebSocket(),
      expired.request,
    );
    expect(expiredSocket.closed).toBe(true);

    current = NOW;
    const secondCall = `CA${"e".repeat(32)}`;
    const stopped = await authorizeCall(hub, secondCall);
    await transport.stop();
    const stoppedSocket = new FakeWebSocket();
    await hub.accept(
      stopped.route,
      stoppedSocket.asWebSocket(),
      stopped.request,
    );
    expect(stoppedSocket.closed).toBe(true);
  });

  it("rotates relay tokens after reconfiguration and replay tombstone expiry", async () => {
    let current = NOW;
    const hub = createVoiceGatewayHub({
      now: () => current,
    });
    const firstTransport = hub.createTransport({
      configureWebhook: async () => undefined,
    });
    const startInput = {
      connectionId: CONNECTION_ID,
      config: parseVoiceConfig(CONFIG),
      publicBaseUrl: "https://mate.example",
      signal: new AbortController().signal,
      onPrompt: async () => undefined,
    };
    await firstTransport.start(startInput);
    const firstToken = await tokenFromIncoming(
      hub,
      CALL_SID,
    );
    await firstTransport.stop();

    const secondTransport = hub.createTransport({
      configureWebhook: async () => undefined,
    });
    await secondTransport.start(startInput);
    const secondToken = await tokenFromIncoming(
      hub,
      CALL_SID,
    );
    expect(secondToken).not.toBe(firstToken);
    expect(
      authorizeToken(hub, firstToken),
    ).toBe(401);

    current = new Date(
      NOW.getTime() + 2 * 60 * 1_000 + 1,
    );
    expect(hub.inspect(CONNECTION_ID)).toMatchObject({
      pendingCalls: 0,
    });
    current = new Date(
      current.getTime() + 24 * 60 * 60 * 1_000 + 1,
    );
    const thirdToken = await tokenFromIncoming(
      hub,
      CALL_SID,
    );
    expect(thirdToken).not.toBe(secondToken);
    expect(authorizeToken(hub, secondToken)).toBe(401);
    expect(authorizeToken(hub, thirdToken)).toBe(true);
    await secondTransport.stop();
  });

  it("terminal status revokes authorized and pre-setup calls", async () => {
    const hub = createVoiceGatewayHub({
      now: () => NOW,
      generateToken: () => TOKEN,
    });
    const transport = hub.createTransport({
      configureWebhook: async () => undefined,
    });
    await transport.start({
      connectionId: CONNECTION_ID,
      config: parseVoiceConfig(CONFIG),
      publicBaseUrl: "https://mate.example",
      signal: new AbortController().signal,
      onPrompt: async () => undefined,
    });

    const authorized = await authorizeCall(hub, CALL_SID);
    expect(
      (
        await completeCall(hub, CALL_SID)
      ).status,
    ).toBe(204);
    const authorizedSocket = new FakeWebSocket();
    await hub.accept(
      authorized.route,
      authorizedSocket.asWebSocket(),
      authorized.request,
    );
    expect(authorizedSocket.closed).toBe(true);

    const preSetupCall = `CA${"f".repeat(32)}`;
    const preSetup = await authorizeCall(hub, preSetupCall);
    const preSetupSocket = new FakeWebSocket();
    await hub.accept(
      preSetup.route,
      preSetupSocket.asWebSocket(),
      preSetup.request,
    );
    expect(hub.inspect(CONNECTION_ID)).toMatchObject({
      preSetupCalls: 1,
    });
    await completeCall(hub, preSetupCall);
    expect(preSetupSocket.closed).toBe(true);
    expect(hub.inspect(CONNECTION_ID)).toMatchObject({
      activeCalls: 0,
      authorizedCalls: 0,
      preSetupCalls: 0,
    });
    preSetupSocket.receive({
      type: "setup",
      callSid: preSetupCall,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hub.inspect(CONNECTION_ID)?.activeCalls).toBe(0);
    await transport.stop();
  });

  it("drops queued final prompts after the call becomes terminal", async () => {
    let releaseFirstPrompt!: () => void;
    const firstPromptBlocked = new Promise<void>((resolve) => {
      releaseFirstPrompt = resolve;
    });
    const onPrompt = vi.fn()
      .mockImplementationOnce(() => firstPromptBlocked)
      .mockResolvedValue(undefined);
    const hub = createVoiceGatewayHub({
      now: () => NOW,
      generateToken: () => TOKEN,
    });
    const transport = hub.createTransport({
      configureWebhook: async () => undefined,
    });
    await transport.start({
      connectionId: CONNECTION_ID,
      config: parseVoiceConfig(CONFIG),
      publicBaseUrl: "https://mate.example",
      signal: new AbortController().signal,
      onPrompt,
    });
    const call = await authorizeCall(hub, CALL_SID);
    const socket = new FakeWebSocket();
    await hub.accept(call.route, socket.asWebSocket(), call.request);
    socket.receive({
      type: "setup",
      callSid: CALL_SID,
    });
    socket.receive({
      type: "prompt",
      voicePrompt: "第一条",
      last: true,
    });
    socket.receive({
      type: "prompt",
      voicePrompt: "终态后不得处理",
      last: true,
    });
    await vi.waitFor(() => expect(onPrompt).toHaveBeenCalledOnce());
    await completeCall(hub, CALL_SID);
    releaseFirstPrompt();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onPrompt).toHaveBeenCalledOnce();
    await transport.stop();
  });

  it("enforces concurrency and interrupts only the current TTS cycle", async () => {
    const hub = createVoiceGatewayHub({
      now: () => NOW,
      generateToken: () => TOKEN,
      textChunkCodePoints: 4,
    });
    const transport = hub.createTransport({
      configureWebhook: async () => undefined,
    });
    await transport.start({
      connectionId: CONNECTION_ID,
      config: parseVoiceConfig({
        ...CONFIG,
        max_concurrent_calls: 1,
      }),
      publicBaseUrl: "https://mate.example",
      signal: new AbortController().signal,
      onPrompt: async () => undefined,
    });
    const first = await authorizeCall(hub, CALL_SID);
    const secondCallSid = `CA${"d".repeat(32)}`;
    const busyBeforeUpgrade = await incomingCall(
      hub,
      secondCallSid,
    );
    expect(await busyBeforeUpgrade.text()).toContain("<Say>");
    expect(hub.inspect(CONNECTION_ID)).toMatchObject({
      pendingCalls: 0,
      authorizedCalls: 1,
      activeCalls: 0,
    });
    const socket = new FakeWebSocket({ holdSendCallbacks: true });
    await hub.accept(
      first.route,
      socket.asWebSocket(),
      first.request,
    );
    socket.receive({
      type: "setup",
      callSid: CALL_SID,
      from: "+8613900139000",
      to: CONFIG.phone_number,
    });
    await vi.waitFor(() =>
      expect(hub.inspect(CONNECTION_ID)?.activeCalls).toBe(1)
    );

    const busyResponse = await incomingCall(
      hub,
      secondCallSid,
    );
    expect(await busyResponse.text()).toContain("<Say>");

    const sent = transport.send({
      callSid: CALL_SID,
      text: "第一段第二段第三段",
      deliveryId: "delivery-voice-interrupt",
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.receive({
      type: "interrupt",
      utteranceUntilInterrupt: "第一段",
      durationUntilInterruptMs: 100,
    });
    socket.releaseSendCallbacks();
    await expect(sent).resolves.toMatchObject({
      externalMessageId: "voice:delivery-voice-interrupt",
      rawSummary: {
        interrupted: true,
      },
    });
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toEqual({
      type: "text",
      token: "第一段第",
      last: false,
    });
  });

  it("registers the Voice Adapter explicitly", () => {
    const registry = new ChannelAdapterRegistry();
    registerVoiceChannelAdapter(registry);
    expect(registry.registeredTypes()).toEqual(["voice"]);
  });
});

class FakeVoiceTransport implements VoiceTransportPort {
  starts = 0;
  stops = 0;
  startError: Error | null = null;
  sent: Array<{
    callSid: string;
    text: string;
    deliveryId: string;
  }> = [];

  async start(): Promise<void> {
    this.starts += 1;
    if (this.startError) throw this.startError;
  }

  async stop(): Promise<void> {
    this.stops += 1;
  }

  async send(input: {
    callSid: string;
    text: string;
    deliveryId: string;
  }) {
    this.sent.push({
      callSid: input.callSid,
      text: input.text,
      deliveryId: input.deliveryId,
    });
    return {
      externalMessageId: `voice:${input.deliveryId}`,
      sentAt: NOW,
      rawSummary: {
        interrupted: false,
        chunks: 1,
      },
    } as const;
  }

  state() {
    return {
      activeCalls: 0,
      lastConnectedAt: null,
      lastEventAt: null,
    };
  }
}

class FakeWebSocket extends EventEmitter {
  readonly sent: unknown[] = [];
  readonly #callbacks: Array<() => void> = [];
  readonly #holdSendCallbacks: boolean;
  readyState: number = WebSocket.OPEN;
  closed = false;

  constructor(
    input: { holdSendCallbacks?: boolean } = {},
  ) {
    super();
    this.#holdSendCallbacks = input.holdSendCallbacks ?? false;
  }

  asWebSocket(): WebSocket {
    return this as unknown as WebSocket;
  }

  receive(value: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(value)), false);
  }

  send(
    value: string,
    callback?: (error?: Error) => void,
  ): void {
    this.sent.push(JSON.parse(value));
    if (!callback) return;
    if (this.#holdSendCallbacks) {
      this.#callbacks.push(() => callback());
    } else {
      callback();
    }
  }

  releaseSendCallbacks(): void {
    for (const callback of this.#callbacks.splice(0)) callback();
  }

  close(): void {
    this.closed = true;
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
}

function runtimeContext(
  adapter: ReturnType<typeof createVoiceAdapter>,
  signal = new AbortController().signal,
) {
  const config = adapter.validateConfig(CONFIG);
  return {
    connectionId: CONNECTION_ID,
    agentId: "agent-1",
    config,
    signal,
    now: () => NOW,
  };
}

function sendContext(
  adapter: ReturnType<typeof createVoiceAdapter>,
) {
  return {
    config: adapter.validateConfig(CONFIG),
    signal: new AbortController().signal,
    now: () => NOW,
  };
}

function outboundDelivery() {
  return {
    id: "delivery-voice-1",
    eventId: "event-voice-1",
    connectionId: CONNECTION_ID,
    assistantMessageId: "message-voice-1",
    body: "完整回复",
    recipient: {
      externalConversationId: CALL_SID,
      externalUserId: "+8613900139000",
      chatType: "direct" as const,
    },
  };
}

function formRequest(
  url: string,
  params: Readonly<Record<string, string>>,
  signature: string,
): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
    },
    body: new URLSearchParams(params),
  });
}

function upgradeRequest(
  pathWithQuery: string,
  signature: string,
) {
  return {
    url: pathWithQuery,
    headers: {
      host: "mate.example",
      "x-forwarded-proto": "https",
      "x-twilio-signature": signature,
    },
  } as never;
}

async function incomingCall(
  hub: ReturnType<typeof createVoiceGatewayHub>,
  callSid: string,
): Promise<Response> {
  const url =
    `https://mate.example/channel-gateway/voice/${CONNECTION_ID}/incoming`;
  const params = {
    CallSid: callSid,
    From: "+8613900139000",
    To: CONFIG.phone_number,
  };
  return hub.handleIncoming(
    formRequest(url, params, sign(url, params)),
    { connectionId: CONNECTION_ID },
  );
}

async function completeCall(
  hub: ReturnType<typeof createVoiceGatewayHub>,
  callSid: string,
): Promise<Response> {
  const url =
    `https://mate.example/channel-gateway/voice/${CONNECTION_ID}/status`;
  const params = {
    CallSid: callSid,
    CallStatus: "completed",
  };
  return hub.handleStatus(
    formRequest(url, params, sign(url, params)),
    { connectionId: CONNECTION_ID },
  );
}

async function authorizeCall(
  hub: ReturnType<typeof createVoiceGatewayHub>,
  callSid: string,
) {
  const response = await incomingCall(hub, callSid);
  const xml = await response.text();
  const token = /[?&]token=([^"&]+)/.exec(xml)?.[1];
  if (!token) throw new Error("voice_test_token_missing");
  const pathWithQuery =
    `/channel-gateway/voice/${CONNECTION_ID}/relay?token=${token}`;
  const signedUrl = `wss://mate.example${pathWithQuery}`;
  const request = upgradeRequest(
    pathWithQuery,
    sign(signedUrl, {}),
  );
  const route = {
    type: "voice-relay" as const,
    connectionId: CONNECTION_ID,
  };
  expect(hub.authorize(route, request)).toBe(true);
  return { request, route };
}

async function tokenFromIncoming(
  hub: ReturnType<typeof createVoiceGatewayHub>,
  callSid: string,
): Promise<string> {
  const response = await incomingCall(hub, callSid);
  const xml = await response.text();
  const token = /[?&]token=([^"&]+)/.exec(xml)?.[1];
  if (!token) throw new Error("voice_test_token_missing");
  return token;
}

function authorizeToken(
  hub: ReturnType<typeof createVoiceGatewayHub>,
  token: string,
): boolean | number {
  const pathWithQuery =
    `/channel-gateway/voice/${CONNECTION_ID}/relay?token=${token}`;
  const request = upgradeRequest(
    pathWithQuery,
    sign(`wss://mate.example${pathWithQuery}`, {}),
  );
  return hub.authorize({
    type: "voice-relay",
    connectionId: CONNECTION_ID,
  }, request);
}

function sign(
  url: string,
  params: Readonly<Record<string, string>>,
): string {
  const data = Object.keys(params)
    .sort()
    .reduce(
      (value, key) => `${value}${key}${params[key]}`,
      url,
    );
  return createHmac("sha1", AUTH_TOKEN)
    .update(data)
    .digest("base64");
}

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(
      path.join(
        process.cwd(),
        "tests/fixtures/channels/voice",
        name,
      ),
      "utf8",
    ),
  );
}
