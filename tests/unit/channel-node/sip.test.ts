import { EventEmitter } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  loadSipRunnerConfigs,
  resolveSipRunnerConfig,
  type SipRunnerConfig,
} from "../../../runners/channel-node/src/sip/config";
import {
  createDevSipBackend,
  createSipBackendHarness,
  type SipBackend,
  type SipDatagramSocket,
} from "../../../runners/channel-node/src/sip/backend";
import {
  buildSipResponse,
  createSipRegistrarRouter,
  parseSipMessage,
  type SipMessage,
} from "../../../runners/channel-node/src/sip/registrar";
import {
  buildRtpPacket,
  decodeMuLaw,
  encodeMuLaw,
  parseRtpPacket,
  RtpPortAllocator,
} from "../../../runners/channel-node/src/sip/rtp";
import {
  SipCallSessionManager,
} from "../../../runners/channel-node/src/sip/session";
import {
  createSipTransport,
} from "../../../runners/channel-node/src/sip/transport";
import {
  createLiveKitSipBackend,
} from "../../../runners/channel-node/src/sip/livekit";
import type {
  SipSpeechRecognizer,
  SipSpeechSession,
} from "../../../runners/channel-node/src/sip/stt";
import {
  createDashScopeSpeechRecognizer,
} from "../../../runners/channel-node/src/sip/stt";
import type {
  SipSpeechSynthesizer,
} from "../../../runners/channel-node/src/sip/tts";
import {
  createDashScopeSpeechSynthesizer,
} from "../../../runners/channel-node/src/sip/tts";
import type WebSocket from "ws";
import audioFixture from "../../fixtures/channels/sip/audio.json";

const CONNECTION_ID =
  "90000000-0000-4000-8000-000000000001";
const DELIVERY_ID =
  "90000000-0000-4000-8000-000000000002";

describe("SIP media channel runner", () => {
  it("validates complete dev and LiveKit private configuration", () => {
    expect(resolveSipRunnerConfig({
      connection_id: CONNECTION_ID,
      sip_mode: "dev",
      sip_host: "127.0.0.1",
      sip_port: 5060,
      sip_username: "",
      sip_password: "",
      sip_server: "",
      sip_transport: "UDP",
      rtp_port_low: 10_000,
      rtp_port_high: 10_009,
      dashscope_api_key: "runner-only-secret",
      stt_provider: "aliyun",
      tts_provider: "aliyun",
      tts_voice: "longxiaochun_v2",
      language: "zh-CN",
      welcome_greeting: "你好",
      call_timeout: 120,
      livekit_url: "",
      livekit_api_key: "",
      livekit_api_secret: "",
      livekit_sip_trunk_id: "",
      livekit_room_name: "sip-inbound",
      livekit_output_sample_rate: 24_000,
      max_concurrent_calls: 5,
    })).toMatchObject({
      connectionId: CONNECTION_ID,
      mode: "dev",
      bindHost: "127.0.0.1",
      sipPort: 5060,
      rtpPortLow: 10_000,
      rtpPortHigh: 10_009,
      callTimeoutMilliseconds: 120_000,
      maxCalls: 5,
    });

    expect(resolveSipRunnerConfig({
      connection_id: CONNECTION_ID,
      sip_mode: "livekit",
      dashscope_api_key: "runner-only-secret",
      livekit_url: "wss://livekit.example.com",
      livekit_api_key: "livekit-key",
      livekit_api_secret: "livekit-secret",
      livekit_sip_trunk_id: "trunk-1",
      livekit_room_name: "sip-inbound",
    })).toMatchObject({
      mode: "livekit",
      liveKit: {
        url: "wss://livekit.example.com",
        apiKey: "livekit-key",
        apiSecret: "livekit-secret",
        sipTrunkId: "trunk-1",
        roomName: "sip-inbound",
        sampleRate: 24_000,
      },
    });

    expect(() => resolveSipRunnerConfig({
      connection_id: CONNECTION_ID,
      sip_mode: "livekit",
      dashscope_api_key: "runner-only-secret",
      livekit_url: "",
      livekit_api_key: "",
      livekit_api_secret: "",
      livekit_sip_trunk_id: "",
    })).toThrow("sip_livekit_config_required");
    expect(() => resolveSipRunnerConfig({
      connection_id: CONNECTION_ID,
      sip_mode: "livekit",
      dashscope_api_key: "runner-only-secret",
      livekit_url: "ws://livekit.example.com",
      livekit_api_key: "livekit-key",
      livekit_api_secret: "livekit-secret",
      livekit_sip_trunk_id: "trunk-1",
    })).toThrow("sip_livekit_config_required");
    expect(() => resolveSipRunnerConfig({
      connection_id: CONNECTION_ID,
      sip_mode: "dev",
      sip_host: "0.0.0.0",
      sip_server: "",
      dashscope_api_key: "runner-only-secret",
    })).toThrow("sip_embedded_registrar_loopback_required");
  });

  it("loads only a 0600 per-connection SIP configuration file", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "digitalmate-sip-config-"),
    );
    const channelDirectory = path.join(
      directory,
      "channels",
      "sip",
    );
    await mkdir(channelDirectory, {
      recursive: true,
      mode: 0o700,
    });
    const configPath = path.join(
      channelDirectory,
      `${CONNECTION_ID}.json`,
    );
    await writeFile(configPath, JSON.stringify({
      connection_id: CONNECTION_ID,
      sip_mode: "dev",
      dashscope_api_key: "runner-only-secret",
    }), { mode: 0o600 });

    await expect(loadSipRunnerConfigs({
      nodeConfigPath: path.join(directory, "node.json"),
      connectionIds: [CONNECTION_ID],
    })).resolves.toEqual([
      expect.objectContaining({
        connectionId: CONNECTION_ID,
        mode: "dev",
      }),
    ]);

    await chmod(configPath, 0o644);
    await expect(loadSipRunnerConfigs({
      nodeConfigPath: path.join(directory, "node.json"),
      connectionIds: [CONNECTION_ID],
    })).rejects.toThrow(
      "sip_config_private_file_mode_invalid",
    );
  });

  it("parses SIP using CRLF and returns required transaction headers", async () => {
    const fixturePath = path.join(
      process.cwd(),
      "tests/fixtures/channels/sip/register.txt",
    );
    const source =
      (await readFile(fixturePath, "utf8"))
        .trimEnd()
        .replaceAll("\n", "\r\n")
      + "\r\n\r\n";
    const message = parseSipMessage(source);
    expect(message).toMatchObject({
      kind: "request",
      method: "REGISTER",
      requestUri: "sip:127.0.0.1",
    });
    expect(message.headers.get("call-id")).toBe("register-call");

    const response = buildSipResponse(message, 200, "OK");
    expect(response).toContain("\r\nVia: ");
    expect(response).toContain("\r\nFrom: ");
    expect(response).toContain("\r\nTo: ");
    expect(response).toContain("\r\nCall-ID: register-call\r\n");
    expect(response).toContain("\r\nCSeq: 1 REGISTER\r\n");
    expect(response.endsWith("\r\n\r\n")).toBe(true);
    expect(() => parseSipMessage(source.replaceAll("\r\n", "\n")))
      .toThrow("sip_crlf_required");
  });

  it("registers and forwards SIP requests and responses without leaking transactions", () => {
    const sent: Array<Readonly<{
      target: readonly [string, number];
      message: string;
    }>> = [];
    const router = createSipRegistrarRouter({
      send(message, target) {
        sent.push({ message, target });
      },
    });
    const register = [
      "REGISTER sip:127.0.0.1 SIP/2.0",
      "Via: SIP/2.0/UDP 127.0.0.1:5080;branch=z9hG4bK-reg",
      "From: <sip:mate@127.0.0.1>;tag=mate",
      "To: <sip:mate@127.0.0.1>",
      "Call-ID: reg-mate",
      "CSeq: 1 REGISTER",
      "Contact: <sip:mate@127.0.0.1:5080>",
      "Content-Length: 0",
      "",
      "",
    ].join("\r\n");
    router.receive(register, ["127.0.0.1", 5080]);
    expect(sent.at(-1)).toMatchObject({
      target: ["127.0.0.1", 5080],
      message: expect.stringContaining("SIP/2.0 200 OK"),
    });

    sent.length = 0;
    const invite = [
      "INVITE sip:mate@127.0.0.1 SIP/2.0",
      "Via: SIP/2.0/UDP 127.0.0.1:5070;branch=z9hG4bK-invite",
      "From: <sip:alice@127.0.0.1>;tag=alice",
      "To: <sip:mate@127.0.0.1>",
      "Call-ID: sip-call-1",
      "CSeq: 2 INVITE",
      "Contact: <sip:alice@127.0.0.1:5070>",
      "Content-Length: 0",
      "",
      "",
    ].join("\r\n");
    router.receive(invite, ["127.0.0.1", 5070]);
    expect(sent).toEqual([{
      target: ["127.0.0.1", 5080],
      message: invite,
    }]);

    sent.length = 0;
    const ok = buildSipResponse(
      parseSipMessage(invite),
      200,
      "OK",
      { Contact: "<sip:mate@127.0.0.1:5080>" },
    );
    router.receive(ok, ["127.0.0.1", 5080]);
    expect(sent).toEqual([{
      target: ["127.0.0.1", 5070],
      message: ok,
    }]);
    router.closeTransaction("sip-call-1");
    expect(router.snapshot()).toEqual({
      registrations: 1,
      transactions: 0,
    });
  });

  it("round-trips RTP headers and matches the G.711 µ-law golden vector", () => {
    const samples = Int16Array.from(audioFixture.pcm16Samples);
    const encoded = encodeMuLaw(samples);
    expect([...encoded]).toEqual(audioFixture.mulawBytes);
    const decoded = decodeMuLaw(encoded);
    expect([...decoded]).toEqual([-32124, -988, 0, 988, 32124]);

    const packet = buildRtpPacket({
      payloadType: 0,
      marker: false,
      sequence: 65_535,
      timestamp: 0xfffffff0,
      ssrc: 0x12345678,
      payload: encoded,
    });
    expect(parseRtpPacket(packet)).toEqual({
      payloadType: 0,
      marker: false,
      sequence: 65_535,
      timestamp: 0xfffffff0,
      ssrc: 0x12345678,
      payload: encoded,
    });
  });

  it("leases even RTP ports atomically and reports exhaustion", () => {
    const allocator = new RtpPortAllocator(10_000, 10_003);
    expect(allocator.lease()).toBe(10_000);
    expect(allocator.lease()).toBe(10_002);
    expect(() => allocator.lease()).toThrow(
      "sip_rtp_port_range_exhausted",
    );
    allocator.release(10_000);
    expect(allocator.lease()).toBe(10_000);
  });

  it("handles Dev INVITE, ACK, RTP and BYE with ordered RTP counters", async () => {
    const sockets: FakeSipDatagramSocket[] = [];
    const createSocket = () => {
      const socket = new FakeSipDatagramSocket();
      sockets.push(socket);
      return socket;
    };
    const onPcm = vi.fn(async (
      callId: string,
      pcm16: Buffer,
    ) => {
      void callId;
      void pcm16;
    });
    const onCallEnded = vi.fn(async () => undefined);
    const backend = createDevSipBackend(
      resolvedConfig("dev"),
      { createSocket },
    );
    await backend.start({
      onIncomingCall: vi.fn(
        async (): Promise<"accepted"> => "accepted",
      ),
      onCallReady: vi.fn(async () => undefined),
      onPcm,
      onSpeechStart: vi.fn(async () => undefined),
      onCallEnded,
    });
    const signaling = sockets[0]!;
    const invite = sipRequest(
      "INVITE",
      "sip:mate@127.0.0.1",
      "dev-call-1",
      1,
      [
        "v=0",
        "o=alice 0 0 IN IP4 127.0.0.1",
        "s=Test",
        "c=IN IP4 127.0.0.1",
        "t=0 0",
        "m=audio 40000 RTP/AVP 0",
        "a=rtpmap:0 PCMU/8000",
        "",
      ].join("\r\n"),
    );
    signaling.emit(
      Buffer.from(invite),
      ["127.0.0.1", 50_700],
    );
    await vi.waitFor(() => {
      expect(signaling.sent.some(
        ({ data }) => data.toString().startsWith(
          "SIP/2.0 200 OK",
        ),
      )).toBe(true);
    });
    const acceptedResponse = parseSipMessage(
      signaling.sent.find(({ data }) =>
        data.toString().startsWith("SIP/2.0 200 OK")
      )!.data.toString(),
    );
    const dialogTo = acceptedResponse.headers.get("to")!;
    expect(sockets[1]?.bound).toEqual({
      host: "127.0.0.1",
      port: 10_000,
    });

    signaling.emit(
      Buffer.from(sipRequest(
        "ACK",
        "sip:mate@127.0.0.1",
        "dev-call-1",
        1,
      ).replace(
        "To: <sip:mate@127.0.0.1>",
        `To: ${dialogTo}`,
      )),
      ["127.0.0.1", 50_700],
    );
    const inboundRtp = buildRtpPacket({
      payloadType: 0,
      marker: false,
      sequence: 7,
      timestamp: 160,
      ssrc: 99,
      payload: Buffer.alloc(160, 0xff),
    });
    sockets[1]!.emit(
      inboundRtp,
      ["127.0.0.1", 40_000],
    );
    await vi.waitFor(() => {
      expect(onPcm).toHaveBeenCalledWith(
        "dev-call-1",
        expect.any(Buffer),
      );
    });
    expect(
      (onPcm.mock.calls[0]?.[1] as Buffer).byteLength,
    ).toBe(320);

    await backend.playAudio(
      "dev-call-1",
      Buffer.alloc(160, 0x7f),
    );
    await backend.playAudio(
      "dev-call-1",
      Buffer.alloc(160, 0x7e),
    );
    const outboundPackets = sockets[1]!.sent.map(
      ({ data }) => parseRtpPacket(data),
    );
    expect(
      sockets[1]!.sent[1]!.sentAt
      - sockets[1]!.sent[0]!.sentAt,
    ).toBeGreaterThanOrEqual(15);
    expect(outboundPackets[1]!.sequence).toBe(
      (outboundPackets[0]!.sequence + 1) & 0xffff,
    );
    expect(outboundPackets[1]!.timestamp).toBe(
      (outboundPackets[0]!.timestamp + 160) >>> 0,
    );
    expect(outboundPackets.every(
      ({ payload }) => payload.byteLength === 160,
    )).toBe(true);
    const pendingFrame = backend.playAudio(
      "dev-call-1",
      Buffer.alloc(160, 0x7d),
    );
    await backend.interruptAudio("dev-call-1");
    await expect(pendingFrame).resolves.toBe(false);
    expect(sockets[1]!.sent).toHaveLength(2);

    signaling.emit(
      Buffer.from(sipRequest(
        "BYE",
        "sip:mate@127.0.0.1",
        "dev-call-1",
        2,
      )),
      ["127.0.0.1", 50_700],
    );
    await vi.waitFor(() => {
      expect(signaling.sent.some(({ data }) =>
        data.toString().startsWith(
          "SIP/2.0 481 Call Transaction Does Not Exist",
        )
      )).toBe(true);
    });
    expect(onCallEnded).not.toHaveBeenCalled();
    signaling.emit(
      Buffer.from(sipRequest(
        "BYE",
        "sip:mate@127.0.0.1",
        "dev-call-1",
        2,
      ).replace(
        "To: <sip:mate@127.0.0.1>",
        `To: ${dialogTo}`,
      )),
      ["127.0.0.1", 50_700],
    );
    await vi.waitFor(() => {
      expect(onCallEnded).toHaveBeenCalledWith(
        "dev-call-1",
        "remote_bye",
      );
    });
    expect(sockets[1]!.closed).toBe(true);
    await backend.stop();
  });

  it("refreshes and unregisters external SIP bindings by the granted expiration", async () => {
    vi.useFakeTimers();
    try {
      const registerRequests: SipMessage[] = [];
      const socket = new FakeSipDatagramSocket((data) => {
        const source = data.toString();
        if (!source.startsWith("REGISTER ")) return;
        const request = parseSipMessage(source);
        registerRequests.push(request);
        const cseq = Number(
          request.headers.get("cseq")!.split(" ")[0],
        );
        socket.emit(
          Buffer.from(buildSipResponse(
            request,
            500,
            "Server Internal Error",
            { CSeq: `${cseq + 1} REGISTER` },
          )),
          ["127.0.0.1", 5_060],
        );
        const expires =
          request.headers.get("expires") === "0" ? "0" : "2";
        socket.emit(
          Buffer.from(buildSipResponse(
            request,
            200,
            "OK",
            {
              Contact:
                "<sip:mate@127.0.0.1:5060>"
                + `;expires=${expires}`,
              Expires: expires,
            },
          )),
          ["127.0.0.1", 5_060],
        );
      });
      const backend = createDevSipBackend({
        ...resolvedConfig("dev"),
        username: "mate",
        password: "runner-only-secret",
        sipServer: "127.0.0.1:5060",
      }, {
        createSocket: () => socket,
      });
      await backend.start({
        onIncomingCall: vi.fn(
          async (): Promise<"accepted"> => "accepted",
        ),
        onCallReady: vi.fn(async () => undefined),
        onPcm: vi.fn(async () => undefined),
        onSpeechStart: vi.fn(async () => undefined),
        onCallEnded: vi.fn(async () => undefined),
      });
      expect(registerRequests).toHaveLength(1);
      expect(registerRequests[0]!.headers.get("expires"))
        .toBe("300");

      await vi.advanceTimersByTimeAsync(1_599);
      expect(registerRequests).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(registerRequests).toHaveLength(2);

      await backend.stop();
      expect(registerRequests).toHaveLength(3);
      expect(registerRequests[2]!.headers.get("expires"))
        .toBe("0");
      expect(
        registerRequests[2]!.headers.get("contact"),
      ).toContain("expires=0");
      expect(new Set(registerRequests.map(
        (request) => request.headers.get("call-id"),
      )).size).toBe(1);
      expect(new Set(registerRequests.map(
        (request) => request.headers.get("from"),
      )).size).toBe(1);
      expect(registerRequests.map(
        (request) => request.headers.get("cseq"),
      )).toEqual([
        "1 REGISTER",
        "2 REGISTER",
        "3 REGISTER",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a stable REGISTER lifecycle and Proxy-Authorization for 407", async () => {
    const requests: SipMessage[] = [];
    const socket = new FakeSipDatagramSocket((data) => {
      const source = data.toString();
      if (!source.startsWith("REGISTER ")) return;
      const request = parseSipMessage(source);
      requests.push(request);
      const response = requests.length === 1
        ? buildSipResponse(
            request,
            407,
            "Proxy Authentication Required",
            {
              "WWW-Authenticate":
                'Digest realm="wrong.example.com", '
                + 'nonce="wrong", algorithm=SHA-256',
              "Proxy-Authenticate":
                'Digest realm="sip.example.com", '
                + 'nonce="nonce-1", algorithm=MD5, qop="auth"',
            },
          )
        : buildSipResponse(
            request,
            200,
            "OK",
            { Expires: request.headers.get("expires")! },
          );
      socket.emit(
        Buffer.from(response),
        ["127.0.0.1", 5_060],
      );
    });
    const backend = createDevSipBackend({
      ...resolvedConfig("dev"),
      username: "mate",
      password: "runner-only-secret",
      sipServer: "127.0.0.1:5060",
    }, {
      createSocket: () => socket,
    });
    await backend.start({
      onIncomingCall: vi.fn(
        async (): Promise<"accepted"> => "accepted",
      ),
      onCallReady: vi.fn(async () => undefined),
      onPcm: vi.fn(async () => undefined),
      onSpeechStart: vi.fn(async () => undefined),
      onCallEnded: vi.fn(async () => undefined),
    });
    expect(requests).toHaveLength(2);
    expect(
      requests[1]!.headers.get("proxy-authorization"),
    ).toMatch(/^Digest /u);
    expect(requests[1]!.headers.has("authorization"))
      .toBe(false);
    expect(requests.map(
      (request) => request.headers.get("call-id"),
    )).toEqual([
      requests[0]!.headers.get("call-id"),
      requests[0]!.headers.get("call-id"),
    ]);
    expect(requests.map(
      (request) => request.headers.get("from"),
    )).toEqual([
      requests[0]!.headers.get("from"),
      requests[0]!.headers.get("from"),
    ]);
    expect(requests.map(
      (request) => request.headers.get("cseq"),
    )).toEqual(["1 REGISTER", "2 REGISTER"]);
    await backend.stop();
    expect(requests[2]!.headers.get("cseq"))
      .toBe("3 REGISTER");
  });

  it("routes stop hangup inside the accepted SIP dialog", async () => {
    const sockets: FakeSipDatagramSocket[] = [];
    const backend = createDevSipBackend(
      resolvedConfig("dev"),
      {
        createSocket: () => {
          const socket = new FakeSipDatagramSocket();
          sockets.push(socket);
          return socket;
        },
      },
    );
    await backend.start({
      onIncomingCall: vi.fn(
        async (): Promise<"accepted"> => "accepted",
      ),
      onCallReady: vi.fn(async () => undefined),
      onPcm: vi.fn(async () => undefined),
      onSpeechStart: vi.fn(async () => undefined),
      onCallEnded: vi.fn(async () => undefined),
    });
    const invite = sipRequest(
      "INVITE",
      "sip:mate@127.0.0.1",
      "dialog-call",
      7,
      [
        "v=0",
        "o=alice 0 0 IN IP4 127.0.0.1",
        "s=Test",
        "c=IN IP4 127.0.0.1",
        "t=0 0",
        "m=audio 40000 RTP/AVP 0",
        "",
      ].join("\r\n"),
    ).replace(
      "Contact: <sip:alice@127.0.0.1:50700>",
      [
        "Record-Route: <sip:edge.example.com>",
        "Record-Route: <sip:proxy.example.com;lr>",
        "Contact: <sip:alice@127.0.0.1:50999;transport=udp>",
      ].join("\r\n"),
    );
    sockets[0]!.emit(
      Buffer.from(invite),
      ["127.0.0.1", 50_700],
    );
    await vi.waitFor(() => {
      expect(sockets[0]!.sent.some(({ data }) =>
        data.toString().startsWith("SIP/2.0 200 OK")
      )).toBe(true);
    });

    await backend.stop();
    const byePacket = sockets[0]!.sent
      .find(({ data }) => data.toString().startsWith("BYE "));
    const byeSource = byePacket?.data.toString();
    expect(byeSource).toBeDefined();
    const bye = parseSipMessage(byeSource!);
    expect(bye.requestUri).toBe(
      "sip:edge.example.com",
    );
    expect(bye.headers.get("from")).toMatch(/;tag=/u);
    expect(bye.headers.get("to")).toContain("tag=alice");
    expect(bye.headerValues.get("route")).toEqual([
      "<sip:proxy.example.com;lr>",
      "<sip:alice@127.0.0.1:50999;transport=udp>",
    ]);
    expect(bye.headers.get("cseq")).toBe("8 BYE");
    expect(byePacket).toMatchObject({
      host: "edge.example.com",
      port: 5_060,
    });
  });

  it("maps each LiveKit SIP participant to an isolated call and 24 kHz audio source", async () => {
    const room = new FakeLiveKitRoom();
    let admitFirst!: () => void;
    const firstAdmission = new Promise<void>((resolve) => {
      admitFirst = resolve;
    });
    const capturedFrames: unknown[] = [];
    const source = {
      clearQueue: vi.fn(),
      captureFrame: vi.fn(async (frame: unknown) => {
        capturedFrames.push(frame);
      }),
      close: vi.fn(async () => undefined),
    };
    const track = {
      close: vi.fn(async () => undefined),
    };
    const removeParticipant = vi.fn(async () => undefined);
    const onPcm = vi.fn(async (
      callId: string,
      pcm16: Buffer,
    ) => {
      void callId;
      void pcm16;
    });
    const onCallEnded = vi.fn(async () => undefined);
    const onIncomingCall = vi.fn(async (
      call: { callId: string },
    ): Promise<"accepted"> => {
      if (call.callId === "livekit-call-1") {
        await firstAdmission;
      }
      return "accepted";
    });
    const participant = {
      kind: 3,
      identity: "sip-participant-1",
      trackPublications: new Map(),
      attributes: {
        "sip.callID": "livekit-call-1",
        "sip.phoneNumber": "+8613800000000",
        "sip.trunkPhoneNumber": "+8613900000000",
        "sip.trunkID": "trunk-1",
        "sip.ruleID": "dispatch-1",
      },
    };
    room.remoteParticipants.set(
      participant.identity,
      participant,
    );
    const backend = createLiveKitSipBackend(
      resolvedConfig("livekit"),
      {
        roomService: {
          listRooms: vi.fn(async () => [
            { name: "sip-inbound-call-1" },
          ]) as never,
          listParticipants: vi.fn(async () => [
            participant,
          ]) as never,
          removeParticipant,
          deleteRoom: vi.fn(async () => undefined),
        },
        sipService: {
          listSipInboundTrunk: vi.fn(async () => [
            { sipTrunkId: "trunk-1" },
          ]) as never,
          listSipDispatchRule: vi.fn(async () => [
            {
              sipDispatchRuleId: "dispatch-1",
              trunkIds: ["trunk-1"],
              rule: {
                rule: {
                  case: "dispatchRuleIndividual",
                  value: {
                    roomPrefix: "sip-inbound",
                    noRandomness: false,
                  },
                },
              },
            },
          ]) as never,
        },
        createRoom: () => room as never,
        createAudioSource: () => source as never,
        createAudioTrack: () => track as never,
        createAudioFrame: (samples) => ({
          samples,
        }) as never,
        createAudioStream: () =>
          new ReadableStream({
            start(controller) {
              controller.enqueue({
                data: Int16Array.from([1, -1]),
              });
              controller.close();
            },
          }) as never,
        createToken: vi.fn(async () => "room-token"),
      },
    );
    await backend.start({
      onIncomingCall,
      onCallReady: vi.fn(async () => undefined),
      onPcm,
      onSpeechStart: vi.fn(async () => undefined),
      onCallEnded,
    });
    expect(room.connect).toHaveBeenCalledWith(
      "wss://livekit.example.com",
      "room-token",
    );
    await vi.waitFor(() => {
      expect(onIncomingCall).toHaveBeenCalledOnce();
    });
    expect(
      room.localParticipant.publishTrack,
    ).toHaveBeenCalledOnce();
    const unexpectedParticipant = {
      kind: 3,
      identity: "sip-participant-2",
      trackPublications: new Map(),
      attributes: {
        "sip.callID": "livekit-call-2",
        "sip.phoneNumber": "+8613800000001",
        "sip.trunkPhoneNumber": "+8613900000000",
        "sip.trunkID": "trunk-1",
        "sip.ruleID": "dispatch-1",
      },
    };
    room.emit(
      "participantConnected",
      unexpectedParticipant,
    );
    await vi.waitFor(() => {
      expect(removeParticipant).toHaveBeenCalledWith(
        "sip-inbound-call-1",
        "sip-participant-2",
      );
    });
    expect(onIncomingCall).toHaveBeenCalledOnce();
    admitFirst();
    await vi.waitFor(() => {
      expect(onCallEnded).toHaveBeenCalledWith(
        "livekit-call-1",
        "backend_stopped",
      );
    });
    await expect(backend.playAudio(
      "livekit-call-1",
      Buffer.alloc(960),
    )).rejects.toThrow("sip_call_not_active");
    expect(capturedFrames).toHaveLength(0);
    await backend.stop();
    expect(room.disconnect).toHaveBeenCalled();
  });

  it("binds admitted LiveKit audio to a fixed call generation", async () => {
    const room = new FakeLiveKitRoom();
    const capturedFrames: unknown[] = [];
    const source = {
      clearQueue: vi.fn(),
      captureFrame: vi.fn(async (frame: unknown) => {
        capturedFrames.push(frame);
      }),
    };
    const track = {
      close: vi.fn(async () => undefined),
    };
    const removeParticipant = vi.fn(async () => undefined);
    const onPcm = vi.fn(async (
      callId: string,
      pcm16: Buffer,
    ) => {
      void callId;
      void pcm16;
    });
    const onCallEnded = vi.fn(async () => undefined);
    const participant = {
      kind: 3,
      identity: "sip-participant-1",
      trackPublications: new Map(),
      attributes: {
        "sip.callID": "livekit-call-1",
        "sip.phoneNumber": "+8613800000000",
        "sip.trunkPhoneNumber": "+8613900000000",
        "sip.trunkID": "trunk-1",
        "sip.ruleID": "dispatch-1",
      },
    };
    room.remoteParticipants.set(
      participant.identity,
      participant,
    );
    const backend = createLiveKitSipBackend(
      resolvedConfig("livekit"),
      {
        roomService: {
          listRooms: vi.fn(async () => [
            { name: "sip-inbound-call-1" },
          ]) as never,
          listParticipants: vi.fn(async () => [
            participant,
          ]) as never,
          removeParticipant,
          deleteRoom: vi.fn(async () => undefined),
        },
        sipService: {
          listSipInboundTrunk: vi.fn(async () => [
            { sipTrunkId: "trunk-1" },
          ]) as never,
          listSipDispatchRule: vi.fn(async () => [
            {
              sipDispatchRuleId: "dispatch-1",
              trunkIds: ["trunk-1"],
              rule: {
                rule: {
                  case: "dispatchRuleIndividual",
                  value: {
                    roomPrefix: "sip-inbound",
                    noRandomness: false,
                  },
                },
              },
            },
          ]) as never,
        },
        createRoom: () => room as never,
        createAudioSource: () => source as never,
        createAudioTrack: () => track as never,
        createAudioFrame: (samples) => ({
          samples,
        }) as never,
        createAudioStream: () =>
          new ReadableStream({
            start(controller) {
              controller.enqueue({
                data: Int16Array.from([1, -1]),
              });
              controller.close();
            },
          }) as never,
        createToken: vi.fn(async () => "room-token"),
      },
    );
    await backend.start({
      onIncomingCall: vi.fn(
        async (): Promise<"accepted"> => "accepted",
      ),
      onCallReady: vi.fn(async () => undefined),
      onPcm,
      onSpeechStart: vi.fn(async () => undefined),
      onCallEnded,
    });
    await vi.waitFor(async () => {
      await expect(backend.playAudio(
        "livekit-call-1",
        Buffer.alloc(960),
      )).resolves.toBe(true);
    });
    expect(capturedFrames).toHaveLength(1);

    room.emit(
      "trackSubscribed",
      { kind: 1 },
      {},
      participant,
    );
    await vi.waitFor(() => {
      expect(onPcm).toHaveBeenCalledWith(
        "livekit-call-1",
        expect.any(Buffer),
      );
    });
    expect(
      (onPcm.mock.calls[0]?.[1] as Buffer).byteLength,
    ).toBe(4);
    await backend.interruptAudio("livekit-call-1");
    expect(source.clearQueue).toHaveBeenCalled();

    room.emit("participantDisconnected", participant);
    await vi.waitFor(() => {
      expect(onCallEnded).toHaveBeenCalledWith(
        "livekit-call-1",
        "participant_disconnected",
      );
    });
    expect(removeParticipant).not.toHaveBeenCalled();
    await backend.stop();
    expect(room.disconnect).toHaveBeenCalled();
  });

  it("never publishes into a pre-existing shared LiveKit room", async () => {
    const room = new FakeLiveKitRoom();
    for (let index = 1; index <= 2; index += 1) {
      room.remoteParticipants.set(`sip-participant-${index}`, {
        kind: 3,
        identity: `sip-participant-${index}`,
        trackPublications: new Map(),
        attributes: {
          "sip.callID": `shared-call-${index}`,
          "sip.trunkID": "trunk-1",
          "sip.ruleID": "dispatch-1",
        },
      });
    }
    room.connect.mockImplementationOnce(async () => {
      for (const participant of room.remoteParticipants.values()) {
        room.emit("participantConnected", participant);
      }
    });
    const deleteRoom = vi.fn(async () => undefined);
    const onIncomingCall = vi.fn(
      async (): Promise<"accepted"> => "accepted",
    );
    const backend = createLiveKitSipBackend(
      resolvedConfig("livekit"),
      {
        roomService: {
          listRooms: vi.fn(async () => [
            { name: "sip-inbound-shared" },
          ]) as never,
          listParticipants: vi.fn(async () =>
            [...room.remoteParticipants.values()]
          ) as never,
          removeParticipant: vi.fn(async () => undefined),
          deleteRoom,
        },
        sipService: {
          listSipInboundTrunk: vi.fn(async () => [
            { sipTrunkId: "trunk-1" },
          ]) as never,
          listSipDispatchRule: vi.fn(async () => [
            {
              sipDispatchRuleId: "dispatch-1",
              trunkIds: ["trunk-1"],
              rule: {
                rule: {
                  case: "dispatchRuleIndividual",
                  value: {
                    roomPrefix: "sip-inbound",
                    noRandomness: false,
                  },
                },
              },
            },
          ]) as never,
        },
        createRoom: () => room as never,
        createAudioSource: () => ({
          clearQueue: vi.fn(),
        }) as never,
        createAudioTrack: () => ({
          close: vi.fn(async () => undefined),
        }) as never,
        createToken: vi.fn(async () => "room-token"),
      },
    );
    await backend.start({
      onIncomingCall,
      onCallReady: vi.fn(async () => undefined),
      onPcm: vi.fn(async () => undefined),
      onSpeechStart: vi.fn(async () => undefined),
      onCallEnded: vi.fn(async () => undefined),
    });
    await vi.waitFor(() => {
      expect(deleteRoom).toHaveBeenCalledWith(
        "sip-inbound-shared",
      );
    });
    expect(room.localParticipant.publishTrack)
      .not.toHaveBeenCalled();
    expect(onIncomingCall).not.toHaveBeenCalled();
    await backend.stop();
  });

  it("returns busy for the first excess LiveKit call and deletes later overflow rooms", async () => {
    const roomNames = [
      "sip-inbound-call-1",
      "sip-inbound-call-2",
      "sip-inbound-call-3",
    ];
    const participants = roomNames.map((_roomName, index) => ({
      kind: 3,
      identity: `sip-participant-${index + 1}`,
      trackPublications: new Map(),
      attributes: {
        "sip.callID": `capacity-call-${index + 1}`,
        "sip.trunkID": "trunk-1",
        "sip.ruleID": "dispatch-1",
      },
    }));
    const rooms = roomNames.slice(0, 2).map(
      (_roomName, index) => {
        const room = new FakeLiveKitRoom();
        room.remoteParticipants.set(
          `sip-participant-${index + 1}`,
          participants[index]!,
        );
        return room;
      },
    );
    const deleteRoom = vi.fn(async () => undefined);
    const onIncomingCall = vi.fn(async (
      call: { callId: string },
    ): Promise<"accepted" | "busy"> =>
      call.callId === "capacity-call-1"
        ? "accepted"
        : "busy");
    let roomIndex = 0;
    const backend = createLiveKitSipBackend(
      {
        ...resolvedConfig("livekit"),
        maxCalls: 1,
      },
      {
        roomService: {
          listRooms: vi.fn(async () =>
            roomNames.map((name) => ({ name }))
          ) as never,
          listParticipants: vi.fn(async (roomName: string) => {
            const index = roomNames.indexOf(roomName);
            return index < 0 ? [] : [participants[index]!];
          }) as never,
          removeParticipant: vi.fn(async () => undefined),
          deleteRoom,
        },
        sipService: {
          listSipInboundTrunk: vi.fn(async () => [
            { sipTrunkId: "trunk-1" },
          ]) as never,
          listSipDispatchRule: vi.fn(async () => [
            {
              sipDispatchRuleId: "dispatch-1",
              trunkIds: ["trunk-1"],
              rule: {
                rule: {
                  case: "dispatchRuleIndividual",
                  value: {
                    roomPrefix: "sip-inbound",
                    noRandomness: false,
                  },
                },
              },
            },
          ]) as never,
        },
        createRoom: () => rooms[roomIndex++]! as never,
        createAudioSource: () => ({
          clearQueue: vi.fn(),
          captureFrame: vi.fn(async () => undefined),
        }) as never,
        createAudioTrack: () => ({
          close: vi.fn(async () => undefined),
        }) as never,
        createToken: vi.fn(async () => "room-token"),
      },
    );
    await backend.start({
      onIncomingCall,
      onCallReady: vi.fn(async () => undefined),
      onPcm: vi.fn(async () => undefined),
      onSpeechStart: vi.fn(async () => undefined),
      onCallEnded: vi.fn(async () => undefined),
    });
    await vi.waitFor(() => {
      expect(onIncomingCall).toHaveBeenCalledWith(
        expect.objectContaining({
          callId: "capacity-call-2",
        }),
      );
      expect(deleteRoom).toHaveBeenCalledWith(
        "sip-inbound-call-2",
      );
      expect(deleteRoom).toHaveBeenCalledWith(
        "sip-inbound-call-3",
      );
    });

    await backend.stop();
    expect(deleteRoom).toHaveBeenCalledWith(
      "sip-inbound-call-1",
    );
  });

  it("never connects to or deletes a foreign LiveKit room sharing the prefix", async () => {
    const createRoom = vi.fn(() => new FakeLiveKitRoom());
    const deleteRoom = vi.fn(async () => undefined);
    const backend = createLiveKitSipBackend(
      resolvedConfig("livekit"),
      {
        roomService: {
          listRooms: vi.fn(async () => [
            { name: "sip-inbound-support" },
          ]) as never,
          listParticipants: vi.fn(async () => [{
            kind: 3,
            identity: "foreign-sip-participant",
            attributes: {
              "sip.trunkID": "other-trunk",
              "sip.ruleID": "other-rule",
            },
          }]) as never,
          removeParticipant: vi.fn(async () => undefined),
          deleteRoom,
        },
        sipService: {
          listSipInboundTrunk: vi.fn(async () => [
            { sipTrunkId: "trunk-1" },
          ]) as never,
          listSipDispatchRule: vi.fn(async () => [
            {
              sipDispatchRuleId: "dispatch-1",
              trunkIds: ["trunk-1"],
              rule: {
                rule: {
                  case: "dispatchRuleIndividual",
                  value: {
                    roomPrefix: "sip-inbound",
                    noRandomness: false,
                  },
                },
              },
            },
          ]) as never,
        },
        createRoom: createRoom as never,
      },
    );
    await backend.start({
      onIncomingCall: vi.fn(
        async (): Promise<"accepted"> => "accepted",
      ),
      onCallReady: vi.fn(async () => undefined),
      onPcm: vi.fn(async () => undefined),
      onSpeechStart: vi.fn(async () => undefined),
      onCallEnded: vi.fn(async () => undefined),
    });
    expect(createRoom).not.toHaveBeenCalled();
    expect(deleteRoom).not.toHaveBeenCalled();
    await backend.stop();
  });

  it("rejects a LiveKit trunk with any shared-room dispatch rule", async () => {
    const backend = createLiveKitSipBackend(
      resolvedConfig("livekit"),
      {
        roomService: {
          listRooms: vi.fn(async () => []) as never,
          listParticipants: vi.fn(async () => []) as never,
          removeParticipant: vi.fn(async () => undefined),
          deleteRoom: vi.fn(async () => undefined),
        },
        sipService: {
          listSipInboundTrunk: vi.fn(async () => [
            { sipTrunkId: "trunk-1" },
          ]) as never,
          listSipDispatchRule: vi.fn(async () => [
            {
              sipDispatchRuleId: "dispatch-1",
              trunkIds: ["trunk-1"],
              rule: {
                rule: {
                  case: "dispatchRuleIndividual",
                  value: {
                    roomPrefix: "sip-inbound",
                    noRandomness: false,
                  },
                },
              },
            },
            {
              sipDispatchRuleId: "dispatch-2",
              trunkIds: [],
              rule: {
                rule: {
                  case: "dispatchRuleDirect",
                  value: { roomName: "shared-room" },
                },
              },
            },
          ]) as never,
        },
      },
    );
    await expect(backend.start({
      onIncomingCall: vi.fn(
        async (): Promise<"accepted"> => "accepted",
      ),
      onCallReady: vi.fn(async () => undefined),
      onPcm: vi.fn(async () => undefined),
      onSpeechStart: vi.fn(async () => undefined),
      onCallEnded: vi.fn(async () => undefined),
    })).rejects.toThrow(
      "sip_livekit_individual_dispatch_required",
    );
  });

  it("caps concurrent calls, times out sessions and aborts only current TTS", async () => {
    vi.useFakeTimers();
    try {
      const ended: string[] = [];
      const sessions = new SipCallSessionManager({
        maximumCalls: 5,
        callTimeoutMilliseconds: 120_000,
        createCallInstanceId: (() => {
          let index = 0;
          return () => `call-instance-${index += 1}`;
        })(),
        onTimeout: async (callId) => {
          ended.push(callId);
        },
      });
      for (let index = 1; index <= 5; index += 1) {
        expect(sessions.begin({
          callId: `call-${index}`,
          fromUri: `sip:user-${index}@example.com`,
          toUri: "sip:mate@example.com",
        }).status).toBe("accepted");
      }
      expect(sessions.begin({
        callId: "call-6",
        fromUri: "sip:user-6@example.com",
        toUri: "sip:mate@example.com",
      })).toEqual({ status: "busy" });
      expect(sessions.nextUtteranceId("call-1")).toBe(
        "call-1:utterance:call-instance-1:1",
      );
      expect(sessions.nextUtteranceId("call-1")).toBe(
        "call-1:utterance:call-instance-1:2",
      );

      const firstSignal =
        sessions.beginPlayback("call-1", DELIVERY_ID);
      expect(firstSignal.aborted).toBe(false);
      sessions.interruptPlayback("call-1");
      expect(firstSignal.aborted).toBe(true);
      expect(sessions.has("call-1")).toBe(true);
      const nextSignal = sessions.beginPlayback(
        "call-1",
        "90000000-0000-4000-8000-000000000003",
      );
      expect(nextSignal.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(120_000);
      expect(ended).toContain("call-1");
      expect(sessions.has("call-1")).toBe(false);
      sessions.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("streams DashScope STT audio but exposes only final transcripts", async () => {
    const sockets: FakeWebSocket[] = [];
    const onSpeechStart = vi.fn();
    const onPartialTranscript = vi.fn();
    const onFinalTranscript = vi.fn(
      async (text: string) => {
        void text;
      },
    );
    const recognizer = createDashScopeSpeechRecognizer({
      apiKey: "runner-only-secret",
      createSocket(_url, options) {
        const socket = new FakeWebSocket(options);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    const starting = recognizer.startCall({
      callId: "stt-call",
      sampleRate: 8_000,
      language: "zh-CN",
      onSpeechStart,
      onPartialTranscript,
      onFinalTranscript,
    });
    const socket = sockets[0]!;
    socket.open();
    const runTask = JSON.parse(
      socket.sent[0]!.toString(),
    );
    const taskId = runTask.header.task_id as string;
    expect(runTask.payload).toMatchObject({
      task_group: "audio",
      task: "asr",
      model: "paraformer-realtime-8k-v2",
      parameters: {
        format: "pcm",
        sample_rate: 8_000,
        language_hints: ["zh"],
      },
    });
    socket.message(JSON.stringify({
      header: {
        task_id: taskId,
        event: "task-started",
      },
      payload: {},
    }));
    const session = await starting;
    await session.pushPcm(Buffer.alloc(320, 1));
    expect(socket.sent.at(-1)).toEqual(
      Buffer.alloc(320, 1),
    );

    socket.message(sttResult(taskId, "你", false));
    socket.message(sttResult(taskId, "你好", true));
    await vi.waitFor(() => {
      expect(onFinalTranscript)
        .toHaveBeenCalledExactlyOnceWith("你好");
    });
    expect(onSpeechStart).toHaveBeenCalledOnce();
    expect(onPartialTranscript).toHaveBeenCalledWith("你");

    const stopping = session.stop();
    expect(socket.sent.some((value) =>
      value.toString().includes('"action":"finish-task"')
    )).toBe(true);
    socket.message(JSON.stringify({
      header: {
        task_id: taskId,
        event: "task-finished",
      },
      payload: {},
    }));
    await stopping;
    expect(JSON.stringify(socket.options)).not.toContain(
      "X-DashScope-DataInspection",
    );
  });

  it("streams DashScope TTS as raw PCM and closes immediately on barge-in", async () => {
    const sockets: FakeWebSocket[] = [];
    const synthesizer = createDashScopeSpeechSynthesizer({
      apiKey: "runner-only-secret",
      createSocket(_url, options) {
        const socket = new FakeWebSocket(options);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    const controller = new AbortController();
    const iterator = synthesizer.synthesize({
      text: "你好",
      voice: "longxiaochun_v2",
      sampleRate: 24_000,
      signal: controller.signal,
    })[Symbol.asyncIterator]();
    const first = iterator.next();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0]!;
    socket.open();
    const task = JSON.parse(socket.sent[0]!.toString());
    const taskId = task.header.task_id as string;
    expect(task.payload.parameters).toMatchObject({
      voice: "longxiaochun_v2",
      format: "pcm",
      sample_rate: 24_000,
    });
    socket.message(JSON.stringify({
      header: {
        task_id: taskId,
        event: "task-started",
      },
      payload: {},
    }));
    expect(socket.sent.some((value) =>
      value.toString().includes('"text":"你好"')
    )).toBe(true);
    socket.message(Buffer.alloc(960, 3), true);
    await expect(first).resolves.toEqual({
      done: false,
      value: Buffer.alloc(960, 3),
    });

    const next = iterator.next();
    controller.abort();
    await expect(next).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(socket.closed).toBe(true);
  });

  it("fails closed when DashScope media sockets end unexpectedly", async () => {
    const ttsSockets: FakeWebSocket[] = [];
    const synthesizer = createDashScopeSpeechSynthesizer({
      apiKey: "runner-only-secret",
      createSocket(_url, options) {
        const socket = new FakeWebSocket(options);
        ttsSockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    const iterator = synthesizer.synthesize({
      text: "你好",
      voice: "longxiaochun_v2",
      sampleRate: 8_000,
      signal: new AbortController().signal,
    })[Symbol.asyncIterator]();
    const pendingAudio = iterator.next();
    await vi.waitFor(() => expect(ttsSockets).toHaveLength(1));
    ttsSockets[0]!.open();
    const ttsTask = JSON.parse(
      ttsSockets[0]!.sent[0]!.toString(),
    );
    ttsSockets[0]!.message(JSON.stringify({
      header: {
        task_id: ttsTask.header.task_id,
        event: "task-started",
      },
    }));
    ttsSockets[0]!.close();
    await expect(pendingAudio).rejects.toThrow(
      "sip_tts_provider_unavailable",
    );

    const sttSockets: FakeWebSocket[] = [];
    const onSessionError = vi.fn(async () => undefined);
    const recognizer = createDashScopeSpeechRecognizer({
      apiKey: "runner-only-secret",
      createSocket(_url, options) {
        const socket = new FakeWebSocket(options);
        sttSockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    const starting = recognizer.startCall({
      callId: "stt-close-call",
      sampleRate: 8_000,
      language: "zh-CN",
      onSpeechStart: vi.fn(),
      onPartialTranscript: vi.fn(),
      onFinalTranscript: vi.fn(async () => undefined),
      onSessionError,
    });
    sttSockets[0]!.open();
    const sttTask = JSON.parse(
      sttSockets[0]!.sent[0]!.toString(),
    );
    sttSockets[0]!.message(JSON.stringify({
      header: {
        task_id: sttTask.header.task_id,
        event: "task-started",
      },
    }));
    const session = await starting;
    sttSockets[0]!.close();
    await vi.waitFor(() => {
      expect(onSessionError).toHaveBeenCalledOnce();
    });
    await expect(
      session.pushPcm(Buffer.alloc(320)),
    ).rejects.toThrow("sip_stt_session_closed");
  });

  it("hangs up an active call when its STT session fails", async () => {
    let failSession:
      | ((error: Error) => Promise<void> | void)
      | undefined;
    const backend = createSipBackendHarness({
      kind: "dev",
      sampleRate: 8_000,
    });
    const transport = createSipTransport({
      config: resolvedConfig("dev"),
      backend,
      recognizer: {
        async startCall(input) {
          failSession = input.onSessionError;
          return {
            async pushPcm() {},
            async stop() {},
          };
        },
      },
      synthesizer: createSynthesizerHarness(320),
      enqueueInbound: vi.fn(),
    });
    await transport.start();
    await backend.injectIncomingCall({
      callId: "stt-failure-call",
      fromUri: "sip:alice@example.com",
      toUri: "sip:mate@example.com",
    });
    expect(transport.activeCallCount()).toBe(1);

    await failSession?.(
      new Error("sip_stt_provider_unavailable"),
    );
    expect(transport.activeCallCount()).toBe(0);
    await transport.stop();
  });

  it("never retries a Delivery after any SIP audio frame may have played", async () => {
    const harness = createSipBackendHarness({
      kind: "dev",
      sampleRate: 8_000,
    });
    const originalPlayAudio =
      harness.playAudio.bind(harness);
    let attempts = 0;
    const backend: SipBackend = {
      ...harness,
      async playAudio(callId, frame) {
        attempts += 1;
        if (attempts === 2) {
          throw new Error("network_after_first_frame");
        }
        return originalPlayAudio(callId, frame);
      },
    };
    const transport = createSipTransport({
      config: resolvedConfig("dev"),
      backend,
      recognizer: createRecognizerHarness(),
      synthesizer: {
        async *synthesize() {
          yield Buffer.alloc(640, 1);
        },
      },
      enqueueInbound: vi.fn(),
    });
    await transport.start();
    await harness.injectIncomingCall({
      callId: "partial-play-call",
      fromUri: "sip:alice@example.com",
      toUri: "sip:mate@example.com",
    });

    await expect(
      transport.send(sendFrame("partial-play-call")),
    ).resolves.toEqual({
      status: "failed",
      errorCode: "sip_send_outcome_unknown",
    });
    expect(attempts).toBe(2);
    await transport.stop();
  });

  defineSipBackendContract("dev");
  defineSipBackendContract("livekit");
});

function defineSipBackendContract(
  kind: "dev" | "livekit",
): void {
  it(`${kind} emits one final transcript and plays deterministic 20 ms audio frames`, async () => {
    const backend = createSipBackendHarness({
      kind,
      sampleRate: kind === "dev" ? 8_000 : 24_000,
    });
    const inbound: unknown[] = [];
    const recognizer = createRecognizerHarness();
    const synthesizer = createSynthesizerHarness(
      kind === "dev" ? 320 : 960,
    );
    const transport = createSipTransport({
      config: resolvedConfig(kind),
      backend,
      recognizer,
      synthesizer,
      enqueueInbound: async (draft) => {
        inbound.push(draft);
      },
      now: () => new Date("2026-07-27T02:00:00.000Z"),
    });
    await transport.start();

    const call = await backend.injectIncomingCall({
      callId: `${kind}-call-1`,
      fromUri: "sip:alice@example.com",
      toUri: "sip:mate@example.com",
    });
    await call.injectPcm(Buffer.alloc(320, 7));
    recognizer.emitPartial("你");
    expect(inbound).toHaveLength(0);
    await recognizer.emitFinal("你好");
    expect(inbound).toEqual([
      expect.objectContaining({
        connectionId: CONNECTION_ID,
        payload: {
          externalEventId: expect.stringMatching(
            new RegExp(
              `^${kind}-call-1:utterance:`
              + "[0-9a-f-]{36}:1$",
            ),
          ),
          externalConversationId: `${kind}-call-1`,
          externalSenderId: "sip:alice@example.com",
          chatType: "direct",
          mentioned: false,
          text: "你好",
          thread: {},
          attachments: [],
          occurredAt: "2026-07-27T02:00:00.000Z",
          rawSummary: {
            kind: "sip_final_transcript",
            backend: kind,
          },
          replyHandle: {
            publicFields: {
              callId: `${kind}-call-1`,
            },
            secretFields: {},
            expiresAt: null,
          },
        },
      }),
    ]);
    expect(JSON.stringify(inbound)).not.toContain(
      Buffer.alloc(320, 7).toString("base64"),
    );

    await expect(
      transport.send(sendFrame(`${kind}-call-1`)),
    ).resolves.toMatchObject({
      status: "sent",
      externalMessageId: `sip:${DELIVERY_ID}`,
    });
    expect(call.playedFrames.length).toBeGreaterThan(0);
    expect(call.playedFrames.every(
      (frame) =>
        frame.length === (kind === "dev" ? 160 : 960),
    )).toBe(true);
    const mismatchedFrame = sendFrame(`${kind}-call-1`);
    await expect(transport.send({
      ...mismatchedFrame,
      payload: {
        ...mismatchedFrame.payload,
        replyHandle: {
          ...mismatchedFrame.payload.replyHandle,
          publicFields: { callId: "different-call" },
        },
      },
    })).resolves.toEqual({
      status: "failed",
      errorCode: "sip_reply_handle_mismatch",
    });
    await expect(transport.send({
      ...mismatchedFrame,
      payload: {
        ...mismatchedFrame.payload,
        recipient: {
          ...mismatchedFrame.payload.recipient,
          externalUserId: "sip:mallory@example.com",
        },
      },
    })).resolves.toEqual({
      status: "failed",
      errorCode: "sip_recipient_mismatch",
    });

    await call.speechStarted();
    expect(synthesizer.signals.at(-1)?.aborted).toBe(true);
    expect(transport.activeCallCount()).toBe(1);
    await call.end();
    expect(transport.activeCallCount()).toBe(0);
    await transport.stop();
  });
}

function createRecognizerHarness(): SipSpeechRecognizer & Readonly<{
  emitPartial(text: string): void;
  emitFinal(text: string): Promise<void>;
}> {
  let callbacks:
    | Readonly<{
        onSpeechStart(): void;
        onPartialTranscript(text: string): void;
        onFinalTranscript(text: string): Promise<void>;
      }>
    | undefined;
  const session: SipSpeechSession = {
    pushPcm: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  return {
    async startCall(input) {
      callbacks = input;
      return session;
    },
    emitPartial(text) {
      callbacks?.onPartialTranscript(text);
    },
    async emitFinal(text) {
      await callbacks?.onFinalTranscript(text);
    },
  };
}

function createSynthesizerHarness(
  pcmBytes: number,
): SipSpeechSynthesizer & Readonly<{
  signals: AbortSignal[];
}> {
  const signals: AbortSignal[] = [];
  return {
    signals,
    async *synthesize(input) {
      signals.push(input.signal);
      yield Buffer.alloc(pcmBytes, 1);
      await Promise.resolve();
      if (!input.signal.aborted) {
        yield Buffer.alloc(pcmBytes, 2);
      }
    },
  };
}

function resolvedConfig(
  mode: "dev" | "livekit" = "dev",
): SipRunnerConfig {
  return resolveSipRunnerConfig({
    connection_id: CONNECTION_ID,
    sip_mode: mode,
    dashscope_api_key: "runner-only-secret",
    ...(mode === "livekit"
      ? {
          livekit_url: "wss://livekit.example.com",
          livekit_api_key: "livekit-key",
          livekit_api_secret: "livekit-secret",
          livekit_sip_trunk_id: "trunk-1",
          livekit_room_name: "sip-inbound",
        }
      : {}),
  });
}

function sendFrame(callId: string) {
  return {
    type: "send",
    protocolVersion: 1,
    nodeId: "90000000-0000-4000-8000-000000000010",
    sequence: 1,
    sentAt: "2026-07-27T02:00:01.000Z",
    connectionId: CONNECTION_ID,
    deliveryId: DELIVERY_ID,
    expiresAt: "2026-07-27T02:02:00.000Z",
    payload: {
      body: "你好，我在。",
      recipient: {
        externalConversationId: callId,
        externalUserId: "sip:alice@example.com",
        chatType: "direct",
      },
      replyHandle: {
        publicFields: { callId },
        secretFields: {},
        expiresAt: null,
      },
    },
  } as const;
}

class FakeSipDatagramSocket implements SipDatagramSocket {
  readonly sent: Array<Readonly<{
    data: Buffer;
    port: number;
    host: string;
    sentAt: number;
  }>> = [];
  bound: Readonly<{
    port: number;
    host: string;
  }> | null = null;
  closed = false;
  readonly #listeners: Array<(
    data: Buffer,
    address: readonly [string, number],
  ) => void> = [];

  constructor(
    private readonly onSend?: (
      data: Buffer,
      port: number,
      host: string,
    ) => void,
  ) {}

  onMessage(
    listener: (
      data: Buffer,
      address: readonly [string, number],
    ) => void,
  ): void {
    this.#listeners.push(listener);
  }

  async bind(port: number, host: string): Promise<void> {
    this.bound = { port, host };
  }

  async send(
    data: string | Buffer,
    port: number,
    host: string,
  ): Promise<void> {
    this.sent.push({
      data: Buffer.isBuffer(data)
        ? Buffer.from(data)
        : Buffer.from(data),
      port,
      host,
      sentAt: performance.now(),
    });
    this.onSend?.(
      Buffer.isBuffer(data)
        ? Buffer.from(data)
        : Buffer.from(data),
      port,
      host,
    );
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  emit(
    data: Buffer,
    address: readonly [string, number],
  ): void {
    for (const listener of this.#listeners) {
      listener(data, address);
    }
  }
}

function sipRequest(
  method: "INVITE" | "ACK" | "BYE",
  uri: string,
  callId: string,
  cseq: number,
  body = "",
): string {
  return [
    `${method} ${uri} SIP/2.0`,
    `Via: SIP/2.0/UDP 127.0.0.1:50700;branch=z9hG4bK-${method.toLowerCase()}`,
    "From: <sip:alice@127.0.0.1>;tag=alice",
    "To: <sip:mate@127.0.0.1>",
    `Call-ID: ${callId}`,
    `CSeq: ${cseq} ${method}`,
    "Contact: <sip:alice@127.0.0.1:50700>",
    ...(body ? ["Content-Type: application/sdp"] : []),
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body,
  ].join("\r\n");
}

class FakeWebSocket extends EventEmitter {
  readyState = 0;
  closed = false;
  readonly sent: Buffer[] = [];

  constructor(
    readonly options: WebSocket.ClientOptions,
  ) {
    super();
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  message(
    value: string | Buffer,
    isBinary = false,
  ): void {
    this.emit(
      "message",
      Buffer.isBuffer(value) ? value : Buffer.from(value),
      isBinary,
    );
  }

  send(
    value: string | Buffer,
    callback?: (error?: Error) => void,
  ): void {
    this.sent.push(
      Buffer.isBuffer(value)
        ? Buffer.from(value)
        : Buffer.from(value),
    );
    callback?.();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit("close");
  }
}

function sttResult(
  taskId: string,
  text: string,
  sentenceEnd: boolean,
): string {
  return JSON.stringify({
    header: {
      task_id: taskId,
      event: "result-generated",
    },
    payload: {
      output: {
        sentence: {
          text,
          sentence_end: sentenceEnd,
        },
      },
    },
  });
}

class FakeLiveKitRoom extends EventEmitter {
  readonly remoteParticipants = new Map();
  readonly localParticipant = {
    publishTrack: vi.fn(async () => undefined),
  };
  readonly connect = vi.fn(async () => undefined);
  readonly disconnect = vi.fn(async () => undefined);
}
